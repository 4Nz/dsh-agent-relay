import { createElement as h, useEffect, useRef, useState } from "react";
import { initialSubscriptions, sessions, type Subscription } from "./demo.js";

const css = `
.ar{height:100%;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base,#141414);color:var(--dsw-alias-label-primary,#eee);font-family:inherit;font-size:14px;line-height:1.55;color-scheme:inherit}
.ar *{box-sizing:border-box}.ar button,.ar input,.ar select{font:inherit;color:inherit}.ar button{cursor:pointer}.ar button:disabled{cursor:not-allowed;opacity:.45}
.ar button,.ar input,.ar select{border:1px solid var(--dsw-alias-border-l2,#49494d);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#202020);padding:7px 11px}
.ar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#333)}.ar :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#a4b7ff);outline-offset:3px}
.ar .primary{background:var(--dsw-alias-button-ghost-active-fill,#4b4b51);border-color:var(--dsw-alias-button-ghost-active-border,#74747d)}
.ar .muted{color:var(--dsw-alias-label-secondary,#aaa)}.ar .small{font-size:12px}.ar header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:26px 28px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,#393939)}
.ar h1{font-size:20px;margin:0 0 4px;font-weight:600}.ar h2{font-size:18px;margin:0}.ar p{margin:6px 0}.ar .body{padding:20px 28px}.ar .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ar .between{justify-content:space-between}.ar .notice{padding:10px 14px;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:8px;margin-bottom:20px;background:var(--dsw-alias-bg-layer-1,#202020)}
.ar .filters{margin:18px 0}.ar .filters input{flex:1;min-width:180px}.ar .table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:10px}.ar table{border-collapse:collapse;width:100%;min-width:900px;text-align:left}.ar th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-bg-layer-1,#202020)}.ar th,.ar td{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#393939);vertical-align:top}.ar tbody tr:last-child td{border-bottom:0}.ar tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover,#292929)}
.ar .link{background:transparent;border:0;padding:0;text-align:left;color:inherit}.ar .title{font-weight:500;max-width:270px}.ar .path{max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.ar .badge{display:inline-flex;padding:2px 8px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,#292929);border:1px solid var(--dsw-alias-border-l2,#444);font-size:12px;white-space:nowrap}.ar .good{color:var(--dsw-alias-state-business-primary,#a4b7ff)}.ar .bad{color:var(--dsw-alias-state-error-primary,#f28b82)}.ar .warn{color:var(--dsw-alias-state-warn-label,#e8bd75)}.ar .actions{display:flex;gap:8px;flex-wrap:wrap}.ar .actions button{font-size:12px;padding:4px 8px}.ar .empty{text-align:center;padding:60px 20px}.ar .empty strong{display:block;margin-bottom:8px}
.ar .overlay{position:fixed;inset:0;z-index:1000;background:#0007;display:flex;justify-content:flex-end}.ar .drawer{width:min(520px,100%);height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#181818);box-shadow:var(--dsw-elevation-prominent,-8px 0 32px #0004);padding:24px;display:flex;flex-direction:column;gap:20px}.ar .drawer footer{display:flex;justify-content:flex-end;gap:10px;margin-top:auto;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l2,#393939)}.ar label{display:flex;flex-direction:column;gap:7px}.ar .fields{display:grid;gap:18px}.ar .detail{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px}.ar .detail dt{color:var(--dsw-alias-label-secondary,#aaa)}.ar .detail dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.ar .error{color:var(--dsw-alias-state-error-primary,#f28b82)}.ar .toast{position:sticky;bottom:18px;margin:18px auto 0;max-width:650px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#272727)}

.ar select{appearance:none;padding:8px 36px 8px 13px;min-width:124px;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary,#aaa) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary,#aaa) 50%,transparent 50%);background-position:calc(100% - 17px) 50%,calc(100% - 13px) 50%;background-size:4px 4px;background-repeat:no-repeat}
.ar table{min-width:1180px}.ar th{white-space:nowrap}.ar td{vertical-align:middle}.ar .agent-stack{display:flex;align-items:center;gap:8px;white-space:nowrap}.ar .agent-label{font-weight:600;font-size:13px;letter-spacing:.1px}.ar .type-label{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa);padding:1px 6px;border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:4px;white-space:nowrap}
.ar .badge{border-color:transparent;padding:3px 8px;font-weight:500}.ar .state-active{color:var(--dsw-alias-state-business-primary,#a4b7ff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#a4b7ff) 12%,transparent)}.ar .state-paused{color:var(--dsw-alias-state-warn-label,#e8bd75);background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#e8bd75) 10%,transparent)}.ar .state-ended{color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-bg-layer-1,#252525)}
.ar .result-label{display:inline;margin-left:8px;font-size:12px;line-height:1.5;white-space:nowrap}.ar .subscription-state{white-space:nowrap}.ar .start-time{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary,#aaa)}.ar .expiry{white-space:nowrap}.ar .message-cell{min-width:100px}.ar .actions{flex-wrap:nowrap;white-space:nowrap}.ar .title{line-height:1.5}

.ar textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#202020);border:1px solid var(--dsw-alias-border-l2,#49494d);border-radius:var(--dsw-radius-md,8px);padding:10px 12px;resize:vertical;min-height:100px;width:100%}.ar .subscription-kind{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#202020);border:1px solid var(--dsw-alias-border-l2,#393939);border-radius:8px}.ar .drawer .fields{gap:14px}.ar .drawer select{width:100%;min-height:40px}.ar .drawer option{background:var(--dsw-alias-bg-layer-1,#202020);color:var(--dsw-alias-label-primary,#eee)}
@media(max-width:700px){.ar header{padding:18px 16px;align-items:flex-start}.ar .body{padding:16px}.ar .filters select{flex:1}.ar .drawer{padding:20px}.ar .detail{grid-template-columns:90px minmax(0,1fr)}}
`;
const formatStart = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
const resultTone = (value: string) =>
  value === "completed" || value === "delivered"
    ? "good"
    : value === "failed" || value === "unreachable"
      ? "bad"
      : "warn";
