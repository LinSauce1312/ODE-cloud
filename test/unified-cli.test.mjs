import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseArgs, run, HELP } from '../cli.mjs';
import { PLATFORMS } from '../src/cli-args.mjs';
import { fileInfo } from '../lib/download-progress.mjs';
import { createServices, prepareShare } from '../src/cli-runtime.mjs';

const urls = {
  xunlei: 'https://pan.xunlei.com/s/example', quark: 'https://pan.quark.cn/s/example',
  '115': 'https://115.com/s/swexample', pan123: 'https://www.123pan.com/s/Ab12-Z9',
  tianyi: 'https://cloud.189.cn/t/ABC', yidong: 'https://yun.139.com/shareweb/#/w/i/share1',
  baidu: 'https://pan.baidu.com/share/init?surl=example&pwd=nc1i',
};
const silent = () => {};
const withPassword = (url, platform, password = 'abcd') => {
  const parsed = new URL(url);
  parsed.searchParams.set(platform === 'tianyi' ? 'accessCode' : 'pwd', password);
  return parsed.href;
};

test('仅 --help 和命令 --help 展示统一帮助', async () => {
  for (const argv of [[], ['--help'], ['get', '--help']]) {
    let output;
    await run(argv, { output: value => { output = value; } });
    assert.equal(output, HELP);
    assert.match(output, /115/);
    assert.match(output, /--output/);
    assert.doesNotMatch(output, /share\|ls|direct\|dl|--password|--only|--no-check|--jobs/);
  }
});

test('账号参数契约不变且忽略旧密码环境', () => {
  assert.equal(parseArgs(['login', '115', '--browser', 'browser.exe']).options.browser, 'browser.exe');
  assert.equal(parseArgs(['login', 'quark', '--browser']).options.browser, true);
  assert.deepEqual(parseArgs(['login', 'xunlei']).options, {});
  assert.equal(parseArgs(['login', 'xunlei', '--sms', '13800138000']).options.sms, '13800138000');
  assert.deepEqual(parseArgs(['login', 'xunlei'], { env: { ODE_CLOUD_USER: 'user', ODE_CLOUD_PASS: 'secret' } }).options, {});
  for (const platform of PLATFORMS) {
    assert.equal(parseArgs(['logout', platform]).platform, platform);
    assert.equal(parseArgs(['whoami', platform]).platform, platform);
    assert.equal(parseArgs(['status', platform, '--verify']).options.verify, true);
  }
});

test('get 必填 output 基于 cwd 解析，file 单次中英逗号 trim 去重', () => {
  const parsed = parseArgs(['get', urls['115'], '--output', 'relative-target', '--file', ' folder/file.zip ， readme.txt,folder/file.zip ', '--workers', '3', '--chunk', '2']);
  assert.equal(parsed.target, path.resolve('relative-target'));
  assert.equal(parsed.options.engine, 'http');
  assert.equal(parsed.options.workers, 3);
  assert.equal(parsed.options.chunkSize, 2097152);
  assert.deepEqual(parsed.options.file, ['folder/file.zip', 'readme.txt']);
  assert.equal(parseArgs(['get', urls.xunlei, '--output', 'target', '--engine', 'sdk']).options.engine, 'sdk');
});

