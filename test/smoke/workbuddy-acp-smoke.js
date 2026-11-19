// T5.3：向用户指定的专用 A 会话发送一次唯一标记；B 仅作只读对照。
// 仅当提供真实测试 ID 才运行，可能触发模型调用。不会 load/new/jobs，也不会重试。
// 运行：WORKBUDDY_TEST_A=<id> WORKBUDDY_TEST_B=<id> rtk proxy node test/smoke/workbuddy-acp-smoke.js
// 可用 WORKBUDDY_TEST_PORT 指定经过注册表 health 验证的端点，不修改原 token。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createWorkBuddyTokenProvider } from '../../lib/adapters/workbuddy/token.js';
import { createWorkBuddyAcp } from '../../lib/adapters/workbuddy/acp.js';

const a = process.env.WORKBUDDY_TEST_A, b = process.env.WORKBUDDY_TEST_B;
if (!a || !b || a === b || ![a,b].every(id => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(id)))
  throw new Error('需要不同的专用 WORKBUDDY_TEST_A 和 WORKBUDDY_TEST_B');
const provider = createWorkBuddyTokenProvider();
const override = process.env.WORKBUDDY_TEST_PORT;
const port = override === undefined ? null : Number(override);
if (port !== null && (!Number.isInteger(port) || port < 1025 || port > 65535)) throw new Error('测试端口无效');
const token = {
  ...provider,
  async read() {
    const value = await provider.read();
    if (port !== null) {
      const entries = await provider.interactiveSessions();
      const entry = entries.find(item => {
        try { const u = new URL(item.url ?? ''); return ['127.0.0.1','localhost'].includes(u.hostname) && Number(u.port) === port; }
        catch { return false; }
      });
      if (!entry) throw new Error('测试端口不在 interactive 注册表中');
      return { ...value, port, pid: entry.pid };
    }
    return value;
  },
  async requestRefresh() { /* 冒烟不写入用户凭据或 refresh 文件。 */ },
};
const report = { date: new Date().toISOString(), node: process.version, stages: [], prompt_attempts: 0 };
const marker = `WB_RELAY_TEST_${randomUUID()}`;
async function get(path) {
  const value = await token.read();
  const response = await fetch(`http://127.0.0.1:${value.port}${path}`, {
    headers: { Authorization: `Bearer ${value.password}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('预检查 HTTP 失败');
  const body = await response.json(); return body.data ?? body;
}
async function sources(item) {
  if (!item || typeof item.projectId !== 'string' || !item.projectId || /[\\/:\x00]/.test(item.projectId) || ['.','..'].includes(item.projectId))
    throw new Error('未找到测试项目元数据');
  const root = join(homedir(), '.workbuddy', 'projects', item.projectId);
  const files = (await readdir(root)).filter(name => name.endsWith('.jsonl'));
  // 只读取 A/B 所属测试项目，报告仅保留标记是否出现，不输出会话内容。
  return new Map(await Promise.all(files.map(async name => [join(root,name), await readFile(join(root,name),'utf8')])));
}
try {
  const health = await get('/api/v1/health');
  report.workbuddy_version = health.version ?? health.appVersion ?? null;
  const list = await get('/api/v1/sessions?cwd=*');
  const itemA = list.sessions?.find(item => item.id === a), itemB = list.sessions?.find(item => item.id === b);
  if (!itemA || !itemB) throw new Error('未在指定端点找到两个专用测试对话');
  const beforeA = await sources(itemA), beforeB = await sources(itemB);
  if ([...beforeA.values(),...beforeB.values()].some(text => text.includes(marker))) throw new Error('标记已存在');
  const live = await get('/api/v1/sessions/live');
  report.live_target = live.sessionId === a ? 'A' : live.sessionId === b ? 'B' : live.sessionId === null ? 'none' : 'other';
  report.protocol = await createWorkBuddyAcp({ token, timeoutMs: 30_000, diagnostic: event => {
    report.stages.push(event); if (event.stage === 'prompt_started') report.prompt_attempts++;
  } }).prompt(a, `这是 Agent Relay 专用投递测试。请仅回复标记 ${marker}，不要调用工具、读写文件或访问网络。`, { cwd: itemA.cwd });
  // 一次发送后只读轮询，不因未知重新发送。以短窗口捕获延迟落盘。
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
    const afterA = await sources(itemA), afterB = await sources(itemB);
    const match = (files, id) => ({
      conversation_file: [...files].some(([path,text]) => basename(path) === `${id}.jsonl` && text.includes(marker)),
      project_files: [...files.values()].filter(text => text.includes(marker)).length,
    });
    report.a_marker = match(afterA,a); report.b_marker = match(afterB,b);
    if (report.a_marker.project_files || report.b_marker.project_files) break;
  }
  report.mapping_confirmed = false;
  report.note = '协议结果与文件标记分开记录；尚无权威工作会话绑定解析器，不据此宣布稳定精确投递';
  // 此脚本尚不具备完整投递验收条件；诊断结束不能被 CI 当作验收通过。
  process.exitCode = 1;
} catch {
  report.error = report.prompt_attempts ? '发送后验证未完成，不得重发' : '预检查或准备失败，未发送';
  process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
