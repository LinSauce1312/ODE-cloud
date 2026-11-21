#!/usr/bin/env node
/**
 * ODE-cloud Web UI server
 * -----------------------
 * A zero-dependency, localhost-only HTTP wrapper around the existing ODE-cloud
 * services. The CLI remains the source of truth: this server imports the same
 * modules (login, share parsing, link export and download pipelines) instead of
 * re-implementing provider logic.
 *
 * Security model:
 * - binds to 127.0.0.1 only;
 * - rejects foreign Host / Origin headers (DNS rebinding + CSRF defence);
 * - only serves files below ui/public (path traversal guard);
 * - accepts JSON bodies only, with a bounded size;
 * - never prints credentials or download links to the console.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { PLATFORMS } from '../src/cli-args.mjs';
import { createServices, prepareShare } from '../src/cli-runtime.mjs';
import { XunleiAuth } from '../lib/auth.mjs';
import { fileInfo } from '../lib/download-progress.mjs';
import { renderExport } from '../lib/export-format.mjs';
import { loginXunleiWithBrowser } from '../lib/web-login.mjs';
import { loginWithBrowser } from '../lib/browser-login.mjs';
import { loginCloud, hasCloudIdentity } from '../src/cloud-login.mjs';
import { HOME } from '../lib/config.mjs';
import { installSdkFromUrl } from '../urlsdk.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(HERE, 'public');
const DEFAULT_PORT = 8787;
const MAX_BODY = 1.5 * 1024 * 1024;
const MAX_JOBS = 48;
const MAX_ACTIVE_DOWNLOADS = 2;
const JOB_TTL_MS = 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const META = Object.freeze({
  xunlei: { id: 'xunlei', name: '迅雷云盘', short: '迅雷', color: '#4f8cff', login: true, sms: true, share: true, link: true, download: true, note: 'HTTP 多并发；可选本地 SDK' },
  quark: { id: 'quark', name: '夸克网盘', short: '夸克', color: '#6c7cff', login: true, sms: false, share: true, link: true, download: true, note: '官网浏览器登录后 HTTP 下载' },
  pan123: { id: 'pan123', name: '123 网盘', short: '123', color: '#2dd4bf', login: true, sms: false, share: true, link: true, download: true, note: '支持官方账号校验' },
  tianyi: { id: 'tianyi', name: '天翼云盘', short: '天翼', color: '#38bdf8', login: true, sms: false, share: true, link: true, download: true, note: '官网浏览器登录后 HTTP 下载' },
  yidong: { id: 'yidong', name: '移动云盘', short: '移动', color: '#a78bfa', login: true, sms: false, share: true, link: true, download: true, note: '仅保存捕获会话，无独立账号校验' },
  baidu: { id: 'baidu', name: '百度网盘', short: '百度', color: '#fb7185', login: true, sms: false, share: true, link: false, download: false, note: '仅支持分享文件列表，不转存、不下载' },
  '115': { id: '115', name: '115 网盘', short: '115', color: '#60a5fa', login: true, sms: false, share: true, link: true, download: true, note: '官方账号接口校验' },
  uc: { id: 'uc', name: 'UC 网盘', short: 'UC', color: '#fbbf24', login: false, sms: false, share: true, link: true, download: true, guest: true, note: '游客分享，无需登录；受官方游客限制' },
  guangya: { id: 'guangya', name: '光鸭网盘', short: '光鸭', color: '#f472b6', login: false, sms: false, share: true, link: true, download: true, guest: true, note: '公开分享接口，无需登录；分享者需开启免登录' },
});

const OUTPUT_DIR = path.resolve(process.env.ODE_UI_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'ODE-cloud'));
const DEFAULT_SDK_DIR = path.resolve(process.env.ODE_CLOUD_SDK_DIR || path.join(PROJECT_ROOT, 'native', 'win32-x64'));
const UI_SETTINGS_FILE = path.join(HOME, 'ui-settings.json');
const SDK_FILES = ['download.node', 'xl_thunder_sdk.dll'];
const services = createServices();

/** SDK 目录属于本机服务配置，保存后重启仍然生效；其他交互偏好仍只存浏览器。 */
let sdkDir = DEFAULT_SDK_DIR;