test('无效命令和参数在访问服务之前拒绝', async () => {
  let calls = 0;
  const services = new Proxy({}, { get() { calls += 1; throw new Error('service must not be called'); } });
  const invalid = [
    ['unknown'], ['-h'], ['help'], ['ls', urls.quark], ['dl', 'https://example.test/a', '--output', 'a.zip'],
    ['login', 'unknown'], ['login', '115', '--sms', '13800138000'], ['login', 'xunlei', '--sms', 'invalid'],
    ['login', 'xunlei', '--sms', '13800138000', '--user', 'account'], ['login', 'pan123', '--password', 'secret'],
    ['login', 'xunlei', '--user', 'account'], ['get', urls['115']], ['get', urls['115'], 'target'],
    ['get', urls['115'], 'target', '--output', 'other'], ['get', urls['115'], '--output'],
    ['get', urls['115'], '--output', ''], ['get', urls['115'], '--output', 'target', '--workers', '0'],
    ['get', urls['115'], '--output', 'target', '--workers', '33'], ['get', urls['115'], '--output', 'target', '--chunk', '0'],
    ['get', urls['115'], '--output', 'target', '--chunk', '1.5'], ['get', urls['115'], '--output', 'target', '--chunk', '9007199254740992'],
    ['get', urls.quark, '--output', 'target', '--engine', 'sdk'], ['get', urls.xunlei, '--output', 'target', '--engine', 'other'],
    ['get', urls.xunlei, '--output', 'target', '--engine', 'sdk', '--workers', '8'],
    ['get', urls.xunlei, '--output', 'target', '--engine', 'sdk', '--chunk', '2'],
    ['get', urls['115'], '--output', 'target', '--file', '../escape'], ['get', urls['115'], '--output', 'target', '--file', '/absolute'],
    ['get', urls['115'], '--output', 'target', '--file', 'C:/absolute'], ['get', urls['115'], '--output', 'target', '--file', 'a.zip,../escape'],
    ['get', urls['115'], '--output', 'target', '--file', ' ,， '],
    ['get', urls['115'], '--output', 'target', '--file', 'a.zip,,b.zip'],
    ['get', urls['115'], '--output', 'target', '--file', 'a.zip', '--file', 'b.zip'],
    ['get', urls['115'], '--output', 'target', '--output', 'other'],
    ['get', 'https://115.com.evil.test/s/swexample', '--output', 'target'],
    ['direct', 'file:///tmp/a', '--output', 'out'], ['direct', 'https://example.test/a', '--output', 'out', '--engine', 'sdk'],
    ['direct', 'https://example.test/a', 'out'], ['direct', 'https://example.test/a', '--output', 'folder/'],
    ['direct', 'https://user:secret@example.test/a', '--output', 'out'],
    ['status', 'all', '--verify', '--verify'], ['share', urls['115'], '--password'], ['share', urls['115'], '--json'],
    ['share', urls['115'], '--output', 'target'], ['share', urls['115'], '--file', 'a.zip'],
    ['login'], ['logout'], ['status'], ['whoami'], ['status', 'xunlei'], ['status', 'all', '--verify'],
    ['login', 'quark', 'browser.exe'], ['login', 'xunlei', '--browser', '--sms', '13800138000'],
    ['login', 'xunlei', '--user', 'account', '--pass', 'secret'], ['login', 'pan123', '--account', 'account'],
    ['login', 'xunlei', '--browser', ''], ['login', 'xunlei', '--browser', '--browser'],
    ['fingerprint'], ['fingerprint', 'xunlei'], ['login-cloud', '115'], ['logout-cloud', '115'], ['whoami', 'all'], ['logout', 'all'],
  ];
  for (const alias of ['--out', '-o', '--jobs', '-j', '-s', '--only', '--password', '--json', '--no-check', '-h']) {
    invalid.push(['get', urls.xunlei, '--output', 'target', alias, 'value']);
    invalid.push(['direct', 'https://cdn.example/file', '--output', 'target.zip', alias, 'value']);
  }
  for (const argv of invalid) await assert.rejects(run(argv, { services, output: silent }), undefined, argv.join(' '));
  assert.equal(calls, 0);
});

test('status all 在线验证全部七平台', async () => {
  const calls = [];
  const result = await run(['status', 'all'], { services: { status: async (platform, options) => { calls.push([platform, options.verify]); return { platform }; } }, output: silent });
  assert.deepEqual(calls.map(value => value[0]), PLATFORMS);
  assert.equal(result.length, 7);
  assert.ok(calls.every(value => value[1] === true));
});

test('七平台从单一 get 分派，密码来自 URL 或分享文案而非flag', async () => {
  for (const [platform, url] of Object.entries(urls)) {
    let received;
    await run(['get', withPassword(url, platform), '--output', 'target', '--file', 'folder/file.zip,readme.txt', '--chunk', '2'], {
      output: silent, services: { download: async (...args) => { received = args; return { results: [] }; } },
    });
    assert.equal(received[0].platform, platform);
    assert.ok(received[0].raw.includes('abcd'));
    assert.equal(received[1], path.resolve('target'));
    assert.deepEqual(received[2].file, ['folder/file.zip', 'readme.txt']);
    assert.equal(received[2].chunkSize, 2097152);
    assert.equal(received[2].engine, 'http');
    const prepared = prepareShare('分享链接：' + url + ' 提取码：nc1i');
    assert.ok(prepared.raw.includes('提取码：nc1i'));
    assert.equal(prepared.platform, platform);
  }
  assert.ok(prepareShare(urls.baidu).url.includes('pwd=nc1i'));
});

test('share 无options输出 platform/files，所有文件保留完整层级路径而非tree', async () => {
  for (const [platform, url] of Object.entries(urls)) {
    let received;
    const result = await run(['share', withPassword(url, platform)], { output: silent, services: {
      open: async prepared => { received = prepared; return { platform, files: [{ name: 'folder/nested/file.zip', size: 3 }, { name: 'root.txt', size: 1 }] }; },
    } });
    assert.ok(received.raw.includes('abcd'));
    assert.deepEqual(Object.keys(result).sort(), ['files', 'platform']);
    assert.equal(result.files[0].name, 'folder/nested/file.zip');
  }
  const files = [{ name: 'folder/nested/file.zip', size: 3 }, { name: 'root.txt', size: 1 }];
  const services = createServices({
    loadCloudCredential: async () => ({ authorization: 'authorization' }),
    openYidongShare: async () => ({ files, tree: [{ name: 'folder', type: 'folder', children: [] }], share: {}, client: {} }),
  });
  assert.deepEqual(await services.open(prepareShare(urls.yidong)), { platform: 'yidong', count: 2, totalBytes: 4, files: files.map(fileInfo) });
});

