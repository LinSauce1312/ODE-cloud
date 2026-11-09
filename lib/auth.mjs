// 账号会话层：官网浏览器登录、短信验证码登录与令牌刷新。
// 全程使用你自己的账号，产出的 token 只可能拿到你自己账号本身拥有的权限。
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  XLUSER_V1, CLIENT_ID, CLIENT_SECRET,
  CLIENT_VERSION, USER_AGENT,
  TOKEN_REFRESH_SKEW_MS, CRED_FILE, HOME,
} from './config.mjs';

const REDIRECT_URI = 'xlaccsdk01://xunlei.com/callback?state=harbor';

export class XlApiError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.name = 'XlApiError';
    this.code = code;
    this.payload = payload;
  }
}

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};

export class XunleiAuth {
  constructor(cred) {
    this.cred = cred;
    this._refreshing = null;
  }

  static async load() {
    try {
      const raw = await fs.readFile(CRED_FILE, 'utf8');
      const cred = JSON.parse(raw);
      if (!cred.deviceId) cred.deviceId = crypto.randomBytes(16).toString('hex');
      return new XunleiAuth(cred);
    } catch {
      return new XunleiAuth({ deviceId: crypto.randomBytes(16).toString('hex') });
    }
  }

  async save() {
    await fs.mkdir(path.dirname(CRED_FILE), { recursive: true });
    await fs.writeFile(CRED_FILE, JSON.stringify(this.cred, null, 2), { mode: 0o600 });
  }

  get loggedIn() {
    return Boolean(this.cred.accessToken && this.cred.refreshToken);
  }

  get deviceId() {
    return this.cred.deviceId;
  }

  headers(extra = {}) {
    return {
      'user-agent': USER_AGENT,
      accept: 'application/json;charset=UTF-8',
      'content-type': 'application/json',
      'x-device-id': this.cred.deviceId,
      'x-client-id': CLIENT_ID,
      'x-client-version': CLIENT_VERSION,
      'x-captcha-token': this.cred.captchaToken || '',
      ...extra,
    };
  }

