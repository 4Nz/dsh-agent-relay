import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../../lib/adapters/claude/index.js";
import { parseTranscript, finishedTurn } from "../../lib/adapters/claude/transcript.js";

const ID = "11111111-2222-3333-4444-555555555555";
let seq = 0;
const at = (n) => new Date(Date.UTC(2026, 10, 11, 0, 0, n)).toISOString();
const line = (record) => JSON.stringify(record) + "\n";
const prompt = (text, n) => line({ type: "user", uuid: `u${++seq}`, timestamp: at(n), cwd: "/tmp/w", message: { content: text } });
const meta = (n) => line({ type: "user", uuid: `m${++seq}`, timestamp: at(n), isMeta: true, message: { content: "<system-reminder>" } });
const toolResult = (n) => line({ type: "user", uuid: `r${++seq}`, timestamp: at(n), message: { content: [{ type: "tool_result", content: "ok" }] } });
const reply = (text, n, stop = "end_turn", extra = {}) =>
  line({ type: "assistant", uuid: `a${++seq}`, timestamp: at(n), message: { stop_reason: stop, content: [{ type: "text", text }] }, ...extra });
const title = (text) => line({ type: "ai-title", sessionId: ID, aiTitle: text });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-claude-"));
  const project = join(dir, "-tmp-w");
  mkdirSync(project);
  const file = join(project, `${ID}.jsonl`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file };
}
// 假 runner：agents 返回给定列表；-p 调用交给 onPrint 处理。
function runner({ agents = [], agentsFail = false, onPrint } = {}) {
  const calls = [];
  const run = async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === "agents") {
      if (agentsFail) return { code: 1, stdout: "", stderr: "boom", timedOut: false };
      return { code: 0, stdout: JSON.stringify(agents), stderr: "", timedOut: false };
    }
    return onPrint(args, options);
  };
  return { run, calls };
}
const adapter = (dir, run, extra = {}) =>
  createClaudeAdapter({ projectsDir: dir, runner: run, acceptTimeoutMs: 300, pollIntervalMs: 10, ...extra });

test("解析记录：标题、最后回复、损坏的最后一行跳过、中间行损坏报错", () => {
  const text = title("测试会话") + prompt("开始", 1) + reply("完成了", 2) + '{"type":"user"';
  const parsed = parseTranscript(text);
  assert.equal(parsed.title, "测试会话");
  assert.equal(parsed.cwd, "/tmp/w");
  assert.equal(parsed.last_reply, "完成了");
  assert.equal(parsed.last_activity_at, Date.parse(at(2)));
  assert.throws(() => parseTranscript(prompt("a", 1) + "坏行\n" + reply("b", 2)), /无法解析/);
});

test("解析记录：custom-title（手动 rename）优先于 ai-title", () => {
  const both = title("AI 自动标题") +
    line({ type: "custom-title", customTitle: "用户手动标题" }) +
    prompt("开始", 1) + reply("完成", 2);
  assert.equal(parseTranscript(both).title, "用户手动标题");

  const onlyCustom =
    line({ type: "custom-title", customTitle: "测试消息" }) +
    prompt("开始", 1) + reply("完成", 2);
  assert.equal(parseTranscript(onlyCustom).title, "测试消息");
});

test("轮次判定：基线前已结束不算；新一轮结束为 completed；工具调用中为 null；API 错误为 failed", () => {
  const history = prompt("旧任务", 1) + reply("旧结果", 2);
  const baseline = parseTranscript(history).cursor;
  assert.equal(finishedTurn(parseTranscript(history), baseline), null);

  const running = history + prompt("新任务", 3) + reply("调用工具", 4, "tool_use") + toolResult(5) + meta(6);
  assert.equal(finishedTurn(parseTranscript(running), baseline), null);

  const done = running + reply("新结果", 7);
  assert.equal(finishedTurn(parseTranscript(done), baseline).result, "completed");

  const failed = history + prompt("新任务", 3) + reply("API Error", 4, "stop_sequence", { isApiErrorMessage: true });
  assert.equal(finishedTurn(parseTranscript(failed), baseline).result, "failed");

  // 结束之后又有新提问，最近一轮未结束。
  assert.equal(finishedTurn(parseTranscript(done + prompt("再来", 8)), baseline), null);
});

test("snapshot：会话不存在为 closed；busy 时不判定结束；状态查询失败记录原因", async (t) => {
  const { dir, file } = fixture(t);
  const empty = runner();
  assert.equal((await adapter(dir, empty.run).snapshot(ID)).closed, true);

  writeFileSync(file, title("会话") + prompt("任务", 1) + reply("结果", 2));
  const idle = await adapter(dir, runner().run).snapshot(ID, null);
  assert.equal(idle.closed, false);
  assert.equal(idle.held, false);
  assert.equal(idle.finished_turn.result, "completed");
  assert.equal(idle.last_reply, "结果");

  const busy = await adapter(dir, runner({ agents: [{ sessionId: ID, kind: "interactive", status: "busy" }] }).run).snapshot(ID, null);
  assert.equal(busy.runtime, "busy");
  assert.equal(busy.finished_turn, null);

  const broken = await adapter(dir, runner({ agentsFail: true }).run).snapshot(ID, null);
  assert.equal(broken.runtime, "unknown");
  assert.match(broken.runtime_error, /退出码 1/);
  assert.match(broken.check_error, /退出码 1/);

  await assert.rejects(adapter(dir, empty.run).snapshot("../etc/passwd"), /格式无效/);
});

