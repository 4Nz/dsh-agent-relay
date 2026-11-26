import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTeamSettingsStore } from "../../lib/services/team-relay/settings.js";
import { createTeamRelayService } from "../../lib/services/team-relay/index.js";
import { createProviderRegistry } from "../../lib/providers/registry.js";
import { createTeamAgentInspector } from "../../lib/services/team-relay/agents.js";
import { createRelayService } from "../../lib/services/relay.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "team-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "settings.json");
  const service = () => createTeamRelayService({ providers: createProviderRegistry([]),
    sessionTargets: ["claude", "codex"], settingsStore: createTeamSettingsStore(file) });
  return { file, service };
}

test("类型修改和新增可重启恢复，DSH 工具与路由读到保存后的配置", t => {
  const { service } = fixture(t);
  const first = service();
  const settings = first.settings();
  settings.preset.routes[0].preferred = ["codex"];
  settings.preset.routes.push({ ...settings.preset.routes[0], id: "research", label: "专项调研", preferred: ["claude", "codex"], dispatch: "parallel" });
  first.saveSettings(settings.preset, settings.revision);
  const restored = service();
  assert.equal(restored.settings().revision, 1);
  assert.deepEqual(restored.resolve("search").selected, ["codex"]);
  assert.deepEqual(restored.resolve("research").selected, ["claude", "codex"]);
  assert.equal(restored.preset().routes.at(-1).label, "专项调研");
});

test("旧窗口保存被拒绝，非法 Agent 和删除兜底类型不覆盖文件", t => {
  const { service, file } = fixture(t);
  const first = service(), second = service();
  const stale = second.settings();
  first.saveSettings(first.preset(), 0);
  const expected = readFileSync(file, "utf8");
  assert.throws(() => second.saveSettings(stale.preset, 0), /其他窗口/);
  for (const id of ["workbuddy", "doubao", "invented-agent"]) {
    const preset = first.preset(); preset.routes[0].preferred = [id];
    assert.throws(() => first.saveSettings(preset, 1), /尚未接入/);
  }
  const preset = first.preset(); preset.routes = preset.routes.filter(item => item.id !== "other");
  assert.throws(() => first.saveSettings(preset, 1), /兜底/);
  assert.equal(readFileSync(file, "utf8"), expected);
});

test("并发上限由系统固定，旧配置和页面请求不能改变上限或丢失分工", async t => {
  const { service, file } = fixture(t);
  const legacy = service().settings();
  legacy.preset.max_parallel = 12;
  legacy.preset.routes[0].preferred = ["codex"];
  writeFileSync(file, JSON.stringify(legacy));
  const current = service();
  assert.equal(current.settings().preset.max_parallel, 4);
  assert.equal(current.preset().max_parallel, 4);
  assert.deepEqual(current.resolve("search").selected, ["codex"]);
  const request = current.settings();
  request.preset.max_parallel = 16;
  const result = await createRelayService({ teamRelay: current }).call("team_settings_save", request);
  assert.equal(result.ok, true);
  assert.equal(result.value.preset.max_parallel, 4);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.preset.max_parallel, 4);
  assert.deepEqual(stored.preset.routes[0].preferred, ["codex"]);
});

test("损坏配置不会静默重置，保存白名单不包含额外字段", t => {
  const { service, file } = fixture(t);
  const current = service();
  current.saveSettings({ ...current.preset(), unexpected: "private-value" }, 0);
  assert.ok(!readFileSync(file, "utf8").includes("private-value"));
  writeFileSync(file, "broken");
  assert.throws(() => current.settings(), /配置文件无效/);
  assert.throws(() => current.saveSettings({}, 1), /version/);
  assert.equal(readFileSync(file, "utf8"), "broken");
});

test("页面 RPC 使用同一配置服务并拒绝无效请求", async t => {
  const { service } = fixture(t);
  const relay = createRelayService({ teamRelay: service() });
  const result = await relay.call("team_settings", {});
  assert.equal(result.ok, true);
  assert.equal((await relay.call("team_settings_save", { ...result.value, preset: null })).error.code, "invalid_input");
  assert.equal((await relay.call("team_settings_save", result.value)).ok, true);
  assert.equal((await relay.call("team_settings_save", result.value)).error.code, "conflict");
});

test("Agent 检查仅探测 Claude 安装和 Codex 连接，不依赖 channel 或创建会话", async () => {
  const calls = []; let closed = false;
  const inspect = createTeamAgentInspector({
    runClaude: async args => { calls.push(args); return { code: 0, stdout: "Claude Code", stderr: "", timedOut: false }; },
    connectCodex: async () => ({ request: () => { throw new Error("不得发送任务"); }, close: () => { closed = true; } }),
  });
  const agents = await inspect();
  assert.deepEqual(calls, [["--version"]]); assert.equal(closed, true);
  assert.equal(agents.find(a => a.id === "codex").status, "connected");
  assert.equal(agents.find(a => a.id === "claude").status, "detected");
  assert.equal(agents.find(a => a.id === "doubao").selectable, false);
  assert.equal(agents.find(a => a.id === "workbuddy").selectable, false);
});

test("检测失败不会暴露执行器错误或冒充已就绪", async () => {
  const fail = async () => { throw new Error("secret-value"); };
  const agents = await createTeamAgentInspector({ runClaude: fail, connectCodex: fail })();
  assert.equal(agents.filter(a => a.status === "unavailable").length, 2);
  assert.ok(!JSON.stringify(agents).includes("secret-value"));
});

test("豆包接入状态与配置独立，内置 RPC 不接受任意操作", async t => {
  const { file } = fixture(t);
  const actions = [];
  const view = { state: "signed_out", message: "请登录豆包" };
  const doubao = Object.fromEntries(["status", "start", "check", "cancel", "logout"].map(action => [action, () => { actions.push(action); return view; }]));
  const service = createTeamRelayService({
    providers: createProviderRegistry([{ id: "doubao", capabilities: () => ({ execute: true, streaming: false, cancel: false, quota: false }), execute: async () => ({ status: "failed", error: "未登录" }) }]),
    settingsStore: createTeamSettingsStore(file), doubao,
  });
  const preset = service.preset(); preset.routes[0].preferred = ["doubao"];
  service.saveSettings(preset, 0);
  assert.deepEqual(service.resolve("search").selected, ["doubao"]);
  const relay = createRelayService({ teamRelay: service });
  for (const action of ["status", "login", "check", "cancel", "logout"]) {
    assert.deepEqual(await relay.call("team_doubao", { action }), { ok: true, value: view });
  }
  assert.deepEqual(actions, ["status", "start", "check", "cancel", "logout"]);
  for (const action of ["clearEverything", {}, null]) {
    assert.equal((await relay.call("team_doubao", { action })).error.code, "invalid_input");
  }
  assert.ok(!readFileSync(file, "utf8").includes("cookie"));
});
