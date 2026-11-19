import { test } from "node:test";
import assert from "node:assert/strict";
import { createDshSessions } from "../../lib/services/dsh-sessions.js";

test("导航状态区分已有、归档与不存在，查询失败不伪装为不存在", async () => {
  const registry = { archivedSessionIds: ["old", "deleted"] };
  let fail = false;
  const sessions = createDshSessions({
    async listSessions() {
      if (fail) throw Error("宿主查询失败");
      return ["live", "old"].map(id => ({ header: { id } }));
    },
    async readTitleSnapshots() { throw Error("导航不应读取正文或标题"); },
  }, registry);
  assert.equal(await sessions.status("live"), "available");
  assert.equal(await sessions.status("old"), "archived");
  assert.equal(await sessions.status("deleted"), "missing");
  registry.archivedSessionIds = [];
  assert.equal(await sessions.status("old"), "available");
  fail = true;
  await assert.rejects(sessions.status("live"), /宿主查询失败/);
});

test("list 一次批量读取标题，单个缺失/失败回退到该 ID", async () => {
  let titleCalls = 0;
  const host = {
    listSessions: async () => [
      { header: { id: "a" } },
      { header: { id: "b" } },
      { header: { id: "c" } },
    ],
    readTitleSnapshots: async (ids) => {
      titleCalls++;
      assert.deepEqual(ids, ["a", "b", "c"]);
      return [
        { sessionId: "a", status: "fulfilled", value: { session: { id: "a" }, title: { title: "标题A" } } },
        { sessionId: "b", status: "rejected", reason: "读取失败" },
        { sessionId: "c", status: "fulfilled", value: { session: { id: "c" } } },
      ];
    },
  };
  const result = await createDshSessions(host).list();
  assert.equal(titleCalls, 1);
  assert.deepEqual(result, [
    { id: "a", title: "标题A" },
    { id: "b", title: "b" },
    { id: "c", title: "c" },
  ]);
});

test("list 批量整体失败明确报错", async () => {
  const host = {
    listSessions: async () => [{ header: { id: "a" } }],
    readTitleSnapshots: async () => {
      throw new Error("批量读取失败");
    },
  };
  await assert.rejects(createDshSessions(host).list(), /批量读取失败/);
});

test("has 只核对 header.id，不读取标题", async () => {
  let listCalls = 0;
  const host = {
    listSessions: async () => {
      listCalls++;
      return [{ header: { id: "a" } }, { header: { id: "b" } }];
    },
    readTitleSnapshots: async () => {
      throw new Error("不应读取标题");
    },
  };
  const sessions = createDshSessions(host);
  assert.equal(await sessions.has("a"), true);
  assert.equal(await sessions.has("c"), false);
  assert.equal(listCalls, 2);
});

test("has 在 listSessions 失败时抛错，不当作不存在", async () => {
  const host = {
    listSessions: async () => {
      throw new Error("宿主不可用");
    },
    readTitleSnapshots: async () => [],
  };
  await assert.rejects(createDshSessions(host).has("a"), /宿主不可用/);
});

test("归档接收会话不出现在候选中，校验明确拒绝；解除归档后可重新使用", async () => {
  const registry = { archivedSessionIds: ["archived"] };
  const sessions = createDshSessions({
    listSessions: async () => [{ header: { id: "active" } }, { header: { id: "archived" } }],
    readTitleSnapshots: async () => [],
  }, registry);
  assert.deepEqual(await sessions.list(), [{ id: "active", title: "active" }]);
  await assert.rejects(sessions.has("archived"), /接收.*已归档.*恢复.*选择/);
  assert.equal(await sessions.has("active"), true);
  registry.archivedSessionIds = [];
  assert.equal(await sessions.has("archived"), true);
  assert.equal((await sessions.list()).length, 2);
});
