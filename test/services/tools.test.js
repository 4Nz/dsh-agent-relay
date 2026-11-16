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
    "relay_ping",
    "relay_plan",
    "relay_send",
    "relay_setup_check",
    "relay_setup_install",
    "relay_stop",
    "relay_subscribe",
  ]);
  const tool = tools.get("relay_subscribe");
  await tool.execute(
    { agent: "claude", external_session_id: "external", check_interval_seconds:300, max_lifetime_seconds:7200 },
    { agent: { session: { id: "current-dsh" } } },
  );
  assert.equal(received[0], "subscribe");
  assert.equal(received[2], "current-dsh");
  assert.equal(received[1].check_interval_seconds,300);
  assert.equal(received[1].max_lifetime_seconds,7200);
});
