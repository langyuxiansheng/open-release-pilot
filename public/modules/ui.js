import { appendLog } from './log.js';
import { elements, state } from './state.js';

const busyButtons = new WeakSet();

/**
 * 显示页面右上角轻量提示。
 *
 * 这个提示只反馈“用户刚刚点的操作是否被接收/完成/失败”，不替代构建日志。
 * 详细构建输出仍然写入构建日志窗口，避免提示框承载过多文本。
 *
 * @param {string} message 展示给用户的提示文本。
 * @param {"info"|"success"|"error"} [type="info"] 提示类型。
 * @returns {void}
 */
export function showToast(message, type = 'info') {
  if (!elements.toastViewport) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastViewport.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add('leaving');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, type === 'error' ? 4200 : 2400);
}

/**
 * 包装异步按钮操作并给出点击反馈。
 *
 * 这里不直接改 button.disabled，因为按钮禁用状态有些来自业务层：
 * 例如打包开始后，是否允许再次点击由 refreshStatus/renderPackages 决定。
 * 交互层只做“处理中”样式和重复点击拦截，避免覆盖业务状态。
 *
 * @param {HTMLButtonElement} button 触发操作的按钮。
 * @param {Function} action 实际执行的异步或同步操作。
 * @param {{pending?: string, success?: string, error?: string}} [messages={}] 提示文案。
 * @returns {Promise<void>} 操作完成。
 */
export async function runButtonAction(button, action, messages = {}) {
  if (!button || busyButtons.has(button)) return;

  const originalText = button.textContent;
  busyButtons.add(button);
  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  if (messages.pending) button.textContent = messages.pending;

  try {
    await action();
    if (messages.success) showToast(messages.success, 'success');
  } catch (error) {
    const message = error?.message || messages.error || '操作失败';
    appendLog({ time: new Date().toISOString(), line: message });
    showToast(message, 'error');
  } finally {
    if (messages.pending) button.textContent = originalText;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    busyButtons.delete(button);
  }
}

/**
 * 为按钮绑定带反馈的点击事件。
 *
 * @param {HTMLButtonElement} button 需要绑定的按钮。
 * @param {Function} action 点击后执行的动作。
 * @param {{pending?: string, success?: string, error?: string}} [messages={}] 提示文案。
 * @returns {void}
 */
export function bindActionButton(button, action, messages = {}) {
  button.addEventListener('click', () => runButtonAction(button, action, messages));
}

/**
 * 初始化后台页面 hash 路由和侧边导航高亮。
 *
 * 页面拆分后，侧边栏不再依赖滚动位置判断当前模块，而是用 `#projects`、
 * `#workbench`、`#distribution` 作为轻量前端路由。这样用户在项目管理、
 * 打包工作台、分发管理之间切换时，不会被长页面滚动位置干扰。
 *
 * @returns {void}
 */
export function initSideNavIndicator() {
  const pages = Array.from(elements.pages);
  const links = Array.from(elements.pageLinks);
  if (!pages.length || !links.length) return;

  const pageKeys = new Set(pages.map((page) => page.dataset.page).filter(Boolean));
  const firstPage = pageKeys.has('workbench') ? 'workbench' : pages[0].dataset.page;
  const legacyPageMap = new Map([
    // 兼容旧版侧边栏链接，避免用户刷新旧 hash 后落回第一个页面。
    ['release', 'workbench'],
    ['monitor', 'workbench'],
    ['stores', 'distribution'],
    ['notes', 'distribution'],
  ]);
  const pageTitles = new Map(
    links.map((link) => [link.dataset.pageLink, link.dataset.pageTitle || link.textContent.trim()]),
  );

  /**
   * 从当前 hash 中解析页面 key。
   *
   * @returns {string} 有效页面 key；无效 hash 会回退到第一个页面。
   */
  const getPageFromHash = () => {
    const hashPage = decodeURIComponent(window.location.hash || '').replace('#', '');
    const normalizedPage = legacyPageMap.get(hashPage) || hashPage;
    return pageKeys.has(normalizedPage) ? normalizedPage : firstPage;
  };

  /**
   * 切换当前显示的后台页面，并同步侧边导航高亮。
   *
   * @param {string} pageKey 目标页面 key。
   * @param {{replaceHash?: boolean, scrollTop?: boolean}} [options={}] 路由切换选项。
   * @returns {void}
   */
  const setActivePage = (pageKey, options = {}) => {
    const nextPage = pageKeys.has(pageKey) ? pageKey : firstPage;
    state.activePage = nextPage;

    pages.forEach((page) => {
      const active = page.dataset.page === nextPage;
      page.classList.toggle('active', active);
      page.hidden = !active;
    });

    links.forEach((link) => {
      const active = link.dataset.pageLink === nextPage;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    if (elements.pageTitle) {
      elements.pageTitle.textContent = pageTitles.get(nextPage) || 'Open Release Pilot';
    }

    if (options.replaceHash && window.location.hash !== `#${nextPage}`) {
      window.history.replaceState(null, '', `#${nextPage}`);
    }
    if (options.scrollTop) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const targetPage = link.dataset.pageLink || firstPage;
      if (window.location.hash === `#${targetPage}`) {
        setActivePage(targetPage, { scrollTop: true });
        return;
      }
      window.location.hash = targetPage;
    });
  });

  window.addEventListener('hashchange', () => setActivePage(getPageFromHash(), { scrollTop: true }));

  const initialPage = getPageFromHash();
  setActivePage(initialPage, { replaceHash: window.location.hash !== `#${initialPage}` });
}
