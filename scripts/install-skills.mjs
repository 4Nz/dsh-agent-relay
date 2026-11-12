// T3 Skill 安装：仅在显式指定的项目中建立链接，不覆盖已有内容。
import { mkdir, symlink, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("用法：node scripts/install-skills.mjs <DSH 或外部 Agent 项目目录>");
  process.exitCode = 1;
} else {
  const root = await realpath(resolve(target));
  const destination = join(root, ".agents", "skills");
  await mkdir(destination, { recursive: true });
  for (const name of ["dsh-agent-relay", "external-agent-notification"]) {
    const source = fileURLToPath(new URL(`../skills/${name}`, import.meta.url));
    const link = join(destination, name);
    try {
      await symlink(source, link, "dir");
      console.log(`已安装：${name}`);
    } catch (error) {
      if (error.code === "EEXIST" && await realpath(link).catch(() => null) === await realpath(source)) {
        console.log(`已安装：${name}`);
      } else {
        console.error(`无法安装 ${name}：目标已存在或目录不可写，请保留现有内容并人工核对。`);
        process.exitCode = 1;
      }
    }
  }
}
