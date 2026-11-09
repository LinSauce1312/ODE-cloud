import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDownloadProgress, formatDownloadProgress, fileInfo, createProgressRenderer } from '../lib/download-progress.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { createServices } from '../src/cli-runtime.mjs';
import { runCloudPipeline } from '../lib/cloud-pipeline.mjs';

test('file metadata keeps name and readable size first without leaking credentials', () => {
  const info = fileInfo({ name: '目录/file.ZIP', size: 454668917, fid: '42', cookie: 'secret', url: 'https://secret', fidToken: 'secret' });
  assert.deepEqual(Object.keys(info).slice(0, 2), ['name', 'size']);
  assert.equal(info.size, '454668917 (433.61 MB)');
  assert.equal(info.sizeBytes, 454668917);
  assert.equal(info.filename, 'file.ZIP');
  assert.equal(info.directory, '目录');
  assert.equal(info.extension, '.zip');
  assert.equal(info.id, '42');
  assert.doesNotMatch(JSON.stringify(info), /secret|cookie|token/i);
  assert.equal(fileInfo({ name: 'a', size: 1073741824 }).size, '1073741824 (1.00 GB)');
  assert.equal(fileInfo({ name: 'a', size: 0 }).sizeBytes, 0);
  assert.equal(fileInfo({ name: 'a' }).size, null);
});

test('terminal progress preserves lifecycle logs and only rewrites throttled transfer updates', () => {
  const writes = [];
  let clock = 0;
  const render = createProgressRenderer({ stream: { isTTY: true, columns: 120, write: text => writes.push(text) }, now: () => clock });
  const state = { platform: 'quark', engine: 'http', name: '目录/a.zip', index: 1, count: 1, received: 1, total: 10, speed: 2, batchReceived: 1, batchTotal: 10, event: 'start' };
  render(state);
  render({ ...state, event: 'progress' });
  const initial = writes.length;
  render({ ...state, event: 'progress' });
  assert.equal(writes.length, initial);
  clock = 100;
  render({ ...state, event: 'progress' });
  render({ ...state, event: 'done', final: true });
  assert.equal(writes.filter(text => text === '\n').length, 0);
  render.finish();
  render.finish();
  assert.equal(writes.filter(text => text === '\n').length, 0);
  const text = writes.join('');
  assert.ok(text.includes('开始 目录/a.zip'));
  assert.ok(text.includes('完成 目录/a.zip'));
  assert.equal(text.split('下载中').length - 1, 2);
  assert.ok(writes.join('').includes('下载中'));
  assert.ok(writes.join('').includes('完成'));
  const logs = [];
  const plain = createProgressRenderer({ stream: { isTTY: false, write: text => logs.push(text) } });
  plain(state);
  for (let index = 0; index < 100; index += 1) plain({ ...state, event: 'progress' });
  plain({ ...state, event: 'verify' });
  plain({ ...state, event: 'done', final: true });
  plain.finish();
  assert.equal(logs.length, 3);
  assert.ok(!logs[0].includes(String.fromCharCode(27)));
});

test('HTTP and SDK share one dynamic transfer line without duplicate single-file totals', () => {
  for (const engine of ['http', 'sdk']) {
    const writes = [];
    let clock = 0;
    const render = createProgressRenderer({ stream: { isTTY: true, columns: 200, write: text => writes.push(text) }, now: () => clock });
    const reporter = createDownloadProgress({ platform: 'xunlei', engine, files: [{ name: '目录/a.zip', size: 10 }], onProgress: render });
    reporter.plan();
    reporter.event('file', 1);
    reporter.event('start', 1);
    const before = writes.length;
    reporter.transfer(1)({ download_size: 4, file_size: 10, download_speed: 2 });
    const first = writes.length;
    clock = 100;
    reporter.transfer(1)({ download_size: 6, file_size: 10, download_speed: 3 });
    const progressWrites = writes.slice(before);
    assert.equal(first - before, 3);
    assert.equal(progressWrites.length, 6);
    assert.ok(progressWrites.every(text => !text.includes('\n')));
    assert.match(progressWrites.at(-1), /6 B\/10 B.*3 B\/s/);
    assert.equal(progressWrites.join('').split('下载中').length - 1, 2);
    reporter.event('verify', 1);
    reporter.event('done', 1, { size: 10 });
    render.finish();
    const output = writes.join('');
    for (const label of ['计划', '文件', '开始', '校验通过', '完成']) assert.ok(output.includes(label));
    assert.doesNotMatch(output, /总计/);
    const state = { platform: 'xunlei', engine, name: '目录/a.zip', index: 1, count: 1, received: 4, total: 10, speed: 2, batchReceived: 4, batchTotal: 10, event: 'progress' };
    assert.equal(formatDownloadProgress(state).split('4 B/10 B').length - 1, 1);
    assert.match(formatDownloadProgress({ ...state, count: 2, batchTotal: 20 }), /总计 4 B\/20 B/);
    assert.doesNotMatch(formatDownloadProgress({ ...state, count: 2, event: 'plan' }), /总计/);
  }
});

