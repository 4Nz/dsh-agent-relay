# T0、T1、T3、T7 插件发布与升级说明


## T1-T2-T3-T4-T6-T7 会话桥梁升级注意（2026-11-16）

本轮追加 SQLite v4/v5/v6 迁移，拆分唯一路由、主题关注、事件和持久批次。v6 为批次持久保存原关注主题、状态、规划、频率与截止上下文；旧批次可从仍存在的原关注补齐，原记录已删除时返回空上下文，不能换用新关注主题。旧重复活跃关注确定性收敛，已送事实保留不重放，未知事件不删除。升级前按下文完整备份，旧版不能直接读取更高 schema；回滚须配套同一时点数据库与宿主状态，不能只降插件。

旧“一次通知即结束、默认1分钟/60分钟、可改总时长、活动顺延”已被固定24小时主题关注替代；DSH按用户要求规划频率，未选为pending。页面不再接收时间输入。结束后默认原DSH；push按外部来源复用会话，结束后不自动关注。屏蔽push与结束关注分开。安装/升级两份随包Skill后核对无旧规则残留。

验收时分别核对active/paused/ended、pending/ready/deciding、实际频率，以及批次muted/needs_attention/unknown_attention；不可用旧单条通知判定新事件已处理。事件详情能读取原批次并在原接收会话通过relay_batch/relay_decide恢复。恢复提醒不创建关注，未知先核对、不能盲重发。

`release:prepare`仍只完成类型、单测、包清单与隔离tarball安装；不启动真实DSH，不覆盖新桥梁T7。真实验收必须独立DSH_HOME和专用会话，不能据历史Codex专项通过宣称本轮已验收，也不在本任务自动部署/发布。

## T1-T2-T3-T5-T6 状态与路由修复升级注意（2026-11-17）

追加 SQLite v7 迁移，将 relay_bridge.dsh_session_id 从 UNIQUE 改为普通索引，同一 DSH 可关注多个外部会话。迁移在事务内保留原路由 ID、屏蔽状态、事件顺序、批次、原投递目标及恢复提醒；外键延迟至提交时检查，失败整批回滚。不清空 A 的接收绑定，也不恢复此前已结束的关注。升级后 schema 为 7，旧版插件不能直接读取；回滚仍须恢复升级前配套备份。

Codex 正常 unknown 的说明移至 runtime_note，runtime_error 为 null；新增 status_context 标注历史轮次状态来源和用途。原始 cursor、turn status、事件 ID 和完成检测保留兼容，既有调用方应改读 runtime_note。inspect 附带 observed_at/last_activity_age_seconds，不代表实时空闲；check/batch/通知附带来源身份和观测说明。同步更新 DSH Skill；needs_user 会暂停关注，不能仅因 unknown 或历史 interrupted 触发。

当前工作树中的 release:prepare 产物仅用于本地验证，包版本未提升；不得覆盖已分发的同版本包，正式分发前需按下文更新版本。

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

### Windows 安装

使用 Node.js 24 或更新的受支持版本。Windows PowerShell 中校验下载包并安装到专用测试 profile（路径含空格时保留引号）：

```powershell
Get-FileHash -Algorithm SHA256 ".\dsh-agent-relay-0.1.0.tgz"
dsh plugin --profile web add --save-exact "C:\Downloads\dsh-agent-relay-0.1.0.tgz"
```

将哈希与 SHA256SUMS 对照；启用、重启及 Desktop 限制与上文相同。安装预编译 tgz 不需要 Git Bash、Python、编译工具链或 RTK。源码开发与发布仍需安装 devDependencies；没有 RTK 时直接运行 `npm ci --cache ./.npm-cache` 和 `npm run release:prepare`。构建直接以 Node 启动本地工具入口，发布检查沿用 npm 提供的 CLI，避免 Windows `.cmd` 启动差异。

Windows 安装 Skill 的示例（在 profile 根目录执行）：

```powershell
node node_modules/dsh-agent-relay/scripts/install-skills.mjs "C:\Projects\我的项目" --scope dsh
```

