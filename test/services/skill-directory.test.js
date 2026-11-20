import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const name of ['claude-notify', 'codex-notify']) {
  test(`${name} 目录必填，路径验证，项目名搜索去重与歧义不猜测`, async t => {
    const { resolveDirectory } = await import(`../../skills/${name}/directory.mjs`);
    const home = await mkdtemp(join(tmpdir(), 'relay-directory-'));
    t.after(() => rm(home, {recursive:true,force:true}));
    const options = { home, roots: [home], indexedPaths: [], platform: 'linux' };
    assert.equal((await resolveDirectory(undefined, options)).status, 'needs_input');
    await mkdir(join(home,'work','ai-rag'), {recursive:true});
    await writeFile(join(home,'file'), '不是目录');
    assert.equal((await resolveDirectory(join(home,'file'), options)).status, 'not_found');
    const exact = await resolveDirectory('~/work/ai-rag', options);
    assert.equal(exact.status, 'resolved');
    assert.equal(exact.path, await realpath(join(home,'work','ai-rag')));
    assert.equal((await resolveDirectory('ai-rag', options)).path, exact.path);
    await mkdir(join(home,'other','ai-rag'), {recursive:true});
    const ambiguous = await resolveDirectory('ai-rag', options);
    assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.candidates.length, 2);
    assert.equal((await resolveDirectory('missing', options)).status, 'not_found');
    assert.equal((await resolveDirectory('ai-rag', {...options,maxEntries:1})).status, 'incomplete');
    assert.equal((await resolveDirectory('ai', options)).status, 'not_found');
    const partial = await resolveDirectory('ai-rag', {...options,roots:[join(home,'missing')],indexedPaths:[exact.path]});
    assert.equal(partial.status, 'incomplete');
  });
}
