import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";

import { openRelayStore } from "../../lib/storage/index.js";
import { createBridgeService } from "../../lib/services/bridge.js";
import { createRelayService } from "../../lib/services/relay.js";
import { cleanupBackgroundRecords } from "../../lib/services/cleanup.js";
import { createSetupService } from "../../lib/services/setup.js";
import { createNotificationCredentialService } from "../../lib/services/credentials.js";
import { createAgyBridgeService } from "../../lib/services/agy-bridge.js";
import { startAgyBridgeClient } from "../../lib/agy-bridge/server.js";
import { createAgyAdapter } from "../../lib/adapters/agy/index.js";
import { resolveAgyCommand } from "../../lib/adapters/agy/paths.js";
import { resolveClaudeCommand } from "../../lib/adapters/claude/runner.js";
import { connectCodex, CodexTransportError } from "../../lib/adapters/codex/rpc.js";
import { startChannelServer } from "../../lib/channel/server.js";
import { createClaudeChannelService } from "../../lib/services/claude-channel.js";
import { readStdinText as readSendStdin } from "../../skills/agy-notify/send.mjs";
import { readStdinText as readStartStdin, resolveCliSpawn, prepareJob } from "../../skills/agy-notify/start.mjs";

const SESSION_A = "11111111-1111-1111-1111-111111111111";

