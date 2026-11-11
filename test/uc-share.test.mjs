import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUcShareUrl, UcShareClient, openUcShare } from '../src/uc-share.mjs';

const reply = (data, code = 0) => new Response(JSON.stringify({ code, data }), { headers: { 'content-type': 'application/json' } });

test('UC 只解析官方 HTTPS 分享和四位提取码', () => {
  assert.deepEqual(parseUcShareUrl('链接：https://drive.uc.cn/s/abc123 提取码：aB12'), { shareId: 'abc123', password: 'aB12', url: 'https://drive.uc.cn/s/abc123' });
  for (const url of ['https://drive.uc.cn.evil.test/s/abc', 'http://drive.uc.cn/s/abc', 'https://drive.uc.cn/other/abc', 'https://user@drive.uc.cn/s/abc']) assert.throws(() => parseUcShareUrl(url));
});

test('UC 游客分享递归列举并按选中文件获取直链，无账号凭据', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = new URL(url);
    calls.push({ request, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined);
    if (request.pathname.endsWith('/token')) {
      assert.deepEqual(JSON.parse(options.body), { pwd_id: 'share123', passcode: '', share_for_transfer: true });
      return reply({ stoken: 'token123' });
    }
    if (request.pathname.endsWith('/detail')) {
      assert.equal(request.searchParams.get('stoken'), 'token123');
      return reply({ list: request.searchParams.get('pdir_fid') === '0'
        ? [{ fid: 'folder', file_name: '目录', file: false }, { fid: 'file1', share_fid_token: 'ft1', file_name: '根.txt', size: 3, file: true }]
        : [{ fid: 'file2', share_fid_token: 'ft2', file_name: '目标.bin', size: 9, file: true }] });
    }
    assert.equal(request.pathname, '/1/clouddrive/file/download');
    assert.deepEqual(JSON.parse(options.body), { fids: ['file2'], fids_token: ['ft2'], pwd_id: 'share123', stoken: 'token123' });
    return reply([{ download_url: 'https://cdn.uc.cn/file?sign=abc', size: 9 }]);
  };
  const opened = await openUcShare('https://drive.uc.cn/s/share123', { fetchImpl });
  assert.deepEqual(opened.files.map(({ name, size }) => [name, size]), [['目录/目标.bin', 9], ['根.txt', 3]]);
  const link = await opened.client.getShareDownloadLink(opened.share, opened.files[0]);
  assert.equal(link.url, 'https://cdn.uc.cn/file?sign=abc');
  assert.equal(link.size, 9);
  assert.equal(calls.length, 4);
});

test('UC 游客限制、跨域重定向和路径穿越都安全失败', async () => {
  const client = new UcShareClient({ fetchImpl: async () => reply(null, 23018) });
  await assert.rejects(client.getShareDownloadLink({ pwd_id: 'a', stoken: 'b' }, { id: 'c', token: 'd' }), /游客下载超出/);
  const redirect = new UcShareClient({ fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }) });
  await assert.rejects(redirect.open('https://drive.uc.cn/s/abc'), /HTTP 302/);
  const traversal = new UcShareClient({ fetchImpl: async (url) => reply(new URL(url).pathname.endsWith('/token') ? { stoken: 'abc' } : { list: [{ fid: 'abc', file_name: '../evil', file: true, size: 1, share_fid_token: 'ft' }] }) });
  await assert.rejects(traversal.open('https://drive.uc.cn/s/abc'), /路径|文件名/);
  const offline = new UcShareClient({ fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(offline.open('https://drive.uc.cn/s/abc'), /网络请求失败（ENOTFOUND）/);
  const auth = new UcShareClient({ fetchImpl: async () => reply(null, 31001) });
  await assert.rejects(auth.open('https://drive.uc.cn/s/abc'), /要求登录/);
});