let actualPort = DEFAULT_PORT;
let activeDownloads = 0;
let shuttingDown = false;
const jobs = new Map();
const smsSessions = new Map();

/* -------------------------------------------------------------------------- */
/* small utilities                                                            */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

/** 用户输入/参数错误统一标记为 400，避免把所有校验失败都当成服务器故障。 */
function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw badRequest(`数值必须是 ${min}..${max} 的整数`);
  return number;
}

/** 解析用户粘贴的分享内容；只把解析器抛出的错误归为 400。 */
function prepareShareInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('请粘贴网盘分享链接或分享文案');
  if (raw.length > 20_000) throw badRequest('分享文案过长');
  try {
    return prepareShare(raw);
  } catch (error) {
    throw badRequest(safeError(error));
  }
}

/** Remove links and token query values from text that may reach a browser. */
function redact(value) {
  let text = String(value ?? '');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]');
  text = text.replace(/([?&](?:token|sign|signature|auth|authorization|key|pwd|password|secret|sekey|bdstoken|randsk|access_token|refresh_token)=)[^&\s"'<>]*/gi, '$1[已隐藏]');
  return text.trim().slice(0, 3000);
}

function safeError(error, fallback = '操作失败') {
  const message = redact(error?.message || '');
  return message || fallback;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || '操作超时')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, message, code) {
  json(res, status, { ok: false, error: { code: code || 'request_failed', message: safeError(message) } });
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    const error = new Error('请求必须使用 application/json');
    error.status = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('请求体过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON 格式无效');
    error.status = 400;
    throw error;
  }
}

function normalizePlatform(value) {
  const key = String(value || '').toLowerCase();
  if (!Object.hasOwn(META, key)) throw badRequest('未知平台');
  return key;
}

function loginPlatform(value) {
  const key = normalizePlatform(value);
  if (!META[key].login) throw badRequest('该平台不需要登录');
  return key;
}

function resolveTarget(raw, { direct = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest(direct ? '请填写目标文件路径' : '请填写下载目录');
  if (raw.length > 4096 || /[\x00-\x1f]/.test(raw)) throw badRequest('路径格式无效');
  const expanded = raw.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  if (direct && (/[\\/]$/.test(expanded) || ['.', '..'].includes(path.basename(resolved)))) {
    throw badRequest('直链目标必须包含文件名');
  }
  return resolved;
}

async function ensureDirectory(target) {
  await fs.mkdir(target, { recursive: true });
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw badRequest('下载目录不是文件夹');
}

async function ensureFileParent(target) {
  const stat = await fs.stat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isDirectory()) throw badRequest('直链目标必须是文件名，不能是目录');
  await fs.mkdir(path.dirname(target), { recursive: true });
}

/* -------------------------------------------------------------------------- */
/* SDK 本机配置与文件夹选择                                                   */
/* -------------------------------------------------------------------------- */

/** 读取此前保存的 UI 本机配置；环境变量优先，避免覆盖部署者的显式设置。 */
async function loadUiSettings() {
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(UI_SETTINGS_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`读取 UI 设置失败：${safeError(error)}`);
  }
  if (!process.env.ODE_CLOUD_SDK_DIR && typeof data.sdkDir === 'string' && data.sdkDir.trim()) {
    sdkDir = path.resolve(data.sdkDir.trim());
  }
  process.env.ODE_CLOUD_SDK_DIR = sdkDir;
}

