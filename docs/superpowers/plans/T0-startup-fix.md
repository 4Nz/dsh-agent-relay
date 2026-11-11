# T0 启动失败修复与验证

验证日期：2026-11-11（Asia/Shanghai）。DSH：0.2.1-rc.2。

## 原因与修复

- DSH 客户端模块解析器要求 `exports["./client"]` 为字符串或带字符串 `default` 的对象；将 `import` 改为 `default`。
- 服务端访问 `ctx.tools` 前必须声明 `inject = ['tools']`。打开存储后先登记清理，再注册工具，保证后续初始化失败时可关闭数据库。
- 服务端 patch 不可加载引用 `window` 的浏览器 bundle；移除 `agent-relay-client`，由 DSH 客户端模块系统自动加载。
- 浏览器插件必须声明 `inject = ['slots']`，并通过 `ctx.slots.inject` 等待插槽定义后注册，返回清理函数。

## 验证结果

1. 修复前运行 `dsh web`：进程退出，报告导出格式、tools 注入、window 未定义三个错误。
2. 类型检查通过，构建及 14 项存储测试通过；测试使用临时数据库。
3. 备份本机 web profile 中的原插件，将修复后的 package.json、patch 与 lib 更新到已安装插件目录。
4. 重启 `dsh web --no-open`：成功监听 127.0.0.1:3080，未再报告启动失败。
5. 浏览器刷新后，DSH 主界面和 Agent Relay 菜单正常显示。

## 剩余限制

本次优先恢复启动，未发送业务消息；尚未验收 relay_ping 实际调用、空面板点击和完整 T0 能力。仓库修复位于 codex/fix-t0-startup 分支的独立 worktree，未合入 main；本机安装目录已应用修复，重新安装旧包会覆盖。
