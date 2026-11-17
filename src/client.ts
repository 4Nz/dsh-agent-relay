import { createElement as h, useEffect, useState, useRef } from "react";

export const inject = ["slots", "connection", "uiWorkspace"];
const PANEL_ID = "agent-relay";
const labels: Record<string, string> = {
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
const label = (value: string | null) =>
  value ? (labels[value] ?? value) : "—";
const date = (value: number | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
// 表格内“开始时间”：北京时间短格式。
const formatStart = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
const relAgo = (value: number) => {
  const minutes = Math.round((Date.now() - value) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return formatStart(value);
};
const agentName = (agent: string) => (agent === "claude" ? "Claude" : "Codex");
const typeLabel = (type: string) => (type === "poll" ? "主动订阅" : "主动通知");
const expiryText = (sub: any) => {
  if (sub.status === "ended") return "已结束";
  if (sub.status === "paused") return "已暂停";
  if (!sub.expires_at) return "—";
  const remain = sub.expires_at - Date.now();
  if (remain <= 0) return "已到期";
  const minutes = Math.round(remain / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟后`;
  return `约 ${Math.round(minutes / 60)} 小时后`;
};
const checkText = (sub: any) => {
  // 主动通知不轮询外部会话，检查时间只对主动订阅有意义。
  if (sub.type === "push") return "等待外部推送";
  if (!sub.last_checked_at) return "尚未检查";
  const ago = relAgo(sub.last_checked_at);
  if (sub.last_check_status === "error")
    return `检查失败 ${sub.consecutive_failures}/${sub.max_consecutive_failures} · ${ago}`;
  return `检查成功 · ${ago}`;
};
const hasFrequency = (sub: any) =>
  Number.isSafeInteger(sub.selected_interval_seconds) &&
  sub.selected_interval_seconds >= 60;
const planningText = (sub: any) => {
  if (sub.type === "push") return "无需轮询规划";
  if (hasFrequency(sub)) return "频率已规划";
  return ({ pending: "待 DSH 规划", deciding: "待 DSH 判断" }[
    sub.planning_state as string
  ] ?? "待 DSH 规划");
};
const frequencyText = (sub: any) => {
  if (sub.type === "push") return "不适用（主动通知）";
  if (hasFrequency(sub))
    return `每 ${sub.selected_interval_seconds / 60} 分钟`;
  return "尚未选择频率";
};
const deliveryText = (sub: any) => {
  const batch = sub.decision_batch;
  if (batch) return `${label(batch.state)} · ${sub.pending_events ?? 0} 条待处理事件`;
  return sub.pending_events ? `${sub.pending_events} 条事件排队中` : sub.notification ? `旧通知：${label(sub.notification.delivery_status)}` : "—";
};
const deliveryTone = (sub: any) => {
  const state = sub.decision_batch?.state ?? sub.notification?.delivery_status;
  if (state === "processed") return "good";
  if (["failed", "needs_attention", "unknown_attention"].includes(state)) return "warn";
  return "muted";
};
interface Rpc {
  call(
    channel: string,
    method: string,
    payload: unknown,
  ): Promise<{ ok: boolean; value?: any; error?: { message: string } }>;
}
interface PanelProps {
  rpc: Rpc;
  openSession: (id: string) => void;
}
const css = `
.ar{height:100%;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base,#141414);color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:14px;line-height:1.55;color-scheme:inherit}
.ar *{box-sizing:border-box}.ar button,.ar input,.ar select{font:inherit;color:inherit}.ar button{cursor:pointer}.ar button:disabled{cursor:not-allowed;opacity:.45}
.ar button,.ar input,.ar select{border:1px solid var(--dsw-alias-border-l2,#49494d);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#202020);padding:7px 11px}
.ar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#333)}.ar :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#a4b7ff);outline-offset:3px}
.ar .primary{background:var(--dsw-alias-button-ghost-active-fill,#4b4b51);border-color:var(--dsw-alias-button-ghost-active-border,#74747d)}
.ar .muted{color:var(--dsw-alias-label-secondary,#aaa)}.ar .small{font-size:12px}.ar header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:26px 28px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,#393939)}
.ar h1{font-size:20px;margin:0 0 4px;font-weight:600}.ar h2{font-size:18px;margin:0}.ar p{margin:6px 0}.ar .body{padding:20px 28px}.ar .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ar .between{justify-content:space-between}.ar .notice{padding:10px 14px;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:8px;margin-bottom:20px;background:var(--dsw-alias-bg-layer-1,#202020)}
.ar .filters{margin:18px 0}.ar .filters select{min-width:124px}.ar .table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:10px}.ar table{border-collapse:collapse;width:100%;min-width:1290px;text-align:left}.ar th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-bg-layer-1,#202020);white-space:nowrap}.ar th,.ar td{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#393939);vertical-align:middle}.ar tbody tr:last-child td{border-bottom:0}.ar tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover,#292929)}
.ar .link{background:transparent;border:0;padding:0;text-align:left;color:inherit}.ar .title{font-weight:500;max-width:270px;line-height:1.5}.ar .path{max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.ar .badge{display:inline-flex;padding:3px 8px;border-radius:5px;font-size:12px;font-weight:500;white-space:nowrap;border-color:transparent}.ar .good{color:var(--dsw-alias-state-business-primary,#a4b7ff)}.ar .bad{color:var(--dsw-alias-state-error-primary,#f28b82)}.ar .warn{color:var(--dsw-alias-state-warn-label,#e8bd75)}.ar .actions{display:flex;gap:8px;flex-wrap:nowrap;white-space:nowrap}.ar .actions button{font-size:12px;padding:4px 8px}.ar .empty{text-align:center;padding:60px 20px}.ar .empty strong{display:block;margin-bottom:8px}
.ar .overlay{position:fixed;inset:0;z-index:1000;background:#0007;display:flex;justify-content:flex-end}.ar .drawer{width:min(520px,100%);height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#181818);box-shadow:var(--dsw-elevation-prominent,-8px 0 32px #0004);padding:24px;display:flex;flex-direction:column;gap:20px}.ar .drawer footer{display:flex;justify-content:flex-end;gap:10px;margin-top:auto;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l2,#393939)}.ar label{display:flex;flex-direction:column;gap:7px}.ar .drawer .fields{display:grid;gap:14px}.ar .detail{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px}.ar .detail dt{color:var(--dsw-alias-label-secondary,#aaa)}.ar .detail dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.ar .error{color:var(--dsw-alias-state-error-primary,#f28b82)}
.ar select{appearance:none;padding:8px 36px 8px 13px;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary,#aaa) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary,#aaa) 50%,transparent 50%);background-position:calc(100% - 17px) 50%,calc(100% - 13px) 50%;background-size:4px 4px;background-repeat:no-repeat}
.ar .agent-stack{display:flex;align-items:center;gap:8px;white-space:nowrap}.ar .agent-label{font-weight:600;font-size:13px;letter-spacing:.1px}.ar .type-label{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa);padding:1px 6px;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:4px;white-space:nowrap}
.ar .state-active{color:var(--dsw-alias-state-business-primary,#a4b7ff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#a4b7ff) 12%,transparent)}.ar .state-paused{color:var(--dsw-alias-state-warn-label,#e8bd75);background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#e8bd75) 10%,transparent)}.ar .state-ended{color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-bg-layer-1,#252525)}
.ar .subscription-state{white-space:nowrap}.ar .frequency-cell{white-space:nowrap}.ar .start-time{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary,#aaa)}.ar .expiry{white-space:nowrap}.ar .message-cell{min-width:100px}
.ar .drawer select{width:100%;min-height:40px}.ar .drawer option{background:var(--dsw-alias-bg-layer-1,#202020);color:var(--dsw-alias-label-primary,#eee)}
@media(max-width:700px){.ar header{padding:18px 16px;align-items:flex-start}.ar .body{padding:16px}.ar .drawer{padding:20px}.ar .detail{grid-template-columns:90px minmax(0,1fr)}}
`;

// 抽屉统一支持 Escape、焦点圈定与关闭后焦点恢复。
function Drawer({ title, onClose, children }: any) {
  const ref = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current;
    if (!root) return;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        ),
      );
    focusable()[0]?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
      if (e.key === "Tab") {
        const list = focusable(),
          first = list[0],
          last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    root.addEventListener("keydown", keydown);
    return () => {
      root.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return h(
    "div",
    {
      className: "overlay",
      onMouseDown: (e: any) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      },
    },
    h(
      "section",
      {
        className: "drawer",
        role: "dialog",
        "aria-modal": true,
        "aria-label": title,
        ref,
      },
      h(
        "div",
        { className: "row between" },
        h("h2", null, title),
        h("button", { onClick: onClose, "aria-label": "关闭" }, "关闭"),
      ),
      children,
    ),
  );
}

export function AgentRelayPanel({ rpc, openSession }: PanelProps) {
  const [routes,setRoutes]=useState<any[]>([]),[routeCursor,setRouteCursor]=useState<string|null>(null),[routeNext,setRouteNext]=useState<string|null>(null),[routeError,setRouteError]=useState("");
  const [items, setItems] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState({ agent: "", status: "", type: "" }),
    [cursor, setCursor] = useState<any>(null),
    [next, setNext] = useState<any>(null);
  const [drawer, setDrawer] = useState(""),
    [selected, setSelected] = useState("");
  const [agent, setAgent] = useState("claude"),
    [external, setExternal] = useState(""),
    [target, setTarget] = useState(""),
    [topic, setTopic] = useState("");
  const [candidates, setCandidates] = useState<any[]>([]),
    [targets, setTargets] = useState<any[]>([]),
    [candidateLoading, setCandidateLoading] = useState(false),
    [candidateError, setCandidateError] = useState("");
  const [capabilities, setCapabilities] = useState<any[]>([]);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [inspecting, setInspecting] = useState(false);
  const [failures, setFailures] = useState("3");
  const [conflict, setConflict] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]), [eventNext, setEventNext] = useState<number | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false), [eventsError, setEventsError] = useState("");
  const [recoveredBatch, setRecoveredBatch] = useState<any>(null);
  const eventsGen = useRef(0);
  const [message, setMessage] = useState("");
  const [candidateRevision, setCandidateRevision] = useState(0);
  const [installAgent, setInstallAgent] = useState("claude");
  const [installBusy, setInstallBusy] = useState(false);
  const [setupReport, setSetupReport] = useState<any>(null);
  const [probe, setProbe] = useState<any>(null);
  const [installError, setInstallError] = useState("");
  const [setupMessage, setSetupMessage] = useState("");
  const revision = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  // 查阅代次：关闭/切换/卸载时递增，过期响应不得更新界面。
  const inspectGen = useRef(0);
  const creating = drawer === "create";
  const current = drawer==="route"?routes.find(route=>route.id===selected):items.find((s) => s.id === selected);
  const close = () => {
    inspectGen.current++;
    eventsGen.current++;
    setConflict(null);
    setInspecting(false);
    setDrawer("");
  };
  async function call(endpoint: string, payload: unknown = {}) {
    const response = await rpc.call("/api", `agent-relay/${endpoint}`, payload);
    if (!response.ok) throw Object.assign(Error(response.error?.message ?? "操作失败"), response.error);
    return response.value;
  }
  async function refresh() {
    const version = ++revision.current;
    setLoading(true);
    try {
      const result = await call("list", {
        ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)),
        cursor,
        limit: 10,
      });
      if (version === revision.current) {
        setItems(result.items);
        setNext(result.next_cursor);
        setError("");
      }
    } catch (e) {
      if (version === revision.current) setError((e as Error).message);
    } finally {
      if (version === revision.current) setLoading(false);
    }
  }
  useEffect(()=>{let live=true;void call("routes",{cursor:routeCursor,limit:20}).then(page=>{if(live){setRoutes(page?.items??[]);setRouteNext(page?.next_cursor??null);setRouteError("");}}).catch(e=>{if(live)setRouteError(e.message);});return()=>{live=false;};},[routeCursor,refreshVersion]);
  useEffect(() => {
    void refresh();
    return () => {
      revision.current++;
    };
  }, [filter, cursor, refreshVersion]);
  useEffect(() => () => {
    // 卸载时使在途查阅响应失效。
    inspectGen.current++;
    eventsGen.current++;
  }, []);
  useEffect(() => {
    if (!creating) return;
    let live = true;
    setCandidateLoading(true);
    setCandidateError("");
    setCandidates([]);
    setTargets([]);
    setExternal("");
    void Promise.allSettled([
      call("sessions", { agent, limit: 100 }),
      call("dsh_sessions"),
    ])
      .then(([sessions, dsh]) => {
        if (live) {
          if (sessions.status === "fulfilled") setCandidates(sessions.value);
          if (dsh.status === "fulfilled") setTargets(dsh.value);
          setCandidateError([sessions, dsh].filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message ?? "读取会话失败").join("；"));
        }
      })
      .catch((e) => {
        if (live) setCandidateError((e as Error).message);
      })
      .finally(() => {
        if (live) setCandidateLoading(false);
      });
    return () => {
      live = false;
    };
  }, [creating, agent, candidateRevision]);
  useEffect(() => {
    void call("agents").then(setCapabilities).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (drawer !== "install") return;
    let live = true;
    setInstallError("");
    setSetupMessage("");
    setSetupReport(null);
    void call("setup_check", { agent: installAgent })
      .then((value) => {
        if (live) setSetupReport(value);
      })
      .catch((e) => {
        if (live) setInstallError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [drawer, installAgent]);
  // 连通测试进行中时每 2 秒刷新一次结果。
  useEffect(() => {
    if (drawer !== "install" || probe?.status !== "waiting") return;
    const timer = setInterval(() => {
      void call("setup_probe_status").then(setProbe).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [drawer, probe?.status]);
  useEffect(() => {
    if (drawer === "detail" && current?.agent === "codex") void inspect(current);
  }, [drawer, current?.id]);
  useEffect(() => {
    setEvents([]); setEventNext(null); setRecoveredBatch(null); setEventsError("");
    if ((drawer === "detail" || drawer === "route") && current) void loadEvents(current, 0);
    return () => { eventsGen.current++; };
  }, [drawer, current?.id]);
  async function loadEvents(sub: any, after: number) {
    const gen = ++eventsGen.current;
    setEventsLoading(true); setEventsError("");
    try {
      const value = await call("events", { ...(sub.kind==="route"?{agent:sub.agent,external_session_id:sub.external_session_id}:{subscription_id: sub.id}), after_sequence: after, limit: 20 });
      if (gen === eventsGen.current) { setEvents((previous) => after ? [...previous, ...value.items] : value.items); setEventNext(value.next_sequence); }
    } catch (e) { if (gen === eventsGen.current) setEventsError((e as Error).message); }
    finally { if (gen === eventsGen.current) setEventsLoading(false); }
  }
  async function readBatch(id: string) {
    const gen = ++eventsGen.current;
    setEventsLoading(true); setEventsError("");
    try { const value = await call("batch", { batch_id: id }); if (gen === eventsGen.current) setRecoveredBatch(value); }
    catch (e) { if (gen === eventsGen.current) setEventsError((e as Error).message); }
    finally { if (gen === eventsGen.current) setEventsLoading(false); }
  }
  const capability = (agent: string, key: string) =>
    capabilities.find((a) => a.agent === agent)?.capabilities?.[key] === true;
  function sendAllowed(sub: any) {
    if (!capability(sub.agent, "sendMessage")) return false;
    if (sub.agent !== "codex") return true;
    return snapshot?.agent === sub.agent && snapshot?.external_session_id === sub.external_session_id && snapshot.value.send_allowed === true;
  }
  function sendReason(sub: any) {
    if (sub.agent !== "codex") return "该 Agent 不支持发送消息或能力尚未加载";
    return snapshot?.external_session_id === sub.external_session_id ? snapshot.value.send_reason || "请查阅最新状态后发送" : "请先查阅会话，核对是否支持发送";
  }
  async function inspect(sub: any) {
    const gen = ++inspectGen.current;
    const target = { agent: sub.agent, external_session_id: sub.external_session_id };
    setInspecting(true); setError(""); setSnapshot(null);
    try {
      const value = await call("inspect", { agent: target.agent, external_session_id: target.external_session_id });
      // 过期响应（已关闭/切换/卸载）不更新快照、busy、error 或触发刷新。
      if (gen === inspectGen.current) {
        setSnapshot({ agent: target.agent, external_session_id: target.external_session_id, value });
        setRefreshVersion((v) => v + 1);
      }
    } catch (e) { if (gen === inspectGen.current) setError((e as Error).message); }
    finally { if (gen === inspectGen.current) setInspecting(false); }
  }
  async function saveConfig(sub: any) {
    setBusy(true); setError("");
    try {
      await call("update", { subscription_id: sub.id, max_consecutive_failures: Number(failures) });
      setNotice("订阅配置已保存。"); setRefreshVersion((v) => v + 1); close();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function send(sub: any) {
    setBusy(true); setError("");
    try {
      const value = await call("send", { agent: sub.agent, external_session_id: sub.external_session_id,
        subscription_id: sub.id, content: message });
      setNotice(`消息${label(value.message.status)}${value.message.error ? `：${value.message.error}` : value.message.status === "queued" ? "；会话空闲后推送，Claude 确认后显示已确认。" : "；已发送不代表任务完成。"}`);
      setRefreshVersion((v) => v + 1); close(); setMessage("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function action(endpoint: string, id: string) {
    setBusy(true);
    setError("");
    try {
      const value = await call(endpoint, { subscription_id: id });
      setNotice(endpoint === "check" ? label(value.status) : "订阅已更新。");
      setRefreshVersion((version) => version + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stopCurrent(id: string) {
    setBusy(true);
    setError("");
    try {
      await call("stop", { subscription_id: id });
      setNotice("关注已结束；后续 push 仍送原会话，可单独屏蔽。");
      setRefreshVersion((version) => version + 1);
      setDrawer("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function createSubscription(payload: any) {
    {
      const current = await call("current", { agent: payload.agent, external_session_id: payload.external_session_id });
      const normalized = payload.topic?.trim() || "定期汇报新的进展或回复";
      if (current.subscription && (current.subscription.topic !== normalized || (payload.dsh_session_id && payload.dsh_session_id !== current.route?.dsh_session_id))) {
        setConflict({ current: current.subscription, payload });
        return;
      }
    }
    try {
      const value = await call("subscribe", payload);
      if (value.subscription?.status === "paused") {
        setConflict({ current: value.subscription, payload, paused: true });
        setNotice("原关注仍已暂停，定时检查尚未恢复；请选择继续关注或保持暂停。");
        setRefreshVersion((v) => v + 1);
        return;
      }
      setDrawer(""); setConflict(null);
      setNotice(value.subscription?.planning_state === "pending" ? "关注已保存，等待 DSH 按主题规划频率；最长 24 小时。" : value.schedule_ready ? "关注已保存，宿主提醒已就绪。" : "关注已保存，等待 DSH 判断或宿主提醒对账。");
      if (cursor) setCursor(null); else setRefreshVersion((v) => v + 1);
    } catch (e) {
      if ((e as any).code !== "conflict") throw e;
      const current = await call("current", { agent: payload.agent, external_session_id: payload.external_session_id });
      if (!current.subscription) throw e;
      setConflict({ current: current.subscription, payload });
    }
  }
  async function continueConflict() {
    if (!conflict) return;
    setBusy(true); setError("");
    try {
      const sub = conflict.current;
      if (sub.status === "paused") await call("resume", { subscription_id: sub.id });
      else if (sub.muted) await call("mute", { agent: sub.agent, external_session_id: sub.external_session_id, muted: false });
      setNotice("已继续原关注；保留原主题、接收会话与截止时间。");
      setRefreshVersion((v) => v + 1); close();
      if (sub.dsh_session_id) openSession(sub.dsh_session_id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function restartConflict() {
    if (!conflict) return;
    setBusy(true); setError("");
    try { await call("stop", { subscription_id: conflict.current.id }); await createSubscription(conflict.payload); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function resubscribe(sub: any) {
    setBusy(true); setError("");
    try {
      await createSubscription({ type: "poll", agent: sub.agent, external_session_id: sub.external_session_id,
        topic: sub.topic, max_consecutive_failures: sub.max_consecutive_failures });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function muteRoute(sub: any) {
    setBusy(true); setError("");
    try {
      await call("mute", { agent: sub.agent, external_session_id: sub.external_session_id, muted: !sub.muted });
      setRoutes(previous=>previous.map(route=>route.agent===sub.agent&&route.external_session_id===sub.external_session_id?{...route,muted:!sub.muted}:route));
      setNotice(sub.muted ? "已恢复接收 Agent 消息，原批次按原状态恢复。" : "已暂停接收 Agent 消息，事件仍保留；历史关注继续。");
      setRefreshVersion((v) => v + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function removeSubscription(sub: any) {
    setBusy(true);
    setError("");
    try {
      await call("delete_subscription", { subscription_id: sub.id });
      setNotice("订阅已删除。");
      if (selected === sub.id) {
        setSelected("");
        setDrawer("");
      }
      setRefreshVersion((version) => version + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cleanupOld() {
    setBusy(true);
    setError("");
    try {
      const value = await call("cleanup_subscriptions", {});
      setNotice(
        `已清理：删除订阅 ${value.subscriptions} 条、通知 ${value.notifications} 条、消息 ${value.messages} 条。`,
      );
      setCursor(null);
      setRefreshVersion((version) => version + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function runSetup(endpoint: "setup_check" | "setup_install" | "setup_uninstall") {
    setInstallBusy(true);
    setInstallError("");
    setSetupMessage("");
    try {
      const report = await call(endpoint, { agent: installAgent });
      setSetupReport(report);
      const changed = report.items.filter((i: any) => i.action && i.action !== "skipped" && i.action !== "none").length;
      if (endpoint === "setup_check") setSetupMessage("检查完成。");
      else if (endpoint === "setup_uninstall") setSetupMessage("已卸载 channel 配置，通知 Skill 保留。");
      else setSetupMessage(changed > 0 ? `安装完成，本次处理 ${changed} 项。` : "无需改动，所有项已就绪。");
    } catch (e) {
      setInstallError((e as Error).message);
    } finally {
      setInstallBusy(false);
    }
  }
  async function startProbe() {
    setInstallError("");
    try {
      setProbe(await call("setup_probe_start"));
    } catch (e) {
      setInstallError((e as Error).message);
    }
  }
  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createSubscription({ agent, external_session_id: external,
        ...(target ? { dsh_session_id: target } : {}), topic,
        max_consecutive_failures: Number(failures) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const setFilterField = (key: "agent" | "status" | "type", value: string) => {
    setFilter({ ...filter, [key]: value });
    setCursor(null);
  };
  const fieldSelect = (
    name: string,
    value: string,
    onChange: (v: string) => void,
    options: [string, string][],
    opts: { disabled?: boolean; required?: boolean } = {},
  ) =>
    h(
      "label",
      null,
      name,
      h(
        "select",
        {
          value,
          required: opts.required,
          disabled: opts.disabled,
          onChange: (e: any) => onChange(e.target.value),
        },
        ...options.map(([v, t]) => h("option", { key: v, value: v }, t)),
      ),
    );
  const fieldInput = (
    name: string,
    value: string,
    onChange: (v: string) => void,
    opts: { min: number; max: number },
  ) =>
    h(
      "label",
      null,
      name,
      h("input", {
        "aria-label": name,
        type: "number",
        min: opts.min,
        max: opts.max,
        required: true,
        value,
        onChange: (e: any) => onChange(e.target.value),
      }),
    );
  const filterSelect = (
    name: string,
    value: string,
    onChange: (v: string) => void,
    options: [string, string][],
  ) =>
    h(
      "select",
      {
        key: name,
        "aria-label": name,
        value,
        onChange: (e: any) => onChange(e.target.value),
      },
      ...options.map(([v, t]) => h("option", { key: v, value: v }, t)),
    );
  const controls = (sub: any, compact = false) =>
    h(
      "div",
      { className: "actions" },
      sub.dsh_session_id &&
        h(
          "button",
          {
            disabled: busy,
            title: "打开接收本次通知的 DSH 会话",
            onClick: () => {
              try {
                openSession(sub.dsh_session_id);
              } catch (e) {
                setError((e as Error).message);
              }
            },
          },
          "打开会话",
        ),
      !compact && sub.status === "active" &&
        sub.type === "poll" &&
        h(
          "button",
          {
            disabled: busy,
            title: "读取增量事实，由 DSH 按关注主题判断是否汇报或结束",
            onClick: () => void action("check", sub.id),
          },
          "立即检查",
        ),
      sub.status !== "ended" &&
        h(
          "button",
          {
            disabled: busy,
            onClick: () =>
              void action(sub.status === "paused" ? "resume" : "pause", sub.id),
          },
          sub.status === "paused" ? "继续关注" : "暂停",
        ),
      sub.status !== "ended" &&
        h(
          "button",
          {
            disabled: busy,
            onClick: () => {
              setSelected(sub.id);
              setDrawer("stop");
            },
          },
          "结束关注",
        ),
      !compact && h("button", {
        disabled: busy,
        title: sub.muted
          ? "恢复接收该外部会话的主动通知"
          : "暂停接收该外部会话的主动通知；保留已记录事件，不停止历史订阅检查",
        onClick: () => void muteRoute(sub),
      }, sub.muted ? "恢复接收 Agent 消息" : "暂停接收 Agent 消息"),
      // push 不进行历史检查；如需关注历史，通过新建关注显式开启。
      sub.status === "ended" &&
        sub.type === "poll" &&
        h(
          "button",
          {
            disabled: busy,
            onClick: () => void resubscribe(sub),
          },
          "重新订阅",
        ),
      !compact && h(
        "button",
        {
          disabled: busy,
          title: "删除该订阅及其关联通知与消息",
          onClick: () => {
            if (
              window.confirm(
                `删除订阅「${sub.external_session_title ?? sub.external_session_id}」及其关联通知与消息？此操作不可恢复。`,
              )
            )
              void removeSubscription(sub);
          },
        },
        "删除",
      ),
    );
  const renderRow = (sub: any) =>
    h(
      "tr",
      { key: sub.id },
      h(
        "td",
        null,
        h(
          "button",
          {
            className: "link title",
            onClick: () => {
              inspectGen.current++;
              setSelected(sub.id);
              setSnapshot(null);
              setDrawer("detail");
            },
          },
          sub.external_session_title ?? sub.external_session_id,
        ),
        sub.external_cwd &&
          h(
            "div",
            { className: "muted small path", title: sub.external_cwd },
            sub.external_cwd,
          ),
      ),
      h(
        "td",
        null,
        h(
          "div",
          { className: "agent-stack" },
          h("span", { className: "agent-label" }, agentName(sub.agent)),
          h("span", { className: "type-label" }, typeLabel(sub.type)),
        ),
      ),
      h(
        "td",
        { className: "subscription-state" },
        h("span", { className: `badge state-${sub.status}` }, label(sub.status)),
        h("div", { className: "small muted" }, planningText(sub)),
        sub.muted ? h("div", { className: "small warn" }, "push 已屏蔽") : null,
      ),
      h(
        "td",
        { className: "frequency-cell" },
        h("div", { className: "small muted" }, frequencyText(sub)),
      ),
      h(
        "td",
        { className: "start-time" },
        h(
          "time",
          {
            dateTime: new Date(sub.created_at).toISOString(),
            title: "北京时间（Asia/Shanghai）",
          },
          formatStart(sub.created_at),
        ),
      ),
      h("td", { className: "small expiry" }, expiryText(sub)),
      h(
        "td",
        null,
        h(
          "div",
          { className: `small ${sub.last_check_status === "error" ? "warn" : "muted"}` },
          checkText(sub),
        ),
      ),
      h(
        "td",
        { className: "message-cell" },
        h(
          "div",
          {
            className: `small ${deliveryTone(sub)}`,
            title: sub.notification?.delivery_error ?? "",
          },
          deliveryText(sub),
        ),
      ),
      h("td", null, controls(sub, true)),
    );
  const createDrawer = () =>
    h(
      Drawer,
      { title: "新建订阅", onClose: close },
      h(
        "form",
        { className: "fields", onSubmit: submit },
        h("p", { className: "muted" }, "选择需要关注的外部会话，结果将通知到 DSH。"),
        fieldSelect(
          "Agent",
          agent,
          (v) => {
            setAgent(v);
            setExternal("");
          },
          [
            ["claude", "Claude"],
            ["codex", "Codex"],
          ],
        ),
        agent === "codex" &&
          h(
            "div",
            { className: "notice muted small" },
            "选择已有的 Codex 桌面或 CLI 会话进行订阅，无需另建后台会话。订阅只查阅历史，不接管原会话。",
          ),
        fieldSelect(
          "外部会话",
          external,
          setExternal,
          [
            ["", candidateLoading ? "正在读取会话…" : "请选择外部会话"],
            ...candidates.map(
              (s) =>
                [s.id, `${s.title ?? "未命名"} · ${s.id}`] as [string, string],
            ),
          ],
          { disabled: candidateLoading },
        ),
        h("button", { type: "button", disabled: candidateLoading || busy, onClick: () => setCandidateRevision((value) => value + 1) }, "刷新会话列表"),
        (() => {
          const chosen = candidates.find((s) => s.id === external);
          return (
            chosen &&
            h(
              "div",
              { className: "notice small" },
              h("strong", null, chosen.title ?? "未命名"),
              chosen.cwd && h("p", { className: "muted" }, chosen.cwd),
              h("p", { className: "muted" }, `ID：${chosen.id}`),
            )
          );
        })(),
        fieldSelect(
          "接收通知的 DSH 会话",
          target,
          setTarget,
          [
            ["", "复用原接收会话（首次自动新建）"],
            ...targets.map((s) => [s.id, s.title] as [string, string]),
          ],
          {},
        ),
        h("label", null, "关注主题（可选）", h("input", { "aria-label": "关注主题（可选）", value: topic, maxLength: 1000, placeholder: "定期汇报新的进展或回复", onChange: (e: any) => setTopic(e.target.value) })),
        fieldInput("连续失败阈值", failures, setFailures, { min: 1, max: 100 }),
        candidateError &&
          h("p", { className: "error", role: "alert" }, candidateError),
        h(
          "p",
          { className: "muted small" },
          "关注最长 24 小时，从创建起计算，不因活动或暂停顺延。可在主题中说明频率，用户指定优先；未指定时由 DSH 选择并告知。无变化静默，单轮完成不自动结束关注。",
        ),
        h(
          "footer",
          null,
          h("button", { type: "button", onClick: close }, "取消"),
          h(
            "button",
            {
              className: "primary",
              type: "submit",
              disabled: busy || !external || candidateLoading,
            },
            busy ? "正在保存…" : "创建订阅",
          ),
        ),
      ),
    );
  const eventSection=(sub:any)=>h("section", { "aria-label": "事件与批次" },
        h("h2", null, "事件与批次"),
        h("p", { className: "muted small" }, "忙时事件排队合批；已送达仍需 DSH 判断。未知投递先核对，不盲目重发。"),
        eventsError && h("p", { role: "alert", className: "error" }, eventsError),
        ...events.map((event) => h("article", { key: event.id, className: "notice small" },
          h("p", null, `#${event.seq} · ${event.kind} · ${label(event.delivery_state)} · ${date(event.created_at)}`),
          h("details", null, h("summary", null, "事件标识与恢复信息"), h("p", { className: "muted" }, `事件 ${event.id} · 批次 ${event.batch_id ?? "待合批"} · 版本 ${event.decision_version ?? "—"}`)),
          h("p", { style: { whiteSpace: "pre-wrap" } }, event.body),
          event.batch_id && h("button", { disabled: eventsLoading, onClick: () => void readBatch(event.batch_id) }, "读取原批次"))),
        eventsLoading && h("p", null, "正在读取事件…"),
        !eventsLoading && !events.length && !eventsError && h("p", { className: "muted" }, "暂无事件"),
        eventNext !== null && h("button", { disabled: eventsLoading, onClick: () => void loadEvents(sub, eventNext) }, "更多事件"),
        recoveredBatch && h("div", { className: "notice" },
          h("p", null, `原批次：${label(recoveredBatch.status)}（读取事实不等于确认处理）`),
          recoveredBatch.batch_id && h("details", null, h("summary", null, "DSH 恢复指令"), h("p", null, `请调用 relay_batch({batch_id:"${recoveredBatch.batch_id}"}) 读取原事实，按原主题判断后用 relay_decide 确认，decision_version:${recoveredBatch.decision_version}。`)),
          ...(recoveredBatch.events ?? []).map((event: any) => h("p", { key: event.id, style: { whiteSpace: "pre-wrap" } }, event.body)),
          h("p", { className: "muted small" }, "打开原接收会话，由 DSH 使用 relay_batch 读取，再以原 batch_id 与 decision_version 调用 relay_decide。屏蔽中的批次请先解除屏蔽；待核对状态不能视为已处理。")));
  const routeControls=(route:any)=>h("div",{className:"row"},
    route.dsh_session_id&&h("button",{onClick:()=>openSession(route.dsh_session_id)},"打开原会话"),
    h("button",{disabled:busy,onClick:()=>void muteRoute(route)},route.muted?"恢复接收 Agent 消息":"暂停接收 Agent 消息"),
    !route.subscription&&h("button",{disabled:busy,onClick:()=>void resubscribe({...route,topic:"定期汇报新的进展或回复",max_consecutive_failures:3})},"开始关注"));
  const routeDrawer=(route:any)=>h(Drawer,{title:"会话路由",onClose:close},
    h("h2",null,route.external_session_id),h("p",{className:"muted"},`${agentName(route.agent)} · ${route.subscription?"已有关注":"仅接收 push，未开启关注"}`),
    h("p",null,"开始关注后最长 24 小时，检查频率由 DSH 按用户意图选择。停止关注或清理历史不删除此接收关系。"),
    routeControls(route),eventSection(route));
  const detailDrawer = (sub: any) =>
    h(
      Drawer,
      { title: "订阅详情", onClose: close },
      h(
        "div",
        null,
        h("h2", null, sub.external_session_title ?? sub.external_session_id),
        h(
          "p",
          { className: "muted small" },
          `${typeLabel(sub.type)} · ${agentName(sub.agent)}`,
        ),
      ),
      h(
        "dl",
        { className: "detail" },
        ...[
          ["订阅 ID", sub.id],
          ["外部会话 ID", sub.external_session_id],
          ["工作目录", sub.external_cwd ?? "—"],
          ["Agent / 类型", `${agentName(sub.agent)} / ${typeLabel(sub.type)}`],
          [
            "订阅状态",
            `${label(sub.status)}${sub.end_reason ? ` · ${label(sub.end_reason)}` : ""}`,
          ],
          ["关注主题", sub.topic ?? "定期汇报新的进展或回复"],
          ["DSH 调度状态", planningText(sub)],
          ["实际检查频率", frequencyText(sub)],
          ["Agent 消息接收", sub.muted ? "已暂停，事件保留" : "接收中"],
          ["开始时间", formatStart(sub.created_at)],
          [
            "有效期",
            `${expiryText(sub)}${sub.expires_at ? `（${date(sub.expires_at)}）` : ""}`,
          ],
          ["最近检查", checkText(sub)],
          ["会话消息", deliveryText(sub)],
          ["接收会话", sub.dsh_session_id ?? "—"],
          ...(sub.notification ? [["旧通知摘要", sub.notification.summary ?? "—"]] : []),
        ].flatMap(([k, v]) => [
          h("dt", { key: `${k}-k` }, k),
          h("dd", { key: k }, v),
        ]),
      ),
      h("div", { className: "row" },
        h("button", { disabled: busy || inspecting || !capability(sub.agent, "snapshot"),
          title: capability(sub.agent, "snapshot") ? "读取快照，不延长关注截止时间" : "该 Agent 不支持查阅或能力尚未加载",
          onClick: () => void inspect(sub) }, "查阅外部会话"),
        h("button", { disabled: busy || !sendAllowed(sub),
          title: sendAllowed(sub) ? "核对目标后发送" : sendReason(sub),
          onClick: () => { setMessage(""); setDrawer("send"); } }, "发送消息"),
        sub.status !== "ended" && h("button", { disabled: busy, onClick: () => {
          setFailures(String(sub.max_consecutive_failures)); setDrawer("edit");
        } }, "修改配置")),
      sub.agent === "codex" && !sendAllowed(sub) && h("p", { className: "muted small" }, inspecting ? "正在核对会话状态…" : sendReason(sub)),
      snapshot &&
        snapshot.agent === sub.agent &&
        snapshot.external_session_id === sub.external_session_id &&
        h("div", { className: "notice" },
          h("p", null, snapshot.value.closed ? "外部会话已关闭" : `运行状态：${snapshot.value.runtime ?? "unknown"}`),
          snapshot.value.runtime_error && h("p", null, snapshot.value.runtime_error),
          h("p", { style: { whiteSpace: "pre-wrap" } }, snapshot.value.last_reply ?? "暂无回复节选")),
      error && h("p", { role: "alert", className: "error" }, error),
      sub.last_check_error &&
        h("p", { className: "error" }, `检查失败：${sub.last_check_error}`),
      sub.notification?.delivery_error &&
        h(
          "p",
          { className: "error" },
          `通知投递：${sub.notification.delivery_error}`,
        ),
      sub.status === "active" &&
        sub.type === "poll" &&
        sub.planning_state === "ready" && !sub.schedule_task_id &&
        h("p", { className: "warn" }, "已选频率，宿主提醒尚未就绪，等待对账。"),
      eventSection(sub),
      sub.agent === "codex" &&
        h(
          "p",
          { className: "notice muted" },
          "订阅和查阅不要求会话可发送；发送能力以当前连接与会话检查结果为准，实时状态未知不代表任务完成。",
        ),
      h(
        "footer",
        null,
        sub.dsh_session_id &&
          h(
            "button",
            {
              onClick: () => {
                try {
                  openSession(sub.dsh_session_id);
                } catch (e) {
                  setError((e as Error).message);
                }
              },
            },
            "打开接收会话",
          ),
        controls(sub),
      ),
    );
  const stopDrawer = (sub: any) =>
    h(
      Drawer,
      { title: "结束关注", onClose: close },
      h("p", null, `停止关注「${sub.external_session_title ?? sub.external_session_id}」？`),
      h(
        "p",
        { className: "muted" },
        "结束后不再定时检查；后续 push 仍送原 DSH 会话且不会自动重启关注。若不想接收 push，请单独屏蔽。已在途或已送达消息不会撤回。",
      ),
      h(
        "footer",
        null,
        h("button", { onClick: close }, "取消"),
        h(
          "button",
          {
            className: "primary",
            disabled: busy,
            onClick: () => void stopCurrent(sub.id),
          },
          busy ? "正在停止…" : "结束关注",
        ),
      ),
    );
  const editDrawer = (sub: any) => h(Drawer, { title: "修改订阅配置", onClose: close },
    h("p", { className: "muted" }, "固定创建后 24 小时截止；检查频率交由 DSH 按主题及用户要求规划。"),
    fieldInput("连续失败阈值", failures, setFailures, { min: 1, max: 100 }),
    error && h("p", { role: "alert", className: "error" }, error),
    h("button", { disabled: busy, onClick: () => void saveConfig(sub) }, "保存"));
  const sendDrawer = (sub: any) => h(Drawer, { title: "发送消息", onClose: close },
    h("p", null, `目标：${agentName(sub.agent)} · ${sub.external_session_title ?? "未命名"}`),
    h("p", null, `会话 ID：${sub.external_session_id}`), h("p", null, `工作目录：${sub.external_cwd ?? "未知"}`),
    h("label", null, "消息", h("textarea", { value: message, rows: 5, maxLength: 500, onChange: (e: any) => setMessage(e.target.value) })),
    error && h("p", { role: "alert", className: "error" }, error),
    h("button", { disabled: busy || !message.trim() || !sendAllowed(sub), onClick: () => void send(sub) }, "确认目标并发送"));
  const SETUP_LABEL: Record<string, string> = {
    ok: "正常",
    missing: "未安装",
    outdated: "需更新",
    conflict: "冲突",
    unavailable: "不可用",
  };
  const SETUP_OVERALL: Record<string, string> = {
    ok: "已安装，无需重复操作",
    changed: "已完成安装或更新",
    needs_action: "部分项需要处理",
    unavailable: "当前环境不满足，未做改动",
  };
  const SETUP_ITEM: Record<string, string> = {
    claude: "Claude 命令",
    codex: "Codex 命令",
    channel_flag: "channel 支持",
    channel_server: "channel server",
    mcp: "MCP 登记",
    credential: "channel 凭证",
    notification: "通知凭证",
    rule: "Relay 规则",
    claude_md: "CLAUDE.md 引用",
    shell: "claude 函数",
    skill: "通知 Skill",
  };
  const installDrawer = () => h(Drawer, { title: "前置安装接入", onClose: close },
    h("p", { className: "muted" }, installAgent === "claude"
      ? "为 Claude 一次配好接入：通知 Skill（任务完成后通知 DSH）与 channel（把消息送进开在终端里的会话）。已正常的项不会改动，修改前自动备份。"
      : "为 Codex 一次配好接入：通知 Skill（任务完成后通知 DSH）。订阅可选择已有桌面或 CLI 会话，不需要 channel。已正常的项不会改动，修改前自动备份。"),
    fieldSelect("Agent", installAgent, (v) => {
      setInstallAgent(v);
      setSetupReport(null);
      setInstallError("");
      setSetupMessage("");
    }, [["claude", "Claude"], ["codex", "Codex"]]),
    !setupReport && !installError && h("p", { className: "muted" }, "正在检查安装状态…"),
    setupReport && h("div", { className: "notice small" },
      h("p", null, `${SETUP_OVERALL[setupReport.overall] ?? setupReport.overall}${setupReport.version ? ` · ${installAgent === "claude" ? "Claude Code" : "Codex"} ${setupReport.version}` : ""}`),
      h("ul", null, ...setupReport.items.map((item: any) =>
        h("li", { key: item.key, className: item.status === "ok" ? "" : item.status === "conflict" || item.status === "unavailable" ? "error" : "warn" },
          `${SETUP_ITEM[item.key] ?? item.key}：${SETUP_LABEL[item.status] ?? item.status} · ${item.message}`,
          item.backup ? h("span", { className: "muted" }, `（备份：${item.backup}）`) : null))),
      setupReport.sessions && h("p", { className: "muted" }, `已启用 channel 的会话：${setupReport.sessions.online} 个`),
      setupReport.next_steps?.length > 0 && h("div", null, h("p", null, "下一步："),
        h("ol", null, ...setupReport.next_steps.map((step: string, i: number) => h("li", { key: i }, step))))),
    installAgent === "claude" && probe && h("div", { className: "notice small" },
      probe.status === "waiting"
        ? h("div", null, h("p", null, "连通测试进行中，请按以下步骤操作："),
            h("ol", null, ...probe.instructions.map((step: string, i: number) => h("li", { key: i }, step))))
        : h("p", { className: probe.status === "acked" ? "" : "error" }, probe.message)),
    setupMessage && h("p", { role: "status", className: "good" }, setupMessage),
    installError && h("p", { role: "alert", className: "error" }, installError),
    h("footer", null,
      h("button", { disabled: installBusy, onClick: () => void runSetup("setup_check") }, "检查安装状态"),
      installAgent === "claude" && h("button", {
        disabled: installBusy || probe?.status === "waiting" || setupReport?.overall === "unavailable",
        onClick: () => void startProbe(),
      }, probe?.status === "waiting" ? "等待新会话…" : "连通测试"),
      installAgent === "claude" && h("button", {
        disabled: installBusy,
        onClick: () => {
          if (window.confirm("将删除 channel 配置（MCP 登记、规则、claude 函数、channel 凭证），通知 Skill 保留。继续？")) void runSetup("setup_uninstall");
        },
      }, "卸载 channel"),
      h("button", {
        className: "primary",
        disabled: busy || installBusy || setupReport?.overall === "unavailable",
        onClick: () => void runSetup("setup_install"),
      }, installBusy ? "正在处理…" : setupReport?.overall === "ok" ? "重新检查并修复" : "安装 / 修复")));
  return h(
    "div",
    {
      className: "ar",
      "data-dsh-plugin": "dsh-agent-relay",
      "data-dsh-part": "panel",
    },
    h("style", null, css),
    h(
      "header",
      null,
      h(
        "div",
        null,
        h("h1", null, "任务跟踪"),
        h("p", { className: "muted" }, "订阅外部 Agent 会话任务进度。"),
      ),
      h(
        "div",
        { className: "row" },
        h(
          "button",
          {
            onClick: () => {
              setInstallAgent("claude");
              setInstallError("");
              setSetupMessage("");
              setSetupReport(null);
              setProbe(null);
              setDrawer("install");
            },
          },
          "前置安装接入",
        ),
        h(
          "button",
          { className: "primary", onClick: () => { setTopic("");  setFailures("3"); setTarget(""); setError(""); setDrawer("create"); } },
          "新建订阅",
        ),
      ),
    ),
    h(
      "div",
      { className: "body" },
      error && h("div", { className: "error", role: "alert" }, error),
      notice && h("div", { className: "notice", role: "status" }, notice),
      h(
        "div",
        { className: "row between" },
        h("h2", null, "订阅"),
        h(
          "span",
          { className: "muted small" },
          `本页 ${items.length} 条${loading ? " · 加载中" : ""}`,
        ),
      ),
      h(
        "div",
        { className: "filters row" },
        filterSelect(
          "Agent 筛选",
          filter.agent,
          (v) => setFilterField("agent", v),
          [
            ["", "全部 Agent"],
            ["claude", "Claude"],
            ["codex", "Codex"],
          ],
        ),
        filterSelect(
          "类型筛选",
          filter.type,
          (v) => setFilterField("type", v),
          [
            ["", "全部类型"],
            ["poll", "主动订阅"],
            ["push", "主动通知"],
          ],
        ),
        filterSelect(
          "状态筛选",
          filter.status,
          (v) => setFilterField("status", v),
          [
            ["", "全部状态"],
            ["active", "订阅中"],
            ["paused", "已暂停"],
            ["ended", "已结束"],
          ],
        ),
        (filter.agent || filter.type || filter.status) &&
          h(
            "button",
            {
              onClick: () => {
                setFilter({ agent: "", status: "", type: "" });
                setCursor(null);
              },
            },
            "清除筛选",
          ),
        h(
          "button",
          { onClick: () => void refresh(), disabled: loading || busy },
          loading ? "加载中…" : "刷新",
        ),
        h(
          "button",
          {
            onClick: () => {
              if (
                window.confirm(
                  "删除所有创建超过 7 天的订阅数据（含关联通知与消息）？此操作不可恢复。",
                )
              )
                void cleanupOld();
            },
            disabled: loading || busy,
            title: "删除创建超过 7 天的订阅及其关联通知与消息",
          },
          "清理 7 天前",
        ),
      ),
      !loading && !error && !items.length
        ? h(
            "div",
            { className: "empty" },
            h("strong", null, "暂无订阅"),
            h("p", { className: "muted" }, "点击「新建订阅」开始关注一个外部会话。"),
          )
        : h(
            "div",
            { className: "table-wrap" },
            h(
              "table",
              null,
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  ...[
                    "外部会话",
                    "Agent / 类型",
                    "订阅状态",
                    "频率",
                    "开始时间",
                    "有效期",
                    "最近检查",
                    "会话消息",
                    "操作",
                  ].map((t) => h("th", { key: t, scope: "col" }, t)),
                ),
              ),
              h("tbody", null, ...items.map(renderRow)),
            ),
          ),
      h(
        "p",
        { className: "muted small" },
        "订阅状态、任务执行结果和通知投递结果分别记录；检查失败不代表任务失败。",
      ),
      h(
        "p",
        { className: "muted small" },
        "暂停接收 Agent 消息只暂停这个外部会话的主动通知投递：已记录事件会保留，历史订阅检查继续进行；恢复后继续接收。",
      ),
      (cursor || next) &&
        h(
          "div",
          { className: "row", style: { marginTop: 14 } },
          cursor &&
            h(
              "button",
              { onClick: () => setCursor(null), disabled: loading },
              "上一页",
            ),
          next &&
            h(
              "button",
              { onClick: () => setCursor(next), disabled: loading },
              "下一页",
            ),
        ),
    ),
    // 会话路由暂不在任务跟踪页展示；底层路由仍用于 push 投递和浏览器通知跳转。
    conflict && h(Drawer, { title: conflict.paused ? "原关注已暂停" : "已有关注主题", onClose: conflict.paused ? close : () => setConflict(null) },
      h("p", null, `当前关注：${conflict.current.topic}`),
      h("p", { className: "muted" }, conflict.paused
        ? "原关注仍已暂停；同主题订阅不会自动恢复定时检查。选择继续关注会恢复原关注并恢复接收 Agent 消息，截止时间保持不变。"
        : "同一外部会话只能有一个有效关注。继续将保留原主题和接收会话；停止重新来会结束原关注后创建新关注期。"),
      h("button", { disabled: busy, onClick: () => void continueConflict() }, conflict.paused ? "继续关注" : "继续原关注"),
      conflict.paused
        ? h("button", { disabled: busy, onClick: close }, "保持暂停")
        : h("button", { disabled: busy, onClick: () => void restartConflict() }, "停止重新来")),
    !conflict && drawer === "create" && createDrawer(),
    drawer === "detail" && current && detailDrawer(current),
    drawer === "stop" && current && stopDrawer(current),
    drawer === "edit" && current && editDrawer(current),
    drawer === "send" && current && sendDrawer(current),
    drawer === "install" && installDrawer(),
  );
}
// ---- 浏览器通知提醒（渠道抽象，后续可扩展 macOS / 飞书等） ----
interface NotifyChannel {
  available(): boolean;
  request(): Promise<boolean>;
  notify(title: string, body: string, open?:()=>void): void;
}

const browserNotifyChannel: NotifyChannel = {
  available: () => typeof Notification !== "undefined",
  async request() {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try {
      return (await Notification.requestPermission()) === "granted";
    } catch {
      return false;
    }
  },
  notify(title: string, body: string, open?:()=>void) {
    try {
      const notification=new Notification(title, { body });
      if(open)notification.onclick=()=>open();
    } catch {
      /* 通知弹窗失败时静默，不影响事件投递 */
    }
  },
};

const NOTIFY_STORAGE_KEY = "dsh-agent-relay:notify:lastSeen";
const NOTIFY_POLL_INTERVAL_MS = 30_000;

function notifyText(item: any) {
  const status = `${label(item.result)} · ${label(item.delivery_status)}`;
  const summary = String(item.summary ?? "").trim().slice(0, 200);
  return summary ? `${status}：${summary}` : status;
}

// 常驻轮询：侧边栏图标挂载期间，定时拉取 notify_poll 的新增通知并弹浏览器通知。
function useNotifyPolling(rpc: Rpc | undefined, openSession?: (id:string)=>void) {
  useEffect(() => {
    if (!rpc || !browserNotifyChannel.available()) return;
    const conn = rpc;
    let stopped = false;
    let polling = false;
    async function poll() {
      if (stopped || polling) return;
      polling = true;
      try {
        if (!(await browserNotifyChannel.request()) || stopped) return;
        const stored = localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "0";
        let cursor: { created_at: number; id?: string };
        try { const parsed = JSON.parse(stored); cursor = typeof parsed === "number" ? { created_at: parsed } : parsed; }
        catch { cursor = { created_at: 0 }; }
        if (!cursor || !Number.isFinite(cursor.created_at)) cursor = { created_at: 0 };
        const initial = cursor.created_at === 0;
        while (!stopped) {
          const result = await conn.call("/api", "agent-relay/notify_poll", {
            after: cursor.created_at, ...(cursor.id ? { after_id: cursor.id } : {}), limit: 50,
          });
          if (stopped || !result.ok || !Array.isArray(result.value) || !result.value.length) return;
          const items = result.value;
          if (!initial) for (const item of items) {
            if (item.delivery_status !== "muted") browserNotifyChannel.notify("Agent Relay 通知", notifyText(item),item.dsh_session_id&&openSession?()=>openSession(item.dsh_session_id):undefined);
          }
          const last = items[items.length - 1];
          const next = last.cursor ?? { created_at: last.created_at, id: last.id };
          if (next.created_at === cursor.created_at && next.id === cursor.id) return;
          cursor = next;
          localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(cursor));
          if (items.length < 50) return;
        }
      } catch { /* 下轮使用已持久化游标重试。 */ }
      finally { polling = false; }
    }
    void poll();
    const timer = setInterval(poll, NOTIFY_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [rpc,openSession]);
}

function AgentRelayIcon({ rpc,openSession }: { rpc: Rpc;openSession?:(id:string)=>void }) {
  useNotifyPolling(rpc,openSession);
  return h(
    "span",
    {
      "data-dsh-plugin": "dsh-agent-relay",
      "data-dsh-part": "sidebar-icon",
      "aria-label": "任务跟踪",
      title: "任务跟踪",
      style: {
        display: "inline-flex",
        width: "20px",
        height: "20px",
        alignItems: "center",
        justifyContent: "center",
      },
    },
    h(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: "20",
        height: "20",
        fill: "none",
        xmlns: "http://www.w3.org/2000/svg",
        "aria-hidden": "true",
        focusable: "false",
      },
      h("path", {
        d: "M5 7.5h3.5c2.1 0 3.5 1.2 3.5 3.2v2.6c0 2 1.4 3.2 3.5 3.2H19",
        stroke: "currentColor",
        strokeWidth: "1.8",
        strokeLinecap: "round",
      }),
      h("path", {
        d: "M5 16.5h3.5c2.1 0 3.5-1.2 3.5-3.2v-2.6c0-2-1.4-3.2-3.5-3.2H19",
        stroke: "currentColor",
        strokeWidth: "1.8",
        strokeLinecap: "round",
      }),
      h("circle", { cx: "5", cy: "7.5", r: "2", fill: "currentColor" }),
      h("circle", { cx: "5", cy: "16.5", r: "2", fill: "currentColor" }),
      h("circle", { cx: "19", cy: "7.5", r: "2", fill: "currentColor" }),
      h("circle", { cx: "19", cy: "16.5", r: "2", fill: "currentColor" }),
    ),
  );
}
interface RelayClientContext {
  slots: {
    inject(name: string, callback: () => () => void): () => void;
    register(options: unknown, component: unknown): () => void;
  };
  connection: { rpc: Rpc };
  uiWorkspace: { openSession(id: string): void };
}
export function apply(ctx: RelayClientContext): void {
  ctx.slots.inject("main", () =>
    ctx.slots.inject("sidebar.panellist", () => {
      const stopMain = ctx.slots.register(
        {
          name: "main",
          key: PANEL_ID,
          inject: () => ({
            rpc: ctx.connection.rpc,
            openSession: (id: string) => ctx.uiWorkspace.openSession(id),
          }),
        },
        AgentRelayPanel,
      );
      try {
        const stopIcon = ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 50,
            label: () => "任务跟踪",
            inject: () => ({ rpc: ctx.connection.rpc,openSession:(id:string)=>ctx.uiWorkspace.openSession(id) }),
          },
          AgentRelayIcon,
        );
        return () => {
          stopIcon();
          stopMain();
        };
      } catch (error) {
        stopMain();
        throw error;
      }
    }),
  );
}