const statusName = { active: "订阅中", paused: "已暂停", ended: "已结束" };
const resultName = {
  completed: "任务完成",
  failed: "任务执行失败",
  idle_timeout: "到期结束 · 未确认完成",
  expired: "已达最长存活时间",
  session_closed: "外部会话已关闭",
  unreachable: "无法访问会话",
  user_stopped: "手动停止",
  delivered: "通知已送达",
};
const agentName = (agent: string) => (agent === "claude" ? "Claude" : "Codex");
const option = (value: string, text: string) =>
  h("option", { value, key: value }, text);

// 抽屉统一支持 Escape、焦点圈定与关闭后焦点恢复。
function Drawer({ title, onClose, children }: any) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current as HTMLElement;
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
        onClose();
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
        if (e.target === e.currentTarget) onClose();
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

function CreateSubscription({ onClose, onCreate }: any) {
  const [agent, setAgent] = useState("claude"),
    [action, setAction] = useState("report"),
    [customAction, setCustomAction] = useState(""),
    [session, setSession] = useState(""),
    [receiver, setReceiver] = useState(""),
    [hours, setHours] = useState("1"),
    [error, setError] = useState("");
  const target = sessions.find((s) => s.id === session);
  const submit = (e: any) => {
    e.preventDefault();
    if (
      !target ||
      (action === "custom" && !customAction.trim()) ||
      !Number.isFinite(Number(hours)) ||
      Number(hours) <= 0 ||
      Number(hours) > 24
    ) {
      setError(
        "请选择目标会话，填写自定义动作（如有），有效期须大于 0 且不超过 24 小时。",
      );
      return;
    }
    // TODO(T4/T2.3)：先按需创建 DSH 接收会话，取得真实 ID 后再建立 poll 订阅。
    // TODO(T2/T4)：定义并持久化汇报/自定义动作契约；此处仅保留演示配置，不执行动作。
    onCreate({
      id: `demo-${crypto.randomUUID()}`,
      agent,
      type: "poll",
      action,
      customAction: action === "custom" ? customAction.trim() : "",
      title: target.title,
      cwd: target.cwd,
      externalId: target.id,
      status: "active",
      result: "",
      check: "尚未检查",
      delivery: "尚未生成",
      receiver: receiver || "新建会话",
      expires: `约 ${hours} 小时后`,
      createdAt: new Date().toISOString(),
      summary: "",
    });
  };
  return h(
    Drawer,
    { title: "新建订阅", onClose },
    h(
      "form",
      { onSubmit: submit, className: "fields" },
      h(
        "p",
        { className: "muted" },
        "选择需要关注的外部会话，结果将通知到 DSH。",
      ),
      h(
        "label",
        null,
        "Agent",
        h(
          "select",
          {
            value: agent,
            onChange: (e: any) => {
              setAgent(e.target.value);
              setSession("");
            },
          },
          option("claude", "Claude"),
          option("codex", "Codex"),
        ),
      ),
      agent === "codex" &&
        h(
          "p",
          { className: "notice muted small" },
          "Codex 支持会话发现和快照查阅，暂不支持发送消息。当前为模拟能力展示，本页面尚未连接真实会话。",
        ),
      h(
        "label",
        null,
        "外部会话",
        h(
          "select",
          {
            value: session,
            required: true,
            onChange: (e: any) => setSession(e.target.value),
          },
          option("", "请选择会话"),
          ...sessions
            .filter((s) => s.agent === agent)
            .map((s) => option(s.id, s.title)),
        ),
      ),
      target &&
        h(
          "div",
          { className: "notice small" },
          h("strong", null, target.title),
          h("p", { className: "muted" }, target.cwd),
          h("p", { className: "muted" }, `ID：${target.id}`),
        ),
      h(
        "div",
        { className: "subscription-kind" },
        h("span", { className: "muted small" }, "订阅类型"),
        h("span", { className: "badge state-active" }, "主动订阅"),
      ),
      h(
        "p",
        { className: "muted small" },
        "到期后检查会话，不保证即时发现任务完成。",
      ),
      h(
        "label",
        null,
        "动作",
        h(
          "select",
          {
            value: action,
            onChange: (e: any) => setAction(e.target.value),
          },
          option("report", "汇报"),
          option("custom", "自定义动作"),
        ),
      ),
      action === "report"
        ? h(
            "p",
            { className: "muted small" },
            "将外部会话的结果摘要汇报到接收会话。",
          )
        : h(
            "label",
            null,
            "动作说明",
            h("textarea", {
              value: customAction,
              required: true,
              maxLength: 4000,
              rows: 4,
              placeholder:
                "例如：根据结果摘要整理下一步待办，并在接收会话中汇报。",
              onChange: (e: any) => setCustomAction(e.target.value),
            }),
            h(
              "span",
              { className: "muted small" },
              "描述收到结果后希望 DSH 执行的动作。演示页面仅保存说明，不执行。",
            ),
          ),
      h(
        "label",
        null,
        "接收会话",
        h(
          "select",
          {
            value: receiver,
            onChange: (e: any) => setReceiver(e.target.value),
          },
          option("", "新建会话"),
          option("Relay 开发跟进", "Relay 开发跟进"),
          option("文档整理", "文档整理"),
        ),
      ),
      h(
        "p",
        { className: "muted small" },
        receiver
          ? "结果将发送到所选 DSH 会话。"
          : "默认新建 DSH 会话，用于接收此次订阅的结果。",
      ),
      h(
        "label",
        null,
        "有效期（小时）",
        h("input", {
          type: "number",
          min: "0.01",
          max: "24",
          step: "any",
          required: true,
          value: hours,
          onChange: (e: any) => setHours(e.target.value),
        }),
      ),
      h(
        "p",
        { className: "muted small" },
        "默认 1 小时；通过 Relay 查阅或发送消息会顺延，最长存活 24 小时。",
      ),
      error && h("p", { className: "error", role: "alert" }, error),
      h(
        "footer",
        null,
        h("button", { type: "button", onClick: onClose }, "取消"),
        h("button", { className: "primary", type: "submit" }, "创建演示订阅"),
      ),
    ),
  );
}

