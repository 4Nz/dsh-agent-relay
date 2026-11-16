import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupService, ruleText, shellBlock } from "../../lib/services/setup.js";
import { createChannelCredentialService, createNotificationCredentialService } from "../../lib/services/credentials.js";

const SKILL = "---\nname: external-agent-notification\n---\n# 通知技能\n";

function fixture(t, { version = "2.1.311", flag = true, agents = [], registrations = [], shell = "/bin/zsh", codexVersion = "0.163.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-setup-"));
  const home = join(root, "home");
  mkdirSync(home);
  const skillsDir = join(root, "skills");
  mkdirSync(join(skillsDir, "external-agent-notification"), { recursive: true });
  writeFileSync(join(skillsDir, "external-agent-notification", "SKILL.md"), SKILL);
  const channelEntry = join(root, "lib", "channel", "main.js");
  mkdirSync(join(root, "lib", "channel"), { recursive: true });
  writeFileSync(channelEntry, "");
  const dataDir = join(root, "data");
  const claudeJson = join(home, ".claude.json");
  const calls = [];
  const codexCalls = [];
  const logs = [];
  const run = async (args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
    if (version === null) throw new Error("spawn claude ENOENT");
    if (args[0] === "--version") return ok(`${version} (Claude Code)\n`);
    if (args[0] === "--dangerously-load-development-channels")
      return flag
        ? { code: 1, stdout: "", stderr: "error: option '--dangerously-load-development-channels <servers...>' argument missing", timedOut: false }
        : { code: 1, stdout: "", stderr: "error: unknown option '--dangerously-load-development-channels'", timedOut: false };
    if (args[0] === "mcp") {
      const config = existsSync(claudeJson) ? JSON.parse(readFileSync(claudeJson, "utf8")) : {};
      config.mcpServers ??= {};
      if (args[1] === "add-json") config.mcpServers[args[4]] = JSON.parse(args[5]);
      if (args[1] === "remove") delete config.mcpServers[args[2]];
      writeFileSync(claudeJson, JSON.stringify(config));
      return ok("done");
    }
    return ok();
  };
  const codexRunner = async (args) => {
    codexCalls.push(args);
    if (codexVersion === null) throw new Error("spawn codex ENOENT");
    if (args[0] === "--version") return { code: 0, stdout: `${codexVersion}\n`, stderr: "", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const service = createSetupService({
    run,
    codexRunner,
    channel: { registrations: () => registrations, probe: async () => ({ status: "not_registered" }) },
    listAgents: async () => agents,
    channelCredentials: createChannelCredentialService({ dataDir }),
    notificationCredentials: createNotificationCredentialService({
      file: join(dataDir, "notification-client.json"),
      endpoint: "http://127.0.0.1:37421/api/agent-relay/notifications",
    }),
    homeDir: home,
    env: { SHELL: shell },
    nodePath: "/usr/local/bin/node",
    channelEntry,
    skillsDir,
    now: (() => { let n = 1000; return () => ++n; })(),
    log: (x) => logs.push(x),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    claudeJson,
    rule: join(home, ".claude", "agent-relay.md"),
    claudeMd: join(home, ".claude", "CLAUDE.md"),
    zshrc: join(home, ".zshrc"),
    token: join(home, ".claude", "agent-relay", "channel-token"),
    notification: join(dataDir, "notification-client.json"),
  };
  return { service, home, files, calls, codexCalls, logs, channelEntry, skillsDir };
}
const byKey = (report) => Object.fromEntries(report.items.map((i) => [i.key, i]));

test("首次安装一次配好全部项，并提示新开终端与连通测试", async (t) => {
  const { service, files, channelEntry } = fixture(t);
  const before = await service.check("claude");
  assert.equal(before.overall, "needs_action");
  assert.equal(byKey(before).mcp.status, "missing");
  const report = await service.install("claude");
  assert.equal(report.overall, "changed");
  for (const item of report.items) assert.equal(item.status, "ok", `${item.key}: ${item.message}`);
  const mcp = JSON.parse(readFileSync(files.claudeJson, "utf8")).mcpServers["agent-relay"];
  assert.deepEqual(mcp, { command: "/usr/local/bin/node", args: [channelEntry] });
  assert.equal(readFileSync(files.rule, "utf8"), ruleText());
  assert.equal(readFileSync(files.claudeMd, "utf8"), "@agent-relay.md\n");
  assert.equal(readFileSync(files.zshrc, "utf8"), shellBlock());
  // Windows 不实现 POSIX 权限位；其余安装断言仍在所有平台执行。
  if (process.platform !== "win32") assert.equal(statSync(files.token).mode & 0o777, 0o600);
  assert.ok(report.next_steps.some((s) => /新开终端/.test(s)));
  assert.ok(report.next_steps.some((s) => /连通测试/.test(s)));
});

test("重复安装返回 ok，文件不变也不重复调用安装", async (t) => {
  const { service, files, calls } = fixture(t);
  await service.install("claude");
  const snapshot = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]));
  const addCalls = calls.filter((c) => c[1] === "add-json").length;
  const again = await service.install("claude");
  assert.equal(again.overall, "ok");
  assert.ok(again.items.every((i) => i.action === "skipped"));
  for (const [k, f] of Object.entries(files)) assert.equal(readFileSync(f, "utf8"), snapshot[k], k);
  assert.equal(calls.filter((c) => c[1] === "add-json").length, addCalls);
  assert.deepEqual(again.next_steps, []);
});