Windows Skill 目录使用 junction，不要求管理员或开发者模式；其他平台保留目录符号链接。更新只处理安装记录对应的自有链接，Windows 替换失败会尝试恢复旧链接。数据目录和凭证依赖 Windows 用户目录继承的文件权限保护；POSIX 的 0600/0700 不等价于 Windows 权限设置，应避免放在共享可读写目录。

本轮仅适配基础构建、打包和安装，不代表 Windows 上 Claude/Codex 发送、Unix socket 或 shell/channel 自动配置已兼容；完整 DSH 启用流程仍需专用 profile 的 T7 实测。

### Codex 已有会话订阅（0.1.3）

「新建订阅」可直接选择已有 Codex 桌面/CLI 会话，不要求先创建 Relay 后台会话。插件优先连接既有 daemon；默认 daemon 不可用时，使用本机官方 `codex app-server --listen stdio://` 子进程读取历史。连接只允许列会话和读历史，不执行 resume、新轮次或排队发送，查询后回收自有进程。历史查询可用不代表原桌面会话的实时状态可知，`notLoaded` 仍不能视为空闲或完成。

需要 DSH 启动环境能找到 Codex CLI。Windows 支持桌面自带 `codex.exe`；npm 安装的 `codex.cmd`/`codex.ps1` 解析到同目录官方包的 `node_modules/@openai/codex/bin/codex.js`，由 Node 启动，不执行 shell。macOS 沿用 PATH 中的可执行入口。可选 `DSH_CODEX_BIN` 指定官方可执行文件或 JS 入口的绝对路径；不接受带参数的命令字符串。

显式指定自定义 socket 时连接失败不自动切换，防止掩盖错误端点。消息发送和后台会话创建仍要求可用的原 daemon 写连接；本次新增的历史查询连接不会接管桌面会话。平台与真实链路验收结果另见任务验收文档，CLI 帮助存在不等于真实订阅通过。

## Skill 安装与升级

从 0.1.1 起，外部通知 Skill 包含 `SKILL.md` 和 `send.mjs`，手动安装时必须同时复制两个文件；项目链接安装自动包含整个目录。发送脚本需要 Node.js >=24，在 macOS 与 Windows 使用相同 Node 实现。

通知凭证在「任务跟踪 → 前置安装接入」安装时自动生成，写入 `$DSH_HOME/agent-relay/notification-client.json`，其中包含明文通知凭证和本机 HTTP 地址；外部 Agent 的发送脚本直接读取该文件，不再需要单独设置页或「复制凭证」。凭证为纯明文存储，仅保存在本人私有目录。

发送器每次读取客户端配置，因此凭证变化后无需重启外部 Agent。不把 token 写入环境变量。配置路径优先使用 `DSH_AGENT_RELAY_CONFIG` 指定的绝对路径，否则使用 `DSH_HOME`，最后回退当前用户主目录的 `.dsh`。macOS 默认 `~/.dsh/agent-relay/notification-client.json`；Windows 默认 `%USERPROFILE%\.dsh\agent-relay\notification-client.json`。自定义 home 或端口的实例重新生成后会写入当前实际地址；外部 Agent 未继承自定义 home 时使用前置安装接入页显示的配置路径。

客户端配置含原文，应只保存在本人私有目录，不加入版本库、日志或备份共享目录。POSIX 文件权限为 0600；Windows 继承父目录权限，用户主目录之外的路径应另行确认 ACL。配置缺失或损坏时，在前置安装接入页重新执行安装即可修复。

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

## Claude 前置安装接入（T6.6）

在订阅看板「前置安装接入」选择 Claude，点击「安装 / 修复」。插件直接写入：用户级 MCP server `agent-relay`（`claude mcp add-json -s user`）、`~/.claude/agent-relay.md` 规则与 `~/.claude/CLAUDE.md` 中的 `@agent-relay.md`、`~/.zshrc` 或 `~/.bashrc` 中带标记的 `claude` 函数、`~/.claude/agent-relay/channel-token`（0600）。修改前在原文件旁生成 `.agent-relay-<时间>.bak` 备份；重复安装只修复不正常的项。插件升级后 channel server 路径变化，自检显示 MCP「需更新」，再次安装即可。

