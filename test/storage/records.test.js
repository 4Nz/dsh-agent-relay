import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, subscription, message } from "./helpers.js";
import { createSubscriptions } from "../../lib/storage/subscriptions.js";
import { createMessages } from "../../lib/storage/messages.js";
test("订阅默认值、非法输入及 SQL 约束", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db);
  const row = s.create(subscription());
  assert.equal(row.idle_timeout_seconds, 3600);
  assert.equal(row.max_consecutive_failures, 3);
  assert.equal(row.consecutive_failures, 0);
  assert.throws(() =>
    s.create({ ...subscription("x"), check_interval_seconds: 59 }),
  );
  assert.throws(() => s.create({ ...subscription("x"), id: "" }), TypeError);
  assert.throws(
    () => s.create({ ...subscription("x"), created_at: -1 }),
    TypeError,
  );
  assert.throws(
    () => s.create({ ...subscription("x"), cursor: { n: NaN } }),
    TypeError,
  );
  assert.equal(
    s.create(subscription("p", "push")).check_interval_seconds,
    null,
  );
  for (const sql of [
    "UPDATE relay_subscription SET agent='bad'",
    "UPDATE relay_subscription SET status='ended'",
    "UPDATE relay_subscription SET check_interval_seconds=NULL WHERE type='poll'",
    "UPDATE relay_subscription SET check_interval_seconds=60 WHERE type='push'",
  ])
    assert.throws(() => db.exec(sql));
  assert.equal(s.get("missing"), null);
});
test("稳定分页、组合筛选、条件更新和不可复活", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db);
  for (const id of ["a", "b", "c"]) s.create(subscription(id));
  const first = s.list({
    owner: "local",
    agent: "claude",
    type: "poll",
    status: "active",
    limit: 2,
  });
  assert.deepEqual(
    first.items.map((x) => x.id),
    ["c", "b"],
  );
  assert.deepEqual(
    s.list({ limit: 2, cursor: first.next_cursor }).items.map((x) => x.id),
    ["a"],
  );
  assert.equal(s.list({ owner: "other" }).items.length, 0);
  for (const limit of [0, 101, 1.5])
    assert.throws(() => s.list({ limit }), TypeError);
  assert.equal(
    s.update({
      id: "a",
      expected_status: "paused",
      patch: { status: "active" },
    }),
    false,
  );
  assert.equal(
    s.update({
      id: "a",
      expected_status: "active",
      patch: {
        status: "ended",
        end_reason: "user_stopped",
        ended_at: 200,
        updated_at: 200,
      },
    }),
    true,
  );
  assert.equal(
    s.update({
      id: "a",
      expected_status: "ended",
      patch: { status: "active" },
    }),
    false,
  );
  assert.throws(
    () =>
      s.update({
        id: "b",
        expected_status: "active",
        patch: { agent: "codex" },
      }),
    TypeError,
  );
});
test("消息关联路由、状态与查询", (t) => {
  const { db } = fixture(t);
  createSubscriptions(db).create(subscription());
  const m = createMessages(db);
  m.create({ ...message(), subscription_id: "s" });
  assert.throws(() =>
    m.create({ ...message("wrong"), subscription_id: "s", agent: "codex" }),
  );
  assert.throws(() =>
    db.exec(
      "INSERT INTO relay_message(id,agent,external_session_id,subscription_id,content,created_at) VALUES('bad','codex','x','s','x',100)",
    ),
  );
  assert.equal(m.list({ external_session_id: "session'1" }).items.length, 1);
  assert.equal(m.get("missing"), null);
  assert.equal(
    m.transition({
      id: "m",
      expected_status: "sending",
      status: "sent",
      sent_at: 200,
    }),
    true,
  );
  assert.equal(m.get("m").sent_at, 200);
  assert.equal(
    m.transition({ id: "m", expected_status: "sent", status: "failed" }),
    false,
  );
});