test("sendMessage：处理中、被终端持有、状态未知、会话不存在时拒绝，且不调用 -p", async (t) => {
  const { dir, file } = fixture(t);
  writeFileSync(file, prompt("任务", 1) + reply("结果", 2));
  const cases = [
    [{ agents: [{ sessionId: ID, status: "busy" }] }, /处理中/],
    [{ agents: [{ sessionId: ID, status: "idle" }] }, /其他进程持有/],
    [{ agentsFail: true }, /无法确认会话状态/],
  ];
  for (const [options, reason] of cases) {
    const r = runner({ ...options, onPrint: () => assert.fail("不应发送") });
    const result = await adapter(dir, r.run).sendMessage(ID, "继续");
    assert.equal(result.status, "rejected");
    assert.match(result.reason, reason);
  }
  const missing = "99999999-2222-3333-4444-555555555555";
  assert.equal((await adapter(dir, runner().run).sendMessage(missing, "继续")).status, "rejected");
});

test("sendMessage：消息写入会话记录即为 sent，消息经 stdin 传入并使用原会话 cwd", async (t) => {
  const { dir, file } = fixture(t);
  writeFileSync(file, prompt("任务", 1) + reply("结果", 2));
  const r = runner({
    onPrint: (args, options) => {
      appendFileSync(file, prompt(options.input, 3));
      // 模拟这一轮仍在执行，进程迟迟不退出。
      return new Promise(() => {});
    },
  });
  const result = await adapter(dir, r.run).sendMessage(ID, "--help 也只是普通文本");
  assert.equal(result.status, "sent");
  assert.ok(result.external_ref);
  const call = r.calls.find((c) => c.args[0] === "-p");
  assert.deepEqual(call.args, ["-p", "--resume", ID, "--permission-prompts", "none", "--output-format", "json"]);
  assert.equal(call.options.input, "--help 也只是普通文本");
  assert.equal(call.options.cwd, "/tmp/w");
});

test("sendMessage：进程报错且未写入为 failed；超时未写入为 unknown；基线前的同文消息不算", async (t) => {
  const { dir, file } = fixture(t);
  writeFileSync(file, prompt("继续", 1) + reply("结果", 2));
  const failed = runner({
    onPrint: async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: "额度不足" }), stderr: "", timedOut: false }),
  });
  const a = await adapter(dir, failed.run).sendMessage(ID, "继续");
  assert.equal(a.status, "failed");
  assert.match(a.error, /额度不足/);

  const hang = runner({ onPrint: () => new Promise(() => {}) });
  const b = await adapter(dir, hang.run).sendMessage(ID, "继续");
  assert.equal(b.status, "unknown");

  const silent = runner({ onPrint: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }) });
  assert.equal((await adapter(dir, silent.run).sendMessage(ID, "继续")).status, "unknown");
});

test("sendMessage：同一会话串行发送", async (t) => {
  const { dir, file } = fixture(t);
  writeFileSync(file, prompt("任务", 1) + reply("结果", 2));
  let active = 0,
    peak = 0,
    n = 10;
  const r = runner({
    onPrint: async (args, options) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      appendFileSync(file, prompt(options.input, ++n));
      active--;
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
    },
  });
  const a = adapter(dir, r.run);
  const results = await Promise.all([a.sendMessage(ID, "一"), a.sendMessage(ID, "二")]);
  assert.deepEqual(results.map((x) => x.status), ["sent", "sent"]);
  assert.equal(peak, 1);
});

test("runPrompt：开新会话不带 --resume，带 --add-dir，成功返回 completed", async (t) => {
  const { dir } = fixture(t);
  const r = runner({
    onPrint: async () => ({ code: 0, stdout: JSON.stringify({ result: "已安装" }), stderr: "", timedOut: false }),
  });
  const result = await adapter(dir, r.run).runPrompt("安装 skill", { addDirs: ["/tmp/skills"] });
  assert.deepEqual(result, { status: "completed", output: "已安装" });
  const call = r.calls.find((c) => c.args[0] === "-p");
  assert.equal(call.args.includes("--resume"), false);
  assert.deepEqual(call.args, ["-p", "安装 skill", "--permission-prompts", "none", "--output-format", "json", "--add-dir", "/tmp/skills"]);
  assert.equal(call.options.input, undefined);
});

