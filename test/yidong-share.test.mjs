import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { accountFromAuthorization, openYidongShare, parseYidongShareUrl } from '../src/yidong-share.mjs';

const KEY = Buffer.from('PVGDwmcvfs1uV3d1');
const AUTHORIZATION = `Basic ${Buffer.from('pc:13800138000:demo-token').toString('base64')}`;

function decode(body) {
  const bytes = Buffer.from(body, 'base64');
  const decipher = createDecipheriv('aes-128-cbc', KEY, bytes.subarray(0, 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
}

function encode(payload, zipped = false) {
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-128-cbc', KEY, iv);
  const content = Buffer.from(JSON.stringify(payload));
  return Buffer.concat([iv, cipher.update(zipped ? gzipSync(content) : content), cipher.final()]).toString('base64');
}

test('accepts only official 139 share routes and captures password', () => {
  assert.deepEqual(parseYidongShareUrl('链接: https://yun.139.com/shareweb/#/w/i/abc_XY?pwd=1234 提取码：xyz1'), { linkId: 'abc_XY', passwd: '1234' });
  assert.deepEqual(parseYidongShareUrl('https://yun.139.com/shareweb/#/m/i/abc-D 提取码：wxyz'), { linkId: 'abc-D', passwd: 'wxyz' });
  assert.deepEqual(parseYidongShareUrl('https://yun.139.com/m/i/short123'), { linkId: 'short123', passwd: '' });
  assert.deepEqual(parseYidongShareUrl('https://yun.139.com/shareweb/#/w/i/share1?pwd=abcd&path=parent/sub'), { linkId: 'share1', passwd: 'abcd', folderPath: 'parent/sub' });
  assert.throws(() => parseYidongShareUrl('https://yun.139.com/shareweb/#/w/i/share1?path=../../other'), /目录 ID/);
  assert.throws(() => parseYidongShareUrl('https://yun.139.com.evil.test/shareweb/#/w/i/abc'), /官方/);
  assert.throws(() => parseYidongShareUrl('http://yun.139.com/shareweb/#/w/i/abc'), /HTTPS/);
  assert.throws(() => parseYidongShareUrl('https://yun.139.com/shareweb/#/x/i/abc'), /路径/);
});

test('decodes Basic pc account, accepts raw authorization (aligned with ODE), and rejects empty', () => {
  // Basic 包装：与 ODE 原版一致，取 parts[1] 作为 account。
  assert.equal(accountFromAuthorization(AUTHORIZATION), '13800138000');
  // 原始 authorization（浏览器捕获的 Bearer/原始头）：与 ODE 原版一致，account 默认空串。
  assert.equal(accountFromAuthorization('Bearer opaque.jwt.token'), '');
  assert.equal(accountFromAuthorization('abc123rawtoken'), '');
  // Basic 但 account 为空：原版 parts[1] 为空时也回退到空串（不抛错）。
  assert.equal(accountFromAuthorization(`Basic ${Buffer.from('pc::token').toString('base64')}`), '');
  // 仅拒绝空凭据。
  assert.throws(() => accountFromAuthorization(''), /为空/);
  assert.throws(() => accountFromAuthorization(null), /为空/);
});

test('anonymous AES listing recursively traverses caLst and coLst; link request signs plaintext and never leaks auth to CDN', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const payload = decode(options.body);
    calls.push({ url, headers: options.headers, payload, body: options.body });
    if (url.endsWith('getOutLinkInfoV6')) {
      const query = payload.getOutLinkInfoReq;
      assert.equal(query.account, '');
      assert.equal(query.linkID, 'share_id');
      assert.equal(query.passwd, 'a123');
      assert.equal(query.caSrt, 1);
      assert.equal(query.coSrt, 1);
      assert.equal(query.srtDr, 0);
      assert.equal(query.bNum, 1);
      assert.equal(query.eNum, 200);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['mcloud-sign'], undefined);
      assert.equal(options.headers['hcy-cool-flag'], '1');
      const result = query.pCaID === 'root'
        ? { caLst: [{ caID: 'dir1', caName: 'Documents' }], coLst: [{ coID: 'rootfile', coName: 'root.zip', coSize: 34 }] }
        : { caLst: [], coLst: [{ coID: 'nested', coName: 'nested.zip', coSize: 72 }] };
      return new Response(encode({ resultCode: 0, success: true, data: result }, true));
    }
    assert.ok(url.endsWith('dlFromOutLinkV3'));
    assert.equal(options.headers.Authorization, AUTHORIZATION);
    assert.match(options.headers['mcloud-sign'], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,[A-Za-z0-9]{16},[A-F0-9]{32}$/);
    assert.deepEqual(payload, { dlFromOutLinkReqV3: {
      account: '13800138000', linkID: 'share_id', coIDLst: { item: ['nested'] },
      commonAccountInfo: { account: '13800138000', accountType: 1 },
    } });
    return new Response(JSON.stringify({ resultCode: 0, data: { redrUrl: 'https://cdn.example.test/data?signature=abc', coSize: 72 } }));
  };
  const opened = await openYidongShare('https://yun.139.com/shareweb/#/w/i/share_id?pwd=a123', { authorization: AUTHORIZATION }, { fetchImpl });
  assert.deepEqual(opened.files.map((entry) => entry.name), ['Documents/nested.zip', 'root.zip']);
  assert.deepEqual(opened.tree, [
    { name: 'Documents', path: 'Documents', type: 'directory', children: [
      { name: 'nested.zip', path: 'Documents/nested.zip', type: 'file', size: 72 },
    ] },
    { name: 'root.zip', path: 'root.zip', type: 'file', size: 34 },
  ]);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body, calls[1].body);
  const link = await opened.client.getShareDownloadLink(opened.share, opened.files[0]);
  assert.deepEqual(link, { url: 'https://cdn.example.test/data?signature=abc', headers: {}, size: 72 });
  assert.equal(calls.length, 3);
});

