import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { XunleiAuth } from './auth.mjs';
import { CRED_FILE } from './config.mjs';

const LOOPBACK = '127.0.0.1';
const LOGIN_URL = 'https://pan.xunlei.com/';
const TOKEN_KEYS = { access: ['access_token', 'accessToken'], refresh: ['refresh_token', 'refreshToken'] };

export function isOfficialXunleiUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'xunlei.com' || url.hostname.endsWith('.xunlei.com'));
  } catch { return false; }
}

export function isOfficialXunleiAuthResponse(raw) {
  return isOfficialXunleiUrl(raw) && /\/auth\/(?:signin|token|login)(?:[/?]|$)/i.test(new URL(raw).pathname);
}

function tokenPair(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const accessToken = TOKEN_KEYS.access.map((key) => candidate[key]).find((value) => typeof value === 'string' && value.trim());
  const refreshToken = TOKEN_KEYS.refresh.map((key) => candidate[key]).find((value) => typeof value === 'string' && value.trim());
  if (!accessToken || !refreshToken) return null;
  const expiresIn = Number(candidate.expires_in ?? candidate.expiresIn);
  return { accessToken, refreshToken, ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}) };
}

export function extractXunleiTokens(value) {
  const visited = new Set();
  const visit = (candidate, depth) => {
    if (depth > 8 || candidate == null) return null;
    if (typeof candidate === 'string') {
      try { return visit(JSON.parse(candidate), depth + 1); } catch { return null; }
    }
    if (typeof candidate !== 'object' || visited.has(candidate)) return null;
    visited.add(candidate);
    const pair = tokenPair(candidate);
    if (pair) return pair;
    for (const nested of Object.values(candidate)) {
      const found = visit(nested, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(value, 0);
}

export async function validateWebTokens(tokens, auth) {
  auth ??= await XunleiAuth.load();
  const pair = extractXunleiTokens(tokens);
  if (!pair) throw new Error('官网登录未同时提供 accessToken 和 refreshToken');
  const candidate = new XunleiAuth({ ...auth.cred, ...pair, expiresAt: Date.now() + 7200 * 1000 });
  candidate.refresh = async () => { throw new Error('账号校验失败'); };
  candidate.request = async (url, options = {}) => {
    if (!isOfficialXunleiUrl(url)) throw new Error('账号校验地址不可信');
    const response = await fetch(url, { ...options, headers: candidate.headers({ Authorization: 'Bearer ' + pair.accessToken }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('账号校验失败');
    const account = await response.json();
    if (account.error_code != null && Number(account.error_code) !== 0) throw new Error('账号校验失败');
    return account;
  };
  let account;
  try {
    account = await candidate.me();
    if (!account || typeof account !== 'object' || ![account, account.data, account.user].some((item) =>
      item && ['user_id', 'userId', 'id', 'sub', 'name', 'user_name', 'nickname', 'phone_number'].some((key) => item[key] != null && String(item[key]).trim()))) {
      throw new Error('账号响应缺少用户身份');
    }
  } catch {
    throw new Error('官网令牌未通过账号校验，未保存凭据');
  }
  const identity = [account, account.data, account.user].find((item) => item && (item.user_id != null || item.userId != null || item.id != null || item.sub != null));
  const previous = auth.cred;
  auth.cred = { ...candidate.cred, userId: String(identity?.user_id ?? identity?.userId ?? identity?.id ?? identity?.sub ?? ''), expiresAt: Date.now() + (pair.expiresIn || 7200) * 1000, capturedAt: new Date().toISOString() };
  try { await auth.save(); }
  catch (error) { auth.cred = previous; throw error; }
  auth.verified = true;
  return auth;
}

function browserCandidates() {
  const programs = process.env.PROGRAMFILES || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(programs, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programs, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
}

async function findBrowser(browserPath) {
  for (const candidate of browserPath ? [browserPath] : browserCandidates()) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error('未找到 Chrome/Edge，请指定 browserPath');
}

async function waitForPort(profile, timeoutMs, child, getLaunchError) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (getLaunchError()) throw new Error('无法启动 Chrome/Edge', { cause: getLaunchError() });
    if (child.exitCode !== null) throw new Error('浏览器提前退出');
    try {
      const port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {}
    await delay(100);
  }
  throw new Error('浏览器未在本地开启 CDP');
}

function safeSocket(raw, port) {
  const url = new URL(raw);
  if (url.protocol !== 'ws:' || url.hostname !== LOOPBACK || url.port !== String(port)
    || url.username || url.password || !/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(url.pathname)) {
    throw new Error('CDP 目标不是当前本地浏览器');
  }
  return url.href;
}

async function connect(raw, port, onResponse) {
  const socket = new WebSocket(safeSocket(raw, port));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error('浏览器 CDP 请求失败'));
      else request.resolve(message.result);
    } else if (message.method === 'Network.loadingFinished') onResponse?.(message.params.requestId, send);
    else if (message.method === 'Network.responseReceived') onResponse?.(message.params.requestId, send, message.params.response?.url, message.params.response?.status);
  });
  return { send, close: () => { socket.close(); for (const request of pending.values()) request.reject(new Error('浏览器连接关闭')); pending.clear(); } };
}

async function stopBrowser(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  }
  if (child.exitCode === null) child.kill();
}

async function removeProfile(profile) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await fs.rm(profile, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4) throw new Error('临时浏览器资料删除失败，请检查临时目录', { cause: error });
      await delay(200 * (attempt + 1));
    }
  }
}

