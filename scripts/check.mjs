#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PORTABLE_FILES, SOURCE_ROOT } from './build-portable.mjs';

const manifest = new Set(PORTABLE_FILES);
if (manifest.size !== PORTABLE_FILES.length) throw new Error('分发白名单存在重复文件');
let modules = 0;
let imports = 0;
for (const relative of PORTABLE_FILES) {
  const absolute = path.join(SOURCE_ROOT, relative);
  for (const segment of relative.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))) {
    if ((await fs.lstat(path.join(SOURCE_ROOT, segment))).isSymbolicLink()) throw new Error('白名单禁止符号链接：' + relative);
  }
  if (!(await fs.stat(absolute)).isFile()) throw new Error('白名单不是普通文件：' + relative);
  if (/\.(node|dll|exe|zip)$/i.test(relative) || relative.startsWith('native/')) throw new Error('白名单禁止二进制：' + relative);
  if (!relative.endsWith('.mjs')) continue;
  const checked = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8', timeout: 30_000 });
  if (checked.error || checked.status !== 0) throw new Error('语法检查失败：' + relative + '\n' + (checked.error?.message || checked.stderr));
  modules++;
  const source = await fs.readFile(absolute, 'utf8');
  const specifiers = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g);
  for (const match of specifiers) {
    const specifier = match[1];
    if (specifier.startsWith('node:')) continue;
    if (!specifier.startsWith('.')) throw new Error('仅接受 Node 内置或项目内字面量导入：' + relative + ' → ' + specifier);
    const resolved = path.relative(SOURCE_ROOT, path.resolve(path.dirname(absolute), specifier)).split(path.sep).join('/');
    if (!manifest.has(resolved)) throw new Error('导入超出分发白名单：' + relative + ' → ' + specifier);
    imports++;
  }
}
console.log(JSON.stringify({ files: PORTABLE_FILES.length, modules, localImports: imports, syntax: 'passed', portableBoundaries: 'passed' }, null, 2));
