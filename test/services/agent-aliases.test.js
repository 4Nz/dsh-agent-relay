import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentAliasStore,
  defaultAgentAliasConfig,
} from "../../lib/services/agent-aliases.js";
import { openRelayStore } from "../../lib/storage/index.js";
import { createRelayService } from "../../lib/services/relay.js";
import { registerTools } from "../../lib/tools.js";

test("agent-aliases：首次 ensure 写入默认大肥鱼/哈基米 JSON 配置，不覆盖用户修改且容错坏文件", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-agent-aliases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = join(dir, "agent-aliases.json");
  const store = createAgentAliasStore(file);

  // 未创建前 read 仍返回内置默认值。
  const before = store.read();
  assert.equal(before.agents.dsh.display_name, "大肥鱼");
  assert.equal(before.agents.agy.display_name, "哈基米");
  assert.equal(store.resolve("大肥鱼"), "dsh");
  assert.equal(store.resolve("哈基米"), "agy");
  assert.equal(store.resolve("Antigravity"), "agy");
  assert.equal(store.resolve("DSH"), "dsh");
  assert.match(before.summary, /大肥鱼 = DSH（dsh）/);
  assert.match(before.summary, /哈基米 = Antigravity（agy）/);

  // 首次 ensure 落盘默认 JSON。
  const created = store.ensure();
  assert.equal(created.created, true);
  const disk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(disk, defaultAgentAliasConfig());

  // 用户手动修改 JSON 后再次 ensure 不覆盖，且实时生效。
  writeFileSync(
    file,
    JSON.stringify({
      format: 1,
      agents: {
        dsh: { display_name: "大肥鱼", aliases: ["肥鱼"] },
        agy: { display_name: "哈基米", aliases: ["小反重力"] },
        codex: { display_name: "代码狗", aliases: [] },
      },
    }),
  );
  assert.equal(store.ensure().created, false);
  assert.equal(store.resolve("肥鱼"), "dsh");
  assert.equal(store.resolve("小反重力"), "agy");
  assert.equal(store.resolve("代码狗"), "codex");

  // 跨 Agent 冲突别名拒绝猜测，返回 null。
  writeFileSync(
    file,
    JSON.stringify({
      format: 1,
      agents: {
        agy: { display_name: "撞名", aliases: [] },
        codex: { display_name: "撞名", aliases: [] },
      },
    }),
  );
  assert.equal(store.resolve("撞名"), null);

  // 坏 JSON 不崩溃，安全回退默认别名。
  writeFileSync(file, "{bad json");
  assert.equal(store.resolve("大肥鱼"), "dsh");
  assert.equal(store.resolve("哈基米"), "agy");
});

test("Relay 与工具接入：agent_aliases 只读返回配置，外部 Agent 接口接受别名归一，工具描述附带别名提示", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-alias-integration-"));
  const storage = openRelayStore({ dataDir: join(dir, "db") });
  t.after(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const aliasStore = createAgentAliasStore(join(dir, "agent-aliases.json"));
  aliasStore.ensure();

  const seenAgents = [];
  const relay = createRelayService({
    store: storage,
    agentAliases: aliasStore,
    adapters: {
      get: (agent) => ({
        agent,
        capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: true, runPrompt: false }),
        async listSessions() {
          seenAgents.push(agent);
          return [];
        },
      }),
      list: () => [],
    },
    subscriptions: {},
    checks: {},
    notifications: {},
    listDshSessions: async () => [],
  });

  const aliasesRes = await relay.call("agent_aliases", {});
  assert.equal(aliasesRes.ok, true);
  assert.equal(aliasesRes.value.agents.dsh.display_name, "大肥鱼");
  assert.equal(aliasesRes.value.agents.agy.display_name, "哈基米");

  // 传别名「哈基米」归一化为规范 agy；传「大肥鱼」（dsh 非外部 adapter）明确拒绝。
  const sessionsRes = await relay.call("sessions", { agent: "哈基米" });
  assert.equal(sessionsRes.ok, true);
  assert.deepEqual(seenAgents, ["agy"]);
  const badRes = await relay.call("sessions", { agent: "大肥鱼" });
  assert.equal(badRes.ok, false);

  // 工具描述包含默认别名提示。
  const tools = new Map();
  registerTools(
    { tools: { register: (tool) => tools.set(tool.name, tool) } },
    storage,
    relay,
    undefined,
    aliasStore,
  );
  assert.match(tools.get("relay_list_sessions").description, /大肥鱼 = DSH（dsh）/);
  assert.match(tools.get("relay_send").description, /哈基米 = Antigravity（agy）/);
});
