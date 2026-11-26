import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultTeamRelayPreset, validateTeamRelayPreset, TEAM_RELAY_MAX_PARALLEL } from "./policy.js";
import type { TeamRelayPreset, TeamSettingsSnapshot } from "./types.js";
export type { TeamSettingsSnapshot } from "./types.js";

export interface TeamSettingsStore {
  read(): TeamSettingsSnapshot;
  save(preset: TeamRelayPreset, revision: number): TeamSettingsSnapshot;
}

// 配置文件不保存凭证。同步原子替换配合宿主单实例锁，避免半写和同进程并发覆盖。
export function createTeamSettingsStore(file: string): TeamSettingsStore {
  function read(): TeamSettingsSnapshot {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { revision: 0, preset: defaultTeamRelayPreset() };
      throw new Error("无法读取 TeamRelay 配置，请检查文件访问权限");
    }
    try {
      const value = JSON.parse(raw) as TeamSettingsSnapshot;
      if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error();
      validateTeamRelayPreset(value.preset);
      value.preset.max_parallel = TEAM_RELAY_MAX_PARALLEL;
      return value;
    } catch { throw new Error("TeamRelay 配置文件无效；请修复配置，原文件未被覆盖"); }
  }
  return {
    read,
    save(preset, revision) {
      validateTeamRelayPreset(preset);
      const current = read();
      if (!Number.isSafeInteger(revision) || revision !== current.revision)
        throw Object.assign(new Error("配置已在其他窗口更新，请重新加载后再保存"), { code: "conflict" });
      const saved = { revision: revision + 1, preset: { ...structuredClone(preset), max_parallel: TEAM_RELAY_MAX_PARALLEL } };
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(temporary, file);
      } finally { rmSync(temporary, { force: true }); }
      return saved;
    },
  };
}
