import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUDS, cloudLoginGuide, cookieFor, loginCloud, validateCloudCredential, mobileLoginEvent, inspectCloudAccount, readOfficialStorage, safeCloudIdentity, hasCloudIdentity } from '../src/cloud-login.mjs';
import { createServices, prepareShare } from '../src/cli-runtime.mjs';
import { run } from '../cli.mjs';

test('validates four cloud sessions against their original account endpoints', async () => {
  const cases = [
    ['baidu', { cookie: 'BDUSS=x; STOKEN=y; BDUSS_BFESS=z' }, { errno: 0, result: { username: 'me' } }, 'gettemplatevariable'],
    ['tianyi', { cookie: 'login=x' }, { res_code: 0 }, 'getUserBriefInfo'],
    ['pan123', { token: 'sample-token' }, { code: 0, data: { Nickname: 'me' } }, 'yun.123pan.cn/b/api/user/info'],
    ['quark', { cookie: '__pus=x; __puus=y' }, { code: 'OK' }, '/account/info'],
  ];
  for (const [platform, credential, reply, urlPart] of cases) {
    let calledUrl;
    let calledHeaders;
    const fetchImpl = async (url, options) => {
      calledUrl = url;
      calledHeaders = options?.headers || {};
      return new Response(JSON.stringify(reply), { status: 200 });
    };
    assert.equal(await validateCloudCredential(platform, credential, fetchImpl), true);
    assert.match(calledUrl, new RegExp(urlPart));
    if (platform === 'pan123') {
      assert.match(calledHeaders.Authorization || '', /Bearer sample-token/);
      assert.match(calledHeaders.Origin || '', /yun\.123pan\.cn/);
      assert.match(calledHeaders.Referer || '', /yun\.123pan\.cn/);
    }
    if (platform === 'baidu') assert.match(calledHeaders.Cookie || '', /BDUSS=x/);
    assert.equal(await validateCloudCredential(platform, credential, async () => new Response('{}')), false);
  }
});

test('captures mobile authorization only from the expected official login request', () => {
  const state = { requestId: '', authorization: '', ok: false };
  mobileLoginEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'wrong', request: { method: 'POST', url: 'https://evil.test/user/getUser', headers: { Authorization: 'bad' } } } }, state);
  assert.equal(state.authorization, '');
  assert.equal(state.ok, false);
  mobileLoginEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'login', request: { method: 'POST', url: 'https://user-njs.yun.139.com/service/user/getUser', headers: { Authorization: 'Bearer test' } } } }, state);
  mobileLoginEvent({ method: 'Network.responseReceived', params: { requestId: 'login', response: { status: 200 } } }, state);
  assert.equal(state.authorization, 'Bearer test');
  assert.equal(state.responseId, 'login');
  // 与 ODE 原版对齐：捕获到官方登录请求的 authorization 即视为登录成功。
  assert.equal(state.ok, true);
});
test('mobile authorization can be raw Bearer token or Basic wrapped (aligned with ODE)', () => {
  const state = { requestId: '', authorization: '', ok: false };
  mobileLoginEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { method: 'POST', url: 'https://yun.139.com/orchestration/user/getUser', headers: { authorization: 'Bearer abc.def.ghi' } } } }, state);
  assert.equal(state.authorization, 'Bearer abc.def.ghi');
  assert.equal(state.ok, true);
});

test('cookieFor keeps Tianyi SSO cookies on .189.cn parent and subdomains', () => {
  const cookies = [
    { name: 'SSONET', value: 'sso', domain: '.189.cn' },
    { name: 'LT', value: 'lt', domain: 'e.189.cn' },
    { name: 'SESSION', value: 'sess', domain: 'api.cloud.189.cn' },
    { name: 'COOKIE_LOGIN_USER', value: 'user', domain: 'cloud.189.cn' },
    { name: 'unrelated', value: 'x', domain: 'example.test' },
    { name: 'empty', value: '', domain: 'cloud.189.cn' },
  ];
  const result = cookieFor('tianyi', cookies);
  assert.ok(result.includes('SSONET=sso'), 'should keep .189.cn parent-domain SSO cookie');
  assert.ok(result.includes('LT=lt'), 'should keep e.189.cn subdomain cookie');
  assert.ok(result.includes('SESSION=sess'), 'should keep api.cloud.189.cn subdomain cookie');
  assert.ok(result.includes('COOKIE_LOGIN_USER=user'), 'should keep cloud.189.cn cookie');
  assert.ok(!result.includes('unrelated'), 'should not keep unrelated domain cookies');
  assert.ok(!result.includes('empty'), 'should not keep empty cookies');
});

test('cookieFor still uses exact domain match for non-Tianyi platforms (Quark)', () => {
  const cookies = [
    { name: '__pus', value: 'pus', domain: 'pan.quark.cn' },
    { name: 'external', value: 'x', domain: 'quark.com' },
    { name: '__puus', value: 'puus', domain: '.quark.cn' },
  ];
  const result = cookieFor('quark', cookies);
  assert.ok(result.includes('__pus=pus'));
  assert.ok(result.includes('__puus=puus'));
  assert.ok(!result.includes('external'));
});

