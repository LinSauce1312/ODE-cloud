import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const SHARE_BASE = 'https://share-kd-njs.yun.139.com';
const LIST_URL = `${SHARE_BASE}/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6`;
const LINK_URL = `${SHARE_BASE}/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3`;
const KEY = Buffer.from('PVGDwmcvfs1uV3d1');
const PAGE_SIZE = 200;
const MAX_ENTRIES = 1000;
const SHARE_HEADERS = {
  'hcy-cool-flag': '1',
  'x-deviceinfo': '||3|12.27.0|||||chrome 150.0.0.0|360X444|zh-cn|||',
  'x-huawei-channelsrc': '10245500',
  'x-mm-source': '0002',
  'Content-Type': 'application/json;charset=UTF-8',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  Origin: 'https://yun.139.com',
  Referer: 'https://yun.139.com/',
  Accept: 'application/json, text/plain, */*',
};

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

function sign(body) {
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
  const timestamp = `${date} ${time}`;
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const nonce = [...randomBytes(16)].map((byte) => alphabet[byte % alphabet.length]).join('');
  const encoded = encodeURIComponent(body).split('').sort().join('');
  const combined = md5(Buffer.from(encoded).toString('base64')) + md5(`${timestamp}:${nonce}`);
  return `${timestamp},${nonce},${md5(combined).toUpperCase()}`;
}

function encrypt(body) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', KEY, iv);
  return Buffer.concat([iv, cipher.update(body, 'utf8'), cipher.final()]).toString('base64');
}

function decrypt(text) {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < 32 || (bytes.length - 16) % 16) throw new Error('移动云盘响应不是有效 AES 数据');
  const decipher = createDecipheriv('aes-128-cbc', KEY, bytes.subarray(0, 16));
  const decoded = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]);
  return (decoded[0] === 0x1f && decoded[1] === 0x8b ? gunzipSync(decoded) : decoded).toString('utf8');
}

function parseReply(text) {
  const payload = text.trim();
  if (payload.startsWith('{')) return JSON.parse(payload);
  return JSON.parse(decrypt(payload));
}

function checkReply(reply, operation) {
  if (reply.resultCode != null && String(reply.resultCode) !== '0' || reply.success === false) {
    throw new Error(`${operation}失败：${reply.desc || reply.message || reply.resultCode || '未知错误'}`);
  }
  if (!reply.data || typeof reply.data !== 'object') throw new Error(`${operation}失败：响应缺少 data`);
  return reply.data;
}

