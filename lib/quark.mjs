const API = 'https://drive-pc.quark.cn/1/clouddrive';
const ORIGIN = 'https://pan.quark.cn';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch';

export class QuarkApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'QuarkApiError';
    this.code = code;
  }
}

export function parseQuarkShareUrl(raw) {
  const text = String(raw ?? '').trim();
  const match = text.match(/https?:\/\/[^\s<>"']+|pan\.quark\.cn\/s\/[A-Za-z0-9]+[^\s<>"']*/i);
  if (!match) throw new QuarkApiError('未找到夸克分享链接');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    throw new QuarkApiError('夸克分享链接格式错误');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'pan.quark.cn') {
    throw new QuarkApiError('不是夸克分享链接');
  }
  const shareId = /^\/s\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
  if (!shareId) throw new QuarkApiError('夸克分享链接缺少分享 ID');
  const pwd = url.searchParams.get('pwd') || /(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})/.exec(text)?.[1] || '';
  return { shareId, pwd };
}

function requireCookie(cookie) {
  if (typeof cookie !== 'string' || !['__pus', '__puus'].every((key) =>
    cookie.split(';').some((part) => part.trim().startsWith(`${key}=`) && part.trim().length > key.length + 1))) {
    throw new QuarkApiError('夸克 Cookie 需包含 __pus 和 __puus');
  }
  return cookie.trim();
}

function updateCookie(cookie, headers) {
  const setCookies = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [headers?.get?.('set-cookie')].filter(Boolean);
  let parts = cookie.split(';').map((part) => part.trim()).filter(Boolean);
  for (const setCookie of setCookies) {
    const pair = /^\s*(__puus|__pus)=([^;\s]*)/.exec(setCookie);
    if (!pair) continue;
    parts = parts.filter((part) => !part.startsWith(`${pair[1]}=`));
    parts.push(`${pair[1]}=${pair[2]}`);
  }
  return parts.join('; ');
}

function normalizeFile(raw) {
  return {
    fid: String(raw.fid ?? ''),
    name: String(raw.file_name ?? raw.fname ?? ''),
    size: Number(raw.size ?? raw.fsize ?? 0),
    isDirectory: raw.dir === true || raw.isdir === 1,
    pdirFid: String(raw.pdir_fid ?? ''),
    fidToken: String(raw.share_fid_token ?? raw.fid_token ?? ''),
  };
}

/** 独立夸克 Cookie 会话；不会写入磁盘，调用方负责保管 Cookie 与下载 headers。 */
export class QuarkClient {
  constructor(cookie, { fetchImpl = fetch } = {}) {
    this.cookie = requireCookie(cookie);
    this.fetchImpl = fetchImpl;
  }

  async request(url, { method = 'GET', body, shareDetail = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Cookie: this.cookie,
          'User-Agent': USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(shareDetail ? { Origin: ORIGIN, Referer: `${ORIGIN}/` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new QuarkApiError('夸克网络请求失败');
    }
    this.cookie = updateCookie(this.cookie, response.headers);
    let json;
    try {
      json = await response.json();
    } catch {
      throw new QuarkApiError(`夸克响应不是 JSON（HTTP ${response.status}）`, response.status);
    }
    const code = Number(json.code ?? 0);
    if (!response.ok || (json.status !== undefined && Number(json.status) !== 200) || (json.code !== undefined && code !== 0)) {
      throw new QuarkApiError(`夸克接口拒绝请求（HTTP ${response.status}，code ${Number.isFinite(code) ? code : '未知'}）`, Number.isFinite(code) && code !== 0 ? code : response.status);
    }
    return json.data;
  }

  /** 检查 cookie 登录态，返回账户昵称；错误时不会回显凭据。 */
  async login() {
    let response;
    try {
      response = await this.fetchImpl(`${ORIGIN}/account/info`, {
        method: 'GET', headers: { Cookie: this.cookie, 'User-Agent': USER_AGENT },
      });
    } catch {
      throw new QuarkApiError('夸克账户验证网络请求失败');
    }
    this.cookie = updateCookie(this.cookie, response.headers);
    let json;
    try {
      json = await response.json();
    } catch {
      throw new QuarkApiError(`夸克账户验证响应不是 JSON（HTTP ${response.status}）`, response.status);
    }
    if (!response.ok || json.success !== true || (json.code !== undefined && json.code !== 'OK')) {
      throw new QuarkApiError('夸克 Cookie 无效或登录态已失效', response.status);
    }
    return { nickname: String(json.data?.nickname ?? '') };
  }

  async shareToken(shareId, pwd = '') {
    const data = await this.request(`${API}/share/sharepage/token?pr=ucpro&fr=pc`, {
      method: 'POST', body: { pwd_id: shareId, passcode: pwd, support_visit_limit_private_share: true },
    });
    if (!data?.stoken) throw new QuarkApiError('夸克分享未返回访问凭证');
    return { shareId, stoken: String(data.stoken), title: String(data.title ?? ''), firstFid: String(data.first_fid ?? '0') };
  }

  /** 单个目录全量分页；服务端单页可能不足 pageSize，按空页/重复页停止。 */
  async listDirectory(session, pdirFid = '0', { pageSize = 50, maxPages = 200 } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxPages) || maxPages < 1) {
      throw new QuarkApiError('无效的分页参数');
    }
    const files = new Map();
    for (let page = 1; page <= maxPages; page += 1) {
      const params = new URLSearchParams({
        pr: 'ucpro', fr: 'pc', pwd_id: session.shareId, stoken: session.stoken,
        pdir_fid: String(pdirFid), ver: '2', force: '0', _page: String(page), _size: String(pageSize),
        _fetch_banner: '0', _fetch_share: '0', fetch_relate_conversation: '0', _fetch_total: '1',
        _sort: 'file_type:asc,file_name:asc',
      });
      const data = await this.request(`${API}/share/sharepage/detail?${params}`, { shareDetail: true });
      if (!Array.isArray(data?.list)) throw new QuarkApiError('夸克分享列表格式错误');
      if (data.list.length === 0) return [...files.values()];
      const before = files.size;
      for (const raw of data.list) {
        const file = normalizeFile(raw);
        if (!file.fid || !file.name) continue;
        if (!files.has(file.fid)) files.set(file.fid, file);
      }
      if (files.size === before) return [...files.values()];
    }
    throw new QuarkApiError('夸克分享目录超出最大分页数');
  }

