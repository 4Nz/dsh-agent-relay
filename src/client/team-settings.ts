import { createElement as h, useEffect, useRef, useState } from "react";
import type { TeamRelayPreset, TeamRelayRoute, TeamSettingsSnapshot, TeamAgentView, DoubaoAccessView, DoubaoAccessAction } from "../services/team-relay/types.js";

interface Rpc {
  call(channel: string, method: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
}
const names: Record<string, string> = { dsh: "DSH", codex: "Codex", claude: "Claude", doubao: "豆包", workbuddy: "WorkBuddy" };
export const TEAM_RELAY_SETTINGS_TITLE = "TeamRelay（实验）";
// 宿主切换设置项会卸载组件；按连接保留未保存草稿，不写入磁盘或跨宿主复用。
const drafts = new WeakMap<Rpc, { saved: TeamSettingsSnapshot; draft: TeamRelayPreset; editor: TeamRelayRoute | null }>();
const pendingSettings = new WeakMap<Rpc, Promise<TeamSettingsSnapshot>>();
const statusNames: Record<TeamAgentView["status"], string> = {
  builtin: "内置", detected: "已检测到", connected: "已连接", unavailable: "待检查",
  not_integrated: "待接入", unsupported: "暂未支持",
  signed_out: "未登录", logging_in: "等待登录", saved: "登录态已保存", expired: "登录已失效",
};
const style = `
.tr-settings{color:var(--dsw-alias-label-primary,#eee);font:14px/1.6 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px;box-sizing:border-box}
.tr-settings *{box-sizing:border-box}.tr-settings h2{font-size:20px;line-height:1.4;margin:0;font-weight:600}.tr-settings h3{font-size:15px;margin:0;font-weight:600}.tr-settings p{margin:6px 0}.tr-settings .tr-muted{color:var(--dsw-alias-label-secondary,#aaa);font-size:13px}.tr-settings .tr-head,.tr-settings .tr-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.tr-settings .tr-head{align-items:flex-start;margin-bottom:22px}.tr-settings .tr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tr-settings button,.tr-settings input,.tr-settings select,.tr-settings textarea{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#373737);padding:7px 11px;max-width:100%}.tr-settings button{cursor:pointer;white-space:nowrap}.tr-settings button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#444)}.tr-settings button:disabled{opacity:.45;cursor:not-allowed}.tr-settings :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#a4b7ff);outline-offset:3px}.tr-settings .tr-primary{background:var(--dsw-alias-label-primary,#eee);color:var(--dsw-alias-bg-base,#252525);border-color:transparent}.tr-settings .tr-primary:hover:not(:disabled){background:#ccc;color:#222}.tr-settings .tr-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2,#505050);margin-bottom:20px}.tr-settings .tr-tabs button{border:0;background:transparent;border-radius:0;padding:10px 14px;border-bottom:2px solid transparent}.tr-settings .tr-tabs button[aria-selected=true]{border-bottom-color:currentColor;font-weight:600}.tr-settings .tr-card{border:1px solid var(--dsw-alias-border-l2,#555);border-radius:12px;padding:16px;margin-bottom:12px}.tr-settings .tr-copy{flex:1;min-width:0;overflow-wrap:anywhere}.tr-settings .tr-card p{margin-bottom:0}.tr-settings .tr-card select{min-width:110px}.tr-settings .tr-badge{font-size:12px;border-radius:6px;padding:2px 8px;white-space:nowrap;background:var(--dsw-alias-bg-layer-1,#3e3e3e);color:var(--dsw-alias-label-secondary,#bbb)}.tr-settings .tr-good{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-state-success-tertiary,#28543c55)}.tr-settings .tr-note{border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#383838);font-size:13px;margin-bottom:16px}.tr-settings .tr-error{color:var(--dsw-alias-state-error-primary,#ffb4aa)}.tr-settings .tr-editor{margin:16px 0;padding:18px;border:1px solid var(--dsw-alias-state-business-primary,#97a8d8);border-radius:12px}.tr-settings .tr-fields{display:grid;gap:14px;margin:16px 0}.tr-settings label{display:grid;gap:6px}.tr-settings textarea{resize:vertical;width:100%;min-height:85px}.tr-settings fieldset{border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;margin:0;padding:12px}.tr-settings fieldset label{display:inline-flex;align-items:center;margin:4px 16px 4px 0}.tr-settings .tr-footer{display:flex;justify-content:space-between;gap:12px;align-items:center;padding-top:16px}.tr-settings a{color:inherit;text-underline-offset:3px}
@media(max-width:600px){.tr-settings{padding:16px}.tr-settings .tr-head{flex-wrap:wrap}.tr-settings .tr-row{flex-wrap:wrap}.tr-settings .tr-copy{flex-basis:100%}.tr-settings .tr-footer{align-items:flex-start;flex-wrap:wrap}}
`;

export function TeamRelaySettings({ rpc }: { rpc: Rpc }) {
  const cached = useRef(drafts.get(rpc));
  const [saved, setSaved] = useState<TeamSettingsSnapshot | null>(() => cached.current?.saved ?? null);
  const [draft, setDraft] = useState<TeamRelayPreset | null>(() => cached.current?.draft ?? null);
  const [agents, setAgents] = useState<TeamAgentView[]>([]);
  const [tab, setTab] = useState("types");
  const [editor, setEditor] = useState<TeamRelayRoute | null>(() => cached.current?.editor ?? null);
  const [loading, setLoading] = useState(!cached.current || pendingSettings.has(rpc));
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [agentError, setAgentError] = useState("");
  const [doubaoBusy, setDoubaoBusy] = useState(false);
  const agentRequest = useRef(0);
  const accessRequest = useRef(false);
  const [notice, setNotice] = useState(cached.current ? "已恢复尚未保存的修改。" : "");
  const alive = useRef(true);
  const dirty = !!draft && JSON.stringify(saved?.preset) !== JSON.stringify(draft);

  async function call<T>(endpoint: string, payload: unknown = {}): Promise<T> {
    const result = await rpc.call("/api", `agent-relay/${endpoint}`, payload);
    if (!result.ok) throw new Error(result.error?.message ?? "操作失败");
    return result.value as T;
  }
  function requestSettings(endpoint: string, payload: unknown = {}) {
    const request = call<TeamSettingsSnapshot>(endpoint, payload).then(value => {
      if (pendingSettings.get(rpc) === request) {
        drafts.delete(rpc);
        pendingSettings.delete(rpc);
      }
      return value;
    }, error => {
      if (pendingSettings.get(rpc) === request) pendingSettings.delete(rpc);
      throw error;
    });
    pendingSettings.set(rpc, request);
    return request;
  }
  async function receiveSettings(request: Promise<TeamSettingsSnapshot>, message = "") {
    try {
      const value = await request;
      if (alive.current) { setSaved(value); setDraft(structuredClone(value.preset)); setEditor(null); setNotice(message); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) { setLoading(false); setSaving(false); } }
  }
  async function load() {
    setLoading(true); setError("");
    await receiveSettings(requestSettings("team_settings"));
  }
  async function inspect() {
    const request = ++agentRequest.current;
    setChecking(true); setAgentError("");
    try { const result = await call<TeamAgentView[]>("team_agents"); if (alive.current && request === agentRequest.current) setAgents(result); }
    catch (e) { if (alive.current) setAgentError((e as Error).message); }
    finally { if (alive.current) setChecking(false); }
  }
  function updateDoubao(view: DoubaoAccessView) {
    setAgents(items => items.map(agent => agent.id === "doubao" ? { ...agent, status: view.state, message: view.message } : agent));
  }
  async function doubaoAction(action: DoubaoAccessAction) {
    if (accessRequest.current) return;
    accessRequest.current = true;
    ++agentRequest.current;
    setDoubaoBusy(true); setAgentError("");
    try {
      const view = await call<DoubaoAccessView>("team_doubao", { action });
      if (alive.current) updateDoubao(view);
    } catch (e) { if (alive.current) setAgentError((e as Error).message); }
    finally { accessRequest.current = false; if (alive.current) setDoubaoBusy(false); }
  }
  const loggingIn = agents.some(agent => agent.id === "doubao" && agent.status === "logging_in");
  useEffect(() => {
    if (!loggingIn) return;
    let stopped = false, pending = false;
    const timer = setInterval(async () => {
      if (pending || accessRequest.current) return;
      pending = true;
      const request = agentRequest.current;
      try {
        const view = await call<DoubaoAccessView>("team_doubao", { action: "status" });
        if (!stopped && alive.current && request === agentRequest.current) updateDoubao(view);
      } catch { if (!stopped && alive.current) setAgentError("登录状态读取失败，请重新检测。"); }
      finally { pending = false; }
    }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [rpc, loggingIn]);
  useEffect(() => {
    alive.current = true;
    const request = pendingSettings.get(rpc);
    if (request) void receiveSettings(request);
    else if (!cached.current) void load();
    void inspect();
    return () => { alive.current = false; };
  }, [rpc]);
  useEffect(() => {
    if (saved && draft && (dirty || editor)) drafts.set(rpc, { saved, draft, editor });
    else drafts.delete(rpc);
  }, [rpc, saved, draft, editor, dirty]);
  useEffect(() => {
    if (!dirty && !editor) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, editor]);
  function change(next: TeamRelayPreset) { setDraft(next); setNotice(""); setError(""); }
  function updateRoute(route: TeamRelayRoute) {
    if (!draft) return;
    change({ ...draft, routes: draft.routes.map(item => item.id === route.id ? route : item) });
  }
  async function save() {
    if (!draft || !saved) return;
    setSaving(true); setError(""); setNotice("");
    await receiveSettings(requestSettings("team_settings_save", { preset: draft, revision: saved.revision }), "配置已保存，DSH 将读取这份类型配置。");
  }
  function applyEditor() {
    if (!editor || !draft) return;
    if (!editor.label.trim() || !editor.match.some(text => text.trim()) || !editor.preferred.length) {
      setError("请填写类型名称、适用说明，并选择至少一个 Agent。"); return;
    }
    const route = { ...editor, label: editor.label.trim(), match: editor.match.map(text => text.trim()).filter(Boolean) };
    change({ ...draft, routes: draft.routes.some(item => item.id === route.id)
      ? draft.routes.map(item => item.id === route.id ? route : item) : [...draft.routes, route] });
    setEditor(null);
  }
  const canSelect = (id: string) => agents.find(agent => agent.id === id)?.selectable ?? ["dsh", "codex", "claude"].includes(id);
  const agentLabel = (id: string) => {
    const agent = agents.find(item => item.id === id);
    return `${names[id] ?? id}${agent && !["builtin", "detected", "connected"].includes(agent.status) ? ` · ${statusNames[agent.status]}` : ""}`;
  };
  return h("section", { className: "tr-settings", "aria-label": "TeamRelay 设置" },
    h("style", null, style),
    h("div", { className: "tr-head" },
      h("div", null, h("h2", null, TEAM_RELAY_SETTINGS_TITLE), h("p", { className: "tr-muted" }, "你设定分工，DSH 负责分析、拆分与汇总。")),
      h("div", { className: "tr-actions" },
        h("span", { className: "tr-muted", role: "status" }, dirty || editor ? "有未保存的修改" : ""),
        h("button", { type: "button", className: "tr-primary", disabled: !dirty || saving || loading || !!editor, onClick: () => void save() }, saving ? "保存中…" : "保存配置"))),
    h("div", { className: "tr-note", "aria-label": "TeamRelay 使用说明" },
      h("h3", null, "模式入口与生效范围"),
      h("p", null, h("strong", null, "选择入口："), "新建会话 → 点击输入框上方的模式菜单 → TeamRelay。须在发送第一条消息前选择。"),
      h("p", null, h("strong", null, "生效范围："), "新发起的 TeamRelay 子任务使用已保存的分工配置，进行中的任务沿用原分工；普通会话和已有订阅不受影响。"),
      h("p", { className: "tr-muted" }, "目前可保存任务类型配置和管理 Agent 接入；保存配置不会开启模式或自动派发任务。")),
    h("div", { className: "tr-tabs", role: "tablist", "aria-label": "设置分类" },
      ...[["types", "任务类型"], ["agents", "Agent 接入"]].map(([id, title]) => h("button", {
        key: id, type: "button", role: "tab", id: `tr-tab-${id}`, "aria-selected": tab === id,
        "aria-controls": `tr-panel-${id}`, onClick: () => setTab(id),
      }, title))),
    error ? h("div", { className: "tr-note tr-error", role: "alert" }, error,
      h("button", { type: "button", style: { marginLeft: 12 }, onClick: () => {
        if ((!dirty && !editor) || window.confirm("重新加载会丢弃尚未保存的修改，继续？")) void load();
      } }, "重新加载")) : null,
    notice ? h("div", { className: "tr-note", role: "status" }, notice) : null,
    tab === "types" ? h("div", { role: "tabpanel", id: "tr-panel-types", "aria-labelledby": "tr-tab-types" },
      h("p", { className: "tr-muted", style: { marginBottom: 16 } }, "按任务类型选择执行 Agent。默认全部交给 DSH，也可以调整或新增类型。"),
      loading ? h("p", { role: "status" }, "正在读取配置…") : null,
      draft && !loading ? h("div", null,
        ...draft.routes.map(route => h("div", { key: route.id, className: "tr-card tr-row" },
          h("div", { className: "tr-copy" }, h("h3", null, route.label), h("p", { className: "tr-muted" }, route.match.join("、"))),
          h("div", { className: "tr-actions" },
            route.preferred.length === 1 ? h("select", { "aria-label": `${route.label}的执行 Agent`, value: route.preferred[0], disabled: saving || !!editor,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => updateRoute({ ...route, preferred: [event.target.value] }),
            }, ...Object.keys(names).map(id => h("option", { key: id, value: id, disabled: !canSelect(id) }, agentLabel(id))))
              : h("span", { className: "tr-badge" }, route.preferred.map(id => names[id] ?? id).join(" → "), route.dispatch === "parallel" ? " · 并行" : " · 按顺序选择"),
            h("button", { type: "button", disabled: saving || !!editor, "aria-label": `编辑${route.label}`, onClick: () => { setEditor(structuredClone(route)); setError(""); } }, "编辑")))),
        editor ? h("div", { className: "tr-editor", "aria-label": "类型编辑器" },
          h("h3", null, draft.routes.some(route => route.id === editor.id) ? "编辑类型" : "新增类型"),
          h("div", { className: "tr-fields" },
            h("label", null, "类型名称", h("input", { value: editor.label, maxLength: 80, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, label: e.target.value }) })),
            h("label", null, "适用说明", h("textarea", { value: editor.match.join("\n"), maxLength: 1000, placeholder: "描述这类任务，帮助 DSH 判断如何分配", onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setEditor({ ...editor, match: e.target.value.split("\n") }) })),
            h("fieldset", null, h("legend", null, "执行 Agent"), ...Object.keys(names).map(id => h("label", { key: id },
              h("input", { type: "checkbox", checked: editor.preferred.includes(id), disabled: !canSelect(id), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, preferred: e.target.checked ? [...editor.preferred, id] : editor.preferred.filter(item => item !== id) }) }), agentLabel(id))),
              h("p", { className: "tr-muted" }, "选择顺序：", editor.preferred.map(id => names[id] ?? id).join(" → ") || "尚未选择")),
            editor.preferred.length > 1 ? h("label", null, "多个 Agent 如何执行", h("select", { value: editor.dispatch, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setEditor({ ...editor, dispatch: e.target.value as TeamRelayRoute["dispatch"] }) },
              h("option", { value: "single" }, "按顺序选择可用 Agent"), h("option", { value: "parallel" }, "并行执行"))) : null),
          h("div", { className: "tr-row" },
            h("div", null, editor.id !== "other" && draft.routes.some(route => route.id === editor.id) ? h("button", { type: "button", onClick: () => {
              if (window.confirm(`删除“${editor.label}”类型？保存配置后生效。`)) { change({ ...draft, routes: draft.routes.filter(route => route.id !== editor.id) }); setEditor(null); }
            } }, "删除类型") : null),
            h("div", { className: "tr-actions" }, h("button", { type: "button", onClick: () => setEditor(null) }, "取消"), h("button", { type: "button", className: "tr-primary", onClick: applyEditor }, "完成编辑")))) : null,
        h("div", { className: "tr-footer" },
          h("button", { type: "button", disabled: !!editor || saving || draft.routes.length >= 50, onClick: () => setEditor({ id: `type-${crypto.randomUUID()}`, label: "", match: [""], preferred: ["dsh"], dispatch: "single", approval: "confirm", workspace: "resource" }) }, "+ 新增类型")),
        h("p", { className: "tr-muted", style: { marginTop: 20 } }, "“其他”用于未匹配的任务，保留为兜底类型。")) : null)
    : h("div", { role: "tabpanel", id: "tr-panel-agents", "aria-labelledby": "tr-tab-agents" },
      h("div", { className: "tr-row", style: { marginBottom: 16 } }, h("p", { className: "tr-muted" }, "复用本机已有配置，无需重复填写账号与模型。"),
        h("button", { type: "button", disabled: checking || doubaoBusy, onClick: () => void inspect() }, checking ? "检测中…" : "重新检测")),
      agentError ? h("p", { className: "tr-error", role: "alert" }, agentError) : null,
      ...agents.map(agent => h("div", { key: agent.id, className: "tr-card" },
        h("div", { className: "tr-row" }, h("h3", null, agent.label), h("span", { className: `tr-badge ${["builtin", "detected", "connected"].includes(agent.status) ? "tr-good" : ""}` }, statusNames[agent.status])),
        h("p", { className: "tr-muted" }, agent.message),
        agent.id === "doubao" && agent.selectable ? h("div", { style: { marginTop: 12 } },
          h("div", { className: "tr-actions" },
            agent.status === "logging_in"
              ? h("button", { type: "button", disabled: doubaoBusy || checking, onClick: () => void doubaoAction("cancel") }, "取消登录")
              : h("button", { type: "button", disabled: doubaoBusy || checking, onClick: () => void doubaoAction("login") }, ["saved", "connected", "expired"].includes(agent.status) ? "重新登录豆包" : "登录豆包"),
            h("button", { type: "button", disabled: doubaoBusy || checking || ["logging_in", "signed_out"].includes(agent.status), onClick: () => void doubaoAction("check") }, doubaoBusy ? "处理中…" : "检测登录状态"),
            h("button", { type: "button", disabled: doubaoBusy || checking || agent.status === "signed_out", onClick: () => {
              if (window.confirm("清除 TeamRelay 保存的豆包登录态？已分配的类型会保留，重新登录后可继续使用。")) void doubaoAction("logout");
            } }, "退出登录")),
          h("p", { className: "tr-muted" }, "在 DSH 所在电脑打开独立的 Chrome 或 Edge 窗口，完成扫码或短信登录后自动保存。"),
          h("p", { className: "tr-muted" }, "登录态保存在本机私有文件，仅当前系统用户可读；不需要安装连接器，也无需手工填写 Cookie。")) : null)),
      checking && !agents.length ? h("p", { role: "status" }, "正在检测本地接入状态…") : null));
}