test('unified runtime keeps account credentials out of CDN requests and refreshes selected files only', async () => {
  for (const [platform, shareUrl, credential, opener] of [
    ['pan123', 'https://www.123pan.com/s/AbC-123', { token: 'private' }, 'openPan123Share'],
    ['tianyi', 'https://cloud.189.cn/t/AbC123', { cookie: 'SSO=private' }, 'openTianyiShare'],
    ['yidong', 'https://yun.139.com/shareweb/#/w/i/xyz123', { authorization: 'Basic private' }, 'openYidongShare'],
  ]) {
    const linked = [];
    const transfers = [];
    const services = createServices({
      loadCloudCredential: async requested => { assert.equal(requested, platform); return credential; },
      [opener]: async (raw, saved) => {
        assert.equal(raw, shareUrl);
        assert.deepEqual(saved, credential);
        return { share: {}, files: [{ name: 'folder/a.bin', size: 2 }, { name: 'other/b.bin', size: 3 }],
          client: { async getShareDownloadLink(_share, file) {
            linked.push(file.name);
            return { url: 'https://cdn.example.test/file', headers: {}, size: file.size };
          } } };
      },
      downloadHttp: async transfer => {
        transfers.push(transfer);
        assert.deepEqual(transfer.headers, {});
        assert.equal((await transfer.onExpired()).url, 'https://cdn.example.test/file');
        return { size: 2 };
      },
    });
    const prepared = prepareShare(shareUrl);
    const options = { file: ['folder/a.bin'], workers: 4, chunkSize: 2097152, engine: 'http' };
    const result = await services.download(prepared, 'downloads', options, () => {});
    assert.deepEqual(result.results.map(item => [item.name, item.status]), [['folder/a.bin', 'done']]);
    assert.deepEqual(linked, ['folder/a.bin', 'folder/a.bin']);
    assert.equal(transfers[0].workers, 4);
    assert.equal(transfers[0].chunkSize, 2097152);
    await assert.rejects(services.download(prepared, 'downloads', { ...options, file: ['missing.bin'] }, () => {}), /未找到文件/);
    assert.equal(linked.length, 2);
    const unauthenticated = createServices({ loadCloudCredential: async () => null });
    await assert.rejects(unauthenticated.open(prepared), /先执行/);
  }
});

test('unified direct service never loads cloud credentials or forwards authentication', async () => {
  let transfer;
  const services = createServices({
    loadCloudCredential: async () => { throw new Error('must not load credentials'); },
    authLoader: async () => { throw new Error('must not load credentials'); },
    stat: async () => null,
    downloadHttp: async options => { transfer = options; return { size: 3 }; },
  });
  const result = await services.direct('https://example.test/file.zip', 'out.zip', { workers: 8 }, () => {});
  assert.equal(result.results[0].size, 3);
  assert.equal(transfer.headers, undefined);
  await assert.rejects(run(['direct', 'file:///c:/x', '--output', 'out.zip'], { services, output: () => {} }), /HTTP/);
});

test('exposes all five official login entry points without claiming SMS APIs', () => {
  assert.deepEqual(Object.keys(CLOUDS), ['baidu', 'tianyi', 'pan123', 'quark', 'yidong']);
  assert.match(cloudLoginGuide('baidu').note, /官方网页/);
  assert.throws(() => cloudLoginGuide('unknown'), /不支持/);
  assert.equal(typeof loginCloud, 'function');
});

test('account inspection returns only safe identities and disables redirects', async () => {
  const cases = [
    ['baidu', { cookie: 'BDUSS=private' }, { errno: 0, result: { username: '百度用户', token: 'private', phone: 'private' } }, { username: '百度用户' }],
    ['tianyi', { cookie: 'login=private' }, { res_code: 0, data: { userId: 42, nickname: '天翼用户', cookie: 'private' } }, { userId: 42, nickname: '天翼用户' }],
    ['pan123', { token: 'private' }, { code: 0, data: { UID: 'not-allowlisted', Nickname: '123用户', token: 'private' } }, { Nickname: '123用户' }],
    ['quark', { cookie: '__pus=a; __puus=b' }, { code: 'OK', data: { uid: '42', nickname: '夸克用户', accessToken: 'private' } }, { uid: '42', nickname: '夸克用户' }],
  ];
  for (const [platform, credential, response, account] of cases) {
    const inspected = await inspectCloudAccount(platform, credential, async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify(response));
    });
    assert.deepEqual(inspected, { verified: true, account });
  }
  let requested = false;
  assert.deepEqual(await inspectCloudAccount('yidong', { authorization: 'captured' }, async () => { requested = true; }), { verified: null, account: null });
  assert.equal(requested, false);
  assert.deepEqual(await inspectCloudAccount('baidu', { cookie: 'BDUSS=' }), { verified: false, account: null });
  assert.deepEqual(await inspectCloudAccount('quark', { cookie: '__pus=a; __puus=b' }, async () => { throw new Error('redirect blocked'); }), { verified: false, account: null });
});

