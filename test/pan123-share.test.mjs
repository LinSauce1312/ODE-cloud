import test from 'node:test';
import assert from 'node:assert/strict';
import { makePan123Sign, parsePan123Share, openPan123Share } from '../src/pan123-share.mjs';

function response(data, options = {}) { return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...options.headers }, status: options.status || 200 }); }

const root = { code: 0, data: { Next: '', InfoList: [{ FileId: '12', FileName: 'folder', Type: 1, Size: 0 }, { FileId: '11', FileName: 'root.zip', Type: 0, Size: 5, S3KeyFlag: 'flag', Etag: 'etag' }] } };

test('accepts only actual 123 share hosts and paths, extracts password from text', () => {
  assert.deepEqual(parsePan123Share('https://www.123pan.com/s/Ab12-Z9?pwd=1234'), { shareKey: 'Ab12-Z9', password: '1234' });
  assert.deepEqual(parsePan123Share('共享 https://www.123865.com/s/Ab12-Z9 提取码：abcd'), { shareKey: 'Ab12-Z9', password: 'abcd' });
  assert.throws(() => parsePan123Share('https://www.123pan.com.attacker.test/s/Ab12-Z9'), /不支持/);
  assert.throws(() => parsePan123Share('https://www.123pan.com.evil/s/Ab12-Z9'), /不支持/);
  assert.throws(() => parsePan123Share('https://www.123pan.com/s/Ab12-Z9/other'), /不支持/);
  assert.throws(() => parsePan123Share('http://www.123pan.com/s/Ab12-Z9'), /HTTPS/);
});

test('anonymous listing keeps fixed next=0, advances Page, recurses with bounded paths', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ parsed, options });
    assert.equal(parsed.hostname, 'yun.123pan.cn');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'manual');
    if (parsed.searchParams.get('ParentFileId') === '12') return response({ code: 0, data: { Next: '-1', InfoList: [{ FileId: '31', FileName: 'nested.bin', Size: 9, Type: 0, S3KeyFlag: 'child', Etag: 'nested' }] } });
    if (parsed.searchParams.get('Page') === '2') return response({ code: 0, data: { Next: '-1', InfoList: [] } });
    return response(root);
  };
  const { files, share, client } = await openPan123Share('https://www.123pan.com/s/Ab12-Z9 提取码：abcd', { token: 'secret' }, { fetchImpl: fakeFetch });
  assert.deepEqual(files.map((file) => file.name), ['root.zip', 'folder/nested.bin']);
  assert.equal(share.password, 'abcd');
  assert.equal(typeof client.getShareDownloadLink, 'function');
  assert.deepEqual(calls.map(({ parsed }) => parsed.searchParams.get('Page')), ['1', '2', '1']);
  assert.ok(calls.every(({ parsed }) => parsed.searchParams.get('next') === '0' && parsed.searchParams.get('SharePwd') === 'abcd'));
});

test('signed official download lookup decodes wrapper and probes token-free CDN JSON redirects', async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return response({ code: 0, data: { Next: '-1', InfoList: [{ FileId: '11', FileName: 'root.zip', Type: 0, Size: 5, S3KeyFlag: 'flag', Etag: 'etag' }] } });
    if (requests.length === 2) return response({ code: 0, data: { DownloadURL: `https://www.123865.com/download-v2?params=${Buffer.from('https://cdn.example.test/step?auto_redirect=0').toString('base64url')}` } });
    if (requests.length === 3) return response({ code: 0, data: { redirect_url: 'https://cdn.example.test/end' } });
    return new Response('not a JSON redirect', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '999999' } });
  };
  const { files, share, client } = await openPan123Share('https://www.123865.com/s/Ab12-Z9', { token: 'test-token' }, { fetchImpl: fakeFetch, loginUuid: '0123456789abcdef0123456789abcdef' });
  const link = await client.getShareDownloadLink(share, files[0]);
  assert.deepEqual(link, { url: 'https://cdn.example.test/end', headers: { Referer: 'https://yun.123pan.cn/', 'User-Agent': 'Dart/3.12 (dart:io)' }, size: 5 });
  assert.equal(new URL(requests[1].url).hostname, 'www.123865.com');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers.authorization, 'Bearer test-token');
  assert.equal(requests[1].options.headers.loginuuid, '0123456789abcdef0123456789abcdef');
  assert.match(requests[1].options.headers['auth-key'], /^[0-9a-f]{1,8}$/);
  assert.match(requests[1].options.headers['auth-value'], /^\d+-\d+-[0-9a-f]{1,8}$/);
  assert.equal(requests[1].options.headers.platform, 'android');
  assert.equal(requests[1].options.headers['app-version'], '39');
  assert.deepEqual(JSON.parse(requests[1].options.body), { ShareKey: 'Ab12-Z9', FileID: '11', S3KeyFlag: 'flag', Size: 5, Etag: 'etag' });
  assert.ok(requests.slice(2).every(({ options }) => !JSON.stringify(options.headers).includes('test-token') && options.redirect === 'manual'));
});

test('does not send token to redirecting official API and rejects bad responses', async () => {
  const clientFetch = async (url, options) => options.method === 'POST'
    ? new Response('', { status: 302, headers: { Location: 'https://evil.test/token' } })
    : response({ code: 0, data: { Next: '-1', InfoList: [{ FileId: '11', FileName: 'ok', Type: 0, Size: 1, S3KeyFlag: 'flag', Etag: 'etag' }] } });
  const { files, share, client } = await openPan123Share('https://www.123865.com/s/Ab12-Z9', { token: 'secret' }, { fetchImpl: clientFetch, loginUuid: '0123456789abcdef0123456789abcdef' });
  await assert.rejects(client.getShareDownloadLink(share, files[0]), /HTTP 302/);
  await assert.rejects(openPan123Share('https://www.123pan.com/s/Ab12-Z9', null, { fetchImpl: async () => response({ code: 42, message: 'private-secret' }) }), (error) => error.message.includes('code=42') && !error.message.includes('private-secret'));
  await assert.rejects(openPan123Share('https://www.123pan.com/s/Ab12-Z9', null, { fetchImpl: async () => response({ code: 0, data: { Expired: true, Next: '-1', InfoList: [] } }) }), /失效/);
});

test('uses deterministic CRC32 signature with fixed time and random input', () => {
  const signed = makePan123Sign('/b/api/share/download/info', 1700000000, 123456);
  assert.match(signed.authKey, /^[0-9a-f]{1,8}$/);
  assert.match(signed.authValue, /^1700000000-123456-[0-9a-f]{1,8}$/);
  assert.deepEqual(signed, makePan123Sign('/b/api/share/download/info', 1700000000, 123456));
  assert.throws(() => makePan123Sign('/unexpected'), /无效/);
});

test('makePan123Sign now accepts any /b/api/ path (user/info etc.), not only download/info', () => {
  // YunX 对齐：签名算法对所有 yun.123pan.cn 鉴权接口通用，旧版只允许 download/info 会挡住 user/info 校验。
  const signed = makePan123Sign('/b/api/user/info', 1700000000, 999999);
  assert.match(signed.authKey, /^[0-9a-f]{1,8}$/);
  assert.match(signed.authValue, /^1700000000-999999-[0-9a-f]{1,8}$/);
  assert.throws(() => makePan123Sign('/api/user/info'), /无效/);
});

