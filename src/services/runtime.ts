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
  store: Pick<RelayStore, "recoverInterrupted" | "close">;
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
