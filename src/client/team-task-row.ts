import { createElement as h } from "react";
import { presentTeamTask } from "../services/team-relay/presentation.js";

interface TeamTaskRowProps {
  toolName: string;
  phase: "preparing" | "start" | "result";
  block: {
    meta?: unknown;
    isError?: boolean;
    content?: readonly { type: string; text?: string }[];
  };
}

export function TeamTaskRow({ toolName, phase, block }: TeamTaskRowProps) {
  const action = toolName === "relay_team_dispatch" ? "dispatch" : "status";
  const settled = phase === "result";
  const view = settled ? presentTeamTask(block, action) : undefined;
  const title = view?.title ?? (settled ? "已记录 TeamRelay 任务状态" :
    action === "dispatch" ? "正在派发 TeamRelay 任务" : "正在查看 TeamRelay 任务进度");
  const error = settled && block.isError
    ? block.content?.find(item => item.type === "text")?.text?.replace(/^Error:\s*/, "")
    : undefined;
  const style = {
    fontSize: 13,
    lineHeight: "20px",
    color: settled && block.isError
      ? "var(--dsw-alias-state-error-primary, #e57373)"
      : "var(--dsw-alias-label-secondary, inherit)",
  };
  if (error) {
    return h("details", { style },
      h("summary", { style: { cursor: "pointer" } }, title),
      h("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, error));
  }
  return h("div", { style }, title);
}
