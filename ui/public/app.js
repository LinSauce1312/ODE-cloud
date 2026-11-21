/* ============================================================================
 * ODE-cloud Web UI
 * ----------------------------------------------------------------------------
 * A dependency-free front end for the local ODE-cloud service.
 *
 * This file contains only behaviour. All markup lives in index.html and all
 * presentation lives in styles.css. The API calls go to the same origin, so
 * opening this page through ui/start.bat is required (opening the HTML file
 * directly cannot reach the local service).
 *
 * Security notes:
 * - every value that comes back from the server is escaped before it is placed
 *   into HTML (file names, job labels, account display names, error messages);
 * - the UI never receives credentials, cookies or tokens from the API;
 * - all requests use same-origin fetch with bounded timeouts.
 * ========================================================================== */

(function () {
  'use strict';

  /* ----------------------------------------------------------------------- */
  /* constants + tiny DOM helpers                                            */
  /* ----------------------------------------------------------------------- */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const TOAST_ICONS = {
    success: 'check-circle',
    warn: 'alert',
    error: 'alert',
    info: 'info',
  };

  const VIEW_INFO = {
    dashboard: { eyebrow: '工作台', title: '下载控制台' },
    accounts: { eyebrow: '连接', title: '账号与平台' },
    parse: { eyebrow: '解析', title: '分享解析' },
    jobs: { eyebrow: '传输', title: '下载任务' },
    settings: { eyebrow: '系统', title: '偏好设置' },
  };

  const THEME_KEY = 'ode-theme';
  const PREFS_KEY = 'ode-ui-prefs';

  const state = {
    meta: null,
    accounts: [],
    accountsLoaded: false,
    accountsBusy: false,
    jobs: [],
    downloadJobs: [],
    activeDownloads: 0,
    jobsBusy: false,
    jobsTimer: null,
    jobsUpdatedAt: null,
    statsAt: null,
    view: 'dashboard',
    share: null,
    fileQuery: '',
    fileSearchTimer: null,
    links: null,
    linksRequest: 0,
    prefs: { target: '', engine: 'http', workers: 8, chunk: '' },
    sdk: null,
    sdkBusy: false,
    loginPlatform: null,
    loginMode: 'browser',
    loginJobId: null,
    loginJob: null,
    loginPollTimer: null,
    loginNotified: null,
    sms: { loginId: null, timer: null, cooldownUntil: 0 },
    theme: 'dark',
    serverOnline: true,
    topRefreshBusy: false,
  };

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function icon(name, className = '') {
    return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function setText(selector, value) {
    const element = typeof selector === 'string' ? $(selector) : selector;
    if (element) element.textContent = value;
  }

  function setHidden(selector, hidden) {
    const element = typeof selector === 'string' ? $(selector) : selector;
    if (element) element.hidden = Boolean(hidden);
  }

  function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '—';
    if (number === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let index = 0;
    let current = number;
    while (current >= 1024 && index < units.length - 1) {
      current /= 1024;
      index += 1;
    }
    const digits = index === 0 || current >= 100 ? 0 : current >= 10 ? 1 : 2;
    return `${current.toFixed(digits).replace(/\.0+$/, '')} ${units[index]}`;
  }

  function formatSpeed(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '—';
    return `${formatBytes(number)}/s`;
  }

  function formatAbsolute(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function relativeTime(iso) {
    if (!iso) return '刚刚';
    const timestamp = new Date(iso).getTime();
    if (!Number.isFinite(timestamp)) return '刚刚';
    const elapsed = Math.max(0, Date.now() - timestamp);
    if (elapsed < 20_000) return '刚刚';
    if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)} 秒前`;
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
    if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
    return formatAbsolute(iso);
  }

  function formatCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '0';
    return number.toLocaleString('zh-CN');
  }

  function debounce(fn, wait) {
    let timer = null;
    const wrapped = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
  }

  function platformMeta(id) {
    return state.meta?.platforms?.find((platform) => platform.id === id) || null;
  }

  function platformName(id) {
    return platformMeta(id)?.name || (id === 'direct' ? '直链下载' : id || '未知平台');
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function safeStorageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage failures (private mode / disabled storage).
    }
  }

  /* ----------------------------------------------------------------------- */
  /* API                                                                     */
  /* ----------------------------------------------------------------------- */

  class ApiError extends Error {
    constructor(message, status = 0, code = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  async function api(pathname, { method = 'GET', body, timeout = 30_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = { accept: 'application/json' };
      const options = {
        method,
        headers,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await fetch(pathname, options);
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ApiError('服务返回了无法识别的响应', response.status);
        }
      }
      if (!response.ok || payload?.ok === false) {
        throw new ApiError(
          payload?.error?.message || `请求失败（HTTP ${response.status}）`,
          response.status,
          payload?.error?.code || '',
        );
      }
      if (!payload) throw new ApiError('服务返回了空响应', response.status);
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === 'AbortError') throw new ApiError('请求超时，请稍后重试');
      if (error instanceof TypeError) throw new ApiError('无法连接本地服务，请确认 start.bat 正在运行');
      throw new ApiError(error.message || '请求失败');
    } finally {
      clearTimeout(timer);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* toast                                                                   */
  /* ----------------------------------------------------------------------- */

  function showToast(title, message = '', type = 'info', duration = 4200) {
    const stack = $('#toast-stack');
    if (!stack) return;

    while (stack.children.length >= 4) stack.firstElementChild.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.style.setProperty('--toast-duration', `${Math.max(1200, duration)}ms`);
    toast.innerHTML = `
      <div class="toast-icon">${icon(TOAST_ICONS[type] || 'info')}</div>
      <div class="toast-copy"><strong></strong><p></p></div>
      <button class="toast-close" type="button" aria-label="关闭提示">${icon('x')}</button>
      <div class="toast-progress" aria-hidden="true"></div>`;
    toast.querySelector('.toast-copy strong').textContent = title;
    const copy = toast.querySelector('.toast-copy p');
    if (message) copy.textContent = message;
    else copy.remove();

    let removed = false;
    const remove = () => {
      if (removed || !toast.isConnected) return;
      removed = true;
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 240);
    };

    toast.querySelector('.toast-close').addEventListener('click', remove);
    stack.append(toast);
    setTimeout(remove, Math.max(1200, duration));
  }

  /* ----------------------------------------------------------------------- */
  /* tooltip                                                                 */
  /* ----------------------------------------------------------------------- */

  let tooltipTrigger = null;

  function showTooltip(trigger) {
    const tooltip = $('#tooltip');
    const text = trigger?.getAttribute('data-tip');
    if (!tooltip || !text) return;
    tooltipTrigger = trigger;
    tooltip.textContent = text;
    tooltip.classList.add('is-visible');

    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const gap = 9;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = rect.top - height - gap;
    if (top < margin) top = rect.bottom + gap;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip() {
    tooltipTrigger = null;
    $('#tooltip')?.classList.remove('is-visible');
  }

  function initTooltips() {
    document.addEventListener('pointerover', (event) => {
      const trigger = event.target.closest?.('[data-tip]');
      if (trigger && trigger !== tooltipTrigger) showTooltip(trigger);
    });
    document.addEventListener('pointerout', (event) => {
      if (!tooltipTrigger) return;
      if (!event.relatedTarget || !tooltipTrigger.contains(event.relatedTarget)) hideTooltip();
    });
    document.addEventListener('focusin', (event) => {
      const trigger = event.target.closest?.('[data-tip]');
      if (trigger) showTooltip(trigger);
    });
    document.addEventListener('focusout', (event) => {
      if (tooltipTrigger && event.target === tooltipTrigger) hideTooltip();
    });
    window.addEventListener('scroll', hideTooltip, true);
    window.addEventListener('resize', hideTooltip);
  }

  /* ----------------------------------------------------------------------- */
  /* ripple                                                                  */
  /* ----------------------------------------------------------------------- */

  function initRipple() {
    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target.closest?.('.btn, .icon-btn');
      if (!target || target.disabled) return;
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const size = Math.max(rect.width, rect.height) * 2.2;
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      ripple.style.width = `${size}px`;
      ripple.style.height = `${size}px`;
      ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
      target.append(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    });
  }

  /* ----------------------------------------------------------------------- */
  /* dialogs + confirm                                                       */
  /* ----------------------------------------------------------------------- */

  let confirmResolve = null;

  function syncModalLock() {
    document.body.classList.toggle('modal-open', Boolean(document.querySelector('dialog[open]')));
  }

  function openDialog(dialogOrId) {
    const dialog = typeof dialogOrId === 'string' ? document.getElementById(dialogOrId) : dialogOrId;
    if (!(dialog instanceof HTMLDialogElement) || dialog.open) return;
    for (const other of $$('dialog[open]')) {
      if (other !== dialog) other.close();
    }
    dialog.showModal();
    syncModalLock();
  }

  function askConfirm({ title = '确认操作', message = '', okText = '确认', danger = true } = {}) {
    const dialog = $('#confirm-dialog');
    if (!dialog) return Promise.resolve(false);
    if (confirmResolve) {
      const previous = confirmResolve;
      confirmResolve = null;
      previous(false);
    }
    setText('#confirm-title', title);
    setText('#confirm-message', message);
    const ok = $('#confirm-ok');
    if (ok) {
      ok.textContent = okText;
      ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    }
    openDialog(dialog);
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }

  function initDialogs() {
    const dialogs = $$('dialog.modal');
    for (const dialog of dialogs) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', syncModalLock);
    }

    document.addEventListener('click', (event) => {
      const closer = event.target.closest?.('[data-close]');
      if (!closer) return;
      const dialog = document.getElementById(closer.dataset.close);
      if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    });

    $('#confirm-ok')?.addEventListener('click', () => {
      const resolve = confirmResolve;
      confirmResolve = null;
      if (resolve) resolve(true);
      $('#confirm-dialog')?.close();
    });
    $('#confirm-dialog')?.addEventListener('close', () => {
      if (!confirmResolve) return;
      const resolve = confirmResolve;
      confirmResolve = null;
      resolve(false);
    });

    $('#login-dialog')?.addEventListener('close', () => {
      stopLoginPoll();
      stopSmsCooldown();
    });
  }

  /* ----------------------------------------------------------------------- */
  /* theme + navigation + sidebar                                            */
  /* ----------------------------------------------------------------------- */

  function applyTheme(theme, announce = false) {
    const next = theme === 'light' ? 'light' : 'dark';
    state.theme = next;
    document.documentElement.dataset.theme = next;
    const button = $('#theme-btn');
    if (button) {
      button.setAttribute('aria-pressed', String(next === 'light'));
      button.setAttribute('aria-label', next === 'light' ? '切换到深色主题' : '切换到浅色主题');
    }
    const settingsButton = $('#settings-theme');
    if (settingsButton) settingsButton.textContent = next === 'light' ? '切换到深色' : '切换到浅色';
    if (announce) {
      showToast('主题已切换', next === 'light' ? '现在是浅色主题。' : '现在是深色主题。', 'success');
    }
  }

  function toggleTheme(announce = true) {
    const next = state.theme === 'light' ? 'dark' : 'light';
    applyTheme(next, announce);
    safeStorageSet(THEME_KEY, next);
  }

  function initTheme() {
    const stored = safeStorageGet(THEME_KEY);
    applyTheme(stored === 'light' ? 'light' : 'dark', false);
    $('#theme-btn')?.addEventListener('click', () => toggleTheme(true));
    $('#settings-theme')?.addEventListener('click', () => toggleTheme(true));
  }

  function navigate(view, { replace = true, scroll = true } = {}) {
    const next = VIEW_INFO[view] ? view : 'dashboard';
    state.view = next;

    for (const section of $$('.view')) {
      const active = section.dataset.view === next;
      section.classList.toggle('is-active', active);
      section.hidden = !active;
    }
    for (const item of $$('[data-nav].nav-item')) {
      const active = item.dataset.nav === next;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }

    setText('#page-eyebrow', VIEW_INFO[next].eyebrow);
    setText('#page-title', VIEW_INFO[next].title);

    if (replace && location.hash !== `#${next}`) {
      history.replaceState(null, '', `#${next}`);
    }
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });

    if (next === 'jobs') refreshJobs({ silent: true });
    if (next === 'accounts' && !state.accountsLoaded && !state.accountsBusy) refreshAccounts({ silent: true });
  }

  function initNavigation() {
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('[data-nav]');
      if (!link || link.disabled) return;
      event.preventDefault();
      navigate(link.dataset.nav);
    });
    window.addEventListener('hashchange', () => {
      const view = location.hash.replace(/^#/, '');
      if (VIEW_INFO[view] && view !== state.view) navigate(view, { replace: false, scroll: false });
    });
  }

  /* ----------------------------------------------------------------------- */
  /* accounts                                                                */
  /* ----------------------------------------------------------------------- */

  function accountFor(platform) {
    return state.accounts.find((account) => account.platform === platform) || null;
  }

  function accountStatusInfo(account) {
    if (!account) return { label: '未知', cls: '', tone: 'muted' };
    if (account.error) return { label: '读取失败', cls: 'err', tone: 'danger' };
    if (!account.saved) return { label: '未登录', cls: '', tone: 'muted' };
    if (account.verified === true) return { label: '已连接', cls: 'ok', tone: 'success' };
    if (account.verified === false) return { label: '会话失效', cls: 'err', tone: 'danger' };
    return { label: '已保存', cls: 'warn', tone: 'warning' };
  }

  function accountDisplayName(account) {
    const identity = account?.account;
    if (identity && typeof identity === 'object') {
      const value = identity.nickname || identity.nickName || identity.Nickname
        || identity.name || identity.username || identity.userName || identity.user_name
        || identity.displayName || identity.phone || identity.email || identity.mobile
        || identity.uid || identity.userId || identity.id;
      if (value !== undefined && value !== null && String(value).trim()) return String(value);
    }
    return account?.saved ? '本机会话已保存，未返回公开资料' : '尚未登录';
  }

  function renderAccountCards() {
    const grid = $('#accounts-grid');
    if (!grid || !state.meta) return;
    const loginPlatforms = state.meta.platforms.filter((platform) => platform.login);
    grid.setAttribute('aria-busy', String(!state.accountsLoaded));

    // 账号状态还在读取时也先渲染可操作的账号卡：
    // 既避免页面出现大片骨架，也让用户不必等 whoami 校验完成才能打开登录。
    if (!state.accountsLoaded) {
      grid.innerHTML = loginPlatforms.map((platform) => `
        <article class="account-card is-checking" style="--tint:${escapeHTML(platform.color)}">
          <div class="account-top">
            <span class="account-logo">${escapeHTML(platform.short.slice(0, 1))}</span>
            <div class="account-name">
              <strong>${escapeHTML(platform.name)}</strong>
              <span>${escapeHTML(platform.id)} · ${escapeHTML(platform.note || '')}</span>
            </div>
            <span class="account-status"><i></i>检查中</span>
          </div>
          <div class="account-body">
            <div class="account-user">${icon('users')}<span>正在读取本机会话…</span></div>
            <div class="account-meta"><span><b>校验</b>正在校验</span><span><b>会话</b>读取中</span></div>
          </div>
          <div class="account-actions">
            <button class="btn btn-secondary" type="button" data-account-action="login" data-platform="${platform.id}">${icon('key')}登录</button>
          </div>
          <p class="account-note">${escapeHTML(platform.link === false ? '仅支持查看文件列表，不提供转存、直链或下载。' : platform.note || '')}</p>
        </article>`).join('');
      return;
    }
    if (!state.accounts.length) {
      grid.innerHTML = `
        <div class="panel empty-state" style="grid-column:1/-1">
          <div class="empty-icon">${icon('alert')}</div>
          <h3>无法读取账号状态</h3>
          <p>本地服务可能暂时不可用，请稍后重试。</p>
          <button class="btn btn-ghost btn-sm" type="button" data-account-retry>重新读取</button>
        </div>`;
      return;
    }

    grid.innerHTML = loginPlatforms.map((platform) => {
      const account = accountFor(platform.id);
      const status = accountStatusInfo(account);
      const saved = Boolean(account?.saved);
      const identity = accountDisplayName(account);
      const captured = account?.capturedAt ? `捕获于 ${formatAbsolute(account.capturedAt)}` : (saved ? '捕获时间未知' : '未保存会话');
      const verified = account?.verified === true ? '官方校验通过'
        : account?.verified === false ? '官方校验失败'
          : saved ? '未做在线校验' : '—';
      const actions = saved
        ? `<button class="btn btn-ghost" type="button" data-account-action="view" data-platform="${platform.id}">详情</button>
           <button class="btn btn-secondary" type="button" data-account-action="login" data-platform="${platform.id}">重新登录</button>
           <button class="btn btn-ghost icon-only" type="button" data-account-action="logout" data-platform="${platform.id}" aria-label="退出 ${escapeHTML(platform.name)}" data-tip="退出并清除本机会话">${icon('logout')}</button>`
        : `<button class="btn btn-secondary" type="button" data-account-action="login" data-platform="${platform.id}">${icon('key')}登录</button>`;

      return `
        <article class="account-card" style="--tint:${escapeHTML(platform.color)}">
          <div class="account-top">
            <span class="account-logo">${escapeHTML(platform.short.slice(0, 1))}</span>
            <div class="account-name">
              <strong>${escapeHTML(platform.name)}</strong>
              <span>${escapeHTML(platform.id)} · ${escapeHTML(platform.note || '')}</span>
            </div>
            <span class="account-status ${status.cls}"><i></i>${status.label}</span>
          </div>
          <div class="account-body">
            <div class="account-user">${icon('users')}<span>${escapeHTML(identity)}</span></div>
            <div class="account-meta"><span><b>校验</b>${escapeHTML(verified)}</span><span><b>会话</b>${escapeHTML(captured)}</span></div>
            ${account?.error ? `<p class="account-error">${escapeHTML(account.error)}</p>` : ''}
          </div>
          <div class="account-actions">${actions}</div>
          <p class="account-note">${escapeHTML(platform.link === false ? '仅支持查看文件列表，不提供转存、直链或下载。' : platform.note || '')}</p>
        </article>`;
    }).join('');
  }

  function renderAccountStrip() {
    const strip = $('#dashboard-account-strip');
    if (!strip) return;
    if (!state.accountsLoaded) {
      strip.innerHTML = '<span class="mini-dot"></span><span>正在读取本机会话…</span>';
      return;
    }
    const saved = state.accounts.filter((account) => account.saved).length;
    const verified = state.accounts.filter((account) => account.verified === true).length;
    strip.innerHTML = `<span class="mini-dot" style="opacity:${saved ? 1 : 0.35}"></span><span>${saved
      ? `${saved} 个平台已保存会话 · ${verified} 个通过在线校验`
      : '还没有已保存的账号，公开分享仍可直接解析。'}</span>`;
  }

  function renderDashboardPlatforms() {
    const container = $('#dashboard-platforms');
    if (!container || !state.meta) return;
    container.innerHTML = state.meta.platforms.map((platform) => {
      const account = platform.login ? accountFor(platform.id) : null;
      const connected = platform.guest || Boolean(account?.saved);
      return `<span class="platform-pill ${connected ? '' : 'is-off'}" style="--c:${escapeHTML(platform.color)}"
        data-tip="${escapeHTML(platform.note || platform.name)}" data-nav="accounts">
        <i></i>${escapeHTML(platform.short)}
      </span>`;
    }).join('');
  }

  function updateAccountBadges() {
    const saved = state.accounts.filter((account) => account.saved).length;
    setText('#nav-account-count', String(saved));
  }

  function updateStats() {
    const saved = state.accounts.filter((account) => account.saved).length;
    const running = state.downloadJobs.filter((job) => job.state === 'running').length;
    const shareCount = state.share?.result?.files?.length || 0;
    let bytes = 0;
    for (const job of state.downloadJobs) {
      if (job.state === 'succeeded' && Number.isFinite(job.result?.totalBytes)) bytes += job.result.totalBytes;
    }
    setText('#stat-accounts', state.accountsLoaded ? String(saved) : '–');
    setText('#stat-active', String(running));
    setText('#stat-files', String(shareCount));
    setText('#stat-bytes', formatBytes(bytes));
    setText('#stats-updated', state.statsAt ? `更新于 ${relativeTime(state.statsAt.toISOString())}` : '等待同步');
    updateAccountBadges();
    updateJobBadge();
  }

  async function refreshAccounts({ manual = false, silent = false } = {}) {
    if (state.accountsBusy) return;
    state.accountsBusy = true;
    const button = $('#accounts-refresh');
    if (button) {
      button.disabled = true;
      button.classList.add('is-loading');
    }
    if (!state.accountsLoaded) renderAccountCards();

    try {
      const payload = await api('/api/accounts', { timeout: 35_000 });
      state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      state.accountsLoaded = true;
      state.statsAt = new Date();
      renderAccountCards();
      renderAccountStrip();
      renderDashboardPlatforms();
      updateStats();
      if (manual) {
        const saved = state.accounts.filter((account) => account.saved).length;
        showToast('账号状态已刷新', saved ? `${saved} 个平台保存了本机会话。` : '当前没有已保存的平台账号。', 'success');
      }
    } catch (error) {
      if (!state.accountsLoaded) {
        state.accounts = [];
        renderAccountCards();
      }
      if (!silent) showToast('读取账号状态失败', error.message, 'error', 5200);
    } finally {
      state.accountsBusy = false;
      if (button) {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    }
  }

  function openAccountDetails(account) {
    if (!account) return;
    const safe = {
      platform: account.platform,
      saved: account.saved,
      verified: account.verified,
      capturedAt: account.capturedAt,
      account: account.account || null,
      error: account.error || null,
    };
    const output = $('#account-json');
    if (output) output.textContent = JSON.stringify(safe, null, 2);
    openDialog('account-dialog');
  }

  async function logoutPlatform(platform) {
    const meta = platformMeta(platform);
    if (!meta) return;
    const confirmed = await askConfirm({
      title: `退出 ${meta.name}？`,
      message: `这会删除本机保存的 ${meta.name} 会话。下次下载该平台的分享前需要重新登录。`,
      okText: '退出登录',
    });
    if (!confirmed) return;

    const cardButton = $(`[data-account-action="logout"][data-platform="${platform}"]`);
    if (cardButton) cardButton.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(platform)}/logout`, { method: 'POST', body: {}, timeout: 30_000 });
      showToast('已退出平台', `${meta.name} 的本机会话已清除。`, 'success');
      await refreshAccounts({ silent: true });
    } catch (error) {
      showToast('退出失败', error.message, 'error', 5200);
    } finally {
      if (cardButton) cardButton.disabled = false;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* login                                                                   */
  /* ----------------------------------------------------------------------- */

  function setLoginMode(mode) {
    const next = mode === 'sms' && platformMeta(state.loginPlatform)?.sms ? 'sms' : 'browser';
    state.loginMode = next;
    for (const tab of $$('#login-tabs [data-login-mode]')) {
      const active = tab.dataset.loginMode === next;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    setHidden('#login-browser-panel', next !== 'browser');
    setHidden('#login-sms-panel', next !== 'sms');
  }

  function resetLoginDialog(platform) {
    const meta = platformMeta(platform);
    if (!meta) return;
    state.loginPlatform = platform;
    state.loginJobId = null;
    state.loginJob = null;
    state.loginNotified = null;
    state.sms.loginId = null;
    stopLoginPoll();
    stopSmsCooldown();

    setText('#login-logo', meta.short.slice(0, 1));
    setText('#login-kicker', `CONNECT / ${meta.id.toUpperCase()}`);
    setText('#login-title', `登录 ${meta.name}`);
    setText('#login-status', '正在打开浏览器…');
    setText('#login-events', '');
    setHidden('#login-job-panel', true);
    setHidden('#login-tabs', !meta.sms);
    $('#login-tabs')?.classList.toggle('is-active', false);
    setLoginMode('browser');

    const start = $('#login-start');
    if (start) {
      start.disabled = false;
      start.classList.remove('is-loading');
      start.innerHTML = `${icon('external')}打开官网登录`;
    }
    const confirmButton = $('#login-confirm');
    if (confirmButton) confirmButton.disabled = true;
    $('#login-spinner')?.classList.remove('is-active');

    setHidden('#sms-phone-error', true);
    setHidden('#sms-code-error', true);
    const phone = $('#sms-phone');
    const code = $('#sms-code');
    if (phone) phone.value = '';
    if (code) code.value = '';
    const send = $('#sms-send');
    if (send) {
      send.disabled = false;
      send.textContent = '发送验证码';
    }
    const verify = $('#sms-verify');
    if (verify) {
      verify.disabled = false;
      verify.classList.remove('is-loading');
    }
  }

  function openLogin(platform) {
    const meta = platformMeta(platform);
    if (!meta || !meta.login) {
      showToast('该平台无需登录', '游客分享直接解析即可。', 'info');
      return;
    }
    resetLoginDialog(platform);
    openDialog('login-dialog');
    setTimeout(() => $('#login-start')?.focus(), 60);
  }

  function renderLoginJob(job) {
    if (!job) return;
    state.loginJob = job;
    setHidden('#login-job-panel', false);
    const running = job.state === 'running';
    $('#login-spinner')?.classList.toggle('is-active', running);
    setText('#login-status', job.status || (running ? '正在等待官网登录…' : '任务已结束'));
    const events = Array.isArray(job.events) ? job.events.slice(-5) : [];
    const log = $('#login-events');
    if (log) {
      log.innerHTML = events.map((event) => `<p>${escapeHTML(event.message || '')}</p>`).join('');
      log.scrollTop = log.scrollHeight;
    }
    const confirm = $('#login-confirm');
    if (confirm) confirm.disabled = !job.confirmable;
    const start = $('#login-start');
    if (start) {
      start.disabled = running;
      start.classList.toggle('is-loading', running);
    }
  }

  function stopLoginPoll() {
    clearTimeout(state.loginPollTimer);
    state.loginPollTimer = null;
  }

  async function pollLoginJob(id) {
    if (!id || state.loginJobId !== id) return;
    try {
      const payload = await api(`/api/jobs/${encodeURIComponent(id)}`, { timeout: 15_000 });
      if (state.loginJobId !== id) return;
      const job = payload.job;
      renderLoginJob(job);
      if (job.state === 'running') {
        state.loginPollTimer = setTimeout(() => pollLoginJob(id), 1200);
        return;
      }
      stopLoginPoll();
      if (state.loginNotified === id) return;
      state.loginNotified = id;
      if (job.state === 'succeeded') {
        showToast('登录成功', `${platformName(state.loginPlatform)} 会话已保存。`, 'success', 3600);
        refreshAccounts({ silent: true });
        setTimeout(() => {
          if ($('#login-dialog')?.open) $('#login-dialog').close();
        }, 800);
      } else {
        showToast('登录失败', job.error || job.status || '请重试', 'error', 6200);
        const start = $('#login-start');
        if (start) {
          start.disabled = false;
          start.classList.remove('is-loading');
        }
      }
    } catch (error) {
      if (state.loginJobId !== id) return;
      stopLoginPoll();
      renderLoginJob({
        state: 'failed',
        status: error.message,
        error: error.message,
        confirmable: false,
        events: [{ message: error.message }],
      });
      showToast('登录状态读取失败', error.message, 'error', 5200);
    }
  }

  async function startBrowserLogin() {
    const platform = state.loginPlatform;
    if (!platform) return;
    const button = $('#login-start');
    if (!button || button.disabled) return;
    button.classList.add('is-loading');
    button.disabled = true;
    setHidden('#login-job-panel', false);
    setText('#login-status', '正在启动浏览器…');
    setText('#login-events', '');
    $('#login-spinner')?.classList.add('is-active');
    try {
      const payload = await api('/api/login/browser', {
        method: 'POST',
        body: { platform },
        timeout: 20_000,
      });
      const job = payload.job;
      if (!job?.id) throw new ApiError('服务没有返回登录任务');
      state.loginJobId = job.id;
      state.loginNotified = null;
      renderLoginJob(job);
      showToast('已打开登录窗口', '请在弹出的官网窗口完成登录，页面会自动检测。', 'info', 5200);
      pollLoginJob(job.id);
    } catch (error) {
      $('#login-spinner')?.classList.remove('is-active');
      setText('#login-status', error.message);
      setHidden('#login-job-panel', false);
      button.disabled = false;
      button.classList.remove('is-loading');
      showToast('无法启动登录', error.message, 'error', 5200);
    }
  }

  function stopSmsCooldown() {
    clearInterval(state.sms.timer);
    state.sms.timer = null;
    state.sms.cooldownUntil = 0;
  }

  function startSmsCooldown(seconds = 60) {
    stopSmsCooldown();
    const button = $('#sms-send');
    if (!button) return;
    state.sms.cooldownUntil = Date.now() + seconds * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((state.sms.cooldownUntil - Date.now()) / 1000));
      if (remaining <= 0) {
        stopSmsCooldown();
        button.disabled = false;
        button.textContent = '重新发送';
      } else {
        button.disabled = true;
        button.textContent = `重新发送（${remaining}s）`;
      }
    };
    tick();
    state.sms.timer = setInterval(tick, 1000);
  }

  async function sendSmsCode() {
    const phone = $('#sms-phone')?.value.trim() || '';
    const error = $('#sms-phone-error');
    if (!/^1\d{10}$/.test(phone)) {
      if (error) {
        error.textContent = '请输入 11 位中国大陆手机号';
        error.hidden = false;
      }
      showToast('手机号格式不正确', '请输入 11 位中国大陆手机号。', 'warn');
      $('#sms-phone')?.focus();
      return;
    }
    if (error) error.hidden = true;
    const button = $('#sms-send');
    if (!button || button.disabled) return;
    button.disabled = true;
    button.textContent = '发送中…';
    try {
      const payload = await api('/api/login/sms/send', {
        method: 'POST',
        body: { phone },
        timeout: 30_000,
      });
      state.sms.loginId = payload.loginId;
      showToast('验证码已发送', payload.isUser === false ? '该手机号可能尚未注册迅雷账号。' : '请查看手机短信，10 分钟内完成校验。', 'success', 5200);
      startSmsCooldown(60);
    } catch (requestError) {
      button.disabled = false;
      button.textContent = '发送验证码';
      if (error) {
        error.textContent = requestError.message;
        error.hidden = false;
      }
      showToast('发送验证码失败', requestError.message, 'error', 5200);
    }
  }

  async function verifySmsCode() {
    const code = $('#sms-code')?.value.trim() || '';
    const error = $('#sms-code-error');
    if (!state.sms.loginId) {
      if (error) {
        error.textContent = '请先发送短信验证码';
        error.hidden = false;
      }
      showToast('请先发送验证码', '点击手机号右侧的「发送验证码」。', 'warn');
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      if (error) {
        error.textContent = '请输入 4–8 位数字验证码';
        error.hidden = false;
      }
      showToast('验证码格式不正确', '请输入 4–8 位数字。', 'warn');
      $('#sms-code')?.focus();
      return;
    }
    if (error) error.hidden = true;
    const button = $('#sms-verify');
    if (!button) return;
    button.classList.add('is-loading');
    button.disabled = true;
    try {
      await api('/api/login/sms/verify', {
        method: 'POST',
        body: { loginId: state.sms.loginId, code },
        timeout: 40_000,
      });
      state.sms.loginId = null;
      showToast('登录成功', '迅雷会话已保存到本机。', 'success');
      $('#login-dialog')?.close();
      await refreshAccounts({ silent: true });
    } catch (requestError) {
      if (error) {
        error.textContent = requestError.message;
        error.hidden = false;
      }
      showToast('短信验证失败', requestError.message, 'error', 6200);
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }

  /* ----------------------------------------------------------------------- */
  /* jobs                                                                    */
  /* ----------------------------------------------------------------------- */

  function jobStateLabel(job) {
    if (job.state === 'running') return '运行中';
    if (job.state === 'succeeded') return '已完成';
    if (job.state === 'failed') return '失败';
    return job.state || '未知';
  }

  function jobStateIcon(job) {
    if (job.state === 'failed') return 'alert';
    if (job.state === 'succeeded') return 'check-circle';
    return 'loader';
  }

  function renderJobCard(job) {
    const progress = job.progress;
    const percent = progress && Number.isFinite(progress.percent) ? progress.percent : null;
    const running = job.state === 'running';
    const indeterminate = running && percent === null;
    const platform = platformName(job.platform);
    const stateClass = running ? 'running' : job.state === 'failed' ? 'failed' : 'succeeded';
    const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));
    const received = progress?.batchReceived || progress?.received || 0;
    const total = progress?.batchTotal || progress?.total || null;
    const events = Array.isArray(job.events) ? job.events.slice(-3) : [];
    const results = Array.isArray(job.result?.results) ? job.result.results : [];

    let resultHTML = '';
    if (job.result && results.length) {
      const rows = results.slice(0, 12).map((file) => `
        <div class="result-row">
          <span class="result-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</span>
          <span class="result-path" title="${escapeHTML(file.path || '')}">${escapeHTML(file.path || '')}</span>
          <span class="result-status ${file.status === 'failed' ? 'failed' : ''}">${file.status === 'failed' ? '失败' : '完成'}</span>
        </div>`).join('');
      const more = results.length > 12 ? `<div class="result-row"><span class="result-name muted">还有 ${results.length - 12} 个文件未展开</span></div>` : '';
      resultHTML = `<div class="job-result">
        <div class="result-head"><span>${formatCount(results.length)} 个文件 · ${escapeHTML(job.result.output || '')}</span></div>
        ${rows}${more}
      </div>`;
    }

    return `
      <article class="job-card panel" data-job-id="${escapeHTML(job.id)}">
        <div class="job-head">
          <div class="job-title">
            <span class="job-icon">${icon(jobStateIcon(job))}</span>
            <div><h3 title="${escapeHTML(job.label || '下载任务')}">${escapeHTML(job.label || '下载任务')}</h3><p>${escapeHTML(platform)} · ${formatAbsolute(job.createdAt)}</p></div>
          </div>
          <span class="job-state ${stateClass}"><i></i>${jobStateLabel(job)}</span>
        </div>
        <div class="job-progress">
          <div class="progress-line"><span>${progress?.name ? escapeHTML(progress.name) : (running ? '准备下载…' : '任务状态')}</span><strong>${percent === null ? (running ? '…' : '—') : `${percent}%`}</strong></div>
          <div class="progress-track ${indeterminate ? 'is-indeterminate' : ''}"><i style="width:${width}%"></i></div>
          <div class="progress-meta">
            <span>${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}</span>
            <span>${formatSpeed(progress?.speed || 0)}</span>
            ${progress?.count ? `<span>${progress.index || 0} / ${progress.count} 个文件</span>` : ''}
          </div>
        </div>
        <p class="job-status">${escapeHTML(job.status || '')}</p>
        ${events.length ? `<div class="job-events">${events.map((event) => `<p>${escapeHTML(event.message || '')}</p>`).join('')}</div>` : ''}
        ${job.error ? `<div class="job-error">${escapeHTML(job.error)}</div>` : ''}
        ${resultHTML}
      </article>`;
  }

  function renderRecentJobs() {
    const container = $('#recent-jobs');
    if (!container) return;
    const recent = state.downloadJobs.slice(0, 4);
    if (!recent.length) {
      container.innerHTML = `<div class="empty-inline">${icon('clock')}<span>还没有下载任务</span></div>`;
      return;
    }
    container.innerHTML = recent.map((job) => {
      const percent = Number.isFinite(job.progress?.percent) ? job.progress.percent : job.state === 'succeeded' ? 100 : 0;
      return `<div class="recent-job" data-nav="jobs">
        <span class="recent-icon">${icon(jobStateIcon(job))}</span>
        <div class="recent-copy"><strong>${escapeHTML(job.label || '下载任务')}</strong><span>${jobStateLabel(job)} · ${relativeTime(job.updatedAt)}</span></div>
        <div class="mini-progress"><i style="width:${Math.max(0, Math.min(100, percent))}%"></i></div>
      </div>`;
    }).join('');
  }

  function updateJobBadge() {
    const running = state.downloadJobs.filter((job) => job.state === 'running').length;
    const badge = $('#nav-job-count');
    if (badge) {
      badge.textContent = String(running);
      badge.hidden = running === 0;
    }
    const live = $('#jobs-live');
    if (live) {
      live.className = running ? 'status-chip is-busy' : 'status-chip live';
      live.innerHTML = `<i></i>${running ? `${running} 个运行中` : '空闲'}`;
    }
  }

  function renderJobs() {
    state.downloadJobs = (state.jobs || []).filter((job) => job.kind === 'download');
    const list = $('#jobs-list');
    const empty = $('#jobs-empty');
    if (list) {
      list.innerHTML = state.downloadJobs.map(renderJobCard).join('');
      list.hidden = state.downloadJobs.length === 0;
    }
    if (empty) empty.hidden = state.downloadJobs.length > 0;
    updateJobBadge();
    renderRecentJobs();
    updateStats();
  }

  function scheduleJobsPoll(delay) {
    clearTimeout(state.jobsTimer);
    const running = state.downloadJobs.some((job) => job.state === 'running');
    const wait = delay ?? (running ? 1800 : 9000);
    state.jobsTimer = setTimeout(() => {
      if (document.hidden) {
        scheduleJobsPoll(5000);
        return;
      }
      refreshJobs({ silent: true });
    }, wait);
  }

  async function refreshJobs({ manual = false, silent = false } = {}) {
    if (state.jobsBusy) return;
    state.jobsBusy = true;
    try {
      const payload = await api('/api/jobs', { timeout: 20_000 });
      state.jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      state.activeDownloads = Number(payload.activeDownloads) || 0;
      state.jobsUpdatedAt = new Date();
      state.statsAt = new Date();
      renderJobs();
      if (manual) showToast('任务列表已刷新', `${state.downloadJobs.length} 个下载任务。`, 'success');
    } catch (error) {
      if (!silent) showToast('刷新任务失败', error.message, 'error', 5200);
    } finally {
      state.jobsBusy = false;
      scheduleJobsPoll();
    }
  }

  /* ----------------------------------------------------------------------- */
  /* share parsing + file selection                                          */
  /* ----------------------------------------------------------------------- */

  function setAlert(element, message) {
    const alert = typeof element === 'string' ? $(element) : element;
    if (!alert) return;
    const span = alert.querySelector('span');
    if (span) span.textContent = message || '';
    alert.hidden = !message;
  }

  function showParseError(message) {
    setAlert('#parse-error', message);
  }

  function setShareProgress(busy) {
    const parseButton = $('#parse-btn');
    if (parseButton) {
      parseButton.disabled = busy;
      parseButton.classList.toggle('is-loading', busy);
    }
  }

  async function parseShare(raw, source = 'parse') {
    const value = String(raw || '').trim();
    if (!value) {
      showParseError('请先粘贴网盘分享链接或分享文案');
      showToast('缺少分享链接', '粘贴链接或整段分享文案后再解析。', 'warn');
      $('#share-input')?.focus();
      return;
    }
    if (value.length > 20_000) {
      showParseError('分享文案超过 20000 个字符');
      showToast('分享文案过长', '请只保留链接和必要的提取码。', 'warn');
      return;
    }

    showParseError('');
    setShareProgress(true);
    try {
      const payload = await api('/api/share', {
        method: 'POST',
        body: { raw: value },
        timeout: 100_000,
      });
      const files = Array.isArray(payload.result?.files) ? payload.result.files : [];
      state.share = {
        raw: value,
        info: payload.share,
        result: payload.result,
        selected: new Set(files.map((_, index) => index)),
        parsedAt: new Date(),
      };
      const input = $('#share-input');
      if (input) input.value = value;

      renderShare();
      updateStats();
      state.statsAt = new Date();
      updateStats();
      showToast('解析完成', `${formatCount(files.length)} 个文件 · ${formatBytes(payload.result?.totalBytes)}`, 'success');
    } catch (error) {
      showParseError(error.message);
      showToast('解析失败', error.message, 'error', 6200);
    } finally {
      setShareProgress(false);
    }
  }

  function renderShare() {
    const share = state.share;
    if (!share) return;
    const result = share.result || {};
    const files = Array.isArray(result.files) ? result.files : [];
    const meta = platformMeta(result.platform || share.info?.platform);
    const platform = meta || { id: result.platform || 'share', name: result.platform || '分享', short: '?', color: '#59b8ff', note: '', guest: false, link: true, download: true };

    setHidden('#share-result', false);
    setHidden('#parse-placeholder', true);
    setHidden('#parse-error', true);

    const platformBox = $('#share-platform');
    if (platformBox) {
      platformBox.innerHTML = `<span class="platform-logo" style="background:${escapeHTML(platform.color)}1f;color:${escapeHTML(platform.color)}">${escapeHTML(platform.short.slice(0, 1))}</span>
        <div><p class="eyebrow">PARSED SHARE</p><h3>${escapeHTML(platform.name)}</h3><span id="share-platform-note" class="muted">${escapeHTML(platform.note || '')}</span></div>`;
    }
    setText('#share-count', formatCount(files.length));
    setText('#share-size', formatBytes(result.totalBytes));
    setText('#meta-platform', platform.name);
    setText('#meta-kind', platform.guest ? '游客分享' : platform.link === false ? '文件列表' : '账号分享');
    setText('#meta-time', formatAbsolute(share.parsedAt.toISOString()));

    const limit = $('#platform-limit');
    if (limit) {
      const message = platform.link === false
        ? '百度网盘仅支持查看文件列表，不提供直链导出或下载。'
        : platform.download === false
          ? '该平台仅支持查看文件列表。'
          : '';
      limit.hidden = !message;
      const span = limit.querySelector('span');
      if (span) span.textContent = message;
    }

    const limitNote = $('#file-limit-note');
    if (limitNote) {
      if (files.length > 5000) {
        limitNote.hidden = false;
        limitNote.textContent = `分享共 ${formatCount(files.length)} 个文件，单次导出或下载最多处理 5000 个。`;
      } else {
        limitNote.hidden = true;
        limitNote.textContent = '';
      }
    }

    renderFiles();
    updateSelectionUI();
  }

  function fileMatches(file, query) {
    if (!query) return true;
    const text = [file.name, file.filename, file.directory, file.extension, file.type]
      .filter(Boolean).join(' ').toLowerCase();
    return text.includes(query);
  }

  function visibleFileIndices() {
    const files = state.share?.result?.files || [];
    const query = state.fileQuery.trim().toLowerCase();
    const indices = [];
    for (let index = 0; index < files.length; index += 1) {
      if (fileMatches(files[index], query)) indices.push(index);
    }
    return indices;
  }

  function fileType(file) {
    const value = String(file.extension || file.type || '').replace(/^\./, '').toUpperCase();
    return value && value !== 'FILE' ? value : 'FILE';
  }

  function renderFiles() {
    if (!state.share) return;
    const files = state.share.result?.files || [];
    const visible = visibleFileIndices();
    const body = $('#file-body');
    if (!body) return;

    body.innerHTML = visible.map((index) => {
      const file = files[index] || {};
      const checked = state.share.selected.has(index);
      const name = String(file.name || file.filename || '未命名文件');
      const directory = String(file.directory || '分享根目录');
      return `<tr class="${checked ? 'is-selected' : ''}" data-file-index="${index}">
        <td class="check-col"><input type="checkbox" data-file-check="${index}" ${checked ? 'checked' : ''} aria-label="选择 ${escapeHTML(name)}"></td>
        <td><div class="file-name"><span class="file-icon">${icon('file')}</span><div class="file-copy"><strong title="${escapeHTML(name)}">${escapeHTML(name)}</strong><span>${escapeHTML(directory)}</span></div></div></td>
        <td class="file-size">${formatBytes(file.sizeBytes)}</td>
        <td class="file-type">${escapeHTML(fileType(file))}</td>
      </tr>`;
    }).join('');

    const table = $('#file-table');
    const empty = $('#file-empty');
    if (table) table.hidden = visible.length === 0;
    if (empty) empty.hidden = visible.length > 0;
    setText('#file-visible-count', `显示 ${formatCount(visible.length)} / ${formatCount(files.length)}`);

    updateSelectionUI();
  }

  function updateSelectionUI() {
    if (!state.share) return;
    const files = state.share.result?.files || [];
    const selected = state.share.selected;
    const selectedIndices = [...selected].filter((index) => index >= 0 && index < files.length);
    const size = selectedIndices.reduce((sum, index) => sum + (Number(files[index]?.sizeBytes) || 0), 0);
    const effectiveCount = selectedIndices.length || files.length;

    setText('#share-selected-count', formatCount(selectedIndices.length));
    setText('#selection-count', formatCount(selectedIndices.length));
    setText('#selection-size', formatBytes(size));
    setHidden('#selection-bar', selectedIndices.length === 0);

    const visible = visibleFileIndices();
    const selectedVisible = visible.filter((index) => selected.has(index)).length;
    const selectAll = $('#select-all-files');
    if (selectAll) {
      selectAll.disabled = visible.length === 0;
      selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
      selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    }

    const meta = platformMeta(state.share.result?.platform);
    const canLink = meta?.link !== false;
    const canDownload = meta?.download !== false;
    const hasFiles = files.length > 0;
    const exportButton = $('#export-open');
    const downloadButton = $('#download-open');
    const selectionButton = $('#selection-download');
    if (exportButton) exportButton.disabled = !hasFiles || !canLink;
    if (downloadButton) downloadButton.disabled = !hasFiles || !canDownload;
    if (selectionButton) selectionButton.disabled = !hasFiles || !canDownload;

    const copy = $('#action-copy');
    if (copy) {
      if (!hasFiles) copy.textContent = '这个分享中没有可用文件。';
      else if (!selectedIndices.length) copy.textContent = `未单独选择文件，将使用全部 ${formatCount(files.length)} 个文件。`;
      else copy.textContent = `已选择 ${formatCount(selectedIndices.length)} 个文件，共 ${formatBytes(size)}。`;
    }

    // Keep the total count meaningful even if a filter hides some rows.
    setText('#selection-count', formatCount(selectedIndices.length || 0));
    if (effectiveCount && !selectedIndices.length) {
      setText('#selection-count', formatCount(files.length));
      setText('#selection-size', formatBytes(files.reduce((sum, file) => sum + (Number(file.sizeBytes) || 0), 0)));
    }
  }

  function toggleFile(index) {
    if (!state.share) return;
    if (state.share.selected.has(index)) state.share.selected.delete(index);
    else state.share.selected.add(index);
    const row = $(`tr[data-file-index="${index}"]`);
    const checkbox = $(`input[data-file-check="${index}"]`);
    if (row) row.classList.toggle('is-selected', state.share.selected.has(index));
    if (checkbox) checkbox.checked = state.share.selected.has(index);
    updateSelectionUI();
  }

  function selectAllVisible(checked) {
    if (!state.share) return;
    const visible = visibleFileIndices();
    if (checked) for (const index of visible) state.share.selected.add(index);
    else for (const index of visible) state.share.selected.delete(index);
    renderFiles();
  }

  function clearShareResult() {
    state.share = null;
    state.fileQuery = '';
    const search = $('#file-search');
    if (search) search.value = '';
    const input = $('#share-input');
    if (input) input.value = '';
    showParseError('');
    setHidden('#share-result', true);
    setHidden('#parse-placeholder', false);
    setHidden('#selection-bar', true);
    setText('#file-visible-count', '');
    updateStats();
    showToast('已清空解析结果', '可以粘贴另一个分享链接。', 'info', 2600);
  }

  function effectiveFileNames() {
    const files = state.share?.result?.files || [];
    if (!files.length) return [];
    const selected = [...state.share.selected].filter((index) => index >= 0 && index < files.length).sort((a, b) => a - b);
    const indices = selected.length ? selected : files.map((_, index) => index);
    return indices.map((index) => files[index]?.name).filter(Boolean);
  }

  function effectiveSize() {
    const files = state.share?.result?.files || [];
    const selected = [...state.share.selected].filter((index) => index >= 0 && index < files.length);
    const indices = selected.length ? selected : files.map((_, index) => index);
    return indices.reduce((sum, index) => sum + (Number(files[index]?.sizeBytes) || 0), 0);
  }

  /* ----------------------------------------------------------------------- */
  /* links export                                                            */
  /* ----------------------------------------------------------------------- */

  function setLinksFormat(format) {
    state.links = state.links || { format: 'json', output: '' };
    state.links.format = ['json', 'curl', 'aria2'].includes(format) ? format : 'json';
    for (const tab of $$('#links-tabs [data-format]')) {
      const active = tab.dataset.format === state.links.format;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
  }

  async function generateLinks(format = state.links?.format || 'json') {
    if (!state.share) return;
    const meta = platformMeta(state.share.result?.platform);
    if (meta?.link === false) {
      showToast('该平台不支持导出链接', '百度网盘仅支持查看文件列表。', 'warn');
      return;
    }
    setLinksFormat(format);
    const requestId = ++state.linksRequest;
    state.links.output = '';
    const output = $('#links-output');
    if (output) output.textContent = '正在向网盘申请新鲜直链…';
    const copyButton = $('#links-copy');
    const saveButton = $('#links-save');
    if (copyButton) copyButton.disabled = true;
    if (saveButton) saveButton.disabled = true;
    setHidden('#links-loading', false);
    setAlert('#links-error', '');

    try {
      const payload = await api('/api/links', {
        method: 'POST',
        body: { raw: state.share.raw, files: effectiveFileNames(), format },
        timeout: 130_000,
      });
      if (requestId !== state.linksRequest) return;
      state.links.output = payload.output || '';
      state.links.result = payload.result;
      if (output) output.textContent = payload.output || '没有生成内容';
      setText('#links-count', `${formatCount(payload.result?.links?.length || 0)} 个文件`);
      if (copyButton) copyButton.disabled = !state.links.output;
      if (saveButton) saveButton.disabled = !state.links.output;
      showToast('链接已生成', '直链可能包含短期认证信息，请妥善保管。', 'success', 4200);
    } catch (error) {
      if (requestId !== state.linksRequest) return;
      if (output) output.textContent = '生成失败';
      setAlert('#links-error', error.message);
      showToast('导出链接失败', error.message, 'error', 6200);
    } finally {
      if (requestId === state.linksRequest) setHidden('#links-loading', true);
    }
  }

  function openLinksDialog(format = 'json') {
    if (!state.share) {
      showToast('还没有解析结果', '请先解析一个分享链接。', 'warn');
      return;
    }
    state.links = { format: 'json', output: '', result: null };
    setLinksFormat(format);
    if ($('#links-output')) $('#links-output').textContent = '正在向网盘申请新鲜直链…';
    setText('#links-count', '');
    setHidden('#links-loading', false);
    setAlert('#links-error', '');
    const copyButton = $('#links-copy');
    const saveButton = $('#links-save');
    if (copyButton) copyButton.disabled = true;
    if (saveButton) saveButton.disabled = true;
    openDialog('links-dialog');
    generateLinks(format);
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.append(textarea);
      textarea.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      textarea.remove();
      return ok;
    }
  }

  function downloadLinksText() {
    if (!state.links?.output) return;
    const format = state.links.format || 'json';
    const extension = format === 'json' ? 'json' : format === 'curl' ? 'sh' : 'aria2.txt';
    const mime = format === 'json' ? 'application/json' : 'text/plain';
    const blob = new Blob([state.links.output], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ode-cloud-links.${extension}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已保存链接文件', anchor.download, 'success');
  }

  /* ----------------------------------------------------------------------- */
  /* download + direct                                                       */
  /* ----------------------------------------------------------------------- */

  /** 读取当前 SDK 状态；meta 和 /api/sdk 的返回结构一致。 */
  function sdkData() {
    return state.sdk || state.meta?.sdk || null;
  }

  function sdkReady() {
    const sdk = sdkData();
    return Boolean(sdk?.supported && sdk?.available);
  }

  /** 把 SDK 组件目录、文件是否存在同步到偏好设置和下载弹窗。 */
  function renderSdkStatus(sdk = sdkData()) {
    if (sdk) state.sdk = sdk;
    const status = $('#sdk-status');
    if (status) {
      status.classList.remove('is-ok', 'is-warn');
      status.classList.toggle('is-ok', Boolean(sdk?.supported && sdk?.available));
      status.classList.toggle('is-warn', Boolean(sdk) && !(sdk.supported && sdk.available));
      status.textContent = !sdk
        ? '检测中'
        : !sdk.supported
          ? '当前平台不支持'
          : sdk.available
            ? '组件已就绪'
            : '缺少组件';
    }
    const currentDir = $('#sdk-current-dir');
    if (currentDir) currentDir.textContent = sdk?.dir || '—';
    const hint = $('#sdk-current-hint');
    if (hint) {
      if (!sdk) hint.textContent = '正在读取 SDK 配置…';
      else if (!sdk.supported) hint.textContent = `当前为 ${sdk.platform}/${sdk.arch}；迅雷 SDK 仅提供 Windows x64 组件。`;
      else if (sdk.available) hint.textContent = `已找到 ${sdk.files.join(' 与 ')}。组件能否被当前 Node 加载，将在首次使用 SDK 下载时验证。`;
      else hint.textContent = `目录中缺少 ${sdk.files.join(' 或 ')}；点击“下载 SDK”获取组件。`;
    }
    const checked = $('#sdk-checked-at');
    if (checked) {
      checked.textContent = sdk ? `检查于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` : '';
    }
    updateSdkDownloadNote();
  }

  /** SDK 引擎被选中时显示组件状态；未就绪则禁止启动并提供设置入口。 */
  function updateSdkDownloadNote() {
    const note = $('#download-sdk-note');
    if (!note) return;
    const engine = $('#download-engine')?.value;
    const visible = engine === 'sdk';
    note.hidden = !visible;
    const start = $('#download-start');
    if (!visible) {
      note.classList.remove('is-ready');
      if (start && !start.classList.contains('is-loading')) start.disabled = false;
      return;
    }
    const sdk = sdkData();
    const ready = sdkReady();
    note.classList.toggle('is-ready', ready);
    setText('#download-sdk-title', ready ? '迅雷 SDK 已就绪' : '迅雷 SDK 组件未就绪');
    if (ready) {
      setText('#download-sdk-text', `将使用 ${sdk.dir} 中的组件下载；并发与分片由 SDK 自行调度。`);
    } else if (!sdk) {
      setText('#download-sdk-text', '正在读取组件配置，请稍候。');
    } else if (!sdk.supported) {
      setText('#download-sdk-text', `当前平台 ${sdk.platform}/${sdk.arch} 不支持迅雷 SDK，请改用 HTTP 引擎。`);
    } else {
      setText('#download-sdk-text', `目录 ${sdk.dir || '未设置'} 缺少 ${sdk.files.join(' 或 ')}，可点击“下载 SDK”自动获取。`);
    }
    const settingsButton = $('#download-sdk-settings');
    if (settingsButton) settingsButton.hidden = ready;
    if (start && !start.classList.contains('is-loading')) start.disabled = !ready;
  }

  async function refreshSdk({ silent = false } = {}) {
    if (state.sdkBusy) return;
    state.sdkBusy = true;
    const button = $('#sdk-refresh');
    if (button) {
      button.disabled = true;
      button.classList.add('is-spinning');
    }
    try {
      const payload = await api('/api/sdk', { timeout: 12_000 });
      state.sdk = payload.sdk;
      if (state.meta) state.meta.sdk = payload.sdk;
      renderSdkStatus(payload.sdk);
      if (!silent) showToast('SDK 状态已刷新', payload.sdk?.available ? '组件文件齐全。' : '组件文件不完整。', payload.sdk?.available ? 'success' : 'warn');
    } catch (error) {
      const status = $('#sdk-status');
      if (status) {
        status.classList.remove('is-ok');
        status.classList.add('is-warn');
        status.textContent = '检测失败';
      }
      if (!silent) showToast('无法读取 SDK 状态', error.message, 'error', 5200);
    } finally {
      state.sdkBusy = false;
      if (button) {
        button.disabled = false;
        button.classList.remove('is-spinning');
      }
    }
  }

  /** 调用本机文件夹选择器；取消返回空字符串，失败返回 null。 */
  async function chooseFolder(initial, button) {
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    try {
      const payload = await api('/api/choose-folder', {
        method: 'POST',
        body: { initial: initial || '' },
        timeout: 130_000,
      });
      return payload?.path || '';
    } catch (error) {
      showToast('无法选择文件夹', error.message, 'error', 6000);
      return null;
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  }

  async function browseDirectory(inputSelector, buttonSelector) {
    const input = $(inputSelector);
    if (!input) return;
    const selected = await chooseFolder(input.value.trim(), $(buttonSelector));
    if (!selected) return;
    input.value = selected;
    input.focus();
    showToast('已选择文件夹', selected, 'success', 3400);
  }

  function directFilename(raw) {
    try {
      const parsed = new URL(String(raw || '').trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      const rawName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      return rawName.replace(/[<>:"/\\\\|?*\\x00-\\x1f]/g, '_').slice(0, 120);
    } catch {
      return '';
    }
  }

  async function browseDirectTarget() {
    const target = $('#direct-target');
    const button = $('#browse-direct-target');
    if (!target) return;
    const selected = await chooseFolder(target.value.trim() || state.prefs.target || state.meta?.outputDir || '', button);
    if (!selected) return;
    const separator = selected.includes('\\\\') ? '\\\\' : '/';
    const filename = directFilename($('#direct-url')?.value);
    const directory = selected.replace(/[\\\\/]+$/, '');
    target.value = filename ? `${directory}${separator}${filename}` : `${directory}${separator}`;
    target.focus();
    showToast(
      filename ? '已选择保存文件夹' : '已选择文件夹',
      filename ? target.value : '请补全文件名后再开始下载。',
      filename ? 'success' : 'warn',
      4200,
    );
  }

  function openSdkInstallDialog() {
    setAlert('#sdk-install-error', '');
    setHidden('#sdk-install-url-error', true);
    const start = $('#sdk-install-start');
    if (start) {
      start.disabled = false;
      start.classList.remove('is-loading');
    }
    const url = $('#sdk-install-url');
    if (url) url.value = '';
    const target = $('#sdk-install-target');
    if (target) target.value = sdkData()?.defaultDir || sdkData()?.dir || '';
    openDialog('sdk-install-dialog');
    setTimeout(() => url?.focus(), 60);
  }

  async function submitSdkInstall(event) {
    event.preventDefault();
    const rawUrl = $('#sdk-install-url')?.value.trim() || '';
    const target = $('#sdk-install-target')?.value.trim() || '';
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      setHidden('#sdk-install-url-error', false);
      setText('#sdk-install-url-error', '请输入有效的 HTTPS 下载地址');
      showToast('下载地址无效', '请输入 HTTPS ZIP 直链或小飞机分享地址。', 'warn');
      $('#sdk-install-url')?.focus();
      return;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      setHidden('#sdk-install-url-error', false);
      setText('#sdk-install-url-error', '只接受不含账号密码的 HTTPS 地址');
      showToast('下载地址不可用', '不要包含用户名或密码。', 'warn');
      return;
    }
    setHidden('#sdk-install-url-error', true);
    if (!target) {
      setAlert('#sdk-install-error', '请填写 SDK 安装目录');
      showToast('缺少安装目录', '填写一个服务器可写的绝对路径。', 'warn');
      $('#sdk-install-target')?.focus();
      return;
    }
    if (target.length > 4096) {
      setAlert('#sdk-install-error', '安装目录过长');
      return;
    }
    setAlert('#sdk-install-error', '');
    const button = $('#sdk-install-start');
    if (!button) return;
    button.disabled = true;
    button.classList.add('is-loading');
    try {
      const payload = await api('/api/sdk/install', {
        method: 'POST',
        body: { url: parsed.href, target },
        timeout: 180_000,
      });
      state.sdk = payload.sdk;
      if (state.meta) state.meta.sdk = payload.sdk;
      renderSdkStatus(payload.sdk);
      closeDialog('sdk-install-dialog');
      showToast('SDK 已下载并安装', payload.installed?.directory || target, 'success', 6200);
    } catch (error) {
      setAlert('#sdk-install-error', error.message);
      showToast('SDK 下载失败', error.message, 'error', 7200);
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }

  function configureDownloadEngine() {
    const select = $('#download-engine');
    const platform = state.share?.result?.platform;
    if (!select) return;
    const sdkOption = select.querySelector('option[value="sdk"]');
    const isXunlei = platform === 'xunlei';
    if (sdkOption) sdkOption.disabled = !isXunlei;
    if (!isXunlei && select.value === 'sdk') select.value = 'http';
    const sdk = select.value === 'sdk';
    const workers = $('#download-workers');
    const chunk = $('#download-chunk');
    if (workers) workers.disabled = sdk;
    if (chunk) chunk.disabled = sdk;
    const hint = $('#download-engine-hint');
    if (hint) {
      hint.textContent = sdk ? '迅雷 SDK 自行调度，无需并发数与分片。' : 'HTTP 多并发，稳定且无需组件。';
    }
    updateSdkDownloadNote();
  }

  function openDownloadDialog() {
    if (!state.share) {
      showToast('还没有解析结果', '请先解析一个分享链接。', 'warn');
      return;
    }
    const meta = platformMeta(state.share.result?.platform);
    if (meta?.download === false) {
      showToast('该平台不支持下载', '百度网盘仅支持查看文件列表。', 'warn');
      return;
    }
    const files = state.share.result?.files || [];
    if (!files.length) {
      showToast('分享中没有可下载文件', '请换一个分享链接。', 'warn');
      return;
    }
    setText('#download-count', formatCount(effectiveFileNames().length));
    setText('#download-size', formatBytes(effectiveSize()));
    setText('#download-platform', platformName(state.share.result?.platform));
    setHidden('#download-error', true);

    const startButton = $('#download-start');
    if (startButton) {
      startButton.disabled = false;
      startButton.classList.remove('is-loading');
    }

    const target = $('#download-target');
    if (target) target.value = state.prefs.target || state.meta?.outputDir || '';
    const engine = $('#download-engine');
    if (engine) engine.value = state.prefs.engine === 'sdk' ? 'sdk' : 'http';
    const workers = $('#download-workers');
    if (workers) workers.value = String(state.prefs.workers || 8);
    const chunk = $('#download-chunk');
    if (chunk) chunk.value = state.prefs.chunk ? String(state.prefs.chunk) : '';
    configureDownloadEngine();

    const note = $('#download-note');
    if (note) {
      const selected = [...state.share.selected].length;
      note.textContent = selected
        ? `将下载 ${selected} 个已选文件；下载会保留分享中的目录层级。`
        : `未单独选择文件，将下载全部 ${files.length} 个文件；下载会保留目录层级。`;
    }
    openDialog('download-dialog');
    setTimeout(() => $('#download-target')?.focus(), 60);
  }

  function readBoundedInteger(input, min, max, label, allowEmpty = false) {
    const raw = input?.value.trim() ?? '';
    if (!raw) {
      if (allowEmpty) return undefined;
      showToast(`${label}不能为空`, `请输入 ${min}–${max} 的整数。`, 'warn');
      input?.focus();
      return null;
    }
    const number = Number(raw);
    if (!Number.isInteger(number) || number < min || number > max) {
      showToast(`${label}超出范围`, `请输入 ${min}–${max} 的整数。`, 'warn');
      input?.focus();
      return null;
    }
    return number;
  }

  async function submitDownload(event) {
    event.preventDefault();
    if (!state.share) return;
    const target = $('#download-target')?.value.trim() || '';
    if (!target) {
      setAlert('#download-error', '请填写服务器端下载目录');
      showToast('缺少下载目录', '填写一个服务器可写的绝对路径。', 'warn');
      $('#download-target')?.focus();
      return;
    }
    if (target.length > 4096) {
      setAlert('#download-error', '下载目录过长');
      return;
    }
    const engine = $('#download-engine')?.value === 'sdk' ? 'sdk' : 'http';
    if (engine === 'sdk' && !sdkReady()) {
      const message = '迅雷 SDK 组件未就绪，请先下载 SDK 组件。';
      setAlert('#download-error', message);
      showToast('SDK 组件未就绪', message, 'warn', 6200);
      $('#download-sdk-settings')?.focus();
      return;
    }
    const workers = engine === 'sdk' ? undefined : readBoundedInteger($('#download-workers'), 1, 32, '并发数');
    if (workers === null) return;
    const chunk = engine === 'sdk' ? undefined : readBoundedInteger($('#download-chunk'), 1, 1024, '分片大小', true);
    if (chunk === null) return;

    setAlert('#download-error', '');
    const button = $('#download-start');
    if (!button) return;
    button.disabled = true;
    button.classList.add('is-loading');
    try {
      const payload = await api('/api/download', {
        method: 'POST',
        body: {
          raw: state.share.raw,
          target,
          files: effectiveFileNames(),
          engine,
          workers,
          chunk,
        },
        timeout: 30_000,
      });
      $('#download-dialog')?.close();
      showToast('下载任务已启动', `${platformName(payload.job?.platform)} · 可在「下载任务」查看进度。`, 'success', 5200);
      navigate('jobs');
      await refreshJobs({ silent: true });
    } catch (error) {
      setAlert('#download-error', error.message);
      showToast('无法开始下载', error.message, 'error', 6200);
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }

  /** 让本机文件管理器打开当前下载目录；目录由本地服务创建，不在浏览器中执行。 */
  async function openDownloadFolder() {
    const target = $('#download-target')?.value.trim() || '';
    if (!target) {
      setAlert('#download-error', '请先填写下载目录');
      showToast('没有下载目录', '请先填写服务器端下载目录。', 'warn');
      $('#download-target')?.focus();
      return;
    }
    if (target.length > 4096) {
      setAlert('#download-error', '下载目录过长');
      return;
    }

    const button = $('#download-open-folder');
    if (button) button.disabled = true;
    try {
      const payload = await api('/api/open-folder', {
        method: 'POST',
        body: { path: target },
        timeout: 15_000,
      });
      showToast('已打开下载文件夹', payload.path || target, 'success', 3600);
    } catch (error) {
      setAlert('#download-error', error.message);
      showToast('无法打开文件夹', error.message, 'error', 5200);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openDirectDialog() {
    setAlert('#direct-error', '');
    setHidden('#direct-url-error', true);
    const startButton = $('#direct-start');
    if (startButton) {
      startButton.disabled = false;
      startButton.classList.remove('is-loading');
    }
    const url = $('#direct-url');
    if (url) url.value = '';
    const target = $('#direct-target');
    if (target) target.value = '';
    const workers = $('#direct-workers');
    if (workers) workers.value = String(state.prefs.workers || 8);
    const chunk = $('#direct-chunk');
    if (chunk) chunk.value = state.prefs.chunk ? String(state.prefs.chunk) : '';
    openDialog('direct-dialog');
    setTimeout(() => url?.focus(), 60);
  }

  function suggestDirectTarget() {
    const urlInput = $('#direct-url');
    const target = $('#direct-target');
    if (!urlInput || !target || target.value.trim()) return;
    try {
      const parsed = new URL(urlInput.value.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      const rawName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      const name = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'download.bin';
      const directory = state.prefs.target || state.meta?.outputDir || '';
      if (!directory) return;
      const separator = directory.includes('\\') ? '\\' : '/';
      target.value = `${directory.replace(/[\\/]+$/, '')}${separator}${name}`;
    } catch {
      // Ignore incomplete URLs while the user is typing.
    }
  }

  async function submitDirect(event) {
    event.preventDefault();
    const rawUrl = $('#direct-url')?.value.trim() || '';
    const target = $('#direct-target')?.value.trim() || '';
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      setHidden('#direct-url-error', false);
      setText('#direct-url-error', '请输入有效的 HTTP(S) 文件直链');
      showToast('直链格式无效', '只接受 HTTP(S) 文件链接。', 'warn');
      $('#direct-url')?.focus();
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      setHidden('#direct-url-error', false);
      setText('#direct-url-error', '只接受无嵌入凭据的 HTTP(S) 直链');
      showToast('直链不可用', '不要包含用户名或密码。', 'warn');
      return;
    }
    setHidden('#direct-url-error', true);
    if (!target) {
      setAlert('#direct-error', '请填写目标文件路径（必须包含文件名）');
      showToast('缺少目标文件', '例如 D:/Downloads/file.zip', 'warn');
      $('#direct-target')?.focus();
      return;
    }
    if (target.length > 4096 || /[\\/]$/.test(target)) {
      setAlert('#direct-error', '目标路径必须是包含文件名的完整路径');
      return;
    }
    const workers = readBoundedInteger($('#direct-workers'), 1, 32, '并发数');
    if (workers === null) return;
    const chunk = readBoundedInteger($('#direct-chunk'), 1, 1024, '分片大小', true);
    if (chunk === null) return;
    setAlert('#direct-error', '');
    const button = $('#direct-start');
    if (!button) return;
    button.disabled = true;
    button.classList.add('is-loading');
    try {
      const payload = await api('/api/direct', {
        method: 'POST',
        body: { url: rawUrl, target, engine: 'http', workers, chunk },
        timeout: 30_000,
      });
      $('#direct-dialog')?.close();
      showToast('直链任务已启动', `保存到 ${target}`, 'success', 5200);
      navigate('jobs');
      await refreshJobs({ silent: true });
    } catch (error) {
      setAlert('#direct-error', error.message);
      showToast('无法开始直链下载', error.message, 'error', 6200);
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }

  /* ----------------------------------------------------------------------- */
  /* preferences                                                             */
  /* ----------------------------------------------------------------------- */

  function readPrefs() {
    const fallback = {
      target: state.meta?.outputDir || '',
      engine: 'http',
      workers: 8,
      chunk: '',
    };
    const raw = safeStorageGet(PREFS_KEY);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      const target = typeof parsed.target === 'string' && parsed.target.length <= 4096 ? parsed.target : fallback.target;
      const engine = ['http', 'sdk'].includes(parsed.engine) ? parsed.engine : 'http';
      const workers = Number.isInteger(parsed.workers) && parsed.workers >= 1 && parsed.workers <= 32 ? parsed.workers : 8;
      const chunk = Number.isInteger(parsed.chunk) && parsed.chunk >= 1 && parsed.chunk <= 1024 ? parsed.chunk : '';
      return { target, engine, workers, chunk };
    } catch {
      return fallback;
    }
  }

  function applyPrefsToForm() {
    const target = $('#default-target');
    if (target) target.value = state.prefs.target || state.meta?.outputDir || '';
    const engine = $('#default-engine');
    if (engine) engine.value = state.prefs.engine;
    const workers = $('#default-workers');
    if (workers) workers.value = String(state.prefs.workers);
    const chunk = $('#default-chunk');
    if (chunk) chunk.value = state.prefs.chunk ? String(state.prefs.chunk) : '';
  }

  function savePrefs() {
    return safeStorageSet(PREFS_KEY, JSON.stringify(state.prefs));
  }

  function initPreferences() {
    state.prefs = readPrefs();
    state.sdk = state.meta?.sdk || null;
    applyPrefsToForm();
    renderSdkStatus();

    $('#browse-default-target')?.addEventListener('click', () => {
      browseDirectory('#default-target', '#browse-default-target');
    });
    $('#sdk-install-open')?.addEventListener('click', openSdkInstallDialog);
    $('#sdk-install-form')?.addEventListener('submit', submitSdkInstall);
    $('#sdk-install-default')?.addEventListener('click', () => {
      const target = $('#sdk-install-target');
      if (target) target.value = sdkData()?.defaultDir || sdkData()?.dir || '';
    });
    $('#sdk-refresh')?.addEventListener('click', () => refreshSdk());

    const form = $('#settings-form');
    let saving = false;
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      if (!state.meta) {
        showToast('服务尚未就绪', '请稍后再保存偏好。', 'warn');
        return;
      }
      const targetRaw = $('#default-target')?.value.trim() || state.meta.outputDir;
      if (targetRaw.length > 4096) {
        showToast('下载目录过长', '请控制在 4096 个字符以内。', 'warn');
        $('#default-target')?.focus();
        return;
      }
      const workers = readBoundedInteger($('#default-workers'), 1, 32, '并发数');
      if (workers === null) return;
      const chunkRaw = $('#default-chunk')?.value.trim() || '';
      let chunk = '';
      if (chunkRaw) {
        const number = Number(chunkRaw);
        if (!Number.isInteger(number) || number < 1 || number > 1024) {
          showToast('分片大小超出范围', '请输入 1–1024 的整数，或留空自动。', 'warn');
          $('#default-chunk')?.focus();
          return;
        }
        chunk = number;
      }

      saving = true;
      const saveButton = $('#settings-save');
      if (saveButton) {
        saveButton.disabled = true;
        saveButton.classList.add('is-loading');
      }
      try {
        state.prefs = {
          target: targetRaw,
          engine: $('#default-engine')?.value === 'sdk' ? 'sdk' : 'http',
          workers,
          chunk,
        };
        if (!savePrefs()) {
          showToast('下载偏好未持久化', '浏览器禁用了 localStorage，本次会话内仍然有效。', 'warn', 5200);
        } else {
          showToast('偏好已保存', '下载弹窗会自动使用这些默认值。', 'success');
        }
        if (state.prefs.engine === 'sdk' && !sdkReady()) {
          showToast('默认引擎已保存，但 SDK 未就绪', '请检查组件目录，或改用 HTTP 引擎。', 'warn', 5600);
        }
      } catch (error) {
        showToast('保存偏好失败', error.message, 'error', 6200);
      } finally {
        saving = false;
        if (saveButton) {
          saveButton.disabled = false;
          saveButton.classList.remove('is-loading');
        }
      }
    });

    $('#settings-reset')?.addEventListener('click', () => {
      const target = state.meta?.outputDir || '';
      state.prefs = { target, engine: 'http', workers: 8, chunk: '' };
      safeStorageRemove(PREFS_KEY);
      applyPrefsToForm();
      showToast('已恢复默认偏好', '默认目录使用服务器下载目录；SDK 目录保持不变。', 'success');
    });
  }

  /* ----------------------------------------------------------------------- */
  /* binding                                                                 */
  /* ----------------------------------------------------------------------- */

  function bindAccounts() {
    $('#accounts-refresh')?.addEventListener('click', () => refreshAccounts({ manual: true }));
    $('#accounts-grid')?.addEventListener('click', (event) => {
      const retry = event.target.closest('[data-account-retry]');
      if (retry) {
        refreshAccounts({ manual: true });
        return;
      }
      const action = event.target.closest('[data-account-action]');
      if (!action) return;
      const platform = action.dataset.platform;
      const kind = action.dataset.accountAction;
      if (kind === 'login') openLogin(platform);
      else if (kind === 'view') openAccountDetails(accountFor(platform));
      else if (kind === 'logout') logoutPlatform(platform);
    });
  }

  function bindParse() {
    $('#share-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      parseShare($('#share-input')?.value || '', 'parse');
    });
    $('#share-input')?.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        $('#share-form')?.requestSubmit();
      }
    });
    $('#share-input')?.addEventListener('input', () => showParseError(''));
    $('#clear-share')?.addEventListener('click', clearShareResult);

    $('#paste-btn')?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const input = $('#share-input');
        if (input) {
          input.value = text;
          input.focus();
        }
        showToast('已粘贴剪贴板内容', text.trim() ? '可以开始解析。' : '剪贴板是空的。', text.trim() ? 'success' : 'warn');
      } catch {
        showToast('无法读取剪贴板', '请手动粘贴（Ctrl+V）。', 'warn');
        $('#share-input')?.focus();
      }
    });

    $('#direct-open')?.addEventListener('click', openDirectDialog);
    $('#export-open')?.addEventListener('click', () => openLinksDialog('json'));
    $('#download-open')?.addEventListener('click', openDownloadDialog);
    $('#selection-download')?.addEventListener('click', openDownloadDialog);
    $('#selection-clear')?.addEventListener('click', () => {
      if (!state.share) return;
      state.share.selected.clear();
      renderFiles();
      showToast('已取消选择', '未选择文件时将使用全部文件。', 'info', 2600);
    });

    $('#select-all-files')?.addEventListener('change', (event) => {
      selectAllVisible(event.target.checked);
    });

    $('#file-body')?.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-file-check]');
      if (!checkbox) return;
      const index = Number(checkbox.dataset.fileCheck);
      if (!Number.isInteger(index)) return;
      if (checkbox.checked) state.share?.selected.add(index);
      else state.share?.selected.delete(index);
      const row = checkbox.closest('tr');
      if (row) row.classList.toggle('is-selected', checkbox.checked);
      updateSelectionUI();
    });

    $('#file-body')?.addEventListener('click', (event) => {
      if (event.target.closest('input, button, a')) return;
      const row = event.target.closest('[data-file-index]');
      if (!row) return;
      const index = Number(row.dataset.fileIndex);
      if (Number.isInteger(index)) toggleFile(index);
    });

    const filter = debounce(() => {
      state.fileQuery = $('#file-search')?.value || '';
      renderFiles();
    }, 160);
    $('#file-search')?.addEventListener('input', filter);
    $('#file-empty-reset')?.addEventListener('click', () => {
      const search = $('#file-search');
      if (search) search.value = '';
      state.fileQuery = '';
      renderFiles();
    });
  }

  function bindLinks() {
    $('#links-tabs')?.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-format]');
      if (!tab) return;
      generateLinks(tab.dataset.format);
    });
    $('#links-copy')?.addEventListener('click', async () => {
      if (!state.links?.output) return;
      const ok = await copyText(state.links.output);
      showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? '只粘贴到可信的下载器中。' : '浏览器不允许访问剪贴板，请手动选择文本。', ok ? 'success' : 'warn');
    });
    $('#links-save')?.addEventListener('click', downloadLinksText);
  }

  function bindDownload() {
    $('#download-form')?.addEventListener('submit', submitDownload);
    $('#download-open-folder')?.addEventListener('click', openDownloadFolder);
    $('#download-engine')?.addEventListener('change', configureDownloadEngine);
    $('#download-target')?.addEventListener('input', () => setAlert('#download-error', ''));
    $('#download-workers')?.addEventListener('input', () => setAlert('#download-error', ''));
    $('#download-chunk')?.addEventListener('input', () => setAlert('#download-error', ''));
    $('#browse-download-target')?.addEventListener('click', () => {
      browseDirectory('#download-target', '#browse-download-target');
    });
    $('#download-sdk-settings')?.addEventListener('click', () => {
      $('#download-dialog')?.close();
      openSdkInstallDialog();
    });

    $('#direct-form')?.addEventListener('submit', submitDirect);
    $('#browse-direct-target')?.addEventListener('click', browseDirectTarget);
    const directSuggest = debounce(suggestDirectTarget, 240);
    $('#direct-url')?.addEventListener('input', () => {
      setHidden('#direct-url-error', true);
      setAlert('#direct-error', '');
      directSuggest();
    });
    $('#direct-url')?.addEventListener('change', suggestDirectTarget);
    $('#direct-target')?.addEventListener('input', () => setAlert('#direct-error', ''));
    $('#direct-workers')?.addEventListener('input', () => setAlert('#direct-error', ''));
    $('#direct-chunk')?.addEventListener('input', () => setAlert('#direct-error', ''));
  }

  function bindJobs() {
    $('#jobs-refresh')?.addEventListener('click', () => refreshJobs({ manual: true }));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshJobs({ silent: true });
    });
  }

  function bindLogin() {
    $('#login-start')?.addEventListener('click', startBrowserLogin);
    $('#login-tabs')?.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-login-mode]');
      if (!tab) return;
      setLoginMode(tab.dataset.loginMode);
    });
    $('#login-confirm')?.addEventListener('click', async () => {
      if (!state.loginJobId) return;
      const button = $('#login-confirm');
      if (button) button.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(state.loginJobId)}/confirm`, {
          method: 'POST',
          body: {},
          timeout: 15_000,
        });
        showToast('已请求重新检测', '请确认已经在官网窗口完成登录。', 'info', 3200);
      } catch (error) {
        showToast('重新检测失败', error.message, 'error', 5200);
      }
    });

    $('#sms-send')?.addEventListener('click', sendSmsCode);
    $('#sms-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      verifySmsCode();
    });
    $('#sms-phone')?.addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 11);
      setHidden('#sms-phone-error', true);
    });
    $('#sms-code')?.addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 8);
      setHidden('#sms-code-error', true);
    });
  }

  function bindGlobal() {
    $('#top-refresh')?.addEventListener('click', async () => {
      if (state.topRefreshBusy) return;
      state.topRefreshBusy = true;
      const button = $('#top-refresh');
      button?.classList.add('is-spinning');
      if (button) button.disabled = true;
      await Promise.allSettled([
        refreshAccounts({ silent: true }),
        refreshJobs({ silent: true }),
      ]);
      button?.classList.remove('is-spinning');
      if (button) button.disabled = false;
      state.topRefreshBusy = false;
      showToast('已刷新本机状态', '账号与任务列表已更新。', 'success', 2600);
    });

    document.addEventListener('keydown', (event) => {
      const tag = event.target?.tagName?.toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable;
      if (typing) return;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!state.share) navigate('parse');
        $('#file-search')?.focus();
      }
    });

    window.addEventListener('offline', () => {
      setServerState(false);
      showToast('网络已断开', '本机服务连接可能中断。', 'warn', 5200);
    });
    window.addEventListener('online', () => refreshJobs({ silent: true }));
  }

  function setServerState(online) {
    state.serverOnline = Boolean(online);
    const element = $('#server-state');
    if (!element) return;
    element.classList.toggle('is-offline', !online);
    const label = element.querySelector('span');
    if (label) label.textContent = online ? '在线' : '未连接';
  }

  /* ----------------------------------------------------------------------- */
  /* boot                                                                    */
  /* ----------------------------------------------------------------------- */

  function applyMeta() {
    if (!state.meta) return;
    setText('#server-version', `v${state.meta.version || '1.0.0'}`);
    setText('#top-output-path', state.meta.outputDir || '—');
    setText('#settings-url', `${location.protocol}//${location.host}`);
    setText('#settings-node', `${state.meta.platform || 'local'} · Node ${state.meta.node || '—'}`);
    setText('#settings-output', state.meta.outputDir || '—');
    setText('#stat-bytes', formatBytes(0));
    state.sdk = state.meta.sdk || state.sdk || null;
    renderSdkStatus();
    renderDashboardPlatforms();
    setServerState(true);
  }

  async function boot() {
    initTheme();
    initTooltips();
    initRipple();
    initDialogs();
    initNavigation();
    bindAccounts();
    bindParse();
    bindLinks();
    bindDownload();
    bindJobs();
    bindLogin();
    bindGlobal();
    initPreferences();

    const initialView = location.hash.replace(/^#/, '');
    navigate(VIEW_INFO[initialView] ? initialView : 'dashboard', { replace: true, scroll: false });

    try {
      const meta = await api('/api/meta', { timeout: 15_000 });
      state.meta = meta;
      state.sdk = meta.sdk || null;
      applyMeta();
      state.prefs = readPrefs();
      applyPrefsToForm();
      setServerState(true);
    } catch (error) {
      setServerState(false);
      showToast('无法连接本地服务', error.message, 'error', 7200);
    }

    await Promise.allSettled([
      refreshAccounts({ silent: true }),
      refreshJobs({ silent: true }),
    ]);
    updateStats();
    scheduleJobsPoll(4000);
  }

  boot();
})();