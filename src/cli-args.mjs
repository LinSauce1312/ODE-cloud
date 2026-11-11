import path from 'node:path';
import { safeSharePath } from '../lib/game-share.mjs';

export const PLATFORMS = Object.freeze(['xunlei', 'quark', 'pan123', 'tianyi', 'yidong', 'baidu', '115']);
const schemas = {
  login: ['browser', 'sms'],
  logout: [], status: ['verify'], whoami: [],
  share: [],
  link: ['file', 'format'],
  get: ['output', 'file', 'workers', 'chunk', 'engine'],
  direct: ['output', 'workers', 'chunk', 'engine'],
};

function positive(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(name + ' 必须是 1..' + max + ' 的整数');
  return Number(value);
}

export function parseArgs(argv) {
  if (!argv.length || argv.length === 1 && argv[0] === '--help') return { command: 'help' };
  const command = argv[0];
  if (!Object.hasOwn(schemas, command)) throw new Error('未知命令：' + command);
  if (argv.length === 2 && argv[1] === '--help') return { command: 'help' };
  const options = {};
  const positional = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    const key = argument.startsWith('--') ? argument.slice(2) : '';
    if (!schemas[command].includes(key)) throw new Error('未知参数：' + argument);
    if (Object.hasOwn(options, key)) throw new Error('重复参数：' + argument);
    if (key === 'verify') { options.verify = true; continue; }
    if (key === 'browser') {
      const browserPath = argv[index + 1];
      options.browser = browserPath !== undefined && !browserPath.startsWith('-') ? argv[++index] : true;
      if (typeof options.browser === 'string' && !options.browser.trim()) throw new Error('--browser 路径不能为空');
      continue;
    }
    const value = argv[++index];
    if (!value || !value.trim() || value.startsWith('-')) throw new Error(argument + ' 缺少参数');
    if (key === 'file') {
      const names = value.split(/[,，]/).map(name => name.trim());
      if (names.some(name => !name)) throw new Error('--file 不允许空文件路径');
      options.file = [...new Set(names.map(name => safeSharePath(name)))];
    } else options[key] = value;
  }
  if (positional.some(value => !value.trim())) throw new Error('参数不能为空');
  if (['login', 'logout', 'status', 'whoami'].includes(command)) {
    if (positional.length !== 1) throw new Error(command + ' 必须且只能指定一个平台');
    const platform = positional[0];
    if (!PLATFORMS.includes(platform) && !(command === 'status' && platform === 'all')) throw new Error('不支持的平台：' + platform);
    if (command === 'login' && options.sms !== undefined) {
      if (platform !== 'xunlei') throw new Error('--sms 仅支持 xunlei');
      if (Object.hasOwn(options, 'browser')) throw new Error('--sms 不能与 --browser 混用');
      if (!/^1\d{10}$/.test(options.sms)) throw new Error('--sms 需要 11 位中国大陆手机号');
    }
    if (command === 'status') {
      if (platform === 'all' && options.verify) throw new Error('status all 已默认在线校验，不接受额外 --verify');
      if (platform !== 'all' && !options.verify) throw new Error('status <平台> 必须指定 --verify');
      options.verify = true;
    }
    return { command, platform, options };
  }
  if (positional.length !== 1) throw new Error(command + ' 必须且只能指定一个链接；下载目录请使用 --output');
  if (command === 'share') return { command, value: positional[0], options };
  if (command === 'link') {
    options.format ||= 'json';
    if (!['json', 'curl', 'aria2'].includes(options.format)) throw new Error('--format 必须是 json、curl 或 aria2');
    return { command, value: positional[0], options };
  }
  if (!options.output) throw new Error('缺少 --output 下载路径（可使用相对于当前运行目录的路径）');
  const target = path.resolve(options.output);
  options.engine ||= 'http';
  if (!['http', 'sdk'].includes(options.engine)) throw new Error('--engine 必须是 http 或 sdk');
  if (options.engine === 'sdk' && (options.workers !== undefined || options.chunk !== undefined)) throw new Error('SDK 自行调度下载，不接受 --workers 或 --chunk');
  options.workers = options.workers === undefined ? 8 : positive(options.workers, '--workers', 32);
  options.chunkSize = options.chunk === undefined ? undefined : positive(options.chunk, '--chunk', Math.floor(Number.MAX_SAFE_INTEGER / 1048576)) * 1048576;
  if (command === 'direct') {
    const url = new URL(positional[0]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只接受无嵌入凭据的 HTTP(S) 文件直链');
    if (options.engine !== 'http') throw new Error('direct 仅支持 HTTP 引擎');
    if (/[\\/]$/.test(options.output) || ['.', '..'].includes(path.basename(options.output))) throw new Error('直链目标必须包含文件名');
  }
  return { command, value: positional[0], target, options };
}
