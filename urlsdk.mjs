import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createCipheriv, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createInterface } from 'node:readline/promises';

export const SDK_HASHES = Object.freeze({
  'download.node': '535faca140a47125fb26541e3c1bafb361b4398c5873b9c84c1e122eee096d21',
  'xl_thunder_sdk.dll': 'bf8507e2e40fafb573286baf9a5f7c47ec9b355a026802b62c43332f25d5b2e9',
});
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_COMPONENT = 16 * 1024 * 1024;
const defaultDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native', 'win32-x64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function sdkDirectory() {
  return path.resolve(process.env.ODE_CLOUD_SDK_DIR || defaultDirectory);
}

export function extractSdkArchive(bytes, hashes = SDK_HASHES) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_ARCHIVE) throw new Error('SDK ZIP 大小无效');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('不是受支持的 ZIP 压缩包');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count > 1000 || directoryOffset + directorySize !== end) throw new Error('不支持分卷、ZIP64 或异常 ZIP 目录');
  const result = new Map();
  let position = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const compressed = bytes.readUInt32LE(position + 20);
    const expanded = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const recordEnd = position + 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    const local = bytes.readUInt32LE(position + 42);
    if (recordEnd > end || flags & 1 || bytes.readUInt16LE(position + 34) || ((bytes.readUInt32LE(position + 38) >>> 16) & 0xf000) === 0xa000) throw new Error('拒绝加密、符号链接或异常 ZIP 条目');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    const name = nameBytes.toString('utf8').replaceAll('\\', '/');
    const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
    if (!name || name.startsWith('/') || parts.some(part => !part || part === '.' || part === '..' || (part.includes(':') || [...part].some(character => character.charCodeAt(0) < 32)))) throw new Error('ZIP 含不安全路径');
    const filename = parts.at(-1);
    if (!name.endsWith('/') && Object.hasOwn(hashes, filename)) {
      if (result.has(filename) || expanded > MAX_COMPONENT || ![0, 8].includes(method) || local + 30 > directoryOffset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('SDK 组件重复、过大或压缩方式不受支持');
      const localNameLength = bytes.readUInt16LE(local + 26);
      const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
      if (start + compressed > directoryOffset || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) throw new Error('SDK ZIP 本地条目不一致');
      let content;
      try { content = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: MAX_COMPONENT }); }
      catch { throw new Error('SDK 组件解压失败'); }
      if (content.length !== expanded || digest(content) !== hashes[filename]) throw new Error('SDK 组件 SHA-256 校验失败：' + filename);
      result.set(filename, content);
    }
    position = recordEnd;
  }
  if (position !== end || result.size !== Object.keys(hashes).length) throw new Error('ZIP 缺少完整 SDK 组件或目录损坏');
  return result;
}

function httpsUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('请输入有效的 HTTPS ZIP 下载地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('仅支持不含嵌入账号密码和片段的 HTTPS 下载地址');
  return url;
}

export async function fetchSdkArchive(raw, { fetchImpl = fetch } = {}) {
  const source = await resolveSdkSource(raw, { fetchImpl });
  let url = httpsUrl(source.url);
  const signal = AbortSignal.timeout(60000);
  try {
    for (let redirects = 0; redirects <= 7; redirects += 1) {
      if (source.feijipan && !['api.feijipan.com', 'kf-app.dinghaoinc.com'].includes(url.hostname)) throw new Error('host');
      const response = await fetchImpl(url, { redirect: 'manual', signal, headers: source.headers });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 7) throw new Error('redirect');
        url = httpsUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('response'); }
      return await boundedBody(response, MAX_ARCHIVE);
    }
  } catch {
    throw new Error('SDK 下载失败：请检查 HTTPS 地址、分享权限、网络或 ZIP 大小（最大 32 MiB）；小飞机仅支持已验证的官方下载域名，地址不会记录到日志');
  }
  throw new Error('SDK 重定向次数超限');
}

