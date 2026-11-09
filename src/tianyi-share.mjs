import { createHash } from 'node:crypto';

const SHARE_ORIGIN = 'https://cloud.189.cn';
const API_ORIGIN = 'https://api.cloud.189.cn';
const SSO_ORIGINS = [API_ORIGIN, SHARE_ORIGIN, 'https://open.e.189.cn', 'https://h5.cloud.189.cn'];
const PAGE_SIZE = 300;

export function parseTianyiShareUrl(raw) {
  const match = String(raw).match(/https:\/\/[^\s<>"'，。]+/i);
  if (!match) throw new Error('请输入天翼云盘官方分享链接');
  let url;
  try { url = new URL(match[0].replace(/[),，。；;]+$/, '')); } catch { throw new Error('无效的天翼云盘分享链接'); }
  if (url.origin !== SHARE_ORIGIN || (!/^\/t\/[^/]+\/?$/.test(url.pathname) && url.pathname !== '/web/share') || url.username || url.password || url.port) {
    throw new Error('只接受 cloud.189.cn/t/<分享码> 或 /web/share?code=<分享码> 的 HTTPS 链接');
  }
  const shareCode = url.pathname === '/web/share' ? url.searchParams.get('code') : decodeURIComponent(url.pathname.split('/')[2]);
  if (!/^[\w-]+$/.test(shareCode)) throw new Error('分享码格式不正确');
  const trailing = String(raw).slice((match.index || 0) + match[0].length);
  const accessCode = url.searchParams.get('accessCode') || url.searchParams.get('pwd')
    || trailing.match(/(?:访问码|提取码|密码|accessCode|pwd)\s*[:：=]\s*([\w-]+)/i)?.[1] || '';
  return { shareCode, accessCode };
}

function officialUrl(origin, pathname, params) {
  const url = new URL(pathname, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

async function readJson(response) {
  if (!response.ok) throw new Error(`天翼云盘请求失败：HTTP ${response.status}`);
  const data = await response.json();
  if (data.res_code !== undefined && Number(data.res_code) !== 0) {
    throw new Error(`天翼云盘返回错误：${data.errorMsg || data.res_message || data.message || data.res_code}`);
  }
  return data;
}

function isFolder(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function safeSegment(value) {
  const name = String(value || '');
  if (!name || name === '.' || name === '..' || /[\\/<>:"|?*\u0000-\u001f]/.test(name)) throw new Error('分享中存在不安全的文件名');
  return name;
}

export class TianyiShareClient {
  constructor(credential, { fetchImpl = fetch } = {}) {
    this.cookie = credential?.cookie || '';
    this.fetchImpl = fetchImpl;
  }

  async request(origin, pathname, params, headers = {}) {
    const response = await this.fetchImpl(officialUrl(origin, pathname, params), { headers, redirect: 'manual' });
    return readJson(response);
  }

  async open(raw) {
    const { shareCode, accessCode } = parseTianyiShareUrl(raw);
    const noCache = Date.now();
    const common = { noCache, shareCode };
    const access = accessCode ? await this.request(SHARE_ORIGIN, '/api/open/share/checkAccessCode.action', { ...common, accessCode }, { Accept: 'application/json;charset=UTF-8' }) : null;
    const info = await this.request(SHARE_ORIGIN, '/api/open/share/getShareInfoByCodeV2.action', common, { Accept: 'application/json;charset=UTF-8' });
    const shareId = access?.shareId || info.shareId;
    if (!shareId || !info.fileId) throw new Error('天翼分享缺少 shareId 或 fileId');
    const share = { shareCode, accessCode, shareId: String(shareId), fileId: String(info.fileId), isFolder: isFolder(info.isFolder), shareMode: accessCode ? 1 : 3 };
    const files = [];
    const visited = new Set();
    const listFolder = async (folderId, prefix, folder) => {
      if (visited.has(String(folderId))) throw new Error('分享目录存在循环引用');
      visited.add(String(folderId));
      for (let pageNum = 1; pageNum <= 1000; pageNum += 1) {
        const params = { noCache: Date.now(), pageNum, pageSize: PAGE_SIZE, fileId: folderId,
          ...(folder ? { shareDirFileId: folderId } : {}), isFolder: folder, shareId, shareMode: share.shareMode,
          iconOption: 5, orderBy: 'lastOpTime', descending: true, accessCode };
        const data = await this.request(SHARE_ORIGIN, '/api/open/share/listShareDir.action', params,
          { Accept: 'application/json;charset=UTF-8', 'Sign-Type': '1' });
        const folders = data.fileListAO?.folderList || [];
        const items = data.fileListAO?.fileList || [];
        if (!Array.isArray(folders) || !Array.isArray(items)) throw new Error('天翼分享列表结构无效');
        for (const item of items) {
          const id = item.id || item.fileId;
          if (!id) throw new Error('分享文件缺少 ID');
          files.push({ ...item, id: String(id), name: [...prefix, safeSegment(item.name || item.fileName || item.server_filename)].join('/'), size: Number(item.size || item.fileSize || 0) });
        }
        for (const item of folders) {
          const id = item.id || item.fileId;
          if (!id) throw new Error('分享文件夹缺少 ID');
          await listFolder(id, [...prefix, safeSegment(item.name || item.fileName)], true);
        }
        if (folders.length + items.length < PAGE_SIZE) return;
      }
      throw new Error('分享目录分页超过安全上限');
    };
    await listFolder(share.fileId, [], share.isFolder);
    if (!share.isFolder && files.length === 0) {
      files.push({ id: share.fileId, name: safeSegment(info.name || info.fileName || info.server_filename), size: Number(info.size || info.fileSize || 0) });
    }
    return { files, share, client: this };
  }

  async accessToken() {
    if (!this.cookie) throw new Error('天翼账号未登录，请先登录天翼云盘');
    let url = new URL('/open/oauth2/ssoH5.action', API_ORIGIN);
    for (let hop = 0; hop < 8; hop += 1) {
      if (!SSO_ORIGINS.includes(url.origin) || url.username || url.password) throw new Error('天翼认证跳转到了非官方地址');
      const token = url.searchParams.get('accessToken');
      if (token) return token;
      const response = await this.fetchImpl(url, { headers: { Cookie: this.cookie }, redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) {
        const final = new URL(response.url || url);
        if (!SSO_ORIGINS.includes(final.origin)) throw new Error('天翼认证响应地址不是官方域名');
        const finalToken = final.searchParams.get('accessToken');
        if (finalToken) return finalToken;
        break;
      }
      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url);
    }
    throw new Error('天翼云盘 SSO 未返回 accessToken，请重新登录');
  }

  async getShareDownloadLink(share, file) {
    const fileId = file?.id || file?.fileId;
    if (!share?.shareId || !fileId) throw new Error('取链缺少 shareId 或 fileId');
    const token = await this.accessToken();
    const timestamp = Date.now();
    const signature = createHash('md5').update(`AccessToken=${token}&Timestamp=${timestamp}&dt=1&fileId=${fileId}&shareId=${share.shareId}`).digest('hex');
    const data = await this.request(API_ORIGIN, '/open/file/getFileDownloadUrl.action', { fileId, dt: 1, shareId: share.shareId },
      { Cookie: this.cookie, Accesstoken: token, Signature: signature, Timestamp: String(timestamp), 'Sign-Type': '1', Accept: 'application/json;charset=UTF-8' });
    let url;
    try { url = new URL(data.fileDownloadUrl); } catch { throw new Error('天翼云盘未返回有效的下载地址'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('天翼云盘未返回安全的 HTTPS 下载地址');
    return { url: url.href, headers: {}, size: Number(file.size || 0) };
  }
}

export async function openTianyiShare(raw, credential, { fetchImpl = fetch } = {}) {
  return new TianyiShareClient(credential, { fetchImpl }).open(raw);
}
