import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const agent of ['codex', 'claude']) {
  async function fixture(t, source) {
    const root = await mkdtemp(join(tmpdir(), 'relay-background-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, '项目 空格');
    const bin = join(root, 'bin');
    await mkdir(cwd); await mkdir(bin);
    await writeFile(join(bin, agent), `#!${process.execPath}\n${source}`, { mode: 0o700 });
    const env = { ...process.env, DSH_HOME: root, PATH: `${bin}:${process.env.PATH}` };
    const module = await import(`../../skills/${agent}-notify/start.mjs`);
    return { root, cwd, env, ...module };
  }

  test(`${agent} 后台启动按请求防重，查询不会启动任务，准确保存结果与会话 ID`, async t => {
    const f = await fixture(t, `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const input=readFileSync(0,'utf8');
appendFileSync('次数.txt','1');
writeFileSync('输入.json',JSON.stringify({input,args:process.argv.slice(2)}));
const id='11111111-1111-4111-8111-111111111111';
if('${agent}'==='codex') {
 console.log(JSON.stringify({type:'thread.started',thread_id:id}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'完整结果\\n第二行'}}));
 console.log(JSON.stringify({type:'turn.completed'}));
} else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:process.argv[process.argv.indexOf('--session-id')+1],result:'完整结果\\n第二行',permission_denials:[]}));
`);
    const input = { request_id: '一次任务', cwd: f.cwd, content: '任务含 `shell` 与 $(命令)，保持原文' };
    const prepared = await f.prepareJob(input, { env: f.env });
    const again = await f.prepareJob(input, { env: f.env });
    assert.equal(again.duplicate, true);
    assert.equal((await f.inspectJob('一次任务', { env: f.env })).status, 'prepared');
    await assert.rejects(readFile(join(f.cwd, '次数.txt')), /ENOENT/);
    await Promise.all([f.runJob(prepared.directory, { env: f.env }), f.runJob(prepared.directory, { env: f.env })]);
    const result = await f.inspectJob('一次任务', { env: f.env });
    assert.equal(result.status, 'completed');
    assert.match(result.session_id, /^[0-9a-f-]{36}$/);
    assert.equal(result.result, '完整结果\n第二行');
    assert.equal(await readFile(join(f.cwd, '次数.txt'), 'utf8'), '1');
    const actual = JSON.parse(await readFile(join(f.cwd, '输入.json'), 'utf8'));
    assert.ok(actual.input.includes(input.content));
    assert.equal(actual.args.some(a => a.includes('bypass') || a.includes('skip-permissions')), false);
    await assert.rejects(f.prepareJob({ ...input, content: '改变任务' }, { env: f.env }), /request_id/);
    await assert.rejects(f.prepareJob({ ...input, request_id: '缺目录', cwd: '/不存在目录' }, { env: f.env }));
  });

  test(`${agent} 没有结束事件不能仅凭退出码认定完成，残留启动记录不得重跑`, async t => {
    const f = await fixture(t, 'process.exit(0);');
    const job = await f.prepareJob({ request_id: '中断', cwd: f.cwd, content: '测试' }, { env: f.env });
    await f.runJob(job.directory, { env: f.env });
    assert.equal((await f.inspectJob('中断', { env: f.env })).status, 'unknown');
    const duplicate = await f.prepareJob({ request_id: '中断', cwd: f.cwd, content: '测试' }, { env: f.env });
    assert.equal(duplicate.duplicate, true);
  });

  test(`${agent} 回传必须明确目标，不指定时不附加回传任务`, async t => {
    const f = await fixture(t, 'process.exit(0);');
    const input = { request_id: '回传', cwd: f.cwd, content: '测试', reply_agent: 'claude' };
    await assert.rejects(f.prepareJob(input, { env: f.env }), /回传/);
    const job = await f.prepareJob({ ...input, reply_session_id: '22222222-2222-4222-8222-222222222222' }, { env: f.env });
    const request = JSON.parse(await readFile(join(job.directory, 'request.json'), 'utf8'));
    assert.ok(request.prompt.includes('22222222-2222-4222-8222-222222222222'));
    assert.ok(request.prompt.includes('回传:result'));
    const plain = await f.prepareJob({ request_id: '只发送', cwd: f.cwd, content: '测试' }, { env: f.env });
    const plainRequest = JSON.parse(await readFile(join(plain.directory, 'request.json'), 'utf8'));
    assert.equal(plainRequest.reply, null);
  });
}
