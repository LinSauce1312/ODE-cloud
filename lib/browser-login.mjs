import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { saveCredential, loadCloudCredential as loadAdapterCredential, clearCredential, inspectCloudAccount } from '../src/cloud-login.mjs';

const LOOPBACK = '127.0.0.1';
const PLATFORM = Object.freeze({ QUARK: 'quark', PAN115: '115' });
const TARGETS = Object.freeze({
  quark: { url: 'https://pan.quark.cn/', domains: ['pan.quark.cn'], names: ['__pus', '__puus'], required: ['__pus', '__puus'] },
  '115': { url: 'https://115.com/', domains: ['115.com', '115cdn.com'], names: ['UID', 'CID', 'SEID', 'KID', 'PHPSESSID', 'GST', 'USERSESSIONID'], required: ['UID', 'SEID'] },
});
import { DATA_DIR } from './paths.mjs';
const STORAGE_DIR = DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'cloud-credentials.json');

function targetFor(platform) {
  const key = String(platform).toLowerCase();
  if (!TARGETS[key]) throw new Error(`不支持的云盘平台：${platform}`);
  return { key, ...TARGETS[key] };
}

function cookiePairs(cookies, domains) {
  const list = Array.isArray(cookies) ? cookies : String(cookies || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index > 0 ? { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() } : null;
  }).filter(Boolean);
  const result = new Map();
  for (const cookie of list) {
    if (cookie?.domain !== undefined && !domains.includes(String(cookie.domain).replace(/^\./, ''))) continue;
    if (cookie?.name && cookie.value !== undefined && cookie.value !== '') result.set(String(cookie.name), String(cookie.value));
  }
  return result;
}

/** Only returns credentials for the requested platform and its explicit allowlist. */
export function filterCloudCookies(platform, cookies) {
  const target = targetFor(platform);
  const source = cookiePairs(cookies, target.domains);
  const selected = (target.key === 'quark' ? [...source.keys()] : target.names.filter((name) => source.has(name)))
    .map((name) => `${name}=${source.get(name)}`);
  if (!target.required.every((name) => source.has(name))) return '';
  return selected.join('; ');
}

export function hasCloudLogin(platform, cookie) {
  return Boolean(filterCloudCookies(platform, cookie));
}

export function credentialStoragePath(platform) { return platform === 'quark' ? path.join(STORAGE_DIR, 'adapter-credentials.json') : STORAGE_FILE; }

async function readCredentials() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORAGE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('云盘登录凭据文件损坏或无法读取');
  }
}

/** Stores only the validated platform cookie; legacy environment variables are never consulted. */
export async function saveCloudCredential(platform, cookie) {
  const capturedAt = new Date().toISOString();
  const { key } = targetFor(platform);
  const filtered = filterCloudCookies(key, cookie);
  if (!filtered) throw new Error(`${key} Cookie 缺少登录所需字段`);
  if (key === 'quark') {
    await saveCredential(key, { cookie: filtered, capturedAt });
    return filtered;
  }
  const current = await readCredentials();
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const temporary = `${STORAGE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ ...current, [key]: { cookie: filtered, capturedAt } }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, STORAGE_FILE);
  try { await fs.chmod(STORAGE_FILE, 0o600); } catch {}
  return filtered;
}

export async function loadCloudCredentialRecord(platform) {
  const { key } = targetFor(platform);
  const value = key === 'quark' ? await loadAdapterCredential(key) : (await readCredentials())[key];
  return normalizeCloudCredentialRecord(key, value);
}

export function normalizeCloudCredentialRecord(platform, value) {
  return {
    cookie: filterCloudCookies(platform, typeof value === 'string' ? value : value?.cookie || ''),
    capturedAt: typeof value?.capturedAt === 'string' ? value.capturedAt : null,
  };
}

export async function loadCloudCredential(platform) {
  return (await loadCloudCredentialRecord(platform)).cookie;
}

export async function clearCloudCredential(platform) {
  const { key } = targetFor(platform);
  if (key === 'quark') return clearCredential(key);
  const current = await readCredentials();
  delete current[key];
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.writeFile(STORAGE_FILE, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try { await fs.chmod(STORAGE_FILE, 0o600); } catch {}
}

function browserCandidates() {
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
}

async function findBrowser(browserPath) {
  const candidates = browserPath ? [browserPath] : browserCandidates();
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error('未找到 Chrome 或 Edge；请传入 browserPath（例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe）');
}

async function waitForPort(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const lines = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {}
    await delay(100);
  }
  throw new Error('浏览器未在 loopback 上开启 CDP');
}

export function assertLoopbackWebSocketUrl(raw, port) {
  let endpoint;
  try { endpoint = new URL(raw); } catch { throw new Error('CDP 返回了无效的 WebSocket 地址'); }
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== LOOPBACK || endpoint.port !== String(port)
    || !/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(endpoint.pathname) || endpoint.username || endpoint.password) {
    throw new Error('CDP WebSocket 地址不是当前 loopback 浏览器');
  }
  return endpoint.href;
}

async function cdpSession(port, targetUrl) {
  const response = await fetch(`http://${LOOPBACK}:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`无法创建浏览器登录页（HTTP ${response.status}）`);
  const target = await response.json();
  const socket = new WebSocket(assertLoopbackWebSocketUrl(target.webSocketDebuggerUrl, port));
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP 命令失败')); else resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const commandId = ++id; pending.set(commandId, { resolve, reject }); socket.send(JSON.stringify({ id: commandId, method, params }));
  });
  return { send, close: () => socket.close() };
}

