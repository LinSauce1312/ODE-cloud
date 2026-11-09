import { safeSharePath } from '../lib/game-share.mjs';

const ORIGIN = 'https://pan.baidu.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

export function parseBaiduShareUrl(raw) {
  const match = String(raw || '').match(/https:\/\/[^\s<>"'，。]+/i);
  if (!match) throw new Error('请输入百度网盘官方 HTTPS 分享链接');
  let url;
  try { url = new URL(match[0].replace(/[),，。；;]+$/, '')); } catch { throw new Error('百度分享链接无效'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.port) throw new Error('仅支持 pan.baidu.com 官方 HTTPS 分享');
  const route = url.pathname.match(/^\/s\/1([A-Za-z0-9_-]+)\/?$/);
  const surl = route ? route[1] : url.pathname === '/share/init' ? url.searchParams.get('surl') : '';
  if (!surl || !/^[A-Za-z0-9_-]{4,128}$/.test(surl)) throw new Error('百度分享路径须为 /s/1<分享码> 或 /share/init?surl=<分享码>');
  const password = url.searchParams.get('pwd') || String(raw).slice((match.index || 0) + match[0].length).match(/(?:提取码|访问码|密码)\s*[:：=]\s*([A-Za-z0-9]{4})/)?.[1] || '';
  if (password && !/^[A-Za-z0-9]{4}$/.test(password)) throw new Error('百度提取码须为4位字母或数字');
  return { surl, password, url: ORIGIN + '/s/1' + surl };
}

function pageData(html) {
  for (const marker of [/yunData\s*=\s*/g, /yunData\.setData\s*\(\s*/g, /locals\.mset\s*\(\s*/g]) {
    let match;
    while ((match = marker.exec(html))) {
      const start = marker.lastIndex;
      if (html[start] !== '{') continue;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < html.length; index += 1) {
        const character = html[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) {
          try { return JSON.parse(html.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('百度官网未返回可解析的分享元数据；可能需要官网登录、验证码或页面协议已变化');
}

function identifier(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('百度分享标识超出安全整数范围');
  const text = String(value ?? '');
  if (!/^[0-9]{1,24}$/.test(text)) throw new Error('百度分享缺少有效标识');
  return text;
}

function checkReply(reply) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || Number(reply.errno) !== 0) {
    const code = Number(reply?.errno);
    if ([-20, -62, -6, -9, -12].includes(code)) throw new Error('百度分享需要正确提取码、官网登录或验证码；请在官网处理后重试');
    throw new Error('百度分享官方接口拒绝请求（errno=' + (Number.isFinite(code) ? code : 'unknown') + '）；分享可能失效或无权限');
  }
  return reply;
}

export class BaiduShareClient {
  constructor(credential, { fetchImpl = fetch, pageSize = 100, maxPages = 1000, maxDepth = 32, maxEntries = 100000 } = {}) {
    this.cookie = credential?.cookie || '';
    if (typeof this.cookie !== 'string' || /[\r\n]/.test(this.cookie)) throw new Error('百度登录Cookie格式无效');
    this.fetchImpl = fetchImpl;
    for (const [key, value] of Object.entries({ pageSize, maxPages, maxDepth, maxEntries })) {
      if (!Number.isInteger(value) || value < 1 || value > (key === 'maxEntries' ? 100000 : key === 'maxDepth' ? 64 : 1000)) throw new Error('百度列举安全上限无效');
      this[key] = value;
    }
    this.opened = new WeakMap();
  }

  async request(pathname, params = {}, body) {
    const url = new URL(pathname, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.port) throw new Error('百度账号请求仅允许官方源');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const headers = { Cookie: this.cookie, Referer: ORIGIN + '/', 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    const response = await this.fetchImpl(url, { method: body ? 'POST' : 'GET', headers, body: body ? new URLSearchParams(body).toString() : undefined, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('百度官网请求失败：HTTP ' + response.status);
    const setCookies = response.headers?.getSetCookie?.() || [response.headers?.get?.('set-cookie') || ''];
    for (const value of setCookies) {
      const match = value.match(/(?:^|,\s*)BDCLND=([^;\s,]+)/);
      if (match) {
        const retained = this.cookie.split(';').map((part) => part.trim()).filter((part) => part && !part.startsWith('BDCLND='));
        retained.push('BDCLND=' + match[1]); this.cookie = retained.join('; ');
      }
    }
    return response;
  }

  async json(pathname, params, body) {
    const response = await this.request(pathname, params, body);
    let reply;
    try { reply = await response.json(); } catch { throw new Error('百度官网返回非JSON；请先在官网处理登录或验证码'); }
    return checkReply(reply);
  }

  async open(raw) {
    const parsed = parseBaiduShareUrl(raw);
    if (parsed.password) {
      const verified = await this.json('/share/verify', { surl: parsed.surl, web: 1, clienttype: 0 }, { pwd: parsed.password, vcode: '', vcode_str: '' });
      if (typeof verified.randsk === 'string' && verified.randsk && !/[\r\n;]/.test(verified.randsk)) {
        const retained = this.cookie.split(';').map((part) => part.trim()).filter((part) => part && !part.startsWith('BDCLND='));
        retained.push('BDCLND=' + encodeURIComponent(verified.randsk)); this.cookie = retained.join('; ');
      }
    }
    const response = await this.request('/s/1' + parsed.surl);
    const html = await response.text();
    if (html.length > 8 * 1024 * 1024) throw new Error('百度分享页面过大');
    const metadata = pageData(html);
    const share = { surl: parsed.surl, shareId: identifier(metadata.shareid ?? metadata.share_id), uk: identifier(metadata.uk ?? metadata.share_uk) };
    const files = [];
    const visited = new Set();
    const ids = new Set();
    let entries = 0;
    const walk = async (directory, prefix, depth) => {
      if (depth > this.maxDepth || visited.has(directory)) throw new Error('百度分享目录循环或层级超过上限');
      visited.add(directory);
      for (let page = 1; page <= this.maxPages; page += 1) {
        const result = await this.json('/share/list', { shareid: share.shareId, uk: share.uk, root: directory === '/' ? 1 : 0, dir: directory, page, num: this.pageSize, order: 'name', desc: 0, web: 1, clienttype: 0 });
        if (!Array.isArray(result.list)) throw new Error('百度分享列表结构无效');
        for (const item of result.list) {
          if (++entries > this.maxEntries) throw new Error('百度分享文件数量超过安全上限');
          const id = identifier(item.fs_id);
          if (ids.has(id)) throw new Error('百度分享重复条目或分页未前进');
          ids.add(id);
          const segment = safeSharePath(item.server_filename);
          if (segment.includes('/')) throw new Error('百度分享文件名单段含路径分隔符');
          const name = prefix ? prefix + '/' + segment : segment;
          if (Number(item.isdir) === 1) {
            if (typeof item.path !== 'string' || !item.path.startsWith('/') || item.path.includes('\\') || item.path.split('/').some((part) => part === '..' || part === '.')) throw new Error('百度分享目录路径无效');
            await walk(item.path, name, depth + 1);
          } else {
            const size = Number(item.size);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('百度分享文件大小无效');
            files.push({ id, name: safeSharePath(name), size });
          }
        }
        if (result.has_more === false || result.has_more === 0 || result.has_more == null && result.list.length < this.pageSize) return;
      }
      throw new Error('百度分享分页超过安全上限');
    };
    await walk('/', '', 0);
    const sekey = this.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('BDCLND='))?.slice(7) || '';
    this.opened.set(share, { metadata, sekey, files: new Map(files.map((file) => [file.id, { ...file }])) });
    return { client: this, share, files };
  }

  async getShareDownloadLink(share, file) {
    const session = this.opened.get(share);
    const listed = session?.files.get(String(file?.id));
    if (!listed || listed.name !== file.name || listed.size !== file.size) throw new Error('百度文件不属于本次已列举分享');
    if (!/(?:^|;)\s*BDUSS=[^;\s]+/.test(this.cookie)) throw new Error('百度分享下载需要本机有效官网登录Cookie，请先登录百度');
    const { metadata } = session;
    if (typeof metadata.sign !== 'string' || !metadata.sign || !/^\d+$/.test(String(metadata.timestamp || ''))) throw new Error('百度官网未提供下载sign/timestamp；请在官网处理权限或验证码，不尝试绕过');
    let sekey;
    try { sekey = decodeURIComponent(session.sekey); } catch { throw new Error('百度提取码会话无效，请重新打开分享'); }
    const result = await this.json('/api/sharedownload', { sign: metadata.sign, timestamp: metadata.timestamp, bdstoken: typeof metadata.bdstoken === 'string' ? metadata.bdstoken : '', clienttype: 0, web: 1, app_id: 250528 }, { encrypt: 0, product: 'share', uk: share.uk, primaryid: share.shareId, fid_list: JSON.stringify([listed.id]), extra: JSON.stringify({ sekey }) });
    const link = result.list?.find((item) => String(item.fs_id) === listed.id)?.dlink;
    let url;
    try { url = new URL(link); } catch { throw new Error('百度未返回可用文件直链，可能需要会员或验证码'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('百度返回不安全下载地址');
    const host = url.hostname;
    if (!['baidu.com', 'baidupcs.com', 'baidubce.com'].some((domain) => host === domain || host.endsWith('.' + domain))) throw new Error('百度返回非官方CDN，拒绝发送下载请求');
    return { url: url.href, headers: { Referer: ORIGIN + '/', 'User-Agent': USER_AGENT }, size: listed.size };
  }
}

export async function openBaiduShare(raw, credential, options = {}) {
  return new BaiduShareClient(credential, options).open(raw);
}