export async function captureXunleiPageTokens(session) {
  const location = await session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  if (!isOfficialXunleiUrl(location?.result?.value)) return null;
  const evaluation = await session.send('Runtime.evaluate', {
    expression: "(location.protocol === 'https:' && !location.port && !location.username && !location.password && (location.hostname === 'xunlei.com' || location.hostname.endsWith('.xunlei.com'))) ? JSON.stringify({origin: location.origin, url: location.href, local: Object.values(localStorage), session: Object.values(sessionStorage), cookie: document.cookie}) : null",
    returnByValue: true,
  });
  const storage = JSON.parse(evaluation.result?.value || '{}');
  if (!isOfficialXunleiUrl(storage.origin) || !isOfficialXunleiUrl(storage.url)) return null;
  const direct = extractXunleiTokens(storage);
  if (direct) return direct;
  const parameters = Object.fromEntries(new URL(storage.url).searchParams);
  const urlTokens = extractXunleiTokens(parameters);
  if (urlTokens) return urlTokens;
  const cookies = {};
  for (const part of String(storage.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return extractXunleiTokens(cookies);
}

export async function loginXunleiWithBrowser(auth, { browserPath, timeoutMs = 5 * 60_000, onStatus, manualConfirm = null } = {}) {
  if (!(auth instanceof XunleiAuth)) throw new Error('需要 XunleiAuth 实例');
  const executable = await findBrowser(browserPath);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-cloud-xunlei-login-'));
  let child;
  let launchError;
  const sessions = new Map();
  const candidates = [];
  const responseUrls = new Map();
  const responseIds = new Set();
  try {
    child = spawn(executable, [
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-address=${LOOPBACK}`, '--remote-debugging-port=0', LOGIN_URL,
    ], { stdio: 'ignore', windowsHide: false });
    child.once('error', (error) => { launchError = error; });
    const port = await waitForPort(profile, Math.min(timeoutMs, 30_000), child, () => launchError);
    const onResponse = (requestId, send, url, status) => {
      if (url) {
        if (status >= 200 && status < 300 && isOfficialXunleiAuthResponse(url)) responseUrls.set(requestId, url);
      } else if (responseUrls.has(requestId) && !responseIds.has(requestId)) {
        responseIds.add(requestId);
        responseUrls.delete(requestId);
        send('Network.getResponseBody', { requestId }).then((response) => {
          if (!response.base64Encoded) {
            const tokens = extractXunleiTokens(response.body);
            if (tokens) candidates.push(tokens);
          }
        }).catch(() => {});
      }
    };
    onStatus?.('请在官方网页完成迅雷云盘手机号/验证码登录；程序会自动检测并保存。若自动检测不到，可输入 yes 回车手动确认（从浏览器 Cookie / localStorage / 跳转 URL 捞取）');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('浏览器提前退出');
      if (manualConfirm) await Promise.resolve().then(() => manualConfirm()).catch(() => false);
      const response = await fetch(`http://${LOOPBACK}:${port}/json/list`);
      if (!response.ok) throw new Error('无法读取本地浏览器页面');
      const targets = await response.json();
      for (const target of targets) {
        if (target.type !== 'page' || !isOfficialXunleiUrl(target.url) || sessions.has(target.id)) continue;
        const session = await connect(target.webSocketDebuggerUrl, port, onResponse);
        sessions.set(target.id, session);
        await session.send('Network.enable');
      }
      for (const [id, session] of sessions) {
        const target = targets.find((entry) => entry.id === id);
        if (!target || !isOfficialXunleiUrl(target.url)) continue;
        try {
          const tokens = await captureXunleiPageTokens(session);
          if (tokens) candidates.push(tokens);
        } catch {}
      }
      while (candidates.length) {
        const candidate = candidates.shift();
        try {
          onStatus?.('已检测到迅雷云盘会话，正在校验官方账号接口…');
          const result = await validateWebTokens(candidate, auth);
          onStatus?.('官方账号校验通过，登录状态已保存在本机' + CRED_FILE + '。');
          return result;
        }
        catch (error) { if (error.message !== '官网令牌未通过账号校验，未保存凭据') throw error; }
      }
      await delay(1000);
    }
    throw new Error('等待迅雷官方网页登录超时；未获取通过校验的令牌');
  } finally {
    for (const session of sessions.values()) { try { session.close(); } catch {} }
    try { await stopBrowser(child); } finally { await removeProfile(profile); }
  }
}
