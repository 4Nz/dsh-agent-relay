// 两个接力 Skill 各携带完整脚本，可独立安装；配置与 dsh-notify 共用。
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const targetAgent = { 'claude-notify': 'claude', 'codex-notify': 'codex' }[basename(dirname(fileURLToPath(import.meta.url)))];
const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configPath(env, home) {
  if (env.DSH_AGENT_RELAY_CONFIG) {
    if (!isAbsolute(env.DSH_AGENT_RELAY_CONFIG)) throw new Error('DSH_AGENT_RELAY_CONFIG 必须是绝对文件路径');
    return env.DSH_AGENT_RELAY_CONFIG;
  }
  let root = env.DSH_HOME?.trim().length ? env.DSH_HOME : join(home, '.dsh');
  if (root === '~') root = home;
  else if (root.startsWith('~/') || root.startsWith('~\\')) root = join(home, root.slice(2));
  return join(resolve(root), 'agent-relay', 'notification-client.json');
}

export async function sendMessage(input, { env = process.env, home = homedir() } = {}) {
  if (!targetAgent) throw new Error('请保留 claude-notify 或 codex-notify 的 Skill 目录名');
  if (!input || typeof input.request_id !== 'string' || !input.request_id.trim() || input.request_id.length > 500)
    throw new Error('必须提供稳定的 request_id');
  const query = input.status === true;
  if (!query && (typeof input.external_session_id !== 'string' || !sessionId.test(input.external_session_id)
    || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 16000))
    throw new Error('必须提供真实目标会话 UUID 和 1～16000 字符的正文');
  let config;
  try { config = JSON.parse(await readFile(configPath(env, home), 'utf8')); }
  catch { throw new Error('未找到有效的本机配置，请在 DSH 前置安装接入生成凭证；自定义位置使用 DSH_AGENT_RELAY_CONFIG'); }
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/api/agent-relay/notifications' || endpoint.search || endpoint.hash) throw new Error();
    endpoint.pathname = query ? '/api/agent-relay/messages/status' : '/api/agent-relay/messages';
  } catch { throw new Error('配置必须指向本机 127.0.0.1 的 HTTP 通知入口'); }
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token))
    throw new Error('本机凭证格式无效，请在前置安装接入重新生成');
  const body = query ? { request_id: input.request_id } : {
    agent: targetAgent, external_session_id: input.external_session_id, request_id: input.request_id, content: input.content,
  };
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch { throw new Error('连接失败或结果未知；确认 DSH 已启动，先用 --status 和原 request_id 查询，不要生成新 ID 重发'); }
  if (response.status === 401) throw new Error('凭证已失效，请核对 DSH_HOME 或重新生成凭证');
  if (response.status === 404) throw new Error('未找到请求记录或当前插件尚未提供接力入口；核对版本与原请求，不要盲目重发');
  if (response.status !== (query ? 200 : 202))
    throw new Error(`请求失败（HTTP ${response.status}）；检查安装状态与参数，发送结果不明时先查询原 request_id`);
  let result;
  try { result = await response.json(); } catch { throw new Error('响应无法解析，先用原 request_id 查询状态'); }
  if (result.accepted !== true || typeof result.message_id !== 'string'
    || !['sending', 'queued', 'sent', 'rejected', 'failed', 'unknown'].includes(result.status))
    throw new Error('响应未确认消息状态，先用原 request_id 查询');
  // 仅输出回执字段；不回显配置、正文或未知响应字段。
  return {
    accepted: true, duplicate: result.duplicate === true, message_id: result.message_id, status: result.status,
    ...(typeof result.external_ref === 'string' ? { external_ref: result.external_ref } : {}),
    ...(typeof result.error === 'string' ? { error: result.error.replaceAll(config.token, '[已隐藏]') } : {}),
    ...(typeof result.acked_at === 'number' ? { acked_at: result.acked_at } : {}),
    ...(typeof result.ack_summary === 'string' ? { ack_summary: result.ack_summary.replaceAll(config.token, '[已隐藏]') } : {}),
  };
}

if (process.argv[1] && (import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  || import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)) {
  try {
    const input = {};
    const allowed = new Set(['external-session-id', 'request-id', 'content', 'content-file']);
    const seen = new Set();
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || seen.has(key)) throw new Error('参数无效或重复');
      seen.add(key);
      if (key === 'status') { input.status = true; continue; }
      if (!allowed.has(key) || args[i + 1] === undefined) throw new Error('参数无效：发送需 --external-session-id、--request-id 和 --content-file；查询用 --status --request-id');
      input[key.replaceAll('-', '_')] = args[++i];
    }
    if (input.status && (input.content !== undefined || input.content_file !== undefined || input.external_session_id !== undefined))
      throw new Error('状态查询仅接受 --status 与 --request-id');
    if (input.content_file !== undefined) {
      if (input.content !== undefined) throw new Error('--content 与 --content-file 不能同时使用');
      try { input.content = await readFile(input.content_file, 'utf8'); }
      catch { throw new Error('无法读取正文文件'); }
    }
    const result = await sendMessage(input);
    console.log(JSON.stringify(result));
    if (['failed', 'rejected', 'unknown'].includes(result.status)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

