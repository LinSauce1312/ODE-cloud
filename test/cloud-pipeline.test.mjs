import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCloudPipeline } from '../lib/cloud-pipeline.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xlp-cloud-'));
const content = Buffer.from('sample file');
const auth = { deviceId: 'local-device', cred: { accessToken: 'local-token' }, loggedIn: true };
const file = { name: 'Folder/item.bin', size: content.length, id: '1' };
let linked = 0;
const client = {
  async resolveShare() { return { share: { token: 'share' }, files: [file] }; },
  async resolve() { return { files: [file] }; },
  async getShareDownloadLink() { linked += 1; return { url: 'https://example.com/item', headers: { Cookie: 'quark=session', Referer: 'https://pan.quark.cn/', 'User-Agent': 'test-agent' }, size: content.length }; },
  async link() { linked += 1; return { url: 'https://example.com/item', headers: { cookie: 'UID=login; CDN=short-lived', referer: 'https://115cdn.com/', 'user-agent': 'test-agent' }, size: content.length }; },
};
try {
  for (const platform of ['quark', '115']) {
    const output = path.join(root, platform);
    const result = await runCloudPipeline({
      platform, cookie: 'session-cookie', shareUrl: platform === '115' ? 'https://115.com/s/sw1' : 'https://pan.quark.cn/s/1',
      auth, outDir: output, client, httpDownloader: async ({ dest, headers }) => {
        assert.match(headers.Cookie || headers.cookie, platform === '115' ? /UID=login; CDN=short-lived/ : /quark=session/);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content);
        return { size: content.length, path: dest };
      },
    });
    assert.equal(result.results[0].status, 'done');
    assert.equal(result.results[0].verified, 'size');
    assert.equal((await fs.readFile(path.join(output, 'Folder', 'item.bin'))).toString(), content.toString());
    await runCloudPipeline({ platform, cookie: 'session-cookie', shareUrl: 'https://pan.quark.cn/s/1', outDir: output, client, httpDownloader: () => { throw new Error('already exists'); } });
  }
  assert.equal(linked, 2, '已存在文件不重复请求短期直链');
  await assert.rejects(runCloudPipeline({ platform: '115', cookie: 'x', engine: 'sdk', outDir: root, client }), /只支持直链 HTTP Range/);
  const invalidClient = { ...client, async resolveShare() { return { share: {}, files: [{ ...file, name: '../escape.bin' }] }; } };
  await assert.rejects(runCloudPipeline({ platform: 'quark', cookie: 'x', auth, outDir: root, client: invalidClient }), /不安全/);
  console.log('PASS: 夸克/115 短期 Cookie、串行下载、已存在跳过及路径防护');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
