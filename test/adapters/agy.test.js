import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgyAdapter } from "../../lib/adapters/agy/index.js";
import {
  detectAgyDesktopBinary,
  resolveAgyCommand,
  resolveAgySkillsDir,
  uriToFilePath,
} from "../../lib/adapters/agy/paths.js";
import { parseAgyTranscript } from "../../lib/adapters/agy/transcript.js";
import { createAgyBridgeService } from "../../lib/services/agy-bridge.js";
import { createAgyBridgeRoutes } from "../../lib/services/agy-bridge-http.js";
import { startAgyBridgeClient } from "../../lib/agy-bridge/server.js";

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_CHILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_ARCHIVED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function createSummariesDb(dir, rows, archivedIds = []) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "conversation_summaries.db"));
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      killed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE conversations_fts (
      conversation_id TEXT,
      archived INTEGER
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
      status, project_id, parent_conversation_id, nesting_depth, not_fully_idle, killed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(
      r.id,
      r.title ?? "",
      r.preview ?? "",
      r.stepCount ?? 2,
      r.time ?? "2026-11-26 06:00:00+00:00",
      JSON.stringify(r.workspaceUris ?? []),
      r.status ?? "CASCADE_RUN_STATUS_IDLE",
      r.projectId ?? "",
      r.parentId ?? "",
      r.nestingDepth ?? 0,
      r.notFullyIdle ? 1 : 0,
      r.killed ? 1 : 0,
    );
  }
  const insertFts = db.prepare("INSERT INTO conversations_fts(conversation_id, archived) VALUES (?, ?)");
  for (const r of rows) {
    insertFts.run(r.id, archivedIds.includes(r.id) ? 1 : 0);
  }
  db.close();
}

function writeTranscript(dataDir, sessionId, steps, fullSteps = null) {
  const logsDir = join(dataDir, "brain", sessionId, ".system_generated", "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, "transcript.jsonl"),
    steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
  );
  if (fullSteps) {
    writeFileSync(
      join(logsDir, "transcript_full.jsonl"),
      fullSteps.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );
  }
}

test("跨平台路径解析：兼容 Windows 与 macOS 的配置目录、CLI 与 file URI", () => {
  assert.equal(
    resolveAgySkillsDir({ platform: "win32", homeDir: "C:\\Users\\Alice", env: {} }),
    "C:\\Users\\Alice\\.gemini\\config\\skills",
  );
  assert.equal(
    resolveAgySkillsDir({ platform: "darwin", homeDir: "/Users/alice", env: {} }),
    "/Users/alice/.gemini/config/skills",
  );

  const winCli = resolveAgyCommand({
    platform: "win32",
    homeDir: "C:\\Users\\Alice",
    env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local", Path: "C:\\Windows\\System32" },
    existsFile: (p) => p === "C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe",
  });
  assert.equal(winCli.found, true);
  assert.equal(winCli.command, "C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe");

  const macApp = detectAgyDesktopBinary({
    platform: "darwin",
    homeDir: "/Users/alice",
    env: {},
    existsFile: (p) => p === "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
  });
  assert.equal(macApp, "/Applications/Antigravity.app/Contents/Resources/bin/language_server");

  assert.equal(uriToFilePath("file:///C:/Users/Alice/project"), "C:\\Users\\Alice\\project");
  if (process.platform !== "win32") {
    assert.equal(uriToFilePath("file:///Users/alice/project"), "/Users/alice/project");
  }
});

