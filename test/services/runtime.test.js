import { test } from "node:test";
import assert from "node:assert/strict";
import { startRelayRuntime } from "../../lib/services/runtime.js";
test("启动先恢复再对账；卸载等待在途任务后关闭存储", async () => {
  const events = [];
  let release;
  let first = true;
  const runtime = startRelayRuntime({
    store: {
      recoverInterrupted() {
        events.push("recover");
      },
      close() {
        events.push("close");
      },
      notifications: {
        expirePushSubscriptions() {
          events.push("expire");
        },
      },
    },
    subscriptions: {
      async reconcile() {
        events.push("reconcile");
        return { errors: [] };
      },
    },
    notifications: {
      async drain() {
        events.push("drain");
        if (first) {
          first = false;
          await new Promise((r) => (release = r));
        }
      },
    },
    onError: () => {},
    intervalMs: 100000,
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["recover", "reconcile", "drain"]);
  const stopping = runtime.stop();
  assert.equal(events.includes("close"), false);
  release();
  await stopping;
  assert.equal(events.at(-1), "close");
});
test("首次对账失败后仍继续工作，后续驱动重试对账", async () => {
  let reconciles = 0;
  let drains = 0;
  const errors = [];
  const runtime = startRelayRuntime({
    store: {
      recoverInterrupted() {},
      close() {},
      notifications: { expirePushSubscriptions() {} },
    },
    subscriptions: {
      async reconcile() {
        if (++reconciles === 1) throw Error("暂不可用");
        return { errors: [] };
      },
    },
    notifications: {
      async drain() {
        drains++;
      },
    },
    onError: (e) => errors.push(String(e)),
    intervalMs: 5,
  });
  await runtime.ready;
  for (const end = Date.now() + 1000; reconciles < 2 && Date.now() < end;)
    await new Promise((r) => setTimeout(r, 5));
  await runtime.stop();
  assert.ok(reconciles >= 2);
  assert.ok(drains >= 1);
  assert.equal(errors.length, 1);
});

test("每轮交给桥梁统一到期对账，不调用旧一次性到期转换", async () => {
  let expires = 0;
  let reconciles = 0;
  const runtime = startRelayRuntime({
    store: {
      recoverInterrupted() {},
      close() {},
      notifications: {
        expirePushSubscriptions() {
          expires++;
        },
      },
    },
    subscriptions: {
      async reconcile() {
        reconciles++;
        return { errors: [] };
      },
    },
    notifications: { async drain() {} },
    onError: () => {},
    intervalMs: 5,
  });
  await runtime.ready;
  for (const end = Date.now() + 1000; reconciles < 2 && Date.now() < end;)
    await new Promise((r) => setTimeout(r, 5));
  await runtime.stop();
  assert.equal(expires, 0);
  assert.ok(reconciles >= 2);
});