/** 合并写入本机 UI 配置；只保存非敏感的目录设置。 */
async function saveUiSettings(patch) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(UI_SETTINGS_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = { ...current, ...patch };
  await fs.mkdir(HOME, { recursive: true });
  const temporary = `${UI_SETTINGS_FILE}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, UI_SETTINGS_FILE);
}

/** 只检查组件文件是否存在；是否能被当前 Node ABI 加载要等真正下载时验证。 */
async function sdkStatus() {
  let available = false;
  try {
    await Promise.all(SDK_FILES.map((file) => fs.access(path.join(sdkDir, file))));
    available = true;
  } catch {
    available = false;
  }
  return {
    dir: sdkDir,
    defaultDir: DEFAULT_SDK_DIR,
    available,
    supported: process.platform === 'win32' && process.arch === 'x64',
    platform: process.platform,
    arch: process.arch,
    files: SDK_FILES,
  };
}

async function setSdkDir(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('请选择 SDK 组件目录');
  if (raw.length > 4096) throw badRequest('SDK 组件目录过长');
  const target = path.resolve(raw.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
  const stat = await fs.stat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isDirectory()) throw badRequest('SDK 组件目录不存在或不是文件夹');
  await saveUiSettings({ sdkDir: target });
  sdkDir = target;
  process.env.ODE_CLOUD_SDK_DIR = target;
  return sdkStatus();
}

/** 通过 urlsdk.mjs 下载并校验 SDK 组件，成功后把安装目录设为当前 SDK 目录。 */
async function installSdkComponents(rawUrl, rawTarget) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw badRequest('请填写 SDK 下载地址');
  if (rawUrl.length > 4096) throw badRequest('SDK 下载地址过长');
  let source;
  try {
    source = new URL(rawUrl.trim());
  } catch {
    throw badRequest('请输入有效的 HTTPS 下载地址');
  }
  if (source.protocol !== 'https:' || source.username || source.password) {
    throw badRequest('仅支持不含账号密码的 HTTPS 下载地址');
  }
  const target = path.resolve(rawTarget && String(rawTarget).trim() ? String(rawTarget).trim() : sdkDir);
  if (target.length > 4096) throw badRequest('SDK 安装目录过长');
  const stat = await fs.stat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isDirectory()) throw badRequest('SDK 安装路径不是文件夹');
  try {
    const installed = await installSdkFromUrl(source.href, { directory: target });
    await saveUiSettings({ sdkDir: target });
    sdkDir = target;
    process.env.ODE_CLOUD_SDK_DIR = target;
    return { installed, sdk: await sdkStatus() };
  } catch (error) {
    if (error?.status) throw error;
    throw badRequest(error?.message || 'SDK 下载失败');
  }
}

function runProcess(command, args, { env = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('选择文件夹超时，请手动输入路径'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else if (code === 1 && !stdout.trim()) resolve('');
      else reject(new Error((stderr.trim() || `文件夹选择器退出码 ${code}`).slice(0, 500)));
    });
  });
}

/** 在服务端所在机器弹出系统文件夹选择器；浏览器无法直接取得真实绝对路径。 */
async function chooseFolder(initial = '') {
  const start = typeof initial === 'string' && initial.trim()
    ? path.resolve(initial.trim().replace(/^~(?=$|[\\/])/, os.homedir()))
    : '';
  if (start.length > 4096) throw badRequest('初始目录过长');
  if (process.platform === 'win32') {
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '选择 ODE-cloud 文件夹'",
      '$d.ShowNewFolderButton = $true',
      'if ($env:ODE_PICK_INITIAL) { $d.SelectedPath = $env:ODE_PICK_INITIAL }',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    const selected = await runProcess('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      env: { ODE_PICK_INITIAL: start },
    });
    return selected ? path.resolve(selected) : '';
  }
  if (process.platform === 'darwin') {
    const selected = await runProcess('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择 ODE-cloud 文件夹")']);
    return selected ? path.resolve(selected) : '';
  }
  const args = ['--file-selection', '--directory', '--title=选择 ODE-cloud 文件夹'];
  if (start) args.push(`--filename=${start.replace(/[\\/]+$/, '')}/`);
  const selected = await runProcess('zenity', args);
  return selected ? path.resolve(selected) : '';
}

/* -------------------------------------------------------------------------- */
/* job store                                                                  */
/* -------------------------------------------------------------------------- */

function createJob(kind, label, extra = {}) {
  pruneJobs();
  const job = {
    id: randomUUID(),
    kind,
    label,
    state: 'running',
    status: '正在启动…',
    progress: null,
    result: null,
    error: null,
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    confirmable: false,
    confirm: null,
    ...extra,
  };
  jobs.set(job.id, job);
  return job;
}

function pruneJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.state === 'running') continue;
    if (Date.parse(job.updatedAt) < cutoff) jobs.delete(id);
  }
  if (jobs.size >= MAX_JOBS) {
    const finished = [...jobs.values()].filter((job) => job.state !== 'running').sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    while (jobs.size >= MAX_JOBS && finished.length) jobs.delete(finished.shift().id);
  }
}

function addEvent(job, message, type = 'info') {
  const text = safeError(message, '状态更新');
  job.status = text;
  job.updatedAt = nowIso();
  job.events.push({ at: job.updatedAt, type, message: text });
  if (job.events.length > 80) job.events.splice(0, job.events.length - 80);
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    state: job.state,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    events: job.events.slice(-30),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    confirmable: job.confirmable,
    platform: job.platform || null,
  };
}

function finishJob(job, result) {
  job.state = 'succeeded';
  job.result = result;
  job.status = '已完成';
  job.updatedAt = nowIso();
  job.progress = job.progress ? { ...job.progress, percent: job.progress.percent ?? 100 } : null;
  job.events.push({ at: job.updatedAt, type: 'success', message: '任务完成' });
}

function failJob(job, error, fallback = '任务失败') {
  job.state = 'failed';
  job.error = safeError(error, fallback);
  job.status = job.error;
  job.updatedAt = nowIso();
  job.events.push({ at: job.updatedAt, type: 'error', message: job.error });
}

function applyProgress(job, state) {
  const total = Number.isFinite(state.batchTotal) && state.batchTotal > 0 ? state.batchTotal : null;
  const received = Number.isFinite(state.batchReceived) && state.batchReceived >= 0 ? state.batchReceived : 0;
  const percent = total ? Math.min(100, Math.round((received / total) * 1000) / 10) : null;
  job.progress = {
    event: state.event,
    platform: state.platform,
    engine: state.engine,
    name: state.name || '',
    index: state.index || 0,
    count: state.count || 0,
    received,
    total,
    speed: Number.isFinite(state.speed) ? state.speed : 0,
    percent,
    batchReceived: received,
    batchTotal: total,
  };
  job.updatedAt = nowIso();
  if (state.event === 'failed') addEvent(job, `文件失败：${state.name || '未知文件'}`, 'error');
  else if (state.event === 'done') addEvent(job, `文件完成：${state.name || '未知文件'}`, 'success');
  else if (state.event === 'skip') addEvent(job, `已跳过：${state.name || '未知文件'}`, 'info');
}

/* -------------------------------------------------------------------------- */
/* account / login helpers                                                    */
/* -------------------------------------------------------------------------- */

async function accountStatus(platform) {
  return withTimeout(services.whoami(platform), 25_000, '账号校验超时');
}

function accountError(platform, error) {
  return {
    platform,
    saved: null,
    verified: null,
    capturedAt: null,
    account: null,
    error: safeError(error, '账号状态读取失败'),
  };
}

async function allAccounts() {
  const rows = await Promise.all(PLATFORMS.map(async (platform) => {
    try { return await accountStatus(platform); }
    catch (error) { return accountError(platform, error); }
  }));
  return { accounts: rows, checkedAt: nowIso() };
}

function startBrowserLogin(platform) {
  const meta = META[platform];
  if ([...jobs.values()].some((job) => job.kind === 'login' && job.platform === platform && job.state === 'running')) {
    const error = new Error(`${meta.name} 正在登录，请先完成当前登录窗口`);
    error.status = 409;
    throw error;
  }
  const job = createJob('login', `登录 · ${meta.name}`, { platform, confirmable: true });
  let confirmRequested = false;
  job.confirm = () => {
    confirmRequested = true;
    addEvent(job, '已请求重新检测浏览器会话…');
  };
  const manualConfirm = async () => {
    if (!confirmRequested) return false;
    confirmRequested = false;
    return true;
  };
  const onStatus = (message) => addEvent(job, message);
  (async () => {
    try {
      if (platform === 'xunlei') {
        const auth = await XunleiAuth.load();
        await loginXunleiWithBrowser(auth, { timeoutMs: LOGIN_TIMEOUT_MS, onStatus, manualConfirm });
      } else if (platform === '115') {
        await loginWithBrowser(platform, { timeoutMs: LOGIN_TIMEOUT_MS, onStatus, manualConfirm });
      } else {
        await loginCloud(platform, { timeoutMs: LOGIN_TIMEOUT_MS, onStatus, manualConfirm });
      }
      const account = await accountStatus(platform);
      finishJob(job, { account });
      addEvent(job, account.verified === null ? '会话已保存；该平台暂无独立账号校验' : '登录成功，已保存本机会话', 'success');
    } catch (error) {
      failJob(job, error, '登录失败');
    } finally {
      job.confirmable = false;
      job.confirm = null;
    }
  })();
  return job;
}

async function smsSend(phone) {
  if (!/^1\d{10}$/.test(String(phone))) throw badRequest('请输入 11 位中国大陆手机号');
  const auth = await XunleiAuth.load();
  const previous = { ...auth.cred };
  const persist = auth.save;
  auth.save = async () => {};
  try {
    const sent = await auth.sendSmsCode(phone);
    if (!sent.verificationId) throw new Error('迅雷未返回 verification_id');
    // invalidate earlier pending sessions for this phone
    for (const [id, session] of smsSessions) if (session.phone === phone) smsSessions.delete(id);
    const id = randomUUID();
    smsSessions.set(id, { auth, previous, persist, verificationId: sent.verificationId, phone, createdAt: Date.now() });
    return { loginId: id, isUser: sent.isUser ?? null };
  } catch (error) {
    auth.save = persist;
    auth.cred = previous;
    throw error;
  }
}

async function smsVerify(loginId, code) {
  const session = smsSessions.get(String(loginId));
  if (!session) throw badRequest('短信登录会话不存在或已过期，请重新发送验证码');
  if (Date.now() - session.createdAt > 10 * 60 * 1000) {
    smsSessions.delete(String(loginId));
    throw badRequest('验证码会话已过期，请重新发送');
  }
  if (!/^\d{4,8}$/.test(String(code))) throw badRequest('短信验证码格式无效');
  const { auth } = session;
  try {
    await auth.loginWithSmsCode(session.phone, String(code), session.verificationId);
    if (!hasCloudIdentity(await auth.me())) throw new Error('官方账号校验失败，未保存新会话');
    auth.cred.capturedAt = nowIso();
    auth.save = session.persist;
    await session.persist.call(auth);
    smsSessions.delete(String(loginId));
    return accountStatus('xunlei');
  } catch (error) {
    auth.cred = session.previous;
    auth.save = session.persist;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* share / download helpers                                                   */
/* -------------------------------------------------------------------------- */

async function openShare(raw) {
  const prepared = prepareShareInput(raw);
  const result = await withTimeout(services.open(prepared), 90_000, '解析分享超时');
  return { share: { raw: prepared.raw, url: prepared.url, platform: prepared.platform }, result };
}

async function exportLinks(raw, files, format) {
  if (!['json', 'curl', 'aria2'].includes(format)) throw badRequest('导出格式必须是 json、curl 或 aria2');
  const prepared = prepareShareInput(raw);
  if (META[prepared.platform].link === false) throw badRequest('该平台仅支持文件列表，不支持导出下载链接');
  const list = Array.isArray(files) ? files.filter((item) => typeof item === 'string' && item.trim()).slice(0, 5000) : [];
  const result = await withTimeout(services.link(prepared, { file: list }), 120_000, '取链超时');
  return { result, output: renderExport(result, format), format, sensitive: true };
}

function normalizeDownload(result, platform, engine, target) {
  const items = Array.isArray(result) ? result : result?.results || [];
  const results = items.map((item) => {
    let info;
    try { info = fileInfo(item); }
    catch {
      info = { name: String(item?.name || '未知文件'), size: null, sizeBytes: null, filename: String(item?.name || '未知文件').split('/').at(-1), directory: '', extension: '', type: 'file' };
    }
    const status = item?.status === 'failed' || item?.status === 'skipped' ? item.status : 'done';
    const entry = {
      ...info,
      path: item?.path || path.join(target, ...info.name.split('/')),
      status,
    };
    if (status === 'failed') entry.error = safeError(item?.error, '下载失败，请检查账号权限、分享有效性、网络或目标目录');
    return entry;
  });
  return {
    platform,
    engine,
    output: target,
    count: results.length,
    totalBytes: results.every((item) => item.sizeBytes !== null) ? results.reduce((sum, item) => sum + item.sizeBytes, 0) : null,
    results,
  };
}

function validateDownloadOptions(body, platform) {
  const engine = body.engine === 'sdk' ? 'sdk' : 'http';
  if (body.engine && !['http', 'sdk'].includes(body.engine)) throw badRequest('下载引擎必须是 http 或 sdk');
  if (engine === 'sdk' && platform !== 'xunlei') throw badRequest('只有迅雷分享支持 SDK 引擎');
  if (engine === 'sdk' && (body.workers !== undefined || body.chunk !== undefined)) {
    throw badRequest('SDK 自行调度，不能同时设置 workers 或 chunk');
  }
  const workers = engine === 'sdk' ? undefined : clampInt(body.workers, 1, 32, 8);
  const chunk = engine === 'sdk' || body.chunk === undefined || body.chunk === '' ? undefined : clampInt(body.chunk, 1, 1024, undefined) * 1024 * 1024;
  const files = Array.isArray(body.files)
    ? [...new Set(body.files.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))].slice(0, 5000)
    : undefined;
  return { engine, workers, chunkSize: chunk, file: files };
}

function beginDownloadJob(raw, target, options, label, platform) {
  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
    const error = new Error('当前已有 2 个下载任务，请等待完成后再开始');
    error.status = 429;
    throw error;
  }
  const job = createJob('download', label, { platform });
  activeDownloads += 1;
  const prepared = prepareShare(raw, { engine: options.engine });
  (async () => {
    try {
      const result = await services.download(prepared, target, options, (state) => applyProgress(job, state));
      finishJob(job, normalizeDownload(result, prepared.platform, options.engine, target));
    } catch (error) {
      failJob(job, error, '下载失败');
    } finally {
      activeDownloads = Math.max(0, activeDownloads - 1);
    }
  })();
  return job;
}

function beginDirectJob(url, target, options) {
  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
    const error = new Error('当前已有 2 个下载任务，请等待完成后再开始');
    error.status = 429;
    throw error;
  }
  const job = createJob('download', `直链下载 · ${path.basename(target)}`, { platform: 'direct' });
  activeDownloads += 1;
  (async () => {
    try {
      const result = await services.direct(url, target, options, (state) => applyProgress(job, state));
      finishJob(job, normalizeDownload(result, 'direct', 'http', target));
    } catch (error) {
      failJob(job, error, '直链下载失败');
    } finally {
      activeDownloads = Math.max(0, activeDownloads - 1);
    }
  })();
  return job;
}

/* -------------------------------------------------------------------------- */
/* static files                                                               */
/* -------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
}

async function serveStatic(req, res, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname); }
  catch { return fail(res, 400, '路径编码无效'); }
  if (relative.includes('\0')) return fail(res, 400, '路径无效');
  if (relative === '/' || relative === '') relative = '/index.html';
  const target = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, '禁止访问');
  let data;
  try { data = await fs.readFile(target); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return fail(res, 404, '页面不存在');
    throw error;
  }
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': data.length,
    'cache-control': pathname === '/' || pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(data);
}

/* -------------------------------------------------------------------------- */
/* request routing                                                            */
/* -------------------------------------------------------------------------- */

function checkLocalRequest(req) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return false;
  const portMatch = host.match(/:(\d+)$/);
  if (portMatch && Number(portMatch[1]) !== actualPort) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || Number(parsed.port || 80) !== actualPort) return false;
    } catch { return false; }
  }
  return true;
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  if (method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, uptime: process.uptime(), activeDownloads, port: actualPort });
  }

  if (method === 'GET' && pathname === '/api/meta') {
    return json(res, 200, {
      ok: true,
      version: '1.0.0',
      node: process.version,
      platform: process.platform,
      outputDir: OUTPUT_DIR,
      port: actualPort,
      platforms: Object.values(META),
      engines: ['http', 'sdk'],
      sdk: await sdkStatus(),
      limits: { workers: 32, chunkMiB: 1024, maxActiveDownloads: MAX_ACTIVE_DOWNLOADS },
      checkedAt: nowIso(),
    });
  }

  if (method === 'GET' && pathname === '/api/sdk') {
    return json(res, 200, { ok: true, sdk: await sdkStatus() });
  }

  if (method === 'POST' && pathname === '/api/sdk/install') {
    const body = await readJson(req);
    const result = await installSdkComponents(body.url, body.target);
    return json(res, 200, { ok: true, ...result });
  }

  if (method === 'POST' && pathname === '/api/sdk-dir') {
    const body = await readJson(req);
    return json(res, 200, { ok: true, sdk: await setSdkDir(body.path) });
  }

  if (method === 'POST' && pathname === '/api/choose-folder') {
    const body = await readJson(req);
    const selected = await chooseFolder(body.initial);
    return json(res, 200, { ok: true, path: selected || null, canceled: !selected });
  }

  if (method === 'GET' && pathname === '/api/accounts') {
    const payload = await allAccounts();
    return json(res, 200, { ok: true, ...payload });
  }

  if (parts[1] === 'accounts' && parts[2]) {
    const platform = normalizePlatform(parts[2]);
    if (method === 'GET' && parts.length === 3) {
      const account = await accountStatus(platform).catch((error) => accountError(platform, error));
      return json(res, 200, { ok: true, account, checkedAt: nowIso() });
    }
    if (method === 'POST' && parts[3] === 'logout') {
      await readJson(req);
      if (!META[platform].login) throw badRequest('游客平台没有可清除的账号');
      const result = await services.logout(platform);
      return json(res, 200, { ok: true, result });
    }
  }

  if (method === 'POST' && pathname === '/api/login/browser') {
    const body = await readJson(req);
    const platform = loginPlatform(body.platform);
    const job = startBrowserLogin(platform);
    return json(res, 202, { ok: true, job: publicJob(job) });
  }

  if (method === 'POST' && pathname === '/api/login/sms/send') {
    const body = await readJson(req);
    const result = await smsSend(body.phone);
    return json(res, 200, { ok: true, ...result });
  }

  if (method === 'POST' && pathname === '/api/login/sms/verify') {
    const body = await readJson(req);
    const account = await smsVerify(body.loginId, body.code);
    return json(res, 200, { ok: true, account });
  }

  if (method === 'POST' && pathname === '/api/share') {
    const body = await readJson(req);
    const { share, result } = await openShare(body.raw);
    return json(res, 200, { ok: true, share, result });
  }

  if (method === 'POST' && pathname === '/api/links') {
    const body = await readJson(req);
    const result = await exportLinks(body.raw, body.files, body.format || 'json');
    return json(res, 200, { ok: true, ...result });
  }

  if (method === 'POST' && pathname === '/api/open-folder') {
    const body = await readJson(req);
    const target = resolveTarget(body.path || OUTPUT_DIR);
    await ensureDirectory(target);
    openFolder(target);
    return json(res, 200, { ok: true, path: target });
  }

  if (method === 'POST' && pathname === '/api/download') {
    const body = await readJson(req);
    const raw = body.raw;
    const prepared = prepareShareInput(raw);
    const target = resolveTarget(body.target);
    await ensureDirectory(target);
    const options = validateDownloadOptions(body, prepared.platform);
    if (!META[prepared.platform].download) throw badRequest('该平台暂不支持下载，仅可查看文件列表');
    const job = beginDownloadJob(raw, target, options, `分享下载 · ${META[prepared.platform].name}`, prepared.platform);
    return json(res, 202, { ok: true, job: publicJob(job) });
  }

  if (method === 'POST' && pathname === '/api/direct') {
    const body = await readJson(req);
    if (typeof body.url !== 'string') throw badRequest('请填写 HTTP(S) 文件直链');
    let parsed;
    try { parsed = new URL(body.url); } catch { throw badRequest('直链格式无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw badRequest('只接受无嵌入凭据的 HTTP(S) 文件直链');
    if (body.engine && body.engine !== 'http') throw badRequest('直链仅支持 HTTP 引擎');
    const target = resolveTarget(body.target, { direct: true });
    await ensureFileParent(target);
    const options = validateDownloadOptions({ ...body, engine: 'http' }, 'direct');
    const job = beginDirectJob(body.url, target, options);
    return json(res, 202, { ok: true, job: publicJob(job) });
  }

  if (method === 'GET' && pathname === '/api/jobs') {
    const list = [...jobs.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(publicJob);
    return json(res, 200, { ok: true, jobs: list, activeDownloads, checkedAt: nowIso() });
  }

  if (parts[1] === 'jobs' && parts[2]) {
    const job = jobs.get(parts[2]);
    if (!job) return fail(res, 404, '任务不存在或已过期', 'not_found');
    if (method === 'GET' && parts.length === 3) return json(res, 200, { ok: true, job: publicJob(job) });
    if (method === 'POST' && parts[3] === 'confirm') {
      if (!job.confirm) return fail(res, 409, '当前任务不支持重新检测', 'not_confirmable');
      job.confirm();
      return json(res, 200, { ok: true, job: publicJob(job) });
    }
  }

  return fail(res, 404, '接口不存在', 'not_found');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  securityHeaders(res);
  try {
    if (!checkLocalRequest(req)) return fail(res, 403, '仅允许通过本机回环地址访问');
    const url = new URL(req.url || '/', `http://127.0.0.1:${actualPort}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, '方法不允许');
      await handleApi(req, res, pathname, url.searchParams);
    } else {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '方法不允许');
      await serveStatic(req, res, pathname);
    }
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error(`[${nowIso()}] ${req.method} ${req.url} -> ${safeError(error)}`);
    if (!res.headersSent) fail(res, status, error, status === 500 ? 'server_error' : 'bad_request');
    else res.destroy();
  } finally {
    // Lightweight access log; never includes request bodies, credentials or links.
    if (!shuttingDown) console.log(`${req.method} ${new URL(req.url || '/', 'http://local').pathname} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

/* -------------------------------------------------------------------------- */
/* lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

function parseCli(argv) {
  const options = { port: undefined, open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--open') options.open = true;
    else if (arg === '--port') {
      const value = argv[++index];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) throw new Error('--port 需要 1..65535');
      options.port = Number(value);
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** 在系统文件管理器中定位下载目录；仅由本机回环接口触发。 */
function openFolder(target) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [target], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch {
    // 打开文件管理器失败不应中断下载流程。
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } catch {
    // Opening a browser is a convenience; the URL is still printed.
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log(`ODE-cloud Web UI\n\n  node ui/server.mjs [--port 8787] [--open]\n\n环境变量：ODE_UI_PORT、ODE_UI_DOWNLOAD_DIR、ODE_CLOUD_SDK_DIR`);
    return;
  }
  await loadUiSettings().catch((error) => {
    console.warn(`读取本机 UI 设置失败：${safeError(error)}`);
  });
  const requested = options.port ?? (Number(process.env.ODE_UI_PORT) || DEFAULT_PORT);
  if (!Number.isInteger(requested) || requested < 1 || requested > 65535) throw new Error('端口无效');
  let port = requested;
  let bound = false;
  const attempts = options.port || process.env.ODE_UI_PORT ? 1 : 12;
  for (let offset = 0; offset < attempts; offset += 1) {
    try {
      actualPort = await listen(port + offset);
      bound = true;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || offset === attempts - 1) throw error;
    }
  }
  if (!bound) throw new Error('无法绑定本地端口');
  await ensureDirectory(OUTPUT_DIR).catch(() => {});

  const url = `http://127.0.0.1:${actualPort}`;
  console.log('');
  console.log('  ODE-cloud Web UI');
  console.log(`  ${url}`);
  console.log(`  下载目录：${OUTPUT_DIR}`);
  console.log('  仅监听本机回环地址；按 Ctrl+C 停止。');
  console.log('');
  if (options.open) openBrowser(url);

  const cleanup = setInterval(pruneJobs, 10 * 60 * 1000);
  cleanup.unref?.();
}

process.on('SIGINT', () => {
  shuttingDown = true;
  console.log('\n正在关闭 ODE-cloud Web UI…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on('SIGTERM', () => {
  shuttingDown = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

main().catch((error) => {
  console.error('启动失败：' + safeError(error));
  if (process.env.ODE_CLOUD_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});