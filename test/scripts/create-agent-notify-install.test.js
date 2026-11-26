import test from 'node:test';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const script=fileURLToPath(new URL('../../skills/create-agent-notify/scripts/install.mjs',import.meta.url));
test('接入 Skill 安装支持预检、幂等、备份升级且保留人工改动',t=>{
 const root=mkdtempSync(join(tmpdir(),'安装 接力-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'demo-notify'),dest=join(root,'skills');mkdirSync(source);
 writeFileSync(join(source,'SKILL.md'),'---\nname: demo-notify\ndescription: 测试\n---\n# 测试');writeFileSync(join(source,'send.mjs'),'// v1');
 const run=(...extra)=>JSON.parse(execFileSync(process.execPath,[script,'--source',source,'--skills-root',dest,...extra],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 assert.equal(run('--check').action,'install');assert.equal(readdirSync(root).includes('skills'),false);
 assert.equal(run().action,'installed');assert.equal(run().action,'unchanged');
 writeFileSync(join(source,'send.mjs'),'// v2');const update=run();assert.equal(update.action,'updated');assert.equal(readFileSync(join(update.backup,'send.mjs'),'utf8'),'// v1');
 writeFileSync(join(dest,'demo-notify','send.mjs'),'// 用户修改');assert.throws(()=>run(),/人工修改|冲突/);assert.equal(readFileSync(join(dest,'demo-notify','send.mjs'),'utf8'),'// 用户修改');
});
test('安装拒绝源目录符号链接，避免带入外部凭据文件',t=>{
 const root=mkdtempSync(join(tmpdir(),'skill-link-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const source=join(root,'demo-notify');mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: demo-notify\ndescription: 测试\n---');symlinkSync('/tmp',join(source,'outside'));
 assert.throws(()=>execFileSync(process.execPath,[script,'--source',source,'--skills-root',join(root,'skills')],{stdio:['ignore','pipe','pipe']}),/符号链接/);
});

test('登记脚本生成待接入清单，明确升级才标记 ready 并保留备份',t=>{
 const root=mkdtempSync(join(tmpdir(),'notify-register-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'demo-notify');mkdirSync(source);mkdirSync(join(source,'references'));
 writeFileSync(join(source,'SKILL.md'),'---\nname: demo-notify\ndescription: 示例\n---');writeFileSync(join(source,'send.mjs'),'// sender');writeFileSync(join(source,'references','api.md'),'接口契约');
 const register=fileURLToPath(new URL('../../skills/create-agent-notify/scripts/register.mjs',import.meta.url));
 const run=(...extra)=>execFileSync(process.execPath,[register,'--source',source,'--target-agent','demo','--label','示例接力',...extra],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 run();const file=join(source,'agent-notify.json');let data=JSON.parse(readFileSync(file,'utf8'));
 assert.equal(data.status,'pending');assert.deepEqual(data.files,['SKILL.md','references/api.md','send.mjs']);
 assert.throws(()=>run('--ready'),/update/);run('--ready','--update');
 assert.equal(JSON.parse(readFileSync(file,'utf8')).status,'ready');assert.ok(readdirSync(source).some(name=>name.startsWith('agent-notify.json.backup-')));
});