test("R-01 Windows CLI 解析：优先 .exe 或 npm JS 入口，拒绝裸 .cmd/.bat", (t) => {
  const agyOnlyCmd = resolveAgyCommand({
    platform: "win32",
    env: { Path: "C:\\Tools\\bin" },
    existsFile: (p) => p === "C:\\Tools\\bin\\agy.cmd",
  });
  assert.equal(agyOnlyCmd.found, false);

  const agySiblingExe = resolveAgyCommand({
    platform: "win32",
    cliPath: "C:\\Tools\\bin\\agy.cmd",
    existsFile: (p) => p === "C:\\Tools\\bin\\agy.exe" || p === "C:\\Tools\\bin\\agy.cmd",
  });
  assert.equal(agySiblingExe.found, true);
  assert.equal(agySiblingExe.command, "C:\\Tools\\bin\\agy.exe");

  const claudeNpm = resolveClaudeCommand({
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliArgs: ["--version"],
    env: { Path: "C:\\Users\\demo\\AppData\\Roaming\\npm" },
    existsFile: (p) =>
      p === "C:\\Users\\demo\\AppData\\Roaming\\npm\\claude.cmd" ||
      p === "C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
  });
  assert.equal(claudeNpm.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(claudeNpm.args, [
    "C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    "--version",
  ]);

  const dir = mkdtempSync(join(tmpdir(), "relay-win-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const npmDir = join(dir, "npm");
  const cliJs = join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(npmDir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(cliJs, "// fake codex cli\n");
  writeFileSync(
    join(npmDir, "codex.cmd"),
    '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  );
  const codexSpec = resolveCliSpawn("codex", { PATH: npmDir }, dir, "win32");
  assert.equal(codexSpec.command, process.execPath);
  assert.deepEqual(codexSpec.prefixArgs, [cliJs]);

  const badCmd = join(dir, "broken.cmd");
  writeFileSync(badCmd, "@echo off\r\n");
  assert.throws(
    () => resolveCliSpawn("agy", { DSH_AGY_BIN: badCmd }, dir, "win32"),
    /Windows 下不支持直接启动/,
  );
});

test("R-02 & N-1~N-4 桥梁生命周期：pause/stop 清 schedule_task_id、reconcile 单飞、inspect/send 关闭、删除清理孤儿批次", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-bridge-hardening-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let closed = false;
  let nowMs = 10_000;
  let scheduleCreated = 0;
  let scheduleDeleted = 0;
  let releaseCreate = null;
  const tasks = new Map();

  const adapter = {
    agent: "claude",
    capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: true, runPrompt: false }),
    async snapshot() {
      return closed
        ? { closed: true, title: "已关闭", cwd: "/tmp", cursor: null, last_activity_at: nowMs, runtime: "unknown", held: false, runtime_error: null, check_error: null, finished_turn: null, last_reply: null }
        : { closed: false, title: "测试会话", cwd: "/tmp", cursor: { uuid: "u1", timestamp: nowMs }, last_activity_at: nowMs, runtime: "idle", held: false, runtime_error: null, check_error: null, finished_turn: null, last_reply: "ok" };
    },
    async incremental() {
      return { closed, events: [], cursor: { uuid: "u1", timestamp: nowMs }, has_more: false };
    },
    async sendMessage() {
      return { status: "sent", external_ref: "ref-1" };
    },
  };
  const adapters = { get: () => adapter, list: () => [adapter] };
  const scheduler = {
    async create(input) {
      scheduleCreated++;
      if (releaseCreate) await releaseCreate();
      const id = `task-${scheduleCreated}`;
      tasks.set(id, { id, prompt: input.prompt, sessionId: input.sessionId, status: "active" });
      return id;
    },
    async delete({ id }) {
      scheduleDeleted++;
      return tasks.delete(id);
    },
    async catalog() {
      return [...tasks.values()];
    },
  };
  const transport = {
    idle: async () => true,
    deliver: async () => ({ status: "delivered" }),
    confirm: async () => "delivered",
  };
  const bridge = createBridgeService({
    store,
    adapters,
    scheduler,
    transport,
    createSession: async () => "dsh-1",
    now: () => nowMs,
  });
  const relay = createRelayService({
    store,
    bridge,
    adapters,
    subscriptions: {
      inspect: async () => {
        throw new Error("不应绕过 bridge 调用旧 subscriptions.inspect");
      },
      delete: async () => {
        throw new Error("不应绕过 bridge 调用旧 subscriptions.delete");
      },
      closeSession: async () => {
        throw new Error("不应绕过 bridge 调用旧 subscriptions.closeSession");
      },
    },
    checks: {},
    notifications: { drain: async () => {} },
    skillInstall: {},
    listDshSessions: async () => [],
  });

  // 1. pause 与 stop 正确清空 schedule_task_id（N-4）
  const created = await bridge.subscribe({
    type: "poll",
    agent: "claude",
    external_session_id: SESSION_A,
    dsh_session_id: "dsh-1",
    check_interval_seconds: 300,
    topic: "观察进度",
  });
  assert.equal(created.ok, true);
  const subId = created.subscription.id;
  assert.ok(store.subscriptions.get(subId).schedule_task_id);

  const paused = await bridge.pause(subId);
  assert.equal(paused.ok, true);
  assert.equal(store.subscriptions.get(subId).status, "paused");
  assert.equal(store.subscriptions.get(subId).schedule_task_id, null);

  // 2. 并发 reconcile() 单飞，不重复创建定时任务（N-3）
  await bridge.resume(subId);
  store.subscriptions.update({
    id: subId,
    expected_status: "active",
    patch: { schedule_task_id: null, updated_at: nowMs },
  });
  tasks.clear();
  scheduleCreated = 0;
  let resumeGate;
  releaseCreate = () => new Promise((r) => (resumeGate = r));
  const r1 = bridge.reconcile();
  const r2 = bridge.reconcile();
  while (!resumeGate) await new Promise(setImmediate);
  releaseCreate = null;
  resumeGate();
  await Promise.all([r1, r2]);
  assert.equal(scheduleCreated, 1, "并发 reconcile 仅应创建一个定时任务");

  // 3. 删除订阅收敛未确认批次，且后续新关注不被旧批次阻塞（N-2）
  await bridge.push({
    agent: "claude",
    external_session_id: SESSION_A,
    request_id: "req-before-delete",
    summary: "测试进展",
    result: "completed",
  });
  const route = store.bridge.route("claude", SESSION_A);
  const batchBeforeDelete = store.bridge.open(route.id);
  assert.ok(batchBeforeDelete);
  const deleted = await relay.call("delete_subscription", { subscription_id: subId });
  assert.equal(deleted.ok, true);
  assert.equal(store.bridge.batch(batchBeforeDelete.id).state, "needs_attention");
  assert.equal(store.bridge.open(route.id), null);

  // 4. relay.call('inspect') 发现会话关闭时经 bridge 结束订阅（N-1）
  const created2 = await bridge.subscribe({
    type: "poll",
    agent: "claude",
    external_session_id: SESSION_A,
    dsh_session_id: "dsh-1",
    check_interval_seconds: 300,
    topic: "观察关闭",
  });
  assert.equal(created2.ok, true);
  const sub2Id = created2.subscription.id;
  closed = true;
  const inspected = await relay.call("inspect", { agent: "claude", external_session_id: SESSION_A });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.value.closed, true);
  assert.equal(store.subscriptions.get(sub2Id).status, "ended");
  assert.equal(store.subscriptions.get(sub2Id).end_reason, "session_closed");
  assert.equal(store.subscriptions.get(sub2Id).schedule_task_id, null);
  assert.ok(scheduleDeleted >= 2);
});

test("R-03 & N-6 存储与后台目录定期清理：终态表按窗口清理，活跃订阅与 Codex 绑定保留", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cleanup-hardening-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const day = 86_400_000;
  const oldTs = 1_000;
  const nowMs = 31 * day;
  const recentTs = nowMs - day;
  const cutoff = nowMs - 30 * day;

  // 创建路由、已处理旧批次/旧事件与近期事件
  const route = store.bridge.ensure("claude", SESSION_A, "dsh-1");
  store.bridge.append(route, { id: "push:old-1", kind: "push", body: "旧事件" }, oldTs);
  const oldBatch = store.bridge.prepare(route, null, oldTs);
  store.bridge.acknowledge(oldBatch.id, oldTs);

  store.bridge.append(route, { id: "push:recent-1", kind: "push", body: "新事件" }, recentTs);

  // 创建定向通知（旧终态 + 活跃待投递）
  store.targetedNotifications.insert(
    {
      request_id: "t-old",
      agent: "claude",
      external_session_id: SESSION_A,
      dsh_session_id: "dsh-1",
      result: "completed",
      summary: "旧定向",
      external_ref: null,
    },
    oldTs,
  );
  store.targetedNotifications.claim("t-old");
  store.targetedNotifications.finish("t-old", "delivered", null);
  store.targetedNotifications.insert(
    {
      request_id: "t-live",
      agent: "claude",
      external_session_id: SESSION_A,
      dsh_session_id: "dsh-1",
      result: "completed",
      summary: "活跃定向",
      external_ref: null,
    },
    oldTs,
  );

  // 创建 Codex 绑定（永不误删）与未读回执（已读清理、未读保留）
  store.codexSessions.register({
    session_id: "codex-bound-1",
    endpoint: "/tmp/codex.sock",
    cwd: "/tmp",
    created_at: oldTs,
    updated_at: oldTs,
  });
  store.unread.record("dsh-1", "rcpt-old-read");
  const seqRead = store.unread.list()[0].sequence;
  store.unread.record("dsh-1", "rcpt-old-unread");
  store.unread.markRead("dsh-1", seqRead);

  const summary = store.cleanupHistory({ now: nowMs, retentionDays: 30 });
  assert.deepEqual(Object.keys(summary).sort(), ["messages_deleted", "notifications_deleted"]);
  assert.equal(store.bridge.event("push:old-1"), null, "超出窗口的终态事件应被清理");
  assert.equal(store.bridge.batch(oldBatch.id), null, "无事件引用的终态批次应被清理");
  assert.ok(store.bridge.event("push:recent-1"), "窗口内的事件必须保留");
  assert.equal(store.targetedNotifications.get("t-old"), null, "超期终态定向通知应被清理");
  assert.ok(store.targetedNotifications.get("t-live"), "未完成定向通知必须保留");
  assert.equal(store.codexSessions.has("codex-bound-1", "/tmp/codex.sock"), true, "Codex 会话绑定不得被历史清理删除");
  assert.deepEqual(store.unread.list().map((r) => r.delivery_key), ["rcpt-old-unread"]);

  // cleanupSubscriptions 不误删未到期的活跃订阅
  store.subscriptions.create({
    id: "active-unexpired",
    owner: "test",
    type: "poll",
    agent: "claude",
    external_session_id: "ext-live",
    dsh_session_id: "dsh-1",
    check_interval_seconds: 300,
    max_lifetime_seconds: 86400 * 10,
    created_at: nowMs - 8 * day,
    updated_at: nowMs - 8 * day,
  });
  const subCleanup = store.cleanupSubscriptions({ now: nowMs, olderThanDays: 7 });
  assert.equal(subCleanup.subscriptions, 0);
  assert.ok(store.subscriptions.get("active-unexpired"));

  // cleanupBackgroundRecords 仅删除超期终态目录，保留运行中/未知与近期目录
  const oldCompleted = join(dir, "background-jobs", "claude", "job-old-completed");
  const oldUnknown = join(dir, "background-jobs", "claude", "job-old-unknown");
  const recentCompleted = join(dir, "background-jobs", "agy", "job-recent");
  const oldLaunch = join(dir, "visible-launches", "launch-old");
  for (const d of [oldCompleted, oldUnknown, recentCompleted, oldLaunch]) mkdirSync(d, { recursive: true });
  writeFileSync(join(oldCompleted, "state.json"), JSON.stringify({ status: "completed", updated_at: oldTs }));
  writeFileSync(join(oldUnknown, "state.json"), JSON.stringify({ status: "unknown", updated_at: oldTs }));
  writeFileSync(join(recentCompleted, "state.json"), JSON.stringify({ status: "completed", updated_at: recentTs }));
  writeFileSync(join(oldLaunch, "launch.json"), JSON.stringify({ status: "opened", updated_at: oldTs }));
  utimesSync(join(oldLaunch, "launch.json"), new Date(oldTs), new Date(oldTs));

  const removed = cleanupBackgroundRecords(dir, cutoff);
  assert.equal(removed, 2);
  assert.equal(existsSync(oldCompleted), false);
  assert.equal(existsSync(oldLaunch), false);
  assert.equal(existsSync(oldUnknown), true);
  assert.equal(existsSync(recentCompleted), true);
});

