import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner } from "../../lib/adapters/claude/runner.js";

test("runner 超时先 TERM 后 KILL，忽略 TERM 的子进程在确定上限内完成 timedOut", async () => {
  const runner = createRunner(process.execPath);
  const start = Date.now();
  const result = await runner(
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { timeoutMs: 100 },
  );
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, true);
  // TERM(100ms) + 1s 宽限 + KILL + 最多 1s 收尾，应在数秒内结算而不是挂起。
  assert.ok(elapsed < 5000, `耗时 ${elapsed}ms 应在上限内`);
});

test("runner 正常退出返回退出码，不超时", async () => {
  const runner = createRunner(process.execPath);
  const result = await runner(["-e", "process.stdout.write('ok'); process.exit(0)"]);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "ok");
});

test("runner 不存在的二进制以 ENOENT 拒绝", async () => {
  const runner = createRunner("/nonexistent/binary/definitely-missing");
  await assert.rejects(runner([]), /ENOENT/);
});
