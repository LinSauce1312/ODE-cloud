import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPortable, PORTABLE_FILES, SOURCE_ROOT } from '../scripts/build-portable.mjs';

test('all portable module references resolve inside the allowlist', async () => {
  const included = new Set(PORTABLE_FILES);
  assert.equal(included.size, PORTABLE_FILES.length);
  for (const relative of PORTABLE_FILES) {
    assert.doesNotMatch(relative, /(?:^|\/)(?:node_modules|native|\.env|credentials|adapter-credentials|cloud-credentials|tasks)(?:\/|\.|$)|\.(?:node|dll|exe|so|dylib)$/i);
    if (!relative.endsWith('.mjs')) continue;
    const source = await fs.readFile(path.join(SOURCE_ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /process\.env\.XLPAN_|\.\.\/\.\.\/(?:ode-adapter|xunlei-pipeline)/);
    const imports = source.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])(\.[^'"]+)\1/g);
    for (const match of imports) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[2]));
      assert.ok(included.has(target), relative + ' references missing portable module ' + target);
    }
  }
});

test('公开包不包含任何SDK二进制，独立安装器不需要本地组件才能打包', () => {
  assert.deepEqual(PORTABLE_FILES.filter(relative => relative.startsWith('native/')), []);
  assert.ok(PORTABLE_FILES.includes('urlsdk.mjs'));
  assert.ok(PORTABLE_FILES.includes('test/urlsdk.test.mjs'));
});

test('portable build refuses source interiors and existing targets, and can rebuild after moving', async () => {
  await assert.rejects(buildPortable(SOURCE_ROOT), /拒绝/);
  await assert.rejects(buildPortable(path.join(SOURCE_ROOT, 'forbidden-output')), /内部/);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-cloud-portable-test-'));
  try {
    await assert.rejects(buildPortable(temporary), /覆盖/);
    const first = path.join(temporary, 'first');
    const result = await buildPortable(first);
    assert.equal(result.files, PORTABLE_FILES.length);
    const copied = [];
    async function walk(directory, prefix = '') {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
        else copied.push(relative);
      }
    }
    await walk(first);
    assert.deepEqual(copied.sort(), [...PORTABLE_FILES].sort());
    await assert.rejects(buildPortable(first), /覆盖/);
    const movedBuilder = await import(pathToFileURL(path.join(first, 'scripts/build-portable.mjs')).href);
    const rebuilt = await movedBuilder.buildPortable(path.join(temporary, 'rebuilt'));
    assert.equal(rebuilt.files, PORTABLE_FILES.length);
    assert.equal(await fs.readFile(path.join(temporary, 'rebuilt', 'cli.mjs'), 'utf8'), await fs.readFile(path.join(SOURCE_ROOT, 'cli.mjs'), 'utf8'));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('SMS login advertises echo and unified browser terminals close in finally', async () => {
  const source = await fs.readFile(path.join(SOURCE_ROOT, 'src/cli-runtime.mjs'), 'utf8');
  assert.match(source, /此终端输入会回显/);
  assert.match(source, /finally\s*\{\s*terminal\.close\(\);\s*\}/);
  assert.match(source, /finally\s*\{\s*terminal\?\.close\(\);\s*\}/);
  const paths = await fs.readFile(path.join(SOURCE_ROOT, 'lib/paths.mjs'), 'utf8');
  assert.match(paths, /process\.env\.ODE_CLOUD_HOME/);
  assert.match(paths, /\.ode-cloud/);
});
