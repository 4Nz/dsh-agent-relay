// T2.4/T2.5/T3.1/T7：真实本机集成验收。会新建专用 Claude 会话并产生少量费用。
// 使用独立 DSH_HOME，不读取业务会话；约需 1～3 分钟。
// 依赖本机 DSH 0.2.1-rc.2，使用其内部启动器仅为测试，不属于插件运行依赖。
// 用法：rtk npm run build，然后 rtk proxy node test/smoke/m2-smoke.js
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRunner } from "../../lib/adapters/claude/runner.js";
import { openRelayStore } from "../../lib/storage/index.js";

const install =
  process.env.DSH_INSTALL_ROOT ??
  dirname(
    dirname(
      realpathSync(execFileSync("which", ["dsh"], { encoding: "utf8" }).trim()),
    ),
  );
const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-m2-")));
const dshHome = join(root, "dsh"),
  claudeHome = join(root, "claude"),
  cwd = join(root, "workspace");
mkdirSync(cwd);
const profile = join(dshHome, "profiles/web");
mkdirSync(join(profile, "node_modules"), { recursive: true });
symlinkSync(
  join(install, "node_modules/@deepseek-ai"),
  join(profile, "node_modules/@deepseek-ai"),
  "dir",
);
const plugin = join(profile, "node_modules/dsh-agent-relay");
mkdirSync(plugin);
const repository = resolve(dirname(new URL(import.meta.url).pathname), "../..");
for (const file of ["package.json", "cordis.patch.yml"])
  copyFileSync(join(repository, file), join(plugin, file));
cpSync(join(repository, "lib"), join(plugin, "lib"), { recursive: true });
writeFileSync(
  join(profile, "package.json"),
  JSON.stringify({
    name: "relay-m2-smoke",
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
      "@deepseek-ai/dsh-base": "0.2.1-rc.2",
      "@deepseek-ai/dsh-web-app": "0.2.1-rc.2",
      "dsh-agent-relay": "0.1.0",
    },
  }),
);
writeFileSync(join(profile, "cordis.patch.yml"), "[]\n");
const run = createRunner(),
  externalId = randomUUID();
