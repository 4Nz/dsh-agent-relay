import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRelayStore } from "../../lib/storage/index.js";

test("TeamRelay 存储独立保存运行、子任务和依赖", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-team-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = store.teamRelay.createRun({
    id: "run-1",
    owner: "dsh",
    preset_version: 1,
    preset: { max_parallel: 4 },
    status: "planned",
    max_parallel: 4,
    created_at: 1000,
    updated_at: 1000,
    hard_expires_at: 2000,
  });
  assert.equal(run.id, "run-1");
  store.teamRelay.createTask({
    id: "task-a",
    run_id: "run-1",
    route_id: "search",
    target_kind: "provider",
    target_id: "doubao",
    prompt: "查询资料",
    status: "pending",
    created_at: 1001,
    updated_at: 1001,
  });
  store.teamRelay.createTask({
    id: "task-b",
    run_id: "run-1",
    route_id: "complex-code",
    target_kind: "session",
    target_id: "claude-session",
    prompt: "实现代码",
    status: "pending",
    created_at: 1002,
    updated_at: 1002,
  });
  store.teamRelay.addDependency({ run_id: "run-1", task_id: "task-b", depends_on_task_id: "task-a" });

  assert.deepEqual(store.teamRelay.getRun("run-1"), run);
  assert.deepEqual(store.teamRelay.listTasks("run-1").map((task) => task.id), ["task-a", "task-b"]);
  assert.deepEqual(store.teamRelay.listDependencies("run-1"), [
    { run_id: "run-1", task_id: "task-b", depends_on_task_id: "task-a" },
  ]);
});

test("TeamRelay 存储拒绝自依赖", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-team-cycle-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.teamRelay.createRun({
    id: "run-1", owner: "dsh", preset_version: 1, preset: {}, status: "planned",
    max_parallel: 4, created_at: 1000, updated_at: 1000, hard_expires_at: 2000,
  });
  assert.throws(
    () => store.teamRelay.addDependency({ run_id: "run-1", task_id: "task-a", depends_on_task_id: "task-a" }),
    /自身|自依赖/,
  );
});

test("TeamRelay 存储拒绝形成环的依赖", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-team-cycle-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.teamRelay.createRun({
    id: "run-1", owner: "dsh", preset_version: 1, preset: {}, status: "planned",
    max_parallel: 4, created_at: 1000, updated_at: 1000, hard_expires_at: 2000,
  });
  for (const id of ["task-a", "task-b"]) {
    store.teamRelay.createTask({
      id, run_id: "run-1", route_id: "search", target_kind: "provider", target_id: "doubao",
      prompt: id, status: "pending", created_at: 1000, updated_at: 1000,
    });
  }
  store.teamRelay.addDependency({ run_id: "run-1", task_id: "task-b", depends_on_task_id: "task-a" });
  assert.throws(
    () => store.teamRelay.addDependency({ run_id: "run-1", task_id: "task-a", depends_on_task_id: "task-b" }),
    /循环依赖/,
  );
});
