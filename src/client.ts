import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createUnreadController, type UnreadController, type UnreadHost } from "./client/unread.js";
import { TeamRelaySettings, TEAM_RELAY_SETTINGS_TITLE } from "./client/team-settings.js";
import { TeamTaskRow } from "./client/team-task-row.js";
import {
  agentName,
  checkText,
  deliveryText,
  deliveryTone,
  expiryText,
  formatStart,
  frequencyText,
  label,
  planningText,
  typeLabel,
  type Rpc,
} from "./client/format.js";
import { panelCss } from "./client/styles.js";
import { filterSelect } from "./client/drawer.js";
import { AgentRelayIcon } from "./client/notifications.js";
import { renderInstallDrawer } from "./client/install-drawer.js";
import {
  renderConflictDrawer,
  renderCreateDrawer,
  renderDetailDrawer,
  renderEditDrawer,
  renderEventSection,
  renderSendDrawer,
  renderStopDrawer,
} from "./client/panel-drawers.js";

export const inject = ["slots", "connection", "uiWorkspace", "sessions", "layout"];
const PANEL_ID = "agent-relay";

interface PanelProps {
  rpc: Rpc;
  openSession: (id: string) => void;
}

export function AgentRelayPanel({ rpc, openSession }: PanelProps) {
  const [routes, setRoutes] = useState<any[]>([]),
    [routeCursor] = useState<string | null>(null),
    [, setRouteNext] = useState<string | null>(null),
    [, setRouteError] = useState("");
  const [items, setItems] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState({ agent: "", status: "", type: "" }),
    [cursor, setCursor] = useState<any>(null),
    [cursorStack, setCursorStack] = useState<any[]>([]),
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
  const [events, setEvents] = useState<any[]>([]),
    [eventNext, setEventNext] = useState<number | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false),
    [eventsError, setEventsError] = useState("");
  const [recoveredBatch, setRecoveredBatch] = useState<any>(null);
  const eventsGen = useRef(0);
  const [message, setMessage] = useState("");
  const [candidateRevision, setCandidateRevision] = useState(0);
  const [installAgent, setInstallAgent] = useState("claude");
  const [notifyCatalog, setNotifyCatalog] = useState<any[]>([]);
  const [enableAgySandbox, setEnableAgySandbox] = useState(false);
  const [optionalSkills, setOptionalSkills] = useState<string[]>([]);
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
  const current =
    drawer === "route"
      ? routes.find((route) => route.id === selected)
      : items.find((s) => s.id === selected);

  const close = () => {
    inspectGen.current++;
    eventsGen.current++;
    setConflict(null);
    setInspecting(false);
    setDrawer("");
  };

  async function call(endpoint: string, payload: unknown = {}) {
    const response = await rpc.call("/api", `agent-relay/${endpoint}`, payload);
    if (!response.ok)
      throw Object.assign(Error(response.error?.message ?? "操作失败"), response.error);
    return response.value;
  }

  async function openReceiver(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = await call("dsh_session_status", { dsh_session_id: id });
      if (result?.status === "archived")
        throw new Error(
          "该 DSH 接收会话已归档，请先在 DSH 中恢复该会话，再打开。历史接收目标保持不变。",
        );
      if (result?.status === "missing")
        throw new Error(
          "该 DSH 接收会话不存在或已删除，无法打开。不会自动新建会话或跳转到其他接收会话。",
        );
      if (result?.status !== "available" || result.id !== id)
        throw new Error("无法确认 DSH 接收会话状态，请刷新页面后重试。");
      openSession(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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

  useEffect(() => {
    if (drawer !== "route") return;
    let live = true;
    void call("routes", { cursor: routeCursor, limit: 20 })
      .then((page) => {
        if (live) {
          setRoutes(page?.items ?? []);
          setRouteNext(page?.next_cursor ?? null);
          setRouteError("");
        }
      })
      .catch((e) => {
        if (live) setRouteError(e.message);
      });
    return () => {
      live = false;
    };
  }, [drawer, routeCursor, refreshVersion]);

  useEffect(() => {
    void refresh();
    return () => {
      revision.current++;
    };
  }, [filter, cursor, refreshVersion]);

  useEffect(
    () => () => {
      inspectGen.current++;
      eventsGen.current++;
    },
    [],
  );

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
          setCandidateError(
            [sessions, dsh]
              .filter((r) => r.status === "rejected")
              .map((r) => (r as PromiseRejectedResult).reason?.message ?? "读取会话失败")
              .join("；"),
          );
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
    void call("setup_check", { agent: installAgent, optional_skills: optionalSkills })
      .then((value) => {
        if (live) {
          setSetupReport(value);
          setNotifyCatalog(value.optional_skills ?? []);
        }
      })
      .catch((e) => {
        if (live) setInstallError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [drawer, installAgent, optionalSkills]);

  // 连通测试进行中时每 2 秒刷新一次结果。
  useEffect(() => {
    if (drawer !== "install" || probe?.status !== "waiting") return;
    const timer = setInterval(() => {
      void call("setup_probe_status").then(setProbe).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [drawer, probe?.status]);

  useEffect(() => {
    if (drawer === "detail" && (current?.agent === "codex" || current?.agent === "agy"))
      void inspect(current);
  }, [drawer, current?.id]);

  useEffect(() => {
    setEvents([]);
    setEventNext(null);
    setRecoveredBatch(null);
    setEventsError("");
    if ((drawer === "detail" || drawer === "route") && current) void loadEvents(current, 0);
    return () => {
      eventsGen.current++;
    };
  }, [drawer, current?.id]);

  async function loadEvents(sub: any, after: number) {
    const gen = ++eventsGen.current;
    setEventsLoading(true);
    setEventsError("");
    try {
      const value = await call("events", {
        ...(sub.kind === "route"
          ? { agent: sub.agent, external_session_id: sub.external_session_id }
          : { subscription_id: sub.id }),
        after_sequence: after,
        limit: 20,
      });
      if (gen === eventsGen.current) {
        setEvents((previous) => (after ? [...previous, ...value.items] : value.items));
        setEventNext(value.next_sequence);
      }
    } catch (e) {
      if (gen === eventsGen.current) setEventsError((e as Error).message);
    } finally {
      if (gen === eventsGen.current) setEventsLoading(false);
    }
  }

  async function readBatch(id: string) {
    const gen = ++eventsGen.current;
    setEventsLoading(true);
    setEventsError("");
    try {
      const value = await call("batch", { batch_id: id });
      if (gen === eventsGen.current) setRecoveredBatch(value);
    } catch (e) {
      if (gen === eventsGen.current) setEventsError((e as Error).message);
    } finally {
      if (gen === eventsGen.current) setEventsLoading(false);
    }
  }

  const capability = (a: string, key: string) =>
    capabilities.find((item) => item.agent === a)?.capabilities?.[key] === true;

  function sendAllowed(sub: any) {
    if (!capability(sub.agent, "sendMessage")) return false;
    if (sub.agent !== "codex" && sub.agent !== "agy") return true;
    return (
      snapshot?.agent === sub.agent &&
      snapshot?.external_session_id === sub.external_session_id &&
      snapshot.value.send_allowed === true
    );
  }

  function sendReason(sub: any) {
    if (sub.agent !== "codex" && sub.agent !== "agy")
      return "该 Agent 不支持发送消息或能力尚未加载";
    return snapshot?.external_session_id === sub.external_session_id
      ? snapshot.value.send_reason || "请查阅最新状态后发送"
      : "请先查阅会话，核对是否支持发送";
  }

  async function inspect(sub: any) {
    const gen = ++inspectGen.current;
    const t = { agent: sub.agent, external_session_id: sub.external_session_id };
    setInspecting(true);
    setError("");
    setSnapshot(null);
    try {
      const value = await call("inspect", {
        agent: t.agent,
        external_session_id: t.external_session_id,
      });
      if (gen === inspectGen.current) {
        setSnapshot({ agent: t.agent, external_session_id: t.external_session_id, value });
        setRefreshVersion((v) => v + 1);
      }
    } catch (e) {
      if (gen === inspectGen.current) setError((e as Error).message);
    } finally {
      if (gen === inspectGen.current) setInspecting(false);
    }
  }

  async function saveConfig(sub: any) {
    setBusy(true);
    setError("");
    try {
      await call("update", {
        subscription_id: sub.id,
        max_consecutive_failures: Number(failures),
      });
      setNotice("订阅配置已保存。");
      setRefreshVersion((v) => v + 1);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send(sub: any) {
    setBusy(true);
    setError("");
    try {
      const value = await call("send", {
        agent: sub.agent,
        external_session_id: sub.external_session_id,
        subscription_id: sub.id,
        content: message,
      });
      setNotice(
        `消息${label(value.message.status)}${value.message.error ? `：${value.message.error}` : value.message.status === "queued" ? "；会话空闲后推送，Claude 确认后显示已确认。" : "；已发送不代表任务完成。"}`,
      );
      setRefreshVersion((v) => v + 1);
      close();
      setMessage("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
      const existing = await call("current", {
        agent: payload.agent,
        external_session_id: payload.external_session_id,
      });
      const normalized = payload.topic?.trim() || "定期汇报新的进展或回复";
      if (
        existing.subscription &&
        (existing.subscription.topic !== normalized ||
          (payload.dsh_session_id &&
            payload.dsh_session_id !== existing.route?.dsh_session_id))
      ) {
        setConflict({ current: existing.subscription, payload });
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
      setDrawer("");
      setConflict(null);
      setNotice(
        value.subscription?.planning_state === "pending"
          ? "关注已保存，等待 DSH 按主题规划频率；最长 24 小时。"
          : value.schedule_ready
            ? "关注已保存，宿主提醒已就绪。"
            : "关注已保存，等待 DSH 判断或宿主提醒对账。",
      );
      if (cursor) {
        setCursorStack([]);
        setCursor(null);
      } else setRefreshVersion((v) => v + 1);
    } catch (e) {
      if ((e as any).code !== "conflict") throw e;
      const existing = await call("current", {
        agent: payload.agent,
        external_session_id: payload.external_session_id,
      });
      if (!existing.subscription) throw e;
      setConflict({ current: existing.subscription, payload });
    }
  }

  async function continueConflict() {
    if (!conflict) return;
    setBusy(true);
    setError("");
    try {
      const sub = conflict.current;
      if (sub.status === "paused") await call("resume", { subscription_id: sub.id });
      else if (sub.muted)
        await call("mute", {
          agent: sub.agent,
          external_session_id: sub.external_session_id,
          muted: false,
        });
      setNotice("已继续原关注；保留原主题、接收会话与截止时间。");
      setRefreshVersion((v) => v + 1);
      close();
      if (sub.dsh_session_id) await openReceiver(sub.dsh_session_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restartConflict() {
    if (!conflict) return;
    setBusy(true);
    setError("");
    try {
      await call("stop", { subscription_id: conflict.current.id });
      await createSubscription(conflict.payload);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resubscribe(sub: any) {
    setBusy(true);
    setError("");
    try {
      await createSubscription({
        type: "poll",
        agent: sub.agent,
        external_session_id: sub.external_session_id,
        topic: sub.topic,
        max_consecutive_failures: sub.max_consecutive_failures,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function muteRoute(sub: any) {
    setBusy(true);
    setError("");
    try {
      await call("mute", {
        agent: sub.agent,
        external_session_id: sub.external_session_id,
        muted: !sub.muted,
      });
      setRoutes((previous) =>
        previous.map((route) =>
          route.agent === sub.agent &&
          route.external_session_id === sub.external_session_id
            ? { ...route, muted: !sub.muted }
            : route,
        ),
      );
      setNotice(
        sub.muted
          ? "已恢复接收 Agent 消息，原批次按原状态恢复。"
          : "已暂停接收 Agent 消息，事件仍保留；历史关注继续。",
      );
      setRefreshVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
      setCursorStack([]);
      setCursor(null);
      setRefreshVersion((version) => version + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runSetup(
    endpoint: "setup_check" | "setup_install" | "setup_uninstall",
  ) {
    setInstallBusy(true);
    setInstallError("");
    setSetupMessage("");
    try {
      const applySandbox = endpoint === "setup_install" && enableAgySandbox && setupReport?.agy_sandbox?.status === "missing";
      const report = await call(endpoint, { agent: installAgent, optional_skills: optionalSkills,
        ...(applySandbox ? { enable_agy_sandbox: true, agy_sandbox_revision: setupReport.agy_sandbox.revision } : {}),
      });
      if (endpoint === "setup_install") setEnableAgySandbox(false);
      setSetupReport(report);
      setNotifyCatalog(report.optional_skills ?? []);
      const changed = report.items.filter(
        (i: any) => i.action && i.action !== "skipped" && i.action !== "none",
      ).length;
      if (endpoint === "setup_check") setSetupMessage("检查完成。");
      else if (endpoint === "setup_uninstall")
        setSetupMessage("已卸载 channel 配置，通知 Skill 保留。");
      else if (
        report.overall === "needs_action" ||
        report.overall === "unavailable" ||
        report.items.some((i: any) => i.status !== "ok")
      )
        setInstallError(
          `${changed > 0 ? `本次已处理 ${changed} 项，但` : ""}仍有安装项未就绪，请展开安装详情查看原因。`,
        );
      else
        setSetupMessage(
          changed > 0 ? `安装完成，本次处理 ${changed} 项。` : "无需改动，所有项已就绪。",
        );
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
      await createSubscription({
        agent,
        external_session_id: external,
        ...(target ? { dsh_session_id: target } : {}),
        topic,
        max_consecutive_failures: Number(failures),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setFilterField = (key: "agent" | "status" | "type", value: string) => {
    setFilter({ ...filter, [key]: value });
    setCursorStack([]);
    setCursor(null);
  };

  const controls = (sub: any, compact = false) =>
    h(
      "div",
      { className: "actions" },
      sub.dsh_session_id &&
        h(
          "button",
          {
            disabled: busy,
            title: "打开这条订阅原来绑定的 DSH 接收会话",
            onClick: () => openReceiver(sub.dsh_session_id),
          },
          "打开 DSH 接收会话",
        ),
      !compact &&
        sub.status === "active" &&
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
      !compact &&
        h(
          "button",
          {
            disabled: busy,
            title: sub.muted
              ? "恢复接收该外部会话的主动通知"
              : "暂停接收该外部会话的主动通知；保留已记录事件，不停止历史订阅检查",
            onClick: () => void muteRoute(sub),
          },
          sub.muted ? "恢复接收 Agent 消息" : "暂停接收 Agent 消息",
        ),
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
      !compact &&
        h(
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
          h("div", { className: "muted small path", title: sub.external_cwd }, sub.external_cwd),
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
      h("td", { className: "frequency-cell" }, h("div", { className: "small muted" }, frequencyText(sub))),
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

  return h(
    "div",
    {
      className: "ar",
      "data-dsh-plugin": "dsh-agent-relay",
      "data-dsh-part": "panel",
    },
    h("style", null, panelCss),
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
              setEnableAgySandbox(false);
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
          {
            className: "primary",
            onClick: () => {
              setTopic("");
              setFailures("3");
              setTarget("");
              setError("");
              setDrawer("create");
            },
          },
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
        filterSelect("Agent 筛选", filter.agent, (v) => setFilterField("agent", v), [
          ["", "全部 Agent"],
          ["claude", "Claude"],
          ["codex", "Codex"],
          ["agy", "Antigravity"],
        ]),
        filterSelect("类型筛选", filter.type, (v) => setFilterField("type", v), [
          ["", "全部类型"],
          ["poll", "主动订阅"],
          ["push", "主动通知"],
        ]),
        filterSelect("状态筛选", filter.status, (v) => setFilterField("status", v), [
          ["", "全部状态"],
          ["active", "订阅中"],
          ["paused", "已暂停"],
          ["ended", "已结束"],
        ]),
        (filter.agent || filter.type || filter.status) &&
          h(
            "button",
            {
              onClick: () => {
                setFilter({ agent: "", status: "", type: "" });
                setCursorStack([]);
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
      (cursor || cursorStack.length > 0 || next) &&
        h(
          "div",
          { className: "row", style: { marginTop: 14 } },
          (cursor || cursorStack.length > 0) &&
            h(
              "button",
              {
                onClick: () => {
                  const prev =
                    cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null;
                  setCursorStack((stack) => stack.slice(0, -1));
                  setCursor(prev);
                },
                disabled: loading,
              },
              "上一页",
            ),
          next &&
            h(
              "button",
              {
                onClick: () => {
                  setCursorStack((stack) => [...stack, cursor]);
                  setCursor(next);
                },
                disabled: loading,
              },
              "下一页",
            ),
        ),
    ),
    // 会话路由暂不在任务跟踪页展示；底层路由仍用于 push 投递和浏览器通知跳转。
    conflict &&
      renderConflictDrawer(conflict, {
        busy,
        onClose: close,
        onClearConflict: () => setConflict(null),
        onContinue: () => void continueConflict(),
        onRestart: () => void restartConflict(),
      }),
    !conflict &&
      drawer === "create" &&
      renderCreateDrawer({
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
        onClose: close,
        onSubmit: submit,
        onChangeAgent: (v) => {
          setAgent(v);
          setExternal("");
        },
        onChangeExternal: setExternal,
        onRefreshCandidates: () => setCandidateRevision((v) => v + 1),
        onChangeTarget: setTarget,
        onChangeTopic: setTopic,
        onChangeFailures: setFailures,
      }),
    drawer === "detail" &&
      current &&
      renderDetailDrawer(current, {
        busy,
        inspecting,
        snapshot,
        error,
        canSnapshot: capability(current.agent, "snapshot"),
        canSend: sendAllowed(current),
        sendReasonText: sendReason(current),
        onClose: close,
        onInspect: (sub) => void inspect(sub),
        onOpenSend: () => {
          setMessage("");
          setDrawer("send");
        },
        onOpenEdit: (sub) => {
          setFailures(String(sub.max_consecutive_failures));
          setDrawer("edit");
        },
        eventSection: renderEventSection(current, {
          events,
          eventNext,
          eventsLoading,
          eventsError,
          recoveredBatch,
          onLoadMore: (sub, after) => void loadEvents(sub, after),
          onReadBatch: (id) => void readBatch(id),
        }),
        controls: controls(current),
      }),
    drawer === "stop" &&
      current &&
      renderStopDrawer(current, {
        busy,
        onClose: close,
        onConfirm: () => void stopCurrent(current.id),
      }),
    drawer === "edit" &&
      current &&
      renderEditDrawer(current, {
        busy,
        failures,
        error,
        onChangeFailures: setFailures,
        onClose: close,
        onSave: (sub) => void saveConfig(sub),
      }),
    drawer === "send" &&
      current &&
      renderSendDrawer(current, {
        busy,
        message,
        error,
        canSend: sendAllowed(current),
        onChangeMessage: setMessage,
        onClose: close,
        onSend: (sub) => void send(sub),
      }),
    drawer === "install" &&
      renderInstallDrawer({
        busy,
        installAgent,
        notifyCatalog,
        optionalSkills,
        installBusy,
        setupReport,
        probe,
        installError,
        setupMessage,
        onClose: close,
        enableAgySandbox,
        onToggleSandbox: setEnableAgySandbox,
        onChangeAgent: (v) => {
          setEnableAgySandbox(false);
          setInstallAgent(v);
          setOptionalSkills([]);
          setSetupReport(null);
          setInstallError("");
          setSetupMessage("");
        },
        onToggleOptionalSkill: (name, checked) => {
          if (name === "agy-notify") setEnableAgySandbox(false);
          setOptionalSkills((list) =>
            checked ? [...list, name] : list.filter((item) => item !== name),
          );
          setSetupReport(null);
          setSetupMessage("");
        },
        onRunSetup: (endpoint) => void runSetup(endpoint),
        onStartProbe: () => void startProbe(),
      }),
  );
}

function UnreadWatcher({ unread }: { unread: UnreadController }) {
  useEffect(() => unread.start(), [unread]);
  return null;
}

function RelayUnreadDot({
  sessionId,
  unread,
}: {
  sessionId: string;
  unread: UnreadController;
}) {
  const receipts = useSyncExternalStore(unread.subscribe, unread.getSnapshot);
  if (!receipts.has(sessionId)) return null;
  return h("span", {
    role: "img",
    "aria-label": "外部消息未读",
    title: "外部消息未读",
    "data-dsh-part": "relay-unread",
    style: {
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: "50%",
      backgroundColor: "#3b82f6",
    },
  });
}

function RelayUnreadHover({
  sessionId,
  unread,
}: {
  sessionId: string;
  unread: UnreadController;
}) {
  const receipts = useSyncExternalStore(unread.subscribe, unread.getSnapshot);
  return receipts.has(sessionId) ? h("span", null, "有未读的外部 Agent 消息") : null;
}

interface RelayClientContext {
  slots: {
    inject(name: string, callback: () => () => void): () => void;
    register(options: unknown, component: unknown): () => void;
  };
  connection: { rpc: Rpc };
  uiWorkspace: { openSession(id: string): void };
  sessions: UnreadHost["sessions"];
  layout: UnreadHost["layout"];
}

export function apply(ctx: RelayClientContext): void {
  for (const key of ["relay_team_dispatch", "relay_team_status"]) {
    ctx.slots.inject("tool.call.toolview", () =>
      ctx.slots.register({ name: "tool.call.toolview", key }, TeamTaskRow),
    );
  }
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "agent-relay.team-relay",
        order: 80,
        label: () => TEAM_RELAY_SETTINGS_TITLE,
        inject: () => ({ rpc: ctx.connection.rpc }),
      },
      TeamRelaySettings,
    ),
  );
  const unread = createUnreadController(ctx.connection.rpc, {
    sessions: ctx.sessions,
    layout: ctx.layout,
    visible: () => document.visibilityState === "visible" && document.hasFocus(),
    onVisibilityChange(listener) {
      document.addEventListener("visibilitychange", listener);
      window.addEventListener("focus", listener);
      return () => {
        document.removeEventListener("visibilitychange", listener);
        window.removeEventListener("focus", listener);
      };
    },
    every(listener) {
      const timer = setInterval(listener, 5_000);
      return () => clearInterval(timer);
    },
  });
  for (const [name, component] of [
    ["shell.overlay", UnreadWatcher],
    ["sidebar.session.row.leading", RelayUnreadDot],
    ["sidebar.session.row.hover", RelayUnreadHover],
  ] as const) {
    ctx.slots.inject(name, () =>
      ctx.slots.register(
        {
          name,
          id: "agent-relay.unread",
          order: 10,
          inject: () => ({ unread }),
        },
        component,
      ),
    );
  }
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
            inject: () => ({
              rpc: ctx.connection.rpc,
              openSession: (id: string) => ctx.uiWorkspace.openSession(id),
            }),
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
