// 编排层：把「解析 → 计划 → 串行子任务 → 校验」串起来。
// 与迅雷游戏助手一致：同一时刻只跑一个子文件，避免多文件互抢带宽；
// 直链超过 60s 才允许刷新，避免把解析接口打爆。
import fs from 'node:fs/promises';
import path from 'node:path';
import { download } from './engine.mjs';
import { createDownloadProgress } from './download-progress.mjs';
import { downloadSdk } from './sdk-engine.mjs';
import { GameAssistantShare, safeSharePath } from './game-share.mjs';
import { DOWNLOAD_UA, URL_REFRESH_THROTTLE_MS } from './config.mjs';

const sanitize = (value) => safeSharePath(value).split('/').join(path.sep);

/**
 * 执行一条下载任务。
 * @param {object} o
 * @param {import('./auth.mjs').XunleiAuth} o.auth
 * @param {string} o.shareUrl
 * @param {string} o.outDir
 * @param {number} [o.workers]
 * @param {number} [o.chunkSize]
 */
export async function runPipeline(o) {
  const {
    auth, shareUrl, outDir, workers = 8, chunkSize, files: requestedFiles = [],
    engine = 'http', sdkDownloader = downloadSdk, httpDownloader = download,
    log = () => {}, progress = () => {}, signal, share = new GameAssistantShare(auth),
  } = o;
  if (!['http', 'sdk'].includes(engine)) throw new Error(`不支持下载引擎：${engine}`);

  const files = await share.list(shareUrl);
  let items = files;
  if (requestedFiles.length) {
    const selectedPaths = new Set(requestedFiles.map((name) => safeSharePath(name)));
    const availablePaths = new Set(files.map((file) => safeSharePath(file.name)));
    for (const name of selectedPaths) if (!availablePaths.has(name)) throw new Error(`未找到文件：${name}`);
    items = files.filter((file) => selectedPaths.has(safeSharePath(file.name)));
  }

  const totalBytes = items.reduce((total, file) => total + file.size, 0);
  const reporter = createDownloadProgress({ platform: 'xunlei', engine, files: items, onProgress: progress, log });
  reporter.plan();
  for (const [index, file] of items.entries()) reporter.event('file', index + 1);
  const links = await share.links(items.map((item) => item.gcid), { withTokens: engine === 'sdk' });
  const results = [];
  const lastRefresh = new Map();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (signal?.aborted) break;
    const dest = path.join(outDir, sanitize(item.name));

    const existing = await fs.stat(dest).catch(() => null);
    if (existing && existing.size === item.size) {
      reporter.event('skip', i + 1, { size: item.size });
      results.push({ name: item.name, size: item.size, status: 'exists' });
      continue;
    }

    const link = links.get(item.gcid);
    const url = engine === 'sdk' ? link?.url : link;
    const maybeRefresh = async () => {
      const refreshed = await share.links([item.gcid], { withTokens: engine === 'sdk' });
      const fresh = refreshed.get(item.gcid);
      if (!fresh || (engine === 'sdk' && !fresh.url)) throw new Error('直链刷新失败，分享可能已失效或账号无权下载');
      lastRefresh.set(item.gcid, Date.now());
      return fresh;
    };
    if (!url) {
      reporter.event('failed', i + 1);
      results.push({ name: item.name, size: item.size, status: 'failed', error: '未获得可用直链' });
      continue;
    }
    lastRefresh.set(item.gcid, Date.now());

    reporter.event('start', i + 1);
    try {
      const onProgress = reporter.transfer(i + 1);
      const { size } = engine === 'sdk'
        ? await sdkDownloader({
          url, dest, size: item.size, token: link.token, auth, signal, onProgress,
          refreshToken: async () => (await maybeRefresh()).token,
        })
        : await httpDownloader({
          url, dest, size: item.size, workers, chunkSize, signal,
          headers: { 'user-agent': DOWNLOAD_UA, referer: 'https://pan.xunlei.com/' },
          onProgress,
          onExpired: async () => {
            if (Date.now() - lastRefresh.get(item.gcid) < URL_REFRESH_THROTTLE_MS) {
              throw new Error('直链失效且刷新被节流');
            }
            reporter.event('refresh', i + 1);
            return maybeRefresh();
          },
        });

      const actualSize = (await fs.stat(dest)).size;
      if (actualSize !== item.size) throw new Error(`文件大小不符：${actualSize}/${item.size}`);
      reporter.event('verify', i + 1, { received: actualSize });

      reporter.event('done', i + 1, { size });
      results.push({ name: item.name, size, status: 'done', verified: 'size' });
    } catch (err) {
      reporter.event('failed', i + 1);
      results.push({ name: item.name, size: item.size, status: 'failed', error: err.message });
    }
  }

  return { results, totalBytes };
}


