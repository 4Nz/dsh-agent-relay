import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "relay-skills-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, version] of [["v1", "0.1.0"], ["v2", "0.2.0"]]) {
    await mkdir(join(dir, name, "scripts"), { recursive: true });
    await cp(new URL("../../scripts/install-skills.mjs", import.meta.url), join(dir, name, "scripts/install-skills.mjs"));
    await cp(new URL("../../skills/", import.meta.url), join(dir, name, "skills"), { recursive: true });
    await writeFile(join(dir, name, "package.json"), JSON.stringify({ name: "dsh-agent-relay", version }));
  }
  const project = join(dir, "project");
  await mkdir(project);
  const destination = join(project, ".agents/skills");
  const run = (version, ...args) => spawnSync(process.execPath,
    [join(dir, version, "scripts/install-skills.mjs"), project, ...args], { encoding: "utf8" });
  return { dir, project, destination, run };
}

test("Skill 按用途安装，检查缺失时不创建项目文件", async (t) => {
  const { destination, run } = await fixture(t);
  assert.equal(run("v1", "--scope", "external", "--check").status, 1);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  assert.equal(run("v1", "--scope", "external").status, 0);
  await assert.rejects(lstat(join(destination, "dsh-agent-relay")), { code: "ENOENT" });
  assert.ok((await lstat(join(destination, "external-agent-notification"))).isSymbolicLink());
  assert.equal(run("v1", "--scope", "external", "--check").status, 0);
  assert.equal(run("v1", "--scope", "wrong").status, 1);
});

test("Skill 升级修复旧安装包移除后的断链，检查不修改安装记录", async (t) => {
  const { dir, destination, run } = await fixture(t);
  assert.equal(run("v1").status, 0);
  const record = join(destination, ".dsh-agent-relay.json");
  const before = await readFile(record, "utf8");
  await rm(join(dir, "v1"), { recursive: true });
  assert.equal(run("v2", "--check").status, 1);
  assert.equal(await readFile(record, "utf8"), before);
  assert.equal(run("v2").status, 1);
  const update = run("v2", "--update");
  assert.equal(update.status, 0, update.stderr);
  assert.equal(await realpath(join(destination, "external-agent-notification")), await realpath(join(dir, "v2/skills/external-agent-notification")));
  assert.equal(run("v2", "--check").status, 0);
});

test("Skill 更新拒绝覆盖用户修改的链接和同名目录", async (t) => {
  const { dir, destination, run } = await fixture(t);
  assert.equal(run("v1").status, 0);
  const link = join(destination, "dsh-agent-relay");
  await rm(link);
  const own = join(dir, "user-skill");
  await mkdir(own);
  await writeFile(join(own, "SKILL.md"), "用户内容");
  await symlink(own, link, "dir");
  assert.equal(run("v2", "--update").status, 1);
  assert.equal(await readFile(join(link, "SKILL.md"), "utf8"), "用户内容");
  await rm(link);
  await mkdir(link);
  await writeFile(join(link, "SKILL.md"), "用户目录");
  assert.equal(run("v2", "--update").status, 1);
  assert.equal(await readFile(join(link, "SKILL.md"), "utf8"), "用户目录");
});
