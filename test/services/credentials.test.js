import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialService } from "../../lib/services/credentials.js";

test("共享凭证只保存摘要，生成后可校验，重置使旧凭证失效", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-credentials-"));
  try {
    const service = createCredentialService({ dataDir: dir, randomBytes: () => Buffer.alloc(32, 7) });
    const first = service.generate();
    assert.equal(first.token.length, 43);
    assert.equal(service.verify(first.token), true);
    assert.equal(service.verify("错误凭证"), false);
    const saved = readFileSync(join(dir, "notification-credential.json"), "utf8");
    assert.equal(saved.includes(first.token), false);
    const second = service.reset();
    assert.equal(second.token, first.token);
    assert.equal(service.verify(first.token), true);
    assert.equal(service.get().configured, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
