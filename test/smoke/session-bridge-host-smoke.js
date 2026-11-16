// T1/T2/T3/T4/T6/T7：隔离真实 DSH 宿主，确定性模型 + 合成 Claude 历史。
// 不调用真实外部 Agent，不安装用户配置，不产生模型费用。先 npm run build。
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  cpSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { openRelayStore } from "../../lib/storage/index.js";
import {
  createChannelCredentialService,
  createNotificationCredentialService,
} from "../../lib/services/credentials.js";
import { ruleText, shellBlock } from "../../lib/services/setup.js";

const install =
  process.env.DSH_INSTALL_ROOT ??
  "/Users/nzimp/.local/lib/node_modules/@deepseek-ai/dsh";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-bridge-host-")));
const dshHome = join(root, "dsh"),
  claudeHome = join(root, "claude"),
  fixtureBin = join(root, "bin"),
  cwd = join(root, "workspace");
const profile = join(dshHome, "profiles/web"),
  plugin = join(profile, "node_modules/dsh-agent-relay");
for (const directory of [plugin, claudeHome, fixtureBin, cwd])
  mkdirSync(directory, { recursive: true });
const write = (file, body) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
};
symlinkSync(
  join(install, "node_modules/@deepseek-ai"),
  join(profile, "node_modules/@deepseek-ai"),
  "dir",
);
for (const path of ["package.json", "cordis.patch.yml", "lib", "skills"])
  cpSync(join(repository, path), join(plugin, path), { recursive: true });
const version = JSON.parse(readFileSync(join(install, "package.json"))).version;
write(
  join(profile, "package.json"),
  JSON.stringify({
    name: "relay-bridge-host-fixture",
    private: true,
    type: "module",
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "dsh-agent-relay",
        ],
      },
    },
    dependencies: {
      "@deepseek-ai/dsh-base": version,
      "@deepseek-ai/dsh-web-app": version,
      "dsh-agent-relay": "0.1.0",
    },
  }),
);
write(join(profile, "cordis.patch.yml"), "[]\n");
// CLI 白名单：所有未列出的动作（尤其 -p/--resume）硬失败；调用记录只含测试参数。
const cliLog = join(root, "fixture-cli.jsonl");
write(
  join(fixtureBin, "claude"),
  `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2);appendFileSync(${JSON.stringify(cliLog)},JSON.stringify(a)+'\\n');\nif(a.length===1&&a[0]==='--version') console.log('2.1.0 fixture');\nelse if(a[0]==='agents'&&a[1]==='--json') console.log('[]');\nelse if(a.length===1&&a[0]==='--dangerously-load-development-channels'){console.error('argument missing');process.exitCode=1;}\nelse {console.error('fixture禁止执行');process.exitCode=97;}\n`,
);
write(join(fixtureBin, "package.json"), '{"type":"module"}');
chmodSync(join(fixtureBin, "claude"), 0o700);
write(
  join(fixtureBin, "codex"),
  `#!${process.execPath}\nprocess.stderr.write('fixture禁止Codex执行');process.exit(97);\n`,
);
chmodSync(join(fixtureBin, "codex"), 0o700);
const reserve = createServer();
await new Promise((ok, reject) =>
  reserve.once("error", reject).listen(0, "127.0.0.1", ok),
);
const port = reserve.address().port;
await new Promise((ok) => reserve.close(ok));
const endpoint = `http://127.0.0.1:${port}/api/agent-relay/notifications`;
// 仅改变本测试进程环境；HOME/CODEX_HOME 保持不变。不调用 setup.install。
Object.assign(process.env, {
  DSH_HOME: dshHome,
  CLAUDE_CONFIG_DIR: claudeHome,
  ZDOTDIR: root,
  SHELL: "/bin/zsh",
  PATH: fixtureBin + ":" + process.env.PATH,
  DSH_TELEMETRY_DISABLED: "1",
  DSH_AGENT_RELAY_PORT: String(port),
});
const dataDir = join(dshHome, "agent-relay");
const { token } = createNotificationCredentialService({
  file: join(dataDir, "notification-client.json"),
  endpoint,
}).ensure();
write(
  join(claudeHome, "agent-relay/channel-token"),
  createChannelCredentialService({ dataDir }).reset().token,
);
write(
  join(claudeHome, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      "agent-relay": {
        command: process.execPath,
        args: [join(plugin, "lib/channel/main.js")],
      },
    },
  }),
);
write(join(claudeHome, "agent-relay.md"), ruleText());
write(join(claudeHome, "CLAUDE.md"), "@agent-relay.md\n");
write(join(root, ".zshrc"), shellBlock());
cpSync(join(plugin, "skills"), join(claudeHome, "skills"), { recursive: true });
const externalId = randomUUID(),
  transcript = join(claudeHome, "projects/fixture", externalId + ".jsonl");