export function AgentRelayPanel() {
  const [items, setItems] = useState(initialSubscriptions),
    [agent, setAgent] = useState(""),
    [type, setType] = useState(""),
    [status, setStatus] = useState(""),
    [search, setSearch] = useState(""),
    [drawer, setDrawer] = useState(""),
    [selected, setSelected] = useState(""),
    [toast, setToast] = useState("");
  const current = items.find((s) => s.id === selected);
  const filtered = items.filter(
    (s) =>
      (!agent || s.agent === agent) &&
      (!type || s.type === type) &&
      (!status || s.status === status) &&
      `${s.title} ${s.cwd} ${s.externalId}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  const close = () => setDrawer("");
  const act = (s: Subscription, action: string) => {
    // TODO(T4)：调用共享服务层的暂停、恢复、停止接口；失败时保留原状态并展示错误。
    setItems(
      items.map((item) =>
        item.id === s.id
          ? {
              ...item,
              status: action,
              result: action === "ended" ? "user_stopped" : "",
              expires:
                action === "paused"
                  ? "已暂停"
                  : action === "ended"
                    ? "已结束"
                    : "约 1 小时后",
            }
          : item,
      ),
    );
    setToast("已更新演示状态；未操作真实订阅或外部 Agent。");
  };
  const controls = (s: Subscription) =>
    h(
      "div",
      { className: "actions" },
      s.status === "active" &&
        h(
          "button",
          {
            title: "按有效期规则检查，不强制结束订阅",
            onClick: () => {
              // TODO(T4/T2.4)：调用检查接口，遵循 expires_at 与 hard_expires_at。
              setToast(
                "演示：立即检查将按有效期规则执行；尚未连接后端，未检查真实会话。",
              );
            },
          },
          "立即检查",
        ),
      s.status !== "ended" &&
        h(
          "button",
          {
            onClick: () => act(s, s.status === "paused" ? "active" : "paused"),
          },
          s.status === "paused" ? "恢复" : "暂停",
        ),
      s.status !== "ended" &&
        h(
          "button",
          {
            onClick: () => {
              setSelected(s.id);
              setDrawer("stop");
            },
          },
          "停止",
        ),
    );
  const detail =
    current &&
    h(
      Drawer,
      { title: "订阅详情", onClose: close },
      h(
        "div",
        null,
        h("h2", null, current.title),
        h("p", { className: "muted small" }, "演示记录"),
      ),
      h(
        "dl",
        { className: "detail" },
        ...[
          ["订阅 ID", current.id],
          ["外部会话 ID", current.externalId],
          ["工作目录", current.cwd],
          ["Agent / 类型", `${agentName(current.agent)} / ${current.type}`],
          [
            "订阅状态",
            `${statusName[current.status]}${current.result ? ` · ${resultName[current.result]}` : ""}`,
          ],
          ["开始时间", formatStart(current.createdAt)],
          ["有效期", current.expires],
          ["最近检查", current.check],
          ["会话消息", current.delivery],
          ["接收会话", current.receiver],
          ["动作", current.action === "custom" ? "自定义动作" : "汇报"],
          ...(current.action === "custom"
            ? [["动作说明", current.customAction || "—"]]
            : []),
          ["通知摘要", current.summary || "尚未生成通知"],
        ].flatMap(([key, value]) => [
          h("dt", { key: `${key}-k` }, key),
          h("dd", { key }, value),
        ]),
      ),
      current.agent === "codex" &&
        h(
          "p",
          { className: "notice muted" },
          "Codex 暂不支持发送消息。运行状态未知不能视为任务完成。",
        ),
      h(
        "footer",
        null,
        h(
          "button",
          {
            onClick: () =>
              setToast(
                "TODO：接入 DSH 原生会话导航。演示记录没有真实目标会话。",
              ),
          },
          "打开 DSH 会话（演示）",
        ),
        controls(current),
      ),
    );
  return h(
    "div",
    { className: "ar", "data-dsh-plugin": "dsh-agent-relay" },
    h("style", null, css),
    h(
      "header",
      null,
      h(
        "div",
        null,
        h("h1", null, "Agent Relay"),
        h(
          "p",
          { className: "muted" },
          "关注外部 Agent 会话，接收一次结果通知。",
        ),
      ),
      h(
        "button",
        { className: "primary", onClick: () => setDrawer("create") },
        "新建订阅",
      ),
    ),
    h(
      "div",
      { className: "body" },
      h(
        "div",
        { className: "notice row between" },
        h(
          "span",
          null,
          h("strong", null, "演示数据"),
          h(
            "span",
            { className: "muted" },
            " · 所有操作仅在本页生效，刷新后重置。",
          ),
        ),
        h("button", { onClick: () => setDrawer("settings") }, "通知凭证设置"),
      ),
      h(
        "div",
        { className: "row between" },
        h("h2", null, "订阅"),
        h(
          "span",
          { className: "muted small" },
          `共 ${items.length} 条 · ${items.filter((s) => s.status === "active").length} 条订阅中`,
        ),
      ),
      h(
        "div",
        { className: "filters row" },
        h("input", {
          "aria-label": "搜索外部会话",
          placeholder: "搜索会话标题、目录或 ID",
          value: search,
          onChange: (e: any) => setSearch(e.target.value),
        }),
        ...[
          [
            "Agent",
            agent,
            setAgent,
            [
              ["", "全部 Agent"],
              ["claude", "Claude"],
              ["codex", "Codex"],
            ],
          ],
          [
            "类型",
            type,
            setType,
            [
              ["", "全部类型"],
              ["poll", "主动订阅"],
              ["push", "主动通知"],
            ],
          ],
          [
            "状态",
            status,
            setStatus,
            [
              ["", "全部状态"],
              ["active", "订阅中"],
              ["paused", "已暂停"],
              ["ended", "已结束"],
            ],
          ],
        ].map(([label, value, set, options]: any) =>
          h(
            "select",
            {
              key: label,
              "aria-label": label,
              value,
              onChange: (e: any) => set(e.target.value),
            },
            ...options.map(([v, t]: string[]) => option(v, t)),
          ),
        ),
        (search || agent || type || status) &&
          h(
            "button",
            {
              onClick: () => {
                setSearch("");
                setAgent("");
                setType("");
                setStatus("");
              },
            },
            "清除筛选",
          ),
      ),
      filtered.length
        ? h(
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
              h(
                "tbody",
                null,
                ...filtered.map((s) =>
                  h(
                    "tr",
                    { key: s.id },
                    h(
                      "td",
                      null,
                      h(
                        "button",
                        {
                          className: "link title",
                          onClick: () => {
                            setSelected(s.id);
                            setDrawer("detail");
                          },
                        },
                        s.title,
                      ),
                      h(
                        "div",
                        { className: "muted small path", title: s.cwd },
                        s.cwd,
                      ),
                    ),
                    h(
                      "td",
                      null,
                      h(
                        "div",
                        { className: "agent-stack" },
                        h(
                          "span",
                          { className: `agent-label ${s.agent}` },
                          agentName(s.agent),
                        ),
                        h(
                          "span",
                          { className: "type-label" },
                          s.type === "poll" ? "主动订阅" : "主动通知",
                        ),
                      ),
                    ),
                    h(
                      "td",
                      { className: "subscription-state" },
                      h(
                        "span",
                        {
                          className: `badge state-${s.status}`,
                        },
                        statusName[s.status],
                      ),
                    ),
                    h(
                      "td",
                      { className: "start-time" },
                      h(
                        "time",
                        {
                          dateTime: s.createdAt,
                          title: "北京时间（Asia/Shanghai）",
                        },
                        formatStart(s.createdAt),
                      ),
                    ),
                    h("td", { className: "small expiry" }, s.expires),
                    h(
                      "td",
                      null,
                      h(
                        "div",
                        {
                          className: `small ${s.check.includes("失败") ? "warn" : "muted"}`,
                        },
                        s.check,
                      ),
                    ),
                    h(
                      "td",
                      { className: "message-cell" },
                      h(
                        "div",
                        {
                          title:
                            s.delivery === "尚未生成"
                              ? "尚未生成会话消息"
                              : s.delivery,
                          className: `small ${s.delivery === "投递失败" ? "bad" : "muted"}`,
                        },
                        s.delivery === "尚未生成" ? "—" : s.delivery,
                      ),
                    ),
                    h("td", null, controls(s)),
                  ),
                ),
              ),
            ),
          )
        : h(
            "div",
            { className: "empty" },
            h("strong", null, "没有匹配的订阅"),
            h(
              "p",
              { className: "muted" },
              "调整筛选条件，或创建一条演示订阅。",
            ),
          ),
      h(
        "p",
        { className: "muted small" },
        "订阅结束、任务执行结果和通知投递结果分别记录；检查失败不代表任务失败。",
      ),
      toast &&
        h(
          "div",
          { className: "toast row between", role: "status" },
          toast,
          h(
            "button",
            { "aria-label": "关闭提示", onClick: () => setToast("") },
            "关闭",
          ),
        ),
    ),
    drawer === "create" &&
      h(CreateSubscription, {
        onClose: close,
        onCreate: (s: Subscription) => {
          setItems([s, ...items]);
          setAgent("");
          setType("");
          setStatus("");
          setSearch("");
          close();
          setToast("演示订阅已创建，尚未连接后端。");
        },
      }),
    drawer === "detail" && detail,
    drawer === "stop" &&
      current &&
      h(
        Drawer,
        { title: "停止订阅", onClose: close },
        h("p", null, `停止关注「${current.title}」？`),
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
              onClick: () => {
                act(current, "ended");
                close();
              },
            },
            "停止演示订阅",
          ),
        ),
      ),
    drawer === "settings" &&
      h(
        Drawer,
        { title: "共享通知凭证", onClose: close },
        h("div", { className: "notice" }, "演示界面 · 尚未接入凭证服务"),
        h(
          "p",
          null,
          "本地 Agent 共用一份通知凭证。正式接入后在 DSH 设置页面管理。",
        ),
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
      ),
  );
}