async function stopBrowser(child) {
  if (!child || !child.pid) return;
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
      if (attempt === 4) throw new Error('浏览器临时 profile 删除失败，请手动检查临时目录', { cause: error });
      await delay(200 * (attempt + 1));
    }
  }
}

/** Opens an isolated Chrome/Edge profile, waits for the user to finish official web login, then reads only target-origin cookies. */
export async function loginWithBrowser(platform, { browserPath, timeoutMs = 5 * 60_000, onStatus, manualConfirm = null, verifyCredential = null, fetchImpl = fetch } = {}) {
  const target = targetFor(platform);
  const name = (target.key === 'quark' ? '夸克' : '115') + '云盘';
  const executable = await findBrowser(browserPath);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-cloud-browser-'));
  let child;
  let session;
  try {
    child = spawn(executable, [
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-address=${LOOPBACK}`, '--remote-debugging-port=0', target.url,
    ], { windowsHide: false, stdio: 'ignore' });
    const port = await waitForPort(path.join(profile, 'DevToolsActivePort'), Math.min(timeoutMs, 30_000));
    session = await cdpSession(port, target.url);
    onStatus?.(`请在官方网页完成${name}手机号/验证码登录；程序会自动检测并保存。若自动检测不到，可输入 yes 回车手动确认（从浏览器 Cookie / localStorage / 跳转 URL 捞取）`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (manualConfirm) await Promise.resolve().then(() => manualConfirm()).catch(() => false);
      const result = await session.send('Network.getCookies', { urls: target.domains.map((domain) => `https://${domain}/`) });
      const cookie = filterCloudCookies(target.key, result.cookies.filter((item) => target.domains.includes(String(item.domain).replace(/^\./, ''))));
      if (cookie) {
        onStatus?.(`已检测到${name}会话，正在校验官方账号接口…`);
        const inspection = verifyCredential
          ? await verifyCredential({ cookie }, target.key)
          : await inspectCloudAccount(target.key, { cookie }, fetchImpl);
        const verified = inspection === true || inspection?.verified === true ? true
          : inspection === false || inspection?.verified === false ? false : null;
        if (verified !== true) { await delay(1000); continue; }
        await saveCloudCredential(target.key, cookie);
        const record = await loadCloudCredentialRecord(target.key);
        onStatus?.(`官方账号校验通过，登录状态已保存在本机${credentialStoragePath(target.key)}。`);
        return { platform: target.key, saved: true, verified, capturedAt: record.capturedAt };
      }
      await delay(1000);
    }
    throw new Error(`${target.key} 登录等待超时`);
  } finally {
    try { session?.close(); } catch {}
    await stopBrowser(child);
    await removeProfile(profile);
  }
}

export { PLATFORM, TARGETS };
