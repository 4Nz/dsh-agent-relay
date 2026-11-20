// T7.6：打开可见 Claude 终端，使用独立本机 HTTP/数据库/channel 凭证验证首次任务及已有 ID 接力。
// 需要用户确认终端内的信任/channel/工具提示；不自动确认权限，不修改全局 MCP 配置。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { openRelayStore } from '../../lib/storage/index.js';
import { createClaudeAdapter } from '../../lib/adapters/claude/index.js';
import { createRunner } from '../../lib/adapters/claude/runner.js';
import { createClaudeAgentList } from '../../lib/adapters/claude/agents.js';
import { createAdapterRegistry } from '../../lib/adapters/registry.js';
import { createRelayService } from '../../lib/services/relay.js';
import { createClaudeChannelService } from '../../lib/services/claude-channel.js';
import { createChannelRoutes } from '../../lib/services/channel-http.js';
import { createMessageRoutes } from '../../lib/services/message-http.js';
import { createPushServer } from '../../lib/services/push.js';
import { prepareLaunch, openLaunch } from '../../skills/claude-notify/open.mjs';
import { resolveDirectory } from '../../skills/claude-notify/directory.mjs';
import { sendMessage } from '../../skills/claude-notify/send.mjs';

const [flag, argument] = process.argv.slice(2);
if (!['--cwd', '--resume-launch'].includes(flag)) throw new Error('必须明确提供专用测试目录 --cwd <绝对路径>，或核对已打开的测试启动记录 --resume-launch <launch.json>');
const previous = flag === '--resume-launch' ? JSON.parse(await readFile(argument, 'utf8')) : null;
const resolved = await resolveDirectory(previous?.cwd ?? argument);
assert.equal(resolved.status, 'resolved', '先确定目录再启动');
const root = previous ? dirname(dirname(dirname(dirname(argument)))) : await mkdtemp(join(tmpdir(), 'relay-visible-claude-'));
const port = previous ? Number(new URL(JSON.parse(await readFile(join(root,'client.json'),'utf8')).endpoint).port) : 0;
const store = openRelayStore({ dataDir: root });
const listAgents = createClaudeAgentList(createRunner());
const channel = createClaudeChannelService({ store, listAgents });
const adapter = createClaudeAdapter({ channel });
const relay = createRelayService({ store, adapters: createAdapterRegistry([adapter]), subscriptions: {}, checks: {}, notifications: {}, skillInstall: {}, listDshSessions: async () => [], onQueued: () => channel.tick() });
const token = randomBytes(32).toString('base64url');
const credentials = { verify: value => value === token };
const server = createPushServer({ port, handler: async () => new Response('', {status:404}), routes: { ...createMessageRoutes({ relay, credentials }), ...createChannelRoutes({ channel, credentials }) } });
let tick;
try {
  const { port } = await server.start();
  const tokenFile = join(root, 'channel-token');
  const config = join(root, 'client.json');
  await writeFile(tokenFile, token, {mode:0o600});
  await writeFile(config, JSON.stringify({endpoint:`http://127.0.0.1:${port}/api/agent-relay/notifications`,token}), {mode:0o600});
  const launch = previous ?? await prepareLaunch({request_id:randomUUID(),cwd:resolved.path,content:'这是用户授权的专用可见会话测试。请只回复 VISIBLE_CLAUDE_READY，不调用工具、不读写文件、不创建其他会话。后续 channel 测试按用户授权处理，并仅调用 agent-relay 的 ack 工具确认。'},
    {env:{...process.env,DSH_HOME:root,DSH_AGENT_RELAY_PORT:String(port),AGENT_RELAY_CHANNEL_TOKEN_FILE:tokenFile}});
  if (!previous) await openLaunch(launch);
  console.log(JSON.stringify({status:'opened',session_id:launch.session_id,cwd:resolved.path,launch_directory:dirname(launch.record_file)}));
  tick = setInterval(() => void channel.tick(), 1000);
  let saved;
  try { saved=JSON.parse(await readFile(join(root,'test-message.json'),'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deadline = Date.now() + 10 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    let exit;
    try { exit = JSON.parse(await readFile(join(dirname(launch.record_file),'exit.json'),'utf8')); } catch {}
    if (exit) throw new Error(`可见终端提前退出：${JSON.stringify(exit)}`);
    const snapshot = await adapter.snapshot(launch.session_id);
    if (!snapshot.closed) assert.equal(snapshot.cwd, resolved.path, '真实会话目录与指定目录必须一致');
    if ((snapshot.last_reply?.includes('VISIBLE_CLAUDE_READY') || (saved && snapshot.last_reply?.includes(saved.marker)))
      && (await channel.accept(launch.session_id)).status === 'queued') { ready=true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(ready, '等待可见终端启动/确认超时；不重开、不重发');
  console.log(JSON.stringify({status:'ready',session_id:launch.session_id}));
  const marker = saved?.marker ?? `VISIBLE_CLAUDE_RELAY_${randomUUID()}`;
  const input = saved?.input ?? { request_id:randomUUID(), external_session_id:launch.session_id,content:`这是用户授权的已有会话 ID 接力测试。请只回复 ${marker}，并调用 agent-relay 的 ack 工具，summary 包含这个标记。不读写文件，不发送其他消息。` };
  assert.equal(input.external_session_id, launch.session_id);
  if (!saved) await writeFile(join(root,'test-message.json'),JSON.stringify({marker,input}),{mode:0o600,flag:'wx'});
  const options = {env:{DSH_AGENT_RELAY_CONFIG:config}};
  const result = await sendMessage(input, options);
  assert.ok(['queued','sent'].includes(result.status));
  assert.equal((await sendMessage(input, options)).duplicate, true);
  console.log(JSON.stringify({status:result.status,session_id:launch.session_id,request_id:input.request_id}));
  const ackDeadline = Date.now() + 5 * 60_000;
  let message;
  do {
    message = store.messages.get(result.message_id);
    if (message.acked_at && message.ack_summary?.includes(marker)) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < ackDeadline);
  assert.ok(message.acked_at && message.ack_summary?.includes(marker), '未收到处理确认；核对终端工具权限提示，不重发');
  assert.equal(store.subscriptions.list().items.length, 0);
  console.log(JSON.stringify({result:'passed',session_id:launch.session_id,cwd:resolved.path,ack_summary:message.ack_summary,duplicate_suppressed:true,subscriptions_created:0}));
} finally {
  clearInterval(tick); channel.dispose();
  const stopping = server.stop();
  // 活跃终端会立即继续轮询；显式关闭本次测试 HTTP 连接，避免清理阶段一直等待。
  server.server.closeAllConnections(); await stopping; store.close();
  // 启动记录保留用于人工核对，临时 token 不连接真实 DSH；终端继续可见，不强行关闭。
  console.log(JSON.stringify({test_data:root,test_server:'stopped'}));
}