test("R-05 & R-13 接力 Skill 脚本三端与单源模板完全一致，且 --stdin 安全校验与指纹一致", async (t) => {
  const skillsRoot = new URL("../../skills/", import.meta.url);
  const templateRoot = new URL("../../scripts/skill-templates/agent-notify/", import.meta.url);
  for (const file of ["send.mjs", "start.mjs", "directory.mjs"]) {
    const template = readFileSync(new URL(file, templateRoot), "utf8");
    const agy = readFileSync(new URL(`agy-notify/${file}`, skillsRoot), "utf8");
    const claude = readFileSync(new URL(`claude-notify/${file}`, skillsRoot), "utf8");
    const codex = readFileSync(new URL(`codex-notify/${file}`, skillsRoot), "utf8");
    assert.equal(agy, template, `agy-notify/${file} 必须与单源模板字节一致`);
    assert.equal(claude, template, `claude-notify/${file} 必须与单源模板字节一致`);
    assert.equal(codex, template, `codex-notify/${file} 必须与单源模板字节一致`);
  }

  // TTY 立即拒绝
  const fakeTty = new PassThrough();
  fakeTty.isTTY = true;
  await assert.rejects(() => readSendStdin({ stream: fakeTty }), /不能交互式等待终端输入/);

  // 超过字节上限立即拒绝
  const huge = new PassThrough();
  const hugePromise = readSendStdin({ stream: huge, maxBytes: 16 });
  huge.end("a".repeat(32));
  await assert.rejects(() => hugePromise, /字节上限/);

  // CRLF 归一与 heredoc 末尾单换行剥离，保证 start.mjs 指纹与 --content 一致
  const piped = new PassThrough();
  const readPromise = readStartStdin({ stream: piped });
  piped.end("第一行\r\n第二行\r\n");
  const normalized = await readPromise;
  assert.equal(normalized, "第一行\n第二行");

  const home = mkdtempSync(join(tmpdir(), "relay-stdin-fp-"));
  const workDir = join(home, "proj");
  mkdirSync(workDir, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = await prepareJob(
    { request_id: "fp-same", cwd: workDir, content: "第一行\n第二行", omit_source: true },
    { home, env: { DSH_HOME: join(home, ".dsh") } },
  );
  const second = await prepareJob(
    { request_id: "fp-same", cwd: workDir, content: normalized, omit_source: true },
    { home, env: { DSH_HOME: join(home, ".dsh") } },
  );
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
});

test("R-06 & R-12 推送服务自检反映真实监听状态；通知凭证 verify 校验端点一致", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-setup-push-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const credFile = join(dir, "notification-client.json");
  const credA = createNotificationCredentialService({
    file: credFile,
    endpoint: "http://127.0.0.1:37421/api/agent-relay/notifications",
  });
  const { token } = credA.ensure();
  assert.equal(credA.verify(token), true);

  // 端口变化后，verify 与 status 一致返回失效
  const credB = createNotificationCredentialService({
    file: credFile,
    endpoint: "http://127.0.0.1:39999/api/agent-relay/notifications",
  });
  assert.equal(credB.status().configured, false);
  assert.equal(credB.verify(token), false);

  let listening = false;
  const setup = createSetupService({
    run: async () => ({ code: 0, stdout: "2.1.0", stderr: "", timedOut: false }),
    codexRunner: async () => ({ code: 0, stdout: "codex 0.1.0", stderr: "", timedOut: false }),
    channel: { registrations: () => [], probe: async () => ({ status: "not_registered" }) },
    listAgents: async () => [],
    channelCredentials: { reset: () => ({ token: "x", digest: "0".repeat(64), created_at: 1 }), verify: () => true },
    notificationCredentials: credA,
    pushServerStatus: () => ({
      listening,
      host: "127.0.0.1",
      port: 37421,
      error: listening ? null : "EADDRINUSE",
    }),
    homeDir: dir,
    env: { CODEX_HOME: join(dir, ".codex") },
  });

  const down = await setup.check("codex");
  assert.equal(down.overall, "unavailable");
  assert.equal(down.items.find((i) => i.key === "push_server")?.status, "unavailable");
  await assert.rejects(() => setup.requireReady("codex"), /EADDRINUSE/);

  listening = true;
  const up = await setup.check("codex");
  assert.equal(up.items.find((i) => i.key === "push_server")?.status, "ok");
});

