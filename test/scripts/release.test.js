import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePackage } from "../../scripts/release.mjs";

const pkg = { name: "dsh-agent-relay", version: "0.1.0", exports: { ".": { import: "./lib/index.js", types: "./lib/index.d.ts" }, "./client": { default: "./lib/client.js" } }, dsh: { bundle: { patch: "./cordis.patch.yml" } } };
const files = ["package.json", "lib/index.js", "lib/index.d.ts", "lib/client.js", "cordis.patch.yml", "scripts/install-skills.mjs", "skills/dsh-agent-relay/SKILL.md", "skills/dsh-notify/SKILL.md", "README.md", "CHANGELOG.md", "docs/operations/T0-T1-T3-T7-plugin-release.md"];
files.push("skills/dsh-notify/send.mjs");
files.push("skills/create-agent-notify/SKILL.md", "skills/create-agent-notify/references/contract.md", "skills/create-agent-notify/scripts/install.mjs", "skills/create-agent-notify/scripts/register.mjs");
files.push("skills/claude-notify/agent-notify.json", "skills/codex-notify/agent-notify.json");
files.push('skills/claude-notify/SKILL.md', 'skills/claude-notify/send.mjs', 'skills/codex-notify/SKILL.md', 'skills/codex-notify/send.mjs');
files.push('skills/claude-notify/open.mjs', 'skills/claude-notify/directory.mjs', 'skills/codex-notify/directory.mjs', 'skills/claude-notify/start.mjs', 'skills/codex-notify/start.mjs');
const showcaseFiles = ["task-dashboard", "dsh-subscribe", "dsh-pause", "codex-notify-request", "dsh-send-to-codex", "codex-notify-and-reply", "claude-cli-notify"].map((name) => `docs/images/showcase/${name}.png`);
files.push("README.en.md", ...showcaseFiles);
test("发布检查包含双语说明和全部展示图片，拒绝额外图片", () => {
  assert.doesNotThrow(() => validatePackage(pkg, files));
  for (const missing of ["README.en.md", ...showcaseFiles])
    assert.throws(() => validatePackage(pkg, files.filter((f) => f !== missing)), /缺少/);
  assert.throws(() => validatePackage(pkg, [...files, "docs/images/showcase/private.png"]), /不允许/);
});
test("发布检查拒绝缺失导出和缺失 Skill", () => {
  assert.doesNotThrow(() => validatePackage(pkg, files, "v0.1.0"));
  assert.doesNotThrow(() => validatePackage(pkg, [...files, 'README.en.md'], "v0.1.0"));
  for (const missing of ["lib/index.d.ts", ...files.filter(f => f.startsWith('skills/'))])
    assert.throws(() => validatePackage(pkg, files.filter((f) => f !== missing)), /缺少/);
});
test("发布检查拒绝源码、数据库、凭证和缓存混入安装包", () => {
  for (const path of ["src/index.ts", "lib/agent-relay.sqlite", "lib/notification-credential.json", ".env", "node_modules/test.js", "skills/.secret"])
    assert.throws(() => validatePackage(pkg, [...files, path]), /不允许/);
});
test("发布标签和包版本必须一致，非法版本不能作为产物目录", () => {
  assert.throws(() => validatePackage(pkg, files, "v0.2.0"), /标签/);
  assert.throws(() => validatePackage({ ...pkg, version: "../bad" }, files), /版本/);
});
