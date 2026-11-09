import fs from 'node:fs/promises';
import path from 'node:path';
import { download } from './engine.mjs';
import { createDownloadProgress } from './download-progress.mjs';
import { safeSharePath } from './game-share.mjs';
import { QuarkClient } from './quark.mjs';
import { Pan115Share } from './pan115.mjs';

export function cloudClient(platform, cookie) {
  if (platform === 'quark') return new QuarkClient(cookie);
  if (platform === '115') return new Pan115Share({ cookie });
  throw new Error(`不支持网盘：${platform}`);
}

/** Separate the link's short-lived credentials from the file plan: fetch immediately before transfer. */
export async function runCloudPipeline({ platform, cookie, shareUrl, password, outDir, engine = 'http', workers = 8, client = cloudClient(platform, cookie), httpDownloader = download, log = () => {}, progress = () => {}, signal }) {
  if (engine !== 'http') throw new Error('夸克/115 只支持直链 HTTP Range 下载；迅雷 P2SP 仅用于迅雷分享');
  const resolved = platform === 'quark'
    ? await client.resolveShare(shareUrl, { password })
    : await client.resolve(shareUrl, { password });
  const selected = resolved.files;
  const reporter = createDownloadProgress({ platform, engine, files: selected, onProgress: progress, log });
  reporter.plan();
  for (const [index, file] of selected.entries()) reporter.event('file', index + 1);
  const results = [];
  for (const [index, file] of selected.entries()) {
    if (signal?.aborted) break;
    const name = safeSharePath(file.name);
    const dest = path.join(outDir, ...name.split('/'));
    const existing = await fs.stat(dest).catch(() => null);
    if (existing?.size === file.size && file.size > 0) {
      reporter.event('skip', index + 1, { size: file.size });
      results.push({ name, size: file.size, status: 'exists' });
      continue;
    }
    reporter.event('start', index + 1);
    try {
      const getFreshLink = async () => {
        const refreshed = platform === 'quark'
          ? await client.getShareDownloadLink(resolved.share, file)
          : await client.link(shareUrl, file);
        if (!/^https:\/\//i.test(refreshed.url)) throw new Error('刷新后的网盘直链不是 HTTPS');
        return refreshed;
      };
      let link = await getFreshLink();
      if (!link.headers?.cookie && !link.headers?.Cookie) throw new Error('网盘直链缺少认证 Cookie');
      const expected = file.size || link.size;
      const onProgress = reporter.transfer(index + 1);
      await httpDownloader({ url: link.url, dest, size: expected, headers: link.headers, workers, signal, onExpired: async () => {
        link = await getFreshLink();
        if (!link.headers?.cookie && !link.headers?.Cookie) throw new Error('刷新后的网盘直链缺少认证 Cookie');
        return { url: link.url, headers: link.headers };
      }, onProgress });
      const actual = (await fs.stat(dest)).size;
      if (expected && actual !== expected) throw new Error(`文件大小不符：${actual}/${expected}`);
      reporter.event('verify', index + 1, { received: actual });
      reporter.event('done', index + 1, { size: actual });
      results.push({ name, size: actual, status: 'done', verified: expected ? 'size' : null });
    } catch (error) {
      reporter.event('failed', index + 1);
      results.push({ name, size: file.size, status: 'failed', error: error.message });
    }
  }
  return { results, totalBytes: selected.reduce((sum, file) => sum + file.size, 0) };
}