test("保留用户已有内容并在修改前备份", async (t) => {
  const { service, files, home } = fixture(t);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(files.claudeMd, "@RTK.md");
  writeFileSync(files.zshrc, "export PATH=/x:$PATH\n");
  const report = await service.install("claude");
  assert.equal(readFileSync(files.claudeMd, "utf8"), "@RTK.md\n\n@agent-relay.md\n");
  assert.equal(readFileSync(files.zshrc, "utf8"), `export PATH=/x:$PATH\n\n${shellBlock()}`);
  const md = byKey(report).claude_md;
  assert.ok(md.backup && readFileSync(md.backup, "utf8") === "@RTK.md");
});

test("旧版本内容识别为 outdated 并备份后更新", async (t) => {
  const { service, files } = fixture(t);
  await service.install("claude");
  writeFileSync(files.rule, "<!-- agent-relay-rule v0 -->\n旧规则\n");
  writeFileSync(files.zshrc, "alias ll=ls\n" + shellBlock().replace("agent-relay v1", "agent-relay v0").replace("claude()", "claude ()"));
  const check = byKey(await service.check("claude"));
  assert.equal(check.rule.status, "outdated");
  assert.equal(check.shell.status, "outdated");
  const report = byKey(await service.install("claude"));
  assert.equal(report.rule.action, "updated");
  assert.ok(readFileSync(report.rule.backup, "utf8").includes("旧规则"));
  assert.equal(readFileSync(files.zshrc, "utf8"), `alias ll=ls\n\n${shellBlock()}`);
});

test("重复标记、同名 MCP、非 Relay 写入的规则文件返回 conflict 且不覆盖", async (t) => {
  const { service, files, home } = fixture(t);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(files.claudeJson, JSON.stringify({ mcpServers: { "agent-relay": { command: "python3", args: ["other.py"] } } }));
  writeFileSync(files.rule, "用户自己的文件\n");
  writeFileSync(files.claudeMd, "@agent-relay.md\n@agent-relay.md\n");
  writeFileSync(files.zshrc, shellBlock() + shellBlock());
  const report = await service.install("claude");
  assert.equal(report.overall, "needs_action");
  const items = byKey(report);
  for (const key of ["mcp", "rule", "claude_md", "shell"]) {
    assert.equal(items[key].status, "conflict", key);
    assert.equal(items[key].action, "none", key);
  }
  assert.match(items.claude_md.message, /2 行/);
  assert.equal(readFileSync(files.rule, "utf8"), "用户自己的文件\n");
  assert.equal(JSON.parse(readFileSync(files.claudeJson, "utf8")).mcpServers["agent-relay"].command, "python3");
});

test("不支持 channel 时只提示版本，不做改动，原始输出写日志", async (t) => {
  const { service, files, logs } = fixture(t, { flag: false });
  const report = await service.install("claude");
  assert.equal(report.overall, "unavailable");
  const flag = byKey(report).channel_flag;
  assert.equal(flag.status, "unavailable");
  assert.equal(flag.message, "当前版本 Claude（2.1.311）不支持 channel");
  assert.equal(existsSync(files.rule), false);
  assert.equal(existsSync(files.zshrc), false);
  assert.ok(logs.some((x) => /unknown option/.test(x)));
});

test("找不到 claude 时返回 unavailable", async (t) => {
  const { service } = fixture(t, { version: null });
  const report = await service.check("claude");
  assert.equal(report.overall, "unavailable");
  assert.equal(byKey(report).claude.status, "unavailable");
});

test("不支持的 shell 只提示手动配置，其余项照常安装", async (t) => {
  const { service } = fixture(t, { shell: "/usr/bin/fish" });
  const report = await service.install("claude");
  assert.equal(byKey(report).shell.status, "unavailable");
  assert.equal(byKey(report).rule.status, "ok");
  assert.equal(report.overall, "needs_action");
});

