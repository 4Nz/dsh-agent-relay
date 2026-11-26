import type { DatabaseSync } from "node:sqlite";
import { integer, json, text } from "./records.js";

export type TeamRelayRunStatus =
  | "planned"
  | "running"
  | "waiting_user"
  | "partially_completed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type TeamRelayTaskStatus =
  | "pending"
  | "runnable"
  | "queued"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "unknown";

export interface TeamRelayRun {
  id: string;
  owner: string;
  preset_version: number;
  preset: Record<string, unknown>;
  status: TeamRelayRunStatus;
  max_parallel: number;
  created_at: number;
  updated_at: number;
  hard_expires_at: number;
}

export interface TeamRelayTask {
  id: string;
  run_id: string;
  route_id: string;
  target_kind: "dsh" | "provider" | "session";
  target_id: string;
  prompt: string;
  status: TeamRelayTaskStatus;
  resource_key: string | null;
  external_ref: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface TeamRelayDependency {
  run_id: string;
  task_id: string;
  depends_on_task_id: string;
}

function runFromRow(row: Record<string, unknown> | undefined): TeamRelayRun | null {
  if (!row) return null;
  return { ...row, preset: JSON.parse(row.preset as string) } as TeamRelayRun;
}

export function createTeamRelayStore(db: DatabaseSync) {
  return {
    transaction<T>(work: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try { const value = work(); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    recoverInterrupted(): void {
      db.prepare("UPDATE relay_team_task SET status='unknown',error='宿主中断，执行结果未确认；不得自动重发',updated_at=? WHERE status IN ('queued','running')").run(Date.now());
      db.prepare("UPDATE relay_team_run SET status='unknown',updated_at=? WHERE status='running'").run(Date.now());
    },
    unresolvedResource(key: string): boolean {
      return !!db.prepare("SELECT 1 FROM relay_team_task WHERE resource_key=? AND status='unknown' LIMIT 1").get(key);
    },
    updateTask(id: string, status: TeamRelayTaskStatus, result: string | null = null, error: string | null = null): void {
      db.prepare("UPDATE relay_team_task SET status=?,result=?,error=?,updated_at=? WHERE id=?").run(status, result, error, Date.now(), id);
    },
    setReference(id: string, ref: string): void {
      db.prepare("UPDATE relay_team_task SET external_ref=?,updated_at=? WHERE id=?").run(ref, Date.now(), id);
    },
    updateRun(id: string, status: TeamRelayRunStatus): void {
      db.prepare("UPDATE relay_team_run SET status=?,updated_at=? WHERE id=?").run(status, Date.now(), id);
    },
    createRun(input: TeamRelayRun): TeamRelayRun {
      text(input.id, "id");
      text(input.owner, "owner");
      integer(input.preset_version, "preset_version", 1);
      integer(input.max_parallel, "max_parallel", 1);
      integer(input.created_at, "created_at");
      integer(input.updated_at, "updated_at");
      integer(input.hard_expires_at, "hard_expires_at");
      const preset = json(input.preset);
      db.prepare(
        "INSERT INTO relay_team_run(id,owner,preset_version,preset,status,max_parallel,created_at,updated_at,hard_expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        input.id,
        input.owner,
        input.preset_version,
        preset,
        input.status,
        input.max_parallel,
        input.created_at,
        input.updated_at,
        input.hard_expires_at,
      );
      return this.getRun(input.id)!;
    },
    getRun(id: string): TeamRelayRun | null {
      text(id, "id");
      return runFromRow(db.prepare("SELECT * FROM relay_team_run WHERE id=?").get(id) as Record<string, unknown> | undefined);
    },
    createTask(input: Omit<TeamRelayTask, "resource_key" | "external_ref" | "result" | "error"> & Partial<Pick<TeamRelayTask, "resource_key" | "external_ref" | "result" | "error">>): TeamRelayTask {
      text(input.id, "id");
      text(input.run_id, "run_id");
      text(input.route_id, "route_id");
      text(input.target_kind, "target_kind");
      text(input.target_id, "target_id");
      text(input.prompt, "prompt");
      integer(input.created_at, "created_at");
      integer(input.updated_at, "updated_at");
      db.prepare(
        "INSERT INTO relay_team_task(id,run_id,route_id,target_kind,target_id,prompt,status,resource_key,external_ref,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        input.id,
        input.run_id,
        input.route_id,
        input.target_kind,
        input.target_id,
        input.prompt,
        input.status,
        input.resource_key ?? null,
        input.external_ref ?? null,
        input.result ?? null,
        input.error ?? null,
        input.created_at,
        input.updated_at,
      );
      return db.prepare("SELECT * FROM relay_team_task WHERE id=?").get(input.id) as unknown as TeamRelayTask;
    },
    listTasks(runId: string): TeamRelayTask[] {
      text(runId, "run_id");
      return db.prepare("SELECT * FROM relay_team_task WHERE run_id=? ORDER BY created_at,id").all(runId) as unknown as TeamRelayTask[];
    },
    addDependency(input: TeamRelayDependency): void {
      text(input.run_id, "run_id");
      text(input.task_id, "task_id");
      text(input.depends_on_task_id, "depends_on_task_id");
      if (input.task_id === input.depends_on_task_id)
        throw new TypeError("任务不能依赖自身");
      const rows = db.prepare("SELECT id,run_id FROM relay_team_task WHERE id IN (?,?)").all(input.task_id, input.depends_on_task_id) as { id: string; run_id: string }[];
      if (rows.length !== 2 || rows.some((row) => row.run_id !== input.run_id))
        throw new TypeError("依赖任务必须属于同一运行");
      const cycle = db.prepare(
        `WITH RECURSIVE reachable(task_id) AS (
          SELECT depends_on_task_id FROM relay_team_dependency WHERE run_id=? AND task_id=?
          UNION
          SELECT dependency.depends_on_task_id
          FROM relay_team_dependency dependency JOIN reachable ON dependency.task_id=reachable.task_id
          WHERE dependency.run_id=?
        ) SELECT 1 FROM reachable WHERE task_id=? LIMIT 1`,
      ).get(input.run_id, input.depends_on_task_id, input.run_id, input.task_id);
      if (cycle) throw new TypeError("依赖会形成循环依赖");
      db.prepare("INSERT INTO relay_team_dependency(run_id,task_id,depends_on_task_id) VALUES(?,?,?)").run(input.run_id, input.task_id, input.depends_on_task_id);
    },
    listDependencies(runId: string): TeamRelayDependency[] {
      text(runId, "run_id");
      return db.prepare("SELECT run_id,task_id,depends_on_task_id FROM relay_team_dependency WHERE run_id=? ORDER BY task_id,depends_on_task_id").all(runId).map((row) => ({ ...row })) as unknown as TeamRelayDependency[];
    },
  };
}

export type TeamRelayStore = ReturnType<typeof createTeamRelayStore>;
