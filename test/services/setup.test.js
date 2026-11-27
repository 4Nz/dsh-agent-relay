import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createSetupService, ruleText, shellBlock } from "../../lib/services/setup.js";
import { createChannelCredentialService, createNotificationCredentialService } from "../../lib/services/credentials.js";

const SKILL = "---\nname: dsh-notify\n---\n# 通知技能\n";

function fixture(t, { version = "2.1.311", flag = true, agents = [], registrations = [], shell = "/bin/zsh", codexVersion = "0.163.0", agyVersion = "1.1.14", agyRegistrations = [], platform = process.platform, existsFile } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-setup-"));
  const home = join(root, "home");
  mkdirSync(home);
  const skillsDir = join(root, "skills");
  mkdirSync(join(skillsDir, "dsh-notify"), { recursive: true });
  writeFileSync(join(skillsDir, "dsh-notify", "SKILL.md"), SKILL);
  writeFileSync(join(skillsDir, "dsh-notify", "send.mjs"), "// sender v1\n");
  for (const file of ['SKILL.md', 'references/contract.md', 'scripts/install.mjs', 'scripts/register.mjs']) {
    const target = join(skillsDir, 'create-agent-notify', file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `creator ${file} v1`);
  }
  const channelEntry = join(root, "lib", "channel", "main.js");
  mkdirSync(join(root, "lib", "channel"), { recursive: true });
  writeFileSync(channelEntry, "");
  const agySidecarEntry = join(root, "lib", "agy-bridge", "main.js");
  mkdirSync(join(root, "lib", "agy-bridge"), { recursive: true });
  writeFileSync(agySidecarEntry, "");
  const dataDir = join(root, "data");
  const claudeJson = join(home, ".claude.json");
  const calls = [];
  const codexCalls = [];
  const agyCalls = [];
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
  const agyRunner = async (args) => {
    agyCalls.push(args);
    if (agyVersion === null) throw new Error("spawn agy ENOENT");
    if (args[0] === "--version") return { code: 0, stdout: `${agyVersion}\n`, stderr: "", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const service = createSetupService({
    run,
    codexRunner,
    agyRunner,
    agyBridge: { registrations: () => agyRegistrations },
    agyBridgeCredentials: createChannelCredentialService({ dataDir, name: "agy-bridge-credential.json" }),
    channel: { registrations: () => registrations, probe: async () => ({ status: "not_registered" }) },
    listAgents: async () => agents,
    channelCredentials: createChannelCredentialService({ dataDir }),
    notificationCredentials: createNotificationCredentialService({
      file: join(dataDir, "notification-client.json"),
      endpoint: "http://127.0.0.1:37421/api/agent-relay/notifications",
    }),
    homeDir: home,
    env: { SHELL: shell },
    platform,
    existsFile,
    nodePath: "/usr/local/bin/node",
    channelEntry,
    agySidecarEntry,
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
  return { service, home, files, calls, codexCalls, agyCalls, logs, channelEntry, agySidecarEntry, skillsDir };
}
const byKey = (report) => Object.fromEntries(report.items.map((i) => [i.key, i]));

for (const agent of ['claude', 'codex']) {
  test(`${agent} 接力 Skill 按勾选安装，未选择不安装、不删除、不阻塞就绪`, async t => {
    const { service, home, skillsDir } = fixture(t);
    for (const name of ['claude-notify', 'codex-notify']) {
      mkdirSync(join(skillsDir, name));
      writeFileSync(join(skillsDir, name, 'agent-notify.json'), JSON.stringify({format:1,name,label:name,target_agent:name.replace('-notify',''),status:'ready',files:['SKILL.md','send.mjs','directory.mjs','start.mjs',...(name==='claude-notify'?['open.mjs']:[])]}));
      writeFileSync(join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\n---\n接力`);
      writeFileSync(join(skillsDir, name, 'send.mjs'), '// sender');
      writeFileSync(join(skillsDir, name, 'directory.mjs'), '// directory');
      writeFileSync(join(skillsDir, name, 'start.mjs'), '// background starter');
      if (name === 'claude-notify') writeFileSync(join(skillsDir, name, 'open.mjs'), '// visible launcher');
    }
    const target = name => join(home, `.${agent}`, 'skills', name);
    await service.install(agent);
    assert.equal(existsSync(target('claude-notify')), false);
    const installed = await service.install(agent, ['claude-notify']);
    assert.equal(byKey(installed)['claude-notify'].status, 'ok');
    assert.equal(readFileSync(join(target('claude-notify'), 'send.mjs'), 'utf8'), '// sender');
    assert.equal(readFileSync(join(target('claude-notify'), 'open.mjs'), 'utf8'), '// visible launcher');
    assert.equal(readFileSync(join(target('claude-notify'), 'directory.mjs'), 'utf8'), '// directory');
    assert.equal(readFileSync(join(target('claude-notify'), 'start.mjs'), 'utf8'), '// background starter');
    assert.equal(existsSync(target('codex-notify')), false);
    // 旧版受管理安装缺少新脚本时可升级，不能误报为用户冲突。
    const manifestPath = join(target('claude-notify'), '.agent-relay-skill.json');
    const oldManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    oldManifest.skill = oldManifest.files['SKILL.md']; oldManifest.sender = oldManifest.files['send.mjs']; oldManifest.starter = oldManifest.files['start.mjs'];
    delete oldManifest.files;
    delete oldManifest.launcher; delete oldManifest.directory;
    rmSync(join(target('claude-notify'), 'agent-notify.json'));
    writeFileSync(manifestPath, JSON.stringify(oldManifest));
    rmSync(join(target('claude-notify'), 'open.mjs'));
    rmSync(join(target('claude-notify'), 'directory.mjs'));
    const migrated = await service.install(agent, ['claude-notify']);
    assert.equal(byKey(migrated)['claude-notify'].status, 'ok');
    assert.equal(readFileSync(join(target('claude-notify'), 'directory.mjs'), 'utf8'), '// directory');
    const codex = await service.install(agent, ['codex-notify']);
    assert.equal(byKey(codex)['codex-notify'].status, 'ok');
    writeFileSync(join(target('codex-notify'), 'directory.mjs'), '// 用户自定义目录策略');
    assert.equal(byKey(await service.install(agent, ['codex-notify']))['codex-notify'].status, 'conflict');
    assert.equal(readFileSync(join(target('codex-notify'), 'directory.mjs'), 'utf8'), '// 用户自定义目录策略');
    writeFileSync(join(skillsDir, 'claude-notify', 'send.mjs'), '// sender v2');
    const upgraded = await service.install(agent, ['claude-notify']);
    assert.equal(byKey(upgraded)['claude-notify'].action, 'updated');
    assert.equal(readFileSync(join(target('claude-notify'), 'send.mjs'), 'utf8'), '// sender v2');
    assert.ok(readdirSync(target('claude-notify')).some(name => name.startsWith('send.mjs.agent-relay-')));
    writeFileSync(join(target('claude-notify'), 'send.mjs'), '// 用户修改');
    const conflict = await service.install(agent, ['claude-notify']);
    assert.equal(byKey(conflict)['claude-notify'].status, 'conflict');
    assert.equal(readFileSync(join(target('claude-notify'), 'send.mjs'), 'utf8'), '// 用户修改');
    await service.install(agent, []);
    assert.equal(existsSync(target('claude-notify')), true);
    await service.requireReady(agent);
    await assert.rejects(service.install(agent, ['../../outside']), /Skill/);
  });
}

for (const agent of ["claude", "codex"]) {
  for (const file of ["SKILL.md", "send.mjs"]) {
    test(`${agent} 随包 ${file} 缺失时不得把已有安装判为就绪`, async (t) => {
      const { service, home, skillsDir } = fixture(t);
      await service.install(agent);
      const target = join(home, `.${agent}`, "skills", "dsh-notify", file);
      const original = readFileSync(target, "utf8");
      rmSync(join(skillsDir, "dsh-notify", file));
      const check = await service.check(agent);
      assert.equal(byKey(check).skill.status, "unavailable");
      assert.match(byKey(check).skill.message, /重新构建.*重启/);
      const result = await service.install(agent);
      assert.equal(result.overall, "needs_action");
      assert.equal(byKey(result).skill.action, "none");
      assert.equal(readFileSync(target, "utf8"), original);
    });
  }
  test(`${agent} 旧名称安装不能代替新版，修复须写入新版完整文件`, async (t) => {
    const { service, home } = fixture(t);
    const old = join(home, `.${agent}`, "skills", "external-agent-notification");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "SKILL.md"), "用户保留的旧版");
    const target = join(home, `.${agent}`, "skills", "dsh-notify");
    assert.equal(byKey(await service.check(agent)).skill.status, "missing");
    assert.equal(existsSync(target), false, "检查不得写入文件");
    assert.equal(byKey(await service.install(agent)).skill.action, "installed");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), SKILL);
    assert.equal(readFileSync(join(target, "send.mjs"), "utf8"), "// sender v1\n");
    assert.equal(readFileSync(join(old, "SKILL.md"), "utf8"), "用户保留的旧版");
    assert.equal(byKey(await service.check(agent)).skill.status, "ok");
  });
}

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
  assert.ok(again.next_steps.some((s) => /新开终端.*source/.test(s)));
});

test("自检说明配置文件不等于旧终端已加载，恢复会话前仍需加载函数", async (t) => {
  const { service, files } = fixture(t);
  await service.install("claude");
  const report = await service.check("claude");
  assert.match(byKey(report).shell.message, /不代表.*终端.*加载/);
  assert.ok(report.next_steps.some((s) => s.includes(files.zshrc) && /source/.test(s) && /仅退出 Claude/.test(s)));
});

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  test(`${shell} 加载包装函数后为交互与 resume 追加 channel，保留原参数和管理命令`, {
    skip: process.platform === "win32" || !existsSync(shell),
  }, (t) => {
    const root = mkdtempSync(join(tmpdir(), "relay-shell-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    const capture = join(root, "capture.mjs");
    const rc = join(root, "shell config's rc");
    writeFileSync(capture, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(join(root, "claude"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(capture)} "$@"\n`, { mode: 0o755 });
    writeFileSync(rc, shellBlock());
    const result = spawnSync(shell, [...(shell.endsWith("bash") ? ["--noprofile", "--norc"] : ["-f"]), "-c", `
claude --resume old-session
source "$1"
claude
claude --resume old-session
claude --continue
claude '带 空格的提示词' --model sonnet
claude agents --json
claude mcp list
claude --version
claude -p '带 空格的提示词'
`, "relay-test", rc], { env: { ...process.env, PATH: root }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const channel = ["--dangerously-load-development-channels", "server:agent-relay"];
    assert.deepEqual(result.stdout.trim().split("\n").map((line) => JSON.parse(line)), [
      ["--resume", "old-session"],
      channel,
      [...channel, "--resume", "old-session"],
      [...channel, "--continue"],
      [...channel, "带 空格的提示词", "--model", "sonnet"],
      ["agents", "--json"], ["mcp", "list"], ["--version"], ["-p", "带 空格的提示词"],
    ]);
  });
}

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

test("列出未发现在线登记的运行中会话，提示加载配置后重新进入", async (t) => {
  const { service } = fixture(t, {
    agents: [{ pid: 1, sessionId: "on", status: "idle" }, { pid: 2, sessionId: "off", status: "busy" }],
    registrations: [{ pid: 1, initial_session_id: "on", version: null, registered_at: 1, last_seen: 1 }],
  });
  const report = await service.install("claude");
  assert.deepEqual(report.sessions, { online: 1, need_restart: ["off"] });
  assert.ok(report.next_steps.some((s) => s.includes("off") && /--resume/.test(s)));
  assert.ok(report.next_steps.some((s) => /未发现在线.*登记.*新开终端/.test(s)));
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
  assert.deepEqual(report.items.map((i) => i.key), ["codex", "notification", "skill", "create-agent-notify"]);
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
  assert.equal(readFileSync(join(home, ".codex", "skills", "dsh-notify", "SKILL.md"), "utf8"), SKILL);
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
  assert.equal(existsSync(join(home, ".codex", "skills", "dsh-notify", "SKILL.md")), false);
});

test("Codex 只有说明文件时识别缺失发送器，脚本更新后自检通过", async(t) => {
  const {service,home,skillsDir}=fixture(t);
  writeFileSync(join(skillsDir,'dsh-notify','send.mjs'),'// sender v1\n');
  const target=join(home,'.codex','skills','dsh-notify');
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

for (const agent of ['claude', 'codex']) {
  test(`${agent} 创建接入 Skill 默认必装，完整升级且不覆盖人工修改`, async t => {
    const {service, home, skillsDir} = fixture(t);
    const dir = join(home, `.${agent}`, 'skills', 'create-agent-notify');
    assert.equal(byKey(await service.check(agent))['create-agent-notify'].status, 'missing');
    await assert.rejects(service.requireReady(agent), /前置安装/);
    const installed = await service.install(agent);
    assert.equal(byKey(installed)['create-agent-notify'].action, 'installed');
    for (const file of ['SKILL.md', 'references/contract.md', 'scripts/install.mjs', 'scripts/register.mjs'])
      assert.equal(readFileSync(join(dir,file),'utf8'), readFileSync(join(skillsDir,'create-agent-notify',file),'utf8'));
    assert.equal(byKey(await service.install(agent))['create-agent-notify'].action, 'skipped');
    writeFileSync(join(skillsDir,'create-agent-notify','references/contract.md'), 'contract v2');
    assert.equal(byKey(await service.check(agent))['create-agent-notify'].status, 'outdated');
    const updated = byKey(await service.install(agent))['create-agent-notify'];
    assert.equal(updated.action,'updated');assert.ok(updated.backup);
    writeFileSync(join(dir,'scripts/install.mjs'),'用户修改');
    assert.equal(byKey(await service.install(agent))['create-agent-notify'].status,'conflict');
    assert.equal(readFileSync(join(dir,'scripts/install.mjs'),'utf8'),'用户修改');
    rmSync(join(skillsDir,'create-agent-notify','SKILL.md'));
    assert.equal(byKey(await service.check(agent))['create-agent-notify'].status,'unavailable');
  });
}

test('选装项由登记动态发现，待接入不可安装，新增文件列表参与自检和升级', async t => {
 const {service,home,skillsDir}=fixture(t);
 const dir=join(skillsDir,'demo-notify');mkdirSync(dir);
 const manifest={format:1,name:'demo-notify',label:'演示接力',target_agent:'future',status:'pending',files:['SKILL.md','send.mjs','extra.mjs']};
 for(const file of manifest.files)writeFileSync(join(dir,file),'v1');
 const register=()=>writeFileSync(join(dir,'agent-notify.json'),JSON.stringify(manifest));register();
 let report=await service.check('codex');
 assert.equal(report.optional_skills.find(x=>x.name==='demo-notify').available,false);
 await assert.rejects(service.install('codex',['demo-notify']),/待接入/);
 assert.equal(existsSync(join(home,'.codex','skills','demo-notify')),false);
 manifest.status='ready';register();
 await assert.rejects(service.install('codex',['demo-notify']),/待接入/);
 manifest.target_agent='codex';register();
 report=await service.install('codex',['demo-notify']);
 assert.equal(byKey(report)['demo-notify'].status,'ok');
 assert.equal(readFileSync(join(home,'.codex','skills','demo-notify','extra.mjs'),'utf8'),'v1');
 writeFileSync(join(dir,'extra.mjs'),'v2');
 assert.equal(byKey(await service.check('codex',['demo-notify']))['demo-notify'].status,'outdated');
 await service.install('codex',['demo-notify']);
 assert.equal(readFileSync(join(home,'.codex','skills','demo-notify','extra.mjs'),'utf8'),'v2');
 manifest.files.push('../secret.json');register();
 assert.equal((await service.check('codex')).optional_skills.find(x=>x.name==='demo-notify').available,false);
});

for (const platform of ['darwin', 'win32']) {
  test(`Antigravity (${platform}) 前置安装写入全局 .gemini/config/skills 与 Sidecar 桥接，升级备份且不覆盖人工修改`, async t => {
    const { service, home, skillsDir, agySidecarEntry } = fixture(t, { platform });
    for (const name of ['claude-notify', 'codex-notify', 'agy-notify']) {
      mkdirSync(join(skillsDir, name));
      writeFileSync(join(skillsDir, name, 'agent-notify.json'), JSON.stringify({
        format: 1,
        name,
        label: name,
        target_agent: name.replace('-notify', ''),
        status: 'ready',
        files: ['SKILL.md', 'send.mjs', 'directory.mjs', 'start.mjs'],
      }));
      for (const f of ['SKILL.md', 'send.mjs', 'directory.mjs', 'start.mjs']) {
        writeFileSync(join(skillsDir, name, f), `// ${name} ${f}`);
      }
    }

    const checkBefore = await service.check('agy');
    assert.equal(checkBefore.overall, 'needs_action');
    assert.equal(byKey(checkBefore).agy.status, 'ok');
    assert.equal(byKey(checkBefore).agy_sidecar_server.status, 'ok');
    assert.equal(byKey(checkBefore).skill.status, 'missing');
    assert.equal(byKey(checkBefore)['create-agent-notify'].status, 'missing');
    assert.equal(byKey(checkBefore).agy_sidecar.status, 'missing');
    assert.equal(byKey(checkBefore).agy_credential.status, 'missing');

    await assert.rejects(service.requireReady('agy'), /前置安装/);

    const installed = await service.install('agy', ['agy-notify', 'codex-notify']);
    assert.equal(installed.overall, 'changed');
    assert.equal(byKey(installed).skill.status, 'ok');
    assert.equal(byKey(installed)['create-agent-notify'].status, 'ok');
    assert.equal(byKey(installed).agy_sidecar.status, 'ok');
    assert.equal(byKey(installed).agy_credential.status, 'ok');
    assert.equal(byKey(installed)['agy-notify'].status, 'ok');
    assert.equal(byKey(installed)['codex-notify'].status, 'ok');

    const geminiSkills = join(home, '.gemini', 'config', 'skills');
    assert.equal(existsSync(join(geminiSkills, 'dsh-notify', 'SKILL.md')), true);
    assert.equal(existsSync(join(geminiSkills, 'create-agent-notify', 'SKILL.md')), true);
    assert.equal(existsSync(join(geminiSkills, 'agy-notify', 'start.mjs')), true);
    assert.equal(existsSync(join(geminiSkills, 'codex-notify', 'send.mjs')), true);
    assert.equal(existsSync(join(geminiSkills, 'claude-notify')), false);

    const sidecarPath = join(home, '.gemini', 'config', 'sidecars', 'dsh-agent-relay', 'sidecar.json');
    const tokenPath = join(home, '.gemini', 'config', 'dsh-agent-relay', 'bridge-token');
    const sidecarJson = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.equal(sidecarJson.display_name, 'DSH Agent Relay Bridge');
    assert.deepEqual(sidecarJson.args, [agySidecarEntry]);
    assert.equal(existsSync(tokenPath), true);

    await service.requireReady('agy');

    // 插件入口变化时判为 outdated，自动备份并升级
    sidecarJson.args = ['/old/agy-bridge/main.js'];
    writeFileSync(sidecarPath, JSON.stringify(sidecarJson, null, 2));
    assert.equal(byKey(await service.check('agy')).agy_sidecar.status, 'outdated');
    const repaired = await service.install('agy');
    assert.equal(byKey(repaired).agy_sidecar.action, 'updated');
    assert.ok(byKey(repaired).agy_sidecar.backup);

    // 用户自建同名非 Relay Sidecar 时判为 conflict，不覆盖
    writeFileSync(sidecarPath, JSON.stringify({ display_name: 'custom-user-sidecar', command: 'python3', args: ['s.py'] }));
    assert.equal(byKey(await service.check('agy')).agy_sidecar.status, 'conflict');
    const conflictRun = await service.install('agy');
    assert.equal(byKey(conflictRun).agy_sidecar.status, 'conflict');
    assert.equal(JSON.parse(readFileSync(sidecarPath, 'utf8')).display_name, 'custom-user-sidecar');
  });
}

test('Antigravity 未装 CLI 但存在桌面版 language_server 时可用，均缺失时阻断 Sidecar 写入', async t => {
  const desktopOnly = fixture(t, {
    agyVersion: null,
    platform: 'win32',
    existsFile: (p) => p.endsWith('language_server.exe'),
  });
  const okCheck = await desktopOnly.service.check('agy');
  assert.equal(byKey(okCheck).agy.status, 'ok');
  assert.equal(okCheck.version, null);
  assert.match(byKey(okCheck).agy.message, /桌面端/);

  const missingBoth = fixture(t, {
    agyVersion: null,
    platform: 'darwin',
    existsFile: () => false,
  });
  const badCheck = await missingBoth.service.check('agy');
  assert.equal(byKey(badCheck).agy.status, 'unavailable');
  assert.equal('agy_sidecar' in byKey(badCheck), false);
});


test("后台会话沙箱仅在勾选时写入，保留现有字段和权限，按检查版本防止覆盖", async t => {
  const { service, home } = fixture(t);
  const dir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  const original = '{"colorScheme":"dark","custom":{"enabled":true}}\n';
  writeFileSync(path, original, { mode: 0o600 });
  const checked = await service.check("agy");
  assert.equal(checked.agy_sandbox.status, "missing");
  await service.install("agy");
  assert.equal(readFileSync(path, "utf8"), original);
  await service.requireReady("agy");
  writeFileSync(path, original + " ");
  const conflict = await service.install("agy", [], true, checked.agy_sandbox.revision);
  assert.equal(conflict.overall, "needs_action");
  assert.equal(conflict.agy_sandbox.status, "conflict");
  const enabled = (await service.install("agy", [], true)).agy_sandbox;
  assert.equal(enabled.action, "updated");
  assert.equal(readFileSync(enabled.backup, "utf8"), original + " ");
  assert.deepEqual(JSON.parse(readFileSync(path)), {
    ...JSON.parse(original), enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox",
  });
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  const files = readdirSync(dir);
  assert.equal((await service.install("agy", [], true)).agy_sandbox.status, "ok");
  assert.deepEqual(readdirSync(dir), files);
  writeFileSync(path, "broken");
  assert.equal((await service.install("agy", [], true)).agy_sandbox.status, "conflict");
  assert.equal(readFileSync(path, "utf8"), "broken");
});

test("勾选 agy-notify 的发送方可以配置新会话沙箱", async t => {
  const { service, skillsDir } = fixture(t);
  const { cpSync } = await import("node:fs");
  cpSync(new URL("../../skills/agy-notify", import.meta.url), join(skillsDir, "agy-notify"), { recursive: true });
  for (const agent of ["claude", "codex"]) {
    assert.equal((await service.check(agent)).agy_sandbox, undefined);
    await assert.rejects(service.install(agent, [], true), /agy-notify/);
    assert.equal((await service.install(agent, ["agy-notify"], true)).agy_sandbox.status, "ok");
  }
});

test("没有 agy CLI 时选择沙箱不会创建配置", async t => {
  const { service, home } = fixture(t, { agyVersion: null });
  const result = await service.install("agy", [], true);
  assert.equal(result.agy_sandbox.status, "unavailable");
  assert.equal(existsSync(join(home, ".gemini", "antigravity-cli", "settings.json")), false);
});

test("选装与必装 Skill 部分文件已匹配新插件包但清单滞后时按 outdated 补齐，仍保护真正的人工修改", async t => {
  const { service, home, skillsDir } = fixture(t);
  const srcDir = join(skillsDir, "demo-notify");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "agent-notify.json"),
    JSON.stringify({
      format: 1,
      name: "demo-notify",
      label: "演示接力",
      target_agent: "codex",
      status: "ready",
      files: ["SKILL.md", "send.mjs", "open.mjs"],
    }),
  );
  for (const f of ["SKILL.md", "send.mjs", "open.mjs"]) writeFileSync(join(srcDir, f), `${f}-v1`);

  // 先正常安装 v1（写入 .agent-relay-skill.json 与 .create-agent-notify-install.json）
  const first = await service.install("codex", ["demo-notify"]);
  assert.equal(byKey(first)["demo-notify"].status, "ok");
  assert.equal(byKey(first)["create-agent-notify"].status, "ok");

  // 插件包升级到 v2，但目标目录中只有部分文件已提前同步为 v2，其余仍为受管理的 v1，清单仍是 v1
  for (const f of ["SKILL.md", "send.mjs", "open.mjs"]) writeFileSync(join(srcDir, f), `${f}-v2`);
  const targetDir = join(home, ".codex", "skills", "demo-notify");
  writeFileSync(join(targetDir, "SKILL.md"), "SKILL.md-v2");
  writeFileSync(join(targetDir, "send.mjs"), "send.mjs-v2");
  // open.mjs 仍为 v1（匹配旧清单），不应误报 conflict
  assert.equal(byKey(await service.check("codex", ["demo-notify"]))["demo-notify"].status, "outdated");
  const repaired = await service.install("codex", ["demo-notify"]);
  assert.equal(byKey(repaired)["demo-notify"].status, "ok");
  assert.equal(byKey(repaired)["demo-notify"].action, "updated");
  assert.equal(readFileSync(join(targetDir, "open.mjs"), "utf8"), "open.mjs-v2");

  // 必装 create-agent-notify 同理：部分文件已匹配 v2、其余仍匹配旧清单时按 outdated 补齐
  const creatorSrc = join(skillsDir, "create-agent-notify");
  const creatorDst = join(home, ".codex", "skills", "create-agent-notify");
  writeFileSync(join(creatorSrc, "SKILL.md"), "creator-skill-v2");
  writeFileSync(join(creatorSrc, "references/contract.md"), "creator-contract-v2");
  writeFileSync(join(creatorDst, "SKILL.md"), "creator-skill-v2");
  assert.equal(byKey(await service.check("codex"))["create-agent-notify"].status, "outdated");
  const repairedCreator = await service.install("codex");
  assert.equal(byKey(repairedCreator)["create-agent-notify"].status, "ok");
  assert.equal(readFileSync(join(creatorDst, "references/contract.md"), "utf8"), "creator-contract-v2");

  // 真正的人工修改（既不等于新插件包也不等于旧清单）依然报 conflict 且不覆盖
  writeFileSync(join(targetDir, "open.mjs"), "用户手工改动");
  assert.equal(byKey(await service.check("codex", ["demo-notify"]))["demo-notify"].status, "conflict");
  await service.install("codex", ["demo-notify"]);
  assert.equal(readFileSync(join(targetDir, "open.mjs"), "utf8"), "用户手工改动");
});
