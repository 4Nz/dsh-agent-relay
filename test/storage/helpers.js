import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../lib/storage/database.js";
export function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-"));
  const db = openDatabase({ dataDir });
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { db, dataDir };
}
export const subscription = (id = "s", type = "poll") => ({
  id,
  owner: "local",
  type,
  agent: "claude",
  external_session_id: id === "s" ? "session'1" : `session:${id}`,
  dsh_session_id: "dsh",
  ...(type === "poll" ? { check_interval_seconds: 60 } : {}),
  created_at: 100,
  updated_at: 100,
});
export const message = (id = "m") => ({
  id,
  agent: "claude",
  external_session_id: "session'1",
  content: "继续",
  created_at: 100,
});
