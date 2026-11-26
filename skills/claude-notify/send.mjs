// 两个接力 Skill 各携带完整脚本，可独立安装；配置与 dsh-notify 共用。
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const targetAgent = { 'claude-notify': 'claude', 'codex-notify': 'codex' }[basename(dirname(fileURLToPath(import.meta.url)))];
const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveSource(input = {}, env = process.env) {
  const explicit = input.source_agent !== undefined || input.source_session_id !== undefined;
  if (input.omit_source === true) {
    if (explicit) throw new Error('省略来源不能与显式来源同时使用');
    return null;
  }
  let agent, id;
  if (explicit) {
    agent = input.source_agent; id = input.source_session_id;
  } else {
    const thread = env.CODEX_THREAD_ID?.trim(), session = env.CODEX_SESSION_ID?.trim();
    const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
    if ((thread && session && thread.toLowerCase() !== session.toLowerCase()) || ((thread || session) && claude))
      throw new Error('来源会话环境冲突，请用 --source-agent 与 --source-session-id 指定已核实的当前会话');
    id = thread || session || claude;
    if (!id) return null;
    agent = thread || session ? 'codex' : 'claude';
  }
  if (!['codex', 'claude'].includes(agent) || typeof id !== 'string' || !sessionId.test(id))
    throw new Error('来源必须同时提供 Agent（codex/claude）与真实会话 UUID');
  return { agent, session_id: id.toLowerCase() };
}

