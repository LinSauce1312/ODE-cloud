import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createDecipheriv } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { extractSdkArchive, fetchSdkArchive, installSdkFromUrl, sdkStatus, runSdkInstaller, resolveSdkSource } from '../urlsdk.mjs';

const components = { 'download.node': Buffer.from('test-addon-not-executable'), 'xl_thunder_sdk.dll': Buffer.from('test-library-not-executable') };
const hashes = Object.fromEntries(Object.entries(components).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));

function archive(entries = Object.entries(components).map(([name, content]) => ({ name: 'win32-x64/' + name, content })), method = 8) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.content || '');
    const packed = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

const reply = (body, headers = {}) => new Response(body, { headers });

test('stored and deflated ZIPs extract only two verified components from nested folders', () => {
  for (const method of [0, 8]) {
    const entries = [...Object.entries(components).map(([name, content]) => ({ name: '外层/win32-x64/' + name, content })), { name: 'ignored.exe', content: 'not installed' }];
    const files = extractSdkArchive(archive(entries, method), hashes);
    assert.deepEqual([...files.keys()], Object.keys(components));
    for (const [name, content] of files) assert.deepEqual(content, components[name]);
  }
});

test('ZIP rejects traversal, symlinks, duplicate components, wrong hashes, incomplete and non-ZIP bodies', () => {
  const entries = Object.entries(components).map(([name, content]) => ({ name, content }));
  for (const name of ['../escape', '/absolute', 'C:/escape', 'folder/../escape', 'folder\\..\\escape']) {
    assert.throws(() => extractSdkArchive(archive([...entries, { name }]), hashes), /不安全/);
  }
  assert.throws(() => extractSdkArchive(archive([...entries, { name: 'link', attributes: 0xa0000000 }]), hashes), /符号链接/);
  assert.throws(() => extractSdkArchive(archive([...entries, entries[0]]), hashes), /重复/);
  assert.throws(() => extractSdkArchive(archive(), { ...hashes, 'download.node': '0'.repeat(64) }), /SHA-256/);
  assert.throws(() => extractSdkArchive(archive(entries.slice(0, 1)), hashes), /缺少/);
  assert.throws(() => extractSdkArchive(Buffer.from('<html>not a ZIP</html>'), hashes));
});

