import path from 'node:path';
import { stat } from 'node:fs/promises';
import { CRED_FILE, DOWNLOAD_UA } from '../lib/config.mjs';
import { createInterface } from 'node:readline/promises';
import { XunleiAuth } from '../lib/auth.mjs';
import { loginXunleiWithBrowser } from '../lib/web-login.mjs';
import { loginWithBrowser, loadCloudCredential as loadBrowserCredential, loadCloudCredentialRecord, clearCloudCredential } from '../lib/browser-login.mjs';
import { loginCloud, inspectCloudAccount, safeCloudIdentity, hasCloudIdentity, loadCloudCredential, clearCredential } from './cloud-login.mjs';
import { openBaiduShare, parseBaiduShareUrl } from './baidu-share.mjs';
import { createDownloadProgress, fileInfo } from '../lib/download-progress.mjs';
import { openPan123Share, parsePan123Share } from './pan123-share.mjs';
import { openTianyiShare, parseTianyiShareUrl } from './tianyi-share.mjs';
import { openYidongShare, parseYidongShareUrl } from './yidong-share.mjs';
import { parseQuarkShareUrl } from '../lib/quark.mjs';
import { parse115ShareUrl } from '../lib/pan115.mjs';
import { GameAssistantShare, safeSharePath } from '../lib/game-share.mjs';
import { cloudClient, runCloudPipeline } from '../lib/cloud-pipeline.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { download as downloadHttp } from '../lib/engine.mjs';

