import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createClaudeChannelService, NOT_ENABLED } from "../../lib/services/claude-channel.js";
import { createChannelRoutes, CHANNEL_POLL_PATH, CHANNEL_ACK_PATH } from "../../lib/services/channel-http.js";

const S1 = "11111111-2222-3333-4444-555555555555";
const S2 = "66666666-7777-8888-9999-000000000000";

function fixture(t, agents) {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-channel-"));
  const store = openRelayStore({ dataDir });
  const clock = { now: 1_000_000 };
  const state = { agents };
  const channel = createClaudeChannelService({
    store,
    listAgents: async () => state.agents,
    now: () => clock.now,
    onlineMs: 60_000,
    ackTimeoutMs: 600_000,
    queueTimeoutMs: 3_600_000,
  });
  t.after(() => {
    channel.dispose();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const queue = (id, sessionId = S1, created_at = clock.now) =>
    store.messages.create({ id, agent: "claude", external_session_id: sessionId, content: `消息 ${id}`, created_at, status: "queued" });
  return { store, channel, clock, state, queue };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("未登记或离线的会话拒绝，登记后接受入队", async (t) => {
  const { channel, clock } = fixture(t, [{ pid: 10, sessionId: S1, status: "idle" }]);
  assert.deepEqual(await channel.accept(S1), { status: "rejected", reason: NOT_ENABLED });
  const pending = channel.poll({ pid: 10, session_id: S1, version: "0.1.0" }, 50);
  assert.deepEqual(await channel.accept(S1), { status: "queued" });
  assert.deepEqual(await channel.accept(S2), { status: "rejected", reason: NOT_ENABLED });
  await pending;
  clock.now += 120_000;
  assert.equal((await channel.accept(S1)).status, "rejected", "超过在线时间视为离线");
});

test("状态查询失败时拒绝并带原因", async (t) => {
  const { channel } = fixture(t, "claude agents 超时");
  const result = await channel.accept(S1);
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /无法确认会话状态/);
});

test("会话空闲时推送一条，等 ack 后再推下一条", async (t) => {
  const { channel, store, queue } = fixture(t, [{ pid: 10, sessionId: S1, status: "idle" }]);
  queue("a");
  queue("b");
  const first = await channel.poll({ pid: 10, session_id: S1, version: null }, 1000);
  assert.deepEqual(first, [{ msg_id: "a", content: "消息 a" }]);
  assert.equal(store.messages.get("a").status, "sent");
  assert.equal(store.messages.get("a").external_ref, "channel:a");
  // a 未 ack 时不推 b
  const waiting = channel.poll({ pid: 10, session_id: S1, version: null }, 50);
  assert.deepEqual(await waiting, []);
  assert.equal(store.messages.get("b").status, "queued");
  assert.deepEqual(channel.ack({ msg_id: "a", summary: "完成" }), { ok: true, message: "已确认" });
  assert.equal(store.messages.get("a").ack_summary, "完成");
  const second = await channel.poll({ pid: 10, session_id: S1, version: null }, 1000);
  assert.deepEqual(second.map((m) => m.msg_id), ["b"]);
  assert.deepEqual(channel.ack({ msg_id: "a", summary: null }), { ok: true, message: "此前已确认" });
  assert.equal(channel.ack({ msg_id: "missing", summary: null }).ok, false);
});

test("会话忙碌时保持 queued，空闲后推送", async (t) => {
  const { channel, store, state, queue } = fixture(t, [{ pid: 10, sessionId: S1, status: "busy" }]);
  queue("a");
  assert.deepEqual(await channel.poll({ pid: 10, session_id: S1, version: null }, 50), []);
  assert.equal(store.messages.get("a").status, "queued");
  state.agents = [{ pid: 10, sessionId: S1, status: "idle" }];
  assert.deepEqual((await channel.poll({ pid: 10, session_id: S1, version: null }, 1000)).map((m) => m.msg_id), ["a"]);
});

test("/clear 后按 pid 解析当前会话 ID", async (t) => {
  const { channel, store, queue } = fixture(t, [{ pid: 10, sessionId: S2, status: "idle" }]);
  // channel server 仍以启动时的 S1 登记，进程当前会话已是 S2
  queue("old", S1);
  queue("new", S2);
  const pushed = await channel.poll({ pid: 10, session_id: S1, version: null }, 1000);
  assert.deepEqual(pushed.map((m) => m.msg_id), ["new"]);
  assert.equal(store.messages.get("old").status, "queued");
  assert.deepEqual(await channel.accept(S2), { status: "queued" });
});

test("pid 对不上时按启动会话 ID 兜底匹配", async (t) => {
  const { channel, queue } = fixture(t, [{ pid: 99, sessionId: S1, status: "idle" }]);
  queue("a");
  assert.deepEqual((await channel.poll({ pid: 10, session_id: S1, version: null }, 1000)).map((m) => m.msg_id), ["a"]);
});

test("ack 超时记 unknown 不重发，迟到 ack 改回 sent；排队超时记 failed", async (t) => {
  const { channel, store, clock, queue } = fixture(t, [{ pid: 10, sessionId: S1, status: "idle" }]);
  queue("a");
  await channel.poll({ pid: 10, session_id: S1, version: null }, 1000);
  clock.now += 700_000;
  await channel.tick();
  assert.equal(store.messages.get("a").status, "unknown");
  assert.match(store.messages.get("a").error, /结果未知/);
  channel.ack({ msg_id: "a", summary: "迟到" });
  assert.equal(store.messages.get("a").status, "sent");
  queue("stale", S2, clock.now);
  clock.now += 3_700_000;
  await channel.tick();
  assert.equal(store.messages.get("stale").status, "failed");
});

test("连通测试：登记后推送探测并等 ack；未登记返回 not_registered", async (t) => {
  const { channel } = fixture(t, []);
  assert.deepEqual(await channel.probe(S2, () => "x", { registerTimeoutMs: 50, ackTimeoutMs: 50 }), { status: "not_registered" });
  const polling = channel.poll({ pid: 10, session_id: S1, version: null }, 2000);
  const probing = channel.probe(S1, (id) => `探测 ${id}`, { registerTimeoutMs: 1000, ackTimeoutMs: 1000 });
  const pushed = await polling;
  assert.equal(pushed[0].msg_id, `probe-${S1}`);
  assert.equal(pushed[0].content, `探测 probe-${S1}`);
  channel.ack({ msg_id: pushed[0].msg_id, summary: "OK" });
  assert.deepEqual(await probing, { status: "acked", summary: "OK" });
});

test("dispose 结束挂起的长轮询", async (t) => {
  const { channel } = fixture(t, []);
  const pending = channel.poll({ pid: 10, session_id: null, version: null }, 60_000);
  await tick();
  channel.dispose();
  assert.deepEqual(await pending, []);
});

test("HTTP 接口校验凭证与输入，返回消息与 ack 结果", async (t) => {
  const { channel, queue } = fixture(t, [{ pid: 10, sessionId: S1, status: "idle" }]);
  const routes = createChannelRoutes({ channel, credentials: { verify: (x) => x === "secret" }, pollWaitMs: 1000 });
  const call = (path, payload, token = "secret") =>
    routes[path](new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    }));
  assert.equal((await call(CHANNEL_POLL_PATH, { pid: 10 }, "wrong")).status, 401);
  assert.equal((await call(CHANNEL_POLL_PATH, { pid: -1 })).status, 400);
  assert.equal((await call(CHANNEL_POLL_PATH, { pid: 10, session_id: "bad" })).status, 400);
  queue("a");
  const polled = await call(CHANNEL_POLL_PATH, { pid: 10, session_id: S1, version: "0.1.0" });
  assert.deepEqual(await polled.json(), { messages: [{ msg_id: "a", content: "消息 a" }] });
  assert.equal((await call(CHANNEL_ACK_PATH, { msg_id: "" })).status, 400);
  const acked = await call(CHANNEL_ACK_PATH, { msg_id: "a", summary: "完成" });
  assert.equal(acked.status, 200);
  assert.equal((await call(CHANNEL_ACK_PATH, { msg_id: "missing" })).status, 404);
});
