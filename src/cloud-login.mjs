import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const LOOPBACK = '127.0.0.1';
import { DATA_DIR } from '../lib/paths.mjs';
const STORAGE = path.join(DATA_DIR, 'adapter-credentials.json');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const CLOUDS = Object.freeze({
  baidu: { name: '百度网盘', loginUrl: 'https://pan.baidu.com/', domains: ['baidu.com', 'pan.baidu.com'] },
  tianyi: { name: '天翼云盘', loginUrl: 'https://cloud.189.cn/web/login.html', domains: ['189.cn', 'cloud.189.cn'] },
  pan123: { name: '123网盘', loginUrl: 'https://login.123pan.com/centerlogin?redirect_url=https%3A%2F%2Fwww.123pan.com%2F&source_page=website', domains: ['123pan.com', 'www.123pan.com', 'login.123pan.com'] },
  quark: { name: '夸克网盘', loginUrl: 'https://pan.quark.cn/', domains: ['quark.cn', 'pan.quark.cn'] },
  yidong: { name: '移动云盘', loginUrl: 'https://yun.139.com/w/#/', domains: ['139.com', 'yun.139.com', 'user-njs.yun.139.com'] },
});

export function cloudLoginGuide(platform) {
  const key = String(platform).toLowerCase();
  const cloud = CLOUDS[key];
  if (!cloud) throw new Error(`不支持的网盘：${platform}`);
  return { platform: key, name: cloud.name, loginUrl: cloud.loginUrl, mode: 'official-browser', note: '在官方网页完成手机号与验证码，不代填验证码。' };
}

function browserCandidates() {
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
}

async function findBrowser(browserPath) {
  for (const candidate of browserPath ? [browserPath] : browserCandidates()) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error('未找到 Chrome 或 Edge；可以在 login 命令后传入浏览器完整路径');
}

