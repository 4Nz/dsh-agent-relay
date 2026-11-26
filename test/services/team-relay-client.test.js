import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { defaultTeamRelayPreset } from "../../lib/services/team-relay/policy.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const nodes = tree => [tree, ...tree.children.filter(child => typeof child === "object").flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => node.children.filter(child => typeof child === "string")).join(" ");
const button = (tree, label) => nodes(tree).find(node => node.type === "button" && node.children.includes(label));
const agentSelect = tree => nodes(tree).find(node => node.props["aria-label"] === "网络搜索的执行 Agent");

// 与客户端现有测试一致，执行真实打包模块；每次挂载独立保存 hook，卸载执行 effect cleanup。
function settingsHarness() {
  let plugin, component, active;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== false && child !== undefined) }),
    useState(initial) {
      const owner = active, index = owner.cursor++;
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === "function" ? initial() : initial;
      return [owner.hooks[index], value => {
        owner.hooks[index] = typeof value === "function" ? value(owner.hooks[index]) : value;
        owner.dirty = true;
      }];
    },
    useRef(initial) {
      const index = active.cursor++;
      return active.hooks[index] ??= { current: initial };
    },
    useEffect(run, deps) {
      const owner = active, index = owner.cursor++, previous = owner.hooks[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        const effect = { deps, cleanup: previous?.cleanup };
        owner.hooks[index] = effect;
        owner.effects.push(() => { effect.cleanup?.(); effect.cleanup = run(); });
      }
    },
  };
  runInNewContext(readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8"), {
    structuredClone,
    setInterval: () => 1, clearInterval() {},
    window: {
      addEventListener() {}, removeEventListener() {}, confirm: () => true,
      __ModuleLoader__: { load(entry) { plugin = entry.factory(() => react); } },
    },
  });
  plugin.apply({
    slots: {
      inject(_name, run) { return run(); },
      register(options, view) { if (options.name === "settings.section") component = view; return () => {}; },
    },
    connection: { rpc: { call() {} } },
    uiWorkspace: { openSession() {} },
  });
  assert.equal(typeof component, "function");
  return {
    mount(rpc) {
      const owner = { hooks: [], effects: [], cursor: 0, dirty: true, mounted: true, tree: null };
      function render() {
        assert.ok(owner.mounted);
        active = owner; owner.cursor = 0; owner.dirty = false;
        owner.tree = component({ rpc }); active = null;
      }
      return {
        async flush() {
          for (let round = 0; round < 20; round++) {
            if (owner.dirty) render();
            for (const run of owner.effects.splice(0)) run();
            await tick();
            if (!owner.dirty && !owner.effects.length) return owner.tree;
          }
          assert.fail("设置页未收敛到稳定状态");
        },
        unmount() {
          assert.equal(owner.effects.length, 0, "卸载前应提交 effect");
          owner.mounted = false;
          for (const hook of owner.hooks) hook?.cleanup?.();
        },
      };
    },
  };
}

function serverFixture() {
  let snapshot = { revision: 0, preset: defaultTeamRelayPreset() };
  const calls = [], pending = [];
  const rpc = {
    async call(_channel, method, payload) {
      const endpoint = method.split("/").at(-1);
      calls.push({ endpoint, payload: structuredClone(payload) });
      if (endpoint === "team_settings") return { ok: true, value: structuredClone(snapshot) };
      if (endpoint === "team_agents") return { ok: true, value: [] };
      if (endpoint === "team_settings_save") return new Promise(resolve => pending.push({ payload, resolve }));
      throw new Error(`意外调用：${endpoint}`);
    },
  };
  return {
    rpc, calls,
    finishSave() {
      const request = pending.shift();
      assert.ok(request, "应存在待完成保存");
      assert.equal(request.payload.revision, snapshot.revision, "后续保存必须使用最新版本号");
      snapshot = { revision: snapshot.revision + 1, preset: structuredClone(request.payload.preset) };
      request.resolve({ ok: true, value: structuredClone(snapshot) });
    },
  };
}

async function changeAgent(view, value) {
  let tree = await view.flush();
  agentSelect(tree).props.onChange({ target: { value } });
  tree = await view.flush();
  assert.equal(agentSelect(tree).props.value, value);
  return tree;
}

test("设置页卸载后恢复 Agent 草稿与未完成编辑，其他连接不继承草稿", async () => {
  const host = settingsHarness(), server = serverFixture();
  let view = host.mount(server.rpc);
  let tree = await changeAgent(view, "codex");
  nodes(tree).find(node => node.props["aria-label"] === "编辑网络搜索").props.onClick();
  tree = await view.flush();
  const editorName = nodes(tree).find(node => node.type === "input" && node.props.value === "网络搜索");
  editorName.props.onChange({ target: { value: "尚未完成的类型名称" } });
  await view.flush(); view.unmount();

  view = host.mount(server.rpc); tree = await view.flush();
  assert.equal(agentSelect(tree).props.value, "codex");
  assert.ok(nodes(tree).some(node => node.type === "input" && node.props.value === "尚未完成的类型名称"));
  assert.match(text(tree), /已恢复尚未保存的修改/);
  assert.equal(server.calls.filter(call => call.endpoint === "team_settings").length, 1);
  view.unmount();

  const other = host.mount(serverFixture().rpc); tree = await other.flush();
  assert.equal(agentSelect(tree).props.value, "dsh");
  assert.ok(!text(tree).includes("已恢复尚未保存的修改"));
  other.unmount();
});

