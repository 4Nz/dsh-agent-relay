import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkBuddyAdapter } from "../../lib/adapters/workbuddy/index.js";
import { createWorkBuddyTokenProvider } from "../../lib/adapters/workbuddy/token.js";
import { parseWorkBuddyTranscript, finishedTurn } from "../../lib/adapters/workbuddy/transcript.js";

const ID = "wb-session-1";
const PROJECT = "Users-test-WorkBuddy-project";
const at = (second) => new Date(Date.UTC(2026, 10, 17, 0, 0, second)).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;

function gateway() {
  return {
    listSessions: async () => ({
      status: 200,
      value: { data: { sessions: [{ id: ID, name: "测试会话", cwd: "/tmp/project", projectId: PROJECT, updatedAt: Date.parse(at(2)), status: "pending" }] } },
      body: "",
    }),
    live: async () => ({ status: 200, value: { data: { sessionId: null, writerOccupied: false } }, body: "" }),
    status: async () => ({ status: 200, value: { data: { busy: false } }, body: "" }),
    history: async () => ({ status: 404, value: { error: { code: "SESSION_NOT_FOUND" } }, body: "SESSION_NOT_FOUND" }),
    replay: async () => ({ status: 404, value: { error: { code: "SESSION_NOT_FOUND" } }, body: "SESSION_NOT_FOUND" }),
    health: async () => ({ status: 200, value: { data: { status: "ok" } }, body: "" }),
    reply: async () => ({ status: 409, value: { error: { code: "SESSION_FOLLOW_NOT_LIVE" } }, body: "" }),
  };
}

function token() {
  return {
    read: async () => ({ password: "x", port: 55409, pid: 1, savedAt: at(1) }),
    interactiveSessions: async () => [],
    requestRefresh: async () => {},
  };
}

function fixture(t) {
  const homeDir = mkdtempSync(join(tmpdir(), "relay-workbuddy-"));
  const projectDir = join(homeDir, ".workbuddy", "projects", PROJECT);
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${ID}.jsonl`);
  writeFileSync(
    file,
    line({ type: "session-meta", title: "本地标题", cwd: "/tmp/project", timestamp: at(1) }) +
      line({ type: "message", role: "user", uuid: "u1", timestamp: at(2), content: "汇报进度" }) +
      line({ type: "message", role: "assistant", uuid: "a1", timestamp: at(3), content: "已经完成", stop_reason: "end_turn" }),
  );
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, projectsDir: join(homeDir, ".workbuddy", "projects") };
}

test("WorkBuddy JSONL：读取标题、回复、游标并判定新轮次完成", () => {
  const transcript = parseWorkBuddyTranscript(
    line({ type: "message", role: "user", uuid: "u1", timestamp: at(1), content: "旧问题" }) +
      line({ type: "message", role: "assistant", uuid: "a1", timestamp: at(2), content: "旧回复" }) +
      line({ type: "message", role: "user", uuid: "u2", timestamp: at(3), content: "新问题" }) +
      line({ type: "message", role: "assistant", uuid: "a2", timestamp: at(4), content: "新回复" }),
  );
  assert.equal(transcript.last_reply, "新回复");
  assert.equal(transcript.cursor.uuid, "a2");
  assert.equal(finishedTurn(transcript, { uuid: "a1", timestamp: Date.parse(at(2)) }).result, "completed");
});

test("WorkBuddy Adapter：网关 history/replay 404 时回退 JSONL，且只读能力明确关闭", async (t) => {
  const fixtureData = fixture(t);
  const adapter = createWorkBuddyAdapter({ ...fixtureData, gateway: gateway(), token: token() });
  const snapshot = await adapter.snapshot(ID);
  assert.equal(snapshot.closed, false);
  assert.equal(snapshot.title, "本地标题");
  assert.equal(snapshot.last_reply, "已经完成");
  assert.equal(snapshot.send_allowed, false);
  assert.match(snapshot.send_reason, /只读/);
  assert.match(snapshot.runtime_note, /历史读取/);
  assert.equal((await adapter.incremental(ID)).events.length, 2);
  assert.deepEqual(adapter.capabilities(), { listSessions: true, snapshot: true, sendMessage: false, runPrompt: false });
  assert.equal((await adapter.sendMessage(ID, "不要发送")).status, "rejected");
  assert.equal((await adapter.runPrompt("不要执行")).status, "rejected");
});

test("WorkBuddy Adapter：准确映射会话列表和无效 ID", async (t) => {
  const fixtureData = fixture(t);
  const adapter = createWorkBuddyAdapter({ ...fixtureData, gateway: gateway(), token: token() });
  const sessions = await adapter.listSessions();
  assert.equal(sessions[0].id, ID);
  assert.equal(sessions[0].send_allowed, false);
  await assert.rejects(adapter.snapshot("../secret"), /格式无效/);
});

test("WorkBuddy Adapter：网关和本地 JSONL 都没有历史时报告检查失败", async (t) => {
  const fixtureData = fixture(t);
  rmSync(fixtureData.projectsDir, { recursive: true, force: true });
  const adapter = createWorkBuddyAdapter({ ...fixtureData, gateway: gateway(), token: token() });
  await assert.rejects(adapter.snapshot(ID), /找不到对应的本地 JSONL/);
  await assert.rejects(adapter.incremental(ID), /找不到对应的本地 JSONL/);
});

test("WorkBuddy token：Windows 不误用 POSIX mode 拒绝凭据", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "relay-workbuddy-token-"));
  const dir = join(homeDir, ".workbuddy");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".gw-token");
  writeFileSync(path, JSON.stringify({ password: "x", port: 55409, pid: null, savedAt: at(1) }));
  chmodSync(path, 0o644);
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const token = createWorkBuddyTokenProvider({ homeDir, platform: "win32" });
  assert.equal((await token.read()).port, 55409);
});
