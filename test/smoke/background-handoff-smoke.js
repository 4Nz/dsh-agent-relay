// T7.6：显式运行才创建两端专用后台会话并产生模型费用。
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv.includes('--create-test-sessions')) throw new Error('需显式传入 --create-test-sessions；会创建收费的专用测试会话');
const root = await mkdtemp(join(tmpdir(), 'relay-background-smoke-'));
const env = { ...process.env, DSH_HOME: root,
  DSH_AGENT_RELAY_CONFIG: process.env.DSH_AGENT_RELAY_CONFIG || join(homedir(), '.dsh', 'agent-relay', 'notification-client.json') };
console.log(JSON.stringify({ record_directory: root }));
for (const agent of ['codex', 'claude']) {
  const module = await import(`../../skills/${agent}-notify/start.mjs`);
  const cwd = join(root, agent); await mkdir(cwd);
  const request_id = randomUUID(), marker = `BACKGROUND_${agent.toUpperCase()}_${request_id}`;
  const input = { cwd, request_id, content: `这是用户授权的接力能力专用测试，只回复 ${marker}，不调用工具、不读写文件、不发送消息。` };
  const job = await module.prepareJob(input, { env });
  await module.launchJob(job, { env });
  let result;
  const until = Date.now() + 180000;
  do {
    await delay(2000);
    result = await module.inspectJob(request_id, { env });
    if (['completed', 'failed', 'needs_attention'].includes(result.status)) break;
  } while (Date.now() < until);
  await writeFile(join(root, `${agent}-result.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
  assert.equal(result.status, 'completed');
  assert.equal(result.result?.trim(), marker);
  assert.ok(result.session_id);
  const again = await module.prepareJob(input, { env });
  assert.equal(again.duplicate, true);
  assert.equal(again.session_id, result.session_id);
}
console.log('后台新建、只读结果查询、原请求防重真实验证通过');
