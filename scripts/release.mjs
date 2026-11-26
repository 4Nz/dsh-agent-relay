import { discoverNotifySkills } from "../lib/services/notify-skill-registry.js";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guide = "docs/operations/T0-T1-T3-T7-plugin-release.md";
const showcaseFiles = ["task-dashboard", "dsh-subscribe", "dsh-pause", "codex-notify-request", "dsh-send-to-codex", "codex-notify-and-reply", "claude-cli-notify"].map((name) => `docs/images/showcase/${name}.png`);
export function validatePackage(pkg, files, tag) {
  if (pkg.name !== "dsh-agent-relay" || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(pkg.version)) throw new Error("包名或版本不合法");
  if (tag && tag !== `v${pkg.version}`) throw new Error("发布标签与 package.json 版本不一致");
  const flatten = (value) => typeof value === "string" ? [value] : Object.values(value).flatMap(flatten);
  const required = ["package.json", "lib/index.js", "lib/client.js", "scripts/install-skills.mjs", "skills/dsh-agent-relay/SKILL.md", "skills/dsh-notify/SKILL.md", "README.md", "CHANGELOG.md", guide,
    ...flatten(pkg.exports).map((path) => path.replace(/^\.\//, "")), pkg.dsh.bundle.patch.replace(/^\.\//, "")];
  const registered = discoverNotifySkills(fileURLToPath(new URL("../skills", import.meta.url)), []);
  if (registered.some(entry => entry.files.length === 0)) throw new Error("接力 Skill 登记文件无效");
  const senderFiles = ["skills/dsh-notify/SKILL.md", "skills/dsh-notify/send.mjs", ...registered.flatMap(entry => entry.files.map(file => `skills/${entry.name}/${file}`))];
  senderFiles.push("skills/create-agent-notify/SKILL.md", "skills/create-agent-notify/references/contract.md", "skills/create-agent-notify/scripts/install.mjs", "skills/create-agent-notify/scripts/register.mjs");
  required.push(...senderFiles, "README.en.md", ...showcaseFiles);
  for (const path of required) if (!files.includes(path)) throw new Error(`安装包缺少：${path}`);
  for (const path of files) {
    const allowed = ["package.json", "cordis.patch.yml", "README.md", "README.en.md", "CHANGELOG.md", "LICENSE", guide, "scripts/install-skills.mjs", "skills/dsh-agent-relay/SKILL.md", "skills/dsh-notify/SKILL.md"].includes(path)
      || senderFiles.includes(path) || showcaseFiles.includes(path)
      || /^lib\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.d\.ts|\.js)$/.test(path);
    if (!allowed) throw new Error(`不允许发布文件：${path}`);
  }
}

function run(command, args, cwd, capture = false) {
  // release:prepare 由 npm 启动，沿用同一个 npm CLI，不经过 Windows cmd.exe。
  if (command === "npm") {
    if (!process.env.npm_execpath) throw new Error("请通过 npm run release:prepare 执行发布检查");
    args = [process.env.npm_execpath, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit", timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}

async function release() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  // 标签与版本校验先于任何构建/打包副作用。
  if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${pkg.version}`) throw new Error("发布标签与 package.json 版本不一致");
  const temporary = await mkdtemp(join(tmpdir(), "relay-release-"));
  try {
    // 生命周期脚本会向 stdout 写日志；显式构建后禁用 pack 脚本，保留纯 JSON 清单。
    run("npm", ["run", "build"], root);
    const [pack] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary, "--cache", join(root, ".npm-cache")], root, true));
    validatePackage(pkg, pack.files.map((file) => file.path), process.env.RELEASE_TAG);
    const tarball = join(temporary, pack.filename);
    const consumer = join(temporary, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "relay-package-smoke", private: true, type: "module" }));
    // 用真实 tarball 安装，禁用所有安装脚本，证明无需用户构建。
    run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--cache", join(root, ".npm-cache"), tarball], consumer);
    run(process.execPath, [join(root, "scripts/package-smoke.mjs"), join(consumer, "node_modules", pkg.name), pkg.version], consumer);
    const output = join(root, "dist", pkg.version);
    await mkdir(output, { recursive: true });
    const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
    await cp(tarball, join(output, pack.filename));
    await writeFile(join(output, "SHA256SUMS"), `${sha256}  ${pack.filename}\n`);
    await writeFile(join(output, "release.json"), JSON.stringify({ name: pkg.name, version: pkg.version, node: process.version, engines: pkg.engines, filename: pack.filename, sha256, files: pack.files.map((f) => f.path), package_smoke: "passed", t7: "需另行记录真实宿主验收" }, null, 2) + "\n");
    console.log(`安装包验证通过：${output}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  release().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
