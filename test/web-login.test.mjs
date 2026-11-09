import assert from 'node:assert/strict';
import test from 'node:test';
import { XunleiAuth } from '../lib/auth.mjs';
import { extractXunleiTokens, isOfficialXunleiAuthResponse, isOfficialXunleiUrl, validateWebTokens, captureXunleiPageTokens } from '../lib/web-login.mjs';

test('only official HTTPS Xunlei origins qualify as browser token sources', () => {
  assert.equal(isOfficialXunleiUrl('https://xluser-ssl.xunlei.com/v1/auth/signin'), true);
  assert.equal(isOfficialXunleiUrl('https://pan.xunlei.com/'), true);
  for (const url of ['http://pan.xunlei.com/', 'https://xunlei.com.evil.test/', 'https://other.test/', 'https://user:pass@pan.xunlei.com/', 'https://pan.xunlei.com:8443/', 'not a URL']) {
    assert.equal(isOfficialXunleiUrl(url), false, url);
  }
});

test('only official authentication responses can supply captured response tokens', () => {
  assert.equal(isOfficialXunleiAuthResponse('https://xluser-ssl.xunlei.com/v1/auth/signin'), true);
  assert.equal(isOfficialXunleiAuthResponse('https://xluser-ssl.xunlei.com/v1/auth/token'), true);
  for (const url of ['https://evil.xunlei.com.test/v1/auth/signin', 'https://pan.xunlei.com/a/other', 'http://xluser-ssl.xunlei.com/v1/auth/signin']) {
    assert.equal(isOfficialXunleiAuthResponse(url), false);
  }
});

test('extracts only paired tokens from nested storage or first-party JSON responses', () => {
  const tokens = { access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 3600 };
  assert.deepEqual(extractXunleiTokens(JSON.stringify({ local: [JSON.stringify({ user: { token: tokens } })] })), {
    accessToken: 'access-private', refreshToken: 'refresh-private', expiresIn: 3600,
  });
  assert.deepEqual(extractXunleiTokens({ response: { data: { accessToken: 'a', refreshToken: 'r' } } }), { accessToken: 'a', refreshToken: 'r' });
  for (const invalid of [{ access_token: 'only-access' }, { access_token: 'a', other: { refresh_token: 'r' } }, '{invalid', null]) {
    assert.equal(extractXunleiTokens(invalid), null);
  }
});

test('validates via auth.me before saving and preserves existing credentials on failure', async () => {
  const auth = new XunleiAuth({ deviceId: 'fixed-device', userId: 'old-user', accessToken: 'old-access', refreshToken: 'old-refresh' });
  let saved = 0;
  let requested;
  auth.save = async () => { saved += 1; };
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      requested = options.headers.Authorization;
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ user_id: '123' }));
    };
    await validateWebTokens({ accessToken: 'new-access', refreshToken: 'new-refresh' }, auth);
    assert.equal(requested, 'Bearer new-access');
    assert.equal(auth.cred.refreshToken, 'new-refresh');
    assert.equal(auth.cred.userId, '123');
    assert.equal(saved, 1);
    assert.equal(auth.verified, true);
    assert.ok(Number.isFinite(Date.parse(auth.cred.capturedAt)));
    globalThis.fetch = async () => new Response(JSON.stringify({ error_code: 403, message: 'denied' }), { status: 403 });
    await assert.rejects(validateWebTokens({ accessToken: 'invalid-access', refreshToken: 'invalid-refresh' }, auth), /未通过账号校验/);
    assert.equal(auth.cred.accessToken, 'new-access');
    assert.equal(saved, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ nickname: 'account' }));
    auth.save = async () => { throw new Error('disk full'); };
    await assert.rejects(validateWebTokens({ accessToken: 'unsaved', refreshToken: 'unsaved-refresh' }, auth), /disk full/);
    assert.equal(auth.cred.accessToken, 'new-access');
    await assert.rejects(validateWebTokens({ accessToken: 'incomplete' }, auth), /同时提供/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('manual page token detection trusts only official current URL and guarded storage', async () => {
  let reads = 0;
  const untrusted = { send: async (_method, params) => { reads += 1; assert.equal(params.expression, 'location.href'); return { result: { value: 'https://evil.example/' } }; } };
  assert.equal(await captureXunleiPageTokens(untrusted), null);
  assert.equal(reads, 1);
  for (const channel of ['url', 'cookie']) {
    const trusted = { send: async (_method, params) => {
      if (params.expression === 'location.href') return { result: { value: 'https://pan.xunlei.com/' } };
      assert.match(params.expression, /location.hostname/);
      return { result: { value: JSON.stringify({ origin: 'https://pan.xunlei.com', url: channel === 'url' ? 'https://pan.xunlei.com/?access_token=a&refresh_token=r' : 'https://pan.xunlei.com/', cookie: channel === 'cookie' ? 'access_token=a; refresh_token=r' : '', local: [], session: [] }) } };
    } };
    assert.deepEqual(await captureXunleiPageTokens(trusted), { accessToken: 'a', refreshToken: 'r' });
  }
});