export function parseYidongShareUrl(raw) {
  const match = String(raw).match(/https:\/\/[^\s<>"'，。]+/i);
  if (!match) throw new Error('需要移动云盘官方 HTTPS 分享链接');
  let url;
  try { url = new URL(match[0]); } catch { throw new Error('移动云盘分享链接格式错误'); }
  if (url.protocol !== 'https:' || url.hostname !== 'yun.139.com' || url.username || url.password || url.port) {
    throw new Error('仅接受 yun.139.com 官方分享链接');
  }
  const routes = [url.hash.replace(/^#/, '').split('?')[0], url.pathname];
  const id = routes.map((route) => route.match(/^\/(?:w|m)\/i\/([A-Za-z0-9_-]+)\/?$/i)?.[1]).find(Boolean);
  if (!id || !/^\/(?:shareweb|(?:w|m)\/i\/[A-Za-z0-9_-]+)\/?$/i.test(url.pathname)
    && !/^\/shareweb\/(?:w|m)\/i\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)) {
    throw new Error('移动云盘分享路径应为 /shareweb/#/w/i/<id> 或 /m/i/<id>');
  }
  const hashQuery = url.hash.split('?')[1] || '';
  const query = new URLSearchParams(hashQuery);
  const passwd = url.searchParams.get('pwd') || query.get('pwd') || String(raw).match(/(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})/)?.[1] || '';
  if (passwd && !/^[A-Za-z0-9]{1,16}$/.test(passwd)) throw new Error('移动云盘提取码格式错误');
  const folderPath = query.get('path');
  if (folderPath && (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(folderPath) || folderPath.length > 1024)) throw new Error('移动云盘分享目录 ID 格式错误');
  return { linkId: id, passwd, ...(folderPath ? { folderPath } : {}) };
}

export function accountFromAuthorization(authorization) {
  if (typeof authorization !== 'string' || !authorization.trim()) {
    throw new Error('移动云盘登录凭据为空；请重新执行 login yidong');
  }
  const trimmed = authorization.trim();
  // 与 ODE 原版对齐：authorization 可能是 Basic 包装（pc:account:token），也可能是浏览器捕获的原始头。
  if (/^Basic\s+[A-Za-z0-9+/]+={0,2}$/i.test(trimmed)) {
    const encoded = trimmed.split(/\s+/)[1];
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length >= 2 && parts[0] === 'pc' && parts[1]) return parts[1];
  }
  // 原版取链 E() 默认 account = ''，commonAccountInfo.account 也传空串；此处保持一致。
  return '';
}

function safeSegment(name) {
  const value = String(name || '');
  if (!value || value === '.' || value === '..' || /[\\/<>:"|?*\u0000-\u001f]/.test(value)) {
    throw new Error('移动云盘分享包含不安全的文件名');
  }
  return value;
}

export class YidongShareClient {
  constructor(credential, { fetchImpl = fetch } = {}) {
    this.authorization = credential?.authorization;
    this.account = accountFromAuthorization(this.authorization);
    this.fetchImpl = fetchImpl;
  }

  async request(url, body, authenticated = false) {
    const plain = JSON.stringify(body);
    const headers = { ...SHARE_HEADERS };
    if (authenticated) {
      headers.Authorization = this.authorization;
      headers['mcloud-sign'] = sign(plain);
    }
    const response = await this.fetchImpl(url, { method: 'POST', headers, body: encrypt(plain) });
    if (!response.ok) throw new Error(`移动云盘分享接口 HTTP ${response.status}`);
    return parseReply(await response.text());
  }

  async listPage(share, folderId = 'root', begin = 1) {
    const payload = { getOutLinkInfoReq: {
      account: '', linkID: share.linkId, passwd: share.passwd,
      caSrt: 1, coSrt: 1, srtDr: 0, bNum: begin, pCaID: folderId, eNum: begin + PAGE_SIZE - 1,
    } };
    const data = checkReply(await this.request(LIST_URL, payload), '分享列目录');
    const directories = (data.caLst || []).map((item) => ({ id: String(item.caID || ''), label: item.caName, isDirectory: true }));
    const files = (data.coLst || []).map((item) => ({
      id: String(item.coID || ''), label: item.coName,
      isDirectory: item.isdir === true || Number(item.coType) === 2,
      size: Number(item.coSize || 0),
    }));
    if (!Array.isArray(data.caLst || []) || !Array.isArray(data.coLst || [])) throw new Error('移动云盘目录结构无效');
    return [...directories, ...files];
  }

  async listShare(share) {
    const files = [];
    const tree = [];
    const visited = new Set();
    let entries = 0;
    const walk = async (folderId, parent, children) => {
      if (visited.has(folderId)) throw new Error('移动云盘分享目录存在循环引用');
      visited.add(folderId);
      for (let begin = 1; begin <= MAX_ENTRIES + 1; begin += PAGE_SIZE) {
        const batch = await this.listPage(share, folderId, begin);
        for (const entry of batch) {
          if (++entries > MAX_ENTRIES) throw new Error(`移动云盘分享超过 ${MAX_ENTRIES} 条目录/文件上限`);
          if (!entry.id) throw new Error('移动云盘分享缺少文件 ID');
          const label = safeSegment(entry.label);
          const name = `${parent}${label}`;
          if (entry.isDirectory) {
            const folder = { name: label, path: name, type: 'directory', children: [] };
            children.push(folder);
            await walk(entry.id, `${name}/`, folder.children);
          } else {
            if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('移动云盘分享文件大小无效');
            files.push({ fid: entry.id, name, size: entry.size });
            children.push({ name: label, path: name, type: 'file', size: entry.size });
          }
        }
        if (batch.length < PAGE_SIZE) break;
      }
    };
    await walk(share.folderPath || 'root', '', tree);
    return { files, tree };
  }

  async getShareDownloadLink(share, file) {
    if (!share?.linkId || !file?.fid) throw new Error('缺少移动云盘分享 ID 或文件 ID');
    const payload = { dlFromOutLinkReqV3: {
      account: this.account, linkID: share.linkId, coIDLst: { item: [file.fid] },
      commonAccountInfo: { account: this.account, accountType: 1 },
    } };
    const data = checkReply(await this.request(LINK_URL, payload, true), '获取分享直链');
    if (!data.redrUrl) throw new Error('移动云盘未返回下载直链');
    const download = new URL(data.redrUrl);
    if (download.protocol !== 'https:' || download.username || download.password) throw new Error('移动云盘返回了不安全的下载链接');
    const size = Number(data.coSize ?? data.size ?? file.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('移动云盘返回无效文件大小');
    return { url: download.href, headers: {}, size };
  }
}

export async function openYidongShare(raw, credential, { fetchImpl = fetch } = {}) {
  const share = parseYidongShareUrl(raw);
  const client = new YidongShareClient(credential, { fetchImpl });
  const { files, tree } = await client.listShare(share);
  return { files, tree, share, client };
}