  async #send(url, { method = 'POST', body, headers } = {}) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new XlApiError(`网络请求失败: ${err.message}`, -1);
    }
    const text = await res.text();
    if (this.trace) this.trace({ url, status: res.status, request: body, response: text });
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new XlApiError(`响应不是合法 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    const code = pick(json, ['error_code', 'errorCode']);
    const isErr = code !== undefined && code !== 0 && code !== '0';
    if (isErr || res.status >= 400) {
      // 优先用中文 errorDesc，英文 error_description 信息量太低
      const msg = pick(json, ['errorDesc', 'error_description', 'error_msg', 'errorMessage', 'message']) || `HTTP ${res.status}`;
      throw new XlApiError(String(msg), typeof code === 'number' ? code : res.status, json);
    }
    return json;
  }

  // ---- 步骤 2：验证码令牌（登录前必须初始化，否则 signin/token 会被拒） ----
  async captchaInit(action, meta) {
    const json = await this.#send(`${XLUSER_V1}/shield/captcha/init`, {
      body: {
        action,
        captcha_token: this.cred.captchaToken || '',
        client_id: CLIENT_ID,
        device_id: this.cred.deviceId,
        meta,
        redirect_uri: REDIRECT_URI,
      },
    });
    const token = pick(json, ['captcha_token', 'captchaToken']);
    const url = pick(json, ['url', 'verify_url']);
    if (url) {
      throw new XlApiError(`本次登录需要在浏览器完成验证：\n${url}`, 9001, json);
    }
    if (!token) throw new XlApiError('验证码令牌获取失败', 9002, json);
    this.cred.captchaToken = token;
    return token;
  }

  #storeToken(json) {
    const t = json.token || json;
    const accessToken = pick(t, ['access_token', 'accessToken']);
    const refreshToken = pick(t, ['refresh_token', 'refreshToken']);
    if (!accessToken || !refreshToken) throw new XlApiError('未返回 access_token / refresh_token', 9004, json);
    const expiresIn = Number(pick(t, ['expires_in', 'expiresIn']) || 7200);
    this.cred.accessToken = accessToken;
    this.cred.refreshToken = refreshToken;
    this.cred.expiresAt = Date.now() + expiresIn * 1000;
    this.cred.userId = String(pick(json, ['user_id', 'userId', 'sub']) ?? this.cred.userId ?? '');
    return this.cred;
  }

  // ---- 刷新 ----
  async refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const json = await this.#send(`${XLUSER_V1}/auth/token`, {
        body: {
          grant_type: 'refresh_token',
          refresh_token: this.cred.refreshToken,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        },
      });
      this.#storeToken(json);
      await this.save();
      return this.cred;
    })();
    try {
      return await this._refreshing;
    } catch (error) {
      if (/invalid[ _-]+refresh[ _-]+token|refresh[ _-]+token[^\n]*(?:invalid|expired)/i.test(error.message || '')) {
        throw new XlApiError('迅雷登录会话无法续期（invalid refresh token），请执行 node cli.mjs login xunlei 重新登录，再执行 node cli.mjs status xunlei --verify；若网页登录后仍重复出现，可改用 node cli.mjs login xunlei --sms 你的手机号。未自动删除本机凭据。', 401);
      }
      throw error;
    } finally {
      this._refreshing = null;
    }
  }

  async ensureFresh() {
    if (!this.loggedIn) throw new XlApiError('尚未登录，请先执行 `node cli.mjs login xunlei`', 401);
    if (this.cred.expiresAt && this.cred.expiresAt - Date.now() < TOKEN_REFRESH_SKEW_MS) {
      await this.refresh();
    }
    return this.cred.accessToken;
  }

  /**
   * 带自动重登的鉴权请求。错误码语义与官方一致：
   * 4121/4122/10/16 = token 失效；9 = captcha token 过期。
   */
  async request(url, options = {}, _retried = 0) {
    const token = await this.ensureFresh();
    try {
      return await this.#send(url, {
        ...options,
        // 网盘接口（api-pan）要 Bearer；xluser 接口两者都接受
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      if (_retried > 1) throw err;
      if (err.code === 9) {
        await this.captchaInit('GET:/v1/user/me', { user_id: this.cred.userId || '' }).catch(() => {});
        return this.request(url, options, _retried + 1);
      }
      if ([4121, 4122, 10, 16, 401].includes(err.code)) {
        await this.refresh();
        return this.request(url, options, _retried + 1);
      }
      throw err;
    }
  }

  // ---- 短信验证码登录 ----
  // 完全照抄源软件渲染层的调用（app 里就是这么写的）：
  //   getVerification({ phoneNumber: `+86 ${phone}`, usage: "SIGN_IN" })   → verification_id
  //   verifyVerification({ verificationCode, verificationId })            → verification_token
  //   signInWithVerification({ username: `+86 ${phone}`, verificationCode, verificationToken })
  // 手机号格式必须是 "+86 13800138000"（带空格），裸号会被判 username 不匹配。
  async sendSmsCode(phone) {
    const phoneNumber = `+86 ${phone}`;
    await this.captchaInit('POST:/v1/auth/verification', { phone_number: phoneNumber });
    const json = await this.#send(`${XLUSER_V1}/auth/verification`, {
      body: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        phone_number: phoneNumber,
        usage: 'SIGN_IN',
      },
    });
    return {
      raw: json,
      verificationId: pick(json, ['verification_id', 'verificationId']) || '',
      isUser: json.is_user,
    };
  }

  async loginWithSmsCode(phone, code, verificationId) {
    if (!verificationId) throw new XlApiError('缺少 verification_id，请重新获取验证码', 1012);

    const v = await this.#send(`${XLUSER_V1}/auth/verification/verify`, {
      body: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        verification_code: code,
        verification_id: verificationId,
      },
    });
    const verificationToken = pick(v, ['verification_token', 'verificationToken']) || '';
    if (!verificationToken) throw new XlApiError('校验未返回 verification_token', 1013, v);

    // captcha meta 的 username 必须和下面 signin body 里的 username 完全一致（含 "+86 " 前缀），
    // 否则服务端报 "meta.username expect +86 ..., but got username:..."。
    const username = `+86 ${phone}`;
    await this.captchaInit('POST:/v1/auth/signin', { username });
    const json = await this.#send(`${XLUSER_V1}/auth/signin`, {
      body: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        username,
        verification_code: code,
        verification_token: verificationToken,
      },
    });
    this.#storeToken(json);
    await this.save();
    return this.cred;
  }

  async me() {
    return this.request(`${XLUSER_V1}/user/me`, { method: 'GET' });
  }

  async logout() {
    this.cred = { deviceId: this.cred.deviceId };
    await fs.rm(CRED_FILE, { force: true });
  }
}

