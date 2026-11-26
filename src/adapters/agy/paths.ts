import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const AGY_SIDECAR_ID = "dsh-agent-relay";
export const AGY_SIDECAR_DISPLAY_NAME = "DSH Agent Relay Bridge";

export interface AgyPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  cliPath?: string;
  cliArgs?: string[];
  existsFile?: (path: string) => boolean;
}

function defaultExistsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function expandHome(raw: string, homeDir: string, paths: typeof posix | typeof win32): string {
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return paths.join(homeDir, raw.slice(2));
  return paths.resolve(raw);
}

function selectPathModule(platform: NodeJS.Platform, homeDir?: string): typeof posix | typeof win32 {
  if (platform !== "win32") return posix;
  if (process.platform === "win32") return win32;
  if (!homeDir || /^[a-zA-Z]:[\\/]/.test(homeDir) || homeDir.startsWith("\\\\")) return win32;
  return posix;
}

export function resolveGeminiDir({
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
}: AgyPathOptions = {}): string {
  const paths = selectPathModule(platform, homeDir);
  const custom = env.ANTIGRAVITY_GEMINI_DIR?.trim() || env.GEMINI_DIR?.trim();
  return custom ? expandHome(custom, homeDir, paths) : paths.join(homeDir, ".gemini");
}

export function resolveAgyConfigDir(options: AgyPathOptions = {}): string {
  const paths = selectPathModule(options.platform ?? process.platform, options.homeDir);
  return paths.join(resolveGeminiDir(options), "config");
}

export function resolveAgySkillsDir(options: AgyPathOptions = {}): string {
  const paths = selectPathModule(options.platform ?? process.platform, options.homeDir);
  return paths.join(resolveAgyConfigDir(options), "skills");
}

export function resolveAgySidecarDir(options: AgyPathOptions = {}): string {
  const paths = selectPathModule(options.platform ?? process.platform, options.homeDir);
  return paths.join(resolveAgyConfigDir(options), "sidecars", AGY_SIDECAR_ID);
}

export function resolveAgyBridgeTokenPath(options: AgyPathOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.AGENT_RELAY_AGY_TOKEN_FILE?.trim()) return env.AGENT_RELAY_AGY_TOKEN_FILE.trim();
  const paths = selectPathModule(options.platform ?? process.platform, options.homeDir);
  return paths.join(resolveAgyConfigDir(options), "dsh-agent-relay", "bridge-token");
}

export function resolveAgyDataDirs(options: AgyPathOptions & { dataDirs?: string[] } = {}): {
  dir: string;
  surface: "antigravity" | "antigravity-ide" | "antigravity-cli";
}[] {
  if (options.dataDirs) {
    return options.dataDirs.map((dir) => ({
      dir,
      surface: dir.endsWith("antigravity-cli")
        ? "antigravity-cli"
        : dir.endsWith("antigravity-ide")
          ? "antigravity-ide"
          : "antigravity",
    }));
  }
  const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const gemini = resolveGeminiDir(options);
  return [
    { dir: paths.join(gemini, "antigravity"), surface: "antigravity" },
    { dir: paths.join(gemini, "antigravity-ide"), surface: "antigravity-ide" },
    { dir: paths.join(gemini, "antigravity-cli"), surface: "antigravity-cli" },
  ];
}

export function resolveAgyCommand({
  cliPath,
  cliArgs = [],
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  homeDir = homedir(),
  existsFile = defaultExistsFile,
}: AgyPathOptions = {}): { command: string; args: string[]; found: boolean } {
  const paths = platform === "win32" ? win32 : posix;
  const wrap = (command: string, found: boolean) =>
    /\.[cm]?js$/i.test(command)
      ? { command: nodePath, args: [command, ...cliArgs], found }
      : { command, args: cliArgs, found };

  const specified = cliPath ?? env.DSH_AGY_BIN?.trim();
  if (specified) return wrap(specified, existsFile(specified));

  const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"];
  for (const rawDir of pathEntry.split(separator).filter(Boolean)) {
    const dir = rawDir.replace(/^"(.*)"$/, "$1");
    for (const name of names) {
      const candidate = paths.join(dir, name);
      if (existsFile(candidate)) return wrap(candidate, true);
    }
  }

  const fallbacks =
    platform === "win32"
      ? [
          ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe")] : []),
          win32.join(homeDir, "AppData", "Local", "agy", "bin", "agy.exe"),
        ]
      : [
          posix.join(homeDir, ".local", "bin", "agy"),
          "/opt/homebrew/bin",
          "/usr/local/bin/agy",
        ].map((p) => (p.endsWith("/bin") ? posix.join(p, "agy") : p));

  for (const candidate of fallbacks) {
    if (existsFile(candidate)) return wrap(candidate, true);
  }
  return wrap(platform === "win32" ? "agy.exe" : "agy", false);
}

export function detectAgyDesktopBinary({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  existsFile = defaultExistsFile,
}: AgyPathOptions = {}): string | null {
  if (env.DSH_AGY_LS_BIN?.trim() && existsFile(env.DSH_AGY_LS_BIN.trim())) {
    return env.DSH_AGY_LS_BIN.trim();
  }
  const candidates =
    platform === "win32"
      ? [
          ...(env.LOCALAPPDATA
            ? [
                win32.join(env.LOCALAPPDATA, "Programs", "Antigravity", "resources", "bin", "language_server.exe"),
                win32.join(env.LOCALAPPDATA, "Antigravity", "resources", "bin", "language_server.exe"),
              ]
            : []),
          win32.join(homeDir, "AppData", "Local", "Programs", "Antigravity", "resources", "bin", "language_server.exe"),
          ...(env.ProgramFiles
            ? [win32.join(env.ProgramFiles, "Antigravity", "resources", "bin", "language_server.exe")]
            : []),
        ]
      : platform === "darwin"
        ? [
            "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
            posix.join(homeDir, "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"),
          ]
        : [
            "/opt/Antigravity/resources/bin/language_server",
            "/usr/lib/antigravity/resources/bin/language_server",
          ];

  for (const candidate of candidates) {
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

export function uriToFilePath(uri: string | null | undefined): string | null {
  if (!uri || typeof uri !== "string") return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("file://")) return trimmed;
  try {
    // 兼容 Windows (file:///C:/...) 与 POSIX (file:///Users/...) 路径转换。
    const winDrive = /^file:\/\/\/[a-zA-Z]:/.test(trimmed) || /^file:\/\/\/[a-zA-Z]%3A/i.test(trimmed);
    if (winDrive && process.platform !== "win32") {
      const url = new URL(trimmed);
      return decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, "$1").replaceAll("/", "\\");
    }
    return fileURLToPath(trimmed);
  } catch {
    return null;
  }
}