test('ZIP download bounds input, rejects HTTP redirects and hides private URL in errors', async () => {
  assert.deepEqual(await fetchSdkArchive('https://example.com/sdk.zip', { fetchImpl: async () => reply(archive()) }), archive());
  await assert.rejects(fetchSdkArchive('http://example.com/sdk.zip'), /HTTPS/);
  await assert.rejects(fetchSdkArchive('https://example.com/private-token', { fetchImpl: async () => { throw new Error('https://example.com/private-token'); } }), error => !error.message.includes('private-token'));
  await assert.rejects(fetchSdkArchive('https://example.com/sdk.zip', { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://example.com/sdk.zip' } }) }), /下载失败/);
  await assert.rejects(fetchSdkArchive('https://example.com/sdk.zip', { fetchImpl: async () => reply('too large', { 'content-length': String(33 * 1024 * 1024) }) }), /下载失败/);
});

test('install uses the designated directory, never overwrites, rolls back partial writes and cleans temporary files', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-sdk-test-'));
  try {
    const directory = path.join(temporary, 'components');
    const fetchImpl = async () => reply(archive());
    const result = await installSdkFromUrl('https://example.com/sdk.zip', { directory, fetchImpl, hashes });
    assert.equal(result.directory, directory);
    assert.equal(await sdkStatus(directory, hashes), true);
    assert.deepEqual((await fs.readdir(directory)).sort(), Object.keys(components).sort());
    await assert.rejects(installSdkFromUrl('https://example.com/sdk.zip', { directory, fetchImpl, hashes }), /未覆盖/);
    await fs.unlink(path.join(directory, 'download.node'));
    await fs.writeFile(path.join(directory, 'xl_thunder_sdk.dll'), 'existing user file');
    await assert.rejects(installSdkFromUrl('https://example.com/sdk.zip', { directory, fetchImpl, hashes }), /未覆盖/);
    assert.deepEqual(await fs.readdir(directory), ['xl_thunder_sdk.dll']);
    assert.equal(await fs.readFile(path.join(directory, 'xl_thunder_sdk.dll'), 'utf8'), 'existing user file');
    assert.equal(await sdkStatus(directory, hashes), false);
    const invalid = path.join(temporary, 'invalid');
    await assert.rejects(installSdkFromUrl('https://example.com/sdk.zip', { directory: invalid, hashes, fetchImpl: async () => reply('not ZIP') }));
    await assert.rejects(fs.access(invalid));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('independent CLI accepts only the requested command and prompts for a URL', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-sdk-prompt-'));
  try {
    let prompted = false;
    await assert.rejects(runSdkInstaller(['status', 'xunlei', '--sdk'], { directory: temporary, question: async prompt => { prompted = prompt.includes('URL'); return 'http://invalid.example/sdk.zip'; } }), /HTTPS/);
    assert.equal(prompted, true);
    await assert.rejects(runSdkInstaller(['status', 'all', '--sdk']), /用法/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

const share = 'https://share.feijipan.com/s/Fixture123';
const listing = (fileList = [{ fileName: 'sdk.zip', fileId: 123456789, fileType: 1 }]) => ({ code: 200, status: 0, list: [{ fileList }] });
function decrypt(value) {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from('dingHao-disk-app'), null);
  return Buffer.concat([decipher.update(Buffer.from(value, 'hex')), decipher.final()]).toString('utf8');
}
function feijipanFetch(data = listing(), destination = 'https://kf-app.dinghaoinc.com/temporary/sdk.zip') {
  return async (raw, options) => {
    const url = new URL(raw);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    if (url.pathname === '/ws/recommend/list') {
      assert.equal(url.origin, 'https://api.feijipan.com');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(url.searchParams.get('shareId'), 'Fixture123');
      assert.equal(url.searchParams.get('code'), '');
      assert.match(decrypt(url.searchParams.get('timestamp')), /^\d{13}$/);
      assert.equal(options.headers.Origin, 'https://share.feijipan.com');
      return reply(JSON.stringify(data));
    }
    if (url.pathname === '/ws/file/redirect') {
      assert.equal(url.origin, 'https://api.feijipan.com');
      assert.equal(url.searchParams.get('enable'), '1');
      assert.equal(decrypt(url.searchParams.get('downloadId')), '123456789|');
      assert.equal(decrypt(url.searchParams.get('auth')), '123456789|' + decrypt(url.searchParams.get('timestamp')));
      return new Response(null, { status: 302, headers: { location: destination } });
    }
    assert.equal(url.hostname, 'kf-app.dinghaoinc.com');
    return reply(archive());
  };
}

test('Feijipan resolves anonymous official list, signed redirect and full ZIP without page execution', async () => {
  assert.deepEqual(await fetchSdkArchive(share, { fetchImpl: feijipanFetch() }), archive());
  assert.deepEqual(await resolveSdkSource('https://example.com/sdk.zip'), { url: 'https://example.com/sdk.zip', headers: {} });
});

test('Feijipan installs only verified components in selected directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-sdk-feijipan-'));
  try {
    await installSdkFromUrl(share, { directory, hashes, fetchImpl: feijipanFetch() });
    assert.equal(await sdkStatus(directory, hashes), true);
    assert.deepEqual((await fs.readdir(directory)).sort(), Object.keys(components).sort());
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Feijipan rejects protected, expired, malformed, directory and multi-file shares', async () => {
  for (const data of [null, { code: 403, status: 2 }, { code: 200, status: 2 }, listing([]), listing([{ fileType: 2, fileName: 'folder' }]), listing([{ fileType: 1, fileName: 'sdk.exe', fileId: 1 }]), listing([{ fileType: 1, fileName: 'a.zip', fileId: 1 }, { fileType: 1, fileName: 'b.zip', fileId: 2 }]), listing([{ fileType: 1, fileName: 'sdk.zip', fileId: 9007199254740992 }]), listing([{ fileType: 1, fileName: 'sdk.zip', fileId: 'invalid' }]), { code: 200, status: 0, list: [] }]) {
    await assert.rejects(resolveSdkSource(share, { fetchImpl: async () => reply(JSON.stringify(data)) }), /小飞机/);
  }
});

test('Feijipan share URL is strict and old Lanzou source is explicitly retired', async () => {
  for (const url of ['https://share.feijipan.com/nope', share + '?token=private', 'https://share.feijipan.com:444/s/Fixture123']) {
    await assert.rejects(resolveSdkSource(url, { fetchImpl: async () => assert.fail('unexpected request') }), /格式/);
  }
  await assert.rejects(resolveSdkSource('https://example.lanzoum.com/private'), /已改用小飞机/);
  await assert.rejects(resolveSdkSource('https://user:pass@share.feijipan.com/s/Fixture123'), /HTTPS/);
});

test('Feijipan rejects foreign or insecure redirect before making another request', async () => {
  for (const destination of ['http://kf-app.dinghaoinc.com/sdk.zip', 'https://attacker.example/sdk.zip', 'https://kf-app.dinghaoinc.com.attacker.example/sdk.zip']) {
    await assert.rejects(fetchSdkArchive(share, { fetchImpl: feijipanFetch(listing(), destination) }), /下载失败/);
  }
});

test('Feijipan sanitizes server/network errors and bounds metadata responses', async () => {
  for (const fetchImpl of [async () => { throw new Error('https://secret.example/private-token'); }, async () => reply('not JSON private-token'), async () => reply('{}', { 'content-length': String(2 * 1024 * 1024) }), async () => reply('x'.repeat(1024 * 1024 + 1)), async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } })]) {
    await assert.rejects(resolveSdkSource(share, { fetchImpl }), error => /小飞机分享读取失败/.test(error.message) && !/private-token|secret.example|attacker.example/.test(error.message));
  }
});

test('Feijipan CLI asks only for URL and wrong hashes leave target untouched', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ode-sdk-cli-feijipan-'));
  const prompts = [];
  try {
    await assert.rejects(runSdkInstaller(['status', 'xunlei', '--sdk'], { directory, question: async prompt => { prompts.push(prompt); return share; }, fetchImpl: feijipanFetch(), output: () => assert.fail('unexpected success') }), /SHA-256/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /小飞机/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

