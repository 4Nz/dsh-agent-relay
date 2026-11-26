import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../../lib/tools.js";
test("工具把 DSH 执行会话传入共用服务，注册所有 M2 工具", async () => {
  const tools = new Map();
  let received;
  registerTools(
    {
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
    },
    { subscriptions: { list: () => ({ items: [] }) } },
    {
      call: async (...args) => {
        received = args;
        return { ok: true, value: {} };
      },
    },
    {
      preset: () => ({ version: 1, max_parallel: 4, routes: [] }),
      availableTargetIds: () => ["dsh"],
      resolve: () => ({ selected: [], unavailable: [] }),
    },
  );
  assert.deepEqual([...tools.keys()].sort(), [
    "relay_batch",
    "relay_check",
    "relay_create_session",
    "relay_decide",
    "relay_inspect",
    "relay_list",
    "relay_list_sessions",
    "relay_mute",
    "relay_pause",
    "relay_ping",
    "relay_plan",
    "relay_resume",
    "relay_send",
    "relay_setup_check",
    "relay_setup_install",
    "relay_stop",
    "relay_subscribe",
    "relay_team_config",
  ]);
  const tool = tools.get("relay_subscribe");
  await tool.execute(
    { agent: "claude", external_session_id: "external", check_interval_seconds:300, topic:"等待测试完成" },
    { agent: { session: { id: "current-dsh" } } },
  );
  assert.equal(received[0], "subscribe");
  assert.equal(received[2], "current-dsh");
  assert.equal(received[1].check_interval_seconds,300);
  assert.equal(received[1].topic,"等待测试完成");
  assert.deepEqual(await tools.get("relay_team_config").execute({}), {
    mode: "team-relay",
    preset: { version: 1, max_parallel: 4, routes: [] },
    available_targets: ["dsh"],
  });
  for (const endpoint of ["pause", "resume"]) {
    await tools.get(`relay_${endpoint}`).execute({subscription_id:"sub"}, {agent:{session:{id:"current-dsh"}}});
    assert.equal(received[0],endpoint);
    assert.equal(received[1].subscription_id,"sub");
  }
});
