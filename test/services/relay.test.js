import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createRelayService } from "../../lib/services/relay.js";
import { createAdapterRegistry } from "../../lib/adapters/registry.js";
import { createSubscriptionService } from "../../lib/services/subscriptions.js";
function setup(t, options = {}) {
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
        closed: options.closed ?? false,
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
  const credentials = {
    get: () => ({ configured: true, digest: "digest", created_at: 1 }),
    generate: () => ({ token: "token", digest: "digest", created_at: 2 }),
    reset: () => ({ token: "new-token", digest: "new-digest", created_at: 3 }),
  };
  const relay = createRelayService({
    store,
    adapters,
    subscriptions,
    checks: { check: async () => ({ status: "not_due" }) },
    notifications: { drain: async () => {} },
    credentials,
    listDshSessions: async () => [{ id: "dsh", title: "接收会话" }],
    createDshSession: async () => "new-dsh",
  });
  return {
    relay,
    store,
    sendResults,
    setSendResult(result) {
      nextSendResult = result;
    },
    credentials,
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
  const push = await relay.call("subscribe", {
    agent: "claude",
    external_session_id: "ext",
    type: "push",
  });
  assert.equal(push.ok, true);
  assert.equal(push.value.subscription.type, "push");
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

test("凭证 RPC 只通过服务层暴露生成、查询和重置", async (t) => {
  const { relay } = setup(t);
  assert.deepEqual((await relay.call("credential_get", {})).value.configured, true);
  assert.equal((await relay.call("credential_generate", {})).value.token, "token");
  assert.equal((await relay.call("credential_reset", {})).value.token, "new-token");
});


test("查阅快照顺延有效期，查询失败不伪造成功", async (t) => {
  const { relay, store } = setup(t);
  const created = await relay.call("subscribe", { agent: "claude", external_session_id: "ext" }, "dsh");
  const sub = created.value.subscription;
  store.subscriptions.update({ id: sub.id, expected_status: "active", patch: { expires_at: 1 } });
  const result = await relay.call("inspect", { agent: "claude", external_session_id: "ext" });
  assert.equal(result.ok, true);
  assert.equal(result.value.title, "测试");
  assert.ok(store.subscriptions.get(sub.id).expires_at > Date.now());
  assert.equal((await relay.call("inspect", { agent: "bad", external_session_id: "ext" })).ok, false);
});

test("无当前会话时新建接收会话，创建与修改失败阈值持久保存", async (t) => {
  const { relay, store } = setup(t);
  const result = await relay.call("subscribe", { agent: "claude", external_session_id: "ext", max_consecutive_failures: 5 });
  assert.equal(result.ok, true);
  const sub = result.value.subscription;
  assert.equal(sub.dsh_session_id, "new-dsh");
  assert.equal(sub.max_consecutive_failures, 5);
  assert.equal((await relay.call("update", { subscription_id: sub.id, max_consecutive_failures: 2 })).ok, true);
  assert.equal(store.subscriptions.get(sub.id).max_consecutive_failures, 2);
  assert.equal((await relay.call("update", { subscription_id: sub.id, max_consecutive_failures: 0 })).ok, false);
});


test("发送时发现外部会话关闭，立即结束订阅并拒绝发送", async (t) => {
  const options = {};
  const { relay, store, sendResults } = setup(t, options);
  const created = await relay.call("subscribe", { agent: "claude", external_session_id: "ext" }, "dsh");
  options.closed = true;
  const result = await relay.call("send", { agent: "claude", external_session_id: "ext", content: "继续" });
  assert.equal(result.value.message.status, "rejected");
  assert.equal(sendResults.length, 0);
  assert.equal(store.subscriptions.get(created.value.subscription.id).end_reason, "session_closed");
});

test("发送后订阅使用发送前快照基线，空历史 cursor=null 不被发送后位置覆盖", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-baseline-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let snapshotCount = 0;
  const adapters = createAdapterRegistry([
    {
      agent: "claude",
      capabilities: () => ({ snapshot: true, listSessions: true, sendMessage: true }),
      listSessions: async () => [],
      snapshot: async () => {
        snapshotCount++;
        return {
          closed: false,
          // 发送前为空历史（cursor=null），发送后为非空位置。
          cursor: snapshotCount === 1 ? null : { uuid: `u${snapshotCount}`, timestamp: snapshotCount },
          title: "测试",
          cwd: null,
          last_activity_at: null,
        };
      },
      sendMessage: async () => ({ status: "sent", external_ref: "ref" }),
    },
  ]);
  const subscriptions = createSubscriptionService({
    store,
    adapters,
    scheduler: { create: async () => { throw Error("暂不可用"); }, catalog: async () => [] },
  });
  const relay = createRelayService({
    store,
    adapters,
    subscriptions,
    checks: { check: async () => ({ status: "not_due" }) },
    notifications: { drain: async () => {} },
    listDshSessions: async () => [{ id: "dsh", title: "接收会话" }],
    createDshSession: async () => "new-dsh",
  });
  const result = await relay.call(
    "send",
    { agent: "claude", external_session_id: "ext", content: "继续", subscribe_after_send: true },
    "dsh",
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.message.status, "sent");
  // 订阅基线为发送前空历史，而非发送后的当前位置。
  assert.equal(result.value.subscription.cursor, null);
  // 只读取一次快照（发送前），订阅创建不再重新读取历史。
  assert.equal(snapshotCount, 1);
});

test("发送成功但订阅创建失败时保留 sent 消息并返回 subscription_error", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-suberr-"));
  const realStore = openRelayStore({ dataDir: dir });
  t.after(() => {
    realStore.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = {
    ...realStore,
    subscriptions: {
      ...realStore.subscriptions,
      create: () => {
        throw new Error("存储写入失败");
      },
    },
  };
  const adapters = createAdapterRegistry([
    {
      agent: "claude",
      capabilities: () => ({ snapshot: true, listSessions: true, sendMessage: true }),
      listSessions: async () => [],
      snapshot: async () => ({ closed: false, cursor: null, title: "测试", cwd: null, last_activity_at: null }),
      sendMessage: async () => ({ status: "sent", external_ref: "ref" }),
    },
  ]);
  const subscriptions = createSubscriptionService({
    store,
    adapters,
    scheduler: { create: async () => { throw Error("暂不可用"); }, catalog: async () => [] },
  });
  const relay = createRelayService({
    store,
    adapters,
    subscriptions,
    checks: { check: async () => ({ status: "not_due" }) },
    notifications: { drain: async () => {} },
    listDshSessions: async () => [{ id: "dsh", title: "接收会话" }],
    createDshSession: async () => "new-dsh",
  });
  const result = await relay.call(
    "send",
    { agent: "claude", external_session_id: "ext", content: "继续", subscribe_after_send: true },
    "dsh",
  );
  assert.equal(result.ok, true);
  // 消息确实已发送，不被订阅失败伪装成失败。
  assert.equal(result.value.message.status, "sent");
  assert.equal(result.value.subscription, null);
  assert.equal(result.value.subscription_error, "存储写入失败");
});
