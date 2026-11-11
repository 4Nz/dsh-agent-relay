import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { Page, PageOptions } from "./types.js";
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${name} 必须为非空字符串`);
  return value;
}
export function integer(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new TypeError(`${name} 无效`);
  return value;
}
export function json(value: unknown): string {
  function check(v: unknown, seen = new Set<object>()) {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (
      typeof v !== "object" ||
      seen.has(v) ||
      (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
    )
      throw new TypeError("cursor 必须为 JSON");
    seen.add(v);
    for (const x of Object.values(v)) check(x, seen);
    seen.delete(v);
  }
  check(value);
  return JSON.stringify(value);
}
export function validate(record: Record<string, unknown>) {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) throw new TypeError(`${key} 不能为 undefined`);
    if (key.endsWith("_at") && value !== null) integer(value, key);
    if (["id", "owner", "external_session_id"].includes(key)) text(value, key);
    if (key.endsWith("_seconds") && value !== null)
      integer(value, key, key === "check_interval_seconds" ? 60 : 1);
    if (
      ["consecutive_failures", "max_consecutive_failures"].includes(key) &&
      value !== null
    )
      integer(value, key, key === "consecutive_failures" ? 0 : 1);
  }
}
export function decode<T>(
  row: Record<string, SQLOutputValue> | undefined,
): T | null {
  if (!row) return null;
  const result = { ...row };
  if ("cursor" in result)
    result.cursor =
      result.cursor === null ? null : JSON.parse(result.cursor as string);
  return result as T;
}
export function insert(
  db: DatabaseSync,
  table: string,
  record: Record<string, unknown>,
  allowed: string[],
) {
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) throw new TypeError(`不支持字段 ${key}`);
  validate(record);
  const keys = Object.keys(record);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
  ).run(...(Object.values(record) as SQLInputValue[]));
}
export function list<T extends { id: string; created_at: number }>(
  db: DatabaseSync,
  table: string,
  options: PageOptions,
  filters: string[],
): Page<T> {
  const { limit = 50, cursor = null, ...query } = options;
  integer(limit, "limit", 1);
  if (limit > 100) throw new TypeError("limit 最大 100");
  const where: string[] = [],
    params: SQLInputValue[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (!filters.includes(key)) throw new TypeError(`不支持筛选 ${key}`);
    text(value, key);
    where.push(`${key}=?`);
    params.push(text(value, key));
  }
  if (cursor) {
    integer(cursor.created_at, "cursor.created_at");
    text(cursor.id, "cursor.id");
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const rows = db
    .prepare(
      `SELECT * FROM ${table}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .all(...params, limit + 1);
  const items = rows.slice(0, limit).map((row) => decode<T>(row)!),
    last = items.at(-1);
  return {
    items,
    next_cursor:
      rows.length > limit
        ? { created_at: last!.created_at, id: last!.id }
        : null,
  };
}
export function fields(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((x) => x.name as string);
}