export async function sdkStatus(directory = sdkDirectory(), hashes = SDK_HASHES) {
  for (const [name, expected] of Object.entries(hashes)) {
    const file = path.join(directory, name);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_COMPONENT || digest(await fs.readFile(file)) !== expected) return false;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

export async function installSdkFromUrl(raw, { directory = sdkDirectory(), fetchImpl = fetch, hashes = SDK_HASHES } = {}) {
  const files = extractSdkArchive(await fetchSdkArchive(raw, { fetchImpl }), hashes);
  const target = path.resolve(directory);
  await fs.mkdir(target, { recursive: true });
  if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('拒绝安装到符号链接目录');
  const temporary = await fs.mkdtemp(path.join(target, '.sdk-install-'));
  const created = [];
  try {
    for (const [name, content] of files) await fs.writeFile(path.join(temporary, name), content, { flag: 'wx', mode: 0o600 });
    for (const name of files.keys()) {
      await fs.link(path.join(temporary, name), path.join(target, name));
      created.push(name);
    }
    return { directory: target, files: [...files.keys()] };
  } catch (error) {
    for (const name of created) {
      const original = await fs.stat(path.join(temporary, name));
      const current = await fs.lstat(path.join(target, name)).catch(() => null);
      if (current?.ino === original.ino && current?.dev === original.dev) await fs.unlink(path.join(target, name));
    }
    if (error.code === 'EEXIST') throw new Error('SDK 目录已有同名文件，未覆盖；请先自行备份并移走旧组件');
    throw new Error('SDK 安装失败，请检查目标目录权限；未执行任何组件');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function runSdkInstaller(args, { question, output = console.log, directory = sdkDirectory(), fetchImpl = fetch } = {}) {
  if (args.join(' ') !== 'status xunlei --sdk' || args.length !== 3) throw new Error('用法：node urlsdk.mjs status xunlei --sdk');
  if (await sdkStatus(directory)) { output('SDK 组件已存在且摘要校验通过：' + directory + '（尚未加载，仍需匹配 Node ABI）'); return; }
  let terminal;
  try {
    if (!question) { terminal = createInterface({ input: process.stdin, output: process.stdout }); question = prompt => terminal.question(prompt); }
    const url = (await question('请输入小飞机无密码单文件分享 URL 或 SDK ZIP 的 HTTPS 下载 URL：')).trim();
    await installSdkFromUrl(url, { directory, fetchImpl });
    output('SDK 已校验并添加到：' + directory + '；不使用加载组件的HTTP使用不受影响。');
  } finally { terminal?.close(); }
}

const FEIJIPAN_HEADERS = Object.freeze({
  Origin: 'https://share.feijipan.com',
  Referer: 'https://share.feijipan.com/',
  'User-Agent': 'Mozilla/5.0',
});

async function boundedBody(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new Error('response size');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new Error('response size');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

function feijipanEncrypt(value) {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('dingHao-disk-app'), null);
  return Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

export async function resolveSdkSource(raw, { fetchImpl = fetch } = {}) {
  const original = httpsUrl(raw);
  if (/(?:^|\.)lanzou[a-z]?\.com$/i.test(original.hostname)) throw new Error('已改用小飞机：请提供无密码单文件分享或 HTTPS ZIP 直链，不再解析蓝奏云');
  if (original.hostname !== 'share.feijipan.com') return { url: original.href, headers: {} };
  const shareId = original.pathname.match(/^\/s\/([A-Za-z0-9]{1,128})\/?$/)?.[1];
  if (!shareId || original.search || original.port) throw new Error('小飞机分享地址格式无效，请使用 https://share.feijipan.com/s/分享码');
  const uuid = randomUUID();
  const listing = new URL('https://api.feijipan.com/ws/recommend/list');
  listing.search = new URLSearchParams({ devType: '6', devModel: 'Chrome', uuid, extra: '2', timestamp: feijipanEncrypt(Date.now()), shareId, type: '0', offset: '1', limit: '60', code: '' });
  let data;
  try {
    const response = await fetchImpl(listing, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { ...FEIJIPAN_HEADERS } });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('response'); }
    data = JSON.parse((await boundedBody(response, 1024 * 1024)).toString('utf8'));
  } catch {
    throw new Error('小飞机分享读取失败，请检查网络或分享权限；地址不会记录到日志');
  }
  if (data?.code !== 200 || data.status !== 0) throw new Error('小飞机分享不可用或需要提取码、登录、验证码；仅支持无密码公开单文件分享');
  if (!Array.isArray(data.list) || data.list.length !== 1 || !Array.isArray(data.list[0]?.fileList)) throw new Error('小飞机分享文件列表格式已变化');
  const files = data.list[0].fileList;
  if (files.length !== 1 || files[0]?.fileType !== 1 || typeof files[0].fileName !== 'string' || !/\.zip$/i.test(files[0].fileName)) throw new Error('小飞机分享必须只有一个 ZIP 文件，不支持目录或多个文件');
  const fileId = files[0].fileId;
  if (!(typeof fileId === 'string' && /^\d{1,20}$/.test(fileId)) && !(typeof fileId === 'number' && Number.isSafeInteger(fileId) && fileId > 0)) throw new Error('小飞机文件标识无效');
  const now = Date.now();
  const download = new URL('https://api.feijipan.com/ws/file/redirect');
  download.search = new URLSearchParams({ downloadId: feijipanEncrypt(fileId + '|'), enable: '1', devType: '6', uuid, timestamp: feijipanEncrypt(now), auth: feijipanEncrypt(fileId + '|' + now), shareId });
  return { url: download.href, headers: { ...FEIJIPAN_HEADERS }, feijipan: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runSdkInstaller(process.argv.slice(2)); }
  catch (error) { console.error('错误：' + error.message); process.exitCode = 1; }
}
