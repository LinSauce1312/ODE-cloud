import test from 'node:test';
import assert from 'node:assert/strict';
import { createServices } from '../src/cli-runtime.mjs';
import { XunleiAuth } from '../lib/auth.mjs';
import { run } from '../cli.mjs';

test('invalid refresh tokens explain re-login without deleting credentials or retrying', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const auth = new XunleiAuth({ accessToken: 'old', refreshToken: 'private', expiresAt: 1, deviceId: 'device' });
  const previous = { ...auth.cred };
  let saves = 0;
  auth.save = async () => { saves += 1; };
  try {
    globalThis.fetch = async () => { requests += 1; return { status: 400, text: async () => JSON.stringify({ error_code: 401, error_description: 'invalid refresh token' }) }; };
    await assert.rejects(auth.ensureFresh(), error => {
      assert.match(error.message, /node cli.mjs login xunlei/);
      assert.match(error.message, /status xunlei --verify/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.deepEqual(auth.cred, previous);
    assert.equal(auth._refreshing, null);
    assert.equal(saves, 0);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

const timestamp = '2026-11-09T10:00:00.000Z';
const keys = ['platform', 'saved', 'verified', 'capturedAt'];

test('all status rows perform the same official verification as single-platform status', async () => {
  const calls = [];
  const services = createServices({
    authLoader: async () => ({ loggedIn: true, cred: { capturedAt: timestamp }, me: async () => { calls.push('xunlei'); return { user_id: '42' }; } }),
    loadCloudCredentialRecord: async () => ({ cookie: 'private', capturedAt: timestamp }),
    loadCloudCredential: async () => ({ cookie: 'private', token: 'private', authorization: 'private', capturedAt: timestamp }),
    inspectCloudAccount: async platform => { calls.push(platform); return { verified: platform === 'yidong' ? null : true, account: { id: platform } }; },
  });
  const all = await run(['status', 'all'], { services, output: () => {} });
  assert.equal(calls.length, 7);
  for (const status of all) {
    assert.deepEqual(Object.keys(status), keys);
    const single = await run(['status', status.platform, '--verify'], { services, output: () => {} });
    assert.deepEqual(single, [status]);
    assert.equal(status.verified, status.platform === 'yidong' ? null : true);
  }
});

test('missing credentials and old credentials without a timestamp keep explicit null fields', async () => {
  const services = createServices({
    authLoader: async () => ({ loggedIn: false, cred: {} }),
    loadCloudCredentialRecord: async () => ({ cookie: '', capturedAt: null }),
    loadCloudCredential: async () => null,
  });
  for (const platform of ['xunlei', 'quark', 'pan123', 'tianyi', 'yidong', 'baidu', '115']) {
    assert.deepEqual(await services.status(platform, { verify: true }), { platform, saved: false, verified: false, capturedAt: null });
  }
});

test('whoami never exposes raw xunlei response secrets and masks telephone numbers', async () => {
  const services = createServices({ authLoader: async () => ({ loggedIn: true, cred: { capturedAt: timestamp }, me: async () => ({ data: { user_id: '42', name: 'example', phone_number: '13800138000', access_token: 'SECRET', cookie: 'SECRET' }, refreshToken: 'SECRET' }) }) });
  const result = await services.whoami('xunlei');
  assert.equal(result.verified, true);
  assert.equal(result.account.user_id, '42');
  assert.equal(result.account.phone_number, '*******8000');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('whoami uses the matching official account inspector and unsupported platforms remain unknown', async () => {
  const calls = [];
  const services = createServices({
    loadCloudCredentialRecord: async () => ({ cookie: 'private', capturedAt: timestamp }),
    loadCloudCredential: async () => ({ cookie: 'private', token: 'private', authorization: 'private', capturedAt: timestamp }),
    inspectCloudAccount: async platform => { calls.push(platform); return platform === 'yidong' ? { verified: null, account: null } : { verified: true, account: { id: platform } }; },
  });
  for (const platform of ['quark', 'pan123', 'tianyi', 'baidu', '115']) assert.equal((await services.whoami(platform)).account.id, platform);
  for (const platform of ['yidong']) {
    const result = await services.whoami(platform);
    assert.equal(result.verified, null);
    assert.equal(result.account, null);
  }
  assert.deepEqual(calls, ['quark', 'pan123', 'tianyi', 'baidu', '115', 'yidong']);
});

test('manual polling is offered to every browser implementation and terminals always close', async () => {
  let closes = 0;
  const services = createServices({
    authLoader: async () => ({ loggedIn: true, cred: { capturedAt: timestamp } }),
    loadCloudCredentialRecord: async () => ({ cookie: 'private', capturedAt: timestamp }),
    loadCloudCredential: async () => ({ cookie: 'private', token: 'private', authorization: 'private', capturedAt: timestamp }),
    terminalFactory: () => ({ on: (event, callback) => callback('yes'), close: () => { closes += 1; } }),
    loginXunleiWithBrowser: async (auth, options) => { assert.equal(options.browserPath, undefined); assert.equal(await options.manualConfirm(), true); return { verified: true }; },
    loginWithBrowser: async (platform, options) => { assert.equal(await options.manualConfirm(), true); return { verified: true }; },
    loginCloud: async (platform, options) => { assert.equal(await options.manualConfirm(), true); return { verified: platform === 'yidong' ? null : true }; },
  });
  for (const platform of ['xunlei', 'quark', 'pan123', 'tianyi', 'yidong', 'baidu', '115']) {
    const result = await services.login(platform, { browser: true });
    assert.deepEqual(Object.keys(result), keys);
    assert.equal(result.verified, platform === 'yidong' ? null : true);
  }
  assert.equal(closes, 7);
});

test('SMS never persists a candidate that fails official identity verification', async () => {
  let writes = 0;
  const auth = { cred: { accessToken: 'old' }, save: async () => { writes += 1; }, sendSmsCode: async () => ({ verificationId: 'id' }), loginWithSmsCode: async () => { auth.cred = { accessToken: 'new' }; await auth.save(); }, me: async () => ({ token: 'not an identity' }) };
  const originalSave = auth.save;
  const services = createServices({ authLoader: async () => auth, terminalFactory: () => ({ question: async () => '123456', close: () => {} }) });
  await assert.rejects(services.login('xunlei', { sms: '13800138000' }), /官方账号校验失败/);
  assert.equal(writes, 0);
  assert.equal(auth.cred.accessToken, 'old');
  assert.equal(auth.save, originalSave);
});

test('one rejected account inspector does not stop the remaining status rows', async () => {
  const calls = [];
  const services = createServices({
    authLoader: async () => ({ loggedIn: true, cred: {}, me: async () => ({ user_id: '42' }) }),
    loadCloudCredentialRecord: async () => ({ cookie: 'private' }),
    loadCloudCredential: async () => ({ cookie: 'private', token: 'private', authorization: 'private' }),
    inspectCloudAccount: async platform => { calls.push(platform); if (platform === 'quark') throw new Error('offline'); return { verified: true, account: { id: platform } }; },
  });
  const rows = await run(['status', 'all'], { services, output: () => {} });
  assert.equal(rows.length, 7);
  assert.equal(rows.find(row => row.platform === 'quark').verified, false);
  assert.equal(rows.find(row => row.platform === '115').verified, true);
  assert.equal(calls.length, 6);
});

test('official xunlei account requests reject redirects and have a deadline', async context => {
  const auth = new XunleiAuth({ accessToken: 'private' });
  auth.ensureFresh = async () => 'private';
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { status: 200, text: async () => JSON.stringify({ user_id: '42' }) };
  });
  assert.equal((await auth.me()).user_id, '42');
});

test('retired password entry points stay absent while SMS and session methods remain available', () => {
  const auth = new XunleiAuth({ deviceId: 'device' });
  assert.equal(auth.login, undefined);
  assert.equal(auth.coreLogin, undefined);
  assert.equal(auth.deviceSign, undefined);
  assert.equal(auth.deviceId, 'device');
  for (const method of ['sendSmsCode', 'loginWithSmsCode', 'captchaInit', 'refresh', 'ensureFresh', 'request', 'me', 'logout']) assert.equal(typeof auth[method], 'function');
});