function targetAllowed(platform, raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return CLOUDS[platform].domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

function cookieDomainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function cookieFor(platform, cookies) {
  const domains = CLOUDS[platform].domains;
  return cookies.filter((item) => {
    if (!item.value) return false;
    const host = String(item.domain).replace(/^\./, '').toLowerCase();
    if (!host) return false;
    return domains.some((domain) => cookieDomainMatches(host, domain));
  }).map((item) => `${item.name}=${item.value}`).join('; ');
}

function credentialPresent(platform, credential) {
  if (!credential || typeof credential !== 'object') return false;
  if (platform === 'pan123') return typeof credential.token === 'string' && Boolean(credential.token.trim());
  if (platform === 'yidong') return typeof credential.authorization === 'string' && Boolean(credential.authorization.trim());
  const names = new Set((credential.cookie || '').split(';').filter((item) => item.includes('=') && item.slice(item.indexOf('=') + 1).trim()).map((item) => item.trim().split('=')[0]));
  // 与 YunX-Desktop 对齐：百度只要有 BDUSS 即视为已登录（STOKEN/BDUSS_BFESS 是加分项但非必需）。
  if (platform === 'baidu') return names.has('BDUSS');
  if (platform === 'quark') return ['__pus', '__puus'].every((name) => names.has(name));
  return typeof credential.cookie === 'string' && Boolean(credential.cookie.trim());
}

export async function inspectCloudAccount(platform, credential, fetchImpl = fetch) {
  if (platform !== '115') cloudLoginGuide(platform);
  if (!credentialPresent(platform, credential)) return { verified: false, account: null };
  if (platform === 'yidong') return { verified: null, account: null };
  let url;
  let headers;
  if (platform === '115') {
    const names = new Set(credential.cookie.split(';').map((part) => part.trim().split('=')[0]));
    if (!names.has('UID') || !names.has('SEID')) return { verified: false, account: null };
    url = 'https://webapi.115.com/user/info?ct=json';
    headers = { Cookie: credential.cookie, 'User-Agent': USER_AGENT, Referer: 'https://115.com/', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/plain, */*' };
  } else if (platform === 'baidu') {
    // 与 YunX-Desktop 对齐：百度 BDUSS 通过 Cookie 携带，校验走 gettemplatevariable 的 username 字段。
    url = `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=${encodeURIComponent('["username"]')}`;
    headers = { Cookie: credential.cookie, 'User-Agent': USER_AGENT };
  } else if (platform === 'tianyi') {
    url = `https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action?noCache=${Date.now()}`;
    headers = { Cookie: credential.cookie, 'User-Agent': USER_AGENT };
  } else if (platform === 'pan123') {
    // 123 校验：Authorization: Bearer + Origin/Referer 头（实测 Cookie 方式会报 "cookie token is empty"）。
    // 端点 yun.123pan.cn/b/api/user/info，成功 code==0 且 data 非空。
    url = 'https://yun.123pan.cn/b/api/user/info';
    headers = {
      Authorization: `Bearer ${credential.token}`,
      platform: 'web',
      'app-version': '3',
      Origin: 'https://yun.123pan.cn',
      Referer: 'https://yun.123pan.cn/',
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
    };
  } else {
    url = 'https://pan.quark.cn/account/info?fr=pc&platform=pc';
    headers = { Cookie: credential.cookie, 'User-Agent': USER_AGENT };
  }
  try {
    const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { verified: false, account: null };
    const data = await response.json();
    const verified = platform === '115' ? data.state === true && Number(data.errno ?? data.errNo ?? 0) === 0 && hasCloudIdentity(data.data)
      : platform === 'baidu' ? Number(data.errno) === 0 && Boolean(data.result?.username)
      : platform === 'tianyi' ? Number(data.res_code) === 0
      : platform === 'pan123' ? Number(data.code) === 0 && Boolean(data.data)
      : data.code === 'OK';
    const identity = platform === 'baidu' ? data.result : data.data || data;
    return { verified, account: verified ? safeCloudIdentity(identity) : null };
  } catch { return { verified: false, account: null }; }
}

const IDENTITY_FIELDS = new Set(['id', 'userId', 'user_id', 'uid', 'sub', 'username', 'userName', 'user_name', 'name', 'nickname', 'nickName', 'Nickname', 'displayName']);
const CONTACT_FIELDS = new Set(['phone', 'phone_number', 'phoneNumber', 'mobile', 'mobilePhone', 'telephone', 'email', 'mail']);
const ACCOUNT_FIELDS = new Set([...IDENTITY_FIELDS, ...CONTACT_FIELDS,
  'vip', 'isVip', 'is_vip', 'vipType', 'vip_type', 'vipLevel', 'vip_level', 'member', 'isMember', 'memberType', 'member_type', 'memberLevel', 'member_level', 'membership',
  'expireTime', 'expire_time', 'expiryTime', 'expiresAt', 'vipExpireTime', 'vip_expire_time', 'vipExpire', 'vip_expire', 'vipEndTime', 'vip_end_time', 'memberExpireTime', 'member_expire_time',
  'total', 'used', 'free', 'totalSize', 'usedSize', 'freeSize', 'total_size', 'used_size', 'free_size', 'totalSpace', 'usedSpace', 'freeSpace', 'total_space', 'used_space', 'free_space', 'spaceTotal', 'spaceUsed', 'spaceFree', 'capacity', 'quota']);
const ACCOUNT_WRAPPERS = ['data', 'result', 'user', 'userInfo', 'userinfo', 'profile', 'vip', 'member', 'space'];

function accountScalar(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text) || /https?:\/\/|bearer\s|basic\s|(?:token|cookie|signature|authorization)\s*[=:]|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\./i.test(text)) return undefined;
  return text;
}

function maskedContact(value, email = false) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (email || text.includes('@')) {
    const match = text.match(/^([A-Za-z0-9.!#$%&'*+/=^_`{|}~-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/);
    return match && text.length <= 256 ? match[1][0] + '***@' + match[2] : undefined;
  }
  if (!/^[+\d* ()-]{5,32}$/.test(text)) return undefined;
  const compact = text.replace(/[ ()-]/g, '');
  return compact.replace(/.(?=.{4})/g, '*');
}

export function safeCloudIdentity(identity) {
  const account = {};
  const visited = new Set();
  function collect(source, depth) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || visited.has(source) || depth > 3 || visited.size >= 32) return;
    visited.add(source);
    for (const key of ACCOUNT_FIELDS) {
      const value = Object.getOwnPropertyDescriptor(source, key)?.value;
      let safe = CONTACT_FIELDS.has(key) ? maskedContact(value, key === 'email' || key === 'mail') : accountScalar(value);
      if (safe !== undefined && IDENTITY_FIELDS.has(key) && typeof safe === 'string') {
        if (safe.includes('@')) safe = maskedContact(safe, true);
        else if (/^\+?\d{10,15}$/.test(safe) && !['id', 'userId', 'user_id', 'uid', 'sub'].includes(key)) safe = maskedContact(safe);
      }
      if (safe !== undefined && account[key] === undefined) account[key] = safe;
    }
    for (const key of ACCOUNT_WRAPPERS) collect(Object.getOwnPropertyDescriptor(source, key)?.value, depth + 1);
  }
  collect(identity, 0);
  return Object.keys(account).length ? account : null;
}

export function hasCloudIdentity(identity) {
  const account = safeCloudIdentity(identity);
  return Boolean(account && [...IDENTITY_FIELDS, ...CONTACT_FIELDS].some((key) => {
    const value = account[key];
    return typeof value === 'string' && Boolean(value.trim()) || typeof value === 'number' && Number.isFinite(value) && value > 0;
  }));
}

export async function validateCloudCredential(platform, credential, fetchImpl = fetch) {
  return (await inspectCloudAccount(platform, credential, fetchImpl)).verified === true;
}

async function readCredentials() {
  try {
    const value = JSON.parse(await fs.readFile(STORAGE, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('账号状态文件损坏或无法读取');
  }
}

export async function saveCredential(platform, credential) {
  const current = await readCredentials();
  await fs.mkdir(path.dirname(STORAGE), { recursive: true });
  const temporary = `${STORAGE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ ...current, [platform]: credential }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, STORAGE);
  try { await fs.chmod(STORAGE, 0o600); } catch {}
  return { platform, saved: true };
}

export async function clearCredential(platform) {
  cloudLoginGuide(platform);
  const current = await readCredentials();
  delete current[platform];
  await fs.mkdir(path.dirname(STORAGE), { recursive: true });
  await fs.writeFile(STORAGE, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

export async function loadCloudCredential(platform) {
  cloudLoginGuide(platform);
  return (await readCredentials())[platform] || null;
}

function wsUrl(page, port) {
  const endpoint = new URL(page.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== LOOPBACK || endpoint.port !== String(port)
    || !/^\/devtools\/page\/[\w-]+$/.test(endpoint.pathname) || endpoint.username || endpoint.password) {
    throw new Error('CDP 页面不是本次 loopback 浏览器');
  }
  return endpoint.href;
}

async function attachPage(page, port, onEvent) {
  const socket = new WebSocket(wsUrl(page, port));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message || 'CDP 命令失败'));
      else handler.resolve(message.result);
    } else if (message.method) onEvent(message);
  });
  socket.addEventListener('close', () => {
    for (const handler of pending.values()) handler.reject(new Error('官网登录页已关闭'));
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('官网登录页已关闭')); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { id: page.id, send, close: () => socket.close() };
}

async function browserPort(profile) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const port = Number((await fs.readFile(file, 'utf8')).split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {}
    await delay(100);
  }
  throw new Error('浏览器未开启 loopback CDP；请确认 Chrome/Edge 可正常启动');
}

async function browserPages(port) {
  const response = await fetch(`http://${LOOPBACK}:${port}/json/list`);
  if (!response.ok) throw new Error(`无法读取官网登录页 HTTP ${response.status}`);
  return response.json();
}

function tokenFromUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && /(^|\.)123pan\.(com|cn)$/.test(url.hostname) && url.searchParams.has('token')) {
      return url.searchParams.get('token') || '';
    }
  } catch {}
  return '';
}

export async function readOfficialStorage(session, platform, expression) {
  const location = await session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  if (!targetAllowed(platform, location?.result?.value)) return null;
  const domains = JSON.stringify(CLOUDS[platform].domains);
  const guard = "location.protocol === 'https:' && !location.port && !location.username && !location.password && " + domains + ".some(domain => location.hostname === domain || location.hostname.endsWith('.' + domain))";
  const result = await session.send('Runtime.evaluate', { expression: '(' + guard + ') ? (' + expression + ') : null', returnByValue: true });
  return result?.result?.value ?? null;
}

async function tokenFromStorage(session) {
  const value = await readOfficialStorage(session, 'pan123', "localStorage.getItem('token') || localStorage.getItem('authorToken') || ''");
  return typeof value === 'string' ? value.trim() : '';
}

async function baiduKeysFromStorage(session) {
  const value = await readOfficialStorage(session, 'baidu', "JSON.stringify(Object.fromEntries(['BDUSS', 'STOKEN', 'BDUSS_BFESS'].map(key => [key, localStorage.getItem(key) || sessionStorage.getItem(key) || ''])))");
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

export function mobileLoginEvent(event, state) {
  const request = event.params?.request;
  if (event.method === 'Network.requestWillBeSent' && request?.method === 'POST'
    && /\/user\/getUser(?:\?|$)/.test(request.url || '')
    && targetAllowed('yidong', request.url)
    && /(^|\.)yun\.139\.com$/.test(new URL(request.url).hostname)) {
    state.requestId = event.params.requestId;
    state.responseId = '';
    state.authorization = request.headers?.Authorization || request.headers?.authorization || '';
    // 与 ODE 原版对齐：捕获到官方登录请求的 authorization 即视为登录成功，不依赖 getUser 响应体字段。
    state.ok = Boolean(state.authorization);
  }
  if (event.method === 'Network.requestWillBeSentExtraInfo' && event.params?.requestId === state.requestId) {
    state.authorization ||= event.params.headers?.Authorization || event.params.headers?.authorization || '';
    if (!state.ok) state.ok = Boolean(state.authorization);
  }
  if (event.method === 'Network.responseReceived' && event.params?.requestId === state.requestId) {
    state.responseId = event.params.response?.status === 200 ? state.requestId : '';
  }
}

async function stopBrowser(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  } else child.kill();
}

export async function loginWithBrowser(platform, { browserPath, timeoutMs = 300000, onStatus, fetchImpl = fetch, manualConfirm = null } = {}) {
  const cloud = cloudLoginGuide(platform);
  const name = ({ baidu: '百度', tianyi: '天翼', pan123: '123', quark: '夸克', yidong: '移动' })[platform] + '云盘';
  const executable = await findBrowser(browserPath);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-cloud-browser-'));
  let child;
  const sessions = new Map();
  const mobileState = { requestId: '', responseId: '', authorization: '', ok: false };
  let observedToken = '';
  let baiduStorageKeys = {};
  let lastFingerprint = '';
  let lastValidationAt = 0;
  let lastWarnedEmpty = 0;

  try {
    child = spawn(executable, [
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-address=${LOOPBACK}`, '--remote-debugging-port=0', 'about:blank',
    ], { windowsHide: false, stdio: 'ignore' });
    const port = await browserPort(profile);
    const opened = await fetch(`http://${LOOPBACK}:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!opened.ok) throw new Error(`无法打开官网登录页 HTTP ${opened.status}`);
    const initial = await opened.json();
    const onEvent = async (event, session) => {
      if (platform === 'yidong') {
        mobileLoginEvent(event, mobileState);
        // 与 ODE 原版对齐：登录成功以捕获到 authorization 为准，不再解析 getUser 响应体。
      }
      if (platform === 'pan123') {
        observedToken ||= tokenFromUrl(event.params?.request?.url);
        observedToken ||= tokenFromUrl(event.params?.frame?.url);
        observedToken ||= tokenFromUrl(event.params?.url);
      }
    };
    const first = await attachPage(initial, port, (event) => onEvent(event, first).catch(() => {}));
    sessions.set(first.id, first);
    await first.send('Page.enable');
    await first.send('Network.enable');
    await first.send('Page.navigate', { url: cloud.loginUrl });
    onStatus?.(`请在官方网页完成${name}手机号/验证码登录；程序会自动检测并保存。若自动检测不到，可输入 yes 回车手动确认（从浏览器 Cookie / localStorage / 跳转 URL 捞取）`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const manualYes = manualConfirm ? await Promise.resolve().then(() => manualConfirm()).catch(() => false) : false;
      if (manualYes) { observedToken = ''; baiduStorageKeys = {}; lastFingerprint = ''; lastValidationAt = 0; }
      const pages = await browserPages(port);
      for (const page of pages) {
        if (page.type !== 'page' || !page.webSocketDebuggerUrl || sessions.has(page.id) || !targetAllowed(platform, page.url)) continue;
        try {
          const session = await attachPage(page, port, (event) => onEvent(event, session).catch(() => {}));
          sessions.set(page.id, session);
          await session.send('Page.enable');
          await session.send('Network.enable');
          onStatus?.('检测到官网新窗口，继续等待登录结果…');
        } catch {}
      }
      for (const [id, session] of sessions) {
        if (!pages.some((page) => page.id === id)) { sessions.delete(id); session.close(); continue; }
        try {
          const location = await session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
          if (!targetAllowed(platform, location?.result?.value)) continue;
          if (platform === 'pan123') {
            observedToken ||= tokenFromUrl(location?.result?.value);
            if (!observedToken) observedToken = await tokenFromStorage(session).catch(() => '');
            const history = await session.send('Page.getNavigationHistory');
            for (const item of history.entries || []) observedToken ||= tokenFromUrl(item.url);
          }
          if (platform === 'baidu') {
            const fresh = await baiduKeysFromStorage(session).catch(() => ({}));
            if (fresh.BDUSS) baiduStorageKeys.BDUSS ||= fresh.BDUSS;
            if (fresh.STOKEN) baiduStorageKeys.STOKEN ||= fresh.STOKEN;
            if (fresh.BDUSS_BFESS) baiduStorageKeys.BDUSS_BFESS ||= fresh.BDUSS_BFESS;
          }
        } catch { sessions.delete(id); session.close(); }
      }
      const active = sessions.values().next().value;
      // 修复百度 bug：登录跳转到 passport.baidu.com 时主标签会短暂消失再回来，
      // 不要一发现 sessions 为空就抛「登录页已关闭」——给浏览器一个容错窗口。
      if (!active) {
        if (Date.now() - lastWarnedEmpty > 3000) {
          lastWarnedEmpty = Date.now();
          onStatus?.('登录窗口暂时消失（可能是登录跳转），等待恢复…');
        }
        await delay(500);
        continue;
      }
      const cookies = (await active.send('Network.getAllCookies')).cookies || [];
      if (platform === 'yidong') {
        if (mobileState.authorization && mobileState.ok) {
          const capturedAt = new Date().toISOString();
          const result = await saveCredential(platform, { authorization: mobileState.authorization, capturedAt });
          onStatus?.(`已检测到${name}会话；本平台暂不提供官方账号校验，登录状态已保存在本机${STORAGE}。`);
          return { ...result, verified: null, capturedAt };
        }
      } else {
        let cookieStr = cookieFor(platform, cookies);
        if (platform === 'baidu' && baiduStorageKeys.BDUSS && !cookieStr.includes('BDUSS=')) {
          const extra = Object.entries(baiduStorageKeys).map(([k, v]) => `${k}=${v}`).join('; ');
          cookieStr = `${cookieStr}; ${extra}`.replace(/^;\s*/, '');
        }
        const credential = { cookie: cookieStr, token: observedToken, capturedAt: new Date().toISOString() };
        if (credentialPresent(platform, credential)) {
          const fingerprint = `${credential.cookie}|${credential.token}`;
          if (fingerprint !== lastFingerprint || Date.now() - lastValidationAt > 5000) {
            lastFingerprint = fingerprint;
            lastValidationAt = Date.now();
            onStatus?.(`已检测到${name}会话，正在校验官方账号接口…`);
            if (await validateCloudCredential(platform, credential, fetchImpl)) {
              const result = await saveCredential(platform, credential);
              onStatus?.(`官方账号校验通过，登录状态已保存在本机${STORAGE}。`);
              return { ...result, verified: true, capturedAt: credential.capturedAt };
            }
          }
        }
      }
      await delay(1000);
    }
    throw new Error(`${cloud.name} 登录等待超时；请检查官网是否已登录，再重新运行 login 命令`);
  } finally {
    for (const session of sessions.values()) { try { session.close(); } catch {} }
    await stopBrowser(child);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await fs.rm(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw new Error(`浏览器临时数据删除失败：${profile}`, { cause: error }); await delay(200); }
    }
  }
}

export const loginCloud = loginWithBrowser;
