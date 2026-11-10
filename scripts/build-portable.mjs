#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORTABLE_FILES = Object.freeze([
  "cli.mjs",
  "package.json",
  "环境安装脚本.ps1",
  "README.md",
  "USAGE.md",
  "DEVELOPMENT.md",
  ".gitignore",
  ".editorconfig",
  "scripts/check.mjs",
  "scripts/build-portable.mjs",
  "src/cli-args.mjs",
  "src/cli-runtime.mjs",
  "src/cloud-login.mjs",
  "src/pan123-share.mjs",
  "src/baidu-share.mjs",
  "src/tianyi-share.mjs",
  "src/yidong-share.mjs",
  "lib/paths.mjs",
  "lib/config.mjs",
  "lib/auth.mjs",
  "lib/game-share.mjs",
  "lib/pan115.mjs",
  "lib/quark.mjs",
  "lib/browser-login.mjs",
  "lib/cloud-pipeline.mjs",
  "lib/download-progress.mjs",
  "urlsdk.mjs",
  "test/urlsdk.test.mjs",
  "lib/sdk-engine.mjs",
  "lib/pipeline.mjs",
  "lib/web-login.mjs",
  "lib/engine.mjs",
  "test/sdk-engine.test.mjs",
  "test/quark.test.mjs",
  "test/pan115.test.mjs",
  "test/cloud-pipeline.test.mjs",
  "test/browser-login.test.mjs",
  "test/game-share.test.mjs",
  "test/web-login.test.mjs",
  "test/engine-fault.test.mjs",
  "test/pan123-share.test.mjs",
  "test/tianyi-share.test.mjs",
  "test/yidong-share.test.mjs",
  "test/cloud-adapter.test.mjs",
  "test/standalone.test.mjs",
  "test/unified-cli.test.mjs",
  "test/account-commands.test.mjs",
  "test/baidu-share.test.mjs",
  "test/download-progress.test.mjs"
]);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function buildPortable(destination = path.join(path.dirname(SOURCE_ROOT), 'ODE-cloud-portable')) {
  const root = await fs.realpath(SOURCE_ROOT);
  const requested = path.resolve(destination);
  const parent = await fs.realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  if (inside(root, target)) throw new Error('拒绝输出到源项目内部或源项目本身');
  try {
    await fs.lstat(target);
    throw new Error('拒绝覆盖已有目标');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const relative of PORTABLE_FILES) {
    let current = root;
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw new Error('拒绝打包符号链接：' + relative);
    }
    const info = await fs.stat(current);
    if (!info.isFile() || !inside(root, await fs.realpath(current))) throw new Error('不是项目内普通文件：' + relative);
  }
  await fs.mkdir(target);
  for (const relative of PORTABLE_FILES) {
    const output = path.join(target, relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(path.join(root, relative), output, fs.constants.COPYFILE_EXCL);
  }
  return { directory: target, files: PORTABLE_FILES.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || process.argv[2]?.startsWith('--')) {
    console.error('用法：node scripts/build-portable.mjs [全新目标目录]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await buildPortable(process.argv[2]), null, 2)); }
    catch (error) { console.error('打包失败：' + error.message); process.exitCode = 1; }
  }
}
