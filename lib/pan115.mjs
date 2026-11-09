import { safeSharePath } from './game-share.mjs';

const API_BASE = 'https://webapi.115.com';
const SHARE_HOSTS = new Set(['115.com', '115cdn.com', '115rc.com']);
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36';
const CLIENT_UA = 'Mozilla/5.0 115Browser/36.0.1';

export function cookieValue(cookie, name) {
  const pair = String(cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : '';
}

export function normalizeCookie(cookie) {
  const values = new Map();
  for (const part of String(cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && value && !values.has(name)) values.set(name, value);
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Merge cookies by name, retaining the login cookie and the CDN cookie. */
export function mergeCookies(...cookies) {
  const values = new Map();
  for (const cookie of cookies) {
    for (const part of String(cookie || '').split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (name && value) values.set(name, value);
    }
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Select the path-bound short-lived cookie used by the returned CDN URL. */
export function cookieFromSetCookie(headers) {
  const values = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const rawValues = values.length ? values : (headers?.get('set-cookie') || '').split(/,(?=[^;,]+=)/);
  let fallback = '';
  for (const raw of rawValues) {
    const pair = raw.split(';', 1)[0].trim();
    const name = pair.split('=', 1)[0].trim().toLowerCase();
    if (!pair.includes('=') || ['expires', 'path', 'domain'].includes(name)) continue;
    if (!fallback) fallback = pair;
    const path = raw.match(/(?:^|;)\s*path=([^;]+)/i)?.[1]?.trim();
    if (path && path !== '/') return pair;
  }
  return fallback;
}

export function parse115ShareUrl(raw) {
  const text = String(raw || '').trim();
  const candidate = text.match(/https?:\/\/[^\s<>"'，。；]+|(?<![A-Za-z0-9_.@/-])(?:115\.com|115cdn\.com|115rc\.com)\/s\/[^\s<>"'，。；]+/i)?.[0]?.replace(/[),;]+$/, '');
  if (!candidate) throw new Error('无法识别 115 分享链接');
  let url;
  try { url = new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate); } catch { throw new Error('无法识别 115 分享链接'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !SHARE_HOSTS.has(url.hostname.toLowerCase())) throw new Error('不是安全的 115 HTTPS 分享链接');
  const match = url.pathname.match(/^\/s\/(sw[A-Za-z0-9]+)\/?$/i);
  if (!match) throw new Error('链接里没有找到 115 分享编号');
  const receiveCode = url.searchParams.get('password') || url.searchParams.get('pwd') || /(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/.exec(text)?.[1] || '';
  return { shareCode: match[1], receiveCode };
}

export class Pan115Credential {
  constructor(cookie) {
    this.cookie = normalizeCookie(cookie);
    if (!this.cookie) throw new Error('115 Cookie 不能为空');
  }
  get loggedIn() { return Boolean(cookieValue(this.cookie, 'UID')); }
  get userId() { return cookieValue(this.cookie, 'UID').split('_', 1)[0]; }
}

export class Pan115Api {
  constructor({ cookie = '', fetchImpl = fetch, base = API_BASE, userAgent = WEB_UA } = {}) {
    this.credential = new Pan115Credential(cookie);
    this.fetchImpl = fetchImpl;
    this.base = base.endsWith('/') ? base : `${base}/`;
    this.userAgent = userAgent;
  }

  async request(path, { method = 'GET', body, referer = 'https://115cdn.com/' , download = false } = {}) {
    const url = new URL(path, this.base);
    const headers = { accept: 'application/json, text/plain, */*', 'user-agent': download ? CLIENT_UA : this.userAgent, referer, 'x-requested-with': 'XMLHttpRequest', cookie: this.credential.cookie };
    if (body !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'; }
    const response = await this.fetchImpl(url, { method, headers, body });
    const text = await response.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { throw new Error(`115 返回非 JSON（HTTP ${response.status}）`); }
    const errno = Number(json.errno ?? json.errNo ?? 0);
    if (!response.ok || json.state === false || (errno && errno !== 0)) throw new Error(json.error || json.msg || `115 请求失败（errno=${errno || response.status}）`);
    return { json, headers: response.headers };
  }

  async validate() {
    const { json } = await this.request('/user/info?ct=json', { referer: 'https://115.com/' });
    return String(json.data || '');
  }

  async sharePage({ shareCode, receiveCode = '', cid = '0', offset = 0, limit = 100 }) {
    const qs = new URLSearchParams({ share_code: shareCode, receive_code: receiveCode, cid, offset: String(offset), limit: String(limit), asc: '0', format: 'json' });
    const { json } = await this.request(`/share/snap?${qs}`, { referer: `https://115cdn.com/s/${shareCode}${receiveCode ? `?password=${encodeURIComponent(receiveCode)}&` : ''}` });
    const data = json.data || {};
    return { files: Array.isArray(data.list) ? data.list : [], total: Number(data.count || 0), userId: String(data.userinfo?.user_id || ''), title: String(data.shareinfo?.share_title || ''), state: Number(data.share_state || data.shareinfo?.share_state || 0) };
  }

  async shareDownload({ shareCode, receiveCode = '', userId, file }) {
    if (!userId) throw new Error('缺少分享者 UID');
    const qs = new URLSearchParams({ dl: '1', user_id: userId, share_code: shareCode, file_id: file.id });
    if (receiveCode) qs.set('receive_code', receiveCode);
    const { json, headers } = await this.request(`/share/downurl?${qs}`, { referer: `https://115cdn.com/s/${shareCode}${receiveCode ? `?password=${encodeURIComponent(receiveCode)}&` : ''}`, download: true });
    const data = json.data || {};
    const url = String(data.file_url_302 || data.file_url || data.url?.url || '');
    if (!url) throw new Error('115 未返回下载链接');
    const cdnCookie = cookieFromSetCookie(headers);
    return { url, cookie: mergeCookies(this.credential.cookie, cdnCookie), cdnCookie, name: String(data.fn || file.name), size: Number(data.fs || file.size || 0) };
  }
}

function mapFile(item) {
  const isDir = Number(item.fc ?? (item.fid ? 1 : 0)) === 0;
  const id = String(isDir ? item.cid || '' : item.fid || '');
  return { id, name: String(item.n || ''), size: isDir ? 0 : Number(item.s || 0), isDir, parentId: String(item.pid || item.cid || '') };
}

export class Pan115Share {
  constructor(apiOrOptions = {}) {
    this.api = apiOrOptions instanceof Pan115Api ? apiOrOptions : new Pan115Api(apiOrOptions);
  }
  async resolve(rawUrl, options = {}) {
    const parsed = parse115ShareUrl(rawUrl);
    const receiveCode = options.password || parsed.receiveCode;
    const all = [];
    let userId = '';
    let title = '';
    const walk = async (cid, prefix, depth) => {
      if (depth > (options.maxDepth ?? 32)) throw new Error('115 分享目录嵌套超过限制');
      let offset = 0;
      while (true) {
        const page = await this.api.sharePage({ ...parsed, receiveCode, cid, offset });
        userId ||= page.userId; title ||= page.title;
        const files = page.files.map(mapFile).filter((file) => file.id);
        for (const file of files) {
          if (file.name.includes('/') || file.name.includes('\\')) throw new Error('115 分享文件名含路径分隔符');
          safeSharePath(file.name);
          if (file.isDir) await walk(file.id, `${prefix}${file.name}/`, depth + 1);
          else {
            const item = { ...file, name: `${prefix}${file.name}`, shareCode: parsed.shareCode, receiveCode };
            all.push(item); options.onProgress?.({ type: 'file', file: item });
          }
        }
        offset += page.files.length;
        if (!page.files.length || page.files.length < 100 || (page.total > 0 && offset >= page.total)) break;
      }
    };
    await walk('0', '', 0);
    if (!all.length) throw new Error('115 分享为空或需要正确访问码');
    for (const file of all) file.userId = userId;
    return { shareCode: parsed.shareCode, receiveCode, userId, title, files: all };
  }
  async list(rawUrl, options = {}) {
    return (await this.resolve(rawUrl, options)).files;
  }
  async link(rawUrl, item) {
    const parsed = parse115ShareUrl(rawUrl);
    if (item.shareCode && item.shareCode !== parsed.shareCode) throw new Error('115 文件与分享链接不匹配');
    const session = item.userId ? null : await this.resolve(rawUrl);
    const link = await this.api.shareDownload({ shareCode: parsed.shareCode, receiveCode: item.receiveCode ?? session?.receiveCode ?? parsed.receiveCode, userId: item.userId || session?.userId, file: item });
    return { url: link.url, headers: { cookie: link.cookie, referer: `https://115cdn.com/s/${parsed.shareCode}`, 'user-agent': CLIENT_UA }, cookie: link.cookie, size: link.size || item.size, name: link.name || item.name };
  }
  async links(share, files = share.files) {
    return Promise.all(files.filter((file) => !file.isDir).map(async (file) => ({ file, link: await this.api.shareDownload({ shareCode: share.shareCode, receiveCode: share.receiveCode, userId: share.userId, file }) })));
  }
}

export const PAN115 = { API_BASE, WEB_UA, CLIENT_UA };
