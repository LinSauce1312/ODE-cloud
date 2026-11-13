import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadSdk } from '../lib/sdk-engine.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { GameAssistantShare } from '../lib/game-share.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p2sp-mock-'));
const dest = path.join(root, 'Game', 'file.bin');
const content = Buffer.from('authorized file');
const calls = [];
const addon = {
  init: (options) => { calls.push(['init', options]); return 9000; },
  createP2spTask: (options) => { calls.push(['create', options]); return { errno: 9000, taskId: 7 }; },
  setOriginUserAgent: (...args) => { calls.push(['user-agent', ...args]); return 9000; },
  startTask: (taskId) => { calls.push(['start', taskId]); return 9000; },
  setAccelerateToken: (...args) => { calls.push(['token', ...args]); },
  getTaskInfo: () => ({ status: 2, download_size: content.length, file_size: content.length, download_speed: 0 }),
  stopTask: (taskId) => { calls.push(['stop', taskId]); },
  releaseTask: (taskId) => { calls.push(['release', taskId]); },
  unInit: () => { calls.push(['uninit']); },
};
const auth = { deviceId: 'device123', cred: { peerId: 'testPeerId' }, ensureFresh: async () => 'own-access-token' };
try {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content);
  const result = await downloadSdk({
    url: 'https://example.com/file', dest, size: content.length, token: 'signed-token', auth, addon,
    headers: { Cookie: 'sid=abc', Referer: 'https://pan.quark.cn/s/1', 'User-Agent': 'yunx-test/1.0' },
    sdkDataDir: path.join(root, 'sdk'),
  });
  assert.equal(result.size, content.length);
  assert.ok(calls.findIndex(([name]) => name === 'token') < calls.findIndex(([name]) => name === 'start'), '加速 token 必须在任务启动前设置');
  assert.equal(calls.find(([name]) => name === 'init')[1].peerId, 'testPeerId');
  assert.equal(calls.find(([name]) => name === 'create')[1].filePath, path.dirname(dest));
  assert.equal(calls.find(([name]) => name === 'create')[1].cookie, 'sid=abc');
  assert.equal(calls.find(([name]) => name === 'create')[1].refUrl, 'https://pan.quark.cn/s/1');
  assert.deepEqual(calls.find(([name]) => name === 'user-agent'), ['user-agent', 7, 'yunx-test/1.0']);
  await assert.rejects(
    downloadSdk({ url: 'https://example.com/file', dest, size: content.length, auth, addon, headers: { Authorization: 'secret' } }),
    /不支持这些请求头/,
  );
  assert.deepEqual(calls.find(([name]) => name === 'token'), ['token', 7, -1, { accelerateType: 1, jwt: 'signed-token' }]);
  assert.deepEqual(calls.slice(-2).map(([name]) => name), ['release', 'uninit']);

  const failedTokenCalls = [];
  const failedTokenAddon = {
    ...addon,
    createP2spTask: (options) => { failedTokenCalls.push(['create', options]); return { errno: 9000, taskId: 8 }; },
    setAccelerateToken: () => { failedTokenCalls.push(['token']); return 9001; },
    startTask: () => { failedTokenCalls.push(['start']); return 9000; },
    releaseTask: () => { failedTokenCalls.push(['release']); },
    unInit: () => { failedTokenCalls.push(['uninit']); },
  };
  await assert.rejects(
    downloadSdk({ url: 'https://example.com/file', dest, size: content.length, token: 'bad-token', auth, addon: failedTokenAddon }),
    /设置加速 Token 失败：9001/,
  );
  assert.deepEqual(failedTokenCalls.map(([name]) => name), ['create', 'token', 'release', 'uninit']);

  const share = new GameAssistantShare(auth, { fetchImpl: async (url) => ({
    ok: true, status: 200, json: async () => ({ code: 0, data: url.pathname.endsWith('TransferSpeedURL')
      ? { shareFiles: [{ fileName: 'Game/file.bin', gcid: 'gcid', fileSize: content.length }] }
      : { speedInfos: [{ gcid: 'gcid', url: 'https://example.com/file', token: 'signed-token' }] } }),
  }) });
  await fs.rm(dest);
  const fromPipeline = await runPipeline({
    auth, share, shareUrl: 'https://pan.xunlei.com/s/test', outDir: root, engine: 'sdk',
    sdkDownloader: async (options) => {
      assert.equal(options.token, 'signed-token');
      assert.equal(options.url, 'https://example.com/file');
      await fs.writeFile(options.dest, content);
      return { size: content.length, path: options.dest };
    },
  });
  assert.equal(fromPipeline.results[0].status, 'done');
  assert.equal(fromPipeline.results[0].verified, 'size');
  const mismatch = await runPipeline({
    auth, share, shareUrl: 'https://pan.xunlei.com/s/test', outDir: path.join(root, 'bad'), engine: 'sdk',
    sdkDownloader: async (options) => {
      await fs.mkdir(path.dirname(options.dest), { recursive: true });
      await fs.writeFile(options.dest, content.subarray(1));
      return { size: content.length, path: options.dest };
    },
  });
  assert.equal(mismatch.results[0].status, 'failed');
  assert.match(mismatch.results[0].error, /文件大小不符/);
  console.log('PASS: SDK 参数、凭证透传、大小核对和分享编排');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
