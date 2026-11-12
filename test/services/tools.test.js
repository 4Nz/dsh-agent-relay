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
    "relay_check",
    "relay_inspect",
    "relay_install_skill",
    "relay_list",
    "relay_list_sessions",
    "relay_ping",
    "relay_send",
    "relay_stop",
    "relay_subscribe",
  ]);
  const tool = tools.get("relay_subscribe");
  await tool.execute(
    { agent: "claude", external_session_id: "external" },
    { agent: { session: { id: "current-dsh" } } },
  );
  assert.equal(received[0], "subscribe");
  assert.equal(received[2], "current-dsh");
});
