// 传输层：多连接分片下载引擎（替代迅雷 SDK 的内核位置）。
// 逐字节语义与迅雷侧保持一致：先落 .part 临时文件，全部片完成后再原子改名。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statSafe(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** 探测远端大小与 Range 支持 */
export async function probe(url, headers = {}) {
  let headInfo = null;
  try {
    const res = await fetch(url, { method: 'HEAD', headers });
    if (res.ok) {
      const len = Number(res.headers.get('content-length') || 0);
      headInfo = {
        size: len,
        acceptRanges: (res.headers.get('accept-ranges') || '').includes('bytes'),
        etag: res.headers.get('etag') || '',
      };
    }
  } catch {
    // 有些 CDN 不支持 HEAD，继续用 Range 探测
  }
  // 真实请求验证 Range，不能仅凭 HEAD 的声明并发下载
  const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`探测失败 HTTP ${res.status}`);
  }
  const cr = res.headers.get('content-range') || '';
  const match = /^bytes 0-0\/(\d+)$/.exec(cr);
  const size = match ? Number(match[1]) : headInfo?.size || Number(res.headers.get('content-length') || 0);
  await res.body?.cancel();
  return {
    size,
    acceptRanges: Boolean(match),
    etag: res.headers.get('etag') || headInfo?.etag || '',
  };
}

async function hashChunk(file, chunk) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = chunk.start;
  while (position <= chunk.end) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, chunk.end - position + 1), position);
    if (!bytesRead) return null;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex');
}

function validPlan(chunks, size) {
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > 100000) return false;
  let next = 0;
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) || chunk.start !== next || chunk.end < next || chunk.end >= size) return false;
    next = chunk.end + 1;
  }
  return next === size;
}

function planChunks(size, chunkSize, workers) {
  const chunks = [];
  for (let start = 0; start < size; start += chunkSize) {
    chunks.push({ start, end: Math.min(start + chunkSize, size) - 1, done: false });
  }
  // 片数少于并发时缩小片长，保证并发被用满
  if (chunks.length < workers && size > 1024 * 1024) {
    const target = Math.max(1, workers * 2);
    const cs = Math.ceil(size / target);
    chunks.length = 0;
    for (let start = 0; start < size; start += cs) {
      chunks.push({ start, end: Math.min(start + cs, size) - 1, done: false });
    }
  }
  return chunks;
}

/**
 * 服务端不支持 Range 时的单流兜底。
 */
