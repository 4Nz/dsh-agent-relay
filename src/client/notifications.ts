import { createElement as h, useEffect } from "react";
import { notifyText, type Rpc } from "./format.js";

// ---- 浏览器通知提醒（渠道抽象，后续可扩展 macOS / 飞书等） ----
interface NotifyChannel {
  available(): boolean;
  request(): Promise<boolean>;
  notify(title: string, body: string, open?: () => void): void;
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
  notify(title: string, body: string, open?: () => void) {
    try {
      const notification = new Notification(title, { body });
      if (open) notification.onclick = () => open();
    } catch {
      /* 通知弹窗失败时静默，不影响事件投递 */
    }
  },
};

const NOTIFY_STORAGE_KEY = "dsh-agent-relay:notify:lastSeen";
const NOTIFY_POLL_INTERVAL_MS = 30_000;

// 常驻轮询：侧边栏图标挂载期间，定时拉取 notify_poll 的新增通知并弹浏览器通知。
function useNotifyPolling(
  rpc: Rpc | undefined,
  openSession?: (id: string) => void,
) {
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
        try {
          const parsed = JSON.parse(stored);
          cursor = typeof parsed === "number" ? { created_at: parsed } : parsed;
        } catch {
          cursor = { created_at: 0 };
        }
        if (!cursor || !Number.isFinite(cursor.created_at))
          cursor = { created_at: 0 };
        const initial = cursor.created_at === 0;
        while (!stopped) {
          const result = await conn.call("/api", "agent-relay/notify_poll", {
            after: cursor.created_at,
            ...(cursor.id ? { after_id: cursor.id } : {}),
            limit: 50,
          });
          if (
            stopped ||
            !result.ok ||
            !Array.isArray(result.value) ||
            !result.value.length
          )
            return;
          const items = result.value;
          if (!initial)
            for (const item of items) {
              if (item.delivery_status !== "muted")
                browserNotifyChannel.notify(
                  "Agent Relay 通知",
                  notifyText(item),
                  item.dsh_session_id && openSession
                    ? () => openSession(item.dsh_session_id)
                    : undefined,
                );
            }
          const last = items[items.length - 1];
          const next = last.cursor ?? { created_at: last.created_at, id: last.id };
          if (next.created_at === cursor.created_at && next.id === cursor.id)
            return;
          cursor = next;
          localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(cursor));
          if (items.length < 50) return;
        }
      } catch {
        /* 下轮使用已持久化游标重试。 */
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = setInterval(poll, NOTIFY_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [rpc, openSession]);
}

export function AgentRelayIcon({
  rpc,
  openSession,
}: {
  rpc: Rpc;
  openSession?: (id: string) => void;
}) {
  useNotifyPolling(rpc, openSession);
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
