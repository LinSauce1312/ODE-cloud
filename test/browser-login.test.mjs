import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLoopbackWebSocketUrl, filterCloudCookies, hasCloudLogin, loginWithBrowser, normalizeCloudCredentialRecord } from '../lib/browser-login.mjs';

test('Quark only accepts both required login cookies', () => {
  assert.equal(filterCloudCookies('quark', '__pus=first; uid=other; __puus=second'), '__pus=first; uid=other; __puus=second');
  assert.equal(filterCloudCookies('quark', [
    { domain: '.pan.quark.cn', name: '__pus', value: 'first' },
    { domain: 'pan.quark.cn', name: '__puus', value: 'second' },
    { domain: 'pan.quark.cn', name: 'additional', value: 'official' },
    { domain: 'evil.pan.quark.cn', name: 'tracking', value: 'excluded' },
  ]), '__pus=first; __puus=second; additional=official');
  assert.equal(filterCloudCookies('quark', '__pus=first'), '');
  assert.equal(hasCloudLogin('quark', '__pus=first; __puus=second'), true);
  assert.equal(hasCloudLogin('quark', '__pus=first; __puus='), false);
});

test('115 retains only allowlisted cookies and excludes unrelated domains', () => {
  const browserCookies = [
    { domain: '.115.com', name: 'UID', value: '123_A1_secret' },
    { domain: '.115.com', name: 'SEID', value: 'session' },
    { domain: '.115.com', name: 'SID', value: 'unrelated' },
  ];
  assert.equal(filterCloudCookies('115', browserCookies), 'UID=123_A1_secret; SEID=session');
  assert.equal(filterCloudCookies('115', [
    { domain: 'evil.115.com', name: 'UID', value: 'wrong' },
    { domain: 'evil.example', name: 'SEID', value: 'wrong' },
  ]), '');
  assert.equal(filterCloudCookies('115', 'UID=123; SEID=session; SID=other'), 'UID=123; SEID=session');
  assert.equal(filterCloudCookies('115', 'UID=123; CID=cid; SEID=session; KID=kid; PHPSESSID=php; GST=gst; USERSESSIONID=user; SID=discard'),
    'UID=123; CID=cid; SEID=session; KID=kid; PHPSESSID=php; GST=gst; USERSESSIONID=user');
  assert.equal(filterCloudCookies('115', 'UID=123'), '');
  assert.equal(filterCloudCookies('115', 'uid=123; SEID=session'), '');
});


test('invalid platform and missing browser fail before opening a profile', async () => {
  assert.throws(() => filterCloudCookies('other', []), /不支持/);
  await assert.rejects(loginWithBrowser('quark', { browserPath: 'Z:\\missing-chrome.exe' }), /未找到 Chrome 或 Edge/);
});

test('CDP websocket endpoint remains pinned to the launched loopback port', () => {
  assert.equal(assertLoopbackWebSocketUrl('ws://127.0.0.1:4567/devtools/page/abc-123', 4567), 'ws://127.0.0.1:4567/devtools/page/abc-123');
  assert.throws(() => assertLoopbackWebSocketUrl('ws://localhost:4567/devtools/page/abc-123', 4567), /loopback/);
  assert.throws(() => assertLoopbackWebSocketUrl('ws://127.0.0.2:4567/devtools/page/abc-123', 4567), /loopback/);
  assert.throws(() => assertLoopbackWebSocketUrl('ws://127.0.0.1:9999/devtools/page/abc-123', 4567), /loopback/);
});

test('115 old cookie strings and timestamped records have one compatible shape', () => {
  assert.deepEqual(normalizeCloudCredentialRecord('115', 'UID=123; SEID=private'), { cookie: 'UID=123; SEID=private', capturedAt: null });
  assert.deepEqual(normalizeCloudCredentialRecord('115', { cookie: 'UID=123; SEID=private', capturedAt: '2026-11-09T00:00:00.000Z', token: 'ignored' }), { cookie: 'UID=123; SEID=private', capturedAt: '2026-11-09T00:00:00.000Z' });
  assert.deepEqual(normalizeCloudCredentialRecord('115', null), { cookie: '', capturedAt: null });
  assert.deepEqual(normalizeCloudCredentialRecord('115', { cookie: 'UID=123', capturedAt: 42 }), { cookie: '', capturedAt: null });
});
