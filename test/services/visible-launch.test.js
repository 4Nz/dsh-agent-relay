import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('可见 Claude 启动不使用后台模式，持久请求防止重复开窗，正文不拼接进 shell', async t => {
  const { prepareLaunch, openLaunch } = await import('../../skills/claude-notify/open.mjs');
  const root = mkdtempSync(join(tmpdir(), 'relay-visible-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "中文 ' $(echo wrong)"); mkdirSync(work);
  const options = { home: root, env: {}, platform: 'darwin' };
  await assert.rejects(prepareLaunch({ request_id: 'missing', content: 'test' }, options), /绝对工作目录/);
  await assert.rejects(prepareLaunch({ request_id: 'missing', cwd: join(root, 'absent'), content: 'test' }, options), /ENOENT/);
  const input = { request_id: 'visible-1', cwd: work, content: '只回复 READY；$(touch unexpected)' };
  const created = await prepareLaunch(input, options);
  assert.equal(created.status, 'prepared');
  assert.match(created.session_id, /^[\da-f-]{36}$/);
  assert.equal(readFileSync(created.command_file, 'utf8').includes(input.content), false);
  let opens = 0;
  const opened = await openLaunch(created, { run: async (file, args) => { opens++; assert.equal(file, '/usr/bin/open'); assert.deepEqual(args, ['-a', 'Terminal', created.command_file]); } });
  assert.equal(opened.status, 'opened');
  const again = await prepareLaunch(input, options);
  assert.equal(again.session_id, created.session_id);
  assert.equal(again.duplicate, true);
  await openLaunch(again, { run: async () => { opens++; } });
  assert.equal(opens, 1);
  await assert.rejects(prepareLaunch({ ...input, content: '另一个任务' }, options), /request_id/);
  await assert.rejects(prepareLaunch({ ...input, request_id: 'windows' }, { ...options, platform: 'win32' }), /macOS/);
});

test('启动失败保留未知状态不自动重开；终端载荷传 argv 且清除嵌套标记', { skip: process.platform !== 'darwin' }, async t => {
  const { prepareLaunch, openLaunch } = await import('../../skills/claude-notify/open.mjs');
  const root = mkdtempSync(join(tmpdir(), 'relay-visible-run-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const captured = join(root, 'args.json');
  const fake = join(root, 'claude');
  writeFileSync(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),nested:process.env.CLAUDECODE??null}));\n`, { mode: 0o700 });
  const content = '只回复 READY\n引号 " 和 $(echo nope)';
  const created = await prepareLaunch({ request_id: 'run', cwd: root, content }, { home: root, env: {}, platform: 'darwin' });
  await promisify(execFile)('/bin/zsh', [created.command_file], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CLAUDECODE: '1' } });
  const received = JSON.parse(readFileSync(captured, 'utf8'));
  // channel 是可变长选项，必须以 -- 截断，避免吞掉正文（也支持以 - 开头的任务）。
  assert.deepEqual(received.args.slice(received.args.indexOf('--dangerously-load-development-channels') + 1, received.args.indexOf('--')), ['server:agent-relay']);
  assert.deepEqual(received.args.slice(received.args.indexOf('--') + 1), [content]);
  assert.equal(received.nested, null);
  assert.equal(received.cwd, realpathSync(root));
  const failing = await prepareLaunch({ request_id: 'fail', cwd: root, content }, { home: root, env: {}, platform: 'darwin' });
  await assert.rejects(openLaunch(failing, { run: async () => { throw Error('launch failed'); } }), /未知/);
  const retry = await prepareLaunch({ request_id: 'fail', cwd: root, content }, { home: root, env: {}, platform: 'darwin' });
  assert.equal(retry.status, 'unknown');
  await openLaunch(retry, { run: async () => { assert.fail('不得重开'); } });
});
