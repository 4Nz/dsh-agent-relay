import type { RelayStore } from "../storage/index.js";
import type { SubscriptionService } from "./subscriptions.js";
import type { NotificationService } from "./notifications.js";
export function startRelayRuntime({
  store,
  subscriptions,
  notifications,
  onError,
  intervalMs = 30000,
  beforeClose = async () => {},
}: {
  store: Pick<RelayStore, "recoverInterrupted" | "close" | "notifications">;
  subscriptions: Pick<SubscriptionService, "reconcile">;
  notifications: NotificationService;
  onError: (error: unknown) => void;
  intervalMs?: number;
  beforeClose?: () => Promise<void>;
}) {
  let stopping = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function reconcile() {
    try {
      // 每轮对账前先到期扫描：收敛到达最长存活时间的 push 订阅，
      // 不依赖模型轮询或接收会话存在；暂停不突破最长存活上限。
      // 新关注期由统一桥梁对账；旧通知仅核对投递事实。
      const report = await subscriptions.reconcile();
      for (const error of report.errors) onError(error);
    } catch (error) {
      onError(error);
    }
  }
  const ready = (async () => {
    store.recoverInterrupted({ now: Date.now() });
    await reconcile();
  })();
  let first = true;
  function drive() {
    if (stopping) return;
    running = ready
      .then(async () => {
        if (!first) await reconcile();
        first = false;
        await notifications.drain();
      })
      .catch(onError)
      .finally(() => {
        running = undefined;
        if (!stopping) {
          timer = setTimeout(drive, intervalMs);
          timer.unref();
        }
      });
  }
  drive();
  return {
    ready,
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await beforeClose();
      await running;
      store.close();
    },
  };
}
