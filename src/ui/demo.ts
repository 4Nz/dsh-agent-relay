// TODO(T4)：通过 DSH 内部 RPC 替换演示数据；页面组件不直接访问存储或 Adapter。
export type Subscription = {
  id: string;
  agent: string;
  action?: "report" | "custom";
  customAction?: string;
  type: string;
  title: string;
  cwd: string;
  externalId: string;
  status: string;
  result: string;
  check: string;
  delivery: string;
  receiver: string;
  expires: string;
  createdAt: string;
  summary: string;
};
export const sessions = [
  {
    id: "demo-claude-01",
    agent: "claude",
    title: "完善 Relay 订阅服务",
    cwd: "/projects/dsh-agent-relay",
  },
  {
    id: "demo-claude-02",
    agent: "claude",
    title: "整理插件接入文档",
    cwd: "/projects/dsh-agent-relay",
  },
  {
    id: "demo-codex-01",
    agent: "codex",
    title: "检查检索服务的测试覆盖",
    cwd: "/projects/search-service",
  },
];
export const initialSubscriptions: Subscription[] = [
  {
    id: "demo-sub-01",
    createdAt: "2026-11-11T16:30:00+08:00",
    agent: "claude",
    type: "poll",
    title: sessions[0].title,
    cwd: sessions[0].cwd,
    externalId: sessions[0].id,
    status: "active",
    result: "",
    check: "检查成功 · 5 分钟前",
    delivery: "尚未生成",
    receiver: "Relay 开发跟进",
    expires: "约 55 分钟后",
    summary: "",
  },
  {
    id: "demo-sub-02",
    createdAt: "2026-11-11T16:15:00+08:00",
    agent: "codex",
    type: "push",
    title: sessions[2].title,
    cwd: sessions[2].cwd,
    externalId: sessions[2].id,
    status: "active",
    result: "",
    check: "检查失败 1/3 · daemon 无法连接",
    delivery: "尚未生成",
    receiver: "通知时新建会话",
    expires: "约 40 分钟后",
    summary: "",
  },
  {
    id: "demo-sub-03",
    createdAt: "2026-11-11T15:40:00+08:00",
    agent: "claude",
    type: "poll",
    title: sessions[1].title,
    cwd: sessions[1].cwd,
    externalId: sessions[1].id,
    status: "paused",
    result: "",
    check: "检查成功 · 20 分钟前",
    delivery: "尚未生成",
    receiver: "文档整理",
    expires: "已暂停",
    summary: "",
  },
  {
    id: "demo-sub-04",
    createdAt: "2026-11-11T14:30:00+08:00",
    agent: "claude",
    type: "poll",
    title: "修复会话列表筛选",
    cwd: "/projects/dsh-agent-relay",
    externalId: "demo-claude-03",
    status: "ended",
    result: "completed",
    check: "检查成功 · 30 分钟前",
    delivery: "投递失败",
    receiver: "Relay 开发跟进",
    expires: "已结束",
    summary:
      "已修复会话筛选逻辑并完成验证。这是演示摘要；通知尚未送达接收会话。",
  },
  {
    id: "demo-sub-05",
    createdAt: "2026-11-11T13:00:00+08:00",
    agent: "codex",
    type: "poll",
    title: "核对历史快照边界",
    cwd: "/projects/search-service",
    externalId: "demo-codex-02",
    status: "ended",
    result: "idle_timeout",
    check: "检查成功 · 1 小时前",
    delivery: "已送达",
    receiver: "快照核对",
    expires: "已结束",
    summary: "到期时未发现新消息，无法确认任务是否完成。",
  },
];
