import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialService } from "../../lib/services/credentials.js";

function variableBytes() {
  let n = 0;
  return () => {
    const b = Buffer.alloc(32);
    b.fill(++n);
    return b;
  };
}

test("共享凭证只保存摘要，生成后可校验，明文不落盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-credentials-"));
  try {
    const service = createCredentialService({ dataDir: dir, randomBytes: variableBytes() });
    assert.equal(service.get().configured, false);
    const first = service.generate();
    assert.equal(first.token.length, 43);
    assert.equal(service.verify(first.token), true);
    assert.equal(service.verify("错误凭证"), false);
    const saved = readFileSync(join(dir, "notification-credential.json"), "utf8");
    assert.equal(saved.includes(first.token), false);
    assert.equal(service.get().configured, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("通知客户端配置同步原文和端点，重置后重开读取最新凭证，查询不泄露", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay 凭证-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clientConfig = { path: join(dir, "notification-client.json"), endpoint: "http://127.0.0.1:37429/api/agent-relay/notifications" };
  const service = createCredentialService({ dataDir: dir, clientConfig, randomBytes: variableBytes() });
  const first = service.generate();
  assert.equal(JSON.parse(readFileSync(clientConfig.path)).token, first.token);
  assert.equal(JSON.parse(readFileSync(clientConfig.path)).endpoint, clientConfig.endpoint);
  assert.equal(JSON.stringify(service.get()).includes(first.token), false);
  assert.equal(service.get().client_configured, true);
  assert.equal(service.reveal().token, first.token);
  const second = service.reset();
  const reopened = createCredentialService({ dataDir: dir, clientConfig });
  assert.equal(reopened.reveal().token, second.token);
  assert.equal(reopened.verify(first.token), false);
  if (process.platform !== "win32") assert.equal(statSync(clientConfig.path).mode & 0o777, 0o600);
  rmSync(clientConfig.path);
  assert.equal(reopened.get().client_configured, false);
  assert.throws(() => reopened.reveal(), /重新生成/);
  reopened.reset();
  assert.equal(reopened.get().client_configured, true);
});

test("客户端写入失败保留旧凭证；摘要写入失败恢复旧客户端文件", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-credentials-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "notification-client.json");
  const options = { dataDir: dir, clientConfig: { path, endpoint: "http://127.0.0.1:37421/api/agent-relay/notifications" }, randomBytes: variableBytes() };
  const service = createCredentialService(options);
  const first = service.generate();
  rmSync(path); mkdirSync(path);
  assert.throws(() => service.reset());
  assert.equal(service.verify(first.token), true);
  rmSync(path, { recursive: true });
  // 恢复客户端，再令摘要文件不可被原子替换。
  service.reset();
  const currentClient = readFileSync(path, "utf8");
  const digestPath = join(dir, "notification-credential.json");
  rmSync(digestPath); mkdirSync(digestPath);
  assert.throws(() => service.reset());
  assert.equal(readFileSync(path, "utf8"), currentClient);
});

test("generate 已有凭证时冲突且旧 token 仍有效；reset 替换后旧 token 失效", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-credentials-"));
  try {
    const service = createCredentialService({ dataDir: dir, randomBytes: variableBytes() });
    const first = service.generate();
    assert.equal(service.verify(first.token), true);
    // 同一服务再次 generate 冲突，旧 token 仍有效。
    assert.throws(() => service.generate(), (e) => e?.code === "conflict");
    assert.equal(service.verify(first.token), true);
    // reset 替换为全新 token，旧 token 失效。
    const second = service.reset();
    assert.notEqual(second.token, first.token);
    assert.equal(service.verify(first.token), false);
    assert.equal(service.verify(second.token), true);
    // 重开服务（新实例、同一文件）再次 generate 仍冲突。
    const reopened = createCredentialService({ dataDir: dir, randomBytes: variableBytes() });
    assert.throws(() => reopened.generate(), (e) => e?.code === "conflict");
    assert.equal(reopened.verify(second.token), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
