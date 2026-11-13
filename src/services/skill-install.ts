import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../storage/types.js";
import { connectCodex } from "../adapters/codex/rpc.js";

// 随包分发的外部 Agent 通知 Skill，供 Claude/Codex 安装后向 DSH 推送结果。
export const NOTIFICATION_SKILL = "external-agent-notification";

// 前置安装状态：可用性检测 + 通知 Skill 安装，两者都通过才算 ready。
export interface AgentSetupStatus {
  agent: Agent;
  // 后台实例可用（Codex daemon 可连接；Claude 安装流程开发中恒为 false）。
  available: boolean;
  available_reason: string | null;
  // 通知 Skill 已安装到技能目录。
  skill_installed: boolean;
  skill_dir: string;
  // ready = available && skill_installed；门控以此为准。
  ready: boolean;
  reason: string | null;
}

export interface SetupInstallResult {
  ok: boolean;
  status: AgentSetupStatus;
  reason: string | null;
}

export interface SkillInstallService {
  status(agent: Agent): Promise<AgentSetupStatus>;
  install(agent: Agent): Promise<SetupInstallResult>;
  // 门控：未 ready 抛 TypeError，由上层转成 invalid_input。
  requireReady(agent: Agent): Promise<void>;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function defaultDetect(agent: Agent): Promise<{ available: boolean; reason: string | null }> {
  if (agent === "claude") {
    // Claude 的发送走 Agent Relay channel，安装流程尚在开发，暂不支持。
    return { available: false, reason: "Claude 安装流程开发中，暂不支持" };
  }
  try {
    const client = await connectCodex();
    client.close();
    return { available: true, reason: null };
  } catch (error) {
    return { available: false, reason: `Codex 后台实例不可用：${messageOf(error)}` };
  }
}

export function createSkillInstallService({
  skillsDir,
  homeDir = homedir(),
  detect = defaultDetect,
}: {
  // 技能源码目录，默认随包 skills/；测试可注入临时目录。
  skillsDir?: string;
  homeDir?: string;
  // 可用性检测，默认 Codex 连接 daemon / Claude 开发中；测试可注入 mock。
  detect?: (agent: Agent) => Promise<{ available: boolean; reason: string | null }>;
}): SkillInstallService {
  const root =
    skillsDir ?? fileURLToPath(new URL("../../skills", import.meta.url));
  const skillDir: Record<Agent, string> = {
    claude: join(homeDir, ".claude", "skills"),
    codex: join(homeDir, ".codex", "skills"),
  };
  const target = (agent: Agent) => join(skillDir[agent], NOTIFICATION_SKILL, "SKILL.md");

  async function skillInstalled(agent: Agent): Promise<boolean> {
    try {
      await access(target(agent));
      return true;
    } catch {
      return false;
    }
  }

  async function status(agent: Agent): Promise<AgentSetupStatus> {
    const avail = await detect(agent);
    const installed = await skillInstalled(agent);
    return {
      agent,
      available: avail.available,
      available_reason: avail.reason,
      skill_installed: installed,
      skill_dir: target(agent),
      ready: avail.available && installed,
      reason: !avail.available
        ? avail.reason
        : installed
          ? null
          : `尚未安装通知 Skill：${target(agent)}`,
    };
  }

  async function install(agent: Agent): Promise<SetupInstallResult> {
    const before = await status(agent);
    if (!before.available)
      return { ok: false, status: before, reason: before.available_reason };
    try {
      const content = await readFile(join(root, NOTIFICATION_SKILL, "SKILL.md"), "utf8");
      await mkdir(join(skillDir[agent], NOTIFICATION_SKILL), { recursive: true, mode: 0o700 });
      await writeFile(target(agent), content, "utf8");
    } catch (error) {
      return {
        ok: false,
        status: await status(agent),
        reason: `写入通知 Skill 失败：${messageOf(error)}`,
      };
    }
    return { ok: true, status: await status(agent), reason: null };
  }

  async function requireReady(agent: Agent): Promise<void> {
    if (agent === "claude")
      throw new TypeError("Claude 安装流程开发中，暂不支持");
    if (!(await skillInstalled(agent)))
      throw new TypeError(`Codex 前置安装未完成，请先在「安装」页完成 Codex 安装：${target(agent)}`);
  }

  return { status, install, requireReady };
}
