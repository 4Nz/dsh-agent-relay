import { createElement as h, useEffect, useState, useRef } from "react";

export const inject = ["slots", "connection", "uiWorkspace"];
const PANEL_ID = "agent-relay";
const labels: Record<string, string> = {
  active: "订阅中",
  paused: "已暂停",
  ended: "已结束",
  completed: "任务完成",
  failed: "失败",
  idle_timeout: "到期无新消息",
  expired: "已达最长时间",
  session_closed: "会话已关闭",
  unreachable: "无法访问",
  user_stopped: "手动停止",
  pending: "待投递",
  delivering: "投递中",
  delivered: "已送达",
  unknown: "结果未知",
  success: "成功",
  error: "检查失败",
  not_due: "未到期，已跳过",
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
  if (!sub.last_checked_at) return "尚未检查";
  const ago = relAgo(sub.last_checked_at);
  if (sub.last_check_status === "error")
    return `检查失败 ${sub.consecutive_failures}/${sub.max_consecutive_failures} · ${ago}`;
  return `检查成功 · ${ago}`;
};
const deliveryText = (sub: any) => {
  const n = sub.notification;
  if (!n) return "—";
  return label(n.delivery_status);
};
const deliveryTone = (sub: any) => {
  const s = sub.notification?.delivery_status;
  if (s === "delivered") return "good";
  if (s === "failed") return "bad";
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
.ar .filters{margin:18px 0}.ar .filters select{min-width:124px}.ar .table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:10px}.ar table{border-collapse:collapse;width:100%;min-width:1180px;text-align:left}.ar th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-bg-layer-1,#202020);white-space:nowrap}.ar th,.ar td{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#393939);vertical-align:middle}.ar tbody tr:last-child td{border-bottom:0}.ar tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover,#292929)}
.ar .link{background:transparent;border:0;padding:0;text-align:left;color:inherit}.ar .title{font-weight:500;max-width:270px;line-height:1.5}.ar .path{max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.ar .badge{display:inline-flex;padding:3px 8px;border-radius:5px;font-size:12px;font-weight:500;white-space:nowrap;border-color:transparent}.ar .good{color:var(--dsw-alias-state-business-primary,#a4b7ff)}.ar .bad{color:var(--dsw-alias-state-error-primary,#f28b82)}.ar .warn{color:var(--dsw-alias-state-warn-label,#e8bd75)}.ar .actions{display:flex;gap:8px;flex-wrap:nowrap;white-space:nowrap}.ar .actions button{font-size:12px;padding:4px 8px}.ar .empty{text-align:center;padding:60px 20px}.ar .empty strong{display:block;margin-bottom:8px}
.ar .overlay{position:fixed;inset:0;z-index:1000;background:#0007;display:flex;justify-content:flex-end}.ar .drawer{width:min(520px,100%);height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#181818);box-shadow:var(--dsw-elevation-prominent,-8px 0 32px #0004);padding:24px;display:flex;flex-direction:column;gap:20px}.ar .drawer footer{display:flex;justify-content:flex-end;gap:10px;margin-top:auto;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l2,#393939)}.ar label{display:flex;flex-direction:column;gap:7px}.ar .drawer .fields{display:grid;gap:14px}.ar .detail{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px}.ar .detail dt{color:var(--dsw-alias-label-secondary,#aaa)}.ar .detail dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.ar .error{color:var(--dsw-alias-state-error-primary,#f28b82)}
.ar select{appearance:none;padding:8px 36px 8px 13px;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary,#aaa) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary,#aaa) 50%,transparent 50%);background-position:calc(100% - 17px) 50%,calc(100% - 13px) 50%;background-size:4px 4px;background-repeat:no-repeat}
.ar .agent-stack{display:flex;align-items:center;gap:8px;white-space:nowrap}.ar .agent-label{font-weight:600;font-size:13px;letter-spacing:.1px}.ar .type-label{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa);padding:1px 6px;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:4px;white-space:nowrap}
.ar .state-active{color:var(--dsw-alias-state-business-primary,#a4b7ff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#a4b7ff) 12%,transparent)}.ar .state-paused{color:var(--dsw-alias-state-warn-label,#e8bd75);background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#e8bd75) 10%,transparent)}.ar .state-ended{color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-bg-layer-1,#252525)}
.ar .subscription-state{white-space:nowrap}.ar .start-time{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary,#aaa)}.ar .expiry{white-space:nowrap}.ar .message-cell{min-width:100px}
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
    [minutes, setMinutes] = useState("60");
  const [candidates, setCandidates] = useState<any[]>([]),
    [targets, setTargets] = useState<any[]>([]),
    [candidateLoading, setCandidateLoading] = useState(false),
    [candidateError, setCandidateError] = useState("");
  const revision = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const creating = drawer === "create";
  const current = items.find((s) => s.id === selected);
  const close = () => setDrawer("");
  async function call(endpoint: string, payload: unknown = {}) {
    const response = await rpc.call("/api", `agent-relay/${endpoint}`, payload);
    if (!response.ok) throw Error(response.error?.message ?? "操作失败");
    return response.value;
  }
  async function refresh() {
    const version = ++revision.current;
    setLoading(true);
    try {
      const result = await call("list", {
        ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)),
        cursor,
        limit: 30,
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
  useEffect(() => {
    void refresh();
    return () => {
      revision.current++;
    };
  }, [filter, cursor, refreshVersion]);
  useEffect(() => {
    if (!creating) return;
    let live = true;
    setCandidateLoading(true);
    setCandidateError("");
    setCandidates([]);
    setExternal("");
    void Promise.all([
      call("sessions", { agent, limit: 100 }),
      call("dsh_sessions"),
    ])
      .then(([sessions, dsh]) => {
        if (live) {
          setCandidates(sessions);
          setTargets(dsh);
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
  }, [creating, agent]);
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
      setNotice("订阅已停止。");
      setRefreshVersion((version) => version + 1);
      setDrawer("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const value = await call("subscribe", {
        agent,
        external_session_id: external,
        dsh_session_id: target,
        idle_timeout_seconds: Number(minutes) * 60,
      });
      setDrawer("");
      setNotice(
        value.schedule_ready
          ? "订阅已创建，定时检查已就绪。"
          : "订阅已保存，但定时提醒尚未建立；后台将继续对账。",
      );
      if (cursor) setCursor(null);
      else setRefreshVersion((version) => version + 1);
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
  const controls = (sub: any) =>
    h(
      "div",
      { className: "actions" },
      sub.status === "active" &&
        h(
          "button",
          {
            disabled: busy,
            title: "按有效期规则检查，未到期时跳过，不提前结束订阅",
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
          sub.status === "paused" ? "恢复" : "暂停",
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
          "停止",
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
              setSelected(sub.id);
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
      h("td", null, controls(sub)),
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
            "p",
            { className: "notice muted small" },
            "Codex 支持会话发现与快照查阅，暂不支持发送消息；daemon 不代表桌面会话实时状态。",
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
            ["", "请选择接收会话"],
            ...targets.map((s) => [s.id, s.title] as [string, string]),
          ],
          { required: true },
        ),
        fieldInput("有效期（分钟）", minutes, setMinutes, { min: 1, max: 1440 }),
        candidateError &&
          h("p", { className: "error", role: "alert" }, candidateError),
        h(
          "p",
          { className: "muted small" },
          "到期检查一次并发送结果摘要，随后订阅结束；默认最长关注 24 小时。",
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
              disabled: busy || !external || !target || candidateLoading,
            },
            busy ? "正在保存…" : "创建订阅",
          ),
        ),
      ),
    );
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
          ["开始时间", formatStart(sub.created_at)],
          [
            "有效期",
            `${expiryText(sub)}${sub.expires_at ? `（${date(sub.expires_at)}）` : ""}`,
          ],
          ["最近检查", checkText(sub)],
          ["会话消息", deliveryText(sub)],
          ["接收会话", sub.dsh_session_id ?? "—"],
          ["通知摘要", sub.notification?.summary ?? "尚未生成通知"],
        ].flatMap(([k, v]) => [
          h("dt", { key: `${k}-k` }, k),
          h("dd", { key: k }, v),
        ]),
      ),
      sub.last_check_error &&
        h("p", { className: "error" }, `检查失败：${sub.last_check_error}`),
      sub.notification?.delivery_error &&
        h(
          "p",
          { className: "error" },
          `通知投递：${sub.notification.delivery_error}`,
        ),
      sub.status === "active" &&
        !sub.schedule_task_id &&
        h("p", { className: "error" }, "定时检查尚未就绪，等待对账。"),
      sub.agent === "codex" &&
        h(
          "p",
          { className: "notice muted" },
          "Codex 暂不支持发送消息；daemon 运行状态未知不能视为任务完成。",
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
      { title: "停止订阅", onClose: close },
      h("p", null, `停止关注「${sub.external_session_title ?? sub.external_session_id}」？`),
      h(
        "p",
        { className: "muted" },
        "停止后不再检查，也不再接收该订阅的通知。不会停止外部 Agent 任务。",
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
          busy ? "正在停止…" : "停止订阅",
        ),
      ),
    );
  const settingsDrawer = () =>
    h(
      Drawer,
      { title: "共享通知凭证", onClose: close },
      h("p", null, "本地 Agent 共用一份通知凭证。正式接入后在 DSH 设置页面管理。"),
      h(
        "p",
        { className: "muted" },
        "服务端只保存摘要，生成时一次展示明文；重置后旧凭证失效。",
      ),
      h(
        "button",
        { disabled: true, title: "TODO(T2.6/T6.5)：接入凭证生成与重置服务" },
        "生成凭证（待接入）",
      ),
      h("footer", null, h("button", { onClick: close }, "关闭")),
    );
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
        h("h1", null, "Agent Relay"),
        h("p", { className: "muted" }, "关注外部 Agent 会话，接收一次结果通知。"),
      ),
      h(
        "div",
        { className: "row" },
        h("button", { onClick: () => setDrawer("settings") }, "通知凭证设置"),
        h(
          "button",
          { className: "primary", onClick: () => setDrawer("create") },
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
    drawer === "create" && createDrawer(),
    drawer === "detail" && current && detailDrawer(current),
    drawer === "stop" && current && stopDrawer(current),
    drawer === "settings" && settingsDrawer(),
  );
}
function AgentRelayIcon() {
  return h(
    "span",
    { "data-dsh-plugin": "dsh-agent-relay", "data-dsh-part": "sidebar-icon" },
    "🔗",
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
            label: () => "Agent Relay",
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
