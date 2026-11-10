import assert from 'node:assert/strict';
import test from 'node:test';
import { createServices, prepareShare } from '../src/cli-runtime.mjs';
import { BaiduShareClient, parseBaiduShareUrl, openBaiduShare } from '../src/baidu-share.mjs';

const raw = 'https://pan.baidu.com/share/init?surl=UXKsspVJTdELtpzwMKkPdA&pwd=nc1i';
const metadata = { shareid: 123, uk: 456 };
const response = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function fixture({ badName = false, rejected = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, 'https://pan.baidu.com');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    calls.push({ url, options });
    if (url.pathname === '/share/init') return new Response(null, { headers: { 'set-cookie': 'BAIDUID=initial-session; Path=/; Secure' } });
    if (url.pathname === '/share/verify') {
      assert.equal(new URLSearchParams(options.body).get('pwd'), 'nc1i');
      assert.match(options.headers.Cookie, /BAIDUID=initial-session/);
      return response({ errno: rejected ? -9 : 0, randsk: 'PRIVATE-KEY' });
    }
    if (url.pathname.startsWith('/s/')) return new Response('yunData.setData(' + JSON.stringify(metadata) + ');');
    if (url.pathname === '/share/list') {
      assert.equal(url.searchParams.get('shareid'), '123');
      const directory = url.searchParams.get('dir');
      if (directory === '/') return response({ errno: 0, has_more: 0, list: [{ fs_id: 1, isdir: 1, server_filename: '根目录', path: '/根目录' }] });
      if (directory === '/根目录') return response({ errno: 0, has_more: 0, list: [{ fs_id: 2, isdir: 1, server_filename: '子目录', path: '/根目录/子目录' }] });
      if (directory === '/根目录/子目录') return response({ errno: 0, has_more: 0, list: [{ fs_id: 3, isdir: 0, server_filename: badName ? '../escape' : 'file.zip', size: 8 }] });
      throw new Error('unexpected folder');
    }
    throw new Error('unexpected endpoint');
  };
  return { calls, fetchImpl };
}

test('Baidu accepts official init/s links and extraction text only', () => {
  assert.deepEqual(parseBaiduShareUrl(raw), { surl: 'UXKsspVJTdELtpzwMKkPdA', password: 'nc1i', url: 'https://pan.baidu.com/s/1UXKsspVJTdELtpzwMKkPdA' });
  assert.equal(parseBaiduShareUrl('https://pan.baidu.com/s/1AbcdEF 提取码：nc1i').password, 'nc1i');
  for (const url of ['http://pan.baidu.com:81/s/1Abcd', 'https://pan.baidu.com.evil.test/s/1Abcd', 'https://u:p@pan.baidu.com/s/1Abcd', 'https://pan.baidu.com:444/s/1Abcd', 'https://pan.baidu.com/share/init?surl=../x', 'https://pan.baidu.com/s/1Abcd?pwd=invalid']) assert.throws(() => parseBaiduShareUrl(url));
});

test('Baidu verified share recurses with full directory names and never sends login Cookie to CDN', async () => {
  const fake = fixture();
  const opened = await openBaiduShare(raw, { cookie: 'BDUSS=PRIVATE-LOGIN' }, fake);
  assert.deepEqual(opened.files, [{ id: '3', name: '根目录/子目录/file.zip', size: 8 }]);
  assert.doesNotMatch(JSON.stringify(opened.share), /PRIVATE|sign|token|cookie|password/i);
  assert.equal(fake.calls.some((call) => call.url.hostname !== 'pan.baidu.com'), false);
});

test('Baidu rejects captcha/access failure and unsafe paths', async () => {
  await assert.rejects(openBaiduShare(raw, {}, fixture({ rejected: true })), /提取码|验证码/);
  await assert.rejects(openBaiduShare(raw, {}, fixture({ badName: true })), /安全|分隔符/);
});

