import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
test("客户端面板注入认证 RPC 和会话跳转，卸载回收注册", () => {
  let plugin;
  runInNewContext(
    readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8"),
    {
      window: {
        __ModuleLoader__: {
          load(entry) {
            plugin = entry.factory(() => ({ createElement() {} }));
          },
        },
      },
    },
  );
  const entries = [];
  let disposed = 0;
  let cleanup;
  plugin.apply({
    slots: {
      inject(_name, run) {
        cleanup = run();
        return cleanup;
      },
      register(options, component) {
        entries.push({ options, component });
        return () => disposed++;
      },
    },
    connection: { rpc: { call() {} } },
    uiWorkspace: { openSession() {} },
  });
  const panel = entries.find((e) => e.options.name === "main");
  assert.ok(panel);
  assert.equal(typeof panel.options.inject().rpc.call, "function");
  assert.equal(typeof panel.options.inject().openSession, "function");
  cleanup();
  assert.equal(disposed, 2);
});
