import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SetupItem } from "./setup.js";

export interface AgySandboxItem extends SetupItem {
  path: string;
  revision?: string;
}

function snapshot(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("配置路径不是普通文件");
  const raw = stat ? readFileSync(path, "utf8") : null;
  const settings = raw === null ? {} : JSON.parse(raw);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("配置格式无效");
  const revision = createHash("sha256").update(raw ?? "<missing>").digest("hex");
  return { raw, settings, revision, mode: stat ? stat.mode & 0o777 : 0o600 };
}

// 只展示权限设置；其他用户配置仅用于合并和检测并发修改。
export function agySandboxItem(path: string, enable = false, expectedRevision?: string): AgySandboxItem {
  const base = { key: "agy_sandbox", path };
  try {
    const { raw, settings, revision, mode } = snapshot(path);
    if (settings.enableTerminalSandbox === true && settings.toolPermission === "proceed-in-sandbox")
      return { ...base, status: "ok", revision, message: "已启用沙箱内执行" };
    if (!enable) {
      const permission = ["strict", "request-review", "always-proceed", "proceed-in-sandbox"].includes(settings.toolPermission)
        ? settings.toolPermission : settings.toolPermission === undefined ? "默认" : "自定义";
      const sandbox = settings.enableTerminalSandbox === true ? "开启" : "未开启";
      return { ...base, status: "missing", revision, message: `终端沙箱${sandbox}，工具权限为${permission}` };
    }
    if (expectedRevision !== undefined && expectedRevision !== revision)
      return { ...base, status: "conflict", message: "配置已变化，请重新检查后再安装" };

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const unique = randomUUID();
    const temporary = path + "." + unique + ".tmp";
    const backup = raw === null ? undefined : path + ".agent-relay-" + unique + ".bak";
    try {
      settings.enableTerminalSandbox = true;
      settings.toolPermission = "proceed-in-sandbox";
      writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      chmodSync(temporary, mode);
      if (snapshot(path).revision !== revision)
        return { ...base, status: "conflict", message: "配置已变化，请重新检查后再安装" };
      if (backup && raw !== null) writeFileSync(backup, raw, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
      return { ...agySandboxItem(path), backup, action: raw === null ? "installed" : "updated" };
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    return { ...base, status: "conflict", message: "无法读取或更新 agy CLI 设置，请检查文件格式、类型及访问权限" };
  }
}
