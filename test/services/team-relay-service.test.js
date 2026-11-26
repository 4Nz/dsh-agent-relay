import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderRegistry } from "../../lib/providers/registry.js";
import { createTeamRelayService } from "../../lib/services/team-relay/index.js";

test("TeamRelay 服务返回预设和执行目标能力", () => {
  const providers = createProviderRegistry([{
    id: "doubao",
    capabilities: () => ({ execute: true, streaming: true, cancel: false, quota: true }),
    execute: async () => ({ status: "completed", output: "ok", external_ref: null }),
  }]);
  const service = createTeamRelayService({ providers, sessionTargets: ["claude", "codex"] });
  assert.equal(service.preset().max_parallel, 4);
  assert.deepEqual(service.availableTargetIds(), ["dsh", "doubao", "claude", "codex"]);
  assert.deepEqual(service.resolve("search"), { selected: ["dsh"], unavailable: [] });
});