test('Baidu refuses repeated pagination and never evaluates website JavaScript', async () => {
  const fake = fixture();
  const fetchImpl = async (url, options) => url.pathname === '/share/list' ? response({ errno: 0, has_more: 1, list: [{ fs_id: 9, isdir: 0, server_filename: 'file.bin', size: 1 }] }) : fake.fetchImpl(url, options);
  await assert.rejects(openBaiduShare(raw, {}, { fetchImpl }), /重复|分页/);
  await assert.rejects(openBaiduShare('https://pan.baidu.com/s/1Abcd', {}, { fetchImpl: async () => new Response('yunData.setData((function(){throw Error("execute");})());') }), /元数据/);
  await assert.rejects(openBaiduShare(raw, {}, { fetchImpl: async () => { throw Object.assign(new Error('https://private/?cookie=SECRET'), { cause: { code: 'ECONNRESET' } }); } }), /ECONNRESET/);
});

test('Baidu normalizes both user link formats before CLI dispatch', () => {
  const links = ['https://pan.baidu.com/share/init?surl=JW47AauAJQcnHKDwGT6KYw&pwd=t5by', 'http://pan.baidu.com/s/1JW47AauAJQcnHKDwGT6KYw?pwd=t5by#list/path=%2F&vmode=list'];
  for (const link of links) {
    assert.deepEqual(parseBaiduShareUrl(link), { surl: 'JW47AauAJQcnHKDwGT6KYw', password: 't5by', url: 'https://pan.baidu.com/s/1JW47AauAJQcnHKDwGT6KYw' });
    const prepared = prepareShare(link);
    assert.equal(prepared.platform, 'baidu');
    assert.ok(prepared.raw.startsWith('https://pan.baidu.com/'));
    assert.equal(parseBaiduShareUrl(prepared.raw).password, 't5by');
  }
  for (const link of ['http://pan.quark.cn/s/abcd', 'http://pan.baidu.com.evil.test/s/1Abcd', 'http://u:p@pan.baidu.com/s/1Abcd']) assert.throws(() => prepareShare(link));
});

test('Baidu redirects stay on HTTPS official origin and retain only share cookies', async () => {
  const calls = [];
  const client = new BaiduShareClient({ cookie: 'BDUSS=PRIVATE' }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: '/share/init?surl=Abcd', 'set-cookie': 'BDCLND=share-session; Path=/; Secure' } });
    assert.equal(url.origin, 'https://pan.baidu.com');
    assert.equal(options.headers.Cookie, 'BDUSS=PRIVATE; BDCLND=share-session');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return response({ errno: 0 });
  } });
  await client.request('/share/verify', {}, { pwd: 'abcd' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  for (const location of ['https://evil.example/', 'https://pan.baidu.com.evil.test/', 'http://pan.baidu.com/', 'https://u:p@pan.baidu.com/', 'https://pan.baidu.com:444/']) {
    let count = 0;
    const blocked = new BaiduShareClient({ cookie: 'BDUSS=PRIVATE' }, { fetchImpl: async () => { count++; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(blocked.request('/s/1Abcd'), /拒绝/);
    assert.equal(count, 1);
  }
  const login = new BaiduShareClient({ cookie: 'BDUSS=PRIVATE' }, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://passport.baidu.com/v3/login/api/auth/' } }) });
  await assert.rejects(login.request('/s/1Abcd'), /login baidu/);
  let count = 0;
  const looping = new BaiduShareClient({}, { fetchImpl: async () => { count++; return new Response(null, { status: 302, headers: { location: '/s/1Abcd' } }); } });
  await assert.rejects(looping.request('/s/1Abcd'), /次数/);
  assert.equal(count, 6);
});

test('Baidu network errors expose a safe code instead of fetch failed or credentials', async () => {
  const client = new BaiduShareClient({}, { fetchImpl: async () => { throw Object.assign(new Error('SECRET https://private/?pwd=secret'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(client.request('/s/1Abcd'), error => /ENOTFOUND/.test(error.message) && !/SECRET|pwd=|fetch failed/.test(error.message));
});

test('Baidu download is rejected: list-only, no 转存/直链', async () => {
  const services = createServices({});
  await assert.rejects(services.download(prepareShare(raw), 'downloads', { engine: 'http' }, () => {}), /暂不支持百度/);
});
