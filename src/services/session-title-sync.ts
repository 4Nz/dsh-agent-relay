import type { Agent, RelayStore } from "../storage/index.js";
import { receiveSessionTitle } from "./receive-session.js";

// 仅消费检测结果；不另起轮询、不创建关注。每个接收会话串行并合并为最新标题。
export function createSessionTitleSync({ store, rename, onError = () => {}, now = Date.now }: {
  store: RelayStore;
  rename: (request: { sessionId: string; title: string }) => Promise<unknown>;
  onError?: (error: unknown) => void;
  now?: () => number;
}) {
  type Request = { agent: Agent; external: string; title: string; session: string };
  const pending = new Map<string, Request>();
  const running = new Map<string, Promise<void>>();
  const confirmed = new Map<string, string>();
  function routeFor(request: Request) {
    const route = store.bridge.route(request.agent, request.external);
    if (!route || route.dsh_session_id !== request.session) return null;
    // 共享接收会话没有唯一标题来源，避免各来源在检查时反复覆盖。
    if (store.bridge.routes().some(other => other.id !== route.id && other.dsh_session_id === request.session)) return null;
    return route;
  }
  async function run(session: string) {
    while (pending.has(session)) {
      const request = pending.get(session)!;
      pending.delete(session);
      const route = routeFor(request);
      if (!route) continue;
      const key = `${route.id}/${session}`;
      const sub = store.bridge.live(route);
      if ((confirmed.get(key) ?? sub?.external_session_title) === request.title) continue;
      try {
        await rename({ sessionId: session, title: receiveSessionTitle({
          agent: request.agent, externalSessionId: request.external,
          externalSessionTitle: request.title, type: sub?.type ?? "push",
        }) });
        // 等待宿主期间可能重绑；不要把旧目标的成功误记到新目标。
        if (!routeFor(request)) continue;
        confirmed.set(key, request.title);
        const current = store.bridge.live(route);
        if (current) store.subscriptions.update({
          id: current.id, expected_status: current.status,
          patch: { external_session_title: request.title, updated_at: now() },
        });
      } catch (error) {
        // 不推进成功基线，下次检测相同标题仍会重试。
        try { onError(error); } catch { /* 日志失败也不影响检测。 */ }
      }
    }
  }
  function start(session: string) {
    if (running.has(session)) return;
    const work = Promise.resolve().then(() => run(session)).finally(() => {
      running.delete(session);
      if (pending.has(session)) start(session);
    });
    running.set(session, work);
  }
  return {
    observe(agent: Agent, external: string, title: string | null | undefined) {
      const normalized = title?.trim();
      const route = store.bridge.route(agent, external);
      if (!normalized || !route?.dsh_session_id) return;
      const session = route.dsh_session_id;
      pending.set(session, { agent, external, title: normalized, session });
      start(session);
    },
    async drain() {
      while (running.size) await Promise.allSettled([...running.values()]);
    },
  };
}
