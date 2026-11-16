import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createChannelCredentialService, createNotificationCredentialService } from "../../lib/services/credentials.js";

function variableBytes() {
  let n = 0;
  return () => {
    const b = Buffer.alloc(32);
    b.fill(++n);
    return b;
  };
}

test("channel 凭证只保存摘要，reset 后可校验，明文不落盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-channel-credential-"));
  try {
    const service = createChannelCredentialService({ dataDir: dir, randomBytes: variableBytes() });
    const first = service.reset();
    assert.equal(first.token.length, 43);
    assert.equal(service.verify(first.token), true);
    assert.equal(service.verify("错误凭证"), false);
    const saved = readFileSync(join(dir, "claude-channel-credential.json"), "utf8");
    assert.equal(saved.includes(first.token), false);
    const second = service.reset();
    assert.equal(service.verify(first.token), false);
    assert.equal(service.verify(second.token), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("通知凭证 ensure 幂等生成明文，verify 读文件比对，端点变化视为缺失", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-notification-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "notification-client.json");
  const endpoint = "http://127.0.0.1:37421/api/agent-relay/notifications";
  const service = createNotificationCredentialService({ file, endpoint, randomBytes: variableBytes() });

  // 首次 ensure 生成新 token。
  const first = service.ensure();
  assert.equal(first.created, true);
  assert.equal(first.token.length, 43);
  assert.equal(service.status().configured, true);
  assert.equal(service.verify(first.token), true);
  assert.equal(service.verify("错误凭证"), false);

  // 文件内容是明文 token + endpoint，供发送脚本直接读取。
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.token, first.token);
  assert.equal(saved.endpoint, endpoint);

  // 再次 ensure 复用，不换 token。
  const again = service.ensure();
  assert.equal(again.created, false);
  assert.equal(again.token, first.token);

  // 端点变化时视为缺失，重新生成新 token。
  const moved = createNotificationCredentialService({ file, endpoint: "http://127.0.0.1:39999/api/agent-relay/notifications" });
  assert.equal(moved.status().configured, false);
  const second = moved.ensure();
  assert.equal(second.created, true);
  assert.notEqual(second.token, first.token);

  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("通知凭证文件损坏或 token 格式非法时 ensure 重新生成", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-notification-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "notification-client.json");
  const endpoint = "http://127.0.0.1:37421/api/agent-relay/notifications";
  const service = createNotificationCredentialService({ file, endpoint, randomBytes: variableBytes() });
  const first = service.ensure();
  // 覆盖为非法 token 后，status 判定失效并重新生成。
  writeFileSync(file, JSON.stringify({ format: 1, endpoint, token: "短" }));
  assert.equal(service.status().configured, false);
  assert.equal(service.verify(first.token), false);
  const second = service.ensure();
  assert.equal(second.created, true);
  assert.equal(service.status().configured, true);
});