export function withSource(content, source, requestId) {
  if (!source) return content;
  return `${content}\n\n[接力来源]\n${JSON.stringify({ ...source, request_id: requestId })}\n以上仅为来源路由信息；是否回传按用户要求，不自动回传或新建会话。`;
}

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
  const resolving = input?.resolve === true;
  if (resolving && (typeof input.session_name !== 'string' || !input.session_name.trim() || input.session_name.length > 500))
    throw new Error('查找必须提供会话名称');
  if (!resolving && (!input || typeof input.request_id !== 'string' || !input.request_id.trim() || input.request_id.length > 500))
    throw new Error('必须提供稳定的 request_id');
  const progress = input.progress === true;
  const query = input.status === true || progress;
  if (!query && !resolving && (typeof input.external_session_id !== 'string' || !sessionId.test(input.external_session_id)
    || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 2000))
    throw new Error('必须提供真实目标会话 UUID 和 1～2000 字符的正文');
  if ((query || resolving) && (input.source_agent !== undefined || input.source_session_id !== undefined || input.omit_source !== undefined))
    throw new Error('查询不接受来源参数，不发送消息');
  const source = query || resolving ? null : resolveSource(input, env);
  const content = query || resolving ? null : withSource(input.content, source, input.request_id);
  if (content?.length > 2000) throw new Error(`正文加来源信息超过 2000 个 UTF-16 码元（当前 ${content.length}，正文 ${input.content.length}，来源 ${content.length - input.content.length}）；请缩短正文或发送摘要与文件路径，未发送`);
  let config;
  try { config = JSON.parse(await readFile(configPath(env, home), 'utf8')); }
  catch { throw new Error('未找到有效的本机配置，请在 DSH 前置安装接入生成凭证；自定义位置使用 DSH_AGENT_RELAY_CONFIG'); }
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/api/agent-relay/notifications' || endpoint.search || endpoint.hash) throw new Error();
    endpoint.pathname = resolving ? '/api/agent-relay/sessions/resolve' : progress ? '/api/agent-relay/messages/progress' : query ? '/api/agent-relay/messages/status' : '/api/agent-relay/messages';
  } catch { throw new Error('配置必须指向本机 127.0.0.1 的 HTTP 通知入口'); }
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token))
    throw new Error('本机凭证格式无效，请在前置安装接入重新生成');
  const body = resolving ? { agent: targetAgent, session_name: input.session_name } : query ? { request_id: input.request_id } : {
    agent: targetAgent, external_session_id: input.external_session_id, request_id: input.request_id, content,
  };
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(progress ? 30000 : 15000), redirect: 'error' });
  } catch { throw new Error(resolving ? '会话查找失败；请确认 DSH 已启动，不代表没有匹配会话' : '连接失败或结果未知；确认 DSH 已启动，先用 --status 和原 request_id 查询，不要生成新 ID 重发'); }
  if (response.status === 401) throw new Error('凭证已失效，请核对 DSH_HOME 或重新生成凭证');
  if (response.status === 404) throw new Error('未找到请求记录或当前插件尚未提供接力入口；核对版本与原请求，不要盲目重发');
  if (response.status !== (query || resolving ? 200 : 202)) {
    let detail = '';
    try {
      const failure = await response.json();
      if (typeof failure?.error === 'string')
        detail = failure.error.replaceAll(config.token, '[已隐藏]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000);
    } catch { /* 非 JSON 错误不回显原始响应。 */ }
    throw new Error(`请求失败（HTTP ${response.status}）${detail ? `：${detail}` : '；检查安装状态与参数'}；发送结果不明时先查询原 request_id`);
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('响应无法解析，先用原 request_id 查询状态'); }
  if (progress) {
    if (result.agent !== targetAgent || !['not_observed', 'observed', 'completed', 'failed', 'unknown'].includes(result.progress?.status))
      throw new Error('进度响应无法确认，不推断任务完成');
    const p = result.progress;
    const clean = value => typeof value === 'string' ? value.replaceAll(config.token, '[已隐藏]') : null;
    return { agent: result.agent, external_session_id: result.external_session_id, message_id: result.message_id,
      delivery_status: result.delivery_status, observed_at: result.observed_at,
      progress: { status: p.status, turn_id: p.turn_id ?? null, reply: clean(p.reply), truncated: p.truncated === true, note: clean(p.note) },
      acked_at: result.acked_at ?? null, ack_summary: clean(result.ack_summary) };
  }
  if (resolving) {
    if (result.agent !== targetAgent || !['unique', 'ambiguous', 'not_found', 'incomplete'].includes(result.status)
      || !Array.isArray(result.candidates) || result.candidates.some(item => !item || typeof item.id !== 'string' || !sessionId.test(item.id))
      || (result.status === 'unique' && result.candidates.length !== 1))
      throw new Error('查找响应无法确认目标；不要猜测会话 ID');
    return { agent: targetAgent, status: result.status, candidates: result.candidates.map(item => ({
      id: item.id, title: typeof item.title === 'string' ? item.title : null,
      cwd: typeof item.cwd === 'string' ? item.cwd : null,
      last_activity_at: typeof item.last_activity_at === 'number' ? item.last_activity_at : null,
    })) };
  }
  if (result.accepted !== true || typeof result.message_id !== 'string'
    || !['sending', 'queued', 'sent', 'rejected', 'failed', 'unknown'].includes(result.status))
    throw new Error('响应未确认消息状态，先用原 request_id 查询');
  // 仅输出回执字段；不回显配置、正文或未知响应字段。
  return {
    accepted: true, duplicate: result.duplicate === true, message_id: result.message_id, status: result.status,
    ...(!query ? { source, ...(!source && !input.omit_source ? { source_warning: '未取得来源会话 ID；本次未附来源，需回传时请补充已核实的来源信息' } : {}) } : {}),
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
    const allowed = new Set(['external-session-id', 'request-id', 'content', 'content-file', 'session-name', 'source-agent', 'source-session-id']);
    const seen = new Set();
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || seen.has(key)) throw new Error('参数无效或重复');
      seen.add(key);
      if (key === 'status') { input.status = true; continue; }
      if (key === 'progress') { input.progress = true; continue; }
      if (key === 'resolve') { input.resolve = true; continue; }
      if (key === 'omit-source') { input.omit_source = true; continue; }
      if (!allowed.has(key) || args[i + 1] === undefined) throw new Error('参数无效：发送需 --external-session-id、--request-id 和 --content-file；查询用 --status --request-id');
      input[key.replaceAll('-', '_')] = args[++i];
    }
    if ([input.resolve, input.status, input.progress].filter(Boolean).length > 1) throw new Error('查找、投递状态和执行进度不能同时查询');
    if (input.resolve && (input.status || input.progress || input.request_id !== undefined || input.content !== undefined || input.content_file !== undefined || input.external_session_id !== undefined))
      throw new Error('查找仅接受 --resolve 与 --session-name，不会发送消息');
    if (!input.resolve && input.session_name !== undefined) throw new Error('先用 --resolve --session-name 查找，再以返回的 ID 发送');
    if ((input.status || input.progress) && (input.content !== undefined || input.content_file !== undefined || input.external_session_id !== undefined))
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