  /** 解析分享文案、提取码与递归文件树；只返回文件。 */
  async resolveShare(raw, { pwd, password, maxDepth = 8, pageSize = 50, maxPages = 200 } = {}) {
    const parsed = parseQuarkShareUrl(raw);
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new QuarkApiError('无效的目录深度');
    const session = await this.shareToken(parsed.shareId, password ?? pwd ?? parsed.pwd);
    const files = [];
    const visited = new Set();
    const walk = async (parentFid, prefix, depth) => {
      if (visited.has(parentFid)) return;
      visited.add(parentFid);
      const entries = await this.listDirectory(session, parentFid, { pageSize, maxPages });
      for (const entry of entries) {
        if (entry.isDirectory) {
          if (depth >= maxDepth) throw new QuarkApiError('夸克分享目录超出最大递归深度');
          await walk(entry.fid, `${prefix}${entry.name}/`, depth + 1);
        } else {
          files.push({ ...entry, name: `${prefix}${entry.name}` });
        }
      }
    };
    await walk('0', '', 0);
    return { share: session, files };
  }

  async list(raw, options) {
    return (await this.resolveShare(raw, options)).files;
  }

  async link(raw, file, { password, pwd } = {}) {
    const parsed = parseQuarkShareUrl(raw);
    const session = await this.shareToken(parsed.shareId, password ?? pwd ?? parsed.pwd);
    return this.getShareDownloadLink(session, file);
  }

  async downloadRequest(body) {
    const data = await this.request(`${API}/file/download?pr=ucpro&fr=pc&sys=win32&ve=3.23.2`, { method: 'POST', body });
    const file = Array.isArray(data) ? data[0] : null;
    if (!file?.download_url) throw new QuarkApiError('夸克未返回文件下载链接');
    return {
      fid: String(file.fid ?? body.fids[0]),
      name: String(file.file_name ?? file.filename ?? ''),
      size: Number(file.size ?? 0),
      url: String(file.download_url),
      headers: { Cookie: this.cookie, 'User-Agent': USER_AGENT, Referer: `${ORIGIN}/` },
    };
  }

  /** 分享文件免转存取链；部分分享被服务端拒绝时不会绕过限制或擅自转存。 */
  async getShareDownloadLink(share, file) {
    if (!share?.shareId || !share?.stoken || !file?.fid || !file?.fidToken || file.isDirectory) {
      throw new QuarkApiError('分享取链缺少文件或分享凭证');
    }
    return this.downloadRequest({
      fids: [file.fid], fids_token: [file.fidToken], pwd_id: share.shareId,
      stoken: share.stoken, speedup_session: '', token: '',
    });
  }

  /** 已在当前账号网盘中的 fid 取链，不接受分享文件 fid。 */
  async getAccountDownloadLink(fid) {
    if (typeof fid !== 'string' || !fid.trim()) throw new QuarkApiError('网盘文件 fid 不能为空');
    return this.downloadRequest({ fids: [fid] });
  }
}
