import type { ClaudeRunner } from "./runner.js";
import type { ClaudeAgentEntry } from "../../services/claude-channel.js";

// `claude agents --json` 的进程视图：pid、当前会话 ID 与忙闲状态。失败时返回原因字符串。
export function createClaudeAgentList(run: ClaudeRunner, timeoutMs = 15_000) {
  return async (): Promise<ClaudeAgentEntry[] | string> => {
    let result;
    try {
      result = await run(["agents", "--json"], { timeoutMs });
    } catch (error) {
      return `无法执行 claude：${error instanceof Error ? error.message : String(error)}`;
    }
    if (result.timedOut) return "claude agents 超时";
    if (result.code !== 0) return `claude agents 退出码 ${result.code}`;
    let list: unknown;
    try {
      list = JSON.parse(result.stdout);
    } catch {
      return "claude agents 输出无法解析";
    }
    if (!Array.isArray(list)) return "claude agents 输出格式未知";
    return list
      .filter((item) => typeof item?.sessionId === "string")
      .map((item) => ({
        pid: Number.isSafeInteger(item.pid) ? item.pid : null,
        sessionId: item.sessionId,
        status: typeof item.status === "string" ? item.status : null,
      }));
  };
}
