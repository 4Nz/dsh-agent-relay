// 官方 CLI 后台新建；仅记录执行事实，回传由 Agent 按用户要求调用发送 Skill。
import { mkdir, readFile, writeFile, rename, realpath, stat, open, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const target = { 'codex-notify': 'codex', 'claude-notify': 'claude', 'agy-notify': 'agy' }[basename(dirname(self))];
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
export async function readStdinText({ stream = process.stdin, maxBytes = 128 * 1024, timeoutMs = 15000 } = {}) {
  if (stream.isTTY) throw new Error('使用 --stdin 时必须通过管道或 heredoc 传入正文，不能交互式等待终端输入');
  return await new Promise((resolve_, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { stream.destroy(); } catch { /* 忽略关闭异常 */ }
      finish(reject, new Error('读取标准输入超时'));
    }, timeoutMs);
    timer.unref?.();
    const onData = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      bytes += buf.length;
      if (bytes > maxBytes) {
        try { stream.destroy(); } catch { /* 忽略关闭异常 */ }
        finish(reject, new Error(`标准输入超过 ${maxBytes} 字节上限`));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
      finish(resolve_, text);
    };
    const onError = () => finish(reject, new Error('读取标准输入失败'));
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume?.();
  });
}
function jobDirectory(requestId, { env = process.env, home = homedir() } = {}) {
  if (!target) throw new Error('请保留 codex-notify、claude-notify 或 agy-notify 目录名');
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 450)
    throw new Error('必须提供 1～450 字符的稳定 request_id');
  const root = env.DSH_HOME?.trim() || join(home, '.dsh');
  const expanded = root === '~' ? home : root.startsWith('~/') || root.startsWith('~\\') ? join(home, root.slice(2)) : resolve(root);
  return join(expanded, 'agent-relay', 'background-jobs', target, hash(requestId));
}

