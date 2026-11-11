import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
// 独立数据库只作进程生命周期锁，不向业务库长时间持有事务。
// OS 在异常退出时释放 SQLite 文件锁，重启无须猜测 PID 或删除陈旧锁。
export function acquireRuntimeLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, "runtime-lock.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    db.close();
    throw new Error("Agent Relay 数据目录已有执行实例，不能进行启动恢复", {
      cause: error,
    });
  }
  return () => {
    if (db.isOpen) db.close();
  };
}
