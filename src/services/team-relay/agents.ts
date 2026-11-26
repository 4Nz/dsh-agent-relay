import type { ClaudeRunner } from "../../adapters/claude/runner.js";
import type { CodexClient } from "../../adapters/codex/rpc.js";

import type { TeamAgentView, DoubaoAccessView } from "./types.js";
export type { TeamAgentView } from "./types.js";

export const teamAgentIds = ["dsh", "codex", "claude", "doubao", "workbuddy"] as const;

// 只读检查：不创建会话、不启动模型推理、不调用通知安装或 channel 配置。
export function createTeamAgentInspector({ runClaude, connectCodex, doubaoStatus }: {
  runClaude: ClaudeRunner;
  connectCodex: () => Promise<CodexClient>;
  doubaoStatus?: () => DoubaoAccessView;
}): () => Promise<TeamAgentView[]> {
  return async () => {
    const [codex, claude] = await Promise.all([
      (async (): Promise<TeamAgentView> => {
        const base = { id: "codex", label: "Codex", selectable: true };
        try {
          const client = await connectCodex();
          client.close();
          return { ...base, status: "connected", message: "本机服务已连接，复用 Codex 现有配置。登录与任务权限将在执行时核验。" };
        } catch {
          return { ...base, status: "unavailable", message: "本机 Codex 服务未连接。请启动本地 Codex 服务后重新检测；macOS 无需单独安装 CLI。" };
        }
      })(),
      (async (): Promise<TeamAgentView> => {
        const base = { id: "claude", label: "Claude", selectable: true };
        try {
          const result = await runClaude(["--version"], { timeoutMs: 5000 });
          if (result.code !== 0 || result.timedOut) throw new Error();
          return { ...base, status: "detected", message: "已检测到 Claude Code，复用本机登录与权限配置。新建专用任务无需 channel；登录状态将在执行时核验。" };
        } catch {
          return { ...base, status: "unavailable", message: "未能运行本机 Claude Code。请确认已安装，且 DSH 能找到 claude 命令。" };
        }
      })(),
    ]);
    return [
      { id: "dsh", label: "DSH", selectable: true, status: "builtin", message: "使用当前 DSH 配置，无需额外接入。分析、规划和汇总始终由 DSH 负责。" },
      codex, claude,
      doubaoStatus ? (() => {
        const view = doubaoStatus();
        return { id: "doubao", label: "豆包", selectable: true, status: view.state, message: view.message };
      })() : { id: "doubao", label: "豆包", selectable: false, status: "not_integrated", message: "豆包内置接入服务未就绪。" },
      { id: "workbuddy", label: "WorkBuddy", selectable: false, status: "unsupported", message: "暂未支持。" },
    ];
  };
}
