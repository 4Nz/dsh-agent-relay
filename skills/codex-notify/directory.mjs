// 只查目录元数据；不读取项目正文，不自动创建目录。
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ignored = new Set(['.git', '.svn', '.hg', 'node_modules', '.npm', '.cache', 'Library', '.Trash', 'Caches', 'vendor', 'target', 'dist']);
export async function resolveDirectory(query, { home = homedir(), roots = [home], indexedPaths, platform = process.platform, maxEntries = 100000, timeoutMs = 20000 } = {}) {
  if (typeof query !== 'string' || !query.trim()) return { status: 'needs_input', candidates: [], reason: '请提供新会话工作目录或项目名，确定目录后才能创建会话' };
  query = query.trim();
  async function directory(path) {
    try { const real = await realpath(path); return (await stat(real)).isDirectory() ? real : null; }
    catch { return null; }
  }
  if (isAbsolute(query) || query.startsWith('~') || query.includes('/') || query.includes('\\')) {
    const path = query === '~' ? home : query.startsWith('~/') || query.startsWith('~\\') ? join(home, query.slice(2)) : resolve(query);
    const found = await directory(path);
    return found ? { status: 'resolved', path: found, candidates: [found], source: 'explicit_path' }
      : { status: 'not_found', candidates: [], reason: '目录不存在或不可访问；请提供其他绝对目录，不创建空目录代替' };
  }
  const candidates = new Set();
  let indexIncomplete = false;
  if (indexedPaths === undefined && platform === 'darwin') {
    try {
      const escaped = query.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const { stdout } = await promisify(execFile)('/usr/bin/mdfind', ['-0', 'kMDItemFSName == "' + escaped + '" && kMDItemContentType == "public.folder"'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      indexedPaths = stdout.split('\0').filter(Boolean);
    } catch { indexedPaths = []; indexIncomplete = true; }
  }
  for (const path of indexedPaths ?? []) {
    if (basename(path) !== query) continue;
    const found = await directory(path);
    if (found) candidates.add(found);
  }
  // Spotlight 覆盖整机已索引目录；递归补查用户目录，显式 --root 可补查其他磁盘。
  const pending = [...roots], visited = new Set();
  let count = 0, incomplete = indexIncomplete;
  const deadline = Date.now() + timeoutMs;
  while (pending.length) {
    if (count >= maxEntries || Date.now() >= deadline) { incomplete = true; break; }
    const path = pending.pop();
    let real;
    try { real = await realpath(path); } catch { incomplete = true; continue; }
    if (visited.has(real)) continue;
    visited.add(real); count++;
    if (basename(path) === query) candidates.add(real);
    let entries;
    try { entries = await readdir(real, { withFileTypes: true }); }
    catch { incomplete = true; continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      // 默认不深入隐藏工具缓存；用户明确指定路径/根目录时仍可访问。
      if (entry.name.startsWith('.') && entry.name !== query) continue;
      pending.push(join(real, entry.name));
    }
  }
  const list = [...candidates].sort();
  const status = incomplete ? 'incomplete' : list.length === 1 ? 'resolved' : list.length ? 'ambiguous' : 'not_found';
  return { status, ...(status === 'resolved' ? { path: list[0] } : {}), candidates: list, searched_roots: roots,
    reason: status === 'resolved' ? '已定位唯一候选目录' : status === 'ambiguous' ? '有多个同名目录，请让用户选择完整路径' : status === 'incomplete' ? '部分目录不可访问或搜索达到上限；请让用户确认候选路径或提供更精确路径，不自动选中' : '未找到对应目录，请询问用户；目录未确定前不创建会话' };
}
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let query; const roots = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--directory' && query === undefined && args[i + 1] !== undefined) query = args[++i];
      else if (args[i] === '--root' && args[i + 1] !== undefined && isAbsolute(args[i + 1])) roots.push(args[++i]);
      else throw new Error('用法：node directory.mjs --directory <绝对目录或项目名> [--root <补查绝对目录>]');
    }
    console.log(JSON.stringify(await resolveDirectory(query, roots.length ? { roots: [homedir(), ...roots] } : {})));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