function append(text) {
  appendFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd,
      message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
    }) + "\n",
  );
}
write(transcript, "");
append("基线：专用合成数据");
// 只计数指定fixture文件的真实读取，其他文件原样委托；不替换Adapter行为。
let externalReads = 0;
const originalOpen = fsPromises.open;
fsPromises.open = function (path, ...args) {
  if (String(path) === transcript) externalReads++;
  return originalOpen.call(this, path, ...args);
};
syncBuiltinESMExports();
const launchFile = readdirSync(join(install, "lib")).find((name) =>
  /^profile-boot-.*\.js$/.test(name),
);
assert.ok(launchFile, "本机 DSH 启动器版本不兼容");
const { o: runProfile } = await import(join(install, "lib", launchFile));
const { createLaunchEnvironmentSnapshot } = await import(
  join(install, "node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js")
);
const { LlmAdapter } = await import(
  join(install, "node_modules/@deepseek-ai/dsh-llm/lib/index.js")
);
let releaseBusy,
  busyStarted = false,
  decision = "continue";
const modelCalls = [],
  nativeToolCalls = [],
  modelTurns = new Map();
function toolValue(value) {
  if (typeof value === "string") {
    try {
      return toolValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  if (value.ok === false && value.error) throw Error(JSON.stringify(value));
  if (value.ok === true && value.value) return value.value;
  for (const child of Object.values(value)) {
    const found = toolValue(child);
    if (found) return found;
  }
  return null;
}
class FixtureModel extends LlmAdapter {
  async listModels() {
    return [
      {
        provider: "bridge-fixture",
        id: "fixture",
        name: "桥梁隔离验收模型",
        contextWindow: 128000,
      },
    ];
  }
  async *stream(options) {
    const ui = options.messages.findLastIndex(
        (m) =>
          m.role === "user" &&
          /agent-relay-v2:|decision_version|FIXTURE_BUSY_GATE/.test(
            JSON.stringify(m.content),
          ),
      ),
      ti = options.messages.findLastIndex((m) => m.role === "tool");
    const last = options.messages[ui],
      content = last?.content;
    const text =
      typeof content === "string"
        ? content
        : (content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    if (ui > ti && text.includes("FIXTURE_BUSY_GATE")) {
      busyStarted = true;
      await new Promise((ok) => {
        releaseBusy = ok;
      });
    }
    let facts;
    try {
      facts = JSON.parse(text);
    } catch {}
    const marker = text.match(/\[agent-relay-v2:([A-Za-z0-9_-]+)\]/);
    const id =
      facts?.subscription_id ??
      (marker ? Buffer.from(marker[1], "base64url").toString() : null);
    const key = ui + ":" + text;
    let state = modelTurns.get(key);
    if (id && (!state || state.phase !== "done")) {
      if (!state) {
        const planning = facts?.events?.some((e) => e.kind === "planning");
        state = { phase: planning ? "plan" : "check" };
        modelTurns.set(key, state);
        modelCalls.push({
          source: planning ? "planning" : marker ? "schedule" : "push",
          decision,
          at: Date.now(),
        });
      }
      let name, args;
      if (state.phase === "plan") {
        name = "relay_plan";
        args = { subscription_id: id, check_interval_seconds: 60 };
        state.phase = "after_plan";
      } else if (state.phase === "check" || state.phase === "after_plan") {
        if (state.phase === "after_plan")
          assert.ok(toolValue(options.messages[ti]), "规划工具未成功返回");
        name = "relay_check";
        args = { subscription_id: id };
        state.phase = "after_check";
      } else if (state.phase === "after_check") {
        const value = toolValue(options.messages[ti]);
        assert.ok(value, "检查工具未成功返回");
        state.phase = "done";
        if (value.batch_id) {
          name = "relay_decide";
          args = {
            subscription_id: id,
            batch_id: value.batch_id,
            decision_version: value.decision_version,
            decision,
          };
        }
      }
      if (name) {
        assert.ok(
          options.tools?.some((t) => t.name === name),
          "宿主未提供原生工具：" + name,
        );
        nativeToolCalls.push({ name, args });
        const block = {
          type: "tool-call",
          id: "fixture-" + randomUUID(),
          name,
          arguments: JSON.stringify(args),
        };
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: 0,
          id: block.id,
          name: block.name,
          argumentsDelta: block.arguments,
        };
        yield { type: "block-end", index: 0, block };
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "隔离验收处理完成" };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "隔离验收处理完成" },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
async function until(predicate, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw Error("等待超时：" + label);
}
// 本机宿主可能打印一次性控制台凭证。只落临时私有日志，不回显原始启动输出。
const privateLog = join(root, "host-private.log");
const stdoutWrite = process.stdout.write.bind(process.stdout),
  stderrWrite = process.stderr.write.bind(process.stderr);
for (const stream of [process.stdout, process.stderr])
  stream.write = function (chunk, encoding, callback) {
    appendFileSync(privateLog, chunk);
    const cb = typeof encoding === "function" ? encoding : callback;
    cb?.();
    return true;
  };
let app, store;
const evidence = {
  date: new Date().toISOString(),
  node: process.version,
  dsh: version,
  scenarios: [],
  modelCalls,
  nativeToolCalls,
};
function report(text) {
  evidence.scenarios.push(text);
  stdoutWrite(text + "\n");
}
const deadline = setTimeout(() => {
  stderrWrite("隔离宿主验收超过总时限\n");
  process.exit(1);
}, 240000);
try {
  app = await runProfile({
    environment: createLaunchEnvironmentSnapshot([
      { source: "process", values: process.env },
    ]),
    profile: "web",
    patchFiles: [],
    args: ["--no-open", "--port", "0"],
  });
  const ctx = app.ctx;
  ctx.get("llm").registerAdapter(["bridge-fixture"], new FixtureModel());
  const { sessionId } = await ctx.get("sessionController").create({ cwd });
  await ctx
    .get("sessionController")
    .selectModel({ sessionId, provider: "bridge-fixture", model: "fixture" });
  const { agent } = await ctx.get("sessionController").resolveAgent(sessionId);
  store = openRelayStore({ dataDir });
  const tool = (name, args, context = { agent }) =>
    ctx
      .get("tools")
      .get(name)
      .execute(args, { ...context, signal: AbortSignal.timeout(15000) });
  // 省略 exec.agent 模拟页面的无当前会话语义，仍用默认入口注册的真实工具/服务。
  const first = await tool(
    "relay_subscribe",
    {
      agent: "claude",
      external_session_id: externalId,
      dsh_session_id: sessionId,
      topic: "汇报合成进展直到明确结束",
    },
    {},
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  const subId = first.value.subscription.id,
    sub = () => store.subscriptions.get(subId);
  await until(
    () =>
      sub().schedule_task_id &&
      sub().planning_state === "ready" &&
      agent.status === "idle",
    "模型规划并确认",
  );
  assert.equal(sub().selected_interval_seconds, 60);
  assert.ok(
    (await ctx.get("schedule").catalog()).some(
      (t) => t.id === sub().schedule_task_id,
    ),
  );
  report(
    "通过：生产入口无频率关注 → fixture模型 relay_plan/check/decide → 真实宿主60秒提醒",
  );
  append("第一轮已完成，但关注目标尚未达成");
  const plannedAt = Date.now();
  await until(
    () =>
      modelCalls.some((c) => c.source === "schedule") &&
      agent.status === "idle" &&
      sub().planning_state === "ready",
    "真实60秒调度检查",
    90000,
  );
  assert.ok(Date.now() - plannedAt >= 55000, "未经历真实最短调度等待");
  assert.equal(sub().status, "active");
  report(
    "通过：真实60秒 schedule → 模型 relay_check/decide continue，单轮完成仍 active",
  );
  const pushIds = [];
  const push = async (summary) => {
    const requestId = randomUUID();
    pushIds.push(requestId);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        request_id: requestId,
        agent: "claude",
        external_session_id: externalId,
        result: "completed",
        summary,
      }),
    });
    assert.equal(response.status, 202, await response.text());
  };
  agent.followup({
    id: randomUUID(),
    role: "user",
    source: { kind: "fixture" },
    content: [{ type: "text", text: "FIXTURE_BUSY_GATE" }],
  });
  await until(() => busyStarted && agent.status === "running", "真实Agent忙碌");
  const before = modelCalls.filter((c) => c.source === "push").length;
  await push("忙时消息A");
  await push("忙时消息B");
  assert.equal(sub().schedule_task_id, null);
  assert.equal((await ctx.get("schedule").catalog()).length, 0);
  assert.equal(modelCalls.filter((c) => c.source === "push").length, before);
  assert.ok(
    pushIds.every((id) => {
      const event = store.bridge.event("push:" + id);
      return event && event.batch_id === null && event.processed_at === null;
    }),
  );
  releaseBusy();
  await until(
    () =>
      modelCalls.filter((c) => c.source === "push").length === before + 1 &&
      agent.status === "idle" &&
      sub().schedule_task_id,
    "空闲后合批唤醒并恢复",
    45000,
  );
  const pushed = pushIds.map((id) => store.bridge.event("push:" + id));
  assert.equal(pushed.length, 2);
  assert.equal(pushed[0].batch_id, pushed[1].batch_id);
  assert.ok(pushed.every((event) => event.processed_at !== null));
  assert.deepEqual(
    pushed.map((event) => JSON.parse(event.body).summary),
    ["忙时消息A", "忙时消息B"],
  );
  const events = await tool("relay_check", { subscription_id: subId });
  assert.equal(events.value.status, "unchanged");
  report(
    "通过：Agent running时两次HTTP push落库且删除提醒；空闲后只合批唤醒一次并恢复提醒",
  );
  decision = "end";
  await push("关注目标已达成，明确结束");
  await until(
    () => sub().status === "ended" && agent.status === "idle",
    "模型结束关注",
  );
  assert.equal((await ctx.get("schedule").catalog()).length, 0);
  report("通过：push打断等待 → 模型 relay_decide end → 宿主提醒删除");
  decision = "continue";
  const next = await tool("relay_subscribe", {
    agent: "claude",
    external_session_id: externalId,
    check_interval_seconds: 60,
  });
  assert.equal(next.ok, true, JSON.stringify(next));
  const nextId = next.value.subscription.id;
  // 仅将本测试SQLite记录整体前移24小时，保持schema固定寿命约束；不等待真实一天。
  const fixtureDb = new DatabaseSync(join(dataDir, "agent-relay.sqlite"));
  const cutoff = Date.now() - 1;
  fixtureDb
    .prepare(
      "UPDATE relay_subscription SET created_at=?,hard_expires_at=?,expires_at=? WHERE id=?",
    )
    .run(cutoff - 86400000, cutoff, cutoff, nextId);
  fixtureDb.close();
  const readsBeforeExpiry = externalReads;
  // 毒化临时历史：若错误解析就会产生检查失败，验证截止在外部解析之前拦截。
  write(transcript, "这不是合法JSON\n");
  const expired = await tool("relay_check", { subscription_id: nextId });
  assert.equal(expired.ok, true);
  assert.equal(expired.value.status, "inactive");
  assert.equal(store.subscriptions.get(nextId).status, "ended");
  assert.equal(store.subscriptions.get(nextId).consecutive_failures, 0);
  assert.equal((await ctx.get("schedule").catalog()).length, 0);
  assert.equal(
    (await tool("relay_check", { subscription_id: nextId })).value.status,
    "inactive",
  );
  assert.equal(externalReads, readsBeforeExpiry, "到期后不应打开外部历史");
  evidence.externalReadsBeforeExpiry = readsBeforeExpiry;
  evidence.externalReadsAfterExpiry = externalReads;
  report(
    "通过：固定截止拦截、失效检查不读取毒化外部历史、宿主提醒清理，残留检查仍inactive",
  );
  const log = await ctx.get("sessionQuery").readSession(sessionId);
  assert.ok(
    log.events
      .filter((e) => e.type === "request/context")
      .every((e) => e.data.provider === "bridge-fixture"),
  );
  const relayInbox = log.events
    .filter((e) => e.type === "agent/inbox/spliced")
    .flatMap((e) => e.data.inserted ?? [])
    .filter((m) => m.source?.kind === "agent-relay");
  assert.equal(new Set(relayInbox.map((m) => m.id)).size, relayInbox.length);
  const cliCalls = readFileSync(cliLog, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    cliCalls.every(
      (a) =>
        a[0] === "--version" ||
        a[0] === "--dangerously-load-development-channels" ||
        a[0] === "agents",
    ),
  );
  evidence.relayInboxCount = relayInbox.length;
  evidence.cliCalls = cliCalls.length;
  report(
    "通过：Relay inbox稳定ID无重复；假CLI只有只读白名单调用，未调用真实模型/外部发送",
  );
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.stack;
  if (app) {
    const list = await app.ctx.get("sessionQuery").listSessions();
    write(
      join(root, "fixture-session-debug.json"),
      JSON.stringify(
        await Promise.all(
          list.map((s) => app.ctx.get("sessionQuery").readSession(s.header.id)),
        ),
      ),
    );
  }
  process.exitCode = 1;
  stderrWrite(error.stack + "\n");
} finally {
  releaseBusy?.();
  store?.close();
  await app?.ctx.fiber.dispose();
  clearTimeout(deadline);
  fsPromises.open = originalOpen;
  syncBuiltinESMExports();
  write(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  stdoutWrite("验收证据（不含凭证）：" + join(root, "evidence.json") + "\n");
}
