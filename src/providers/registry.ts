import type {
  ProviderCapabilityView,
  ProviderExecutor,
  ProviderRegistry,
} from "./types.js";

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

function id(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError("Provider ID 不能为空");
  return value.trim();
}

export function createProviderRegistry(
  providers: ProviderExecutor[],
): ProviderRegistry {
  const map = new Map<string, ProviderExecutor>();
  for (const provider of providers) {
    const providerId = id(provider.id);
    if (map.has(providerId))
      throw new ProviderRegistryError(`重复 Provider：${providerId}`);
    map.set(providerId, provider);
  }
  return {
    get(providerId) {
      const provider = map.get(id(providerId));
      if (!provider)
        throw new ProviderRegistryError(`未知 Provider：${providerId}`);
      return provider;
    },
    list(): ProviderCapabilityView[] {
      return [...map.values()].map((provider) => ({
        id: provider.id,
        capabilities: provider.capabilities(),
      }));
    },
  };
}