test('115 按完整 path 精确筛选并转发 HTTP chunk', async () => {
  const files = [{ name: 'folder/one.zip', size: 3 }, { name: 'folder/two.txt', size: 4 }];
  let pipelineOptions;
  let downloadOptions;
  const services = createServices({
    loadBrowserCredential: async platform => { assert.equal(platform, '115'); return 'cookie'; },
    cloudClient: () => ({ resolve: async () => ({ files }), link: async () => ({ url: 'https://cdn.example/file' }) }),
    runCloudPipeline: async options => { pipelineOptions = options; return { results: [] }; },
    downloadHttp: async options => { downloadOptions = options; return {}; },
  });
  await run(['get', withPassword(urls['115'], '115'), '--output', 'target', '--file', 'folder/two.txt', '--chunk', '2'], { services, output: silent });
  assert.equal(pipelineOptions.platform, '115');
  assert.ok(pipelineOptions.shareUrl.includes('pwd=abcd'));
  assert.deepEqual((await pipelineOptions.client.resolve()).files, [files[1]]);
  await pipelineOptions.httpDownloader({ url: 'https://cdn.example/file', workers: 8 });
  assert.equal(downloadOptions.chunkSize, 2097152);
  await assert.rejects(run(['get', urls['115'], '--output', 'target', '--file', 'two.txt'], { services, output: silent }), /未找到文件/);
});

test('quark 多个完整路径筛选，不按扩展名片段筛选', async () => {
  let pipelineOptions;
  const services = createServices({
    loadBrowserCredential: async () => 'cookie',
    cloudClient: () => ({ resolveShare: async (url) => { assert.ok(url.includes('pwd=abcd')); return { files: [{ name: 'folder/one.zip' }, { name: 'two.txt' }, { name: 'three.bin' }], share: {} }; } }),
    runCloudPipeline: async options => { pipelineOptions = options; return { results: [] }; },
  });
  await run(['get', withPassword(urls.quark, 'quark'), '--output', 'target', '--file', 'folder/one.zip，two.txt'], { services, output: silent });
  assert.deepEqual((await pipelineOptions.client.resolveShare()).files.map(file => file.name), ['folder/one.zip', 'two.txt']);
});

test('xunlei HTTP 参数和 SDK 路径均仅 mock 原pipeline，不加载原生内核', async () => {
  let received;
  const services = createServices({
    authLoader: async () => ({ loggedIn: true }),
    xunleiShareFactory: () => ({ list: async () => [{ name: 'folder/one.zip' }], links: async () => new Map() }),
    runPipeline: async options => { received = options; return { results: [] }; },
  });
  await run(['get', urls.xunlei, '--output', 'target', '--file', 'folder/one.zip', '--workers', '3', '--chunk', '2'], { services, output: silent });
  assert.equal(received.engine, 'http');
  assert.equal(Object.hasOwn(received, 'check'), false);
  assert.equal(received.chunkSize, 2097152);
  assert.equal(received.workers, 3);
  assert.deepEqual(received.files, ['folder/one.zip']);
  await run(['get', urls.xunlei, '--output', 'target', '--engine', 'sdk'], { services, output: silent });
  assert.equal(received.engine, 'sdk');
  assert.equal(Object.hasOwn(received, 'check'), false);
});

test('pan123 tianyi yidong 复用认证 opener，保持路径、请求头和取链刷新', async () => {
  for (const platform of ['pan123', 'tianyi', 'yidong']) {
    let downloaded;
    let links = 0;
    const opened = { files: [{ name: 'folder/file.zip', size: 3 }], share: {}, client: { getShareDownloadLink: async () => { links += 1; return { url: 'https://cdn.example/file', headers: { Cookie: 'cdn' } }; } } };
    const opener = 'open' + { pan123: 'Pan123', tianyi: 'Tianyi', yidong: 'Yidong' }[platform] + 'Share';
    const services = createServices({
      loadCloudCredential: async () => ({ token: 'token', cookie: 'cookie', authorization: 'authorization' }),
      [opener]: async () => opened,
      downloadHttp: async options => { downloaded = options; await options.onExpired(); return { size: 3 }; },
    });
    await run(['get', urls[platform], '--output', 'target', '--file', 'folder/file.zip', '--chunk', '2'], { services, output: silent });
    assert.equal(downloaded.dest, path.resolve('target', 'folder', 'file.zip'));
    assert.equal(downloaded.chunkSize, 2097152);
    assert.equal(downloaded.headers.Cookie, 'cdn');
    assert.equal(links, 2);
  }
});

