import { copyFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL("../", import.meta.url));
// 从单源模板同步三套跨 Agent 接力脚本，保持安装目录独立且零代码漂移。
const templateDir = join(root, "scripts", "skill-templates", "agent-notify");
for (const skill of ["claude-notify", "codex-notify", "agy-notify"]) {
  const targetDir = join(root, "skills", skill);
  await mkdir(targetDir, { recursive: true });
  for (const file of ["send.mjs", "start.mjs", "directory.mjs"]) {
    await copyFile(join(templateDir, file), join(targetDir, file));
  }
}
await rm(new URL("../lib/", import.meta.url), { recursive: true, force: true });
// 直接用 Node 启动 JS 入口，避免 Windows 的 .cmd shim；前端清理必须发生在 tsc 之前。
for (const [entry, args] of [[fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json"))), ["-p", "tsconfig.json"]], [require.resolve("tsdown/run"), []]]) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
