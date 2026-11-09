import assert from 'node:assert/strict';
import { GameAssistantShare, safeSharePath, isCloudShare } from '../lib/game-share.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const calls = [];
const server = http.createServer((request, response) => {
  const content = Buffer.from('expected content');
  if (request.method === 'HEAD') {
    response.writeHead(200, { 'content-length': content.length, 'accept-ranges': 'bytes' });
    response.end();
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
  if (!match) { response.writeHead(400); response.end(); return; }
  const start = Number(match[1]);
  const end = Number(match[2]);
  response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${content.length}` });
  response.end(content.subarray(start, end + 1));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fileUrl = `http://127.0.0.1:${server.address().port}/file`;
const fetchImpl = async (url, options) => {
  const endpoint = url.pathname.split('/').pop();
  const body = JSON.parse(options.body);
  calls.push({ endpoint, body, headers: options.headers });
  const data = endpoint === 'TransferSpeedURL'
    ? { shareFiles: [{ fileName: 'Game/readme.txt', gcid: 'hash1', fileSize: 16 }] }
    : { speedInfos: [{ gcid: 'hash1', url: fileUrl, token: 'not-used' }] };
  return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
};
const auth = { deviceId: 'device123', cred: {}, ensureFresh: async () => 'test-access-token' };
const share = new GameAssistantShare(auth, { fetchImpl });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xunlei-share-test-'));
try {
  assert.equal(isCloudShare('https://pan.xunlei.com/s/test'), true);
  assert.equal(isCloudShare('https://pan.xunlei.com.evil.test/s/test'), false);
  for (const bad of ['../outside', 'Game/../outside', '/root', 'C:\\windows\\file', 'Game/con.txt.']) {
    assert.throws(() => safeSharePath(bad));
  }
  const files = await share.list('https://pan.xunlei.com/s/test');
  assert.deepEqual(files.map((file) => file.name), ['Game/readme.txt']);
  const result = await runPipeline({ auth, share, shareUrl: 'https://pan.xunlei.com/s/test', outDir: root });
  assert.equal(result.results[0].status, 'done');
  assert.equal(result.results[0].verified, 'size');
  assert.equal(await fs.readFile(path.join(root, 'Game', 'readme.txt'), 'utf8'), 'expected content');
  assert.deepEqual(calls.map((call) => call.endpoint), ['TransferSpeedURL', 'TransferSpeedURL', 'ParseFileURL']);
  assert.deepEqual(calls[2].body, { gcids: ['hash1'] });
  assert.equal(calls[2].headers.Authorization, 'Bearer test-access-token');
  const selectedLinks = [];
  const selectionShare = {
    list: async () => [
      { name: 'Game/readme.txt', gcid: 'hash1', size: 16 },
      { name: 'Game/extra.txt', gcid: 'hash2', size: 16 },
    ],
    links: async (gcids, options) => {
      selectedLinks.push({ gcids, options });
      return new Map([['hash1', options.withTokens ? { url: fileUrl, token: 'test-token' } : fileUrl]]);
    },
  };
  for (const engine of ['http', 'sdk']) {
    const selected = await runPipeline({ auth, share: selectionShare, shareUrl: 'https://pan.xunlei.com/s/test', outDir: root,
      files: ['Game\\readme.txt'], engine });
    assert.deepEqual(selected.results.map((file) => file.name), ['Game/readme.txt']);
    assert.deepEqual(selectedLinks.at(-1), { gcids: ['hash1'], options: { withTokens: engine === 'sdk' } });
    await assert.rejects(runPipeline({ auth, share: selectionShare, shareUrl: 'https://pan.xunlei.com/s/test', outDir: root,
      files: ['Game/missing.txt'], engine }), /未找到文件/);
  }
  assert.equal(selectedLinks.length, 2);
  console.log('PASS: 分享协议两步解析、账户请求头、路径防护、串行下载');
} finally {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
}
