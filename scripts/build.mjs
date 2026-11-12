import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../lib/", import.meta.url), { recursive: true, force: true });
// 由 npm run build 提供本项目 node_modules/.bin；前端清理必须发生在 tsc 之前。
for (const [command, args] of [["tsc", ["-p", "tsconfig.json"]], ["tsdown", []]]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
