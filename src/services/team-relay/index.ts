import type { ProviderRegistry } from "../../providers/types.js";
import type { TeamSettingsStore, TeamSettingsSnapshot } from "./settings.js";
import type { TeamAgentView } from "./agents.js";
import {
  defaultTeamRelayPreset,
  resolveTeamRelayTargets,
  selectTeamRelayRoute,
  validateTeamRelayPreset,
  TEAM_RELAY_MAX_PARALLEL,
} from "./policy.js";
import type {
  TeamRelayPreset,
  TeamRelayRouteResolution,
  DoubaoAccessPort,
  DoubaoAccessAction,
  DoubaoAccessView,
} from "./types.js";

export interface TeamRelayService {
  preset(): TeamRelayPreset;
  availableTargetIds(): string[];
  resolve(routeId: string): TeamRelayRouteResolution;
  settings(): TeamSettingsSnapshot;
  saveSettings(value: unknown, revision: number): TeamSettingsSnapshot;
  inspectAgents(): Promise<TeamAgentView[]>;
  doubao(action: DoubaoAccessAction): Promise<DoubaoAccessView>;
}

export function createTeamRelayService({
  providers,
  sessionTargets = [],
  preset = defaultTeamRelayPreset(),
  settingsStore,
  inspectAgents = async () => [],
  doubao,
}: {
  providers: ProviderRegistry;
  sessionTargets?: string[];
  preset?: TeamRelayPreset;
  settingsStore?: TeamSettingsStore;
  inspectAgents?: () => Promise<TeamAgentView[]>;
  doubao?: DoubaoAccessPort;
}): TeamRelayService {
  validateTeamRelayPreset(preset);
  const sessions = [...new Set(sessionTargets)];
  const readPreset = () => ({ ...(settingsStore?.read().preset ?? structuredClone(preset)), max_parallel: TEAM_RELAY_MAX_PARALLEL });
  const availableTargetIds = () =>
    [
      "dsh",
      ...providers.list().map((item) => item.id),
      ...sessions,
    ].filter((id, index, all) => all.indexOf(id) === index);
  return {
    preset: readPreset,
    availableTargetIds,
    settings: () => settingsStore?.read() ?? { revision: 0, preset: readPreset() },
    saveSettings(value, revision) {
      if (!settingsStore) throw new Error("配置保存服务未就绪");
      validateTeamRelayPreset(value);
      const registered = new Set(availableTargetIds());
      for (const route of value.routes) {
        if (route.preferred.some(id => !registered.has(id)))
          throw new TypeError(`类型“${route.label}”选择了尚未接入的 Agent`);
      }
      if (!value.routes.some(route => route.id === "other"))
        throw new TypeError("请保留“其他”兜底类型");
      // 只保存声明字段，页面不能向配置文件附加凭证或任意对象。
      return settingsStore.save({ version: value.version, max_parallel: TEAM_RELAY_MAX_PARALLEL,
        routes: value.routes.map(({ id, label, match, preferred, dispatch, approval, workspace }) =>
          ({ id, label: label.trim(), match: match.map(text => text.trim()), preferred, dispatch, approval, workspace })),
      }, revision);
    },
    inspectAgents,
    async doubao(action) {
      if (!doubao) throw new Error("豆包内置接入服务未就绪");
      switch (action) {
        case "status": return doubao.status();
        case "login": return doubao.start();
        case "check": return doubao.check();
        case "cancel": return doubao.cancel();
        case "logout": return doubao.logout();
        default: throw new TypeError("豆包操作无效");
      }
    },
    resolve(routeId) {
      const route = selectTeamRelayRoute(readPreset(), routeId);
      return resolveTeamRelayTargets(route, availableTargetIds());
    },
  };
}
