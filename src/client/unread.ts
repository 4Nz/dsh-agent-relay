import type { UnreadReceipt } from "../unread-types.js";

interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
interface EventEntry {
  type: string;
  event: { type: string; seq: number; data: { id?: string; inserted?: readonly { id: string }[] } };
}
interface Binding {
  session: Observable<{ openState: string; running: boolean; removed: boolean }>;
  eventSource: Observable<{ entries: readonly EventEntry[] }>;
}
export interface UnreadHost {
  sessions: {
    list: Observable<{ phase: string; byId: Record<string, { running: boolean; retainedBy: Readonly<Record<string, number | undefined>> }> }>;
    binding(id: string): Binding | undefined;
  };
  layout: { panelInfo: Observable<{ activePanelId: string | null }> };
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  every(listener: () => void): () => void;
}
interface Rpc {
  call(channel: string, method: string, args: unknown): Promise<{ ok: boolean; value?: unknown }>;
}

// 使用公开会话事件窗口确认消息和后续轮次结束均已加载，不能仅凭 mainView 保留计数判已读。
function hasReadReply(binding: Binding, deliveryKey: string): boolean {
  const state = binding.session.getSnapshot();
  if (state.openState !== "open" || state.running || state.removed) return false;
  let admitted: number | undefined;
  let ended = -1;
  for (const entry of binding.eventSource.getSnapshot().entries) {
    if (entry.type !== "event") continue;
    const { type, data, seq } = entry.event;
    if ((type === "user/message" && data.id === deliveryKey) ||
      (type === "agent/inbox/spliced" && data.inserted?.some(item => item.id === deliveryKey)))
      admitted = seq;
    if (type === "turn/end") ended = seq;
  }
  return admitted !== undefined && ended > admitted;
}

export function createUnreadController(rpc: Rpc, host: UnreadHost) {
  let snapshot = new Map<string, UnreadReceipt>();
  const listeners = new Set<() => void>();
  const acknowledged = new Map<string, number>();
  function publish(next: Map<string, UnreadReceipt>) {
    if (next.size === snapshot.size && [...next].every(([id, item]) => snapshot.get(id)?.sequence === item.sequence)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => snapshot as ReadonlyMap<string, UnreadReceipt>,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      let stopped = false, polling = false, reading = false;
      let binding: Binding | undefined;
      let releaseBinding = () => {};
      function selected() {
        const list = host.sessions.list.getSnapshot();
        if (list.phase !== "ready" || host.layout.panelInfo.getSnapshot().activePanelId !== null) return;
        return Object.entries(list.byId).find(([, row]) => (row.retainedBy.mainView ?? 0) > 0);
      }
      async function readVisible() {
        if (stopped || reading || !host.visible()) return;
        const current = selected();
        if (!current || current[1].running) return;
        const [id] = current;
        const receipt = snapshot.get(id), currentBinding = host.sessions.binding(id);
        if (!receipt || !currentBinding || !hasReadReply(currentBinding, receipt.delivery_key)) return;
        reading = true;
        let success = false;
        try {
          const result = await rpc.call("/api", "agent-relay/mark_read", { dsh_session_id: id, sequence: receipt.sequence });
          if (stopped || !result.ok) return;
          success = true;
          acknowledged.set(id, Math.max(acknowledged.get(id) ?? 0, receipt.sequence));
          const next = new Map(snapshot);
          if ((next.get(id)?.sequence ?? Infinity) <= receipt.sequence) next.delete(id);
          publish(next);
        } catch { /* 保留未读，下次轮询或视图变化重试。 */ }
        finally {
          reading = false;
          if (success && !stopped) void readVisible();
        }
      }
      function viewChanged() {
        if (stopped) return;
        const current = selected();
        const next = current ? host.sessions.binding(current[0]) : undefined;
        if (next !== binding) {
          releaseBinding(); binding = next;
          const releases = next ? [next.session.subscribe(viewChanged), next.eventSource.subscribe(viewChanged)] : [];
          releaseBinding = () => { for (const release of releases) release(); };
        }
        void readVisible();
      }
      async function poll() {
        if (stopped || polling) return;
        polling = true;
        try {
          const result = await rpc.call("/api", "agent-relay/unread", {});
          if (stopped || !result.ok || !Array.isArray(result.value)) return;
          const items = result.value as UnreadReceipt[];
          publish(new Map(items.filter(item => item.sequence > (acknowledged.get(item.dsh_session_id) ?? 0))
            .map(item => [item.dsh_session_id, item])));
          viewChanged();
        } catch { /* 断线不清空缓存；重连后从服务端恢复。 */ }
        finally { polling = false; }
      }
      const releases = [host.sessions.list.subscribe(viewChanged), host.layout.panelInfo.subscribe(viewChanged),
        host.onVisibilityChange(viewChanged), host.every(() => { void poll(); })];
      viewChanged(); void poll();
      return () => { stopped = true; releaseBinding(); for (const release of releases) release(); };
    },
  };
}

export type UnreadController = ReturnType<typeof createUnreadController>;
