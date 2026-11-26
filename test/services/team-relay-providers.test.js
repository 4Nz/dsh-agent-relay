import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderRegistry } from "../../lib/providers/registry.js";

function provider(id = "doubao") {
  return {
    id,
    capabilities: () => ({
      execute: true,
      streaming: true,
      cancel: false,
      quota: true,
    }),
    execute: async () => ({
      status: "completed",
      output: "ok",
      external_ref: null,
    }),
  };
}

test("Provider Registry 注册豆包并只暴露能力事实", () => {
  const registry = createProviderRegistry([provider()]);
  assert.equal(registry.get("doubao").id, "doubao");
  assert.deepEqual(registry.list(), [{
    id: "doubao",
    capabilities: {
      execute: true,
      streaming: true,
      cancel: false,
      quota: true,
    },
  }]);
  assert.equal("cookie" in registry.list()[0], false);
});

test("Provider Registry 拒绝重复 ID 和未知 Provider", () => {
  assert.throws(() => createProviderRegistry([provider(), provider()]), /重复 Provider/);
  const registry = createProviderRegistry([provider()]);
  assert.throws(() => registry.get("workbuddy"), /未知 Provider/);
});
