import { safeSharePath } from '../lib/game-share.mjs';

const ORIGIN = 'https://pc-api.uc.cn';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export function parseUcShareUrl(raw) {
  const match = String(raw || '').match(/https?:\/\/[^\s<>"'，。]+/i);
  if (!match) throw new Error('请输入 UC 网盘官方分享链接');
  let url;
  try { url = new URL(match[0].replace(/[),，。；;]+$/, '')); } catch { throw new Error('UC 分享链接无效'); }
  if (url.protocol !== 'https:' || !['drive.uc.cn', 'fast.uc.cn'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('只支持 UC 官方 HTTPS 分享链接');
  const shareId = url.pathname.match(/^\/(?:s|share)\/([A-Za-z0-9]+)\/?$/)?.[1];
  if (!shareId) throw new Error('UC 分享路径须为 /s/<分享ID> 或 /share/<分享ID>');
  const password = url.searchParams.get('pwd') || String(raw).slice((match.index || 0) + match[0].length).match(/(?:提取码|访问码|密码)\s*[:：=]\s*([A-Za-z0-9]{4})/)?.[1] || '';
  if (password && !/^[A-Za-z0-9]{4}$/.test(password)) throw new Error('UC 提取码须为4位字母或数字');
  return { shareId, password, url: 'https://' + url.hostname + url.pathname };
}

function checkReply(reply) {
  if (reply && typeof reply === 'object' && !Array.isArray(reply) && Number(reply.code) === 0) return reply.data;
  const code = Number(reply?.code);
  if (code === 31001) throw new Error('UC 网盘要求登录后才能获取该文件直链；当前模式不使用网盘账号');
  if (code === 23018) throw new Error('UC 网盘游客下载超出文件大小限制；当前模式不使用网盘账号');
  throw new Error('UC 官方接口拒绝分享请求（code=' + (Number.isFinite(code) ? code : 'unknown') + '）；检查提取码、分享有效性或官网验证');
}

function tokenValue(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) throw new Error('UC 分享令牌无效');
  return value;
}

function identifier(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new Error('UC 分享文件标识无效');
  return text;
}

export class UcShareClient {
  constructor({ fetchImpl = fetch, pageSize = 50, maxPages = 1000, maxDepth = 32, maxEntries = 100000 } = {}) {
    this.fetchImpl = fetchImpl;
    for (const [key, value] of Object.entries({ pageSize, maxPages, maxDepth, maxEntries })) {
      if (!Number.isInteger(value) || value < 1 || value > (key === 'maxEntries' ? 100000 : key === 'maxDepth' ? 64 : 1000)) throw new Error('UC 列举安全上限无效');
      this[key] = value;
    }
  }

  async request(pathname, params = {}, body) {
    const url = new URL(pathname, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.port) throw new Error('UC API 仅允许官方源');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', Referer: 'https://drive.uc.cn/', 'User-Agent': USER_AGENT, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || error?.name || 'NETWORK_ERROR');
      throw new Error('UC 官网网络请求失败（' + (/^[A-Z_a-z0-9]{1,64}$/.test(code) ? code : 'NETWORK_ERROR') + '）；请检查网络或稍后重试');
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('UC 官方 API 返回 HTTP ' + response.status + '；可能要求官网验证或登录'); }
    let reply;
    try { reply = await response.json(); } catch { throw new Error('UC 官方 API 返回非 JSON；可能要求官网登录或验证'); }
    return checkReply(reply);
  }

  async open(raw) {
    const parsed = parseUcShareUrl(raw);
    const share = { pwd_id: parsed.shareId, passcode: parsed.password };
    const token = await this.request('/1/clouddrive/share/sharepage/token', { entry: 'ft', fr: 'pc', pr: 'UCBrowser' }, { ...share, share_for_transfer: true });
    share.stoken = tokenValue(token?.stoken);
    const files = [];
    const visited = new Set();
    const ids = new Set();
    let entries = 0;
    const walk = async (directory, prefix, depth) => {
      if (depth > this.maxDepth || visited.has(directory)) throw new Error('UC 分享目录循环或层级超限');
      visited.add(directory);
      for (let page = 1; page <= this.maxPages; page += 1) {
        const data = await this.request('/1/clouddrive/transfer_share/detail', { ...share, entry: 'ft', pdir_fid: directory,
          fetch_file_list: 1, _page: page, _size: this.pageSize, _fetch_total: 1, _fetch_share: 1,
          _sort: 'file_type:asc,file_name:asc', fr: 'pc', pr: 'UCBrowser' });
        if (!Array.isArray(data?.list)) throw new Error('UC 分享列表结构无效');
        for (const item of data.list) {
          if (++entries > this.maxEntries) throw new Error('UC 分享文件数量超过安全上限');
          const id = identifier(item.fid);
          if (ids.has(id)) throw new Error('UC 分享分页重复或未前进');
          ids.add(id);
          const segment = safeSharePath(item.file_name);
          if (segment.includes('/')) throw new Error('UC 文件名单段含路径分隔符');
          const name = prefix ? prefix + '/' + segment : segment;
          if (item.file === false || item.file === 0) await walk(id, name, depth + 1);
          else {
            if (item.file !== true && item.file !== 1) throw new Error('UC 分享条目文件类型无效');
            const size = Number(item.size);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('UC 文件大小无效');
            files.push({ id, name: safeSharePath(name), size, token: tokenValue(item.share_fid_token) });
          }
        }
        if (data.list.length < this.pageSize) return;
      }
      throw new Error('UC 分享分页超过安全上限');
    };
    await walk('0', '', 0);
    return { client: this, share, files };
  }

  async getShareDownloadLink(share, file) {
    const data = await this.request('/1/clouddrive/file/download', { pr: 'UCBrowser', fr: 'pc', sys: 'win32', ve: '1.8.8' },
      { fids: [file.id], fids_token: [file.token], pwd_id: share.pwd_id, stoken: share.stoken });
    const direct = Array.isArray(data) ? data[0]?.download_url : data?.download_url;
    let url;
    try { url = new URL(direct); } catch { throw new Error('UC 未返回有效文件直链'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('UC 未返回安全 HTTPS 下载链接');
    return { url: url.href, headers: { 'User-Agent': USER_AGENT, Referer: 'https://drive.uc.cn/' }, size: file.size };
  }
}

export async function openUcShare(raw, options = {}) {
  return new UcShareClient(options).open(raw);
}
