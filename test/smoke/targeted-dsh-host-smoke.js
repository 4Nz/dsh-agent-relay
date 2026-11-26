// T1/T2/T3/T7：已安装 Codex Skill → 隔离真实 DSH 宿主 → 专用会话。
// 不调用外部 Agent 模型；DSH 使用确定性模型，不修改业务 DSH 数据。
// CODEX_TEST_THREAD_ID 必须为调用方真实会话 ID。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { openRelayStore } from '../../lib/storage/index.js';
import { createNotificationCredentialService } from '../../lib/services/credentials.js';

const external = process.env.CODEX_TEST_THREAD_ID;
assert.ok(external, '需要真实 CODEX_TEST_THREAD_ID');
const install = process.env.DSH_INSTALL_ROOT ?? join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh');
const repository = fileURLToPath(new URL('../..', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-targeted-host-')));
const home = join(root, 'dsh'), profile = join(home, 'profiles/web'), plugin = join(profile, 'node_modules/dsh-agent-relay');
const sender = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills/dsh-notify/send.mjs');
assert.equal(readFileSync(sender, 'utf8'), readFileSync(join(repository, 'skills/dsh-notify/send.mjs'), 'utf8'), '已安装脚本应与本次构建一致');
mkdirSync(plugin, {recursive: true});
symlinkSync(join(install, 'node_modules/@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), 'dir');
for (const name of ['package.json', 'cordis.patch.yml', 'lib', 'skills']) cpSync(join(repository, name), join(plugin, name), {recursive: true});
const hostVersion = JSON.parse(readFileSync(join(install, 'package.json'))).version;
writeFileSync(join(profile, 'package.json'), JSON.stringify({name: 'relay-targeted-host-smoke', private: true, type: 'module',
  dsh: {profile: {bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-relay']}},
  dependencies: {'@deepseek-ai/dsh-base': hostVersion, '@deepseek-ai/dsh-web-app': hostVersion, 'dsh-agent-relay': '0.1.9'}}));
writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port; await new Promise(r => reserve.close(r));
const config = join(home, 'agent-relay/notification-client.json');
const {token} = createNotificationCredentialService({file: config, endpoint: `http://127.0.0.1:${port}/api/agent-relay/notifications`}).ensure();
Object.assign(process.env, {DSH_HOME: home, DSH_AGENT_RELAY_PORT: String(port), DSH_TELEMETRY_DISABLED: '1'});
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...args) => write(String(chunk).replaceAll(token, '[凭证已隐藏]').replace(/([?&]token=)[^\s]+/g, '$1[凭证已隐藏]'), ...args);
}
const load = p => import(pathToFileURL(p).href);
const {runProfile} = await load(join(install, 'lib/profile-boot.js'));
const {createLaunchEnvironmentSnapshot} = await load(join(install, 'node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js'));
const {LlmAdapter} = await load(join(install, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js'));
let releaseBusy, hold = false, app, store;
class FixtureModel extends LlmAdapter {
  async listModels() {return [{provider: 'targeted-smoke', id: 'fixture', name: '定向消息验收模型', contextWindow: 128000}];}
  async *stream(options) {
    if (hold && JSON.stringify(options.messages.at(-1)).includes('TARGETED_BUSY_GATE'))
      await new Promise(r => releaseBusy = r);
    yield {type: 'block-start', index: 0, blockType: 'text'};
    yield {type: 'text-delta', index: 0, text: '定向消息已处理'};
    yield {type: 'block-end', index: 0, block: {type: 'text', text: '定向消息已处理'}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }
}
const report = {date: new Date().toISOString(), host_version: hostVersion, node: process.version, root, scenarios: []};
const note = text => {report.scenarios.push(text); console.log(text);};
async function until(check, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {if (await check()) return; await sleep(250);}
  throw Error(`等待超时：${label}`);
}
async function boot() {
  app = await runProfile({environment: createLaunchEnvironmentSnapshot([{source: 'process', values: process.env}]), profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0']});
  app.ctx.get('llm').registerAdapter(['targeted-smoke'], new FixtureModel());
  store = openRelayStore({dataDir: join(home, 'agent-relay')});
}
async function create(title) {
  const cwd = join(root, 'workspace'); mkdirSync(cwd, {recursive: true});
  const {sessionId} = await app.ctx.get('sessionController').create({cwd, agentPreset: 'standard'});
  await app.ctx.get('sessionController').selectModel({sessionId, provider: 'targeted-smoke', model: 'fixture'});
  await app.ctx.get('sessionController').rename({sessionId, title});
  return sessionId;
}
async function send(requestId, target = [], summary = '专用定向消息测试，请只回复已收到，不调用工具。') {
  const result = await promisify(execFile)(process.execPath, [sender, '--agent', 'codex', '--external-session-id', external, '--request-id', requestId, '--summary', summary, ...target],
    {env: {...process.env, DSH_AGENT_RELAY_CONFIG: config}, timeout: 25000});
  return JSON.parse(result.stdout);
}
async function hasMessage(sessionId, key) {
  const events = (await app.ctx.get('sessionQuery').readSession(sessionId)).events;
  // 同一条消息会同时产生入箱事件和持久 user/message，不能将两个阶段当成两次投递。
  const messages = events.filter(e => e.type === 'user/message' && e.data.id === key).length;
  const splices = events.filter(e => e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.id === key)).length;
  return Math.max(messages, splices);
}
const timeout = setTimeout(() => {console.error('隔离宿主测试超时'); process.exit(1);}, 180000);
try {
  await boot();
  const a = await create('定向测试-原会话'), b = await create('定向测试-目标会话');
  report.sessions = {a, b};
  // 只在隔离库预置默认接收路由，用于验证本次定向发送不会重绑。
  store.bridge.ensure('codex', external, a);
  const prefix = 'targeted-host-' + randomUUID();
  const named = await send(prefix + '-name', ['--dsh-session-name', '定向测试-目标会话']);
  assert.equal(named.dsh_session_id, b); assert.equal(named.delivery_status, 'delivered');
  const first = store.targetedNotifications.get(prefix + '-name');
  await until(async () => await hasMessage(b, first.delivery_key) === 1, '名称消息进入真实宿主历史');
  assert.equal(await hasMessage(a, first.delivery_key), 0);
  const duplicate = await send(prefix + '-name', ['--dsh-session-name', '定向测试-目标会话']);
  assert.equal(duplicate.duplicate, true); assert.equal(await hasMessage(b, first.delivery_key), 1);
  note('按完整名称送达真实目标；重复请求只保留一次投递');
  const idResult = await send(prefix + '-id', ['--dsh-session-id', a]);
  assert.equal(idResult.dsh_session_id, a);
  await until(() => store.targetedNotifications.get(prefix + '-id').state === 'delivered', 'ID 消息送达');
  assert.equal(await hasMessage(a, store.targetedNotifications.get(prefix + '-id').delivery_key), 1);
  assert.equal(store.bridge.route('codex', external).dsh_session_id, a);
  note('按 ID 送达另一会话；原默认路由未改变');
  const c = await create('定向测试-目标会话');
  await assert.rejects(send(prefix + '-ambiguous', ['--dsh-session-name', '定向测试-目标会话']), e => e.stderr.includes(b) && e.stderr.includes(c));
  assert.equal(store.targetedNotifications.get(prefix + '-ambiguous'), null);
  await assert.rejects(send(prefix + '-name', ['--dsh-session-id', a]), e => e.stderr.includes('原请求不一致'));
  note('真实同名会话返回两个候选 ID；重试换目标被拒绝');
  const {agent} = await app.ctx.get('sessionController').resolveAgent(b);
  await until(() => agent.status === 'idle', '目标空闲');
  hold = true;
  agent.followup({id: randomUUID(), role: 'user', source: {kind: 'fixture'}, content: [{type: 'text', text: 'TARGETED_BUSY_GATE'}]});
  await until(() => !!releaseBusy && agent.status === 'running', '真实宿主忙碌');
  const queued = await send(prefix + '-busy', ['--dsh-session-id', b]);
  assert.equal(queued.delivery_status, 'pending');
  const busyKey = store.targetedNotifications.get(prefix + '-busy').delivery_key;
  assert.equal(await hasMessage(b, busyKey), 0);
  hold = false; releaseBusy();
  await until(() => agent.status === 'idle', '释放专用忙碌轮次');
  store.close(); store = undefined;
  await app.ctx.fiber.dispose(); app = undefined;
  await boot();
  await until(() => store.targetedNotifications.get(prefix + '-busy').state === 'delivered', '重启自动投递排队消息');
  assert.equal(await hasMessage(b, busyKey), 1);
  assert.equal(store.bridge.route('codex', external).dsh_session_id, a);
  note('真实忙时落库；宿主重启后仍向原指定目标投递一次');
  const fallback = await send(prefix + '-default');
  assert.equal(fallback.dsh_session_id, a);
  note('未指定目标的下一条通知仍进入原默认会话');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.message;
  console.error(error.message); process.exitCode = 1;
} finally {
  hold = false; releaseBusy?.(); store?.close();
  if (app) await app.ctx.fiber.dispose();
  clearTimeout(timeout);
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log('测试报告：' + join(root, 'result.json'));
}