test('storage is never read from a page that navigated off the official origin', async () => {
  const commands = [];
  const session = { send: async (_method, params) => {
    commands.push(params.expression);
    return { result: { value: 'https://evil.example/?token=untrusted' } };
  } };
  assert.equal(await readOfficialStorage(session, 'pan123', 'localStorage.getItem("token")'), null);
  assert.deepEqual(commands, ['location.href']);
  const trusted = { send: async (_method, params) => {
    if (params.expression === 'location.href') return { result: { value: 'https://pan.baidu.com/' } };
    assert.match(params.expression, /location.protocol/);
    assert.match(params.expression, /location.hostname/);
    return { result: { value: 'guarded-value' } };
  } };
  assert.equal(await readOfficialStorage(trusted, 'baidu', 'localStorage.getItem("BDUSS")'), 'guarded-value');
});

test('safe account identity masks contacts and permits bounded metadata, never secrets', () => {
  const raw = { data: { user: { sub: '42', name: 'Example', user_name: 'member', phone_number: '13800138000', email: 'alice@example.com', access_token: 'SECRET', cookie: 'SECRET', signature: 'SECRET', avatar: 'https://example.com/?token=SECRET', profile: { nickname: '昵称' }, vip: { vipLevel: 3, vipExpireTime: '2030-01-01', token: 'SECRET' }, space: { total_size: 1000, used_size: 200, free_size: 800 } } } };
  const account = safeCloudIdentity(raw);
  assert.deepEqual(account, { sub: '42', name: 'Example', user_name: 'member', phone_number: '*******8000', email: 'a***@example.com', nickname: '昵称', vipLevel: 3, vipExpireTime: '2030-01-01', total_size: 1000, used_size: 200, free_size: 800 });
  assert.equal(hasCloudIdentity(raw), true);
  assert.equal(hasCloudIdentity({ vip: { vipLevel: 3 }, space: { total: 500 } }), false);
  assert.deepEqual(safeCloudIdentity({ result: { user: { username: 'alice@example.com', phone: '13800138000' } } }), { username: 'a***@example.com', phone: '*******8000' });
  assert.doesNotMatch(JSON.stringify(account), /SECRET|13800138000|alice@|avatar|signature|token|cookie/);
});

test('safe account projection rejects arbitrary containers and malformed fields and bounds recursion', () => {
  const cyclic = { id: '42', profile: {} }; cyclic.profile.user = cyclic;
  assert.deepEqual(safeCloudIdentity(cyclic), { id: '42' });
  assert.equal(safeCloudIdentity({ arbitrary: { id: 'hidden' }, user: [{ id: 'hidden' }], name: 'https://example.com/?token=SECRET', nickname: 'Bearer SECRET', phone: 'not-a-number', email: 'invalid' }), null);
  assert.equal(safeCloudIdentity({ data: { data: { data: { data: { id: 'too-deep' } } } } }), null);
  assert.equal(safeCloudIdentity({ id: Infinity, name: 'bad\nname', profile: { nickname: 'x'.repeat(257) } }), null);
  assert.equal(safeCloudIdentity({ email: 'alice@example.com?token=SECRET', mail: 'a@example.com/SECRET' }), null);
  const accessor = {}; Object.defineProperty(accessor, 'id', { get() { throw new Error('must not invoke getter'); } });
  assert.equal(safeCloudIdentity(accessor), null);
  assert.equal(hasCloudIdentity({ id: 0, name: false, total: 100 }), false);
});

test('115 account inspection uses evidenced official endpoint and requires real identity', async () => {
  const credential = { cookie: 'UID=42_A1_private; SEID=private' };
  const result = await inspectCloudAccount('115', credential, async (url, options) => {
    assert.equal(url, 'https://webapi.115.com/user/info?ct=json');
    assert.equal(options.headers.Cookie, credential.cookie);
    assert.equal(options.headers.Referer, 'https://115.com/');
    assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ state: true, data: { user_id: '42', user_name: '115用户', vip: 1, cookie: 'private', sign: 'private' } }));
  });
  assert.deepEqual(result, { verified: true, account: { user_id: '42', user_name: '115用户', vip: 1 } });
  for (const reply of [{ state: false, data: { user_id: '42' } }, { state: true, errno: 99, data: { user_id: '42' } }, { state: true, data: {} }, { state: true, data: { vip: 1, total: 100 } }, { state: true, data: 'private' }]) {
    assert.deepEqual(await inspectCloudAccount('115', credential, async () => new Response(JSON.stringify(reply))), { verified: false, account: null });
  }
  assert.deepEqual(await inspectCloudAccount('115', credential, async () => { throw new Error('redirect'); }), { verified: false, account: null });
  assert.deepEqual(await inspectCloudAccount('115', { cookie: '' }, async () => { throw new Error('must not fetch'); }), { verified: false, account: null });
  assert.deepEqual(await inspectCloudAccount('yidong', { authorization: 'captured' }, async () => { throw new Error('must not guess protocol'); }), { verified: null, account: null });
});
