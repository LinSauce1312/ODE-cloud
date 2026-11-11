import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGuangyaShareUrl, GuangyaShareClient, openGuangyaShare } from '../src/guangya-share.mjs';

const reply = (data, code = 0) => new Response(JSON.stringify({ code, data }), { headers: { 'content-type': 'application/json' } });

test('光鸭只解析官方 HTTPS /s/ 分享与访问码', () => {
  assert.deepEqual(parseGuangyaShareUrl('https://www.guangyapan.com/s/share123?code=abcd'), { shareId: 'share123', password: 'abcd', url: 'https://www.guangyapan.com/s/share123' });
  for (const url of ['https://www.guangyapan.com.evil.test/s/x', 'http://www.guangyapan.com/s/x', 'https://www.guangyapan.com/other', 'https://user@www.guangyapan.com/s/x']) assert.throws(() => parseGuangyaShareUrl(url));
  assert.throws(() => parseGuangyaShareUrl('https://www.guangyapan.com/s/%E0%A4%A'), /编码无效/);
});

test('光鸭分享令牌、递归列举与选中取链，全部无账号凭据', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = new URL(url);
    const body = JSON.parse(options.body);
    calls.push({ request, body });
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['X-Captcha-Token'], undefined);
    if (request.pathname.endsWith('/get_share_access_token')) {
      assert.deepEqual(body, { shareId: 'share123', code: 'abcd' });
      return reply({ accessToken: 'token123' });
    }
    if (request.pathname.endsWith('/get_share_page_files_list')) {
      assert.equal(body.accessToken, 'token123');
      return body.parent_id === ''
        ? reply({ list: [{ fileId: 'folder1', fileName: '目录', resType: 2 }, { fileId: 'file1', fileName: '根.txt', size: 3 }] })
        : reply({ list: [{ fileId: 'file2', fileName: '目标.bin', size: 9 }], hasMore: false });
    }
    assert.equal(request.pathname, '/userres/v1/get_share_download_url');
    assert.deepEqual(body, { accessToken: 'token123', fileId: 'file2', download: true });
    return reply({ downloadUrl: 'https://cdn.guangyapan.com/file?sign=abc' });
  };
  const opened = await openGuangyaShare('https://www.guangyapan.com/s/share123?code=abcd', { fetchImpl });
  assert.deepEqual(opened.files.map(({ name, size }) => [name, size]), [['目录/目标.bin', 9], ['根.txt', 3]]);
  const link = await opened.client.getShareDownloadLink(opened.share, opened.files[0]);
  assert.equal(link.url, 'https://cdn.guangyapan.com/file?sign=abc');
  assert.equal(link.size, 9);
  assert.equal(calls.length, 4);
});

test('光鸭免登录关闭、验证过期、跨域与路径穿越都安全失败', async () => {
  await assert.rejects(openGuangyaShare('https://www.guangyapan.com/s/a', { fetchImpl: async () => reply(null, 207) }), /未开启免登录/);
  await assert.rejects(openGuangyaShare('https://www.guangyapan.com/s/a', { fetchImpl: async () => reply(null, 9) }), /验证已过期/);
  await assert.rejects(openGuangyaShare('https://www.guangyapan.com/s/a', { fetchImpl: async () => new Response('{"code":"weird"}', { headers: { 'content-type': 'application/json' } }) }), /未知状态码/);
  const redirect = new GuangyaShareClient({ fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }) });
  await assert.rejects(redirect.open('https://www.guangyapan.com/s/a'), /HTTP 302/);
  const traversal = new GuangyaShareClient({ fetchImpl: async (url) => reply(new URL(url).pathname.endsWith('/get_share_access_token') ? { accessToken: 'abc' } : { list: [{ fileId: 'x1', fileName: '../evil', size: 1 }] }) });
  await assert.rejects(traversal.open('https://www.guangyapan.com/s/a'), /路径|文件名/);
});
