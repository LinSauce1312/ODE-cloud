// 官方新鲜下载链接的导出适配层：只做纯文本格式化，不请求网络、不触碰凭据。
// 链接与 Cookie 属于敏感短时凭据，只应由调用方输出到 stdout，不得写入日志或错误文本。
export const EXPORT_FORMATS = Object.freeze(['json', 'curl', 'aria2']);

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(39);
const escapeSingle = (value) => String(value ?? '').replace(/'/g, QUOTE + BACKSLASH + QUOTE + QUOTE);
const shellQuote = (value) => QUOTE + escapeSingle(value) + QUOTE;
const dirOf = (name) => { const i = String(name).lastIndexOf('/'); return i < 0 ? '.' : String(name).slice(0, i); };
const baseOf = (name) => { const i = String(name).lastIndexOf('/'); return i < 0 ? String(name) : String(name).slice(i + 1); };

export function renderCurl(link) {
  const parts = ['curl', '-L', '--create-dirs', '-o', shellQuote(link.name)];
  for (const [key, value] of Object.entries(link.headers || {})) parts.push('-H', shellQuote(key + ': ' + value));
  parts.push(shellQuote(link.url));
  return parts.join(' ');
}

export function renderAria2(link) {
  const parts = ['aria2c', '-d', shellQuote(dirOf(link.name)), '-o', shellQuote(baseOf(link.name))];
  for (const [key, value] of Object.entries(link.headers || {})) parts.push('--header=' + shellQuote(key + ': ' + value));
  parts.push(shellQuote(link.url));
  return parts.join(' ');
}

export function renderExport(result, format = 'json') {
  if (format === 'json') return JSON.stringify(result, null, 2);
  const render = format === 'curl' ? renderCurl : renderAria2;
  const lines = (result?.links || []).map(render);
  return lines.length ? lines.join('\n') + '\n' : '';
}