function checkEvent(event, platform, engine) {
  assert.equal(event.platform, platform);
  assert.equal(event.engine, engine);
  for (const key of ['name', 'index', 'count', 'received', 'total', 'speed', 'final', 'event', 'batchTotal', 'batchReceived']) assert.ok(Object.hasOwn(event, key), key);
  assert.doesNotMatch(JSON.stringify(event), /https:|secret|cookie|token/i);
}

test('shared progress normalizes SDK fields, preserves relative paths, and filters credentials', () => {
  const events = [];
  const logs = [];
  const reporter = createDownloadProgress({ platform: 'xunlei', engine: 'sdk', files: [{ name: 'Folder/sub/file.bin', size: 10 }, { name: 'other.bin', size: 5 }], onProgress: event => events.push(event), log: event => logs.push(event) });
  reporter.plan();
  reporter.event('start', 1);
  reporter.transfer(1)({ download_size: 4, file_size: 10, download_speed: 2, url: 'https://secret', cookie: 'secret', token: 'secret' });
  reporter.transfer(1)({ received: 10, total: 10, speed: 0, final: true });
  assert.equal(events.at(-1).final, false, 'downloader completion must not preempt verification');
  reporter.event('done', 1, { size: 10 });
  reporter.event('skip', 2, { size: 5 });
  assert.equal(events.at(-1).batchReceived, 15);
  assert.equal(events.at(-1).batchTotal, 15);
  assert.equal(events[2].name, 'Folder/sub/file.bin');
  assert.equal(events[2].received, 4);
  assert.equal(events[2].speed, 2);
  assert.equal(events.at(-1).final, true);
  for (const event of events) checkEvent(event, 'xunlei', 'sdk');
  assert.deepEqual(logs.map(event => event.type), ['plan', 'start', 'done', 'skip']);
  assert.match(formatDownloadProgress(events[2]), /xunlei\/sdk.*1\/2.*Folder\/sub\/file.bin.*4 B\/10 B.*2 B\/s/);
});

test('unknown batch sizes remain unknown until every file size is observed', () => {
  const events = [];
  const reporter = createDownloadProgress({ platform: 'direct', files: [{ name: 'a.bin' }, { name: 'b.bin', size: 5 }], onProgress: event => events.push(event) });
  reporter.plan();
  assert.equal(events[0].batchTotal, null);
  reporter.transfer(1)({ received: 2, total: 0, speed: NaN });
  assert.equal(events.at(-1).total, null);
  reporter.event('failed', 1, { error: 'https://secret?token=secret' });
  assert.equal(events.at(-1).received, 2);
  assert.equal(events.at(-1).final, true);
  assert.doesNotMatch(JSON.stringify(events), /secret/);
  reporter.event('done', 1, { size: 3 });
  assert.equal(events.at(-1).batchTotal, 8);
});