test("Transcript 解析：恢复 transcript_full 截断字段，区分外部注入消息与内部任务唤醒", () => {
  const compact = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-26T06:00:00Z",
      content: "<USER_REQUEST>\n首条任务\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-26T06:00:05Z",
      content: "截断预览",
      truncated_fields: ["content"],
    },
    {
      step_index: 2,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: "2026-11-26T06:00:10Z",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T06:00:10Z sender=${SESSION_A}/task-1 priority=MESSAGE_PRIORITY_HIGH content=Background command is still running after 60s: test\n</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 3,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: "2026-11-26T06:00:20Z",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T06:00:20Z sender=${SESSION_B} priority=MESSAGE_PRIORITY_HIGH content=外部追加任务\n</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-26T06:00:25Z",
      content: "追加任务完成",
    },
  ];
  const full = [
    compact[0],
    { ...compact[1], content: "完整首轮回复正文", truncated_fields: undefined },
  ];

  const parsed = parseAgyTranscript(
    compact.map((x) => JSON.stringify(x)).join("\n") + '\n{"incomplete_trailing',
    full.map((x) => JSON.stringify(x)).join("\n"),
  );
  assert.equal(parsed.entries.length, 4);
  assert.equal(parsed.entries[0].kind, "user");
  assert.equal(parsed.entries[0].text, "首条任务");
  assert.equal(parsed.entries[1].text, "完整首轮回复正文");
  assert.equal(parsed.entries[2].kind, "user");
  assert.equal(parsed.entries[2].injected, true);
  assert.equal(parsed.entries[2].text, "外部追加任务");
  assert.equal(parsed.last_reply, "追加任务完成");
});

