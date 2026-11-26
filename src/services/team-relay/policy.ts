import type {
  TeamRelayPreset,
  TeamRelayRoute,
  TeamRelayRouteResolution,
} from "./types.js";

// 系统调度上限，不作为用户可配置项；保留快照字段以兼容已有配置。
export const TEAM_RELAY_MAX_PARALLEL = 4;

export function defaultTeamRelayPreset(): TeamRelayPreset {
  return {
    version: 2,
    max_parallel: TEAM_RELAY_MAX_PARALLEL,
    routes: [
      {
        id: "search",
        label: "网络搜索",
        match: ["网络搜索", "公开资料查询", "实时信息", "资料核验"],
        preferred: ["dsh"],
        dispatch: "single",
        approval: "auto",
        workspace: "none",
      },
      {
        id: "content",
        label: "内容处理与创作",
        match: ["总结", "翻译", "改写", "文档处理", "内容创作"],
        preferred: ["dsh"],
        dispatch: "single",
        approval: "auto",
        workspace: "none",
      },
      {
        id: "development",
        label: "开发与实现",
        match: ["功能开发", "代码实现", "脚本", "修复", "测试", "重构"],
        preferred: ["dsh"],
        dispatch: "single",
        approval: "confirm",
        workspace: "isolated",
      },
      {
        id: "other",
        label: "其他",
        match: ["不适合已有类型的任务", "工具操作", "日常事务"],
        preferred: ["dsh"],
        dispatch: "single",
        approval: "confirm",
        workspace: "resource",
      },
    ],
  };
}

export function validateTeamRelayPreset(value: unknown): asserts value is TeamRelayPreset {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("预设必须为对象");
  const preset = value as TeamRelayPreset;
  if (!Number.isSafeInteger(preset.version) || preset.version < 1)
    throw new TypeError("preset.version 必须为正整数");
  if (!Number.isSafeInteger(preset.max_parallel) || preset.max_parallel < 1 || preset.max_parallel > 16)
    throw new TypeError("preset.max_parallel 必须为 1～16 的整数");
  const ids = new Set<string>();
  if (!Array.isArray(preset.routes) || !preset.routes.length || preset.routes.length > 50)
    throw new TypeError("任务类型数量必须为 1～50");
  for (const route of preset.routes) {
    if (!route || typeof route !== "object" || typeof route.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(route.id))
      throw new TypeError("类型 ID 必须为小写字母开头的字母、数字或连字符，最多 64 字符");
    if (ids.has(route.id)) throw new TypeError(`重复路由：${route.id}`);
    ids.add(route.id);
    if (typeof route.label !== "string" || !route.label.trim() || route.label.length > 80)
      throw new TypeError("类型名称必须为 1～80 字符");
    if (!Array.isArray(route.preferred) || !route.preferred.length || route.preferred.length > 16 ||
        route.preferred.some(id => typeof id !== "string" || !id.trim() || id.length > 100) ||
        new Set(route.preferred).size !== route.preferred.length)
      throw new TypeError(`路由没有首选目标：${route.id}`);
    if (!Array.isArray(route.match) || !route.match.length || route.match.length > 30 ||
        route.match.some(text => typeof text !== "string" || !text.trim() || text.length > 1000))
      throw new TypeError(`路由没有匹配标签：${route.id}`);
    if (!["single", "parallel"].includes(route.dispatch) ||
        !["auto", "confirm"].includes(route.approval) ||
        !["none", "isolated", "resource"].includes(route.workspace))
      throw new TypeError(`类型执行配置无效：${route.id}`);
  }
}

export function selectTeamRelayRoute(
  preset: TeamRelayPreset,
  routeId: string,
): TeamRelayRoute {
  validateTeamRelayPreset(preset);
  const route = preset.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new TypeError(`未知 TeamRelay 路由：${routeId}`);
  return route;
}

export function resolveTeamRelayTargets(
  route: TeamRelayRoute,
  available: Iterable<string>,
): TeamRelayRouteResolution {
  const availableSet = new Set(available);
  const unavailable = route.preferred.filter((id) => !availableSet.has(id));
  if (route.dispatch === "parallel") {
    return {
      selected: route.preferred.filter((id) => availableSet.has(id)),
      unavailable,
    };
  }
  const selected = route.preferred.find((id) => availableSet.has(id));
  return {
    selected: selected ? [selected] : [],
    unavailable: selected
      ? route.preferred.slice(0, route.preferred.indexOf(selected)).filter((id) => !availableSet.has(id))
      : unavailable,
  };
}
