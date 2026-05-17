import { elements, state } from './state.js';

const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * 计算当前应该应用的主题。
 *
 * @returns {"light"|"dark"} 最终生效的主题名。
 */
function resolveTheme() {
  if (state.themePreference === 'dark') return 'dark';
  if (state.themePreference === 'light') return 'light';
  return systemThemeQuery.matches ? 'dark' : 'light';
}

/**
 * 将主题状态写入 html 根节点，并刷新主题按钮选中态。
 *
 * CSS 通过 :root[data-theme="dark"] 切换变量；手动选择亮色/暗色后不会再被系统变化覆盖。
 *
 * @returns {void}
 */
export function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme();
  elements.themeOptions.forEach((button) => {
    button.classList.toggle('active', button.dataset.themeOption === state.themePreference);
  });
}

/**
 * 保存用户选择的主题偏好。
 *
 * @param {string} theme 用户选择的主题值：system、light 或 dark。
 * @returns {void}
 */
export function setThemePreference(theme) {
  if (!['system', 'light', 'dark'].includes(theme)) return;
  state.themePreference = theme;
  localStorage.setItem('release-panel-theme', theme);
  applyTheme();
}

/**
 * 绑定主题切换按钮和系统主题变化监听。
 *
 * @returns {void}
 */
export function bindThemeEvents() {
  elements.themeOptions.forEach((button) => {
    button.addEventListener('click', () => setThemePreference(button.dataset.themeOption));
  });

  // 跟随系统时才响应系统主题变化；手动选择亮色/暗色后不自动覆盖。
  // addListener 是旧版 Safari 的兼容兜底。
  const listener = () => {
    if (state.themePreference === 'system') applyTheme();
  };
  if (systemThemeQuery.addEventListener) {
    systemThemeQuery.addEventListener('change', listener);
  } else {
    systemThemeQuery.addListener(listener);
  }
}
