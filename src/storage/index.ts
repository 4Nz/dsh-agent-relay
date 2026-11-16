import { createCodexSessions } from "./codex-sessions.js";
import { openDatabase } from "./database.js";
import { createSubscriptions } from "./subscriptions.js";
import { createMessages } from "./messages.js";
import { createNotifications } from "./notifications.js";
import { recoverInterrupted, cleanupHistory, deleteSubscription, cleanupSubscriptions } from "./maintenance.js";

export function openRelayStore({ dataDir }: { dataDir: string }) {
  const db = openDatabase({ dataDir });
  return {
    subscriptions: createSubscriptions(db),
    codexSessions: createCodexSessions(db),
    messages: createMessages(db),
    notifications: createNotifications(db),
    recoverInterrupted: (options: { now: number }) =>
      recoverInterrupted(db, options),
    cleanupHistory: (options: { now: number; retention_days?: number }) =>
      cleanupHistory(db, options),
    deleteSubscription: (options: { id: string }) => deleteSubscription(db, options),
    cleanupSubscriptions: (options: { now: number; retention_days?: number }) =>
      cleanupSubscriptions(db, options),
    close() {
      if (db.isOpen) db.close();
    },
  };
}

export type RelayStore = ReturnType<typeof openRelayStore>;
export type * from "./types.js";