test('lists only the game folder selected by the mobile share path', async () => {
  const folders = [];
  const opened = await openYidongShare('https://yun.139.com/shareweb/#/w/i/share1?path=parent/sub', { authorization: AUTHORIZATION }, {
    fetchImpl: async (_url, options) => {
      const folder = decode(options.body).getOutLinkInfoReq.pCaID;
      folders.push(folder);
      return new Response(JSON.stringify({ data: { caLst: [], coLst: [{ coID: 'file1', coName: 'part.bin', coSize: 17 }] } }));
    },
  });
  assert.deepEqual(folders, ['parent/sub']);
  assert.deepEqual(opened.files.map((item) => item.name), ['part.bin']);
});

test('preserves empty source folders in mobile share tree', async () => {
  const fetchImpl = async (_url, options) => {
    const { pCaID } = decode(options.body).getOutLinkInfoReq;
    return new Response(JSON.stringify({ data: { caLst: pCaID === 'root' ? [{ caID: 'empty', caName: 'Empty' }] : [], coLst: [] } }));
  };
  const opened = await openYidongShare('https://yun.139.com/shareweb/#/w/i/s1', { authorization: AUTHORIZATION }, { fetchImpl });
  assert.deepEqual(opened.files, []);
  assert.deepEqual(opened.tree, [{ name: 'Empty', path: 'Empty', type: 'directory', children: [] }]);
});

test('paginates 200 entries and stops at next short page', async () => {
  const pages = [];
  const fetchImpl = async (_url, options) => {
    const { bNum } = decode(options.body).getOutLinkInfoReq;
    pages.push(bNum);
    const coLst = bNum === 1 ? Array.from({ length: 200 }, (_, index) => ({ coID: `id${index}`, coName: `file${index}`, coSize: 1 })) : [{ coID: 'last', coName: 'last', coSize: 1 }];
    return new Response(JSON.stringify({ data: { caLst: [], coLst } }));
  };
  const opened = await openYidongShare('https://yun.139.com/shareweb/#/w/i/s1', { authorization: AUTHORIZATION }, { fetchImpl });
  assert.equal(opened.files.length, 201);
  assert.deepEqual(pages, [1, 201]);
});

test('rejects invalid share data and fails at 1000 entries without silent truncation', async () => {
  const invalid = async () => new Response(JSON.stringify({ success: false, resultCode: 9188, desc: '提取码错误' }));
  await assert.rejects(openYidongShare('https://yun.139.com/shareweb/#/w/i/s1', { authorization: AUTHORIZATION }, { fetchImpl: invalid }), /提取码错误/);
  const overflow = async (_url, options) => {
    const { bNum } = decode(options.body).getOutLinkInfoReq;
    return new Response(JSON.stringify({ data: { coLst: Array.from({ length: 200 }, (_, index) => ({ coID: `f${bNum + index}`, coName: `file${bNum + index}`, coSize: 1 })) } }));
  };
  await assert.rejects(openYidongShare('https://yun.139.com/shareweb/#/w/i/s1', { authorization: AUTHORIZATION }, { fetchImpl: overflow }), /1000/);
});

test('rejects traversal names and unsafe CDN URLs without making a CDN request', async () => {
  const invalidName = async () => new Response(JSON.stringify({ data: { coLst: [{ coID: '1', coName: '../bad', coSize: 1 }] } }));
  await assert.rejects(openYidongShare('https://yun.139.com/shareweb/#/w/i/s1', { authorization: AUTHORIZATION }, { fetchImpl: invalidName }), /不安全/);
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.endsWith('getOutLinkInfoV6')) return new Response(JSON.stringify({ data: { coLst: [{ coID: '1', coName: 'safe', coSize: 1 }] } }));
    return new Response(JSON.stringify({ data: { redrUrl: 'http://untrusted.example.test/file' } }));
  };
  const opened = await openYidongShare('https://yun.139.com/shareweb/#/m/i/s1', { authorization: AUTHORIZATION }, { fetchImpl });
  await assert.rejects(opened.client.getShareDownloadLink(opened.share, opened.files[0]), /不安全/);
  assert.equal(calls, 2);
});