console.log(
  "版本",
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-p",
        `JSON.stringify(require(${JSON.stringify(join(install, "package.json"))}).version)`,
      ],
      { encoding: "utf8" },
    ),
  ),
  (await run(["--version"], { timeoutMs: 15000 })).stdout.trim(),
);
const created = await run(
  [
    "-p",
    "--session-id",
    externalId,
    "--permission-prompts",
    "none",
    "--output-format",
    "json",
  ],
  {
    cwd,
    input: "这是 Agent Relay M2 专用测试。只回复“就绪”。",
    timeoutMs: 120000,
  },
);
assert.equal(created.code, 0, "无法创建专用 Claude 会话");
const projects = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "projects",
);
let found = false;
for (const directory of readdirSync(projects)) {
  const name = externalId + ".jsonl";
  if (readdirSync(join(projects, directory)).includes(name)) {
    const target = join(claudeHome, "projects", directory);
    mkdirSync(target, { recursive: true });
    symlinkSync(join(projects, directory, name), join(target, name));
    found = true;
    break;
  }
}
assert.ok(found, "未找到专用会话记录");
const originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.env.DSH_HOME = dshHome;
process.env.DSH_TELEMETRY_DISABLED = "1";
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
const app = await runProfile({
  environment: createLaunchEnvironmentSnapshot([
    { source: "process", values: process.env },
  ]),
  profile: "web",
  patchFiles: [],
  args: ["--no-open", "--port", "0"],
});
const ctx = app.ctx;
let modelToolCalls = 0;
let store;
// 从定时提醒正文提取 subscription_id：优先解析 v2 base64url 标记，兼容旧版标记。
function relaySubscriptionId(content) {
  const text = JSON.stringify(content);
  const v2 = text.match(/\[agent-relay-v2:([A-Za-z0-9_-]+)\]/);
  if (v2) {
    try {
      return Buffer.from(v2[1], "base64url").toString("utf8");
    } catch {
      return null;
    }
  }
  const legacy = text.match(/\[agent-relay:([^\]\s]+)\]/);
  return legacy?.[1] ?? null;
}
class FixtureModel extends LlmAdapter {
  async listModels() {
    return [
      {
        provider: "m2-test",
        id: "fixture",
        name: "M2 确定性验收模型",
        contextWindow: 128000,
      },
    ];
  }
  async *stream(options) {
    const userIndex = options.messages.findLastIndex(
      (message) => message.role === "user",
    );
    const toolIndex = options.messages.findLastIndex(
      (message) => message.role === "tool",
    );
    const last = userIndex > toolIndex ? options.messages[userIndex] : null;
    const subscriptionId =
      last?.role === "user" ? relaySubscriptionId(last.content) : null;
    if (subscriptionId) {
      modelToolCalls++;
      const native = options.tools?.some((tool) => tool.name === "relay_check");
      const block = {
        type: "tool-call",
        id: "call-" + modelToolCalls,
        name: native ? "relay_check" : "run_code",
        arguments: JSON.stringify(
          native
            ? { subscription_id: subscriptionId }
            : {
                description: "执行 Relay 到期检查",
                code: `return await tools.relay_check({subscription_id:${JSON.stringify(subscriptionId)}});`,
              },
        ),
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
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "M2 测试处理完成" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: "M2 测试处理完成" },
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
}
try {
  ctx.get("llm").registerAdapter(["m2-test"], new FixtureModel());
  const { sessionId } = await ctx.get("sessionController").create({ cwd });
  await ctx
    .get("sessionController")
    .selectModel({ sessionId, provider: "m2-test", model: "fixture" });
  const { agent } = await ctx.get("sessionController").resolveAgent(sessionId);
  const exec = { agent, signal: AbortSignal.timeout(180000) };
  const subscribe = () =>
    ctx
      .get("tools")
      .get("relay_subscribe")
      .execute(
        {
          agent: "claude",
          external_session_id: externalId,
          idle_timeout_seconds: 60,
          check_interval_seconds: 60,
        },
        exec,
      );
  const first = await subscribe();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.schedule_ready, true);
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
  const completed = await run(
    [
      "-p",
      "--resume",
      externalId,
      "--permission-prompts",
      "none",
      "--output-format",
      "json",
    ],
    {
      cwd,
      input: "M2 专用任务已完成，只回复“M2验收完成”。",
      timeoutMs: 120000,
    },
  );
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  assert.equal(completed.code, 0);
  store = openRelayStore({ dataDir: join(dshHome, "agent-relay") });
  const check = (id) =>
    ctx.get("tools").get("relay_check").execute({ subscription_id: id }, exec);
  const firstId = first.value.subscription.id;
  for (let i = 0; i < 2; i++) {
    store.subscriptions.update({
      id: firstId,
      expected_status: "active",
      patch: { expires_at: Date.now(), updated_at: Date.now() },
    });
    await check(firstId);
  }
  const notification = store.notifications.getBySubscription(firstId);
  assert.equal(notification?.result, "completed");
  assert.equal(notification.delivery_status, "delivered");
  await check(firstId);
  assert.equal(
    store.notifications.getBySubscription(firstId).delivery_attempts,
    1,
  );
  const events = (await ctx.get("sessionQuery").readSession(sessionId)).events;
  assert.equal(
    events.filter(
      (event) =>
        event.type === "agent/inbox/spliced" &&
        event.data.inserted?.some(
          (message) => message.id === notification.delivery_key,
        ),
    ).length,
    1,
  );
  console.log("真实 Claude → 工具 → completed → 唯一持久通知通过");
  const second = await subscribe();
  assert.equal(second.ok, true);
  const secondId = second.value.subscription.id;
  console.log("等待真实 60 秒 schedule → 确定性模型 → relay_check");
  for (const end = Date.now() + 90000; Date.now() < end;) {
    if (
      store.notifications.getBySubscription(secondId)?.delivery_status ===
      "delivered"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const automatic = store.notifications.getBySubscription(secondId);
  assert.equal(automatic?.result, "idle_timeout");
  assert.equal(automatic.delivery_status, "delivered");
  assert.ok(modelToolCalls > 0);
  assert.equal(
    (await ctx.get("schedule").catalog()).some((task) =>
      [
        first.value.subscription.schedule_task_id,
        second.value.subscription.schedule_task_id,
      ].includes(task.id),
    ),
    false,
  );
  console.log("自动定时链路通过；模型工具调用次数", modelToolCalls);
  console.log("验收数据目录（仅测试数据）", root);
} finally {
  store?.close();
  await app.ctx.fiber.dispose();
}
