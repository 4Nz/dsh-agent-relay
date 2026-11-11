import type { Agent } from "../storage/types.js";
import { AdapterError } from "./types.js";
import type { AdapterCapabilities, AgentAdapter } from "./types.js";

export interface AdapterRegistry {
  get(agent: Agent): AgentAdapter;
  list(): { agent: Agent; capabilities: AdapterCapabilities }[];
}

// 按 agent 字段查找 Adapter。新增 Agent 只需在创建时多传一个 Adapter。
export function createAdapterRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map<Agent, AgentAdapter>();
  for (const adapter of adapters) {
    if (map.has(adapter.agent))
      throw new TypeError(`重复注册 Adapter：${adapter.agent}`);
    map.set(adapter.agent, adapter);
  }
  return {
    get(agent) {
      const adapter = map.get(agent);
      if (!adapter)
        throw new AdapterError("invalid_input", `暂不支持 Agent：${agent}`);
      return adapter;
    },
    list: () =>
      [...map.values()].map((a) => ({
        agent: a.agent,
        capabilities: a.capabilities(),
      })),
  };
}
