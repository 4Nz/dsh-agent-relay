// 在可见终端中启动交互式 Claude，不创建后台执行实例。
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function prepareLaunch(input, { home = homedir(), env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('自动打开可见终端目前仅支持 macOS；请手动新开终端运行交互式 Claude，不使用后台模式');
  if (typeof input.request_id !== 'string' || !input.request_id.trim() || input.request_id.length > 500)
    throw new Error('必须提供稳定的 request_id');
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 16000)
    throw new Error('正文必须为 1～16000 字符');
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) throw new Error('必须提供绝对工作目录');
  const cwd = await realpath(input.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('工作目录不是目录');
  const root = env.DSH_HOME?.trim() || join(home, '.dsh');
  const expanded = root === '~' ? home : root.startsWith('~/') || root.startsWith('~\\') ? join(home, root.slice(2)) : resolve(root);
  const parent = join(expanded, 'agent-relay', 'visible-launches');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = join(parent, hash(input.request_id));
  const recordPath = join(directory, 'launch.json');
  const fingerprint = hash(JSON.stringify({ cwd, content: input.content }));
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(await readFile(recordPath, 'utf8')); }
    catch { throw new Error('原请求准备状态未知，请检查可见终端与启动目录，不要更换 request_id 重开'); }
    if (previous.fingerprint !== fingerprint) throw new Error('request_id 已用于其他工作目录或正文');
    return { ...previous, duplicate: true };
  }
  const sessionId = randomUUID();
  const preservedEnv = Object.fromEntries(['PATH', 'CLAUDE_CONFIG_DIR', 'DSH_HOME', 'DSH_AGENT_RELAY_CONFIG', 'DSH_AGENT_RELAY_PORT', 'AGENT_RELAY_CHANNEL_TOKEN_FILE'].filter(key => env[key]).map(key => [key, env[key]]));
  const payload = { cwd, session_id: sessionId, content: input.content, env: preservedEnv };
  await writeFile(join(directory, 'request.json'), JSON.stringify(payload) + '\n', { mode: 0o600, flag: 'wx' });
  // 独立载荷文件使 Skill 升级不会改变已经准备好的启动命令。
  const runner = `import { readFile, open, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const directory = new URL('.', import.meta.url);
try { await (await open(new URL('started', directory), 'wx', 0o600)).close(); }
catch { console.error('该启动请求已执行过，请查看原终端，不重复启动'); process.exit(1); }
const input = JSON.parse(await readFile(new URL('request.json', directory), 'utf8'));
const env = { ...process.env, ...input.env }; delete env.CLAUDECODE;
const child = spawn('claude', ['--session-id', input.session_id, '--dangerously-load-development-channels', 'server:agent-relay', '--', input.content], { cwd: input.cwd, env, stdio: 'inherit' });
child.on('error', async () => { await writeFile(new URL('exit.json', directory), JSON.stringify({ status: 'failed', reason: '无法启动 claude' }), { mode: 0o600 }); console.error('无法启动 claude，请检查 CLI 安装'); process.exitCode = 1; });
child.on('exit', async (code, signal) => { await writeFile(new URL('exit.json', directory), JSON.stringify({ status: 'exited', code, signal }), { mode: 0o600 }); process.exitCode = code ?? 1; });
`;
  await writeFile(join(directory, 'run.mjs'), runner, { mode: 0o600, flag: 'wx' });
  const commandFile = join(directory, '打开 Claude 接力.command');
  await writeFile(commandFile, `#!/bin/zsh\nexec ${quote(process.execPath)} ${quote(join(directory, 'run.mjs'))}\n`, { mode: 0o700, flag: 'wx' });
  const record = { status: 'prepared', session_id: sessionId, cwd, command_file: commandFile, record_file: recordPath, fingerprint, duplicate: false };
  await save(recordPath, record);
  return record;
}

export async function openLaunch(record, { run = promisify(execFile) } = {}) {
  if (record.status !== 'prepared') return record;
  try { await writeFile(`${record.record_file}.opening`, '', { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { ...record, status: 'unknown', duplicate: true };
  }
  const launching = { ...record, status: 'unknown' };
  await save(record.record_file, launching);
  try { await run('/usr/bin/open', ['-a', 'Terminal', record.command_file], { timeout: 10000 }); }
  catch { throw new Error(`终端启动结果未知，请检查终端；目标会话 ID：${record.session_id}。不要自动重开`); }
  const opened = { ...record, status: 'opened' };
  await save(record.record_file, opened);
  return opened;
}

async function readStdin(maxBytes = 128 * 1024, timeoutMs = 15000) {
  if (process.stdin.isTTY) throw new Error('使用 --stdin 时必须通过管道或 heredoc 传入正文，当前标准输入是交互终端');
  const raw = await new Promise((resolve_, reject) => {
    const chunks = [];
    let total = 0, settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      fn(value);
    };
    const timer = setTimeout(() => { process.stdin.pause(); done(reject, new Error('读取标准输入超时，请确认已关闭输入流或改用 --content-file')); }, timeoutMs);
    const onData = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) { process.stdin.pause(); done(reject, new Error('标准输入正文超过大小上限')); return; }
      chunks.push(buf);
    };
    const onEnd = () => done(resolve_, Buffer.concat(chunks).toString('utf8'));
    const onError = () => done(reject, new Error('读取标准输入失败'));
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
  return raw.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = {}, args = process.argv.slice(2);
    const allowed = new Set(['request-id', 'cwd', 'content-file', 'content']);
    let prepareOnly = false, useStdin = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--prepare-only') { prepareOnly = true; continue; }
      if (args[i] === '--stdin') { if (useStdin) throw new Error('参数重复'); useStdin = true; continue; }
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed.has(key) || args[i + 1] === undefined || key in input)
        throw new Error('用法：node open.mjs --request-id <稳定 ID> --cwd <绝对目录> (--stdin | --content <正文> | --content-file <正文文件>) [--prepare-only]');
      input[key] = args[++i];
    }
    const contentSources = [input['content-file'] !== undefined, input.content !== undefined, useStdin].filter(Boolean).length;
    if (contentSources !== 1) throw new Error('必须且仅能提供一种正文来源：--stdin、--content 或 --content-file');
    const content = input['content-file'] !== undefined
      ? (await readFile(input['content-file'], 'utf8')).replace(/\r\n/g, '\n')
      : useStdin ? await readStdin() : input.content;
    const record = await prepareLaunch({ request_id: input['request-id'], cwd: input.cwd, content });
    const result = prepareOnly ? record : await openLaunch(record);
    console.log(JSON.stringify({ status: result.status, session_id: result.session_id, cwd: result.cwd, command_file: result.command_file, duplicate: result.duplicate,
      note: 'opened 仅表示终端已请求打开，不代表任务已处理；请在可见终端检查信任、channel 提示和权限交互。后续按此 session_id 发送，不重复投递首条任务。' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
