import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SHARE_GET = 'https://yun.123pan.cn/b/api/share/get';
const DOWNLOAD_INFO = 'https://www.123865.com/b/api/share/download/info';
const REFERER = 'https://yun.123pan.cn/';
const SIGN_TABLE = 'adefghlmyijnopkqrstubcvwsz';
const DART_UA = 'Dart/3.12 (dart:io)';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const MAX_PAGES = 49;
const MAX_DIRECTORIES = 500;
const MAX_FILES = 10000;
const MAX_JSON_BYTES = 8192;
import { DATA_DIR } from '../lib/paths.mjs';
const DEVICE_FILE = path.join(DATA_DIR, 'pan123-device-id');
const HEX32 = /^[0-9a-f]{32}$/;

async function deviceId() {
  try {
    const saved = (await fs.readFile(DEVICE_FILE, 'utf8')).trim();
    if (!HEX32.test(saved)) throw new Error('本地 123 设备标识损坏');
    return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(DEVICE_FILE), { recursive: true });
  const generated = randomUUID().replaceAll('-', '');
  try { await fs.writeFile(DEVICE_FILE, generated, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const saved = (await fs.readFile(DEVICE_FILE, 'utf8')).trim();
  if (!HEX32.test(saved)) throw new Error('本地 123 设备标识损坏');
  return saved;
}

function crc32Hex(input) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(input, 'utf8')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
}

export function makePan123Sign(path, timestamp = Math.floor(Date.now() / 1000), random = Math.floor(Math.random() * 10000000)) {
  if (typeof path !== 'string' || !path.startsWith('/b/api/') || !Number.isSafeInteger(timestamp) || !Number.isInteger(random) || random < 0 || random >= 10000000) {
    throw new Error('无效的 123 签名参数');
  }
  const minute = new Date((timestamp + 57600) * 1000).toISOString().slice(0, 16).replace(/\D/g, '');
  const authKey = crc32Hex([...minute].map((digit) => SIGN_TABLE[Number(digit)]).join(''));
  return { authKey, authValue: `${timestamp}-${random}-${crc32Hex(`${timestamp}|${random}|${path}|web|3|${authKey}`)}` };
}

function safeUrl(value, { firstParty = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('下载链接不是安全的 HTTPS 地址');
  if (firstParty && !['yun.123pan.cn', 'www.123865.com'].includes(url.hostname.toLowerCase())) throw new Error('123 API 请求地址不是官方域名');
  return url;
}

export function parsePan123Share(raw) {
  const match = String(raw).match(/https?:\/\/[^\s<>"'，。；）)\]}]+/i);
  if (!match) throw new Error('需要 123 网盘分享链接');
  const url = safeUrl(match[0]);
  const hostname = url.hostname.toLowerCase();
  let shareKey;
  if (['www.123pan.com', '123pan.com', 'www.123865.com', '123865.com', 'www.123pan.cn'].includes(hostname)) {
    shareKey = /^\/s\/([A-Za-z0-9]+-[A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
    if (!shareKey && hostname === 'www.123pan.cn' && url.pathname === '/api/srr') shareKey = url.searchParams.get('sk');
  } else if (/^[a-z0-9-]+\.share\.123pan\.cn$/i.test(hostname)) {
    shareKey = /^\/123pan\/([A-Za-z0-9]+-[A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!shareKey || !/^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(shareKey)) throw new Error('不支持的 123 分享地址');
  const password = url.searchParams.get('pwd') || url.searchParams.get('password')
    || /(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})/.exec(raw)?.[1] || '';
  if (password && !/^[A-Za-z0-9]{4,8}$/.test(password)) throw new Error('分享提取码格式无效');
  return { shareKey, password };
}

function filename(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\x00-\x1f]/.test(value)) throw new Error('分享包含无效文件名');
  return value;
}

function fileFromApi(item, parentPath) {
  const id = String(item.FileId ?? '');
  const size = Number(item.Size ?? 0);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(size) || size < 0) throw new Error('123 分享文件信息无效');
  const name = filename(item.FileName);
  const isDirectory = Number(item.Type) === 1;
  return { id, name: parentPath ? `${parentPath}/${name}` : name, size, isDirectory,
    s3KeyFlag: String(item.S3KeyFlag ?? ''), etag: String(item.Etag ?? '') };
}

async function jsonApi(fetchImpl, url, options, label) {
  safeUrl(url, { firstParty: true });
  const response = await fetchImpl(url, { ...options, redirect: 'manual' });
  if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）`);
  let data;
  try { data = await response.json(); } catch { throw new Error(`${label}返回无效 JSON`); }
  if (Number(data.code) !== 0) throw new Error(`${label}失败（code=${Number.isSafeInteger(Number(data.code)) ? Number(data.code) : 'unknown'}）`);
  return data.data;
}

function decodeDownloadUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('123 下载接口没有返回链接');
  const trimmed = raw.trim();
  let encoded;
  if (!trimmed.includes('://')) encoded = trimmed;
  else {
    const wrapper = safeUrl(trimmed);
    encoded = wrapper.pathname.includes('download-v2') ? wrapper.searchParams.get('params') : null;
    if (!encoded) return wrapper.href;
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) throw new Error('下载链接 Base64 无效');
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(normalized, 'base64').toString('utf8');
  return safeUrl(decoded).href;
}

async function readSmallJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (response.headers.get('content-length') && (!Number.isSafeInteger(length) || length > MAX_JSON_BYTES)) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json') && !response.headers.get('content-length')) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total <= MAX_JSON_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_JSON_BYTES) return null;
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data?.data?.redirect_url || null;
  } catch { return null; } finally { await reader.cancel().catch(() => {}); }
}

async function resolveRedirects(fetchImpl, initialUrl) {
  let url = safeUrl(initialUrl).href;
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetchImpl(url, { headers: { Referer: REFERER, 'User-Agent': DART_UA }, redirect: 'manual' });
    let next;
    if (response.status >= 300 && response.status < 400) next = response.headers.get('location');
    else if (response.ok) next = await readSmallJson(response);
    else throw new Error(`123 CDN 探测失败（HTTP ${response.status}）`);
    await response.body?.cancel().catch(() => {});
    if (!next) return url;
    url = safeUrl(new URL(next, url).href).href;
  }
  throw new Error('123 CDN 重定向次数过多');
}

export class Pan123Share {
  constructor(credential, { fetchImpl = fetch, loginUuid } = {}) {
    this.token = credential?.token;
    this.fetchImpl = fetchImpl;
    this.loginUuid = loginUuid;
  }

  async list(share, parentId = '0', parentPath = '') {
    const files = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(SHARE_GET);
      for (const [key, value] of Object.entries({ limit: '100', next: '0', orderBy: 'file_name', orderDirection: 'asc', shareKey: share.shareKey, ParentFileId: parentId, Page: String(page) })) url.searchParams.set(key, value);
      if (share.password) url.searchParams.set('SharePwd', share.password);
      const data = await jsonApi(this.fetchImpl, url.href, { headers: { 'User-Agent': DART_UA } }, '读取分享');
      if (data?.Expired) throw new Error('123 分享已失效');
      if (!Array.isArray(data?.InfoList)) throw new Error('123 分享列表格式无效');
      const batch = data.InfoList.map((item) => fileFromApi(item, parentPath));
      files.push(...batch);
      if (files.length > MAX_FILES) throw new Error('123 分享目录文件数超限');
      if (!batch.length || String(data.Next) === '-1') return files;
    }
    throw new Error('123 分享分页超出上限');
  }

  async getShareDownloadLink(share, file) {
    if (!this.token || typeof this.token !== 'string') throw new Error('请先登录 123 网盘');
    if (!file || file.isDirectory || !/^\d+$/.test(String(file.id)) || !file.s3KeyFlag || !file.etag) throw new Error('123 分享文件下载参数无效');
    const { authKey, authValue } = makePan123Sign('/b/api/share/download/info');
    const loginUuid = this.loginUuid || await deviceId();
    if (!HEX32.test(loginUuid)) throw new Error('无效的 123 设备标识');
    const data = await jsonApi(this.fetchImpl, DOWNLOAD_INFO, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, loginuuid: loginUuid, 'auth-key': authKey, 'auth-value': authValue,
        platform: 'android', 'app-version': '39', 'User-Agent': WEB_UA, 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ ShareKey: share.shareKey, FileID: file.id, S3KeyFlag: file.s3KeyFlag, Size: file.size, Etag: file.etag }),
    }, '获取分享直链');
    const url = await resolveRedirects(this.fetchImpl, decodeDownloadUrl(data?.DownloadURL));
    return { url, headers: { Referer: REFERER, 'User-Agent': DART_UA }, size: file.size };
  }
}

export async function openPan123Share(raw, credential, { fetchImpl = fetch, loginUuid } = {}) {
  const share = parsePan123Share(raw);
  const client = new Pan123Share(credential, { fetchImpl, loginUuid });
  const files = [];
  const directories = [{ id: '0', path: '' }];
  const visited = new Set();
  while (directories.length) {
    if (visited.size >= MAX_DIRECTORIES) throw new Error('123 分享目录数量超限');
    const directory = directories.shift();
    if (visited.has(directory.id)) continue;
    visited.add(directory.id);
    const entries = await client.list(share, directory.id, directory.path);
    for (const file of entries) {
      if (file.isDirectory) directories.push({ id: file.id, path: file.name });
      else files.push(file);
      if (files.length + directories.length > MAX_FILES) throw new Error('123 分享文件数量超限');
    }
  }
  return { files, share, client };
}

