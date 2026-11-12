import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