test("列出未启用 channel 的运行中会话，提示退出后重新进入", async (t) => {
  const { service } = fixture(t, {
    agents: [{ pid: 1, sessionId: "on", status: "idle" }, { pid: 2, sessionId: "off", status: "busy" }],
    registrations: [{ pid: 1, initial_session_id: "on", version: null, registered_at: 1, last_seen: 1 }],
  });
  const report = await service.install("claude");
  assert.deepEqual(report.sessions, { online: 1, need_restart: ["off"] });
  assert.ok(report.next_steps.some((s) => s.includes("off") && /--resume/.test(s)));
});

test("卸载只删除 Relay 写入的内容，保留用户内容", async (t) => {
  const { service, files, home } = fixture(t);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(files.claudeMd, "@RTK.md\n");
  writeFileSync(files.zshrc, "export A=1\n");
  await service.install("claude");
  const report = await service.uninstall();
  assert.equal(report.overall, "changed");
  assert.equal(JSON.parse(readFileSync(files.claudeJson, "utf8")).mcpServers["agent-relay"], undefined);
  assert.equal(existsSync(files.rule), false);
  assert.equal(existsSync(files.token), false);
  assert.equal(readFileSync(files.claudeMd, "utf8").trim(), "@RTK.md");
  assert.equal(readFileSync(files.zshrc, "utf8"), "export A=1\n");
  assert.equal((await service.uninstall()).overall, "ok");
  assert.ok(readdirSync(home).some((n) => n.startsWith(".zshrc.agent-relay-")));
});

test("Codex 检查命令与通知 Skill，安装时直接写入 SKILL.md", async (t) => {
  const { service, calls, home, files } = fixture(t);
  const report = await service.check("codex");
  assert.deepEqual(report.items.map((i) => i.key), ["codex", "notification", "skill"]);
  assert.equal(byKey(report).codex.status, "ok");
  assert.equal(byKey(report).codex.message, "Codex 0.163.0");
  assert.equal(byKey(report).notification.status, "missing");
  assert.equal(byKey(report).skill.status, "missing");
  const installed = await service.install("codex");
  assert.equal(installed.overall, "changed");
  assert.equal(byKey(installed).codex.action, "skipped");
  assert.equal(byKey(installed).notification.status, "ok");
  assert.equal(byKey(installed).notification.action, "installed");
  assert.equal(byKey(installed).skill.status, "ok");
  assert.equal(byKey(installed).skill.action, "installed");
  assert.equal(readFileSync(join(home, ".codex", "skills", "external-agent-notification", "SKILL.md"), "utf8"), SKILL);
  assert.equal(existsSync(files.notification), true);
  assert.equal(calls.length, 0);
});

test("Codex 未安装时标记 unavailable，通知 Skill 不覆盖安装", async (t) => {
  const { service, home } = fixture(t, { codexVersion: null });
  const report = await service.check("codex");
  assert.equal(report.overall, "unavailable");
  assert.equal(byKey(report).codex.status, "unavailable");
  assert.match(byKey(report).codex.message, /安装 Codex/);
  const installed = await service.install("codex");
  assert.equal(installed.overall, "unavailable");
  assert.equal(byKey(installed).codex.action, "none");
  assert.equal(byKey(installed).skill.action, "none");
  assert.equal(existsSync(join(home, ".codex", "skills", "external-agent-notification", "SKILL.md")), false);
});

test("Codex 只有说明文件时识别缺失发送器，脚本更新后自检通过", async(t) => {
  const {service,home,skillsDir}=fixture(t);
  writeFileSync(join(skillsDir,'external-agent-notification','send.mjs'),'// sender v1\n');
  const target=join(home,'.codex','skills','external-agent-notification');
  mkdirSync(target,{recursive:true});
  writeFileSync(join(target,'SKILL.md'),SKILL);
  assert.equal(byKey(await service.check('codex')).skill.status,'outdated');
  writeFileSync(join(target,'send.mjs'),'// sender v1\n');
  assert.equal(byKey(await service.check('codex')).skill.status,'ok');
  writeFileSync(join(target,'send.mjs'),'// old sender\n');
  assert.equal(byKey(await service.check('codex')).skill.status,'outdated');
});

test("连通测试：未登记时失败并给出原因", async (t) => {
  const { service } = fixture(t);
  const started = service.probeStart();
  assert.equal(started.status, "waiting");
  assert.ok(started.instructions.length >= 2);
  assert.equal(service.probeStart().started_at, started.started_at, "进行中重复触发返回同一次测试");
  for (let i = 0; i < 50 && service.probeStatus().status === "waiting"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(service.probeStatus().status, "failed");
  assert.match(service.probeStatus().message, /没有新的 Claude 会话/);
});