test("AgyAdapter：会话列表排除归档与子会话，支持增量游标、快照与原消息进度关联", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-agy-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const appDir = join(root, ".gemini", "antigravity");
  const cliDir = join(root, ".gemini", "antigravity-cli");
  const configDir = join(root, ".gemini", "config");
  mkdirSync(join(configDir, "projects"), { recursive: true });
  writeFileSync(
    join(configDir, "projects", "proj-1.json"),
    JSON.stringify({
      id: "proj-1",
      projectResources: { resources: [{ gitFolder: { folderUri: "file:///Users/demo/repo-b" } }] },
    }),
  );

  createSummariesDb(
    appDir,
    [
      {
        id: SESSION_A,
        title: "桌面主会话",
        time: "2026-11-26 06:10:00+00:00",
        workspaceUris: ["file:///Users/demo/repo-a"],
      },
      {
        id: SESSION_CHILD,
        title: "内部子会话",
        time: "2026-11-26 06:11:00+00:00",
        parentId: SESSION_A,
        nestingDepth: 1,
      },
      {
        id: SESSION_ARCHIVED,
        title: "已归档会话",
        time: "2026-11-26 06:12:00+00:00",
      },
    ],
    [SESSION_ARCHIVED],
  );

  createSummariesDb(cliDir, [
    {
      id: SESSION_B,
      title: "CLI 会话",
      time: "2026-11-26 06:05:00+00:00",
      projectId: "proj-1",
    },
  ]);

  writeTranscript(appDir, SESSION_A, [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T06:09:00Z", content: "<USER_REQUEST>第一轮</USER_REQUEST>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T06:09:10Z", content: "第一轮回复" },
    { step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-26T06:10:00Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T06:10:00Z sender=${SESSION_B} priority=MESSAGE_PRIORITY_HIGH content=接力委托\n</SYSTEM_MESSAGE>` },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T06:10:05Z", content: "接力回复完成" },
  ]);

  const adapter = createAgyAdapter({ homeDir: root, env: {}, runner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) });
  const sessions = await adapter.listSessions();
  assert.deepEqual(sessions.map((s) => s.id), [SESSION_A, SESSION_B]);
  assert.equal(sessions[0].send_allowed, false);
  assert.equal(sessions[1].send_allowed, true);
  if (process.platform !== "win32") {
    assert.equal(sessions[0].cwd, "/Users/demo/repo-a");
    assert.equal(sessions[1].cwd, "/Users/demo/repo-b");
  }

  const archivedSnap = await adapter.snapshot(SESSION_ARCHIVED);
  assert.equal(archivedSnap.closed, true);

  const page = await adapter.incremental(SESSION_A, { uuid: "agy:1", timestamp: Date.parse("2026-11-26T06:09:10Z") });
  assert.equal(page.closed, false);
  assert.equal(page.events.length, 2);
  assert.equal(page.events[0].text, "接力委托");
  assert.equal(page.events[1].text, "接力回复完成");

  const snap = await adapter.snapshot(SESSION_A, { uuid: "agy:1", timestamp: Date.parse("2026-11-26T06:09:10Z") });
  assert.deepEqual(snap.finished_turn, { result: "completed", external_ref: "agy:3" });

  const progress = await adapter.messageProgress(SESSION_A, {
    message_id: "m1",
    content: "接力委托",
    external_ref: "agy-after:1",
    created_at: Date.parse("2026-11-26T06:10:00Z") + 400,
  });
  assert.equal(progress.status, "completed");
  assert.equal(progress.reply, "接力回复完成");

  // 离线 CLI 会话在外部接力（visibleOnly）模式下拒绝静默后台恢复。
  const rejectedCli = await adapter.sendMessage(SESSION_B, "外部接力", { visibleOnly: true });
  assert.equal(rejectedCli.status, "rejected");
});

test("AgyBridge 端到端：Sidecar 长轮询、桌面会话发送、归档拒绝与派发后超时转 unknown", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-agy-bridge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const appDir = join(root, ".gemini", "antigravity");
  createSummariesDb(appDir, [{ id: SESSION_A, title: "在线桌面会话" }]);
  writeTranscript(appDir, SESSION_A, [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T06:00:00Z", content: "<USER_REQUEST>你好</USER_REQUEST>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T06:00:02Z", content: "已就绪" },
  ]);

  const tokenFile = join(root, "bridge-token");
  writeFileSync(tokenFile, "secret-bridge-token\n");

  const agyBridge = createAgyBridgeService({ requestTimeoutMs: 200 });
  const routes = createAgyBridgeRoutes({
    agyBridge,
    credentials: { verify: (tok) => tok === "secret-bridge-token" },
    pollWaitMs: 500,
  });

  // 模拟本机 DSH Relay HTTP + Antigravity LanguageServer HTTP。
  let lsArchived = false;
  const agentapiCalls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url?.startsWith("/product.v1.ConversationService/")) {
      assert.equal(req.headers["x-antigravity-csrf-token"], "csrf-123");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          conversation: {
            id: SESSION_A,
            annotations: { title: "在线桌面会话", archived: lsArchived },
            state: { runState: "RUN_STATE_IDLE", updateTime: "2026-11-26T06:05:00Z" },
          },
        }),
      );
      return;
    }
    const handler = routes[req.url];
    const response = await handler(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: raw,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const sidecar = startAgyBridgeClient({
    env: {
      DSH_AGENT_RELAY_PORT: String(port),
      AGENT_RELAY_AGY_TOKEN_FILE: tokenFile,
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
      ANTIGRAVITY_CSRF_TOKEN: "csrf-123",
      ANTIGRAVITY_AGENTAPI_EXE: "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
    },
    runAgentApi: async (exe, args) => {
      agentapiCalls.push({ exe, args });
      return { code: 0, stdout: '{"response":{"sendMessage":{}}}', stderr: "", timedOut: false };
    },
    log: () => {},
  });

  t.after(async () => {
    sidecar.stop();
    agyBridge.dispose();
    await new Promise((r) => server.close(r));
  });

  for (let i = 0; i < 30 && !agyBridge.isOnline(); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(agyBridge.isOnline(), true);

  const adapter = createAgyAdapter({ homeDir: root, env: {}, bridge: agyBridge });
  const snap = await adapter.snapshot(SESSION_A);
  assert.equal(snap.runtime, "idle");
  assert.equal(snap.send_allowed, true);
  assert.equal(snap.status_context?.runtime_source, "agy_bridge");

  const sent = await adapter.sendMessage(SESSION_A, "来自外部 Agent 的消息", { visibleOnly: true });
  assert.deepEqual(sent, { status: "sent", external_ref: "agy-after:1" });
  assert.equal(agentapiCalls.length, 1);
  assert.deepEqual(agentapiCalls[0].args, ["agentapi", "send-message", SESSION_A, "来自外部 Agent 的消息"]);

  lsArchived = true;
  const rejected = await adapter.sendMessage(SESSION_A, "归档后发送", { visibleOnly: true });
  assert.equal(rejected.status, "rejected");

  // 验证派发后 Sidecar 未回执时标记为 unknown，防止盲目重发。
  const isolatedBridge = createAgyBridgeService({ requestTimeoutMs: 60 });
  void isolatedBridge.poll({ pid: 9999, app_data_dir: "antigravity", version: "1.0" }, 500);
  const timeoutOutcome = await isolatedBridge.sendMessage(SESSION_A, "超时消息");
  assert.equal(timeoutOutcome.status, "unknown");
  isolatedBridge.dispose();
});
