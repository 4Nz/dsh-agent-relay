import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../storage/types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { RunPromptResult } from "../adapters/types.js";

// 随包分发的外部 Agent 通知 Skill，供 Claude/Codex 安装后向 DSH 推送结果。
export const NOTIFICATION_SKILL = "external-agent-notification";

const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export interface InstallPreview {
  agent: Agent;
  skill: string;
  target_dir: string;
  prompt: string;
  supported: boolean;
  reason: string | null;
}

export type InstallResult =
  | { supported: true; prompt: string; result: RunPromptResult }
  | { supported: false; reason: string };

export interface SkillInstallService {
  preview(agent: Agent): Promise<InstallPreview>;
  install(agent: Agent): Promise<InstallResult>;
}

export function createSkillInstallService({
  adapters,
  skillsDir,
  homeDir = homedir(),
}: {
  adapters: AdapterRegistry;
  // 技能源码目录，默认随包 skills/；测试可注入临时目录。
  skillsDir?: string;
  homeDir?: string;
}): SkillInstallService {
  const root =
    skillsDir ?? fileURLToPath(new URL("../../skills", import.meta.url));
  const skillDir: Record<Agent, string> = {
    claude: join(homeDir, ".claude", "skills"),
    codex: join(homeDir, ".codex", "skills"),
  };

  async function readSkill(): Promise<string> {
    return readFile(join(root, NOTIFICATION_SKILL, "SKILL.md"), "utf8");
  }

  async function buildPrompt(agent: Agent, content: string): Promise<string> {
    const label = AGENT_LABEL[agent];
    const dir = join(skillDir[agent], NOTIFICATION_SKILL);
    const readFileSender = await readFile(join(root, NOTIFICATION_SKILL, "send.mjs"), "utf8");
    return [
      `请帮我在本机安装一个名为 ${NOTIFICATION_SKILL} 的 ${label} skill，用于在任务完成后向 DSH Agent Relay 发送一次结果通知。`,
      "",
      `请把下面这段 SKILL.md 内容原样保存为文件：${join(dir, "SKILL.md")}（若目录不存在请先创建）。`,
      "",
      "不要增删或改写内容，也不要执行 skill 里描述的通知请求。",
      "",
      "```markdown",
      content,
      "```",
      "",
      `同时将发送脚本原样保存为 ${join(dir, "send.mjs")}：`,
      "```javascript",
      readFileSender,
      "```",
    ].join("\n");
  }

  return {
    async preview(agent: Agent): Promise<InstallPreview> {
      const content = await readSkill();
      const supported = adapters.get(agent).capabilities().runPrompt === true;
      return {
        agent,
        skill: NOTIFICATION_SKILL,
        target_dir: join(skillDir[agent], NOTIFICATION_SKILL),
        prompt: await buildPrompt(agent, content),
        supported,
        reason: supported
          ? null
          : `${AGENT_LABEL[agent]} 开新会话执行安装为后续版本预留，可复制提示词后手动执行。`,
      };
    },
    async install(agent: Agent): Promise<InstallResult> {
      const adapter = adapters.get(agent);
      if (!adapter.capabilities().runPrompt)
        return {
          supported: false,
          reason: `${AGENT_LABEL[agent]} 开新会话执行安装为后续版本预留`,
        };
      const content = await readSkill();
      const prompt = await buildPrompt(agent, content);
      const result = await adapter.runPrompt(prompt, {
        addDirs: [skillDir[agent]],
      });
      return { supported: true, prompt, result };
    },
  };
}
