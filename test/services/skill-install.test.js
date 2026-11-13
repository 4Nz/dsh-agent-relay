import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillInstallService } from "../../lib/services/skill-install.js";

function fixture(t) {
  const skillsDir = mkdtempSync(join(tmpdir(), "relay-skill-src-"));
  mkdirSync(join(skillsDir, "external-agent-notification"));
  writeFileSync(join(skillsDir, "external-agent-notification", "SKILL.md"), "---\nname: external-agent-notification\n---\n# 通知技能\n");
  const homeDir = mkdtempSync(join(tmpdir(), "relay-skill-home-"));
  t.after(() => {
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });
  return { skillsDir, homeDir };
}

test("status：Claude 开发中不可用，Codex 依赖检测结果且未装不算 ready", async (t) => {
  const { skillsDir, homeDir } = fixture(t);
  const svc = createSkillInstallService({
    skillsDir, homeDir,
    detect: async (agent) => agent === "codex"
      ? { available: true, reason: null }
      : { available: false, reason: "Claude 安装流程开发中，暂不支持" },
  });
  const claude = await svc.status("claude");
  assert.equal(claude.available, false);
  assert.match(claude.reason, /开发中/);
  assert.equal(claude.ready, false);

  const codex = await svc.status("codex");
  assert.equal(codex.available, true);
  assert.equal(codex.skill_installed, false);
  assert.equal(codex.ready, false);
  assert.match(codex.reason, /尚未安装/);
  assert.equal(codex.skill_dir, join(homeDir, ".codex", "skills", "external-agent-notification", "SKILL.md"));
});

test("install：Codex 可用时写入 skill 文件并 ready", async (t) => {
  const { skillsDir, homeDir } = fixture(t);
  const svc = createSkillInstallService({ skillsDir, homeDir, detect: async () => ({ available: true, reason: null }) });
  const r = await svc.install("codex");
  assert.equal(r.ok, true);
  assert.equal(r.status.ready, true);
  assert.equal(r.status.skill_installed, true);
  assert.ok(existsSync(join(homeDir, ".codex", "skills", "external-agent-notification", "SKILL.md")));
});

test("install：Claude 不支持且不写文件", async (t) => {
  const { skillsDir, homeDir } = fixture(t);
  const svc = createSkillInstallService({ skillsDir, homeDir });
  const r = await svc.install("claude");
  assert.equal(r.ok, false);
  assert.match(r.reason, /开发中/);
  assert.equal(existsSync(join(homeDir, ".claude", "skills", "external-agent-notification", "SKILL.md")), false);
});

test("requireReady：未装抛错，装后放行，Claude 恒拒绝", async (t) => {
  const { skillsDir, homeDir } = fixture(t);
  const svc = createSkillInstallService({ skillsDir, homeDir, detect: async () => ({ available: true, reason: null }) });
  await assert.rejects(() => svc.requireReady("codex"), /前置安装未完成/);
  await svc.install("codex");
  await svc.requireReady("codex");
  await assert.rejects(() => svc.requireReady("claude"), /开发中/);
});
