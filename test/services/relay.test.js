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
  const runPromptCalls = [];
  const adapters = createAdapterRegistry([
    {
      agent: "claude",
      capabilities: () => ({
        snapshot: true,
        listSessions: true,
        sendMessage: true,
        runPrompt: true,
      }),
      listSessions: async () => [],
      sendMessage: async (...args) => {
        sendResults.push(args);
        return nextSendResult;
      },
      runPrompt: async (text, options) => {
        runPromptCalls.push([text, options]);
        return { status: "completed", output: "已安装" };
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
      capabilities: () => ({ snapshot: true, listSessions: true, sendMessage: false, runPrompt: false }),
      listSessions: async () => [],
      snapshot: async () => ({
        closed: false,
        cursor: null,
        title: "测试",
        cwd: null,
        last_activity_at: null,
      }),
      sendMessage: async () => ({ status: "rejected", reason: "Codex 第一版不支持发送消息" }),
      runPrompt: async () => ({ status: "rejected", reason: "Codex 开新会话执行安装为后续版本预留" }),
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
    skillInstall: {
      preview: async (agent) => ({ agent, skill: "external-agent-notification", target_dir: `/tmp/${agent}/skills`, prompt: "请安装", supported: true, reason: null }),
      install: async (agent) => ({ supported: true, prompt: "请安装", result: { status: "completed", output: "已安装" } }),
    },
    setup: {
      check: async (agent) => ({ agent, overall: "ok", claude_version: null, items: [], next_steps: [] }),
      install: async (agent) => ({ agent, overall: "ok", claude_version: null, items: [], next_steps: [] }),
      uninstall: async () => ({ agent: "claude", overall: "ok", claude_version: null, items: [], next_steps: [] }),
      probeStart: () => ({ status: "idle" }),
      probeStatus: () => ({ status: "idle" }),
      requireReady: async (agent) => {
        if (options.requireReadyReject === agent)
          throw new TypeError(`${agent} 前置安装未完成`);
      },
      instructions: [],
    },
    listDshSessions: async () => [{ id: "dsh", title: "接收会话" }],
    hasDshSession: async (id) => id === "dsh",
    createDshSession: async () => "new-dsh",
    onQueued: options.onQueued,
  });
  return {
    relay,
    store,
    sendResults,
    runPromptCalls,
    setSendResult(result) {
      nextSendResult = result;
    },
    credentials,
    adapters,
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

test("前置安装门控：未安装的 Agent 订阅与发送被拒绝", async (t) => {
  const { relay } = setup(t, { requireReadyReject: "codex" });
  const sub = await relay.call("subscribe", { agent: "codex", external_session_id: "ext" }, "dsh");
  assert.equal(sub.ok, false);
  assert.match(sub.error.message, /前置安装未完成/);
  const send = await relay.call("send", { agent: "codex", external_session_id: "ext", content: "hi" }, "dsh");
  assert.equal(send.ok, false);
  assert.match(send.error.message, /前置安装未完成/);
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

test("notify_poll 按游标返回新增通知并校验输入", async (t) => {
  const { relay, store } = setup(t);
  assert.deepEqual((await relay.call("notify_poll", {})).value, []);
  assert.equal((await relay.call("notify_poll", { after: -1 })).ok, false);
  const created = await relay.call("subscribe", {
    agent: "claude",
    external_session_id: "ext",
    type: "push",
  });
  store.notifications.record({
    notification: {
      id: "n1",
      subscription_id: created.value.subscription.id,
      source: "push",
      result: "completed",
      summary: "完成",
    },
    now: 500,
  });
  const page = (await relay.call("notify_poll", { after: 0 })).value;
  assert.equal(page.length, 1);
  assert.equal(page[0].id, "n1");
  assert.equal(page[0].summary, "完成");
  assert.equal((await relay.call("notify_poll", { after: 500 })).value.length, 0);
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
    skillInstall: { preview: async () => ({}), install: async () => ({}) },
    listDshSessions: async () => [{ id: "dsh", title: "接收会话" }],
    hasDshSession: async (id) => id === "dsh",
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
    skillInstall: { preview: async () => ({}), install: async () => ({}) },
    listDshSessions: async () => [{ id: "dsh", title: "接收会话" }],
    hasDshSession: async (id) => id === "dsh",
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

test("subscribe 用 hasDshSession 验证存在性，不读取标题", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-hasdsh-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
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
  let listCalls = 0;
  let hasCalls = 0;
  const relay = createRelayService({
    store,
    adapters,
    subscriptions,
    checks: { check: async () => ({ status: "not_due" }) },
    notifications: { drain: async () => {} },
    skillInstall: { preview: async () => ({}), install: async () => ({}) },
    listDshSessions: async () => {
      listCalls++;
      return [{ id: "dsh", title: "接收会话" }];
    },
    hasDshSession: async (id) => {
      hasCalls++;
      return id === "dsh";
    },
    createDshSession: async () => "new-dsh",
  });
  // 指定存在的接收会话：仅用 hasDshSession 验证，不读取标题。
  const ok = await relay.call("subscribe", { agent: "claude", external_session_id: "ext", dsh_session_id: "dsh" });
  assert.equal(ok.ok, true);
  assert.equal(hasCalls, 1);
  assert.equal(listCalls, 0);
  // 不存在的接收会话被拒绝。
  const missing = await relay.call("subscribe", { agent: "claude", external_session_id: "ext", dsh_session_id: "nope" });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /不存在/);
  assert.equal(hasCalls, 2);
});


test('Codex 创建入口与发送后订阅保留精确目标轮次，空历史有效', async t => {
  const { relay, adapters } = setup(t);
  const codex = adapters.get('codex');
  codex.capabilities = () => ({ snapshot: true, listSessions: true, sendMessage: true, runPrompt: false, createSession: true });
  codex.createSession = async ({cwd}) => ({ id: 'dedicated', cwd, send_allowed: true });
  codex.sendMessage = async () => ({ status: 'sent', external_ref: 'target-turn' });
  const created = await relay.call('create_session', { agent: 'codex', cwd: '/tmp' });
  assert.equal(created.ok, true);
  assert.equal(created.value.id, 'dedicated');
  const sent = await relay.call('send', { agent: 'codex', external_session_id: 'dedicated', content: '继续', subscribe_after_send: true }, 'dsh');
  assert.equal(sent.value.message.status, 'sent');
  assert.equal(sent.value.subscription.cursor.target_turn_id, 'target-turn');
});
test('发送服务：同目标并发拒绝，其他目标可发送，锁在失败后释放', async t => {
  const { relay, adapters } = setup(t);
  let release;
  const gate = new Promise(r => { release = r; });
  let entered;
  const ready = new Promise(r => { entered = r; });
  adapters.get('claude').sendMessage = async (id) => {
    if (id === 'held') { entered(); await gate; }
    return { status: 'sent', external_ref: id };
  };
  const first = relay.call('send', { agent: 'claude', external_session_id: 'held', content: 'a' });
  await ready;
  const pendingSecond = relay.call('send', { agent: 'claude', external_session_id: 'held', content: 'b' });
  const second = await Promise.race([pendingSecond, new Promise(r => setTimeout(() => r(null), 50))]);
  if (!second) { release(); await Promise.all([first, pendingSecond]); assert.fail('同目标并发必须立即拒绝'); }
  assert.equal(second.value.message.status, 'rejected');
  const other = await relay.call('send', { agent: 'claude', external_session_id: 'other', content: 'c' });
  assert.equal(other.value.message.status, 'sent');
  release(); assert.equal((await first).value.message.status, 'sent');
  assert.equal((await relay.call('send', { agent: 'claude', external_session_id: 'held', content: 'd' })).value.message.status, 'sent');
});

test("Claude 终端持有的会话：消息记为 queued 并触发推送检查，发送后订阅照常创建", async (t) => {
  let triggered = 0;
  const { relay, store, setSendResult } = setup(t, { onQueued: async () => { triggered++; } });
  setSendResult({ status: "queued" });
  const result = await relay.call("send", { agent: "claude", external_session_id: "held", content: "补充需求" });
  assert.equal(result.ok, true);
  assert.equal(result.value.message.status, "queued");
  assert.equal(result.value.message.sent_at, null);
  assert.equal(store.messages.get(result.value.message.id).status, "queued");
  assert.equal(triggered, 1);
  setSendResult({ status: "rejected", reason: "该会话未启用 Agent Relay channel" });
  const rejected = await relay.call("send", { agent: "claude", external_session_id: "held", content: "再补充" });
  assert.equal(rejected.value.message.status, "rejected");
  assert.match(rejected.value.message.error, /channel/);
  assert.equal(triggered, 1);
});
