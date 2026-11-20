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
  const results = ['completed','failed','idle_timeout','expired','session_closed','unreachable'];
  if (!input || !['claude','codex'].includes(input.agent) || !input.external_session_id || !input.request_id || typeof input.summary !== 'string' || input.summary.length > 4000 || !results.includes(input.result ?? 'completed')) throw new Error('通知参数无效，必须提供 Agent、真实会话 ID、稳定 request_id 和不超过 4000 字符的摘要');
  // 白名单构造正文，防止意外把配置凭证放进摘要以外的字段。
  const body = { agent: input.agent, external_session_id: input.external_session_id, request_id: input.request_id, result: input.result ?? 'completed', summary: input.summary,
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
  if (response.status !== 202) throw new Error(`通知未被接收（HTTP ${response.status}），请检查 DSH 前置安装与通知设置`);
  let result;
  try { result = await response.json(); } catch { throw new Error('通知响应无法解析，重试必须复用原 request_id'); }
  if (result.accepted !== true) throw new Error('通知未确认接收，重试必须复用原 request_id');
  return { accepted: true, duplicate: result.duplicate === true, subscription_id: result.subscription_id, dsh_session_id: result.dsh_session_id };
}

// 兼容 Node 24.0：不依赖较新版本的 import.meta.main。
if (process.argv[1] && (import.meta.url === pathToFileURL(resolve(process.argv[1])).href || import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)) {
  try {
    const input = {};
    const allowed = new Set(['agent','external-session-id','request-id','summary','result','subscription-id','external-ref']);
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed.has(key) || args[i + 1] === undefined) throw new Error('用法：node send.mjs --agent codex --external-session-id <真实 ID> --request-id <稳定 ID> --summary <结果摘要>');
      input[key.replaceAll('-', '_')] = args[i + 1];
    }
    console.log(JSON.stringify(await sendNotification(input)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