test('browser login supports every platform and xunlei sms remains the only direct login', async () => {
  const calls = [];
  const services = {
    login: async (platform, options) => { calls.push([platform, options]); return { platform, saved: true, verified: null, message: 'saved' }; },
  };
  for (const platform of PLATFORMS) {
    await run(['login', platform], { services, output: silent });
    await run(['login', platform, '--browser'], { services, output: silent });
    await run(['login', platform, '--browser', 'browser.exe'], { services, output: silent });
  }
  await run(['login', 'xunlei', '--sms', '13800138000'], { services, output: silent });
  assert.equal(calls.length, 22);
  assert.ok(calls.some(([platform, options]) => platform === '115' && options.browser === true));
  assert.equal(calls.at(-1)[1].sms, '13800138000');
});

test('strict account status verification dispatch always requests online verification', async () => {
  const calls = [];
  const services = { status: async (platform, options) => { calls.push([platform, options.verify]); return { platform, saved: true, verified: options.verify ? true : null, message: 'example' }; } };
  for (const platform of PLATFORMS) await run(['status', platform, '--verify'], { services, output: silent });
  assert.deepEqual(calls.map(([platform]) => platform), PLATFORMS);
  assert.ok(calls.every(([, verify]) => verify === true));
});

test('logout requires and forwards every explicit platform', async () => {
  const calls = [];
  const services = { logout: async platform => { calls.push(platform); return { platform, saved: false, verified: null, message: 'removed' }; } };
  for (const platform of PLATFORMS) await run(['logout', platform], { services, output: silent });
  assert.deepEqual(calls, PLATFORMS);
});


test('whoami 转发七平台，direct 仅用严格 output/http/workers/chunk 参数', async () => {
  const accounts = [];
  const calls = [];
  const services = {
    whoami: async platform => { accounts.push(platform); return { platform, saved: true, verified: true, account: { name: 'example' } }; },
    direct: async (...args) => { calls.push(args); return { size: 3 }; },
  };
  for (const platform of PLATFORMS) assert.equal((await run(['whoami', platform], { services, output: silent })).account.name, 'example');
  assert.deepEqual(accounts, PLATFORMS);
  await run(['direct', 'https://cdn.example/file', '--output', 'target.zip', '--engine', 'http', '--chunk', '2', '--workers', '4'], { services, output: silent });
  assert.equal(calls[0][1], path.resolve('target.zip'));
  assert.equal(calls[0][2].engine, 'http');
  assert.equal(calls[0][2].workers, 4);
  assert.equal(calls[0][2].chunkSize, 2097152);
});

test('get 和 direct 结果统一汇总绝对路径、数量与总字节', async () => {
  const result = await run(['get', urls.pan123, '--output', 'target'], { output: silent, services: {
    download: async () => ({ results: [{ name: 'folder/a.zip', size: 3 }, { name: 'b.txt', size: 4 }] }),
  } });
  assert.deepEqual(result, {
    platform: 'pan123', engine: 'http', output: path.resolve('target'), count: 2, totalBytes: 7,
    results: [
      { ...fileInfo({ name: 'folder/a.zip', size: 3 }), path: path.resolve('target', 'folder', 'a.zip'), status: 'done' },
      { ...fileInfo({ name: 'b.txt', size: 4 }), path: path.resolve('target', 'b.txt'), status: 'done' },
    ],
  });
  const direct = await run(['direct', 'https://cdn.example/file', '--output', 'target.zip'], { output: silent, services: {
    direct: async () => ({ results: [{ name: 'target.zip', path: path.resolve('target.zip'), size: 3 }] }),
  } });
  assert.equal(direct.platform, 'direct');
  assert.equal(direct.engine, 'http');
  assert.equal(direct.output, path.resolve('target.zip'));
  assert.equal(direct.count, 1);
  assert.equal(direct.totalBytes, 3);
  assert.equal(direct.results[0].status, 'done');
});

test('pipeline 失败先输出脱敏JSON再退出2，不泄漏原始签名URL', async () => {
  const outputs = [];
  await assert.rejects(run(['get', urls['115'], '--output', 'target'], {
    services: { download: async () => ({ results: [{ name: 'a.zip', size: 3, status: 'failed', error: 'HTTP https://cdn.example/file?token=secret' }] }) },
    output: value => outputs.push(value),
  }), error => {
    assert.equal(outputs.length, 1);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /部分下载任务失败/);
    assert.doesNotMatch(error.message, /secret|https:/);
    return true;
  });
  const result = JSON.parse(outputs[0]);
  assert.equal(result.results[0].status, 'failed');
  assert.doesNotMatch(outputs[0], /token=secret|cdn[.]example/);
});
