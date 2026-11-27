export interface Rpc {
  call(
    channel: string,
    method: string,
    payload: unknown,
  ): Promise<{ ok: boolean; value?: any; error?: { message: string } }>;
}

export const labels: Record<string, string> = {
  active: "关注中",
  processed: "已处理",
  not_found: "记录不存在",
  progress: "新增进展",
  muted: "已暂停接收 Agent 消息",
  needs_attention: "待人工处理",
  unknown_attention: "投递未知，待人工核对",
  events: "增量事实已交给 DSH 判断",
  unchanged: "暂无新变化",
  paused: "已暂停",
  ended: "已结束",
  completed: "任务完成",
  failed: "失败",
  idle_timeout: "到期无新消息",
  expired: "已达最长时间",
  session_closed: "会话已关闭",
  unreachable: "无法访问",
  user_stopped: "手动停止",
  sent: "已发送",
  queued: "排队中",
  rejected: "被拒绝",
  pending: "待投递",
  delivering: "投递中",
  delivered: "已送达",
  unknown: "结果未知",
  success: "成功",
  error: "检查失败",
  not_due: "未到期，已跳过",
  watching: "检查成功，继续关注",
  extended: "检测到活动，已顺延",
  notified: "已生成通知",
  inactive: "订阅未运行",
  running: "检查进行中",
  check_failed: "检查失败，等待下次重试",
};

export const label = (value: string | null) =>
  value ? (labels[value] ?? value) : "—";

export const date = (value: number | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

// 表格内“开始时间”：北京时间短格式。
export const formatStart = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));

export const relAgo = (value: number) => {
  const minutes = Math.round((Date.now() - value) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return formatStart(value);
};

export const agentName = (agent: string) =>
  ({ claude: "Claude", codex: "Codex", agy: "Antigravity" }[agent] ?? agent);

export const typeLabel = (type: string) =>
  type === "poll" ? "主动订阅" : "主动通知";

export const expiryText = (sub: any) => {
  if (sub.status === "ended") return "已结束";
  if (sub.status === "paused") return "已暂停";
  if (!sub.expires_at) return "—";
  const remain = sub.expires_at - Date.now();
  if (remain <= 0) return "已到期";
  const minutes = Math.round(remain / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟后`;
  return `约 ${Math.round(minutes / 60)} 小时后`;
};

export const checkText = (sub: any) => {
  // 主动通知不轮询外部会话，检查时间只对主动订阅有意义。
  if (sub.type === "push") return "等待外部推送";
  if (!sub.last_checked_at) return "尚未检查";
  const ago = relAgo(sub.last_checked_at);
  if (sub.last_check_status === "error")
    return `检查失败 ${sub.consecutive_failures}/${sub.max_consecutive_failures} · ${ago}`;
  return `检查成功 · ${ago}`;
};

export const hasFrequency = (sub: any) =>
  Number.isSafeInteger(sub.selected_interval_seconds) &&
  sub.selected_interval_seconds >= 60;

export const planningText = (sub: any) => {
  if (sub.type === "push") return "无需轮询规划";
  if (hasFrequency(sub)) return "频率已规划";
  return (
    { pending: "待 DSH 规划", deciding: "待 DSH 判断" }[
      sub.planning_state as string
    ] ?? "待 DSH 规划"
  );
};

export const frequencyText = (sub: any) => {
  if (sub.type === "push") return "不适用（主动通知）";
  if (hasFrequency(sub)) return `每 ${sub.selected_interval_seconds / 60} 分钟`;
  return "尚未选择频率";
};

export const deliveryText = (sub: any) => {
  const batch = sub.decision_batch;
  if (batch)
    return `${label(batch.state)} · ${sub.pending_events ?? 0} 条待处理事件`;
  return sub.pending_events
    ? `${sub.pending_events} 条事件排队中`
    : sub.notification
      ? `旧通知：${label(sub.notification.delivery_status)}`
      : "—";
};

export const deliveryTone = (sub: any) => {
  const state = sub.decision_batch?.state ?? sub.notification?.delivery_status;
  if (state === "processed") return "good";
  if (["failed", "needs_attention", "unknown_attention"].includes(state))
    return "warn";
  return "muted";
};

export function parseSummaryText(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of ["summary", "text", "message", "reply"]) {
        if (typeof parsed[key] === "string" && parsed[key].trim()) {
          return parsed[key].trim();
        }
      }
    } catch {
      /* 非 JSON 原样展示 */
    }
  }
  return text;
}

export function notifyText(item: any) {
  const status = `${label(item.result)} · ${label(item.delivery_status)}`;
  const summary = parseSummaryText(item.summary).slice(0, 200);
  return summary ? `${status}：${summary}` : status;
}

export const SETUP_LABEL: Record<string, string> = {
  ok: "正常",
  missing: "未安装",
  outdated: "需更新",
  conflict: "冲突",
  unavailable: "不可用",
};

export const SETUP_OVERALL: Record<string, string> = {
  ok: "已安装，无需重复操作",
  changed: "已完成安装或更新",
  needs_action: "部分项需要处理",
  unavailable: "当前环境不满足，未做改动",
};

export const SETUP_ITEM: Record<string, string> = {
  claude: "Claude 命令",
  codex: "Codex 命令",
  agy: "Antigravity 环境",
  agy_sidecar_server: "桥接 Sidecar 程序",
  agy_sidecar: "桥接 Sidecar 配置",
  agy_credential: "桥接凭证",
  channel_flag: "channel 支持",
  channel_server: "channel server",
  push_server: "本机通知服务",
  mcp: "MCP 登记",
  credential: "channel 凭证",
  notification: "通知凭证",
  rule: "Relay 规则",
  claude_md: "CLAUDE.md 引用",
  shell: "claude 函数",
  skill: "通知 Skill（必装）",
  "create-agent-notify": "Agent 接入 Skill（必装）",
  "claude-notify": "向 Claude 接力",
  "codex-notify": "向 Codex 接力",
  "agy-notify": "向 Antigravity 接力",
};
