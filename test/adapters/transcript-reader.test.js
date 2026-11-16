import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptReader } from "../../lib/adapters/claude/transcript-reader.js";
import { finishedTurn, findPrompt } from "../../lib/adapters/claude/transcript.js";

let seq = 0;
const at = (n) => new Date(Date.UTC(2026, 10, 11, 0, 0, n)).toISOString();
const line = (record) => JSON.stringify(record) + "\n";
const prompt = (text, n) =>
  line({ type: "user", uuid: `u${++seq}`, timestamp: at(n), cwd: "/tmp/w", message: { content: text } });
const meta = (n) =>
  line({ type: "user", uuid: `m${++seq}`, timestamp: at(n), isMeta: true, message: { content: "<system-reminder>" } });
const toolResult = (n) =>
  line({ type: "user", uuid: `r${++seq}`, timestamp: at(n), message: { content: [{ type: "tool_result", content: "ok" }] } });
const reply = (text, n, stop = "end_turn", extra = {}) =>
  line({ type: "assistant", uuid: `a${++seq}`, timestamp: at(n), message: { stop_reason: stop, content: [{ type: "text", text }] }, ...extra });

function fixture(t) {
  seq = 0;
  const dir = mkdtempSync(join(tmpdir(), "relay-reader-"));
  const file = join(dir, "session.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { file };
}

test("全量扫描与快照语义一致：标题、cwd、最后回复、cursor", async (t) => {
  const { file } = fixture(t);
  writeFileSync(file, line({ type: "ai-title", aiTitle: "标题" }) + prompt("任务", 1) + reply("结果", 2));
  const reader = new TranscriptReader(file);
  const tr = await reader.scan();
  assert.equal(tr.title, "标题");
  assert.equal(tr.cwd, "/tmp/w");
  assert.equal(tr.last_reply, "结果");
  assert.equal(tr.cursor.uuid, "a2");
  assert.equal(tr.last_activity_at, Date.parse(at(2)));
});

test("标题：手动 rename 的 custom-title 优先于 ai-title，仅 custom-title 也能读出", async (t) => {
  const { file } = fixture(t);
  writeFileSync(file,
    line({ type: "ai-title", aiTitle: "AI 自动标题" }) +
    line({ type: "custom-title", customTitle: "用户手动标题" }) +
    prompt("任务", 1) + reply("结果", 2));
  assert.equal((await new TranscriptReader(file).scan()).title, "用户手动标题");

  writeFileSync(file,
    line({ type: "custom-title", customTitle: "测试消息" }) +
    prompt("任务", 1) + reply("结果", 2));
  assert.equal((await new TranscriptReader(file).scan()).title, "测试消息");
});

test("reader 快照配合轮次判定：基线命中/缺失时间回退、完成/失败、工具结果与 meta", async (t) => {
  const { file } = fixture(t);
  const history = prompt("旧任务", 1) + reply("旧结果", 2);
  writeFileSync(file, history);
  const base = (await new TranscriptReader(file).scan()).cursor;
  assert.equal(finishedTurn((await new TranscriptReader(file).scan()), base), null);

  // 工具调用中：busy，未结束。
  writeFileSync(file, history + prompt("新任务", 3) + reply("调用工具", 4, "tool_use") + toolResult(5) + meta(6));
  assert.equal(finishedTurn((await new TranscriptReader(file).scan()), base), null);

  // 完成。
  appendFileSync(file, reply("新结果", 7));
  assert.equal(finishedTurn((await new TranscriptReader(file).scan()), base).result, "completed");

  // 失败（API 错误）。
  const failed = history + prompt("再试", 8) + reply("API Error", 9, "stop_sequence", { isApiErrorMessage: true });
  writeFileSync(file, failed);
  assert.equal(finishedTurn((await new TranscriptReader(file).scan()), base).result, "failed");

  // sidechain 记录不计入轮次。
  const sidechain = history + prompt("任务", 10) + line({ type: "assistant", uuid: `s${++seq}`, timestamp: at(11), isSidechain: true, message: { stop_reason: "end_turn" } });
  writeFileSync(file, sidechain);
  assert.equal(finishedTurn((await new TranscriptReader(file).scan()), base), null);
});

test("增量读取：追加小消息只读新增字节，基线前的同文消息不算", async (t) => {
  const { file } = fixture(t);
  writeFileSync(file, prompt("继续", 1) + reply("结果", 2));
  const reader = new TranscriptReader(file);
  const before = await reader.scan();
  const offsetAfterScan = reader.bytesRead;
  // 空轮询不再读历史。
  await reader.readMore();
  assert.equal(reader.bytesRead, offsetAfterScan);
  // 追加一条回复，只读新增。
  appendFileSync(file, reply("新回复", 3));
  const after = await reader.readMore();
  assert.ok(reader.bytesRead > offsetAfterScan);
  assert.ok(reader.bytesRead - offsetAfterScan < 1024);
  assert.equal(after.entries.at(-1).uuid, "a3");
  // findPrompt 用发送前基线：基线前已有同文消息不算。
  assert.equal(findPrompt(after, before.cursor, "继续"), null);
});

test("部分尾行跨轮保留，补全后解析；UTF-8 中文正确解码", async (t) => {
  const { file } = fixture(t);
  writeFileSync(file, prompt("任务", 1));
  const reader = new TranscriptReader(file);
  await reader.scan();
  // 未完成尾行（不完整 JSON）。
  appendFileSync(file, '{"type":"assistant","uuid":"a2","timestamp":"' + at(2) + '","message":{"stop_reason":"end_turn","content":[{');
  const partial = await reader.readMore();
  assert.equal(partial.entries.at(-1).uuid, "u1");
  // 补全尾行 + 换行，并含中文内容。
  appendFileSync(file, '"type":"text","text":"完成啦"}]}}\n');
  const done = await reader.readMore();
  assert.equal(done.entries.at(-1).uuid, "a2");
  assert.equal(done.last_reply, "完成啦");
});

test("文件截短后重新全量扫描", async (t) => {
  const { file } = fixture(t);
  const first = prompt("任务一", 1) + reply("结果一", 2);
  writeFileSync(file, first + prompt("任务二", 3) + reply("结果二", 4));
  const reader = new TranscriptReader(file);
  let tr = await reader.scan();
  assert.equal(tr.entries.length, 4);
  // 文件被截短为只有前两条（用同样字符串）。
  writeFileSync(file, first);
  tr = await reader.readMore();
  assert.equal(tr.entries.length, 2);
  assert.equal(tr.cursor.uuid, "a2");
});

test("约 32MiB 历史：扫描后反复空轮询不再读历史，追加小消息仅读新增字节", async (t) => {
  const { file } = fixture(t);
  const target = 32 * 1024 * 1024;
  const row = JSON.stringify({ type: "user", uuid: "u0", timestamp: at(1), message: { content: "x".repeat(2000) } }) + "\n";
  let size = 0;
  while (size < target) {
    appendFileSync(file, row);
    size += Buffer.byteLength(row);
  }
  const reader = new TranscriptReader(file);
  await reader.scan();
  const afterScan = reader.bytesRead;
  assert.ok(afterScan >= target);
  // 反复空轮询：字节偏移不变，不重新读取历史。
  await reader.readMore();
  await reader.readMore();
  await reader.readMore();
  assert.equal(reader.bytesRead, afterScan);
  // 追加一条小消息，仅读新增字节。
  appendFileSync(file, reply("完成", 9999));
  await reader.readMore();
  const delta = reader.bytesRead - afterScan;
  assert.ok(delta > 0);
  assert.ok(delta < 1024, `追加读取 ${delta} 字节应远小于全量`);
});
