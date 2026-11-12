import { readFileSync } from "node:fs";

// src 与 lib 位于同一层级，安装后仍读取本包元数据。
export const PLUGIN_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
