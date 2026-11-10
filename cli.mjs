#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, PLATFORMS } from './src/cli-args.mjs';
import { createServices, prepareShare } from './src/cli-runtime.mjs';
import { createProgressRenderer, fileInfo } from './lib/download-progress.mjs';

export { parseArgs };
export const HELP = "ODE-cloud — 独立网盘命令行（唯一入口，无 UI）\n  node cli.mjs --help\n  node cli.mjs login <xunlei|quark|pan123|tianyi|yidong|baidu|115> [--browser [浏览器路径]]\n  node cli.mjs login xunlei --sms <11位手机号>\n  node cli.mjs logout <平台>\n  node cli.mjs status <平台> --verify\n  node cli.mjs status all\n  node cli.mjs whoami <平台>\n  node cli.mjs share <官方分享链接或文案>\n  node cli.mjs get <官方分享链接或文案> --output <目录>\n       [--file \"目录/文件1,目录/文件2\"] [--engine http|sdk]\n       [--workers 1..32] [--chunk 分片MiB]\n  node cli.mjs direct <HTTP(S)文件直链> --output <目标文件>\n       [--engine http] [--workers 1..32] [--chunk 分片MiB]\n--output 必填；相对路径以当前运行目录为基准。不传 --file 下载全部文件。\n--engine 默认 http；仅迅雷支持 sdk，SDK 自行调度，不接受 --workers/--chunk。\n分享访问码仅从链接或原始分享文案读取。所有命令和参数无别名。\nshare 始终输出 JSON，name 包含全部目录层级。进度写 stderr，结果 JSON 写 stdout。\n账号平台必须明确；登录默认官网浏览器，仅迅雷另有短信登录。";

function sanitizeReason(message) {
  if (typeof message !== 'string') return '';
  let text = message.replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]');
  text = text.replace(/([?&](?:token|sign|signature|auth|authorization|key|pwd|password|secret|sekey|bdstoken|randsk)=)[^&\s"'<>]*/gi, '$1[已隐藏]');
  return text.trim();
}

function downloadResult(result, platform, engine, target) {
  const items = Array.isArray(result) ? result : result?.results || [];
  const results = items.map(item => ({
    ...fileInfo(item),
    path: item.path || path.join(target, ...item.name.split('/')),
    status: item.status || 'done',
    ...(item.status === 'failed' ? { error: sanitizeReason(item.error) || '下载失败，请检查账号权限、分享有效性、网络、目标目录或SDK兼容性' } : {}),
  }));
  return { platform, engine, output: target, count: results.length,
    totalBytes: results.every(item => item.sizeBytes !== null) ? results.reduce((total, item) => total + item.sizeBytes, 0) : null,
    results };
}

export async function run(argv, { services, output = console.log, onProgress } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help') { output(HELP); return; }
  const { command, platform, options, value, target } = parsed;
  const prepared = ['share', 'get'].includes(command) ? prepareShare(value, options) : null;
  const handlers = services || createServices();
  let result;
  if (command === 'login') result = await handlers.login(platform, options, output);
  else if (command === 'logout') result = await handlers.logout(platform);
  else if (command === 'status') {
    result = [];
    for (const selected of platform === 'all' ? PLATFORMS : [platform]) result.push(await handlers.status(selected, options));
  } else if (command === 'whoami') result = await handlers.whoami(platform);
  else if (command === 'share') result = await handlers.open(prepared, options);
  else if (command === 'get') {
    const reporter = onProgress || createProgressRenderer();
    try { result = await handlers.download(prepared, target, options, reporter); }
    finally { if (!onProgress) reporter.finish(); }
  } else if (command === 'direct') {
    const reporter = onProgress || createProgressRenderer();
    try { result = await handlers.direct(value, target, options, reporter); }
    finally { if (!onProgress) reporter.finish(); }
  }
  if (['get', 'direct'].includes(command)) result = downloadResult(result, prepared?.platform || 'direct', options.engine, target);
  output(JSON.stringify(result, null, 2));
  if (result?.results?.some(item => item.status === 'failed')) {
    const error = new Error('部分下载任务失败，详情见输出的结果 JSON');
    error.exitCode = 2;
    throw error;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).catch(error => {
    console.error('错误：' + error.message);
    if (process.env.ODE_CLOUD_DEBUG) console.error(error.stack);
    process.exitCode = error.exitCode || 1;
  });
}