async function singleStream({ url, dest, headers, onProgress, signal, expectedSize, onExpired }) {
  const partPath = `${dest}.part`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let currentUrl = url;
  let currentHeaders = headers;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error('下载已取消');
    try {
      const res = await fetch(currentUrl, { headers: currentHeaders, signal });
      if ([401, 403, 410].includes(res.status) && onExpired && attempt < 3) {
        await res.body?.cancel();
        const refreshed = await onExpired();
        currentUrl = typeof refreshed === 'string' ? refreshed : refreshed.url;
        if (typeof refreshed === 'object' && refreshed.headers) currentHeaders = refreshed.headers;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (expectedSize > 0 && declared > 0 && declared !== expectedSize) {
        await res.body?.cancel();
        throw new Error(`文件大小不符：${declared}/${expectedSize}`);
      }
      const total = expectedSize || declared;
      const fh = await fs.open(partPath, 'w');
      const startedAt = Date.now();
      let received = 0;
      let lastAt = startedAt;
      let lastBytes = 0;
      try {
        for await (const value of res.body) {
          if (total > 0 && received + value.length > total) throw new Error('下载数据超过预期大小');
          let written = 0;
          while (written < value.length) {
            const result = await fh.write(value, written, value.length - written);
            if (!result.bytesWritten) throw new Error('无法写入下载文件');
            written += result.bytesWritten;
          }
          received += value.length;
          const now = Date.now();
          if (now - lastAt >= 500) {
            onProgress?.({ received, total, speed: ((received - lastBytes) / (now - lastAt)) * 1000 });
            lastAt = now;
            lastBytes = received;
          }
        }
      } finally {
        await fh.close();
      }
      if (total > 0 && received !== total) throw new Error(`下载不完整：${received}/${total}`);
      await fs.rename(partPath, dest);
      onProgress?.({ received, total, speed: received / Math.max(0.001, (Date.now() - startedAt) / 1000), final: true });
      return { size: received, path: dest };
    } catch (error) {
      if (signal?.aborted || attempt === 3 || /数据超过预期|文件大小不符|无法写入/.test(error.message)) throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
}

/**
 * 分片下载。
 * @param {object} opts
 * @param {string} opts.url 直链
 * @param {string} opts.dest 目标文件
 * @param {number} [opts.size] 已知大小
 * @param {number} [opts.workers] 并发连接数
 * @param {number} [opts.chunkSize] 分片大小（字节）
 * @param {object} [opts.headers] 请求头
 * @param {(p:{received:number,total:number,speed:number})=>void} [opts.onProgress]
 * @param {()=>Promise<string>} [opts.onExpired] 返回新的直链（401/403/410 时调用）
 */
export async function download(opts) {
  const {
    url, dest, headers = {}, workers = 8, onProgress, onExpired, signal,
  } = opts;

  if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error('并发数必须是 1 至 32');
  if (opts.chunkSize !== undefined && (!Number.isSafeInteger(opts.chunkSize) || opts.chunkSize < 1)) throw new Error('分片大小必须是正整数');
  let initialUrl = url;
  let initialHeaders = headers;
  let info;
  try { info = await probe(initialUrl, initialHeaders); }
  catch (error) {
    if (!onExpired || signal?.aborted) throw error;
    const refreshed = await onExpired();
    initialUrl = typeof refreshed === 'string' ? refreshed : refreshed.url;
    if (typeof refreshed === 'object' && refreshed.headers) initialHeaders = refreshed.headers;
    info = await probe(initialUrl, initialHeaders);
  }
  if (opts.size != null && info.size > 0 && opts.size !== info.size) {
    throw new Error(`分享文件大小与直链不符：${opts.size} / ${info.size}`);
  }
  const total = opts.size && opts.size > 0 ? opts.size : info.size;
  if (!info.acceptRanges) {
    return singleStream({ url: initialUrl, dest, headers: initialHeaders, onProgress, signal, expectedSize: total, onExpired });
  }
  if (!total) throw new Error('无法获取文件大小，不能安全使用 Range 分片下载');

  const chunkSize = opts.chunkSize || Math.max(1024 * 1024, Math.min(8 * 1024 * 1024, Math.ceil(total / (workers * 4))));
  const partPath = `${dest}.part`;
  const statePath = `${dest}.part.json`;

  await fs.mkdir(path.dirname(dest), { recursive: true });

  let chunks = null;
  const prev = await statSafe(statePath);
  const part = await statSafe(partPath);
  if (prev && part?.size === total) {
    try {
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (state.size === total && state.chunkSize === chunkSize && validPlan(state.chunks, total)
        && (!state.etag || !info.etag || state.etag === info.etag)) {
        chunks = state.chunks;
        const partFile = await fs.open(partPath, 'r');
        try {
          for (const chunk of chunks) {
            if (chunk.done && (!/^[a-f0-9]{64}$/.test(chunk.sha256 || '') || await hashChunk(partFile, chunk) !== chunk.sha256)) {
              chunk.done = false;
              delete chunk.sha256;
            }
          }
        } finally { await partFile.close(); }
      }
    } catch {
      chunks = null;
    }
  }
  if (!chunks) chunks = planChunks(total, chunkSize, workers);

  const fh = await fs.open(partPath, 'r+').catch(async () => {
    const created = await fs.open(partPath, 'w+');
    await created.truncate(total);
    return created;
  });
  const cur = await fh.stat();
  if (cur.size !== total) await fh.truncate(total);

  const startedAt = Date.now();
  let received = chunks.reduce((sum, chunk) => sum + (chunk.done ? chunk.end - chunk.start + 1 : 0), 0);
  const inFlight = new Map();
  let lastReported = received;
  let lastAt = Date.now();
  let currentUrl = initialUrl;
  let currentHeaders = { ...initialHeaders };
  let refreshPromise = null;
  let fatal = null;
  const refreshLink = async () => {
    if (!refreshPromise) {
      refreshPromise = Promise.resolve().then(onExpired).then((refreshed) => {
        currentUrl = typeof refreshed === 'string' ? refreshed : refreshed.url;
        if (typeof refreshed === 'object' && refreshed.headers) currentHeaders = { ...refreshed.headers };
      }).finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  };

  // 状态落盘：串行化 + 原子替换，避免并发写同一文件（Windows 下会 EPERM）
  let persistChain = Promise.resolve();
  let lastName = '';
  const persist = () => {
    const body = JSON.stringify({ size: total, chunkSize, etag: info.etag, chunks });
    if (body === lastName) return persistChain;
    lastName = body;
    persistChain = persistChain
      .then(async () => {
        const tmp = `${statePath}.tmp`;
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, statePath);
      })
      .catch(() => {});
    return persistChain;
  };

  const timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastAt) / 1000;
    const current = Math.min(total, received + [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0));
    const speed = dt > 0 ? Math.max(0, (current - lastReported) / dt) : 0;
    lastReported = current;
    lastAt = now;
    onProgress?.({ received: current, total, speed });
  }, 500);

  const fetchChunk = async (chunk) => {
    for (let attempt = 0; attempt < 4 && !fatal; attempt += 1) {
      if (signal?.aborted) { fatal = signal.reason || new Error('下载已取消'); return; }
      try {
        const response = await fetch(currentUrl, { headers: { ...currentHeaders, Range: `bytes=${chunk.start}-${chunk.end}` }, signal });
        if ([401, 403, 410].includes(response.status)) {
          await response.body?.cancel();
          if (!onExpired) throw new Error(`直链已失效 (HTTP ${response.status})`);
          await refreshLink();
          continue;
        }
        if (response.status === 200) {
          await response.body?.cancel();
          const error = new Error('服务器忽略 Range，改用单流下载');
          error.code = 'RANGE_IGNORED';
          throw error;
        }
        if (response.status !== 206) {
          await response.body?.cancel();
          throw new Error(`下载分片失败 HTTP ${response.status}`);
        }
        const contentRange = response.headers.get('content-range');
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
        if (!match || Number(match[1]) !== chunk.start || Number(match[2]) !== chunk.end || Number(match[3]) !== total
          || (info.etag && response.headers.get('etag') && info.etag !== response.headers.get('etag'))) {
          await response.body?.cancel();
          throw new Error(`服务端返回的分片范围或文件版本不匹配：${contentRange}`);
        }
        let position = chunk.start;
        const digest = createHash('sha256');
        for await (const value of response.body) {
          if (position + value.length - 1 > chunk.end) throw new Error('服务端返回数据超过请求分片');
          let written = 0;
          while (written < value.length) {
            const result = await fh.write(value, written, value.length - written, position + written);
            if (!result.bytesWritten) throw new Error('无法写入下载文件');
            written += result.bytesWritten;
          }
          digest.update(value);
          position += value.length;
          inFlight.set(chunk, position - chunk.start);
        }
        if (position - 1 !== chunk.end) throw new Error(`分片长度不符: 期望到 ${chunk.end}，实际到 ${position - 1}`);
        chunk.sha256 = digest.digest('hex');
        chunk.done = true;
        received += chunk.end - chunk.start + 1;
        inFlight.delete(chunk);
        return;
      } catch (error) {
        inFlight.delete(chunk);
        if (signal?.aborted || error.code === 'RANGE_IGNORED' || /范围或文件版本不匹配|无法写入/.test(error.message) || attempt === 3) {
          fatal = error;
          return;
        }
        await sleep(400 * 2 ** attempt);
      }
    }
  };

  const queue = chunks.filter((c) => !c.done);
  let cursor = 0;
  const runner = async () => {
    while (cursor < queue.length && !fatal) {
      const chunk = queue[cursor++];
      await fetchChunk(chunk);
      await persist();
    }
  };

  let persistTimer = null;
  try {
    persistTimer = setInterval(persist, 3000);
    await Promise.all(Array.from({ length: Math.min(workers, Math.max(1, queue.length)) }, runner));
  } finally {
    if (persistTimer) clearInterval(persistTimer);
    clearInterval(timer);
    await persist();
    await persistChain;
    await fh.close().catch(() => {});
  }

  if (fatal?.code === 'RANGE_IGNORED') {
    const result = await singleStream({ url: currentUrl, dest, headers: currentHeaders, onProgress, signal, expectedSize: total, onExpired });
    await fs.rm(statePath, { force: true });
    return result;
  }
  if (fatal) throw fatal;

  const doneBytes = chunks.reduce((a, c) => a + (c.done ? c.end - c.start + 1 : 0), 0);
  if (doneBytes !== total) throw new Error(`下载不完整：${doneBytes}/${total}`);

  // 收尾补一次进度，保证小文件也能被统计到
  onProgress?.({ received: total, total, speed: total / Math.max(0.001, (Date.now() - startedAt) / 1000), final: true });
  await fs.rename(partPath, dest);
  await fs.rm(statePath, { force: true });
  return { size: total, path: dest };
}
