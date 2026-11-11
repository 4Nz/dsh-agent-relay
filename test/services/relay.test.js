import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createRelayService } from "../../lib/services/relay.js";
import { createAdapterRegistry } from "../../lib/adapters/registry.js";
import { createSubscriptionService } from "../../lib/services/subscriptions.js";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-api-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const sendResults = [];
  let nextSendResult = { status: "sent", external_ref: "external-message" };
  const adapters = createAdapterRegistry([
    {
      agent: "claude",
      capabilities: () => ({
        snapshot: true,
        listSessions: true,
        sendMessage: true,
      }),
      listSessions: async () => [],
      sendMessage: async (...args) => {
        sendResults.push(args);
        return nextSendResult;
      },
      snapshot: async () => ({
        closed: false,
        cursor: null,
        title: "测试",
        cwd: null,
        last_activity_at: null,
      }),
    },
    {
      agent: "codex",
      capabilities: () => ({ snapshot: true, listSessions: true, sendMessage: false }),
      listSessions: async () => [],
      snapshot: async () => ({
        closed: false,
        cursor: null,
        title: "测试",
        cwd: null,
        last_activity_at: null,
      }),
      sendMessage: async () => ({ status: "rejected", reason: "Codex 第一版不支持发送消息" }),
    },
  ]);
  const subscriptions = createSubscriptionService({
    store,
    adapters,
    scheduler: {
      create: async () => {
        throw Error("暂不可用");
      },
      catalog: async () => [],
    },
  });
  const relay = createRelayService({
    store,
    adapters,
    subscriptions,
    checks: { check: async () => ({ status: "not_due" }) },
    notifications: { drain: async () => {} },
    listDshSessions: async () => [{ id: "dsh", title: "接收会话" }],
  });
  return {
    relay,
    store,
    sendResults,
    setSendResult(result) {
      nextSendResult = result;
    },
  };
}
test("订阅使用调用上下文，定时任务未创建时明确返回未就绪", async (t) => {
  const { relay } = setup(t);
  const result = await relay.call(
    "subscribe",
    { agent: "claude", external_session_id: "ext" },
    "dsh",
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.schedule_ready, false);
  assert.equal(result.value.subscription.dsh_session_id, "dsh");
  const list = await relay.call("list", {});
  assert.equal(list.value.items.length, 1);
});
test("非法 Agent、过短周期、push 及不存在的接收会话在业务边界拒绝", async (t) => {
  const { relay, store } = setup(t);
  for (const args of [
    { agent: "bad" },
    { idle_timeout_seconds: 1 },
    { type: "push" },
    { dsh_session_id: "missing" },
  ]) {
    const r = await relay.call(
      "subscribe",
      { agent: "claude", external_session_id: "ext", ...args },
      "dsh",
    );
    assert.equal(r.ok, false);
  }
  assert.equal(store.subscriptions.list().items.length, 0);
});
test("分页和筛选输入校验，不存在订阅明确返回失败", async (t) => {
  const { relay } = setup(t);
  assert.equal((await relay.call("list", { limit: -1 })).ok, false);
  assert.equal(
    (await relay.call("check", { subscription_id: "missing" })).ok,
    false,
  );
  assert.equal(
    (await relay.call("stop", { subscription_id: "missing" })).ok,
    false,
  );
});

test("转发成功后记录消息、顺延同会话订阅并支持发送后订阅", async (t) => {
  const { relay, store, sendResults } = setup(t);
  const result = await relay.call(
    "send",
    {
      agent: "claude",
      external_session_id: "ext",
      content: "继续处理",
      subscribe_after_send: true,
    },
    "dsh",
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.message.status, "sent");
  assert.equal(result.value.message.external_ref, "external-message");
  assert.equal(result.value.subscription.type, "poll");
  assert.equal(sendResults.length, 1);
  assert.deepEqual(sendResults[0], ["ext", "继续处理"]);
  assert.equal(store.messages.list().items.length, 1);
});

test("Codex 或 Adapter 拒绝发送时只记录 rejected，不创建发送后订阅", async (t) => {
  const { relay, store } = setup(t);
  const result = await relay.call("send", {
    agent: "claude",
    external_session_id: "ext",
    content: "继续处理",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.message.status, "sent");
  const missing = await relay.call("send", {
    agent: "codex",
    external_session_id: "ext",
    content: "不应发送",
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.value.message.status, "rejected");
  assert.match(missing.value.message.error, /不支持/);
  assert.equal(store.messages.list().items.length, 2);
});

test("外部发送结果未知时保留 unknown 状态且不创建订阅", async (t) => {
  const { relay, store, setSendResult } = setup(t);
  setSendResult({ status: "unknown", error: "接收结果未知" });
  const result = await relay.call(
    "send",
    {
      agent: "claude",
      external_session_id: "ext",
      content: "可能已发送",
      subscribe_after_send: true,
    },
    "dsh",
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.message.status, "unknown");
  assert.equal(result.value.subscription, null);
  assert.equal(store.subscriptions.list().items.length, 0);
});

test("消息 RPC 按 Agent 和外部会话分页查询", async (t) => {
  const { relay } = setup(t);
  await relay.call("send", {
    agent: "claude",
    external_session_id: "ext",
    content: "查询我",
  });
  const result = await relay.call("messages", {
    agent: "claude",
    external_session_id: "ext",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.items.length, 1);
  assert.equal(result.value.items[0].content, "查询我");
});