export function prepareShare(raw, options = {}) {
  const match = String(raw).match(/https?:\/\/[^\s<>"'，。]+|(?:pan\.quark\.cn|115\.com|115cdn\.com|115rc\.com)\/s\/[^\s<>"']+/i);
  if (!match) throw new Error('请输入网盘官方分享链接');
  const original = match[0].replace(/[),，。；;]+$/, '');
  const url = new URL(/^https?:/i.test(original) ? original : 'https://' + original);
  if (url.protocol === 'http:' && url.hostname === 'pan.baidu.com' && !url.username && !url.password && !url.port) url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('只接受无嵌入凭据的官方 HTTPS 分享链接');
  const host = url.hostname.toLowerCase();
  const domains = { 'pan.xunlei.com': 'xunlei', 'pan.quark.cn': 'quark', '115.com': '115', '115cdn.com': '115', '115rc.com': '115', 'cloud.189.cn': 'tianyi', 'yun.139.com': 'yidong', 'pan.baidu.com': 'baidu', '123pan.com': 'pan123', 'www.123pan.com': 'pan123', '123pan.cn': 'pan123', 'www.123pan.cn': 'pan123', '123865.com': 'pan123', 'www.123865.com': 'pan123', '123865.cn': 'pan123', 'www.123865.cn': 'pan123', 'share.123pan.cn': 'pan123' };
  const platform = domains[host];
  if (!platform) throw new Error('无法识别官方分享平台');

  const value = String(raw).replace(original, url.href);
  const parsers = { baidu: parseBaiduShareUrl, quark: parseQuarkShareUrl, '115': parse115ShareUrl, pan123: parsePan123Share, tianyi: parseTianyiShareUrl, yidong: parseYidongShareUrl };
  parsers[platform]?.(value);
  if (options.engine === 'sdk' && platform !== 'xunlei') throw new Error('只有迅雷分享支持 SDK/P2SP');
  return { platform, raw: value, url: url.href };
}

export function createServices(overrides = {}) {
  const dependencies = {
    authLoader: () => XunleiAuth.load(), loginXunleiWithBrowser, loginWithBrowser, loginCloud,
    inspectCloudAccount, loadBrowserCredential, loadCloudCredentialRecord, clearCloudCredential, loadCloudCredential, clearCredential,
    cloudClient, runCloudPipeline, runPipeline, downloadHttp,
    xunleiShareFactory: auth => new GameAssistantShare(auth), openBaiduShare, openPan123Share, openTianyiShare, openYidongShare,
    terminalFactory: () => createInterface({ input: process.stdin, output: process.stdout }), stat,
    ...overrides,
  };
  const requireAuth = async () => {
    const auth = await dependencies.authLoader();
    if (!auth.loggedIn) throw new Error('请先执行 node cli.mjs login xunlei');
    return auth;
  };
  const requireCookie = async platform => {
    const cookie = await dependencies.loadBrowserCredential(platform);
    if (!cookie) throw new Error('请先执行 node cli.mjs login ' + platform);
    return cookie;
  };
  const question = async prompt => {
    const terminal = dependencies.terminalFactory();
    try { return await terminal.question(prompt); } finally { terminal.close(); }
  };
  const resolveCloud = async prepared => {
    if (['quark', '115'].includes(prepared.platform)) {
      const cookie = await requireCookie(prepared.platform);
      const client = dependencies.cloudClient(prepared.platform, cookie);
      const resolved = prepared.platform === 'quark'
        ? await client.resolveShare(prepared.raw)
        : await client.resolve(prepared.raw);
      return { platform: prepared.platform, cookie, client, resolved, files: resolved.files };
    }
    if (prepared.platform === 'xunlei') {
      const auth = await requireAuth();
      const share = dependencies.xunleiShareFactory(auth);
      return { platform: prepared.platform, auth, share, files: await share.list(prepared.url) };
    }
    if (prepared.platform === 'baidu') {
      const credential = await dependencies.loadCloudCredential('baidu');
      const openAnonymous = async () => {
        const resolved = await dependencies.openBaiduShare(prepared.raw, {});
        return { platform: prepared.platform, ...resolved, resolved };
      };
      if (credential?.cookie) {
        try {
          const resolved = await dependencies.openBaiduShare(prepared.raw, credential);
          return { platform: prepared.platform, ...resolved, resolved };
        } catch (error) {
          if (!/重新认证/.test(String(error?.message || ''))) throw error;
          return openAnonymous();
        }
      }
      return openAnonymous();
    }
    const credential = await dependencies.loadCloudCredential(prepared.platform);
    const required = prepared.platform === 'pan123' ? 'token' : prepared.platform === 'yidong' ? 'authorization' : 'cookie';
    if (!credential?.[required]) throw new Error('请先执行 node cli.mjs login ' + prepared.platform);
    const opener = { pan123: dependencies.openPan123Share, tianyi: dependencies.openTianyiShare, yidong: dependencies.openYidongShare }[prepared.platform];
    const resolved = await opener(prepared.raw, credential);
    return { platform: prepared.platform, ...resolved, resolved };
  };
  const freshLinkFor = async (prepared, opened, file) => {
    if (prepared.platform === 'xunlei') {
      const map = await opened.share.links([file.gcid], { withTokens: false });
      const url = map.get(file.gcid);
      if (!url) throw new Error('未获得可用直链');
      return { url, headers: { 'user-agent': DOWNLOAD_UA, referer: 'https://pan.xunlei.com/' }, size: file.size };
    }
    if (prepared.platform === 'quark' || prepared.platform === '115') {
      const link = prepared.platform === 'quark'
        ? await opened.client.getShareDownloadLink(opened.resolved.share, file)
        : await opened.client.link(prepared.raw, file);
      if (!/^https:\/\//i.test(link.url)) throw new Error('刷新后的网盘直链不是 HTTPS');
      if (!link.headers?.cookie && !link.headers?.Cookie) throw new Error('网盘直链缺少认证 Cookie');
      return { url: link.url, headers: link.headers, size: link.size || file.size };
    }
    const link = await opened.client.getShareDownloadLink(opened.resolved.share, file);
    const url = new URL(link.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('网盘未返回安全 HTTPS 下载链接');
    return { url: link.url, headers: link.headers, size: link.size || file.size };
  };
  const state = (platform, saved, verified = null, capturedAt = null) => ({ platform, saved: Boolean(saved), verified: saved ? verified : false, capturedAt: saved ? capturedAt || null : null });
  const accountFields = safeCloudIdentity;
  const inspect = async (platform, verify) => {
    if (platform === 'xunlei') {
      const auth = await dependencies.authLoader();
      const saved = auth.loggedIn;
      let account = null;
      if (saved && verify) {
        try {
          const response = await auth.me();
          if (hasCloudIdentity(response)) account = accountFields(response);
        } catch {}
      }
      return { status: state(platform, saved, verify ? Boolean(account) : null, auth.cred?.capturedAt), account };
    }
    if (platform === '115') {
      const record = await dependencies.loadCloudCredentialRecord(platform);
      let result = { verified: null, account: null };
      if (record.cookie && verify) {
        try { result = await dependencies.inspectCloudAccount(platform, record); }
        catch { result = { verified: false, account: null }; }
      }
      return { status: state(platform, Boolean(record.cookie), result.verified, record.capturedAt), account: result.account };
    }
    const credential = await dependencies.loadCloudCredential(platform);
    const required = platform === 'pan123' ? 'token' : platform === 'yidong' ? 'authorization' : 'cookie';
    const saved = Boolean(credential?.[required]);
    let result = { verified: null, account: null };
    if (saved && verify) {
      try { result = await dependencies.inspectCloudAccount(platform, credential); }
      catch { result = { verified: false, account: null }; }
    }
    return { status: state(platform, saved, result.verified, credential?.capturedAt), account: result.account };
  };
  return {
    async login(platform, options, output = () => {}) {
      if (platform === 'xunlei' && options.sms) {
        const auth = await dependencies.authLoader();
        const previous = { ...auth.cred };
        const persist = auth.save;
        auth.save = async () => {};
        try {
          const sent = await auth.sendSmsCode(options.sms);
          if (!sent.verificationId) throw new Error('迅雷未返回 verification_id');
          const code = (await question('请输入短信验证码（此终端输入会回显）：')).trim();
          if (!/^\d{4,8}$/.test(code)) throw new Error('短信验证码格式无效');
          await auth.loginWithSmsCode(options.sms, code, sent.verificationId);
          output('已检测到迅雷云盘会话，正在校验官方账号接口…');
          if (!hasCloudIdentity(await auth.me())) throw new Error('官方账号校验失败，未保存新会话');
          auth.cred.capturedAt = new Date().toISOString();
          await persist.call(auth);
          output('官方账号校验通过，登录状态已保存在本机' + CRED_FILE);
          return state(platform, true, true, auth.cred.capturedAt);
        } catch (error) { auth.cred = previous; throw error; }
        finally { auth.save = persist; }
      }
      let terminal;
      let pendingAnswer = false;
      const manualConfirm = async () => {
        if (!terminal) {
          terminal = dependencies.terminalFactory();
          terminal.on('line', line => { if (['yes', 'y'].includes(String(line).trim().toLowerCase())) pendingAnswer = true; });
        }
        const answer = pendingAnswer;
        pendingAnswer = false;
        return answer;
      };
      let result;
      try {
        const browserOptions = { browserPath: typeof options.browser === 'string' ? options.browser : undefined, onStatus: output, manualConfirm };
        if (platform === 'xunlei') result = await dependencies.loginXunleiWithBrowser(await dependencies.authLoader(), browserOptions);
        else if (platform === '115') result = await dependencies.loginWithBrowser(platform, browserOptions);
        else result = await dependencies.loginCloud(platform, browserOptions);
      } finally { terminal?.close(); }
      const { status } = await inspect(platform, false);
      return { ...status, verified: platform === 'xunlei' ? true : result?.verified ?? null };
    },
    async logout(platform) {
      if (platform === 'xunlei') await (await dependencies.authLoader()).logout();
      else if (platform === '115' || platform === 'quark') await dependencies.clearCloudCredential(platform);
      else await dependencies.clearCredential(platform);
      return state(platform, false);
    },
    async status(platform) { return (await inspect(platform, true)).status; },
    async whoami(platform) {
      const { status, account } = await inspect(platform, true);
      return { ...status, account };
    },
    async open(prepared) {
      const opened = await resolveCloud(prepared);
      return { platform: prepared.platform, count: opened.files.length, totalBytes: opened.files.every(file => Number.isSafeInteger(file.size) && file.size >= 0) ? opened.files.reduce((total, file) => total + file.size, 0) : null, files: opened.files.map(fileInfo) };
    },
    async link(prepared, options) {
      if (prepared.platform === 'baidu') throw new Error('暂不支持百度网盘下载链接（仅支持 node cli.mjs share 列出文件）');
      const opened = await resolveCloud(prepared);
      const requested = options.file;
      const available = new Set(opened.files.map(file => safeSharePath(file.name)));
      for (const name of requested || []) if (!available.has(name)) throw new Error('未找到文件：' + name);
      const selected = opened.files.filter(file => !requested || requested.includes(safeSharePath(file.name)));
      if (!selected.length) throw new Error('没有匹配的可导出文件');
      const links = [];
      for (const file of selected) {
        const fresh = await freshLinkFor(prepared, opened, file);
        links.push({ name: safeSharePath(file.name), size: file.size, url: fresh.url, headers: fresh.headers || {} });
      }
      return { platform: prepared.platform, count: links.length,
        totalBytes: selected.every(file => Number.isSafeInteger(file.size) && file.size >= 0) ? selected.reduce((total, file) => total + file.size, 0) : null,
        links };
    },
    async download(prepared, target, options, onProgress) {
      if (prepared.platform === 'baidu') throw new Error('暂不支持百度网盘下载（不转存下载）；仅支持 node cli.mjs share 列出百度分享文件');
      const opened = await resolveCloud(prepared);
      if (prepared.platform === 'xunlei') return dependencies.runPipeline({
        auth: opened.auth, share: { list: async () => opened.files, links: (...args) => opened.share.links(...args) },
        shareUrl: prepared.url, outDir: target, workers: options.workers, chunkSize: options.chunkSize,
        files: options.file || [], engine: options.engine, progress: onProgress,
      });
      const requested = options.file;
      const available = new Set(opened.files.map(file => safeSharePath(file.name)));
      for (const name of requested || []) if (!available.has(name)) throw new Error('未找到文件：' + name);
      const selected = opened.files.filter(file => !requested || requested.includes(safeSharePath(file.name)));
      if (!selected.length) throw new Error('没有匹配的可下载文件');
      if (['quark', '115'].includes(prepared.platform)) {
        const client = Object.create(opened.client);
        const resolved = { ...opened.resolved, files: selected };
        if (prepared.platform === 'quark') client.resolveShare = async () => resolved;
        else client.resolve = async () => resolved;
        return dependencies.runCloudPipeline({ platform: prepared.platform, cookie: opened.cookie, client, shareUrl: prepared.raw,
          outDir: target, workers: options.workers, engine: options.engine, progress: onProgress,
          httpDownloader: args => dependencies.downloadHttp({ ...args, chunkSize: options.chunkSize }),
        });
      }
      const results = [];
      const reporter = createDownloadProgress({ platform: prepared.platform, engine: options.engine, files: selected, onProgress });
      reporter.plan();
      for (const [offset, file] of selected.entries()) {
        const index = offset + 1;
        const name = safeSharePath(file.name);
        const destination = path.join(target, ...name.split('/'));
        reporter.event('start', index);
        try {
          const freshLink = () => freshLinkFor(prepared, opened, file);
          const link = await freshLink();
          const expected = file.size || link.size || undefined;
          const transfer = await dependencies.downloadHttp({ url: link.url, dest: destination, size: expected,
            headers: link.headers, workers: options.workers, chunkSize: options.chunkSize, onExpired: freshLink,
            onProgress: reporter.transfer(index),
          });
          if (expected !== undefined && transfer.size !== expected) throw new Error('下载文件大小不符');
          reporter.event('done', index, { size: transfer.size });
          results.push({ name, path: destination, size: transfer.size, status: 'done' });
        } catch (error) {
          reporter.event('failed', index);
          const reason = String(error?.message || '').trim();
          results.push({ name, path: destination, size: file.size ?? null, status: 'failed',
            error: reason ? reason : '下载失败，请检查账号权限、分享有效性、网络和目标目录' });
        }
      }
      return { results };
    },
    async direct(value, target, options, onProgress) {
      const host = new URL(value).hostname.toLowerCase();
      if (['pan.quark.cn', 'pan.baidu.com', 'pan.xunlei.com', '115.com', '115cdn.com', '115rc.com', 'cloud.189.cn', 'yun.139.com', '123pan.com', '123pan.cn', '123865.com', '123865.cn'].some(domain => host === domain || host.endsWith('.' + domain))) throw new Error('网盘分享页请使用 get，而不是 direct');
      const metadata = await dependencies.stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (metadata?.isDirectory()) throw new Error('direct 目标必须是文件名，不能是目录');
      const name = path.basename(target);
      const reporter = createDownloadProgress({ platform: 'direct', files: [{ name }], onProgress });
      reporter.plan();
      reporter.event('start', 1);
      try {
        const transfer = await dependencies.downloadHttp({ url: value, dest: target, workers: options.workers, chunkSize: options.chunkSize, onProgress: reporter.transfer(1) });
        reporter.event('done', 1, { size: transfer.size });
        return { results: [{ name, path: target, size: transfer.size, status: 'done' }] };
      } catch {
        reporter.event('failed', 1);
        return { results: [{ name, path: target, size: null, status: 'failed', error: '下载失败，请检查直链、网络和目标目录' }] };
      }
    },
  };
}
