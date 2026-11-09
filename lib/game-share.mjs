import crypto from 'node:crypto';

const BASE = 'https://game-asst.xunlei.com/api/download/v1/';

export function safeSharePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('分享文件名为空');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('分享文件路径不是相对路径');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
    throw new Error(`分享文件路径不安全：${value}`);
  }
  return parts.join('/');
}

export function isCloudShare(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'pan.xunlei.com';
  } catch {
    return false;
  }
}

export class GameAssistantShare {
  constructor(auth, { base = BASE, fetchImpl = fetch } = {}) {
    this.auth = auth;
    this.base = base;
    this.fetchImpl = fetchImpl;
  }

  async request(endpoint, body) {
    const token = await this.auth.ensureFresh();
    const peerId = this.auth.cred.peerId ||= `${crypto.createHash('sha1').update(this.auth.deviceId).digest('hex').slice(0, 15)}V`;
    const response = await this.fetchImpl(new URL(endpoint, this.base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-version': '1.16.6',
        'X-Device-ID': this.auth.deviceId,
        'X-Peer-ID': peerId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => { throw new Error(`解析服务返回非 JSON（HTTP ${response.status}）`); });
    if (!response.ok || (json.code !== undefined && json.code !== 0)) {
      throw new Error(json.message || `解析服务返回 HTTP ${response.status} / code ${json.code}`);
    }
    return json.data || {};
  }

  async list(url) {
    if (!isCloudShare(url)) throw new Error('仅支持 https://pan.xunlei.com/ 的分享链接');
    const data = await this.request('TransferSpeedURL', { url });
    if (!Array.isArray(data.shareFiles) || data.shareFiles.length === 0) throw new Error('云盘链接解析失败或分享为空');
    const files = data.shareFiles.map((item) => ({
      gcid: String(item.gcid || ''),
      name: safeSharePath(item.fileName),
      size: Number(item.fileSize),
    }));
    if (files.some((file) => !file.gcid || !Number.isSafeInteger(file.size) || file.size < 0)) {
      throw new Error('分享文件缺少有效的 gcid 或 fileSize');
    }
    return files;
  }

  async links(gcids, { withTokens = false } = {}) {
    const data = await this.request('ParseFileURL', { gcids });
    if (!Array.isArray(data.speedInfos)) throw new Error('解析服务未返回 speedInfos');
    return new Map(data.speedInfos.map((item) => [String(item.gcid), withTokens
      ? { url: String(item.url || ''), token: typeof item.token === 'string' ? item.token : '' }
      : String(item.url || '')]));
  }
}
