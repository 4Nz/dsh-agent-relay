// T5.1 Claude Adapter 真实冒烟测试。会调用本机 claude CLI 并产生少量模型费用，不在 npm test 中运行。
// 用法：npm run build && node test/smoke/claude-smoke.js
// 只操作本脚本在临时目录新建的测试会话，不读取或发送到其他会话。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../../lib/adapters/claude/index.js";
import { createRunner } from "../../lib/adapters/claude/runner.js";

const run = createRunner();
const id = randomUUID();
const marker = `RELAY-${Math.floor(Math.random() * 1e5)}`;
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "relay-smoke-")));
const log = (step, value) => console.log(`[${step}]`, JSON.stringify(value));

const version = await run(["--version"], { timeoutMs: 15_000 });
log("version", version.stdout.trim());

const created = await run(
  ["-p", "--session-id", id, "--permission-prompts", "none", "--output-format", "json"],
  { cwd, input: `记住标识 ${marker}，只回复“好的”。`, timeoutMs: 180_000 },
);
assert.equal(created.code, 0, created.stderr);
log("create", { id, cwd });

const adapter = createClaudeAdapter();
const base = await adapter.snapshot(id);
log("snapshot.base", { closed: base.closed, runtime: base.runtime, held: base.held, finished: base.finished_turn?.result, cwd: base.cwd });
assert.equal(base.closed, false);
assert.equal(base.held, false);
assert.equal(base.finished_turn?.result, "completed");

const listed = (await adapter.listSessions({ limit: 20 })).find((s) => s.id === id);
log("listSessions", { found: Boolean(listed), runtime: listed?.runtime });
assert.ok(listed);

const sent = await adapter.sendMessage(id, `之前让你记住的标识是什么？只回复标识本身。`);
log("send", sent);
assert.equal(sent.status, "sent");

// 等这一轮执行完：进程退出后不再被持有，且基线之后出现已结束的轮次。
let after;
for (let i = 0; i < 90; i++) {
  after = await adapter.snapshot(id, base.cursor);
  if (!after.held && after.finished_turn) break;
  await new Promise((r) => setTimeout(r, 2000));
}
log("snapshot.after", { runtime: after.runtime, held: after.held, finished: after.finished_turn?.result });
assert.equal(after.finished_turn?.result, "completed");
assert.ok(after.last_reply?.includes(marker), `回复中未找到 ${marker}`);
log("reply_contains_marker", true);

const missing = await adapter.snapshot(randomUUID());
log("snapshot.missing", { closed: missing.closed });
assert.equal(missing.closed, true);
console.log("冒烟测试通过");
