// 常量与运行配置。
// 这些值来自迅雷 Android 客户端 / 迅雷网盘开放接口的公开实现（OpenList thunder 驱动），
// 用于让你自己的账号完成一次正常的 OAuth 登录——等价于官方客户端的行为，不涉及任何绕过。
import path from 'node:path';

export const XLUSER_BASE = 'https://xluser-ssl.xunlei.com';
export const XLUSER_V1 = `${XLUSER_BASE}/v1`;

export const CLIENT_ID = 'Xp6vsxz_7IYVw2BB';
export const CLIENT_SECRET = 'Xp6vsy4tN9toTVdMSpomVdXpRmES';
export const CLIENT_VERSION = '8.31.0.9726';

export const USER_AGENT =
  'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 ' +
  'deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 ' +
  'platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 ' +
  '(Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)';

export const DOWNLOAD_UA =
  'Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)';

// 会话过期前多久主动刷新
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
// 直链刷新节流：与迅雷游戏助手保持一致（60s 内不重复请求）
export const URL_REFRESH_THROTTLE_MS = 60 * 1000;

export { DATA_DIR as HOME } from './paths.mjs';
import { DATA_DIR as HOME } from './paths.mjs';
export const CRED_FILE = path.join(HOME, 'credentials.json');
