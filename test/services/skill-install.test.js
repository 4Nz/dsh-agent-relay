import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillInstallService } from "../../lib/services/skill-install.js";
import { createAdapterRegistry } from "../../lib/adapters/registry.js";

function adapters(runCalls) {
  return createAdapterRegistry([
    {
      agent: "claude",
      capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: true, runPrompt: true }),
      listSessions: async () => [],
      snapshot: async () => ({}),
      sendMessage: async () => ({ status: "sent", external_ref: null }),
      runPrompt: async (text, options) => {
        runCalls.push([text, options]);
        return { status: "completed", output: "已安装" };
      },
    },
    {
      agent: "codex",
      capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: false, runPrompt: false }),
      listSessions: async () => [],
      snapshot: async () => ({}),
      sendMessage: async () => ({ status: "rejected", reason: "只读" }),
      runPrompt: async () => ({ status: "rejected", reason: "预留" }),
    },
  ]);
}

function fixture(t) {
  const skillsDir = mkdtempSync(join(tmpdir(), "relay-skill-src-"));
  mkdirSync(join(skillsDir, "external-agent-notification"));
  writeFileSync(join(skillsDir, "external-agent-notification", "SKILL.md"), "---\nname: external-agent-notification\n---\n# 通知技能\n");
  writeFileSync(join(skillsDir, "external-agent-notification", "send.mjs"), "// 通知发送器\n");
  const homeDir = mkdtempSync(join(tmpdir(), "relay-skill-home-"));
  t.after(() => {
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });
  return { skillsDir, homeDir };
}

test("预览读取技能内容并拼装安装提示词，目标目录按 Agent 区分", async (t) => {
  const { skillsDir, homeDir } = fixture(t);
  const runCalls = [];
  const service = createSkillInstallService({ adapters: adapters(runCalls), skillsDir, homeDir });
  const claude = await service.preview("claude");
  assert.equal(claude.supported, true);
  assert.equal(claude.skill, "external-agent-notification");
  assert.equal(claude.target_dir, join(homeDir, ".claude", "skills", "external-agent-notification"));
  assert.match(claude.prompt, /external-agent-notification/);
  assert.match(claude.prompt, /# 通知技能/);
  assert.match(claude.prompt, /SKILL\.md/);
  assert.match(claude.prompt, /send\.mjs/);
  assert.match(claude.prompt, /通知发送器/);
  const codex = await service.preview("codex");
  assert.equal(codex.supported, false);
  assert.match(codex.reason, /预留/);
  assert.equal(codex.target_dir, join(homeDir, ".codex", "skills", "external-agent-notification"));
});

test("安装调用 runPrompt，把技能目录作为 addDirs 传入", async (t) => {
  const { skillsDir, homeDir } = fixture(t);
  const runCalls = [];
  const service = createSkillInstallService({ adapters: adapters(runCalls), skillsDir, homeDir });
  const result = await service.install("claude");
  assert.equal(result.supported, true);
  assert.equal(result.result.status, "completed");
  assert.equal(runCalls.length, 1);
  assert.match(runCalls[0][0], /external-agent-notification/);
  assert.deepEqual(runCalls[0][1], { addDirs: [join(homeDir, ".claude", "skills")] });
});

test("Codex 安装返回不支持且不调用 runPrompt", async (t) => {
  const { skillsDir, homeDir } = fixture(t);
  const runCalls = [];
  const service = createSkillInstallService({ adapters: adapters(runCalls), skillsDir, homeDir });
  const result = await service.install("codex");
  assert.equal(result.supported, false);
  assert.match(result.reason, /预留/);
  assert.equal(runCalls.length, 0);
});