安装后新开终端运行 `claude`，启动时在开发 channel 警告框按回车；已运行的会话需退出后 `claude --resume <会话 ID>` 重新进入。建议运行页面中的连通测试。Claude Code 升级后若自检提示“当前版本 Claude 不支持 channel”，channel 投递不可用，详情见插件日志。

「卸载 channel」删除上述配置并保留通知 Skill。停用插件前建议先卸载，否则 `claude` 函数仍会带 channel 参数启动，channel server 会因连不上 Relay 而静默重试。

## 升级、备份与回滚（T1）

1. 记录旧安装包版本、profile 配置与锁文件，保留旧 tgz。维护期间暂停外部 push 调用。
2. 完全退出使用该数据目录的 DSH 实例。确认退出后，备份整个 `$DSH_HOME/agent-relay` 目录以及该 DSH home 的定时任务和会话持久化数据、profile 配置与锁文件；备份目录设置仅本人可访问。DSH_HOME 默认是 `~/.dsh`，应使用启动实例的实际值。
3. 不在运行期间只复制主 sqlite 文件。离线备份应包含业务库、可能残留的 WAL/SHM、凭证摘要和 conversations 目录；恢复时同样保持宿主停止。运行锁库无需作为业务备份恢复。
4. 安装指定新 tgz，更新 Skill 链接，重启宿主并刷新浏览器；确认原订阅、凭证、定时任务对账以及通知防重状态。
5. 本包数据位于 home 目录，与 node_modules 分离，升级不重置凭证。多 profile 共用 home 时只有一个实例能持有 Relay 锁，不应同时启动两个 Relay。

本次 Codex 专用会话发送将数据库升级为 `user_version=2`，新增专用会话与 daemon socket 绑定；原消息、通知和订阅保留。仅升级程序而不备份数据，之后不能直接换回只支持第一版数据库的旧包。

插件版本与 `PRAGMA user_version` 独立。迁移在事务内完成，失败拒绝启动；旧插件拒绝更高版本数据库。没有结构变化时可安装旧包回退程序；结构变化后不能仅换回旧包，应停止宿主并配套恢复同一时点的插件数据与相关 DSH 状态。恢复旧快照会丢失备份后的变更，必须人工核对已投递通知及外部请求，不能盲目重放。不要自动降级 schema、清库或重新生成凭证。

## 停用与卸载

停用用 profile patch 中 `id: agent-relay` 配合 `disabled:true`，然后重启；恢复启用后由启动对账修复定时任务。停用期间到点的已有提醒可能无法执行工具，长时间停用前应暂停或停止订阅。

卸载先停止订阅、确认提醒清理，再退出宿主，通过插件管理移除 bundle 和依赖。卸载保留 `$DSH_HOME/agent-relay` 数据；需要清除数据时另行人工处理。安装到项目的 Skill 不自动移除，核对链接和安装记录后仅移除本插件创建的链接。

## 上传与草稿 Release

CI 在 main push 和 PR 上生成、验证并保存安装包 artifact。推送 `v<package.json版本>` 标签后，发布工作流再次验证，使用同一批 tgz、SHA256SUMS、release.json 创建草稿 Release，附带变更记录；不会自动公开发布或上传 npm registry。重复运行遇到已有 Release 时失败，不覆盖已有版本。

正式发布前人工核对 T7 记录与升级说明，再发布草稿。工作流依赖 GitHub Actions、仓库 contents 写权限和 GitHub CLI；本轮只新增配置，尚未在远端执行。命令行为参考 [npm 生命周期](https://docs.npmjs.com/cli/v11/using-npm/scripts/) 和 [gh release create](https://cli.github.com/manual/gh_release_create)。
