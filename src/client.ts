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
const styles = `
.ar{height:100%;overflow:auto;padding:28px clamp(16px,4vw,48px);color:inherit;font:inherit;box-sizing:border-box}.ar *{box-sizing:border-box}.ar header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:26px}.ar h1{font-size:24px;letter-spacing:-.5px;margin:0 0 6px;font-weight:650}.ar p{margin:6px 0;opacity:.65;font-size:13px;line-height:1.7}.ar .ar-kicker{font-size:11px;letter-spacing:2px;opacity:.5;margin-bottom:10px}.ar button,.ar select,.ar input{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:7px;padding:8px 12px;min-height:36px}.ar button{cursor:pointer;white-space:nowrap}.ar button:hover:enabled{background:color-mix(in srgb,currentColor 7%,transparent)}.ar button:disabled{opacity:.4;cursor:default}.ar button:focus-visible,.ar select:focus-visible,.ar input:focus-visible{outline:2px solid #3b9b8b;outline-offset:3px}.ar .ar-primary{background:#216d60;color:#fff;border-color:#216d60}.ar .ar-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}.ar .ar-count{margin-left:auto;font-size:12px;opacity:.55}.ar article{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-left:3px solid #418b7c;border-radius:9px;padding:19px 20px;margin-bottom:12px}.ar article[data-status=ended]{border-left-color:color-mix(in srgb,currentColor 25%,transparent)}.ar article[data-status=paused]{border-left-color:#b98c49}.ar .ar-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.ar h2{font-size:15px;font-weight:600;margin:0 0 6px;overflow-wrap:anywhere}.ar code{font-size:11px;opacity:.55;overflow-wrap:anywhere}.ar .ar-badge{font-size:12px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:20px;padding:3px 9px;white-space:nowrap}.ar .ar-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:20px 0}.ar dt{font-size:11px;opacity:.5;margin-bottom:5px}.ar dd{margin:0;font-size:13px;line-height:1.6}.ar .ar-actions{display:flex;gap:8px;flex-wrap:wrap}.ar .ar-actions button{font-size:12px;padding:5px 10px;min-height:30px}.ar .ar-error{color:#c75b47;background:color-mix(in srgb,#c75b47 8%,transparent);border-radius:6px;padding:10px 12px;font-size:13px;overflow-wrap:anywhere;margin:12px 0}.ar .ar-notice{padding:12px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:6px;margin-bottom:16px;font-size:13px}.ar .ar-form{padding:22px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:10px;margin-bottom:24px}.ar .ar-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}.ar label{display:flex;flex-direction:column;gap:7px;font-size:12px}.ar select{width:100%}.ar option{background:Canvas;color:CanvasText}.ar .ar-empty{padding:60px 20px;text-align:center;border:1px dashed color-mix(in srgb,currentColor 20%,transparent);border-radius:10px}.ar .ar-summary{white-space:pre-wrap;margin:12px 0;font-size:13px;opacity:.7;line-height:1.65}@media(max-width:650px){.ar .ar-facts{grid-template-columns:1fr}.ar .ar-fields{grid-template-columns:1fr}.ar header{align-items:flex-start}.ar .ar-count{width:100%;margin-left:0}}
`;
export function AgentRelayPanel({ rpc, openSession }: PanelProps) {
  const [items, setItems] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState({ agent: "", status: "", type: "" }),
    [cursor, setCursor] = useState<any>(null),
    [next, setNext] = useState<any>(null);
  const [creating, setCreating] = useState(false),
    [agent, setAgent] = useState("claude"),
    [external, setExternal] = useState(""),
    [target, setTarget] = useState(""),
    [minutes, setMinutes] = useState("60");
  const [candidates, setCandidates] = useState<any[]>([]),
    [targets, setTargets] = useState<any[]>([]),
    [candidateLoading, setCandidateLoading] = useState(false),
    [candidateError, setCandidateError] = useState("");
  const revision = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
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
        if (live) setCandidateError(e.message);
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
      setNotice(endpoint === "check" ? label(value.status) : "订阅已更新");
      setRefreshVersion((version) => version + 1);
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
      setCreating(false);
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
  const select = (
    name: string,
    value: string,
    onChange: (v: string) => void,
    options: [string, string][],
    disabled = false,
  ) =>
    h(
      "label",
      null,
      name,
      h(
        "select",
        {
          "aria-label": name,
          value,
          disabled,
          onChange: (e: any) => onChange(e.target.value),
        },
        ...options.map(([id, title]) =>
          h("option", { key: id, value: id }, title),
        ),
      ),
    );
  return h(
    "section",
    {
      className: "ar",
      "data-dsh-plugin": "dsh-agent-relay",
      "data-dsh-part": "panel",
    },
    h("style", null, styles),
    h(
      "header",
      null,
      h(
        "div",
        null,
        h("div", { className: "ar-kicker" }, "AGENT RELAY / 主动订阅"),
        h("h1", null, "关注任务，接收结果"),
        h("p", null, "到期检查外部会话，向指定 DSH 会话发送一次结果摘要。"),
      ),
      h(
        "button",
        {
          className: "ar-primary",
          onClick: () => setCreating(!creating),
          disabled: busy,
        },
        creating ? "收起表单" : "＋ 新建订阅",
      ),
    ),
    creating &&
      h(
        "form",
        { className: "ar-form", onSubmit: submit },
        h("h2", null, "新建主动订阅"),
        h(
          "div",
          { className: "ar-fields" },
          select("Agent", agent, setAgent, [
            ["claude", "Claude"],
            ["codex", "Codex"],
          ]),
          select(
            "外部会话",
            external,
            setExternal,
            [
              ["", candidateLoading ? "正在读取会话…" : "请选择外部会话"],
              ...candidates.map(
                (s) =>
                  [s.id, `${s.title ?? "未命名"} · ${s.id}`] as [
                    string,
                    string,
                  ],
              ),
            ],
            candidateLoading,
          ),
          select("接收通知的 DSH 会话", target, setTarget, [
            ["", "请选择接收会话"],
            ...targets.map((s) => [s.id, s.title] as [string, string]),
          ]),
          h(
            "label",
            null,
            "有效期（分钟）",
            h("input", {
              "aria-label": "有效期（分钟）",
              type: "number",
              min: 1,
              max: 1440,
              required: true,
              value: minutes,
              onChange: (e: any) => setMinutes(e.target.value),
            }),
          ),
        ),
        candidateError &&
          h("div", { className: "ar-error", role: "alert" }, candidateError),
        external &&
          h(
            "p",
            null,
            `目标：${external} · ${candidates.find((s) => s.id === external)?.cwd ?? "未提供目录"}`,
          ),
        h(
          "p",
          null,
          agent === "codex"
            ? "Codex 支持会话发现与快照查阅，暂不支持发送消息；daemon 不代表桌面会话实时状态。"
            : "Claude 支持会话查阅；消息转发将在后续里程碑开放。",
        ),
        h(
          "p",
          null,
          "默认最长关注 24 小时。检查依赖 DSH 定时提醒唤醒模型执行。",
        ),
        h(
          "button",
          {
            className: "ar-primary",
            type: "submit",
            disabled: busy || !external || !target || candidateLoading,
          },
          busy ? "正在保存…" : "创建订阅",
        ),
      ),
    h(
      "div",
      { className: "ar-toolbar" },
      select(
        "Agent 筛选",
        filter.agent,
        (v) => {
          setFilter({ ...filter, agent: v });
          setCursor(null);
        },
        [
          ["", "全部 Agent"],
          ["claude", "Claude"],
          ["codex", "Codex"],
        ],
      ),
      select(
        "状态筛选",
        filter.status,
        (v) => {
          setFilter({ ...filter, status: v });
          setCursor(null);
        },
        [
          ["", "全部状态"],
          ["active", "订阅中"],
          ["paused", "已暂停"],
          ["ended", "已结束"],
        ],
      ),
      select(
        "类型筛选",
        filter.type,
        (v) => {
          setFilter({ ...filter, type: v });
          setCursor(null);
        },
        [
          ["", "全部类型"],
          ["poll", "主动订阅"],
          ["push", "主动通知"],
        ],
      ),
      h(
        "button",
        { onClick: () => void refresh(), disabled: loading || busy },
        loading ? "正在加载…" : "刷新",
      ),
      h("span", { className: "ar-count" }, `本页 ${items.length} 条`),
    ),
    error && h("div", { className: "ar-error", role: "alert" }, error),
    notice && h("div", { className: "ar-notice", role: "status" }, notice),
    !loading &&
      !error &&
      !items.length &&
      h(
        "div",
        { className: "ar-empty" },
        h("h2", null, "暂无订阅"),
        h("p", null, "选择一个外部会话，开始关注它的结果。"),
      ),
    ...items.map((sub) =>
      h(
        "article",
        { key: sub.id, "data-status": sub.status },
        h(
          "div",
          { className: "ar-row" },
          h(
            "div",
            null,
            h("h2", null, sub.external_session_title ?? "未命名会话"),
            h("code", null, `${sub.agent} / ${sub.external_session_id}`),
          ),
          h("span", { className: "ar-badge" }, label(sub.status)),
        ),
        h(
          "dl",
          { className: "ar-facts" },
          h(
            "div",
            null,
            h("dt", null, "有效期截止"),
            h("dd", null, date(sub.expires_at)),
          ),
          h(
            "div",
            null,
            h("dt", null, "最近检查"),
            h(
              "dd",
              null,
              `${label(sub.last_check_status)} · ${date(sub.last_checked_at)}`,
            ),
          ),
          h(
            "div",
            null,
            h("dt", null, "结果 / 通知"),
            h(
              "dd",
              null,
              `${label(sub.end_reason)} / ${label(sub.notification?.delivery_status)}`,
            ),
          ),
        ),
        sub.last_check_error &&
          h(
            "div",
            { className: "ar-error" },
            `检查失败：${sub.last_check_error}`,
          ),
        sub.notification?.delivery_error &&
          h(
            "div",
            { className: "ar-error" },
            `通知投递：${sub.notification.delivery_error}`,
          ),
        sub.status === "active" &&
          !sub.schedule_task_id &&
          h("div", { className: "ar-error" }, "定时检查尚未就绪，等待对账。"),
        sub.notification &&
          h(
            "details",
            null,
            h("summary", null, "查看结果摘要"),
            h("div", { className: "ar-summary" }, sub.notification.summary),
          ),
        h(
          "div",
          { className: "ar-actions" },
          sub.status === "active" &&
            h(
              "button",
              { disabled: busy, onClick: () => void action("pause", sub.id) },
              "暂停",
            ),
          sub.status === "paused" &&
            h(
              "button",
              { disabled: busy, onClick: () => void action("resume", sub.id) },
              "恢复",
            ),
          sub.status !== "ended" &&
            h(
              "button",
              { disabled: busy, onClick: () => void action("stop", sub.id) },
              "停止",
            ),
          sub.status === "active" &&
            h(
              "button",
              {
                disabled: busy,
                title: "执行一次检查；未到期时跳过，不提前结束订阅",
                onClick: () => void action("check", sub.id),
              },
              "检查一次",
            ),
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
        ),
        h(
          "p",
          null,
          `${sub.type === "poll" ? "主动订阅" : "主动通知"} · 订阅 ${sub.id}`,
        ),
      ),
    ),
    h(
      "div",
      { className: "ar-actions" },
      cursor &&
        h(
          "button",
          { onClick: () => setCursor(null), disabled: loading },
          "回到首页",
        ),
      next &&
        h(
          "button",
          { onClick: () => setCursor(next), disabled: loading },
          "下一页",
        ),
    ),
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
