import { safeSharePath } from '../lib/game-share.mjs';

// 光鸭网盘公开 /userres/v1 分享命名空间（源自公开 guangyapan/client.py 文档）。
// 与 LinkSwift 的 /nd.bizuserres.s/v1 命名空间不同，二者不可混用：
// LinkSwift 需要浏览器 localStorage 的 Authorization/captcha/device，属于已登录会话；
// /userres/v1 是文档化的独立分享路径，这里按无账号方式尝试，失败时给出明确可操作的错误。
const ORIGIN = 'https://api.guangyapan.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

export function parseGuangyaShareUrl(raw) {
  const match = String(raw || '').match(/https?:\/\/[^\s<>"'，。]+/i);
  if (!match) throw new Error('请输入光鸭网盘官方分享链接');
  let url;
  try { url = new URL(match[0].replace(/[),，。；;]+$/, '')); } catch { throw new Error('光鸭分享链接无效'); }
  if (url.protocol !== 'https:' || !['www.guangyapan.com', 'guangyapan.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('只支持光鸭官方 HTTPS 分享链接');
  const shareId = url.pathname.match(/^\/s\/([^/?#]+)$/)?.[1];
  if (!shareId) throw new Error('光鸭分享路径须为 /s/<分享ID>');
  const password = url.searchParams.get('code') || url.searchParams.get('pwd') || '';
  let decoded;
  try { decoded = decodeURIComponent(shareId); } catch { throw new Error('光鸭分享 ID 编码无效'); }
  if (!decoded || decoded.length > 512 || /[\x00-\x1f\x7f]/.test(decoded)) throw new Error('光鸭分享 ID 无效');
  return { shareId: decoded, password, url: 'https://' + url.hostname + url.pathname };
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function dataOf(reply) {
  if (reply && typeof reply === 'object' && !Array.isArray(reply) && reply.data !== undefined) return reply.data;
  return reply;
}

function checkReply(reply) {
  const raw = pick(reply, ['code', 'status', 'errno', 'errCode']);
  if (raw === undefined) return dataOf(reply);
  const code = Number(raw);
  if (!Number.isFinite(code)) throw new Error('光鸭官方接口返回未知状态码；检查分享有效性或官网验证');
  if (code === 0 || code === 200) return dataOf(reply);
  if (code === 207) throw new Error('光鸭网盘分享者未开启免登录下载；当前模式不使用账号，请登录官网后下载');
  if (code === 9) throw new Error('光鸭网盘页面验证已过期，请刷新分享页后重试');
  if (code === 103) throw new Error('光鸭网盘后端响应超时，请稍后重试');
  throw new Error('光鸭官方接口拒绝分享请求（code=' + (Number.isFinite(code) ? code : 'unknown') + '）；检查访问码、分享有效性或官网验证');
}

function tokenValue(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) throw new Error('光鸭分享令牌无效');
  return value;
}

function textValue(value, label) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('光鸭' + label + '无效');
  return value;
}

function idValue(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new Error('光鸭分享文件标识无效');
  return text;
}

function isFolder(item) {
  return item?.resType === 2 || item?.isDir === true || item?.is_dir === true || item?.leaf === false
    || item?.type === 'folder' || item?.type === 'dir' || item?.fileType === 'folder' || item?.file_type === 'folder';
}

function entryId(item) { return pick(item, ['fileId', 'file_id', 'id', 'fid']); }
function entryName(item) { return pick(item, ['fileName', 'file_name', 'name', 'title']); }
function entrySize(item) { return pick(item, ['size', 'fileSize', 'file_size', 'length']); }

export class GuangyaShareClient {
  constructor({ fetchImpl = fetch, pageSize = 100, maxPages = 1000, maxDepth = 32, maxEntries = 100000 } = {}) {
    this.fetchImpl = fetchImpl;
    for (const [key, value] of Object.entries({ pageSize, maxPages, maxDepth, maxEntries })) {
      if (!Number.isInteger(value) || value < 1 || value > (key === 'maxEntries' ? 100000 : key === 'maxDepth' ? 64 : 1000)) throw new Error('光鸭列举安全上限无效');
      this[key] = value;
    }
  }

  async request(pathname, body) {
    const url = new URL(pathname, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.port) throw new Error('光鸭 API 仅允许官方源');
    let response;
    try {
      response = await this.fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', Referer: 'https://www.guangyapan.com/', 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || error?.name || 'NETWORK_ERROR');
      throw new Error('光鸭官网网络请求失败（' + (/^[A-Z_a-z0-9]{1,64}$/.test(code) ? code : 'NETWORK_ERROR') + '）；请检查网络或稍后重试');
    }
    if (response.status >= 300 || response.status < 200) { await response.body?.cancel(); throw new Error('光鸭官方 API 返回 HTTP ' + response.status + '；可能要求官网验证或登录'); }
    let reply;
    try { reply = await response.json(); } catch { throw new Error('光鸭官方 API 返回非 JSON；可能要求官网登录或验证'); }
    return checkReply(reply);
  }

  async open(raw) {
    const parsed = parseGuangyaShareUrl(raw);
    const tokenData = await this.request('/userres/v1/get_share_access_token', { shareId: parsed.shareId, code: parsed.password });
    const accessToken = tokenValue(pick(tokenData, ['accessToken', 'access_token', 'token']));
    const share = { shareId: parsed.shareId, accessToken };
    const files = [];
    const visited = new Set();
    const ids = new Set();
    let entries = 0;
    const walk = async (parent, prefix, depth) => {
      if (depth > this.maxDepth || visited.has(parent)) throw new Error('光鸭分享目录循环或层级超限');
      visited.add(parent);
      for (let page = 0; page < this.maxPages; page += 1) {
        const data = await this.request('/userres/v1/get_share_page_files_list', { accessToken, parent_id: parent, page, pageSize: this.pageSize });
        const list = Array.isArray(data) ? data : pick(data, ['list', 'files', 'fileList', 'records', 'content', 'rows', 'items']);
        if (!Array.isArray(list)) throw new Error('光鸭分享列表结构无效');
        for (const item of list) {
          if (++entries > this.maxEntries) throw new Error('光鸭分享文件数量超过安全上限');
          const id = idValue(entryId(item));
          if (ids.has(id)) throw new Error('光鸭分享分页重复或未前进');
          ids.add(id);
          const segment = safeSharePath(textValue(entryName(item), '文件名'));
          if (segment.includes('/')) throw new Error('光鸭文件名单段含路径分隔符');
          const name = prefix ? prefix + '/' + segment : segment;
          if (isFolder(item)) await walk(id, name, depth + 1);
          else {
            const size = Number(entrySize(item));
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('光鸭文件大小无效');
            files.push({ id, name: safeSharePath(name), size });
          }
        }
        const hasMore = pick(data, ['hasMore', 'has_more']);
        if (hasMore === false || hasMore === 0 || list.length < this.pageSize) return;
      }
      throw new Error('光鸭分享分页超过安全上限');
    };
    await walk('', '', 0);
    return { client: this, share, files };
  }

  async getShareDownloadLink(share, file) {
    const data = await this.request('/userres/v1/get_share_download_url', { accessToken: share.accessToken, fileId: file.id, download: true });
    const direct = pick(data, ['downloadUrl', 'download_url', 'signedURL', 'url', 'link']);
    let url;
    try { url = new URL(direct); } catch { throw new Error('光鸭未返回有效文件直链；分享者可能未开启免登录下载'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('光鸭未返回安全 HTTPS 下载链接');
    return { url: url.href, headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.guangyapan.com/' }, size: file.size };
  }
}

export async function openGuangyaShare(raw, options = {}) {
  return new GuangyaShareClient(options).open(raw);
}