test("runPrompt：非 JSON 输出摘要；is_error 或非零退出为 failed；超时为 failed", async (t) => {
  const { dir } = fixture(t);
  const plain = runner({ onPrint: async () => ({ code: 0, stdout: "普通输出", stderr: "", timedOut: false }) });
  assert.deepEqual((await adapter(dir, plain.run).runPrompt("x")).status, "completed");

  const err = runner({ onPrint: async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: "安装失败原因" }), stderr: "", timedOut: false }) });
  assert.deepEqual((await adapter(dir, err.run).runPrompt("x")), { status: "failed", error: "安装失败原因" });

  const timeout = runner({ onPrint: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
  assert.match((await adapter(dir, timeout.run).runPrompt("x")).error, /超时/);
});

test("runPrompt：空提示词拒绝", async (t) => {
  const { dir } = fixture(t);
  await assert.rejects(adapter(dir, runner().run).runPrompt("  "), /提示词内容不能为空/);
});

test("listSessions：按修改时间倒序，带标题和运行状态，忽略非会话文件", async (t) => {
  const { dir, file } = fixture(t);
  writeFileSync(file, title("会话甲") + prompt("任务", 1));
  writeFileSync(join(dir, "-tmp-w", "notes.jsonl"), "{}\n");
  const r = runner({ agents: [{ sessionId: ID, status: "busy" }] });
  const sessions = await adapter(dir, r.run).listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "会话甲");
  assert.equal(sessions[0].runtime, "busy");
  assert.equal(sessions[0].held, true);
  assert.deepEqual(await adapter(join(dir, "missing"), r.run).listSessions(), []);
});

test("会话目录不可读时抛检查失败而非视为不存在；真实缺失仍 closed", {
  skip: process.platform === "win32" ? "Windows chmod 不支持 POSIX 目录读取权限，无法构造 EACCES" : false,
}, async (t) => {
  const { dir, file } = fixture(t);
  // 真实缺失：返回 closed。
  assert.equal((await adapter(dir, runner().run).snapshot(ID)).closed, true);
  // 目录不可读：readdir 抛 EACCES，snapshot 抛 AdapterError（检查失败），不当作 closed。
  writeFileSync(file, prompt("任务", 1));
  chmodSync(dir, 0o000);
  try {
    await assert.rejects(adapter(dir, runner().run).snapshot(ID), /无法读取会话目录/);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("sendMessage：被终端持有的会话交给 channel，不调用 -p；无进程持有仍走 --resume", async (t) => {
  const { dir, file } = fixture(t);
  writeFileSync(file, prompt("任务", 1) + reply("结果", 2));
  const accepted = [];
  const channel = {
    accept: async (id) => {
      accepted.push(id);
      return id === ID ? { status: "queued" } : { status: "rejected", reason: "该会话未启用 Agent Relay channel" };
    },
  };
  for (const status of ["idle", "busy"]) {
    const r = runner({ agents: [{ sessionId: ID, status }], onPrint: () => assert.fail("不应发送") });
    assert.deepEqual(await adapter(dir, r.run, { channel }).sendMessage(ID, "继续"), { status: "queued" });
  }
  assert.deepEqual(accepted, [ID, ID]);
  // 状态查询失败时不交给 channel
  const failing = runner({ agentsFail: true, onPrint: () => assert.fail("不应发送") });
  assert.match((await adapter(dir, failing.run, { channel }).sendMessage(ID, "继续")).reason, /无法确认会话状态/);
  assert.equal(accepted.length, 2);
  // 无进程持有：沿用 --resume
  let printed = false;
  const free = runner({
    agents: [],
    onPrint: (args, options) => {
      printed = true;
      appendFileSync(file, prompt(options.input, 3));
      return { code: 0, stdout: JSON.stringify({ is_error: false, session_id: ID }), stderr: "", timedOut: false };
    },
  });
  assert.equal((await adapter(dir, free.run, { channel }).sendMessage(ID, "继续")).status, "sent");
  assert.equal(printed, true);
});

test("Claude 增量跨200条分页保留多轮与无文本页后的回复",async t=>{
 const {dir,file}=fixture(t);writeFileSync(file,prompt("旧",1)+reply("旧结果",2));const a=adapter(dir,runner().run),base=(await a.snapshot(ID)).cursor;
 appendFileSync(file,Array.from({length:200},(_,i)=>toolResult(3+i)).join("")+prompt("新",204)+reply("中间",205)+prompt("继续",206)+reply("最终",207));
 const first=await a.incremental(ID,base);assert.equal(first.events.length,0);assert.equal(first.has_more,true);
 const second=await a.incremental(ID,first.cursor);assert.deepEqual(second.events.map(e=>e.text),["新","中间","继续","最终"]);assert.equal(second.has_more,false);
 assert.deepEqual((await a.incremental(ID,second.cursor)).events,[]);
});


test("Claude 仅改名也通过增量检测返回最新标题", async t => {
 const {dir,file}=fixture(t);writeFileSync(file,title("原名")+prompt("任务",1)+reply("结果",2));
 const a=adapter(dir,runner().run),base=(await a.snapshot(ID)).cursor;
 appendFileSync(file,line({type:"custom-title",customTitle:"新名称"}));
 const page=await a.incremental(ID,base);
 assert.equal(page.title,"新名称");assert.deepEqual(page.events,[]);
});
