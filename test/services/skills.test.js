import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const script = new URL("../../scripts/install-skills.mjs", import.meta.url);
test("Skill 安装到指定项目，可重复执行且拒绝覆盖已有 Skill", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [script.pathname, root], { encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.match(readFileSync(join(root, ".agents/skills/dsh-agent-relay/SKILL.md"), "utf8"), /relay_inspect/);
  assert.equal(run().status, 0);
  rmSync(join(root, ".agents/skills/dsh-agent-relay"));
  mkdirSync(join(root, ".agents/skills/dsh-agent-relay"));
  assert.notEqual(run().status, 0);
});
