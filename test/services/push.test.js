import { test } from "node:test";
import assert from "node:assert/strict";
import { createPushHandler } from "../../lib/services/push.js";

test("push handler 校验共享凭证、为无接收会话的订阅创建分组会话并防重", async () => {
  const calls = [];
  const subscriptions = new Map([
    ["sub", { id: "sub", type: "push", status: "active", dsh_session_id: null }],
  ]);
  const recorded = new Set();
  const handler = createPushHandler({
    credentials: { verify: (token) => token === "secret" },
    store: {
      subscriptions: {
        get: (id) => subscriptions.get(id) ?? null,
        update: ({ id, patch }) => {
          const sub = subscriptions.get(id);
          if (!sub) return false;
          Object.assign(sub, patch);
          return true;
        },
      },
      notifications: {
        getBySubscription: (id) => recorded.has(id) ? { id: "n" } : null,
        record: ({ notification }) => {
          const duplicate = recorded.has(notification.subscription_id);
          recorded.add(notification.subscription_id);
          return { outcome: duplicate ? "duplicate" : "created", notification };
        },
      },
    },
    createSession: async () => {
      calls.push("create");
      return "dsh-new";
    },
    drain: async () => calls.push("drain"),
    now: () => 100,
    newId: () => "notification-id",
  });
  const bad = await handler(new Request("http://relay/notifications", {
    method: "POST",
    headers: { authorization: "Bearer bad", "content-type": "application/json" },
    body: JSON.stringify({ subscription_id: "sub", result: "completed", summary: "完成" }),
  }));
  assert.equal(bad.status, 401);
  const request = () => handler(new Request("http://relay/notifications", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ subscription_id: "sub", result: "completed", summary: "完成" }),
  }));
  assert.equal((await request()).status, 202);
  assert.equal((await request()).status, 202);
  assert.deepEqual(calls, ["create", "drain", "drain"]);
  assert.equal(subscriptions.get("sub").dsh_session_id, "dsh-new");
});

test("push 不需要预先订阅，首次请求自动创建一次性订阅和接收会话", async () => {
  const calls = [];
  const subscriptions = new Map();
  const recorded = new Set();
  const handler = createPushHandler({
    credentials: { verify: (token) => token === "secret" },
    store: {
      subscriptions: {
        get: (id) => subscriptions.get(id) ?? null,
        update: ({ id, patch }) => {
          const sub = subscriptions.get(id);
          if (!sub) return false;
          Object.assign(sub, patch);
          return true;
        },
      },
      notifications: {
        getBySubscription: (id) => recorded.has(id) ? { id: "n" } : null,
        record: ({ notification }) => {
          const duplicate = recorded.has(notification.subscription_id);
          recorded.add(notification.subscription_id);
          return { outcome: duplicate ? "duplicate" : "created", notification };
        },
      },
    },
    createSubscription: async (input) => {
      const sub = { id: input.id, type: "push", status: "active", dsh_session_id: null, agent: input.agent, external_session_id: input.external_session_id };
      subscriptions.set(sub.id, sub);
      return { ok: true, subscription: sub };
    },
    createSession: async () => {
      calls.push("create");
      return "dsh-new";
    },
    drain: async () => calls.push("drain"),
    now: () => 100,
    newId: () => "notification-id",
  });
  const request = () => handler(new Request("http://relay/notifications", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ request_id: "req-1", agent: "claude", external_session_id: "ext", result: "completed", summary: "完成" }),
  }));
  const first = await request();
  const second = await request();
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.deepEqual(calls, ["create", "drain", "drain"]);
  assert.equal(subscriptions.get("push:req-1").dsh_session_id, "dsh-new");
  subscriptions.get("push:req-1").status = "ended";
  assert.equal((await request()).status, 202);
  assert.deepEqual(calls, ["create", "drain", "drain"]);
});
