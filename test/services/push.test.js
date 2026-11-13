import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createPushHandler, createPushServer } from "../../lib/services/push.js";

function rawRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

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
    requireReady: async () => {},
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
    requireReady: async () => {},
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

test("push server 在读取请求体前校验路径与方法，handler 异常返回通用 500 且不暴露堆栈", async () => {
  let throwOnNext = false;
  const handler = async () => {
    if (throwOnNext) throw new Error("boom with secret-token");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { start, stop } = createPushServer({ handler, port: 0 });
  const { port } = await start();
  try {
    // 未知路径 → 404
    assert.equal((await rawRequest({ host: "127.0.0.1", port, path: "/other", method: "POST" }, "{}")).status, 404);
    // GET 带 body → 405（在读取请求体前即拒绝）
    assert.equal((await rawRequest({ host: "127.0.0.1", port, path: "/api/agent-relay/notifications", method: "GET" }, "x")).status, 405);
    // 正常 POST → 200
    assert.equal((await rawRequest({ host: "127.0.0.1", port, path: "/api/agent-relay/notifications", method: "POST" }, "{}")).status, 200);
    // handler 抛异常 → 500，且不暴露堆栈/凭证内容
    throwOnNext = true;
    const err = await rawRequest({ host: "127.0.0.1", port, path: "/api/agent-relay/notifications", method: "POST" }, "{}");
    assert.equal(err.status, 500);
    assert.equal(err.body.includes("boom with secret-token"), false);
    // 进程存活：后续请求仍正常响应
    throwOnNext = false;
    assert.equal((await rawRequest({ host: "127.0.0.1", port, path: "/api/agent-relay/notifications", method: "POST" }, "{}")).status, 200);
  } finally {
    await stop();
  }
});

test("push server 客户端中途断开不产生未处理异常", async () => {
  const handler = async () => new Response("ok");
  const { start, stop } = createPushServer({ handler, port: 0 });
  const { port } = await start();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    // 写入部分请求体后立即销毁连接，服务端读取请求体时流中断。
    await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/api/agent-relay/notifications",
        method: "POST",
      });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write("partial");
      req.destroy();
      resolve();
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await stop();
  }
});
