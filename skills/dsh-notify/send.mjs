// 每次调用读取本机私有配置，不输出凭证，不将凭证传入命令行参数。
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function notificationConfigPath(env = process.env, home = homedir()) {
  if (env.DSH_AGENT_RELAY_CONFIG) {
    if (!isAbsolute(env.DSH_AGENT_RELAY_CONFIG)) throw new Error('DSH_AGENT_RELAY_CONFIG 必须是绝对文件路径');
    return env.DSH_AGENT_RELAY_CONFIG;
  }
  let root = env.DSH_HOME?.trim().length ? env.DSH_HOME : join(home, '.dsh');
  if (root === '~') root = home;
  else if (root.startsWith('~/') || root.startsWith('~\\')) root = join(home, root.slice(2));
  return join(resolve(root), 'agent-relay', 'notification-client.json');
}

export async function sendNotification(input, { env = process.env, home } = {}) {
  const path = notificationConfigPath(env, home);
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('未找到有效的本机通知配置，请在 DSH 中重新生成凭证；自定义 DSH_HOME 时设置 DSH_AGENT_RELAY_CONFIG 指向配置文件'); }
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/api/agent-relay/notifications' || endpoint.search || endpoint.hash)
      throw new Error();
  } catch { throw new Error('通知地址必须是本机 127.0.0.1 的 HTTP 通知入口'); }
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token)) throw new Error('本机通知凭证格式无效，请在 DSH 中重新生成凭证');
  const query = input?.status === true;
  if (query && (Object.keys(input).some(key => !['status', 'request_id'].includes(key)) ||
    typeof input.request_id !== 'string' || !input.request_id.trim() || input.request_id.length > 1000))
    throw new Error('状态查询仅接受 --status 与原 --request-id，不接受发送参数');
  const results = ['completed','failed','idle_timeout','expired','session_closed','unreachable'];
  if (!query && (!input || !['claude','codex'].includes(input.agent) || !input.external_session_id || !input.request_id || typeof input.summary !== 'string' || input.summary.length > 4000 || !results.includes(input.result ?? 'completed'))) throw new Error('通知参数无效，必须提供 Agent、真实会话 ID、稳定 request_id 和不超过 4000 字符的摘要');
  const targeted = input.dsh_session_id !== undefined || input.dsh_session_name !== undefined;
  if ([input.dsh_session_id, input.dsh_session_name].some(value => value !== undefined && (typeof value !== 'string' || !value.trim())))
    throw new Error('目标会话 ID 或名称不能为空');
  // 旧插件会忽略未知字段；专用路径确保旧版本拒绝，不能误投默认会话。
  if (query) endpoint.pathname = '/api/agent-relay/notifications/status';
  else if (targeted) endpoint.pathname = '/api/agent-relay/notifications/targeted';
  // 白名单构造正文，防止意外把配置凭证放进摘要以外的字段。
  const body = query ? {request_id: input.request_id} : { agent: input.agent, external_session_id: input.external_session_id, request_id: input.request_id, result: input.result ?? 'completed', summary: input.summary,
    ...(input.dsh_session_id !== undefined ? {dsh_session_id: input.dsh_session_id} : {}),
    ...(input.dsh_session_name !== undefined ? {dsh_session_name: input.dsh_session_name} : {}),
    ...(input.subscription_id ? {subscription_id:input.subscription_id} : {}), ...(input.external_ref ? {external_ref:input.external_ref} : {}) };
  let response;
  try { response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch (error) {
    // fetch 会把系统错误放在 cause 中。只输出白名单诊断，不能打印原始错误或请求头。
    const code = error?.cause?.code ?? error?.code;
    if (code === 'EPERM' || code === 'EACCES')
      throw new Error(`本机通知连接被权限或沙箱策略阻止（${code}）；不能据此判断 DSH 未启动。请通过执行工具申请本机回环网络访问权限，获准后使用原 request_id 和原摘要重试；不要在同一受限环境中反复重试`);
    if (code === 'ECONNREFUSED')
      throw new Error('本机通知连接被拒绝（ECONNREFUSED）；请核对 DSH 通知服务是否监听配置中的地址和端口，恢复后使用原 request_id 重试');
    if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code))
      throw new Error('通知请求超时，结果未知；先核对接收记录，重试必须复用原 request_id 和原摘要');
    throw new Error('通知连接中断或结果未知；请核对网络权限及 DSH 通知服务，重试必须复用原 request_id 和原摘要');
  }
  if (response.status === 401) throw new Error('通知凭证已失效，请核对 DSH_HOME 或重新生成凭证后使用原 request_id 重试');
  if (query && response.status === 404) throw new Error('未找到原通知记录，或当前插件不支持状态查询；不能据此判断已完成或直接重发');
  if (response.status !== (query ? 200 : 202)) {
    if (targeted && response.status === 404) throw new Error('当前 DSH 插件不支持定向发送，请先升级插件；未回退到默认会话');
    let detail;
    try { detail = (await response.json()).error; } catch { /* 非结构化错误不回显。 */ }
    const codes = ['invalid_target', 'target_missing', 'target_mismatch', 'target_ambiguous', 'target_query_failed', 'target_archived', 'request_conflict', 'target_unavailable'];
    if (detail && codes.includes(detail.code) && typeof detail.message === 'string') {
      const candidates = Array.isArray(detail.candidates) ? detail.candidates
        .filter(item => typeof item?.id === 'string' && typeof item?.title === 'string')
        .map(item => `名称：${JSON.stringify(item.title)}，ID：${JSON.stringify(item.id)}`).join('\n') : '';
      // 仅展示已知业务错误及名称/ID；不回显原始响应或请求头。
      throw new Error([detail.message, candidates].filter(Boolean).join('\n').replaceAll(config.token, '[凭证已隐藏]'));
    }
    throw new Error(`通知未被接收（HTTP ${response.status}），请检查 DSH 前置安装与通知设置`);
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('通知响应无法解析，重试必须复用原 request_id'); }
  if (query) {
    const states = ['pending', 'delivering', 'delivered', 'unknown', 'failed', 'processed', 'muted', 'exhausted', 'needs_attention', 'unknown_attention'];
    if (result.request_id !== input.request_id || !states.includes(result.delivery_status))
      throw new Error('状态响应无法确认，不推断已送达或已完成');
    const output = {request_id: result.request_id, delivery_status: result.delivery_status};
    for (const key of ['targeted', 'agent', 'external_session_id', 'dsh_session_id', 'batch_id', 'attempts', 'retry_at', 'processed_at', 'created_at']) {
      const value = result[key];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
        output[key] = typeof value === 'string' ? value.replaceAll(config.token, '[凭证已隐藏]') : value;
    }
    return output;
  }
  if (result.accepted !== true) throw new Error('通知未确认接收，重试必须复用原 request_id');
  return { accepted: true, duplicate: result.duplicate === true, subscription_id: result.subscription_id, dsh_session_id: result.dsh_session_id,
    ...(result.targeted === true ? {targeted: true, delivery_status: result.delivery_status} : {}) };
}

// 兼容 Node 24.0：不依赖较新版本的 import.meta.main。
if (process.argv[1] && (import.meta.url === pathToFileURL(resolve(process.argv[1])).href || import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)) {
  try {
    const input = {};
    const allowed = new Set(['agent','external-session-id','request-id','summary','result','subscription-id','external-ref','dsh-session-id','dsh-session-name']);
    const args = process.argv.slice(2), seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const key = args[i].replace(/^--/, '');
      if (seen.has(key)) throw new Error('参数重复');
      seen.add(key);
      if (args[i] === '--status') { input.status = true; continue; }
      if (!args[i].startsWith('--') || !allowed.has(key) || args[i + 1] === undefined) throw new Error('用法：node send.mjs --agent codex --external-session-id <真实 ID> --request-id <稳定 ID> --summary <结果摘要>');
      input[key.replaceAll('-', '_')] = args[++i];
    }
    console.log(JSON.stringify(await sendNotification(input)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
