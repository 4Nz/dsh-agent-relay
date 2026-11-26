import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { createDoubaoCredentialStore } from "../../lib/providers/doubao/credentials.js";
import { createDoubaoAccess } from "../../lib/providers/doubao/access.js";
import { createDoubaoBrowserLogin, doubaoBrowserCandidates, selectDoubaoCookies } from "../../lib/providers/doubao/browser-login.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "doubao-access-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createDoubaoCredentialStore(directory) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("豆包凭证使用私有目录和原子文件，损坏数据不会静默重置", (t) => {
  const { directory, store } = fixture(t);
  assert.equal(store.read(), null);
  store.save("sessionid=secret; uid_tt=user");
  const first = store.read();
  assert.equal(first.cookie, "sessionid=secret; uid_tt=user");
  if (process.platform !== "win32") {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "credentials.json")).mode & 0o777, 0o600);
  }
  store.save(first.cookie);
  assert.notEqual(store.read().generation, first.generation);
  assert.deepEqual(readdirSync(directory), ["credentials.json"]);
  writeFileSync(join(directory, "credentials.json"), "broken secret");
  assert.throws(() => store.read(), /^Error: 豆包登录凭证读取失败，请重新登录$/);
  assert.equal(readFileSync(join(directory, "credentials.json"), "utf8"), "broken secret");
});

test("豆包凭证拒绝注入且失败时保留旧值", (t) => {
  const { store } = fixture(t);
  store.save("sessionid=good");
  assert.throws(() => store.save("sessionid=secret\r\nInjected: value"), /^Error: 豆包登录凭证保存失败$/);
  assert.equal(store.read().cookie, "sessionid=good");
});

test("豆包续期限制域名和路径并应用删除指令", (t) => {
  const { store } = fixture(t);
  store.save("sessionid=old; obsolete=gone");
  const snapshot = store.read();
  const headers = new Headers();
  headers.append("set-cookie", "sessionid=new; Domain=.doubao.com; Path=/; Secure");
  headers.append("set-cookie", "evil=value; Domain=evil.doubao.com; Path=/");
  headers.append("set-cookie", "bad=value; Domain=doubao.com.evil.test; Path=/");
  headers.append("set-cookie", "scoped=value; Domain=www.doubao.com; Path=/chat/");
  headers.append("set-cookie", "partition=value; Path=/; Partitioned");
  headers.append("set-cookie", "obsolete=; Path=/; Max-Age=0");
  store.renew(headers, snapshot.cookie, snapshot.generation);
  assert.equal(store.read().cookie, "sessionid=new");
  assert.equal(store.read().generation, snapshot.generation);
});

test("豆包退出和同凭证重登后拒绝旧请求续期", (t) => {
  const { store } = fixture(t);
  store.save("sessionid=same");
  const old = store.read();
  const headers = new Headers({ "set-cookie": "sessionid=stale; Path=/" });
  store.clear();
  store.renew(headers, old.cookie, old.generation);
  assert.equal(store.read(), null);
  store.save(old.cookie);
  store.renew(headers, old.cookie, old.generation);
  assert.equal(store.read().cookie, old.cookie);
});

test("豆包登录单飞，状态轻量且不会把本地保存当成已连接", async (t) => {
  const { store } = fixture(t);
  const login = deferred();
  let captures = 0, probes = 0;
  const access = createDoubaoAccess({ store, login: { capture: () => { captures++; return login.promise; } }, probe: async () => { probes++; return "valid"; } });
  assert.equal(access.status().state, "signed_out");
  assert.equal(access.start().state, "logging_in");
  access.start();
  await setImmediate();
  assert.equal(captures, 1);
  login.resolve("sessionid=private");
  await setImmediate();
  assert.equal(access.status().state, "saved");
  assert.equal(probes, 0);
  assert.equal(JSON.stringify(access.status()).includes("private"), false);
  assert.equal((await access.check()).state, "connected");
  assert.equal(probes, 1);
});

for (const operation of ["cancel", "logout", "dispose"]) {
  test(`豆包 ${operation} 使迟到登录失效`, async (t) => {
    const { store } = fixture(t);
    const login = deferred();
    let signal;
    const access = createDoubaoAccess({ store, login: { capture: (value) => { signal = value; return login.promise; } } });
    access.start();
    await setImmediate();
    access[operation]();
    assert.equal(signal.aborted, true);
    login.resolve("sessionid=late");
    await setImmediate();
    assert.equal(store.read(), null);
  });
}

test("豆包取消后重登仅保存当前登录结果", async (t) => {
  const { store } = fixture(t);
  const first = deferred(), second = deferred();
  let count = 0;
  const access = createDoubaoAccess({ store, login: { capture: () => (++count === 1 ? first.promise : second.promise) } });
  access.start();
  await setImmediate();
  access.cancel();
  access.start();
  await setImmediate();
  second.resolve("sessionid=current");
  await setImmediate();
  first.resolve("sessionid=late");
  await setImmediate();
  assert.equal(store.read().cookie, "sessionid=current");
});

test("豆包退出不会被迟到探测改回已连接", async (t) => {
  const { store } = fixture(t);
  store.save("sessionid=old");
  const probe = deferred();
  const access = createDoubaoAccess({ store, login: { capture: async () => "" }, probe: () => probe.promise });
  const checking = access.check();
  assert.equal(access.logout().state, "signed_out");
  probe.resolve("valid");
  assert.equal((await checking).state, "signed_out");
});

