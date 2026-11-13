// channel server 启动入口：用户级 MCP 配置以 `node <插件目录>/lib/channel/main.js` 拉起。
import { startChannelServer } from "./server.js";
import { PLUGIN_VERSION } from "../version.js";

startChannelServer({ version: PLUGIN_VERSION });
