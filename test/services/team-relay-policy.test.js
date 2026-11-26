import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultTeamRelayPreset,
  resolveTeamRelayTargets,
  selectTeamRelayRoute,
  validateTeamRelayPreset,
} from "../../lib/services/team-relay/policy.js";

test("TeamRelay 默认四种任务类型均由 DSH 执行", () => {
  const preset = defaultTeamRelayPreset();
  assert.equal(preset.max_parallel, 4);
  assert.equal(preset.version, 2);
  assert.deepEqual(preset.routes.map(({ id, label }) => ({ id, label })), [
    { id: "search", label: "网络搜索" },
    { id: "content", label: "内容处理与创作" },
    { id: "development", label: "开发与实现" },
    { id: "other", label: "其他" },
  ]);
  for (const route of preset.routes) {
    assert.deepEqual(route.preferred, ["dsh"]);
    assert.deepEqual(resolveTeamRelayTargets(route, ["dsh"]), {
      selected: ["dsh"], unavailable: [],
    });
  }
});

test("支持修改类型的 Agent 和新增类型，未注册目标仍不可用", () => {
  const preset = defaultTeamRelayPreset();
  selectTeamRelayRoute(preset, "search").preferred = ["doubao", "dsh"];
  preset.routes.push({
    id: "custom-tools", label: "自定义工具任务", match: ["复杂工具"],
    preferred: ["workbuddy"], dispatch: "single", approval: "confirm", workspace: "resource",
  });
  assert.deepEqual(
    resolveTeamRelayTargets(selectTeamRelayRoute(preset, "search"), ["dsh"]),
    { selected: ["dsh"], unavailable: ["doubao"] },
  );
  assert.deepEqual(
    resolveTeamRelayTargets(selectTeamRelayRoute(preset, "custom-tools"), ["dsh", "codex"]),
    { selected: [], unavailable: ["workbuddy"] },
  );
});

test("预设拒绝重复路由和超过全局并发上限", () => {
  const preset = defaultTeamRelayPreset();
  assert.throws(
    () => validateTeamRelayPreset({ ...preset, max_parallel: 0 }),
    /max_parallel/,
  );
  assert.throws(
    () => validateTeamRelayPreset({
      ...preset,
      routes: [preset.routes[0], { ...preset.routes[0] }],
    }),
    /重复路由/,
  );
});
