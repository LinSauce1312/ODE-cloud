import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openTianyiShare, parseTianyiShareUrl } from '../src/tianyi-share.mjs';

function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}

test('only parses official Tianyi share URLs and extraction codes', () => {
  assert.deepEqual(parseTianyiShareUrl('链接：https://cloud.189.cn/t/AbC-123 提取码：9x8z'), { shareCode: 'AbC-123', accessCode: '9x8z' });
  assert.deepEqual(parseTianyiShareUrl('https://cloud.189.cn/t/ABC?pwd=abcd'), { shareCode: 'ABC', accessCode: 'abcd' });
  assert.deepEqual(parseTianyiShareUrl('https://cloud.189.cn/web/share?code=XYZ&pwd=abcd'), { shareCode: 'XYZ', accessCode: 'abcd' });
  assert.throws(() => parseTianyiShareUrl('https://cloud.189.cn/web/share?code='), /分享码/);
  for (const raw of ['https://cloud.189.cn.evil.test/t/ABC', 'http://cloud.189.cn/t/ABC', 'https://cloud.189.cn/t/../ABC']) {
    assert.throws(() => parseTianyiShareUrl(raw));
  }
});

test('checks extraction code, paginates nested folders and signs a fresh official download URL', async () => {
  const calls = [];
  let accessRequests = 0;
  const fetchImpl = async (raw, options) => {
    const url = new URL(raw);
    calls.push({ url, options });
    if (url.pathname.endsWith('/checkAccessCode.action')) {
      assert.equal(url.searchParams.get('accessCode'), '0123');
      return reply({ shareId: 'share-1' });
    }
    if (url.pathname.endsWith('/getShareInfoByCodeV2.action')) return reply({ shareId: 'share-1', fileId: 'root', isFolder: true });
    if (url.pathname.endsWith('/listShareDir.action')) {
      assert.equal(url.searchParams.get('shareMode'), '1');
      assert.equal(url.searchParams.get('accessCode'), '0123');
      assert.equal(options.headers['Sign-Type'], '1');
      const folder = url.searchParams.get('fileId');
      const page = Number(url.searchParams.get('pageNum'));
      if (folder === 'root' && page === 1) return reply({ fileListAO: { folderList: [{ id: 'sub', name: '软件' }], fileList: Array.from({ length: 299 }, (_, index) => ({ id: `root-${index}`, name: `part-${index}.zip`, size: 4 })) } });
      if (folder === 'root') return reply({ fileListAO: { folderList: [], fileList: [{ id: 'extra', name: 'extra.zip', size: 8 }] } });
      if (folder === 'sub') return reply({ fileListAO: { folderList: [], fileList: [{ id: 'file1', name: 'demo.zip', size: 7 }] } });
    }
    if (url.pathname.endsWith('/ssoH5.action')) {
      accessRequests += 1;
      assert.equal(options.headers.Cookie, 'session=test');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: '/open/oauth2/ssoH5.action?accessToken=token-xyz' } });
    }
    if (url.pathname.endsWith('/getFileDownloadUrl.action')) {
      assert.equal(url.origin, 'https://api.cloud.189.cn');
      assert.equal(url.searchParams.get('dt'), '1');
      assert.equal(url.searchParams.get('fileId'), 'file1');
      const timestamp = options.headers.Timestamp;
      const expected = createHash('md5').update(`AccessToken=token-xyz&Timestamp=${timestamp}&dt=1&fileId=file1&shareId=share-1`).digest('hex');
      assert.equal(options.headers.Signature, expected);
      assert.equal(options.headers.Accesstoken, 'token-xyz');
      assert.equal(options.headers.Cookie, 'session=test');
      return reply({ res_code: 0, fileDownloadUrl: 'https://cdn.example.test/file.zip?signature=abc' });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const opened = await openTianyiShare('https://cloud.189.cn/t/ABC 提取码：0123', { cookie: 'session=test' }, { fetchImpl });
  assert.equal(opened.files.length, 301);
  const file = opened.files.find((item) => item.id === 'file1');
  assert.equal(file.name, '软件/demo.zip');
  const first = await opened.client.getShareDownloadLink(opened.share, file);
  assert.deepEqual(first, { url: 'https://cdn.example.test/file.zip?signature=abc', headers: {}, size: 7 });
  await opened.client.getShareDownloadLink(opened.share, file);
  assert.equal(accessRequests, 2);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/getFileDownloadUrl.action')).length, 2);
  assert.equal(calls.filter(({ url }) => url.hostname === 'cdn.example.test').length, 0);
});

test('handles public single-file shares without a login or transfer during listing', async () => {
  const calls = [];
  const opened = await openTianyiShare('https://cloud.189.cn/t/Public', null, { fetchImpl: async (raw) => {
    const url = new URL(raw);
    calls.push(url);
    if (url.pathname.endsWith('/getShareInfoByCodeV2.action')) return reply({ shareId: 'share', fileId: 'single', isFolder: false, name: 'single.zip', size: 12 });
    if (url.pathname.endsWith('/listShareDir.action')) {
      assert.equal(url.searchParams.get('shareMode'), '3');
      assert.equal(url.searchParams.get('isFolder'), 'false');
      return reply({ fileListAO: { folderList: [], fileList: [] } });
    }
    throw new Error('Unexpected request');
  } });
  assert.deepEqual(opened.files.map((file) => file.name), ['single.zip']);
  assert.equal(calls.length, 2);
  await assert.rejects(() => opened.client.getShareDownloadLink(opened.share, opened.files[0]), /未登录/);
});

test('does not forward login Cookie on untrusted SSO redirects or download hosts', async () => {
  const client = (await openTianyiShare('https://cloud.189.cn/t/ABC', { cookie: 'secret=1' }, { fetchImpl: async (raw) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/getShareInfoByCodeV2.action')) return reply({ shareId: 's', fileId: 'f', isFolder: false, name: 'safe.bin' });
    if (url.pathname.endsWith('/listShareDir.action')) return reply({ fileListAO: { folderList: [], fileList: [] } });
    if (url.pathname.endsWith('/ssoH5.action')) return new Response(null, { status: 302, headers: { Location: 'https://attacker.test/token' } });
    throw new Error('Redirect must never be followed');
  } })).client;
  await assert.rejects(() => client.accessToken(), /非官方/);
});
