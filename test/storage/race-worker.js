import { workerData, parentPort } from "node:worker_threads";
import { openDatabase } from "../../lib/storage/database.js";
import { createNotifications } from "../../lib/storage/notifications.js";
const db = openDatabase({ dataDir: workerData.dataDir });
const result = createNotifications(db).record({
  notification: {
    id: workerData.id,
    subscription_id: "s",
    source: "poll",
    result: "completed",
    summary: "完成",
  },
  now: 200,
});
db.close();
parentPort.postMessage(result.outcome);
