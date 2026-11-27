import { createElement as h } from "react";
import { Drawer, fieldInput, fieldSelect } from "./drawer.js";
import {
  agentName,
  checkText,
  date,
  deliveryText,
  expiryText,
  formatStart,
  frequencyText,
  label,
  planningText,
  typeLabel,
} from "./format.js";

export function renderCreateDrawer(ctx: {
  agent: string;
  external: string;
  target: string;
  topic: string;
  failures: string;
  candidates: any[];
  targets: any[];
  candidateLoading: boolean;
  candidateError: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: Event) => void;
  onChangeAgent: (v: string) => void;
  onChangeExternal: (v: string) => void;
  onRefreshCandidates: () => void;
  onChangeTarget: (v: string) => void;
  onChangeTopic: (v: string) => void;
  onChangeFailures: (v: string) => void;
}) {
  const {
    agent,
    external,
    target,
    topic,
    failures,
    candidates,
    targets,
    candidateLoading,
    candidateError,
    busy,
    onClose,
    onSubmit,
    onChangeAgent,
    onChangeExternal,
    onRefreshCandidates,
    onChangeTarget,
    onChangeTopic,
    onChangeFailures,
  } = ctx;
  return h(
    Drawer,
    { title: "新建订阅", onClose },
    h(
      "form",
      { className: "fields", onSubmit },
      h("p", { className: "muted" }, "选择需要关注的外部会话，结果将通知到 DSH。"),
      fieldSelect("Agent", agent, onChangeAgent, [
        ["claude", "Claude"],
        ["codex", "Codex"],
        ["agy", "Antigravity"],
      ]),
      agent === "codex" &&
        h(
          "div",
          { className: "notice muted small" },
          "选择已有的 Codex 桌面或 CLI 会话进行订阅，无需另建后台会话。订阅只查阅历史，不接管原会话。",
        ),
      agent === "agy" &&
        h(
          "div",
          { className: "notice muted small" },
          "选择已有的 Antigravity 桌面、IDE 或 CLI 会话进行订阅。订阅只查阅历史记录，不接管原会话；向桌面已有会话发消息需启用桥接 Sidecar。",
        ),
      fieldSelect(
        "外部会话",
        external,
        onChangeExternal,
        [
          ["", candidateLoading ? "正在读取会话…" : "请选择外部会话"],
          ...candidates.map(
            (s) => [s.id, `${s.title ?? "未命名"} · ${s.id}`] as [string, string],
          ),
        ],
        { disabled: candidateLoading },
      ),
      h(
        "button",
        {
          type: "button",
          disabled: candidateLoading || busy,
          onClick: onRefreshCandidates,
        },
        "刷新会话列表",
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
        onChangeTarget,
        [
          ["", "复用原接收会话（首次自动新建）"],
          ...targets.map((s) => [s.id, s.title] as [string, string]),
        ],
        {},
      ),
      h(
        "label",
        null,
        "关注主题（可选）",
        h("input", {
          "aria-label": "关注主题（可选）",
          value: topic,
          maxLength: 1000,
          placeholder: "定期汇报新的进展或回复",
          onChange: (e: any) => onChangeTopic(e.target.value),
        }),
      ),
      fieldInput("连续失败阈值", failures, onChangeFailures, { min: 1, max: 100 }),
      candidateError && h("p", { className: "error", role: "alert" }, candidateError),
      h(
        "p",
        { className: "muted small" },
        "关注最长 24 小时，从创建起计算，不因活动或暂停顺延。可在主题中说明频率，用户指定优先；未指定时由 DSH 选择并告知。无变化静默，单轮完成不自动结束关注。",
      ),
      h(
        "footer",
        null,
        h("button", { type: "button", onClick: onClose }, "取消"),
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
}

export function renderEventSection(
  sub: any,
  ctx: {
    events: any[];
    eventNext: number | null;
    eventsLoading: boolean;
    eventsError: string;
    recoveredBatch: any;
    onLoadMore: (sub: any, after: number) => void;
    onReadBatch: (id: string) => void;
  },
) {
  const {
    events,
    eventNext,
    eventsLoading,
    eventsError,
    recoveredBatch,
    onLoadMore,
    onReadBatch,
  } = ctx;
  return h(
    "section",
    { "aria-label": "事件与批次" },
    h("h2", null, "事件与批次"),
    h(
      "p",
      { className: "muted small" },
      "忙时事件排队合批；已送达仍需 DSH 判断。未知投递先核对，不盲目重发。",
    ),
    eventsError && h("p", { role: "alert", className: "error" }, eventsError),
    ...events.map((event) =>
      h(
        "article",
        { key: event.id, className: "notice small" },
        h(
          "p",
          null,
          `#${event.seq} · ${event.kind} · ${label(event.delivery_state)} · ${date(event.created_at)}`,
        ),
        h(
          "details",
          null,
          h("summary", null, "事件标识与恢复信息"),
          h(
            "p",
            { className: "muted" },
            `事件 ${event.id} · 批次 ${event.batch_id ?? "待合批"} · 版本 ${event.decision_version ?? "—"}`,
          ),
        ),
        h("p", { style: { whiteSpace: "pre-wrap" } }, event.body),
        event.batch_id &&
          h(
            "button",
            { disabled: eventsLoading, onClick: () => onReadBatch(event.batch_id) },
            "读取原批次",
          ),
      ),
    ),
    eventsLoading && h("p", null, "正在读取事件…"),
    !eventsLoading && !events.length && !eventsError && h("p", { className: "muted" }, "暂无事件"),
    eventNext !== null &&
      h(
        "button",
        { disabled: eventsLoading, onClick: () => onLoadMore(sub, eventNext) },
        "更多事件",
      ),
    recoveredBatch &&
      h(
        "div",
        { className: "notice" },
        h(
          "p",
          null,
          `原批次：${label(recoveredBatch.status)}（读取事实不等于确认处理）`,
        ),
        recoveredBatch.batch_id &&
          h(
            "details",
            null,
            h("summary", null, "DSH 恢复指令"),
            h(
              "p",
              null,
              `请调用 relay_batch({batch_id:"${recoveredBatch.batch_id}"}) 读取原事实，按原主题判断后用 relay_decide 确认，decision_version:${recoveredBatch.decision_version}。`,
            ),
          ),
        ...(recoveredBatch.events ?? []).map((event: any) =>
          h("p", { key: event.id, style: { whiteSpace: "pre-wrap" } }, event.body),
        ),
        h(
          "p",
          { className: "muted small" },
          "打开原接收会话，由 DSH 使用 relay_batch 读取，再以原 batch_id 与 decision_version 调用 relay_decide。屏蔽中的批次请先解除屏蔽；待核对状态不能视为已处理。",
        ),
      ),
  );
}

export function renderDetailDrawer(
  sub: any,
  ctx: {
    busy: boolean;
    inspecting: boolean;
    snapshot: any;
    error: string;
    canSnapshot: boolean;
    canSend: boolean;
    sendReasonText: string;
    onClose: () => void;
    onInspect: (sub: any) => void;
    onOpenSend: () => void;
    onOpenEdit: (sub: any) => void;
    eventSection: any;
    controls: any;
  },
) {
  const {
    busy,
    inspecting,
    snapshot,
    error,
    canSnapshot,
    canSend,
    sendReasonText,
    onClose,
    onInspect,
    onOpenSend,
    onOpenEdit,
    eventSection,
    controls,
  } = ctx;
  return h(
    Drawer,
    { title: "订阅详情", onClose },
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
      ].flatMap(([k, v]) => [h("dt", { key: `${k}-k` }, k), h("dd", { key: k }, v)]),
    ),
    h(
      "div",
      { className: "row" },
      h(
        "button",
        {
          disabled: busy || inspecting || !canSnapshot,
          title: canSnapshot ? "读取快照，不延长关注截止时间" : "该 Agent 不支持查阅或能力尚未加载",
          onClick: () => onInspect(sub),
        },
        "查阅外部会话",
      ),
      h(
        "button",
        {
          disabled: busy || !canSend,
          title: canSend ? "核对目标后发送" : sendReasonText,
          onClick: onOpenSend,
        },
        "发送消息",
      ),
      sub.status !== "ended" &&
        h("button", { disabled: busy, onClick: () => onOpenEdit(sub) }, "修改配置"),
    ),
    (sub.agent === "codex" || sub.agent === "agy") &&
      !canSend &&
      h(
        "p",
        { className: "muted small" },
        inspecting ? "正在核对会话状态…" : sendReasonText,
      ),
    snapshot &&
      snapshot.agent === sub.agent &&
      snapshot.external_session_id === sub.external_session_id &&
      h(
        "div",
        { className: "notice" },
        h(
          "p",
          null,
          snapshot.value.closed ? "外部会话已关闭" : `运行状态：${snapshot.value.runtime ?? "unknown"}`,
        ),
        snapshot.value.runtime_note && h("p", null, snapshot.value.runtime_note),
        snapshot.value.status_context?.note && h("p", null, snapshot.value.status_context.note),
        snapshot.value.last_activity_age_seconds != null &&
          h("p", null, `距最近可见活动：${snapshot.value.last_activity_age_seconds} 秒（不代表空闲时长）`),
        snapshot.value.runtime_error && h("p", null, snapshot.value.runtime_error),
        h("p", { style: { whiteSpace: "pre-wrap" } }, snapshot.value.last_reply ?? "暂无回复节选"),
      ),
    error && h("p", { role: "alert", className: "error" }, error),
    sub.last_check_error && h("p", { className: "error" }, `检查失败：${sub.last_check_error}`),
    sub.notification?.delivery_error &&
      h("p", { className: "error" }, `通知投递：${sub.notification.delivery_error}`),
    sub.status === "active" &&
      sub.type === "poll" &&
      sub.planning_state === "ready" &&
      !sub.schedule_task_id &&
      h("p", { className: "warn" }, "已选频率，宿主提醒尚未就绪，等待对账。"),
    eventSection,
    (sub.agent === "codex" || sub.agent === "agy") &&
      h(
        "p",
        { className: "notice muted" },
        "订阅和查阅不要求会话可发送；发送能力以当前连接与会话检查结果为准，实时状态未知不代表任务完成。",
      ),
    h("footer", null, controls),
  );
}

export function renderStopDrawer(
  sub: any,
  { busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: () => void },
) {
  return h(
    Drawer,
    { title: "结束关注", onClose },
    h("p", null, `停止关注「${sub.external_session_title ?? sub.external_session_id}」？`),
    h(
      "p",
      { className: "muted" },
      "结束后不再定时检查；后续 push 仍送原 DSH 会话且不会自动重启关注。若不想接收 push，请单独屏蔽。已在途或已送达消息不会撤回。",
    ),
    h(
      "footer",
      null,
      h("button", { onClick: onClose }, "取消"),
      h(
        "button",
        { className: "primary", disabled: busy, onClick: onConfirm },
        busy ? "正在停止…" : "结束关注",
      ),
    ),
  );
}

export function renderEditDrawer(
  sub: any,
  {
    busy,
    failures,
    error,
    onChangeFailures,
    onClose,
    onSave,
  }: {
    busy: boolean;
    failures: string;
    error: string;
    onChangeFailures: (v: string) => void;
    onClose: () => void;
    onSave: (sub: any) => void;
  },
) {
  return h(
    Drawer,
    { title: "修改订阅配置", onClose },
    h(
      "p",
      { className: "muted" },
      "固定创建后 24 小时截止；检查频率交由 DSH 按主题及用户要求规划。",
    ),
    fieldInput("连续失败阈值", failures, onChangeFailures, { min: 1, max: 100 }),
    error && h("p", { role: "alert", className: "error" }, error),
    h("button", { disabled: busy, onClick: () => onSave(sub) }, "保存"),
  );
}

export function renderSendDrawer(
  sub: any,
  {
    busy,
    message,
    error,
    canSend,
    onChangeMessage,
    onClose,
    onSend,
  }: {
    busy: boolean;
    message: string;
    error: string;
    canSend: boolean;
    onChangeMessage: (v: string) => void;
    onClose: () => void;
    onSend: (sub: any) => void;
  },
) {
  return h(
    Drawer,
    { title: "发送消息", onClose },
    h("p", null, `目标：${agentName(sub.agent)} · ${sub.external_session_title ?? "未命名"}`),
    h("p", null, `会话 ID：${sub.external_session_id}`),
    h("p", null, `工作目录：${sub.external_cwd ?? "未知"}`),
    h(
      "label",
      null,
      "消息（最多 2000 字符）",
      h("textarea", {
        value: message,
        rows: 5,
        maxLength: 2000,
        onChange: (e: any) => onChangeMessage(e.target.value),
      }),
    ),
    h(
      "p",
      { className: "muted small" },
      "较长内容请先汇总；调研报告可保存为接收方可访问的文档，发送摘要与路径，不建议分段发送。",
    ),
    error && h("p", { role: "alert", className: "error" }, error),
    h(
      "button",
      { disabled: busy || !message.trim() || !canSend, onClick: () => onSend(sub) },
      "确认目标并发送",
    ),
  );
}

export function renderConflictDrawer(
  conflict: any,
  {
    busy,
    onClose,
    onClearConflict,
    onContinue,
    onRestart,
  }: {
    busy: boolean;
    onClose: () => void;
    onClearConflict: () => void;
    onContinue: () => void;
    onRestart: () => void;
  },
) {
  return h(
    Drawer,
    {
      title: conflict.paused ? "原关注已暂停" : "已有关注主题",
      onClose: conflict.paused ? onClose : onClearConflict,
    },
    h("p", null, `当前关注：${conflict.current.topic}`),
    h(
      "p",
      { className: "muted" },
      conflict.paused
        ? "原关注仍已暂停；同主题订阅不会自动恢复定时检查。选择继续关注会恢复原关注并恢复接收 Agent 消息，截止时间保持不变。"
        : "同一外部会话只能有一个有效关注。继续将保留原主题和接收会话；停止重新来会结束原关注后创建新关注期。",
    ),
    h(
      "button",
      { disabled: busy, onClick: onContinue },
      conflict.paused ? "继续关注" : "继续原关注",
    ),
    conflict.paused
      ? h("button", { disabled: busy, onClick: onClose }, "保持暂停")
      : h("button", { disabled: busy, onClick: onRestart }, "停止重新来"),
  );
}
