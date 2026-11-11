import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireRuntimeLock } from "../../lib/services/lock.js";
test("同一数据目录独占执行，释放后可恢复启动", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = acquireRuntimeLock(dir);
  assert.throws(() => acquireRuntimeLock(dir), /已有.*实例/);
  release();
  const again = acquireRuntimeLock(dir);
  again();
});
test("进程异常退出后 SQLite 自动释放执行锁", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const module = new URL("../../lib/services/lock.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import{acquireRuntimeLock}from ${JSON.stringify(module)};acquireRuntimeLock(${JSON.stringify(dir)});process.stdout.write('locked');setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null) reject(Error("锁子进程提前退出"));
    });
  });
  assert.throws(() => acquireRuntimeLock(dir));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  acquireRuntimeLock(dir)();
});