test("豆包失效凭证保留，异常正文不进入状态", async (t) => {
  const { store } = fixture(t);
  store.save("sessionid=secret");
  const access = createDoubaoAccess({ store, login: { capture: async () => { throw new Error("sessionid=secret"); } }, probe: async () => "expired" });
  assert.equal((await access.check()).state, "expired");
  assert.equal(store.read().cookie, "sessionid=secret");
  access.start();
  await setImmediate();
  assert.equal(access.status().state, "unavailable");
  assert.equal(JSON.stringify(access.status()).includes("secret"), false);
});

test("浏览器 Cookie 只采集豆包根域有效登录态且拒绝同名歧义", () => {
  const cookies = ["sessionid", "sessionid_ss", "sid_tt", "uid_tt"].map((name) => ({ name, value: "valid", domain: ".doubao.com", path: "/", expires: -1 }));
  assert.equal(selectDoubaoCookies(cookies.slice(1)), null);
  assert.ok(selectDoubaoCookies(cookies));
  assert.equal(selectDoubaoCookies(cookies.map((cookie) => ({ ...cookie, domain: ".bytedance.com" }))), null);
  assert.equal(selectDoubaoCookies(cookies.map((cookie) => ({ ...cookie, domain: "doubao.com" }))), null);
  assert.equal(selectDoubaoCookies(cookies.map((cookie) => ({ ...cookie, path: "/chat/" }))), null);
  assert.equal(selectDoubaoCookies(cookies.map((cookie) => ({ ...cookie, expires: 1 }))), null);
  assert.equal(selectDoubaoCookies([...cookies, { ...cookies[0], value: "other", domain: "www.doubao.com" }]), null);
});

test("浏览器候选覆盖三个系统，预先取消不会创建目录或启动浏览器", async (t) => {
  assert.ok(doubaoBrowserCandidates("darwin", {}).some((path) => path.startsWith("/Applications/")));
  assert.ok(doubaoBrowserCandidates("win32", {}).some((path) => path.endsWith("chrome.exe")));
  assert.ok(doubaoBrowserCandidates("linux", { PATH: "/usr/bin" }).includes("/usr/bin/google-chrome"));
  const { directory } = fixture(t);
  await assert.rejects(createDoubaoBrowserLogin(directory).capture(AbortSignal.abort()), /^Error: 豆包浏览器登录未完成，请重试$/);
  assert.deepEqual(readdirSync(directory), []);
});

for (const outcome of ["success", "close", "abort", "exit"]) {
  test(`豆包浏览器 ${outcome} 路径始终关闭自有进程并清理临时配置`, async (t) => {
    const { directory } = fixture(t);
    const controller = new AbortController();
    const child = new EventEmitter();
    child.pid = 99999999;
    child.kill = () => true;
    let argumentsSeen, optionsSeen, socketClosed = false;
    const killed = [];
    t.mock.method(fsPromises, "access", async () => {});
    t.mock.method(childProcess, "spawn", (_executable, args, options) => {
      if (_executable === "taskkill") {
        const killer = new EventEmitter();
        killer.kill = () => true;
        queueMicrotask(() => killer.emit("exit", 0));
        return killer;
      }
      argumentsSeen = args;
      optionsSeen = options;
      const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
      if (outcome === "exit") queueMicrotask(() => child.emit("exit", 1));
      else writeFileSync(join(profile, "DevToolsActivePort"), "49152\n/devtools/browser/test-browser\n");
      return child;
    });
    t.mock.method(process, "kill", (pid, signal) => { killed.push({ pid, signal }); return true; });
    const originalSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends EventTarget {
      constructor(url) {
        super();
        assert.equal(url, "ws://127.0.0.1:49152/devtools/browser/test-browser");
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(raw) {
        assert.equal(JSON.parse(raw).method, "Storage.getCookies");
        if (outcome === "abort") controller.abort();
        else if (outcome === "close") this.dispatchEvent(new Event("close"));
        else {
          const cookies = ["sessionid", "sessionid_ss", "sid_tt", "uid_tt"].map((name) => ({ name, value: "private", domain: ".doubao.com", path: "/" }));
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { cookies } }) }));
        }
      }
      close() { socketClosed = true; }
    };
    syncBuiltinESMExports();
    t.after(() => {
      globalThis.WebSocket = originalSocket;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const login = createDoubaoBrowserLogin(directory).capture(controller.signal);
    if (outcome === "success") assert.match(await login, /sessionid=private/);
    else await assert.rejects(login, /^Error: 豆包浏览器登录未完成，请重试$/);
    assert.ok(argumentsSeen.includes("--remote-debugging-port=0"));
    assert.ok(argumentsSeen.includes("--remote-debugging-address=127.0.0.1"));
    assert.equal(optionsSeen.shell, undefined);
    assert.equal(optionsSeen.detached, process.platform !== "win32");
    if (process.platform !== "win32") assert.ok(killed.every(({ pid }) => pid === -99999999));
    if (outcome !== "exit") assert.equal(socketClosed, true);
    assert.deepEqual(readdirSync(directory), []);
  });
}
