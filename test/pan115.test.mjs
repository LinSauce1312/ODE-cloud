import assert from 'node:assert/strict';
import test from 'node:test';
import { Pan115Share, Pan115Api, Pan115Credential, cookieFromSetCookie, mergeCookies, parse115ShareUrl } from '../lib/pan115.mjs';

const response = (json, cookies = []) => ({ ok: true, status: 200, text: async () => JSON.stringify(json), headers: { getSetCookie: () => cookies } });

test('115 credential and share URL parsing', () => {
  const credential = new Pan115Credential('UID=12345_A1_x; SEID=s; UID=other');
  assert.equal(credential.loggedIn, true);
  assert.equal(credential.userId, '12345');
  assert.deepEqual(parse115ShareUrl('https://115cdn.com/s/swABC123?password=pwd1'), { shareCode: 'swABC123', receiveCode: 'pwd1' });
  assert.equal(mergeCookies('UID=1; SID=a', 'SID=b; fid=cdn'), 'UID=1; SID=b; fid=cdn');
});

test('nested share listing paginates and keeps password and owner', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const cid = u.searchParams.get('cid');
    const offset = Number(u.searchParams.get('offset'));
    if (cid === '0' && offset === 0) {
      return response({ state: true, data: { count: 101, userinfo: { user_id: '9988' }, shareinfo: { share_title: 'demo' }, list: [{ fc: 0, cid: 'dir', n: 'Folder' }, ...Array.from({ length: 99 }, (_, i) => ({ fc: 1, fid: `f${i}`, n: `a${i}`, s: i }))] } });
    }
    if (cid === '0' && offset === 100) return response({ state: true, data: { count: 101, userinfo: { user_id: '9988' }, list: [{ fc: 1, fid: 'last', n: 'last.bin', s: 10 }] } });
    if (cid === 'dir') return response({ state: true, data: { count: 1, userinfo: { user_id: '9988' }, list: [{ fc: 1, fid: 'nested', n: 'x.txt', s: 2 }] } });
    throw new Error(`unexpected ${url}`);
  };
  const share = new Pan115Share({ cookie: 'UID=local_A1_x; SEID=s', fetchImpl });
  const files = await share.list('https://115.com/s/swCODE?password=urlpwd', { password: 'manual' });
  assert.equal(files.length, 101);
  assert.equal(files.find((file) => file.name === 'Folder/x.txt').id, 'nested');
  assert.equal(files.at(-1).name, 'last.bin');
  assert.equal(files[0].receiveCode, 'manual');
  assert.equal(files[0].shareCode, 'swCODE');
  assert.equal(calls.length, 3);
});

test('share link returns original URL and merged path-bound CDN cookie', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /share\/downurl/);
    assert.equal(options.headers.cookie, 'UID=local_A1_x; SEID=s');
    assert.equal(options.headers['user-agent'], 'Mozilla/5.0 115Browser/36.0.1');
    return response({ state: true, data: { file_url_302: 'https://cdn.example/object?a=1', fs: '88', fn: 'server.bin' } }, ['acw_tc=waf; Path=/', 'download_token=short; Path=/object/']);
  };
  const api = new Pan115Api({ cookie: 'UID=local_A1_x; SEID=s', fetchImpl });
  const result = await api.shareDownload({ shareCode: 'swCODE', receiveCode: 'pwd', userId: '9988', file: { id: 'f1', name: 'local.bin', size: 88 } });
  assert.equal(cookieFromSetCookie({ getSetCookie: () => ['a=1; Path=/', 'b=2; Path=/x'] }), 'b=2');
  assert.equal(result.url, 'https://cdn.example/object?a=1');
  assert.equal(result.cdnCookie, 'download_token=short');
  assert.equal(result.cookie, 'UID=local_A1_x; SEID=s; download_token=short');
  assert.equal(result.size, 88);
});

test('public link binds the listed file to owner, password and CDN cookie', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === '/share/snap') return response({ state: true, data: { count: 1, userinfo: { user_id: 'owner' }, list: [{ fid: 'f1', fc: 1, n: 'file.txt', s: '5' }] } });
    assert.equal(parsed.searchParams.get('user_id'), 'owner');
    assert.equal(parsed.searchParams.get('receive_code'), 'secret');
    assert.equal(parsed.searchParams.get('file_id'), 'f1');
    assert.equal(options.headers.cookie, 'UID=viewer_A1_t; SEID=login');
    return response({ state: true, data: { file_url: 'https://cdn.example/file' } }, ['cdn=brief; path=/object/']);
  };
  const share = new Pan115Share({ cookie: 'UID=viewer_A1_t; SEID=login', fetchImpl });
  const source = 'https://115rc.com/s/swTEST?password=secret';
  const [item] = await share.list(source);
  const link = await share.link(source, item);
  assert.equal(link.url, 'https://cdn.example/file');
  assert.equal(link.headers.cookie, 'UID=viewer_A1_t; SEID=login; cdn=brief');
  assert.deepEqual(calls, ['/share/snap', '/share/downurl']);
  await assert.rejects(share.link('https://115.com/s/swOTHER', item), /不匹配/);
});


test('115 share text extracts official URL and explicit receive code without guessing', () => {
  for (const host of ['115.com', '115cdn.com', '115rc.com']) {
    for (const prefix of ['https://', '']) {
      assert.deepEqual(parse115ShareUrl('分享链接：' + prefix + host + '/s/swABC123 提取码：nc1i'), { shareCode: 'swABC123', receiveCode: 'nc1i' });
    }
  }
  assert.deepEqual(parse115ShareUrl('分享链接：https://115.com/s/swABC123\n访问码: ab12'), { shareCode: 'swABC123', receiveCode: 'ab12' });
  assert.deepEqual(parse115ShareUrl('https://115.com/s/swABC123/，密码：cd34'), { shareCode: 'swABC123', receiveCode: 'cd34' });
  assert.equal(parse115ShareUrl('分享链接：https://115.com/s/swABC123?password=url1 提取码：text').receiveCode, 'url1');
  assert.equal(parse115ShareUrl('https://115.com/s/swABC123?pwd=url2 提取码：text').receiveCode, 'url2');
  for (const suffix of [' nc1i', ' 提取码：', ' 提取码：ab', ' 提取码：abcdefghi']) assert.equal(parse115ShareUrl('https://115.com/s/swABC123' + suffix).receiveCode, '');
});

test('115 text parsing keeps official HTTPS origins and complete share path boundaries', () => {
  for (const source of ['http://115.com/s/swABC123', 'https://115.com.evil.test/s/swABC123', 'https://115.com@evil.test/s/swABC123', 'https://user:secret@115.com/s/swABC123', 'https://115.com:444/s/swABC123', 'https://115.com/s/swABC123/other', 'https://115.com/s/swABC123.bad', 'https://evil.test/s/swABC123 提取码：abcd', 'evil115.com/s/swABC123', 'evil.115.com/s/swABC123', 'not a share']) {
    assert.throws(() => parse115ShareUrl(source), /115/);
  }
});

