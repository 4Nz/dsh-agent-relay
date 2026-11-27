import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const KNOWN_ALIAS_AGENTS = ["dsh", "agy", "claude", "codex", "doubao"] as const;
export type KnownAliasAgent = (typeof KNOWN_ALIAS_AGENTS)[number];

export interface AgentAliasEntry {
  display_name: string;
  aliases: string[];
}

export interface AgentAliasConfig {
  format: 1;
  agents: Record<KnownAliasAgent, AgentAliasEntry>;
}

export interface AgentAliasSnapshot extends AgentAliasConfig {
  file: string;
  summary: string;
}

export interface AgentAliasStore {
  readonly file: string;
  ensure(): { created: boolean; file: string };
  read(): AgentAliasSnapshot;
  resolve(input: unknown): KnownAliasAgent | null;
  summary(): string;
}

const CANONICAL_LABELS: Record<KnownAliasAgent, string> = {
  dsh: "DSH",
  agy: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  doubao: "豆包",
};

const BUILTIN_SYNONYMS: Record<string, KnownAliasAgent> = {
  dsh: "dsh",
  agy: "agy",
  antigravity: "agy",
  claude: "claude",
  codex: "codex",
  doubao: "doubao",
  豆包: "doubao",
};

export function defaultAgentAliasConfig(): AgentAliasConfig {
  return {
    format: 1,
    agents: {
      dsh: { display_name: "大肥鱼", aliases: [] },
      agy: { display_name: "哈基米", aliases: [] },
      claude: { display_name: "Claude", aliases: [] },
      codex: { display_name: "Codex", aliases: [] },
      doubao: { display_name: "豆包", aliases: [] },
    },
  };
}

function cleanAlias(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 32) return null;
  return cleaned;
}

function normalizeKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function parseConfig(raw: unknown): AgentAliasConfig {
  const defaults = defaultAgentAliasConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const root = raw as Record<string, unknown>;
  const source =
    root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
      ? (root.agents as Record<string, unknown>)
      : root;
  const agents = { ...defaults.agents };
  for (const id of KNOWN_ALIAS_AGENTS) {
    const entry = source[id];
    if (typeof entry === "string") {
      const display = cleanAlias(entry);
      if (display) agents[id] = { display_name: display, aliases: [] };
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const display = cleanAlias(obj.display_name ?? obj.nickname) ?? defaults.agents[id].display_name;
    const seen = new Set<string>([normalizeKey(display)]);
    const aliases: string[] = [];
    if (Array.isArray(obj.aliases)) {
      for (const item of obj.aliases) {
        const cleaned = cleanAlias(item);
        if (!cleaned) continue;
        const key = normalizeKey(cleaned);
        if (seen.has(key)) continue;
        seen.add(key);
        aliases.push(cleaned);
        if (aliases.length >= 10) break;
      }
    }
    agents[id] = { display_name: display, aliases };
  }
  return { format: 1, agents };
}

export function formatAgentAliasSummary(config: AgentAliasConfig): string {
  const parts: string[] = [];
  for (const id of KNOWN_ALIAS_AGENTS) {
    const entry = config.agents[id];
    const canonical = CANONICAL_LABELS[id];
    const customNames: string[] = [];
    if (normalizeKey(entry.display_name) !== normalizeKey(canonical) && normalizeKey(entry.display_name) !== id) {
      customNames.push(entry.display_name);
    }
    for (const alias of entry.aliases) {
      if (normalizeKey(alias) !== normalizeKey(canonical) && normalizeKey(alias) !== id) {
        customNames.push(alias);
      }
    }
    if (customNames.length > 0) {
      parts.push(`${customNames.join("/")} = ${canonical}（${id}）`);
    }
  }
  return parts.join("；");
}

export function resolveAgentAlias(input: unknown, config: AgentAliasConfig): KnownAliasAgent | null {
  const cleaned = cleanAlias(input);
  if (!cleaned) return null;
  const key = normalizeKey(cleaned);
  if (Object.hasOwn(BUILTIN_SYNONYMS, key)) return BUILTIN_SYNONYMS[key]!;
  let matched: KnownAliasAgent | null = null;
  for (const id of KNOWN_ALIAS_AGENTS) {
    const entry = config.agents[id];
    const candidates = [entry.display_name, ...entry.aliases].map(normalizeKey);
    if (candidates.includes(key)) {
      if (matched && matched !== id) return null;
      matched = id;
    }
  }
  return matched;
}

export function createAgentAliasStore(file: string): AgentAliasStore {
  function ensure(): { created: boolean; file: string } {
    if (existsSync(file)) return { created: false, file };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(defaultAgentAliasConfig(), null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, file);
      return { created: true, file };
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  function load(): AgentAliasConfig {
    try {
      const raw = readFileSync(file, "utf8");
      return parseConfig(JSON.parse(raw));
    } catch {
      return defaultAgentAliasConfig();
    }
  }
  function read(): AgentAliasSnapshot {
    const config = load();
    return {
      ...config,
      file,
      summary: formatAgentAliasSummary(config),
    };
  }
  return {
    file,
    ensure,
    read,
    resolve(input) {
      return resolveAgentAlias(input, load());
    },
    summary() {
      return formatAgentAliasSummary(load());
    },
  };
}
