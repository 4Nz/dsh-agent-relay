import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("干净构建移除已删除模块，所有客户端导出都有实际产物", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "relay-build-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.client.json", "tsdown.config.mjs"])
    await cp(join(root, name), join(dir, name), { recursive: true });
  await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  await mkdir(join(dir, "lib"));
  await writeFile(join(dir, "lib/removed.js"), "旧模块");
  const result = spawnSync("npm", ["run", "build"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(access(join(dir, "lib/removed.js")), { code: "ENOENT" });
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  for (const path of Object.values(pkg.exports["./client"])) await access(join(dir, path));
});