test("R-07 & N-5 AgyBridge 按 app_data_dir 路由并回退；Sidecar /result 瞬时失败自动重试", async () => {
  const bridge = createAgyBridgeService({ requestTimeoutMs: 500 });
  const receivedBy = [];

  // 两个在线 Sidecar：桌面端（pid 101）和 IDE 端（pid 202）
  const pDesktop = bridge.poll({ pid: 101, app_data_dir: "/Users/demo/.gemini/antigravity", version: "1.0" }, 5000);
  const pIde = bridge.poll({ pid: 202, app_data_dir: "/Users/demo/.gemini/antigravity-ide", version: "1.0" }, 5000);

  const sendPromise = bridge.sendMessage(SESSION_A, "发往 IDE", {
    preferredAppDataDir: "/Users/demo/.gemini/antigravity-ide",
  });
  const [cmdIde] = await pIde;
  receivedBy.push(202);
  assert.equal(cmdIde.action, "send_message");
  bridge.complete({ request_id: cmdIde.request_id, ok: true, value: { status: "sent" } });
  const outcome = await sendPromise;
  assert.deepEqual(outcome, { status: "sent" });
  assert.deepEqual(receivedBy, [202]);

  // 首选 Sidecar 返回“外部会话不存在”时回退到另一个在线 Sidecar
  const pIde2 = bridge.poll({ pid: 202, app_data_dir: "/Users/demo/.gemini/antigravity-ide", version: "1.0" }, 5000);
  const fallbackSend = bridge.sendMessage(SESSION_A, "回退发往桌面", {
    preferredAppDataDir: "/Users/demo/.gemini/antigravity-ide",
  });
  const [cmd1] = await pIde2;
  bridge.complete({
    request_id: cmd1.request_id,
    ok: true,
    value: { status: "rejected", reason: "外部会话不存在" },
  });
  const [cmd2] = await pDesktop;
  bridge.complete({ request_id: cmd2.request_id, ok: true, value: { status: "sent" } });
  assert.deepEqual(await fallbackSend, { status: "sent" });
  bridge.dispose();

  // Sidecar /result 回调在首次 503 后自动重试成功
  let pollCount = 0;
  let resultAttempts = 0;
  let client;
  const done = new Promise((resolve) => {
    client = startAgyBridgeClient({
      env: {
        DSH_AGENT_RELAY_PORT: "37421",
        AGENT_RELAY_AGY_TOKEN_FILE: new URL("../../package.json", import.meta.url).pathname,
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
      },
      resultRetryDelaysMs: [5, 5],
      log: () => {},
      fetchImpl: async (url) => {
        const s = String(url);
        if (s.endsWith("/poll")) {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              commands: [{ request_id: "r-retry", action: "get_conversation", payload: { conversation_id: SESSION_A } }],
            });
          }
          client.stop();
          return Response.json({ commands: [] });
        }
        if (s.includes("GetConversation")) {
          return Response.json({ conversation: { id: SESSION_A, annotations: { title: "t" }, state: { runState: "RUN_STATE_IDLE" } } });
        }
        if (s.endsWith("/result")) {
          resultAttempts++;
          if (resultAttempts === 1) return new Response("busy", { status: 503 });
          resolve();
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  await done;
  client.stop();
  await client.running;
  assert.equal(resultAttempts, 2);
});

test("R-09 & R-10 Agy 延迟流式读取 transcript_full 与 SQLite 无时区时间按 UTC 解析", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-agy-perf-"));
  const dataDir = join(root, ".gemini", "antigravity");
  const logsDir = join(dataDir, "brain", SESSION_A, ".system_generated", "logs");
  mkdirSync(logsDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = new DatabaseSync(join(dataDir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT, preview TEXT, last_modified_time TEXT, workspace_uris TEXT,
    status TEXT, project_id TEXT, parent_conversation_id TEXT,
    nesting_depth INTEGER, not_fully_idle INTEGER, killed INTEGER
  )`);
  db.prepare(
    `INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0)`,
  ).run(SESSION_A, "UTC 测试", "", "2026-11-27 10:00:00", "[]", "CASCADE_RUN_STATUS_IDLE", "");
  db.close();

  // 无截断字段时，即使 transcript_full.jsonl 含损坏内容也不读取
  writeFileSync(
    join(logsDir, "transcript.jsonl"),
    JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-27T10:00:00Z", content: "<USER_REQUEST>你好</USER_REQUEST>" }) + "\n" +
    JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-27T10:00:05Z", content: "短回复" }) + "\n",
  );
  writeFileSync(join(logsDir, "transcript_full.jsonl"), "INVALID{{{NOT READ\n");

  const adapter = createAgyAdapter({ homeDir: root, env: {} });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].last_activity_at, Date.UTC(2026, 10, 27, 10, 0, 0));

  // 存在 truncated_fields: ["content"] 时，流式只取所需 step_index
  writeFileSync(
    join(logsDir, "transcript.jsonl"),
    JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-27T10:00:00Z", content: "<USER_REQUEST>长问题</USER_REQUEST>" }) + "\n" +
    JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-27T10:00:05Z", content: "截断...", truncated_fields: ["content"] }) + "\n",
  );
  writeFileSync(
    join(logsDir, "transcript_full.jsonl"),
    JSON.stringify({ step_index: 0, content: "无关步骤" }) + "\n" +
    JSON.stringify({ step_index: 1, content: "完整流式恢复正文" }) + "\n",
  );
  const snap = await adapter.snapshot(SESSION_A);
  assert.equal(snap.last_reply, "完整流式恢复正文");
});

test("R-08 Channel Server 串行化请求处理，ClaudeChannelService 清理长期离线登记", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.setEncoding("utf8").on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) lines.push(JSON.parse(line));
  });
  const srv = startChannelServer({ input, output, log: () => {} });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  srv.stop();
  assert.deepEqual(lines.map((m) => m.id), [1, 2]);

  let nowMs = 1_000;
  const channel = createClaudeChannelService({
    store: {
      messages: {
        awaitingAck: () => [],
        ackTimeout: () => {},
        queuedBefore: () => [],
        transition: () => false,
        inFlight: () => [],
        queued: () => [],
      },
    },
    listAgents: async () => [],
    now: () => nowMs,
    onlineMs: 1_000,
  });
  const p = channel.poll({ pid: 999, session_id: SESSION_A, version: "1" }, 5);
  await p;
  assert.equal(channel.registrations().length, 1);
  nowMs = 50_000;
  await channel.tick();
  assert.equal(channel.registrations().length, 0);
  channel.dispose();
});

test("R-11 Codex RPC 单请求超时不破坏共享连接上的并发请求", async () => {
  // 构造纯内存 Duplex WebSocket 服务端，无需任何网络端口
  function encodeServerFrame(text) {
    const payload = Buffer.from(text, "utf8");
    const head = payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
    return Buffer.concat([head, payload]);
  }
  function decodeClientFrames(buf) {
    const out = [];
    let offset = 0;
    while (offset + 2 <= buf.length) {
      let len = buf[offset + 1] & 127;
      let maskStart = offset + 2;
      if (len === 126) {
        if (offset + 4 > buf.length) break;
        len = buf.readUInt16BE(offset + 2);
        maskStart = offset + 4;
      }
      const bodyStart = maskStart + 4;
      if (buf.length < bodyStart + len) break;
      const mask = buf.subarray(maskStart, bodyStart);
      const body = Buffer.from(buf.subarray(bodyStart, bodyStart + len));
      for (let i = 0; i < len; i++) body[i] ^= mask[i % 4];
      out.push(JSON.parse(body.toString("utf8")));
      offset = bodyStart + len;
    }
    return { messages: out, rest: buf.subarray(offset) };
  }

  let upgraded = false;
  let rx = Buffer.alloc(0);
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      rx = Buffer.concat([rx, chunk]);
      if (!upgraded) {
        const text = rx.toString("utf8");
        if (text.includes("\r\n\r\n")) {
          upgraded = true;
          const key = text.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)[1].trim();
          const accept = createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");
          rx = Buffer.alloc(0);
          this.push(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
        }
        cb();
        return;
      }
      const { messages, rest } = decodeClientFrames(rx);
      rx = rest;
      for (const msg of messages) {
        if (msg.method === "initialize") {
          this.push(encodeServerFrame(JSON.stringify({ id: msg.id, result: { ok: true } })));
        } else if (msg.method === "thread/list" && msg.params?.hang) {
          // 故意不回复，触发单请求超时
        } else if (msg.method === "thread/list") {
          setTimeout(() => {
            this.push(encodeServerFrame(JSON.stringify({ id: msg.id, result: { data: ["alive"] } })));
          }, 15);
        }
      }
      cb();
    },
  });

  const client = await connectCodex({
    socketPath: "/tmp/fake-codex.sock",
    timeoutMs: 60,
    createConnection: () => duplex,
  });

  const slow = client.request("thread/list", { hang: true });
  await assert.rejects(
    () => slow,
    (error) => error instanceof CodexTransportError && error.dispatched === true && /超时/.test(error.message),
  );

  // 连接仍保持存活，后续请求正常返回
  const after = await client.request("thread/list", { hang: false });
  assert.deepEqual(after, { data: ["alive"] });
  client.close();
});

test("R-15 前端浏览器通知解析 JSON 摘要，多页分页上一页退回上一游标，默认不盲轮询 routes", async () => {
  let plugin;
  let cursor = 0;
  const states = [];
  const effects = [];
  const notifications = [];
  const calls = [];
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((x) => x !== null && x !== false && x !== undefined),
    }),
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (v) => {
          states[i] = typeof v === "function" ? v(states[i]) : v;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      return (states[i] ??= { current: initial });
    },
    useEffect(run, deps) {
      const i = cursor++;
      if (!states[i] || deps.some((d, j) => d !== states[i][j])) {
        states[i] = deps;
        effects.push(run);
      }
    },
  };
  class Notify {
    static permission = "granted";
    constructor(title, options) {
      notifications.push({ title, ...options });
    }
  }
  const storage = new Map([["dsh-agent-relay:notify:lastSeen", "10"]]);
  runInNewContext(readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8"), {
    window: {
      __ModuleLoader__: {
        load(entry) {
          plugin = entry.factory(() => react);
        },
      },
    },
    Notification: Notify,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
  });

  const pageData = {
    null: { items: [{ id: "p1", agent: "claude", type: "poll", external_session_id: "e1", status: "active", created_at: Date.now() }], next_cursor: "c2" },
    c2: { items: [{ id: "p2", agent: "claude", type: "poll", external_session_id: "e2", status: "active", created_at: Date.now() }], next_cursor: "c3" },
    c3: { items: [{ id: "p3", agent: "claude", type: "poll", external_session_id: "e3", status: "active", created_at: Date.now() }], next_cursor: null },
  };
  const rpc = {
    async call(_c, method, args) {
      const ep = method.split("/").at(-1);
      calls.push({ ep, args });
      if (ep === "agents") return { ok: true, value: [] };
      if (ep === "list") return { ok: true, value: pageData[String(args.cursor ?? "null")] };
      if (ep === "notify_poll") {
        return {
          ok: true,
          value: [
            {
              id: "n-json",
              created_at: 20,
              cursor: { created_at: 20, id: "n-json" },
              result: "completed",
              delivery_status: "delivered",
              summary: JSON.stringify({ result: "completed", summary: "构建和测试全部通过", external_ref: null }),
            },
          ],
        };
      }
      throw new Error(`unexpected endpoint: ${ep}`);
    },
  };
  const nodes = (tree) => [tree, ...tree.children.filter((x) => typeof x === "object").flatMap(nodes)];
  const render = () => {
    cursor = 0;
    return plugin.AgentRelayPanel({ rpc, openSession() {} });
  };
  const flush = async () => {
    for (const run of effects.splice(0)) run();
    await new Promise((r) => setImmediate(r));
  };

  let tree = render();
  await flush();
  tree = render();
  assert.equal(calls.some((c) => c.ep === "routes"), false, "未打开路由抽屉时不应轮询 routes");

  // 第 1 页 -> 第 2 页 -> 第 3 页
  nodes(tree).find((n) => n.type === "button" && n.children.includes("下一页")).props.onClick();
  tree = render();
  await flush();
  tree = render();
  assert.equal(calls.filter((c) => c.ep === "list").at(-1).args.cursor, "c2");

  nodes(tree).find((n) => n.type === "button" && n.children.includes("下一页")).props.onClick();
  tree = render();
  await flush();
  tree = render();
  assert.equal(calls.filter((c) => c.ep === "list").at(-1).args.cursor, "c3");

  // 第 3 页点“上一页”应退回第 2 页（cursor = "c2"），而非直接跳回首页 null
  nodes(tree).find((n) => n.type === "button" && n.children.includes("上一页")).props.onClick();
  tree = render();
  await flush();
  tree = render();
  assert.equal(calls.filter((c) => c.ep === "list").at(-1).args.cursor, "c2");

  // 再点“上一页”退回第 1 页（cursor = null）
  nodes(tree).find((n) => n.type === "button" && n.children.includes("上一页")).props.onClick();
  tree = render();
  await flush();
  tree = render();
  assert.equal(calls.filter((c) => c.ep === "list").at(-1).args.cursor, null);

  // 浏览器通知应把 JSON summary 解析为可读正文
  let icon;
  plugin.apply({
    slots: {
      inject(_n, run) {
        return run();
      },
      register(options, component) {
        if (options.name === "sidebar.panellist") icon = component;
        return () => {};
      },
    },
    connection: { rpc },
    uiWorkspace: { openSession() {} },
  });
  cursor = 100;
  icon({ rpc });
  await flush();
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /构建和测试全部通过/);
  assert.equal(notifications[0].body.includes('{"result"'), false);
});
