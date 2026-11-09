import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuarkApiError, QuarkClient, parseQuarkShareUrl } from '../lib/quark.mjs';

const cookie = '__pus=old-pus; __puus=old-puus; uid=account';
const response = (json, cookies = [], status = 200) => ({
  ok: status < 400, status, headers: { getSetCookie: () => cookies }, json: async () => json,
});

test('share URL validates host and extracts password from query or text', () => {
  assert.deepEqual(parseQuarkShareUrl('https://pan.quark.cn/s/Share9?pwd=abcd'), { shareId: 'Share9', pwd: 'abcd' });
  assert.deepEqual(parseQuarkShareUrl('链接：https://pan.quark.cn/s/Share9 提取码：efgh'), { shareId: 'Share9', pwd: 'efgh' });
  assert.throws(() => parseQuarkShareUrl('https://pan.quark.cn.evil.test/s/Share9'), QuarkApiError);
  assert.throws(() => parseQuarkShareUrl('https://evil.test/s/Share9'), QuarkApiError);
  assert.throws(() => new QuarkClient('__pus=a'), /Cookie/);
});

test('account verification and cookie refresh stay isolated from other accounts', async () => {
  const client = new QuarkClient(cookie, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://pan.quark.cn/account/info');
    assert.equal(options.headers.Cookie, cookie);
    return response({ success: true, code: 'OK', data: { nickname: 'tester' } }, ['__puus=fresh; Path=/']);
  } });
  assert.deepEqual(await client.login(), { nickname: 'tester' });
  assert.equal(client.cookie, '__pus=old-pus; uid=account; __puus=fresh');
  assert.equal(new QuarkClient('__pus=other; __puus=other').cookie, '__pus=other; __puus=other');
});

test('share pagination, nested directory, password and signed download headers', async () => {
  const calls = [];
  const fetchImpl = async (raw, options) => {
    const url = new URL(raw);
    calls.push({ url, options });
    if (url.pathname.endsWith('/token')) {
      assert.deepEqual(JSON.parse(options.body), { pwd_id: 'Share9', passcode: 'abcd', support_visit_limit_private_share: true });
      return response({ status: 200, data: { stoken: 'st-secret', title: 'title', first_fid: 'root-file' } });
    }
    if (url.pathname.endsWith('/detail')) {
      assert.equal(url.searchParams.get('pwd_id'), 'Share9');
      assert.equal(url.searchParams.get('stoken'), 'st-secret');
      assert.equal(options.headers.Origin, 'https://pan.quark.cn');
      assert.equal(options.headers.Referer, 'https://pan.quark.cn/');
      const parent = url.searchParams.get('pdir_fid');
      const page = Number(url.searchParams.get('_page'));
      const list = parent === '0' && page === 1
        ? [{ fid: 'folder', file_name: 'docs', dir: true, pdir_fid: '0' }]
        : parent === '0' && page === 2
          ? [{ fid: 'root-file', file_name: 'root.bin', size: 2, share_fid_token: 'root-token', pdir_fid: '0' }]
          : parent === 'folder' && page === 1
            ? [{ fid: 'nested', file_name: 'nested.txt', size: 3, share_fid_token: 'nested-token', pdir_fid: 'folder' }]
            : [];
      return response({ status: 200, data: { list } });
    }
    if (url.pathname.endsWith('/download')) {
      assert.deepEqual(JSON.parse(options.body), {
        fids: ['nested'], fids_token: ['nested-token'], pwd_id: 'Share9',
        stoken: 'st-secret', speedup_session: '', token: '',
      });
      return response({ status: 200, data: [{ fid: 'nested', download_url: 'https://cdn.example/nested', size: 3 }] },
        ['__puus=download-signature; Path=/', '__pus=updated-pus; Path=/']);
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
  const client = new QuarkClient(cookie, { fetchImpl });
  const result = await client.resolveShare('https://pan.quark.cn/s/Share9?pwd=abcd');
  assert.deepEqual(result.files.map((file) => file.name), ['docs/nested.txt', 'root.bin']);
  assert.deepEqual(result.files.map((file) => file.fidToken), ['nested-token', 'root-token']);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/detail')).length, 5);
  const link = await client.getShareDownloadLink(result.share, result.files[0]);
  const viaLink = await client.link('https://pan.quark.cn/s/Share9', result.files[0], { password: 'abcd' });
  assert.equal(viaLink.url, link.url);
  assert.equal((await client.list('https://pan.quark.cn/s/Share9', { password: 'abcd' })).length, 2);
  assert.equal(link.url, 'https://cdn.example/nested');
  assert.equal(link.headers.Cookie, 'uid=account; __puus=download-signature; __pus=updated-pus');
  assert.equal(link.headers.Referer, 'https://pan.quark.cn/');
  assert.match(link.headers['User-Agent'], /quark-cloud-drive/);
});

test('account file link uses only account fid; rejected API codes never expose secrets', async () => {
  const client = new QuarkClient(cookie, { fetchImpl: async (url, options) => {
    assert.ok(url.toString().includes('/file/download'));
    assert.deepEqual(JSON.parse(options.body), { fids: ['owned-fid'] });
    return response({ code: 0, data: [{ download_url: 'https://cdn.example/owned', size: 12 }] });
  } });
  assert.equal((await client.getAccountDownloadLink('owned-fid')).size, 12);
  const denied = new QuarkClient(cookie, { fetchImpl: async () => response({ status: 400, code: 31001, message: 'secret-should-not-leak' }, [], 403) });
  await assert.rejects(() => denied.getAccountDownloadLink('owned-fid'), (error) => {
    assert.equal(error.code, 31001);
    assert.doesNotMatch(error.message, /secret|old-pus|old-puus/);
    return true;
  });
});

test('repeated page stops; max pages and invalid response fail closed', async () => {
  let pages = 0;
  const client = new QuarkClient(cookie, { fetchImpl: async () => {
    pages += 1;
    return response({ status: 200, data: { list: [{ fid: 'same', file_name: 'same.bin' }] } });
  } });
  const session = { shareId: 'Share9', stoken: 'st-secret' };
  assert.equal((await client.listDirectory(session)).length, 1);
  assert.equal(pages, 2);
  await assert.rejects(() => client.listDirectory(session, '0', { maxPages: 1 }), /最大分页数/);
  await assert.rejects(() => client.listDirectory(session, '0', { pageSize: 0 }), /分页参数/);
  const invalid = new QuarkClient(cookie, { fetchImpl: async () => response({ status: 200, data: {} }) });
  await assert.rejects(() => invalid.listDirectory(session), /列表格式错误/);
});