test('native HTTP and mocked SDK pipelines emit the same lifecycle and full relative name', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-progress-native-'));
  try {
    for (const engine of ['http', 'sdk']) {
      const events = [];
      const transfer = async ({ dest, onProgress }) => {
        onProgress({ received: 2, total: 4, speed: 2, token: 'secret' });
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, 'data');
        return { size: 4 };
      };
      const share = { list: async () => [{ name: 'Folder/file.bin', gcid: 'id', size: 4 }], links: async () => new Map([['id', engine === 'sdk' ? { url: 'https://cdn.test/a', token: 'secret' } : 'https://cdn.test/a']]) };
      const result = await runPipeline({ auth: {}, share, shareUrl: 'https://pan.xunlei.com/s/a', outDir: path.join(temporary, engine), engine, httpDownloader: transfer, sdkDownloader: transfer, progress: event => events.push(event) });
      assert.equal(result.results[0].status, 'done');
      assert.deepEqual(events.map(event => event.event), ['plan', 'file', 'start', 'progress', 'verify', 'done']);
      assert.equal(events.at(-1).name, 'Folder/file.bin');
      assert.equal(events.at(-1).batchReceived, 4);
      for (const event of events) checkEvent(event, 'xunlei', engine);
      const skipped = [];
      await runPipeline({ auth: {}, share, shareUrl: 'https://pan.xunlei.com/s/a', outDir: path.join(temporary, engine), engine, sdkDownloader: transfer, progress: event => skipped.push(event) });
      assert.equal(skipped.at(-1).event, 'skip');
      assert.equal(skipped.at(-1).batchReceived, 4);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('native missing-link failure emits a sanitized terminal event and keeps failed result', async () => {
  const events = [];
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-progress-fail-'));
  try {
    const result = await runPipeline({ auth: {}, shareUrl: 'https://pan.xunlei.com/s/a', outDir: temporary, share: { list: async () => [{ name: 'Folder/a.bin', gcid: 'id', size: 4 }], links: async () => new Map() }, progress: event => events.push(event) });
    assert.equal(result.results[0].status, 'failed');
    assert.equal(events.at(-1).event, 'failed');
    assert.equal(events.at(-1).final, true);
    checkEvent(events.at(-1), 'xunlei', 'http');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('quark and 115 pipelines bridge plan start transfer verify skip and failure events', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-progress-cloud-'));
  try {
    for (const platform of ['quark', '115']) {
      const files = [{ name: 'Folder/file.bin', size: 4 }];
      const client = { resolveShare: async () => ({ files, share: {} }), resolve: async () => ({ files }), getShareDownloadLink: async () => ({ url: 'https://cdn.test/a', headers: { Cookie: 'secret' } }), link: async () => ({ url: 'https://cdn.test/a', headers: { Cookie: 'secret' } }) };
      const events = [];
      const outDir = path.join(temporary, platform);
      const options = { platform, cookie: 'secret', client, outDir, shareUrl: 'https://official.test/share', progress: event => events.push(event), httpDownloader: async ({ dest, onProgress }) => {
        onProgress({ received: 2, total: 4, speed: 3, headers: { Cookie: 'secret' } });
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, 'data');
      } };
      await runCloudPipeline(options);
      assert.deepEqual(events.map(event => event.event), ['plan', 'file', 'start', 'progress', 'verify', 'done']);
      for (const event of events) checkEvent(event, platform, 'http');
      events.length = 0;
      await runCloudPipeline(options);
      assert.equal(events.at(-1).event, 'skip');
      assert.equal(events.at(-1).batchReceived, 4);
      events.length = 0;
      const failed = await runCloudPipeline({ ...options, outDir: outDir + '-failed', httpDownloader: async () => { throw new Error('https://secret?token=secret'); } });
      assert.equal(failed.results[0].status, 'failed');
      assert.equal(events.at(-1).event, 'failed');
      assert.doesNotMatch(JSON.stringify(events), /secret/);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('direct service reports unknown size then actual completion without exposing URL', async () => {
  const events = [];
  const services = createServices({ stat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }, downloadHttp: async ({ onProgress }) => { onProgress({ received: 3, speed: 2 }); return { size: 3 }; } });
  const result = await services.direct('https://secret/file', 'file.bin', { workers: 4, chunkSize: 8388608 }, event => events.push(event));
  assert.equal(result.results[0].size, 3);
  assert.equal(result.results[0].status, 'done');
  assert.deepEqual(events.map(event => event.event), ['plan', 'start', 'progress', 'done']);
  assert.equal(events[0].batchTotal, null);
  assert.equal(events.at(-1).total, 3);
  for (const event of events) checkEvent(event, 'direct', 'http');
});
test('HTTP and SDK pipelines always reject incorrect downloaded file size', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-progress-size-'));
  try {
    for (const engine of ['http', 'sdk']) {
      const events = [];
      const transfer = async ({ dest }) => {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, 'bad');
        return { size: 3 };
      };
      const share = { list: async () => [{ name: 'file.bin', gcid: 'id', size: 4 }], links: async () => new Map([['id', engine === 'sdk' ? { url: 'https://cdn.test/a', token: 'secret' } : 'https://cdn.test/a']]) };
      const result = await runPipeline({ auth: {}, share, shareUrl: 'https://pan.xunlei.com/s/a', outDir: path.join(temporary, engine), engine, httpDownloader: transfer, sdkDownloader: transfer, progress: event => events.push(event) });
      assert.equal(result.results[0].status, 'failed');
      assert.match(result.results[0].error, /文件大小不符/);
      assert.equal(events.at(-1).event, 'failed');
      assert.ok(!events.some(event => event.event === 'done'));
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

