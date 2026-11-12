# T0、T1、T3、T7 插件发布与升级说明

## 交付方式与兼容性

第一阶段分发编译好的 npm `.tgz`，不发布到 npm registry，保留 `private:true`。npm 安装不运行编译，也不会自动安装 Skill。运行要求 Node.js >=24；服务端 ESM、浏览器入口为 DSH loader factory，不能用普通 ESM 文件替代。

包声明 DSH 范围 `>=0.2.0 <0.3.0`；官方依赖固定 `0.2.1-rc.2`，Cordis `^4.0.4`。历史接入调研环境为 DSH `0.2.1-rc.2`；该预发布版本是否被宿主兼容检查接受应以实际安装结果为准，不自动豁免。后续 DSH 版本必须先在专用 profile 验证。Claude、Codex 的可执行文件、socket 和用户授权由本机提供，不随包分发。

## 开发迭代与发布准备

在独立 worktree 开发。包版本仅在 package.json 维护，调整版本时同步 package-lock.json 与 CHANGELOG.md；已分发的相同版本不替换内容。破坏工具、HTTP 字段或 Skill 用法时明确兼容策略；变更数据库结构只追加迁移，不修改已发布的迁移。

```bash
rtk npm ci --cache ./.npm-cache
rtk npm run release:prepare
```

产物位于 `dist/<版本>/`：安装包、`SHA256SUMS` 和 `release.json`。验证包括类型检查、全量单元测试、清空 lib 后构建、exports/Skill/文件白名单、真实 tarball 临时安装（禁用安装脚本）、服务端导入、前端 loader 注册、包版本和临时数据库重开。临时安装依赖 registry 网络或本机缓存。

这些检查不启动真实 DSH，不调用外部 Agent、不产生模型费用，不能替代 T7。发布前另行记录 T7.1～T7.5 的版本、日期、步骤、结果和未验证项；原生设置页、真实 push 投递、重启对账、未知结果防重及忙碌会话转发均需实际验收。

## 安装

先下载同一版本的 tgz 与 SHA256SUMS，在下载目录验证：

```bash
rtk proxy shasum -a 256 -c SHA256SUMS
rtk proxy dsh plugin --profile web add --save-exact /绝对路径/dsh-agent-relay-0.1.0.tgz
```

通过宿主插件管理启用 bundle，并确认 profile 的 `dsh.profile.bundles` 包含 `dsh-agent-relay`。如果手动配置，只添加一次 bundle 名称，不将插件的 insert 段复制到用户 patch。必要覆盖写为 `- id: agent-relay`，避免重复 entry。退出并重启目标 DSH，刷新浏览器，核对日志版本、看板、设置入口和 push 监听日志。

命令依据本机 DSH `dsh plugin` 转发 pnpm 的接口；上述完整安装/启用/重启流程仍需在目标宿主验收。Desktop 应使用其安装自带的插件管理入口，npm 安装的 CLI 不能直接管理保留的 desktop profile。不要安装到当前运行的业务 profile 来做交付测试。

## Skill 安装与升级

在 profile 根目录执行安装包内脚本，例如：

```bash
rtk proxy node node_modules/dsh-agent-relay/scripts/install-skills.mjs /绝对路径/DSH工作项目 --scope dsh
rtk proxy node node_modules/dsh-agent-relay/scripts/install-skills.mjs /绝对路径/外部Agent项目 --scope external
```

目标为项目 `.agents/skills`。省略 scope 保持旧用法，同时安装两份 Skill；只在 Agent 确实扫描该目录时生效。脚本不会修改 Claude/Codex 的全局配置。

检查与更新：

```bash
rtk proxy node node_modules/dsh-agent-relay/scripts/install-skills.mjs /绝对路径/项目 --scope dsh --check
rtk proxy node node_modules/dsh-agent-relay/scripts/install-skills.mjs /绝对路径/项目 --scope dsh --update
```

`--check` 不写文件；缺失、来源不同或指向旧包时非零退出。安装记录位于 `.agents/skills/.dsh-agent-relay.json`，按 Skill 保存版本和链接目标。`--update` 只替换记录匹配且未被用户改动的符号链接，支持旧包移除后的断链；同名目录或用户改过的链接一律保留并报错。安装后让宿主重新扫描 Skill。

旧脚本没有安装记录：仍指向当前包的链接可以直接重新安装补记；来源不同的旧链接需要人工核对后仅移除符号链接，再重新安装，不递归删除同名目录。项目中的安装记录包含本机路径，通常应加入该项目的本地忽略规则，不提交到公共仓库。

## 升级、备份与回滚（T1）

1. 记录旧安装包版本、profile 配置与锁文件，保留旧 tgz。维护期间暂停外部 push 调用。
2. 完全退出使用该数据目录的 DSH 实例。确认退出后，备份整个 `$DSH_HOME/agent-relay` 目录以及该 DSH home 的定时任务和会话持久化数据、profile 配置与锁文件；备份目录设置仅本人可访问。DSH_HOME 默认是 `~/.dsh`，应使用启动实例的实际值。
3. 不在运行期间只复制主 sqlite 文件。离线备份应包含业务库、可能残留的 WAL/SHM、凭证摘要和 conversations 目录；恢复时同样保持宿主停止。运行锁库无需作为业务备份恢复。
4. 安装指定新 tgz，更新 Skill 链接，重启宿主并刷新浏览器；确认原订阅、凭证、定时任务对账以及通知防重状态。
5. 本包数据位于 home 目录，与 node_modules 分离，升级不重置凭证。多 profile 共用 home 时只有一个实例能持有 Relay 锁，不应同时启动两个 Relay。

插件版本与 `PRAGMA user_version` 独立。迁移在事务内完成，失败拒绝启动；旧插件拒绝更高版本数据库。没有结构变化时可安装旧包回退程序；结构变化后不能仅换回旧包，应停止宿主并配套恢复同一时点的插件数据与相关 DSH 状态。恢复旧快照会丢失备份后的变更，必须人工核对已投递通知及外部请求，不能盲目重放。不要自动降级 schema、清库或重新生成凭证。

## 停用与卸载

停用用 profile patch 中 `id: agent-relay` 配合 `disabled:true`，然后重启；恢复启用后由启动对账修复定时任务。停用期间到点的已有提醒可能无法执行工具，长时间停用前应暂停或停止订阅。

卸载先停止订阅、确认提醒清理，再退出宿主，通过插件管理移除 bundle 和依赖。卸载保留 `$DSH_HOME/agent-relay` 数据；需要清除数据时另行人工处理。安装到项目的 Skill 不自动移除，核对链接和安装记录后仅移除本插件创建的链接。

## 上传与草稿 Release

CI 在 main push 和 PR 上生成、验证并保存安装包 artifact。推送 `v<package.json版本>` 标签后，发布工作流再次验证，使用同一批 tgz、SHA256SUMS、release.json 创建草稿 Release，附带变更记录；不会自动公开发布或上传 npm registry。重复运行遇到已有 Release 时失败，不覆盖已有版本。

正式发布前人工核对 T7 记录与升级说明，再发布草稿。工作流依赖 GitHub Actions、仓库 contents 写权限和 GitHub CLI；本轮只新增配置，尚未在远端执行。命令行为参考 [npm 生命周期](https://docs.npmjs.com/cli/v11/using-npm/scripts/) 和 [gh release create](https://cli.github.com/manual/gh_release_create)。