function resolveWindowsShim(shimPath, agent) {
  const dir = dirname(shimPath);
  const exeSibling = join(dir, `${agent}.exe`);
  if (existsSync(exeSibling)) return { command: exeSibling, prefixArgs: [] };
  if (/\.(cmd|bat)$/i.test(shimPath)) {
    try {
      const body = readFileSync(shimPath, 'utf8');
      const match = body.match(/%dp0%[\\/]([^\r\n"]+\.[cm]?js)/i);
      if (match?.[1]) {
        const jsPath = join(dir, match[1].replaceAll('\\', '/'));
        if (existsSync(jsPath)) return { command: process.execPath, prefixArgs: [jsPath] };
      }
    } catch { /* 读取 shim 失败时继续已知路径回退 */ }
  }
  const knownJs = agent === 'claude'
    ? [join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')]
    : agent === 'codex'
      ? [join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]
      : [];
  for (const candidate of knownJs) {
    if (existsSync(candidate)) return { command: process.execPath, prefixArgs: [candidate] };
  }
  return null;
}

export function resolveCliSpawn(agent, env = process.env, home = homedir(), platform = process.platform) {
  const isWin = platform === 'win32';
  const override = agent === 'agy'
    ? env.DSH_AGY_BIN?.trim()
    : env[agent === 'codex' ? 'DSH_CODEX_BIN' : 'DSH_CLAUDE_BIN']?.trim();
  const toSpec = candidate => {
    if (/\.[cm]?js$/i.test(candidate)) return { command: process.execPath, prefixArgs: [candidate] };
    if (isWin && /\.(cmd|bat|ps1)$/i.test(candidate)) return resolveWindowsShim(candidate, agent);
    return { command: candidate, prefixArgs: [] };
  };
  if (override) {
    const resolved = toSpec(override);
    if (!resolved) throw new Error(`Windows 下不支持直接启动 ${override}，请安装原生 .exe 或指定对应的 JS 入口`);
    return resolved;
  }
  const pathVal = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '';
  const pathDirs = pathVal.split(isWin ? ';' : ':').filter(Boolean).map(dir => dir.replace(/^"(.*)"$/, '$1'));
  if (isWin) {
    for (const dir of pathDirs) {
      const exe = join(dir, `${agent}.exe`);
      if (existsSync(exe)) return { command: exe, prefixArgs: [] };
    }
    for (const dir of pathDirs) {
      for (const ext of ['.cmd', '.bat', '.ps1']) {
        const shim = join(dir, `${agent}${ext}`);
        if (existsSync(shim)) {
          const resolved = resolveWindowsShim(shim, agent);
          if (resolved) return resolved;
        }
      }
    }
    const fallbacks = agent === 'agy'
      ? [...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')] : []), join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')]
      : [];
    for (const candidate of fallbacks) if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
    return { command: `${agent}.exe`, prefixArgs: [] };
  }
  if (agent === 'agy') {
    for (const dir of pathDirs) {
      const candidate = join(dir, 'agy');
      if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
    }
    for (const candidate of [join(home, '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']) {
      if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
    }
  }
  return { command: agent, prefixArgs: [] };
}

export async function prepareJob(input, options = {}) {
  const directory = jobDirectory(input.request_id, options);
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) throw new Error('新建前必须确定绝对工作目录');
  const cwd = await realpath(input.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('工作目录不是目录');
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 16000)
    throw new Error('正文必须为 1～16000 字符');
  // worker.mjs 被单独复制；仅准备阶段加载 Skill 中的来源助手。
  const { resolveSource, withSource } = await import('./send.mjs');
  const source = resolveSource(input, options.env ?? process.env);
  const content = withSource(input.content, source, input.request_id);
  if (content.length > 16000) throw new Error('正文加来源信息超过 16000 字符，请缩短正文，未启动');
  let reply = null;
  if (input.reply_agent !== undefined || input.reply_session_id !== undefined) {
    if (!['claude', 'codex', 'agy'].includes(input.reply_agent) || !uuid.test(input.reply_session_id ?? ''))
      throw new Error('回传必须同时指定来源 Agent（claude/codex/agy）与真实会话 ID');
    reply = { agent: input.reply_agent, session_id: input.reply_session_id, request_id: `${input.request_id}:result` };
  }
  const fingerprint = hash(JSON.stringify({ cwd, content: input.content, reply, source }));
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')); }
    catch { throw new Error('原启动请求状态未知，请检查记录，不要更换 request_id 重开'); }
    const legacy = previous.source === undefined && previous.fingerprint === hash(JSON.stringify({ cwd, content: input.content, reply }));
    if (previous.fingerprint !== fingerprint && !legacy) throw new Error('request_id 已用于其他目录、正文、来源或回传目标');
    return { directory, duplicate: true, ...await inspectJob(input.request_id, options) };
  }
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const gemini = env.ANTIGRAVITY_GEMINI_DIR?.trim() || env.GEMINI_DIR?.trim() || join(home, '.gemini');
  const skills = target === 'codex' ? join(env.CODEX_HOME || join(home, '.codex'), 'skills')
    : target === 'agy' ? join(gemini, 'config', 'skills')
    : join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills');
  const prompt = `${content}\n\n[接力任务 ${input.request_id}]\n` + (reply
    ? `用户已要求本次结果回传：处理完成、失败或需用户介入时，使用 ${reply.agent}-notify 向 ${reply.agent} 会话 ${reply.session_id} 发送一次结果。发送脚本：${join(skills, `${reply.agent}-notify`, 'send.mjs')}。固定 request_id：${reply.request_id}。同次结果核对/重试保持 ID、目标和正文不变；结果不明先查状态。回传入队后结束，不等待对方再回信，不另建会话，不扩大任务授权。请在最终回复中记录实际回传状态；无法回传时保留结果并说明原因。`
    : '本次仅委托处理，未要求主动回传；请在最终回复中写明结果或阻碍，供发起方只读查询。');
  const request = { agent: target, request_id: input.request_id, cwd, prompt, reply, source, fingerprint,
    session_id: target === 'claude' ? randomUUID() : null, created_at: Date.now() };
  await writeFile(join(directory, 'request.json'), JSON.stringify(request) + '\n', { mode: 0o600, flag: 'wx' });
  await copyFile(self, join(directory, 'worker.mjs'));
  await save(join(directory, 'state.json'), { status: 'prepared', session_id: request.session_id, updated_at: Date.now() });
  return { directory, duplicate: false, ...await inspectJob(input.request_id, options) };
}

export async function inspectJob(requestId, options = {}) {
  const directory = jobDirectory(requestId, options);
  let request, state;
  try {
    request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
    state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  } catch { throw new Error('未找到完整启动记录，不能据此重试新建；请核对原 request_id 与 DSH_HOME'); }
  if (state.status === 'running' && Date.now() - state.updated_at > 30000)
    state = { ...state, status: 'unknown', error: '执行进程心跳已过期；实际会话可能仍在运行，不自动重启或重发' };
  return { agent: request.agent, request_id: requestId, cwd: request.cwd, status: state.status,
    session_id: state.session_id ?? request.session_id, created_at: request.created_at,
    updated_at: state.updated_at, finished_at: state.finished_at ?? null,
    result: state.result ?? null, result_file: state.result_file ?? null,
    result_truncated: state.result_truncated === true, error: state.error ?? null,
    record_file: join(directory, 'state.json'), reply: request.reply, source: request.source ?? null,
    ...(!request.source ? { source_warning: '此任务没有来源会话信息；需回传时请补充已核实的来源 ID' } : {}),
    note: 'completed 仅表示本轮执行结束；业务是否完成及回传是否成功需看结果。查询不会启动或重发任务。' };
}

export async function launchJob(job, { env = process.env } = {}) {
  if (job.duplicate) return job;
  // 在 spawn 前落下唯一启动锁；崩溃留下未知状态也不能重新执行有副作用的任务。
  try { await (await open(join(job.directory, 'launch.lock'), 'wx', 0o600)).close(); }
  catch (error) { if (error.code === 'EEXIST') return { ...job, status: 'unknown', duplicate: true }; throw error; }
  await save(join(job.directory, 'state.json'), { status: 'unknown', session_id: job.session_id, updated_at: Date.now(), error: '已请求后台启动，等待执行进程确认' });
  const log = await open(join(job.directory, 'worker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [join(job.directory, 'worker.mjs'), '--worker', job.directory],
      { env, cwd: job.cwd, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve_, reject) => { child.once('spawn', resolve_); child.once('error', reject); });
    child.unref();
    return { ...job, status: 'starting', note: '已请求后台执行；用同一 request_id 查询，不重复提交首条任务。' };
  } finally { await log.close(); }
}

export async function runJob(directory, { env = process.env } = {}) {
  try { await (await open(join(directory, 'run.lock'), 'wx', 0o600)).close(); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  const statePath = join(directory, 'state.json');
  let state = { status: 'running', session_id: request.session_id, updated_at: Date.now(), runner_pid: process.pid };
  let writing = Promise.resolve();
  const persist = () => { const value = { ...state, updated_at: Date.now() }; writing = writing.then(() => save(statePath, value)); return writing; };
  await persist();
  const heartbeat = setInterval(() => void persist().catch(() => {}), 5000);
  heartbeat.unref();
  const args = request.agent === 'codex'
    ? ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', request.cwd, '-']
    : request.agent === 'agy'
      ? ['--output-format', 'stream-json', '-p', request.prompt]
      : ['-p', '--session-id', request.session_id, '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
  // 子 Agent 的来源必须是自己的会话，不能继承发起方的身份。
  const childEnv = { ...env };
  delete childEnv.CODEX_THREAD_ID;
  delete childEnv.CODEX_SESSION_ID;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('ANTIGRAVITY_')) delete childEnv[key];
  }
  if (request.agent === 'claude') childEnv.CLAUDE_CODE_SESSION_ID = request.session_id;
  let final = null, lastReply = null, agyStreamReply = '', ended = false, denied = false, line = '', parseError = false;
  const output = await open(join(directory, 'output.jsonl'), 'a', 0o600);
  const stderr = await open(join(directory, 'stderr.log'), 'a', 0o600);
  let outputBytes = 0, errorBytes = 0, writes = Promise.resolve();
  const keep = (handle, value, isError = false) => {
    const size = Buffer.byteLength(value);
    if (isError ? errorBytes + size > 16 * 1024 * 1024 : outputBytes + size > 16 * 1024 * 1024) return;
    if (isError) errorBytes += size; else outputBytes += size;
    writes = writes.then(() => handle.write(value));
  };
  function event(raw) {
    let e; try { e = JSON.parse(raw); } catch { if (raw.trim()) parseError = true; return; }
    if (request.agent === 'codex') {
      if (e.type === 'thread.started' && uuid.test(e.thread_id ?? '')) state.session_id = e.thread_id;
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') lastReply = e.item.text;
      if (e.type === 'turn.completed') { ended = true; final = lastReply; }
      if (e.type === 'turn.failed') { state.error = 'Codex 本轮执行失败，详情见本地输出记录'; state.status = 'failed'; }
    } else if (request.agent === 'agy') {
      if (uuid.test(e.conversation_id ?? '')) state.session_id = e.conversation_id;
      if (uuid.test(e.step_update?.conversation_id ?? '')) state.session_id = e.step_update.conversation_id;
      if (uuid.test(e.result?.conversation_id ?? '')) state.session_id = e.result.conversation_id;
      if (e.event === 'step_update' && e.step_update?.step_type === 'agent_response' && typeof e.step_update.text_delta === 'string') {
        agyStreamReply += e.step_update.text_delta;
        lastReply = agyStreamReply;
      }
      if (e.event === 'result' && e.result) {
        if (typeof e.result.response === 'string' && e.result.response) lastReply = e.result.response;
        if (e.result.status === 'SUCCESS') {
          ended = true;
          final = typeof e.result.response === 'string' ? e.result.response : lastReply;
        } else {
          state.status = 'failed';
          state.error = (typeof e.result.error === 'string' && e.result.error.trim().slice(0, 500)) || 'Antigravity CLI 本轮执行失败，详情见本地输出记录';
        }
      }
    } else {
      if (uuid.test(e.session_id ?? '')) state.session_id = e.session_id;
      if (e.type === 'assistant') {
        const text = e.message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (text) lastReply = text;
      }
      if (e.type === 'result') {
        ended = true; final = typeof e.result === 'string' ? e.result : lastReply;
        denied = Array.isArray(e.permission_denials) && e.permission_denials.length > 0;
        if (e.is_error || e.subtype !== 'success') state.status = 'failed';
      }
    }
    state.result = typeof lastReply === 'string' ? lastReply.slice(0, 16000) : null;
  }
  let outcome;
  let resolveError = null;
  try {
    let spec;
    try { spec = resolveCliSpawn(request.agent, childEnv); }
    catch (error) { resolveError = error instanceof Error ? error.message : String(error); }
    if (resolveError) {
      outcome = { code: null, spawnError: true };
    } else {
      const child = spawn(spec.command, [...spec.prefixArgs, ...args], { cwd: request.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        keep(output, chunk);
        line += chunk;
        let at;
        while ((at = line.indexOf('\n')) >= 0) { const complete = line.slice(0, at); line = line.slice(at + 1); event(complete); }
        if (line.length > 2 * 1024 * 1024) { line = ''; parseError = true; }
      });
      child.stderr.on('data', chunk => keep(stderr, chunk, true));
      child.stdin.on('error', () => {});
      child.stdin.end(request.agent === 'agy' ? '' : request.prompt);
      outcome = await new Promise(resolve_ => {
        child.once('error', () => resolve_({ code: null, spawnError: true }));
        child.once('close', (code, signal) => resolve_({ code, signal }));
      });
      if (line.trim()) event(line);
    }
  } finally {
    clearInterval(heartbeat);
    await writes; await output.close(); await stderr.close();
  }
  if (typeof final === 'string') {
    await writeFile(join(directory, 'result.txt'), final, { mode: 0o600 });
    state.result = final.slice(0, 16000); state.result_file = join(directory, 'result.txt'); state.result_truncated = final.length > 16000;
  }
  if (outcome.spawnError) { state.status = 'failed'; state.error = resolveError || `无法启动 ${request.agent}，请检查 CLI 安装`; }
  else if (state.status !== 'failed') {
    state.status = ended && outcome.code === 0 && !parseError && state.session_id ? (denied ? 'needs_attention' : 'completed') : 'unknown';
    if (state.status === 'unknown') state.error = '未确认正常轮次结束；保留原会话与记录，不自动重跑';
    if (denied) state.error = '有工具权限请求被拒绝，请结合结果处理';
  }
  state.finished_at = Date.now();
  await persist();
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(self)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--worker' && args.length === 2) await runJob(args[1]);
    else {
      const input = {}, seen = new Set(); let status = false;
      for (let i = 0; i < args.length; i++) {
        const key = args[i].replace(/^--/, '');
        if (!args[i].startsWith('--') || seen.has(key)) throw new Error('参数无效或重复');
        seen.add(key);
        if (key === 'status') { status = true; continue; }
        if (key === 'omit-source') { input.omit_source = true; continue; }
        if (key === 'stdin') { input.stdin = true; continue; }
        if (!['request-id', 'cwd', 'content', 'content-file', 'reply-agent', 'reply-session-id', 'source-agent', 'source-session-id'].includes(key) || args[i + 1] === undefined)
          throw new Error('新建使用 --cwd --request-id 与正文（--stdin、--content 或 --content-file）；查询使用 --status --request-id');
        input[key.replaceAll('-', '_')] = args[++i];
      }
      if (status) {
        if (Object.keys(input).some(key => key !== 'request_id')) throw new Error('查询仅接受 --status --request-id');
        console.log(JSON.stringify(await inspectJob(input.request_id)));
      } else {
        const sources = [input.content !== undefined, input.content_file !== undefined, input.stdin === true].filter(Boolean).length;
        if (sources !== 1) throw new Error('新建必须且只能提供一种正文来源：--stdin、--content 或 --content-file');
        if (input.content_file !== undefined) {
          try { input.content = await readFile(input.content_file, 'utf8'); }
          catch { throw new Error('无法读取正文文件'); }
        } else if (input.stdin === true) {
          input.content = await readStdinText();
        }
        const prepared = await prepareJob(input);
        console.log(JSON.stringify(await launchJob(prepared)));
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
