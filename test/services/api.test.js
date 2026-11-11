import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRelayApi } from "../../lib/api.js";
test("认证连接路由校验 envelope，并使用共用服务返回 RPC 结果", async () => {
  const routes = [];
  const stop = registerRelayApi(
    {
      fetch: {
        register(route) {
          routes.push(route);
          return () => routes.pop();
        },
      },
    },
    {
      call: async (endpoint, payload) => ({
        ok: true,
        value: { endpoint, payload },
      }),
    },
  );
  const route = routes.find((r) => r.path === "/api/agent-relay/list");
  let response = await route.fetch(
    new Request("http://localhost/api/agent-relay/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "r",
        method: "agent-relay/list",
        payload: { limit: 10 },
      }),
    }),
  );
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.rpcId, "r");
  assert.equal(body.result.value.endpoint, "list");
  response = await route.fetch(
    new Request("http://localhost/api/agent-relay/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(response.status, 400);
  stop();
  assert.equal(routes.length, 0);
});
