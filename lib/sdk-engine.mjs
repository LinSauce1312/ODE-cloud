import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HOME } from './config.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSdkDir = path.join(projectRoot, 'native', 'win32-x64');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OK = 9000;

export async function loadSdk(sdkDir = process.env.ODE_CLOUD_SDK_DIR || defaultSdkDir) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('原版下载内核仅支持 Windows x64');
  const addonPath = path.join(path.resolve(sdkDir), 'download.node');
  const dllPath = path.join(path.resolve(sdkDir), 'xl_thunder_sdk.dll');
  try { await fs.access(addonPath); await fs.access(dllPath); }
  catch { throw new Error('未提供本地 SDK：请设置 ODE_CLOUD_SDK_DIR，目录内需有匹配 Node ABI 的 download.node 与 xl_thunder_sdk.dll；默认 HTTP 不需要 SDK'); }
  try { return require(addonPath); }
  catch (error) {
    throw new Error('SDK 组件无法加载：需要兼容当前 Node ABI ' + process.versions.modules + ' 的 Windows x64 组件；可改用 --engine http。' + error.message, { cause: error });
  }
}

export async function downloadSdk({ url, dest, size, token, auth, headers = {}, onProgress, refreshToken, signal, addon: providedAddon, sdkDataDir }) {
  const requestHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const unsupported = Object.keys(requestHeaders).filter((name) => !['cookie', 'referer', 'user-agent'].includes(name));
  if (unsupported.length) throw new Error(`P2SP 不支持这些请求头：${unsupported.join(', ')}`);
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`无效请求头：${name}`);
  }
  const addon = providedAddon || await loadSdk();
  const dataDir = sdkDataDir || path.join(HOME, 'sdk');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const peerId = auth.cred.peerId;
  if (!peerId || !auth.deviceId) throw new Error('缺少账号设备标识，无法初始化下载内核');
  const initResult = addon.init({
    appKey: 'Y29tLnh1bmxlaS5nYW1lLWFzc2lzdGFudADzFwE=',
    appName: 'com.xunlei.game-assistant', appVersion: '1.0.0',
    logSavePath: dataDir, statSavePath: dataDir, statCfgSavePath: dataDir,
    peerId, guid: auth.deviceId, permissionLevel: 3, networkType: 10,
  });
  if (initResult !== OK) throw new Error(`下载内核初始化失败：${initResult}`);
  let taskId;
  let completed = false;
  try {
    const created = addon.createP2spTask({
      mode: 0, url, filePath: path.dirname(dest), filename: path.basename(dest),
      cookie: requestHeaders.cookie || '', refUrl: requestHeaders.referer || '',
    });
    if (created?.errno !== OK) throw new Error(`创建 P2SP 任务失败：${created?.errno}`);
    taskId = created.taskId;
    if (requestHeaders['user-agent']) {
      const result = addon.setOriginUserAgent(taskId, requestHeaders['user-agent']);
      if (result !== OK) throw new Error(`设置 P2SP User-Agent 失败：${result}`);
    }
    const startResult = addon.startTask(taskId);
    if (startResult !== OK) throw new Error(`启动 P2SP 任务失败：${startResult}`);
    const applyToken = (jwt) => {
      if (jwt) addon.setAccelerateToken(taskId, -1, { accelerateType: 1, jwt });
    };
    applyToken(token);
    let lastRefresh = Date.now();
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error('下载已取消');
      const info = addon.getTaskInfo(taskId);
      if (!info || typeof info === 'number') throw new Error(`读取 P2SP 任务失败：${info}`);
      onProgress?.({ received: info.download_size || 0, total: size || info.file_size || 0, speed: info.download_speed || 0 });
      if (info.status === 2) break;
      if (info.status === 3 || info.status === 4) throw new Error(`P2SP 任务失败：${info.errno_code || info.status}`);
      if (refreshToken && Date.now() - lastRefresh >= 60_000) {
        lastRefresh = Date.now();
        try { applyToken(await refreshToken()); } catch {}
      }
      await sleep(1000);
    }
    const actual = await fs.stat(dest);
    if (size != null && actual.size !== size) throw new Error(`P2SP 文件大小不符：${actual.size}/${size}`);
    completed = true;
    onProgress?.({ received: actual.size, total: size || actual.size, speed: 0, final: true });
    return { size: actual.size, path: dest };
  } finally {
    if (taskId !== undefined) {
      if (!completed) { try { addon.stopTask(taskId); } catch {} }
      try { addon.releaseTask(taskId); } catch {}
    }
    try { addon.unInit(); } catch {}
  }
}
