// T3 Skill 安装与升级：只管理显式项目中的自有链接，检查模式不写文件。
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const scopes = {
  dsh: ["dsh-agent-relay"],
  external: ["external-agent-notification"],
  all: ["dsh-agent-relay", "external-agent-notification"],
};

async function install() {
  const [target, ...args] = process.argv.slice(2);
  let scope = "all", check = false, update = false;
  if (!target || target.startsWith("--")) throw new Error("用法：node scripts/install-skills.mjs <项目目录> [--scope dsh|external|all] [--check | --update]");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scope") scope = args[++i];
    else if (args[i] === "--check") check = true;
    else if (args[i] === "--update") update = true;
    else throw new Error(`未知参数：${args[i]}`);
  }
  if (!Object.hasOwn(scopes, scope) || (check && update)) throw new Error("scope 必须为 dsh、external 或 all；--check 与 --update 不能同时使用");
  const root = await realpath(resolve(target));
  const destination = join(root, ".agents", "skills");
  const manifest = join(destination, ".dsh-agent-relay.json");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  let record = { format: 1, links: {} };
  try {
    if (!(await lstat(manifest)).isFile()) throw new Error("安装记录必须是普通文件");
    record = JSON.parse(await readFile(manifest, "utf8"));
    if (record.format !== 1 || !record.links || typeof record.links !== "object" || Array.isArray(record.links)) throw new Error("无法识别安装记录，请人工核对");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!check) await mkdir(destination, { recursive: true });
  let changed = false;
  for (const name of scopes[scope]) {
    const source = await realpath(fileURLToPath(new URL(`../skills/${name}`, import.meta.url)));
    const link = join(destination, name);
    try {
      const stat = await lstat(link).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const current = stat?.isSymbolicLink() ? resolve(dirname(link), await readlink(link)) : null;
      const same = current !== null && await realpath(link).catch(() => null) === source;
      if (check) {
        if (!same) throw new Error("缺失、来源不同或需要更新");
        console.log(`正常：${name}（包版本 ${pkg.version}）`);
        continue;
      }
      if (stat && !same) {
        const owned = stat.isSymbolicLink() && record.links[name]?.target === current;
        if (!owned) throw new Error("目标已存在且不属于本安装记录，请保留现有内容并人工核对");
        if (!update) throw new Error("已安装旧版本，请使用 --update 刷新链接");
        const temporary = `${link}.${randomUUID()}.tmp`;
        try {
          await symlink(source, temporary, process.platform === "win32" ? "junction" : "dir");
          if (process.platform === "win32") {
            // Windows 不能用 rename 覆盖现有目录 junction，先移走自有链接，失败时恢复。
            const backup = `${link}.${randomUUID()}.bak`;
            await rename(link, backup);
            try {
              await rename(temporary, link);
            } catch (error) {
              await rename(backup, link);
              throw error;
            }
            await rm(backup, { force: true });
          } else {
            await rename(temporary, link);
          }
        } finally {
          await rm(temporary, { force: true });
        }
      } else if (!stat) {
        await symlink(source, link, process.platform === "win32" ? "junction" : "dir");
      }
      // 兼容旧脚本创建的、仍指向当前包的链接，首次执行补记所有权。
      record.links[name] = { target: same ? current : source, version: pkg.version };
      changed = true;
      console.log(`已安装：${name}（${pkg.version}）`);
    } catch (error) {
      console.error(`无法处理 ${name}：${error.message}`);
      process.exitCode = 1;
    }
  }
  if (changed) {
    const temporary = `${manifest}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, manifest);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

install().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
