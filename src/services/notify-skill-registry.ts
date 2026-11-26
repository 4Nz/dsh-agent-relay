import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const NOTIFY_MANIFEST = "agent-notify.json";
export interface NotifySkillEntry {
  name: string;
  label: string;
  target_agent: string;
  files: string[];
  available: boolean;
  reason: string | null;
}
export function safeSkillFile(root: string, file: string): boolean {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:md|mjs|json)$/.test(file)) return false;
  let path = root;
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return false;
  for (const part of file.split("/")) {
    path = join(path, part);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
  }
  return true;
}
// 每次自检重新发现登记文件，新增 Skill 无需修改页面或重启宿主。
export function discoverNotifySkills(root: string, supported: readonly string[]): NotifySkillEntry[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*-notify$/.test(d.name) && !["dsh-notify", "create-agent-notify"].includes(d.name))
    .sort((a, b) => a.name.localeCompare(b.name)).flatMap(d => {
      const dir = join(root, d.name), file = join(dir, NOTIFY_MANIFEST);
      if (!existsSync(file)) return [];
      const invalid: NotifySkillEntry = {name: d.name, label: d.name, target_agent: "", files: [], available: false, reason: "登记文件无效，请核对接入信息"};
      try {
        if (!safeSkillFile(dir, NOTIFY_MANIFEST)) return [invalid];
        const value = JSON.parse(readFileSync(file, "utf8"));
        if (value.format !== 1 || value.name !== d.name || typeof value.label !== "string" || !value.label.trim() || value.label.length > 200 ||
          typeof value.target_agent !== "string" || !/^[a-z0-9-]+$/.test(value.target_agent) || !["ready", "pending"].includes(value.status) ||
          !Array.isArray(value.files) || !value.files.includes("SKILL.md") || !value.files.includes("send.mjs") ||
          value.files.length > 30 || new Set(value.files).size !== value.files.length || value.files.some((f: unknown) => typeof f !== "string" || !safeSkillFile(dir, f))) return [invalid];
        const files = [...new Set<string>([...value.files, NOTIFY_MANIFEST])];
        const missing = files.some(f => !existsSync(join(dir, f)) || !lstatSync(join(dir, f)).isFile());
        const reason = missing ? "安装文件缺失" : value.status !== "ready" ? "待接入：尚未完成真实验收" : !supported.includes(value.target_agent) ? "待接入：宿主尚未注册该 Agent 的发送能力" : null;
        return [{name: d.name, label: value.label, target_agent: value.target_agent, files, available: reason === null, reason}];
      } catch { return [invalid]; }
    });
}
