import {test} from 'node:test';
import assert from 'node:assert/strict';

test('Codex CLI：Windows 桌面 exe、npm cmd 和显式 JS 路径均不经 shell',async()=>{
 const {resolveCodexCommand}=await import('../../lib/adapters/codex/cli.js');
 const node='C:\\node\\node.exe';const args=['app-server','--listen','stdio://'];
 const bin='C:\\npm 中文目录';const js=bin+'\\node_modules\\@openai\\codex\\bin\\codex.js';
 const existsFile=p=>[bin+'\\codex.cmd',js].includes(p);
 assert.deepEqual(resolveCodexCommand({platform:'win32',nodePath:node,env:{Path:bin},existsFile}),{command:node,args:[js,...args]});
 assert.deepEqual(resolveCodexCommand({platform:'win32',nodePath:node,env:{DSH_CODEX_BIN:bin+'\\codex.cmd'},existsFile}),{command:node,args:[js,...args]});
 assert.deepEqual(resolveCodexCommand({platform:'win32',nodePath:node,cliPath:js,env:{},existsFile}),{command:node,args:[js,...args]});
 const exe='C:\\Codex\\codex.exe';
 assert.deepEqual(resolveCodexCommand({platform:'win32',nodePath:node,env:{PATH:'C:\\Codex'},existsFile:p=>p===exe}),{command:exe,args});
 assert.throws(()=>resolveCodexCommand({platform:'win32',cliPath:bin+'\\codex.cmd',env:{},existsFile:()=>false}),/Codex/);
 assert.deepEqual(resolveCodexCommand({platform:'darwin',env:{},existsFile:()=>false}),{command:'codex',args});
});
