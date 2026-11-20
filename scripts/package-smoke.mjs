// 只验证安装产物，不启动宿主、不读取外部 Agent 历史。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const [root, version] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(root, path)).href);
assert.equal((await load("lib/version.js")).PLUGIN_VERSION, version);
assert.equal(typeof (await load("lib/index.js")).apply, "function");
for (const name of ["claude-notify", "codex-notify"]) {
  assert.equal(typeof (await load(`skills/${name}/send.mjs`)).sendMessage, "function");
  assert.equal(typeof (await load(`skills/${name}/directory.mjs`)).resolveDirectory, "function");
  assert.equal(typeof (await load(`skills/${name}/start.mjs`)).prepareJob, "function");
}
assert.equal(typeof (await load("skills/claude-notify/open.mjs")).prepareLaunch, "function");
let registration;
runInNewContext(await readFile(join(root, "lib/client.js"), "utf8"), {
  window: { __ModuleLoader__: { load(entry) { registration = entry; } } },
});
assert.equal(registration.id, "dsh-agent-relay");
assert.equal(typeof registration.factory, "function");
const { openRelayStore } = await load("lib/storage/index.js");
const dataDir = await mkdtemp(join(tmpdir(), "relay-package-db-"));
try {
  for (let i = 0; i < 2; i++) {
    const store = openRelayStore({ dataDir });
    try { assert.equal(store.subscriptions.list({}).items.length, 0); }
    finally { store.close(); }
  }
} finally { await rm(dataDir, { recursive: true, force: true }); }
console.log("安装包冒烟通过：服务端导入、前端 loader、包版本、临时存储重开");
