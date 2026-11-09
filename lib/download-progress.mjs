import { safeSharePath } from './game-share.mjs';
import { clearLine, cursorTo } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const terminalEvents = new Set(['done', 'skip', 'failed']);

export function createDownloadProgress({ platform, engine = 'http', files, onProgress = () => {}, log = () => {} }) {
  const entries = files.map(file => ({ name: safeSharePath(file.name), total: number(file.size) > 0 ? number(file.size) : null, received: 0 }));
  const count = entries.length;
  const batchSize = () => entries.every(entry => entry.total !== null) ? entries.reduce((sum, entry) => sum + entry.total, 0) : null;
  function event(type, index = 1, state = {}) {
    const kind = type === 'fail' ? 'failed' : type;
    const entry = entries[index - 1];
    if (kind !== 'plan' && !entry) throw new Error('下载进度文件索引无效');
    const total = number(state.total) > 0 ? number(state.total) : null;
    if (entry && total !== null) entry.total = total;
    if (entry && number(state.received) !== null) entry.received = number(state.received);
    if (entry && ['done', 'skip'].includes(kind)) {
      const actual = number(state.size);
      if (actual !== null) { entry.total = actual; entry.received = actual; }
      else if (entry.total !== null) entry.received = entry.total;
    }
    if (entry && entry.total !== null) entry.received = Math.min(entry.received, entry.total);
    const output = {
      platform, engine, name: kind === 'plan' ? '' : entry.name, index: count ? index : 0, count,
      received: kind === 'plan' ? 0 : entry.received, total: kind === 'plan' ? batchSize() : entry.total,
      speed: kind === 'progress' ? number(state.speed) ?? 0 : 0,
      final: terminalEvents.has(kind), event: kind,
      batchTotal: batchSize(), batchReceived: entries.reduce((sum, file) => sum + file.received, 0),
    };
    if (kind !== 'progress') log({ ...output, type: kind === 'failed' ? 'fail' : kind, size: kind === 'plan' ? output.batchTotal : output.total });
    onProgress(output);
    return output;
  }
  return {
    plan: () => event('plan'),
    event,
    transfer: index => state => event('progress', index, {
      received: number(state.received) ?? number(state.download_size),
      total: number(state.total) ?? number(state.file_size),
      speed: number(state.speed) ?? number(state.download_speed),
    }),
  };
}

export function fileInfo(file) {
  const name = safeSharePath(file.name);
  const sizeBytes = Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null;
  const filename = name.split('/').at(-1);
  const dot = filename.lastIndexOf('.');
  const result = {
    name,
    size: sizeBytes === null ? null : sizeBytes + ' (' + (sizeBytes / (sizeBytes >= 1073741824 ? 1073741824 : 1048576)).toFixed(2) + (sizeBytes >= 1073741824 ? ' GB)' : ' MB)'),
    sizeBytes,
    filename,
    directory: name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '',
    extension: dot > 0 ? filename.slice(dot).toLowerCase() : '',
    type: 'file',
  };
  const id = file.id ?? file.fid;
  if ((typeof id === 'string' || Number.isSafeInteger(id)) && String(id).length <= 256) result.id = String(id);
  for (const key of ['md5', 'sha1', 'gcid']) {
    if (typeof file[key] === 'string' && /^[a-f0-9]{32,40}$/i.test(file[key])) result[key] = file[key];
  }
  return result;
}

export function createProgressRenderer({ stream = process.stderr, now = Date.now, interval = 100 } = {}) {
  let active = false;
  let lastWrite = -Infinity;
  function render(state) {
    if (state.event !== 'progress') {
      if (active) { cursorTo(stream, 0); clearLine(stream, 0); active = false; }
      stream.write(stripVTControlCharacters(formatDownloadProgress(state)) + '\n');
      return;
    }
    if (!stream.isTTY) return;
    const timestamp = now();
    if (timestamp - lastWrite < interval) return;
    lastWrite = timestamp;
    let line = stripVTControlCharacters(formatDownloadProgress(stream.isTTY ? { ...state, name: '' } : state));
    if (stream.isTTY && state.name) line += ' ' + stripVTControlCharacters(String(state.name)).replace(/[\x00-\x1f\x7f]/g, ' ');
    if (stream.isTTY) {
      const limit = Math.max(1, (stream.columns || 120) - 1);
      let width = 0;
      let clipped = '';
      for (const character of line) {
        const cells = character.codePointAt(0) >= 0x1100 ? 2 : 1;
        if (width + cells > limit - 1) { clipped += '…'; break; }
        clipped += character;
        width += cells;
      }
      line = clipped;
      cursorTo(stream, 0);
      clearLine(stream, 0);
      stream.write(line);
      active = true;
    } else stream.write(line + '\n');
  }
  render.finish = () => {
    if (active) stream.write('\n');
    active = false;
  };
  return render;
}

function bytes(value) {
  if (number(value) === null) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return amount.toFixed(unit ? 2 : 0) + ' ' + units[unit];
}

export function formatDownloadProgress(state) {
  const label = { plan: '计划', file: '文件', start: '开始', progress: '下载中', done: '完成', skip: '跳过', failed: '失败', refresh: '刷新链接', verify: '校验通过' }[state.event] || '下载状态';
  const name = String(state.name || '').replace(/[\x00-\x1f\x7f]/g, ' ');
  return '[' + state.platform + '/' + state.engine + '] [' + state.index + '/' + state.count + '] ' + label + (name ? ' ' + name : '')
    + ' ' + bytes(state.received) + '/' + bytes(state.total) + ' ' + bytes(state.speed) + '/s'
    + (state.count > 1 && state.event !== 'plan' ? ' 总计 ' + bytes(state.batchReceived) + '/' + bytes(state.batchTotal) : '');
}
