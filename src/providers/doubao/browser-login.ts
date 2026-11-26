import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureDoubaoPrivateDirectory } from "./credentials.js";
import type { DoubaoLogin } from "./access.js";

const required = ["sessionid", "sessionid_ss", "sid_tt", "uid_tt"];
const failure = () => new Error("豆包浏览器登录未完成，请重试");

/** 只接收对 www.doubao.com 的账户及聊天路径均有效的 Cookie。 */
export function selectDoubaoCookies(cookies: unknown[]): string | null {
  const pairs = new Map<string, string>();
  for (const entry of cookies) {
    if (!entry || typeof entry !== "object") continue;
    const cookie = entry as Record<string, unknown>;
    const { name, value, domain, path, expires, partitionKey } = cookie;
    if (typeof name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (typeof value !== "string" || !/^[\x21-\x3A\x3C-\x7E]+$/.test(value)) continue;
    if (typeof domain !== "string" || ![".doubao.com", ".www.doubao.com", "www.doubao.com"].includes(domain.toLowerCase())) continue;
    if (path !== "/" || partitionKey !== undefined) continue;
    if (typeof expires === "number" && expires > 0 && expires * 1000 <= Date.now()) continue;
    // 同名 host/domain Cookie 的先后顺序不稳定，拒绝歧义，等待下次读取。
    if (pairs.has(name) && pairs.get(name) !== value) return null;
    pairs.set(name, value);
  }
  if (required.some((name) => !pairs.has(name))) return null;
  return [...pairs].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function doubaoBrowserCandidates(platform = process.platform, env = process.env): string[] {
  if (platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ...["Google Chrome", "Microsoft Edge"].map((name) => join(env.HOME ?? "", "Applications", `${name}.app`, "Contents", "MacOS", name)),
  ];
  if (platform === "win32") return [...new Set([
    env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA,
    "C:\\Program Files", "C:\\Program Files (x86)",
  ].filter((root): root is string => Boolean(root)))].flatMap((root) => [
    `${root}\\Google\\Chrome\\Application\\chrome.exe`,
    `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ]);
  return (env.PATH ?? "/usr/bin:/usr/local/bin:/snap/bin").split(delimiter).filter(Boolean).flatMap((root) =>
    ["google-chrome", "google-chrome-stable", "microsoft-edge", "microsoft-edge-stable", "chromium", "chromium-browser"].map((name) => join(root, name)),
  );
}

async function findBrowser(): Promise<string> {
  for (const executable of doubaoBrowserCandidates()) {
    try { await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK); return executable; }
    catch { /* 继续检查下一个已安装浏览器。 */ }
  }
  throw new Error("未找到可执行的 Chrome 或 Edge 浏览器");
}

async function waitForDevtools(profile: string, signal: AbortSignal): Promise<string> {
  const readySignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  while (!readySignal.aborted) {
    try {
      const [portText, socketPath] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      const port = Number(portText);
      if (/^\d+$/.test(portText) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(socketPath)) {
        return `ws://127.0.0.1:${port}${socketPath}`;
      }
    } catch { /* 启动早期文件尚未写入。 */ }
    await delay(200, undefined, { signal: readySignal });
  }
  throw failure();
}

async function readCookies(url: string, signal: AbortSignal): Promise<unknown[]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  requestSignal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    function finish(cookies?: unknown[]): void {
      if (settled) return;
      settled = true;
      requestSignal.removeEventListener("abort", abort);
      try { socket.close(); } catch { /* 连接未建立时也须释放。 */ }
      if (cookies) resolve(cookies);
      else reject(failure());
    }
    const abort = () => finish();
    requestSignal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("error", () => finish(), { once: true });
    socket.addEventListener("close", () => finish(), { once: true });
    socket.addEventListener("open", () => {
      if (!settled) {
        try { socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies", params: {} })); }
        catch { finish(); }
      }
    }, { once: true });
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        finish(!message.error && Array.isArray(message.result?.cookies) ? message.result.cookies : undefined);
      } catch { finish(); }
    });
    if (requestSignal.aborted) finish();
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 2_000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once("error", () => { child.kill(); done(); });
      killer.once("exit", done);
    });
    return;
  }
  // detached 为本次登录创建独立进程组，不触碰用户原有浏览器。
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await delay(300);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* 整个进程组已退出。 */ }
}

export function createDoubaoBrowserLogin(directory: string): DoubaoLogin {
  return {
    async capture(signal) {
      let profile: string | undefined;
      let child: ChildProcess | undefined;
      const exited = new AbortController();
      const deadline = AbortSignal.timeout(300_000);
      const lifetime = AbortSignal.any([signal, exited.signal, deadline]);
      try {
        lifetime.throwIfAborted();
        const executable = await findBrowser();
        lifetime.throwIfAborted();
        ensureDoubaoPrivateDirectory(directory);
        profile = await mkdtemp(join(directory, "login-"));
        lifetime.throwIfAborted();
        child = spawn(executable, [
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "--no-first-run", "--no-default-browser-check",
          "https://www.doubao.com/chat/",
        ], { stdio: "ignore", detached: process.platform !== "win32", windowsHide: false });
        child.once("error", () => exited.abort());
        child.once("exit", () => exited.abort());
        const url = await waitForDevtools(profile, lifetime);
        while (!lifetime.aborted) {
          const cookie = selectDoubaoCookies(await readCookies(url, lifetime));
          lifetime.throwIfAborted();
          if (cookie) return cookie;
          await delay(1_000, undefined, { signal: lifetime });
        }
        throw failure();
      } catch { throw failure(); }
      finally {
        if (child) await terminate(child);
        if (profile) {
          try { await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
          catch { throw new Error("豆包临时登录目录清理失败"); }
        }
      }
    },
  };
}
