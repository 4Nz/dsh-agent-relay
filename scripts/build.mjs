import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../lib/", import.meta.url), { recursive: true, force: true });
// 直接用 Node 启动 JS 入口，避免 Windows 的 .cmd shim；前端清理必须发生在 tsc 之前。
for (const [entry, args] of [[fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json"))), ["-p", "tsconfig.json"]], [require.resolve("tsdown/run"), []]]) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
