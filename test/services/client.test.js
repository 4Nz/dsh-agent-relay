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
  const cleanups = [];
  plugin.apply({
    slots: {
      inject(_name, run) {
        const cleanup = run();
        if (_name !== "sidebar.panellist") cleanups.push(cleanup);
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
  for (const cleanup of cleanups.reverse()) cleanup();
  const settings = entries.find((e) => e.options.name === "settings.section");
  assert.ok(settings);
  assert.equal(typeof settings.options.inject().rpc.call, "function");
  assert.equal(disposed, 3);
});

test("凭证设置使用认证 RPC，明文只在当前组件实例展示", async () => {
  let plugin, cursor = 0, states = [], effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = value; }];
    },
    useEffect(run) { effects.push(run); },
  };
  runInNewContext(readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(entry) { plugin = entry.factory(() => react); } } },
  });
  const calls = [];
  const rpc = { async call(channel, method) {
    calls.push([channel, method]);
    return { ok: true, value: method.endsWith("credential_get")
      ? { configured: false } : { configured: true, digest: "abcdef0123456789", token: "test-token" } };
  } };
  const render = () => { cursor = 0; return plugin.CredentialSettings({ rpc }); };
  const nodes = (tree) => [tree, ...tree.children.filter((x) => typeof x === "object").flatMap(nodes)];
  render(); effects.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  const generate = nodes(render()).find((x) => x.type === "button" && x.children.includes("生成凭证"));
  assert.equal(generate.props.disabled, false);
  await generate.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(nodes(render()).some((x) => x.type === "textarea" && x.props.value === "test-token"));
  assert.deepEqual(calls, [["/api", "agent-relay/credential_get"], ["/api", "agent-relay/credential_generate"]]);
  states = []; effects = [];
  assert.equal(nodes(render()).some((x) => x.type === "textarea"), false);
});
