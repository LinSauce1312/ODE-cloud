import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { download } from '../lib/engine.mjs';

const source = Buffer.alloc(256 * 1024);
for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, respond) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xl-engine-'));
  const server = http.createServer(respond);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, url: `http://127.0.0.1:${server.address().port}/file` };
}

function rangeResponse(request, response, { etag = 'original', short = false } = {}) {
  if (request.method === 'HEAD') {
    response.writeHead(200, { 'content-length': source.length, 'accept-ranges': 'bytes', etag });
    response.end();
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
  if (!match) {
    response.writeHead(200, { 'content-length': source.length, etag });
    response.end(source);
    return;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${source.length}`, etag });
  response.end(source.subarray(start, short ? start + 1 : end + 1));
}

test('短分片有限重试后保留状态，不发布不完整文件', async (t) => {
  const { directory, url } = await fixture(t, (request, response) => rangeResponse(request, response, { short: request.headers.range !== 'bytes=0-0' }));
  const dest = path.join(directory, 'short.bin');
  await assert.rejects(download({ url, dest, workers: 2, chunkSize: 65536 }), /分片长度不符/);
  await assert.rejects(fs.stat(dest), { code: 'ENOENT' });
  await fs.stat(`${dest}.part.json`);
});

test('单流短响应重试后才发布完整文件', async (t) => {
  let attempts = 0;
  const { directory, url } = await fixture(t, (request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': source.length });
      response.end();
    } else if (request.headers.range) {
      response.writeHead(200, { 'content-length': source.length });
      response.end();
    } else {
      attempts += 1;
      const bytes = attempts === 1 ? source.subarray(0, source.length / 2) : source;
      response.writeHead(200);
      response.end(bytes);
    }
  });
  const dest = path.join(directory, 'single.bin');
  await download({ url, dest });
  assert.equal(attempts, 2);
  assert.equal(hash(await fs.readFile(dest)), hash(source));
});

test('分片途中 Range 被忽略时清理并回退单流', async (t) => {
  let fallback = 0;
  const { directory, url } = await fixture(t, (request, response) => {
    if (request.method === 'HEAD' || request.headers.range === 'bytes=0-0') {
      rangeResponse(request, response);
    } else if (request.headers.range) {
      response.writeHead(200, { 'content-length': source.length });
      response.end(source);
    } else {
      fallback += 1;
      rangeResponse(request, response);
    }
  });
  const dest = path.join(directory, 'fallback.bin');
  await download({ url, dest, workers: 4, chunkSize: 65536 });
  assert.equal(fallback, 1);
  assert.equal(hash(await fs.readFile(dest)), hash(source));
  await assert.rejects(fs.stat(`${dest}.part.json`), { code: 'ENOENT' });
});

test('续传时损坏的已完成分片会重新下载', async (t) => {
  const requested = [];
  const { directory, url } = await fixture(t, (request, response) => {
    if (request.headers.range && request.headers.range !== 'bytes=0-0') requested.push(request.headers.range);
    rangeResponse(request, response);
  });
  const dest = path.join(directory, 'resume.bin');
  const firstChunk = source.subarray(0, 65536);
  const part = Buffer.alloc(source.length);
  firstChunk.copy(part);
  part[0] ^= 0xff;
  await fs.writeFile(`${dest}.part`, part);
  await fs.writeFile(`${dest}.part.json`, JSON.stringify({
    size: source.length, chunkSize: 65536, etag: 'original',
    chunks: [0, 65536, 131072, 196608].map((start) => ({
      start, end: start + 65535, done: start === 0, ...(start === 0 ? { sha256: hash(firstChunk) } : {}),
    })),
  }));
  await download({ url, dest, workers: 2, chunkSize: 65536 });
  assert.ok(requested.includes('bytes=0-65535'));
  assert.equal(hash(await fs.readFile(dest)), hash(source));
});

test('过期链接刷新后并发分片可完成', async (t) => {
  let refreshed = 0;
  const { directory, url } = await fixture(t, (request, response) => {
    if (request.headers.range !== 'bytes=0-0' && request.method !== 'HEAD' && !request.url.includes('fresh')) {
      response.writeHead(403);
      response.end();
      return;
    }
    rangeResponse(request, response);
  });
  const dest = path.join(directory, 'refresh.bin');
  await download({ url, dest, workers: 4, chunkSize: 65536, onExpired: async () => {
    refreshed += 1;
    return `${url}?fresh`;
  } });
  assert.ok(refreshed >= 1);
  assert.equal(hash(await fs.readFile(dest)), hash(source));
});
