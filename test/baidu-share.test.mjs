import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBaiduShareUrl, openBaiduShare } from '../src/baidu-share.mjs';

const raw = 'https://pan.baidu.com/share/init?surl=UXKsspVJTdELtpzwMKkPdA&pwd=nc1i';
const metadata = { shareid: 123, uk: 456, sign: 'official-sign', timestamp: 1700000000, bdstoken: 'PRIVATE-CSRF' };
const response = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function fixture({ missingSign = false, badName = false, rejected = false, external = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, 'https://pan.baidu.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push({ url, options });
    if (url.pathname === '/share/verify') {
      assert.equal(new URLSearchParams(options.body).get('pwd'), 'nc1i');
      return response({ errno: rejected ? -9 : 0, randsk: 'PRIVATE-KEY' });
    }
    if (url.pathname.startsWith('/s/')) return new Response('yunData.setData(' + JSON.stringify({ ...metadata, ...(missingSign ? { sign: '' } : {}) }) + ');');
    if (url.pathname === '/share/list') {
      assert.equal(url.searchParams.get('shareid'), '123');
      const directory = url.searchParams.get('dir');
      if (directory === '/') return response({ errno: 0, has_more: 0, list: [{ fs_id: 1, isdir: 1, server_filename: '根目录', path: '/根目录' }] });
      if (directory === '/根目录') return response({ errno: 0, has_more: 0, list: [{ fs_id: 2, isdir: 1, server_filename: '子目录', path: '/根目录/子目录' }] });
      if (directory === '/根目录/子目录') return response({ errno: 0, has_more: 0, list: [{ fs_id: 3, isdir: 0, server_filename: badName ? '../escape' : 'file.zip', size: 8 }] });
      throw new Error('unexpected folder');
    }
    if (url.pathname === '/api/sharedownload') {
      const body = new URLSearchParams(options.body);
      assert.deepEqual(JSON.parse(body.get('fid_list')), ['3']);
      assert.deepEqual(JSON.parse(body.get('extra')), { sekey: 'PRIVATE-KEY' });
      return response({ errno: 0, list: [{ fs_id: 3, dlink: external ? 'https://evil.example/file' : 'https://d.pcs.baidu.com/file?temporary=1' }] });
    }
    throw new Error('unexpected endpoint');
  };
  return { calls, fetchImpl };
}

test('Baidu accepts official init/s links and extraction text only', () => {
  assert.deepEqual(parseBaiduShareUrl(raw), { surl: 'UXKsspVJTdELtpzwMKkPdA', password: 'nc1i', url: 'https://pan.baidu.com/s/1UXKsspVJTdELtpzwMKkPdA' });
  assert.equal(parseBaiduShareUrl('https://pan.baidu.com/s/1AbcdEF 提取码：nc1i').password, 'nc1i');
  for (const url of ['http://pan.baidu.com/s/1Abcd', 'https://pan.baidu.com.evil.test/s/1Abcd', 'https://u:p@pan.baidu.com/s/1Abcd', 'https://pan.baidu.com:444/s/1Abcd', 'https://pan.baidu.com/share/init?surl=../x', 'https://pan.baidu.com/s/1Abcd?pwd=invalid']) assert.throws(() => parseBaiduShareUrl(url));
});

test('Baidu verified share recurses with full directory names and never sends login Cookie to CDN', async () => {
  const fake = fixture();
  const opened = await openBaiduShare(raw, { cookie: 'BDUSS=PRIVATE-LOGIN' }, fake);
  assert.deepEqual(opened.files, [{ id: '3', name: '根目录/子目录/file.zip', size: 8 }]);
  assert.doesNotMatch(JSON.stringify(opened.share), /PRIVATE|sign|token|cookie|password/i);
  const link = await opened.client.getShareDownloadLink(opened.share, opened.files[0]);
  assert.equal(link.url, 'https://d.pcs.baidu.com/file?temporary=1');
  assert.equal(Object.keys(link.headers).some((key) => /cookie|authorization/i.test(key)), false);
  assert.doesNotMatch(JSON.stringify(link.headers), /PRIVATE/);
  assert.equal(fake.calls.some((call) => call.url.hostname !== 'pan.baidu.com'), false);
  await assert.rejects(opened.client.getShareDownloadLink({ ...opened.share }, opened.files[0]), /不属于/);
  await assert.rejects(opened.client.getShareDownloadLink(opened.share, { ...opened.files[0], id: '4' }), /不属于/);
});

test('Baidu rejects captcha/access failure, unsafe paths, missing download signature and untrusted CDN', async () => {
  await assert.rejects(openBaiduShare(raw, {}, fixture({ rejected: true })), /提取码|验证码/);
  await assert.rejects(openBaiduShare(raw, {}, fixture({ badName: true })), /安全|分隔符/);
  const unsigned = await openBaiduShare(raw, { cookie: 'BDUSS=PRIVATE' }, fixture({ missingSign: true }));
  await assert.rejects(unsigned.client.getShareDownloadLink(unsigned.share, unsigned.files[0]), /sign\/timestamp/);
  const foreign = await openBaiduShare(raw, { cookie: 'BDUSS=PRIVATE' }, fixture({ external: true }));
  await assert.rejects(foreign.client.getShareDownloadLink(foreign.share, foreign.files[0]), /非官方CDN/);
  const anonymous = await openBaiduShare(raw, {}, fixture());
  await assert.rejects(anonymous.client.getShareDownloadLink(anonymous.share, anonymous.files[0]), /Cookie/);
});

test('Baidu refuses repeated pagination and never evaluates website JavaScript', async () => {
  const fake = fixture();
  const fetchImpl = async (url, options) => url.pathname === '/share/list' ? response({ errno: 0, has_more: 1, list: [{ fs_id: 9, isdir: 0, server_filename: 'file.bin', size: 1 }] }) : fake.fetchImpl(url, options);
  await assert.rejects(openBaiduShare(raw, {}, { fetchImpl }), /重复|分页/);
  await assert.rejects(openBaiduShare('https://pan.baidu.com/s/1Abcd', {}, { fetchImpl: async () => new Response('yunData.setData((function(){throw Error("execute");})());') }), /元数据/);
  await assert.rejects(openBaiduShare(raw, {}, { fetchImpl: async () => { throw new Error('redirect blocked'); } }), /redirect/);
});
