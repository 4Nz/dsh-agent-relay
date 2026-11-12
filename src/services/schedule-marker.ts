import type { Subscription } from "../storage/types.js";

// 定时提醒正文中的标记。旧版 `[agent-relay:<id>]` 因 id 可能含空格/方括号/Unicode，
// 标记会被截断导致对账反复重建任务；v2 用 base64url 编码 id，编码不含分隔符，
// 可被严格解析回主键。标记的生成与解析集中在本模块，不通过宽松正则猜测主键。

const V2_PREFIX = "[agent-relay-v2:";
const V2_SUFFIX = "]";
// base64url 字符集（无 padding）。
const V2_ENCODED = /^[A-Za-z0-9_-]+$/;
// 旧版标记：`[agent-relay:` 后接 id；不匹配 v2（v2 为 `agent-relay-v2:`）。
const LEGACY_MARKER = /\[agent-relay:/;

export function v2Marker(id: string): string {
  return `${V2_PREFIX}${Buffer.from(id, "utf8").toString("base64url")}${V2_SUFFIX}`;
}

// 严格解析 v2 标记：编码须为规范 base64url，且解码后重新编码与原编码一致，
// 拒绝任何宽松猜测或截断。解析失败返回 null。
export function parseV2Marker(prompt: string): string | null {
  const start = prompt.indexOf(V2_PREFIX);
  if (start < 0) return null;
  const end = prompt.indexOf(V2_SUFFIX, start + V2_PREFIX.length);
  if (end < 0) return null;
  const encoded = prompt.slice(start + V2_PREFIX.length, end);
  if (!V2_ENCODED.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64url") === encoded
    ? decoded
    : null;
}

// 是否为旧版标记（本插件历史遗留任务）。
export function hasLegacyMarker(prompt: string): boolean {
  return LEGACY_MARKER.test(prompt);
}

// 旧版完整提醒正文，用于与历史遗留任务精确匹配（正文 + 接收会话双重核对）。
export function legacyPrompt(
  sub: Pick<Subscription, "id" | "external_session_title" | "external_session_id">,
): string {
  return `[agent-relay:${sub.id}] 调用 relay_check 工具检查外部会话，参数 subscription_id=${sub.id}。只执行这一次检查，不做其他操作。`;
}