test("延迟保存先卸载再成功，重新挂载读取已保存配置并使用新版本号", async () => {
  const host = settingsHarness(), server = serverFixture();
  let view = host.mount(server.rpc);
  let tree = await changeAgent(view, "codex");
  button(tree, "保存配置").props.onClick();
  await view.flush(); view.unmount();
  server.finishSave(); await tick();

  view = host.mount(server.rpc); tree = await view.flush();
  assert.equal(agentSelect(tree).props.value, "codex");
  assert.equal(button(tree, "保存配置").props.disabled, true);
  assert.ok(!text(tree).includes("已恢复尚未保存的修改"));
  assert.equal(server.calls.filter(call => call.endpoint === "team_settings").length, 2);
  tree = await changeAgent(view, "claude");
  button(tree, "保存配置").props.onClick();
  assert.equal(server.calls.filter(call => call.endpoint === "team_settings_save").at(-1).payload.revision, 1);
  server.finishSave(); tree = await view.flush();
  assert.equal(button(tree, "保存配置").props.disabled, true);
  view.unmount();
});

test("保存仍在进行时重挂载等待原请求，禁止编辑且完成后采用新版本", async () => {
  const host = settingsHarness(), server = serverFixture();
  let view = host.mount(server.rpc);
  let tree = await changeAgent(view, "codex");
  button(tree, "保存配置").props.onClick();
  await view.flush(); view.unmount();

  view = host.mount(server.rpc); tree = await view.flush();
  assert.match(text(tree), /正在读取配置/);
  assert.equal(agentSelect(tree), undefined, "等待旧保存结果时不可编辑旧版本");
  assert.equal(button(tree, "保存配置").props.disabled, true);
  assert.equal(server.calls.filter(call => call.endpoint === "team_settings").length, 1);
  assert.equal(server.calls.filter(call => call.endpoint === "team_settings_save").length, 1);
  server.finishSave(); tree = await view.flush();
  assert.equal(agentSelect(tree).props.value, "codex");
  assert.equal(button(tree, "保存配置").props.disabled, true);
  assert.ok(!text(tree).includes("已恢复尚未保存的修改"));
  tree = await changeAgent(view, "claude");
  button(tree, "保存配置").props.onClick();
  assert.equal(server.calls.filter(call => call.endpoint === "team_settings_save").at(-1).payload.revision, 1);
  server.finishSave(); await view.flush(); view.unmount();
});

test("豆包使用内置登录入口，切页恢复登录状态并可检测和退出", async () => {
  const host = settingsHarness(), server = serverFixture();
  let state = "signed_out";
  const actions = [];
  const rpc = { async call(channel, method, payload) {
    if (method.endsWith("/team_agents")) return { ok: true, value: [{
      id: "doubao", label: "豆包", selectable: true, status: state, message: "内置登录状态",
    }] };
    if (method.endsWith("/team_doubao")) {
      actions.push(payload.action);
      state = ({ login: "logging_in", cancel: "signed_out", check: "connected", logout: "signed_out" })[payload.action] ?? state;
      return { ok: true, value: { state, message: "内置登录状态" } };
    }
    return server.rpc.call(channel, method, payload);
  } };
  let view = host.mount(rpc), tree = await view.flush();
  button(tree, "Agent 接入").props.onClick(); tree = await view.flush();
  assert.ok(!text(tree).includes("dsh-connect-doubao"));
  button(tree, "登录豆包").props.onClick(); tree = await view.flush();
  assert.match(text(tree), /等待登录/);
  button(tree, "取消登录").props.onClick(); tree = await view.flush();
  assert.match(text(tree), /未登录/);
  button(tree, "登录豆包").props.onClick(); await view.flush(); view.unmount();
  view = host.mount(rpc); tree = await view.flush();
  button(tree, "Agent 接入").props.onClick(); tree = await view.flush();
  assert.ok(button(tree, "取消登录"), "重挂载应继续显示服务端登录任务");
  state = "saved";
  button(tree, "重新检测").props.onClick(); tree = await view.flush();
  assert.match(text(tree), /登录态已保存/);
  button(tree, "检测登录状态").props.onClick(); tree = await view.flush();
  assert.match(text(tree), /已连接/);
  button(tree, "退出登录").props.onClick(); tree = await view.flush();
  assert.match(text(tree), /未登录/);
  assert.deepEqual(actions, ["login", "cancel", "login", "check", "logout"]);
  view.unmount();
});
