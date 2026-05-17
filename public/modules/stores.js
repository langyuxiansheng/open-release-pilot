import { requestJson } from './api.js';
import { appendLog } from './log.js';
import { elements, state } from './state.js';
import { showToast } from './ui.js';

let activeFilePicker = null;

/**
 * 渲染 Android 应用商店发布配置。
 *
 * 配置由服务端 schemas 驱动：新增平台或字段时优先改 server.js 的 schema，
 * 前端会根据 type 自动生成输入框，不需要为每个平台写一套表单。
 *
 * @param {object} storeConfig 后端返回的商店配置上下文。
 * @returns {void}
 */
export function renderStores(storeConfig) {
  elements.storeConfig.innerHTML = '';
  // 老版本接口没有 platforms 字段时，用 schemas 的 key 兜底，保证页面不白屏。
  const platforms = storeConfig.platforms || Object.keys(storeConfig.schemas).map((key) => ({ key, name: key }));
  state.activeStoreKey ||= platforms[0]?.key || '';

  const configLabel = document.createElement('div');
  configLabel.className = 'config-path';
  configLabel.textContent = storeConfig.usingLocalConfig
    ? `正在使用本地配置：${storeConfig.path}`
    : `当前加载示例配置，保存后会写入：${storeConfig.localPath}`;
  elements.storeConfig.appendChild(configLabel);

  const tabs = document.createElement('div');
  tabs.className = 'store-tabs';
  platforms.forEach((platform) => {
    const values = storeConfig.stores[platform.key] || {};
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `store-tab ${platform.key === state.activeStoreKey ? 'active' : ''} ${values.enabled ? 'enabled' : ''}`;
    tab.textContent = platform.name;
    tab.title = `${platform.code || platform.key} / ${values.enabled ? '已启用' : '未启用'}`;
    tab.addEventListener('click', () => {
      // 切 tab 时只重绘上传配置区域，不重新请求接口，避免覆盖用户正在编辑的其它区块。
      state.activeStoreKey = platform.key;
      renderStores(state.status.storeConfig);
    });
    tabs.appendChild(tab);
  });
  elements.storeConfig.appendChild(tabs);

  const activePlatform = platforms.find((platform) => platform.key === state.activeStoreKey) || platforms[0];
  if (!activePlatform) return;

  // 当前平台的字段和值分开读取：schema 定义字段展示和值类型，stores 保存用户本机配置。
  const fields = storeConfig.schemas[activePlatform.key] || [];
  const values = storeConfig.stores[activePlatform.key] || {};
  const card = document.createElement('section');
  card.className = 'store-card';
  card.dataset.store = activePlatform.key;

  const header = document.createElement('div');
  header.className = 'store-card-header';
  const title = document.createElement('strong');
  title.textContent = `${activePlatform.name} (${activePlatform.code || activePlatform.key})`;
  const stateLabel = document.createElement('span');
  stateLabel.textContent = `${values.enabled ? '已启用' : '未启用'} / ${getUploadSupportLabel(activePlatform.uploadSupport)}`;
  header.append(title, stateLabel);
  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'field-note';
  meta.textContent = `渠道值：${activePlatform.code || '-'}；目录：${activePlatform.channelDir || '-'}。这里只配置发布平台，是否实际打包仍由 scripts/build_android_channels.sh 控制。`;
  card.appendChild(meta);

  fields.forEach((field) => {
    card.appendChild(createStoreField(activePlatform, field, values[field.key]));
  });

  elements.storeConfig.appendChild(card);
  updateAllStoreFieldVisibility(activePlatform.key);
}

/**
 * 把服务端的平台能力标识转换成用户能理解的发布能力文案。
 *
 * api-update 专门用于应用宝这类“只支持已上线应用更新”的接口；
 * 这样界面不会把它误描述成完整的新应用上传能力。
 *
 * @param {string} support 服务端 STORE_PLATFORMS 中的 uploadSupport。
 * @returns {string} 展示在渠道 tab 详情里的能力说明。
 */
function getUploadSupportLabel(support) {
  if (support === 'api') return '接口上传';
  if (support === 'api-update') return '接口更新';
  return '人工或待接入';
}

/**
 * 根据 schema 创建单个商店配置字段。
 *
 * 支持类型：
 * section 只渲染分组说明，不参与保存；checkbox 布尔开关；
 * segmented 渲染成按钮组，适合安装方式这类少量互斥选项；
 * number 保存时转为 Number；list 多行文本转数组；
 * release-notes 提供“引用全局更新日志”按钮；textarea/password/text 原样保存字符串。
 *
 * @param {object} platform 当前平台配置。
 * @param {object} field 字段 schema。
 * @param {unknown} value 字段当前值。
 * @returns {HTMLElement} 字段表单 DOM。
 */
function createStoreField(platform, field, value) {
  const storeKey = platform.key;
  const wrapper = document.createElement('div');
  wrapper.className = `store-field ${field.type === 'checkbox' ? 'checkbox' : ''} ${field.type === 'section' ? 'section-field' : ''}`;
  wrapper.dataset.fieldKey = field.key;
  if (field.visibleWhen) {
    wrapper.dataset.visibleWhenKey = field.visibleWhen.key;
    wrapper.dataset.visibleWhenEquals = String(field.visibleWhen.equals);
  }

  const inputId = `store-${storeKey}-${field.key}`;
  const label = document.createElement('label');
  label.htmlFor = inputId;
  label.textContent = field.label;

  if (field.type === 'section') {
    // section 只承担表单分组说明，不写入 stores.local.json。
    // 复杂平台接口字段很多时，分组能让维护者按接口路由快速定位参数。
    const heading = document.createElement('strong');
    heading.textContent = field.label;
    const note = document.createElement('div');
    note.className = 'field-note';
    note.textContent = field.note || '';
    wrapper.append(heading, note);
    return wrapper;
  }

  const input = field.type === 'textarea' || field.type === 'list' || field.type === 'release-notes'
    ? document.createElement('textarea')
    : document.createElement('input');
  input.id = inputId;
  input.dataset.store = storeKey;
  input.dataset.key = field.key;
  input.dataset.type = field.type;

  if (field.type === 'checkbox') {
    input.type = 'checkbox';
    input.checked = Boolean(value);
    wrapper.append(input, label);
  } else {
    // textarea 的 type 是浏览器只读属性，只有真正的 input 才能设置 type。
    // 这里用 tagName 判断，避免 textarea/list/release-notes 字段在切换渠道 tab 时抛错。
    if (input.tagName === 'INPUT') {
      input.type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
    }
    input.value = field.type === 'list'
      ? Array.isArray(value) ? value.join('\n') : ''
      : value ?? '';
    if (field.type === 'segmented') {
      wrapper.append(label, createSegmentedField(field, input, value));
    } else if (field.type === 'release-notes') {
      // 渠道发布说明是独立字段。按钮只把全局更新日志复制到当前 textarea，
      // 不建立自动同步关系，避免用户后续单独调整渠道文案时被覆盖。
      const labelRow = document.createElement('div');
      labelRow.className = 'field-label-row';
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'field-inline-action';
      copyButton.textContent = '引用全局更新日志';
      copyButton.addEventListener('click', () => {
        input.value = elements.releaseNotes.value || '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      labelRow.append(label, copyButton);
      wrapper.append(labelRow, input);
    } else if (field.type === 'password') {
      // 密钥类字段默认隐藏，但本地调试发布接口时经常需要核对复制结果。
      // 只切换 input.type，不改 value 和 data-*，保存逻辑仍然按原输入框读取。
      const secretRow = document.createElement('div');
      secretRow.className = 'secret-input-row';
      const toggleButton = document.createElement('button');
      toggleButton.type = 'button';
      toggleButton.className = 'secret-toggle-button';
      toggleButton.textContent = '显示';
      toggleButton.setAttribute('aria-label', `显示${field.label}`);
      toggleButton.addEventListener('click', () => {
        const shouldShow = input.type === 'password';
        input.type = shouldShow ? 'text' : 'password';
        toggleButton.textContent = shouldShow ? '隐藏' : '显示';
        toggleButton.setAttribute('aria-label', `${shouldShow ? '隐藏' : '显示'}${field.label}`);
      });
      secretRow.append(input, toggleButton);
      wrapper.append(label, secretRow);
    } else if (isPathField(field)) {
      // APK、截图、资质文件等路径字段仍然允许手动编辑；选择按钮只是把本机文件路径写入输入框。
      // 每个平台 tab 只保存自己的 stores[storeKey]，所以不同渠道可以选择不同安装包。
      const pathRow = document.createElement('div');
      pathRow.className = field.type === 'list' ? 'store-path-list-row' : 'store-path-input-row';
      const pickButton = document.createElement('button');
      pickButton.type = 'button';
      pickButton.className = 'store-path-picker-button';
      pickButton.textContent = field.type === 'list' ? '添加文件' : getPathPickerButtonText(field);
      pickButton.addEventListener('click', () => openStoreFilePicker(platform, field, input));
      pathRow.append(input, pickButton);
      wrapper.append(label, pathRow);
    } else {
      wrapper.append(label, input);
    }
  }

  const note = document.createElement('div');
  note.className = 'field-note';
  note.textContent = field.note || '';
  wrapper.appendChild(note);
  applyStoreFieldVisibility(wrapper);
  input.addEventListener('input', () => updateDependentStoreFields(storeKey, field.key, input.value));
  input.addEventListener('change', () => updateDependentStoreFields(storeKey, field.key, input.value));
  return wrapper;
}

/**
 * 创建分段按钮字段。
 *
 * 分段按钮本质上仍然通过一个隐藏 input 保存值，所以 collectStoreConfig
 * 不需要知道它的 DOM 细节，仍按 data-store/data-key/data-type 收集。
 *
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement} input 隐藏输入框。
 * @param {unknown} value 当前字段值。
 * @returns {HTMLElement} 分段按钮容器。
 */
function createSegmentedField(field, input, value) {
  const group = document.createElement('div');
  group.className = 'store-segmented';
  input.type = 'hidden';
  input.dataset.valueType = field.valueType || 'string';

  const defaultValue = value === undefined || value === null || value === ''
    ? field.options?.[0]?.value ?? ''
    : value;
  input.value = String(defaultValue);

  (field.options || []).forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'store-segmented-option';
    button.textContent = option.label;
    button.dataset.value = String(option.value);
    button.setAttribute('aria-pressed', String(String(option.value) === input.value));
    button.addEventListener('click', () => {
      input.value = String(option.value);
      updateSegmentedActiveState(group, input.value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    group.appendChild(button);
  });
  updateSegmentedActiveState(group, input.value);
  group.appendChild(input);
  return group;
}

/**
 * 更新分段按钮激活态。
 *
 * @param {HTMLElement} group 分段按钮容器。
 * @param {string} value 当前值。
 * @returns {void}
 */
function updateSegmentedActiveState(group, value) {
  group.querySelectorAll('.store-segmented-option').forEach((button) => {
    button.classList.toggle('active', button.dataset.value === String(value));
    button.setAttribute('aria-pressed', String(button.dataset.value === String(value)));
  });
}

/**
 * 根据 visibleWhen 控制字段显示状态。
 *
 * 字段隐藏时保留 DOM 和值，避免用户在切换安装方式时丢失已经输入的密码。
 *
 * @param {HTMLElement} wrapper 字段容器。
 * @returns {void}
 */
function applyStoreFieldVisibility(wrapper) {
  const dependencyKey = wrapper.dataset.visibleWhenKey;
  if (!dependencyKey) return;
  const expectedValue = wrapper.dataset.visibleWhenEquals;
  const storeKey = wrapper.querySelector('[data-store]')?.dataset.store;
  const scope = wrapper.closest('.store-card') || elements.storeConfig;
  const dependencyInput = scope.querySelector(`[data-store="${storeKey}"][data-key="${dependencyKey}"]`);
  const visible = dependencyInput && dependencyInput.value === expectedValue;
  wrapper.hidden = !visible;
}

/**
 * 当前平台表单渲染完成后统一刷新一次字段显隐。
 *
 * createStoreField 执行时表单卡片还没有挂到页面上，依赖字段可能暂时查不到；
 * 渲染完成后补一次全量计算，保证密码字段这类条件字段初始状态正确。
 *
 * @param {string} storeKey 平台 key。
 * @returns {void}
 */
function updateAllStoreFieldVisibility(storeKey) {
  elements.storeConfig.querySelectorAll('[data-visible-when-key]').forEach((wrapper) => {
    const input = wrapper.querySelector('[data-store]');
    if (input?.dataset.store === storeKey) applyStoreFieldVisibility(wrapper);
  });
}

/**
 * 依赖字段变化后刷新同平台其它字段的显隐。
 *
 * @param {string} storeKey 平台 key。
 * @param {string} changedKey 发生变化的字段 key。
 * @param {string} value 当前值，仅用于说明事件语义。
 * @returns {void}
 */
function updateDependentStoreFields(storeKey, changedKey, value) {
  void value;
  elements.storeConfig.querySelectorAll(`[data-visible-when-key="${changedKey}"]`).forEach((wrapper) => {
    const input = wrapper.querySelector('[data-store]');
    if (input?.dataset.store === storeKey) applyStoreFieldVisibility(wrapper);
  });
}

/**
 * 判断字段是否是本地文件路径配置。
 *
 * 这里只处理应用市场发布配置里的本地文件路径：APK/AAB、截图、图标、PDF 资质等。
 * URL 字段和账号字段不会被当成文件路径，避免误显示选择按钮。
 *
 * @param {object} field 字段 schema。
 * @returns {boolean} true 表示需要显示文件选择按钮。
 */
function isPathField(field) {
  if (!['text', 'list'].includes(field.type)) return false;
  return /path|paths/i.test(field.key) || /路径/.test(field.label || '');
}

/**
 * 按字段含义返回选择按钮文案。
 *
 * @param {object} field 字段 schema。
 * @returns {string} 按钮文案。
 */
function getPathPickerButtonText(field) {
  return /apk|aab/i.test(field.key) || /APK|AAB/.test(field.label || '') ? '选择包' : '选择文件';
}

/**
 * 打开应用市场配置的本地文件选择器。
 *
 * @param {object} platform 当前平台配置。
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement|HTMLTextAreaElement} input 目标输入框。
 * @returns {void}
 */
function openStoreFilePicker(platform, field, input) {
  activeFilePicker = { platform, field, input, selectedPath: '' };
  const modal = getStoreFilePickerModal();
  modal.querySelector('[data-picker-selected]').textContent = '未选择';
  modal.classList.add('open');
  modal.removeAttribute('hidden');
  loadStorePickerDirectory(getInitialPickerPath(platform, field, input), field).catch((error) => {
    appendLog({ time: new Date().toISOString(), line: error.message });
    showToast(error.message || '读取文件列表失败', 'error');
  });
}

/**
 * 获取文件选择器的初始目录。
 *
 * @param {object} platform 当前平台配置。
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement|HTMLTextAreaElement} input 目标输入框。
 * @returns {string} 初始目录或文件路径。
 */
function getInitialPickerPath(platform, field, input) {
  const currentValue = field.type === 'list'
    ? String(input.value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1)
    : String(input.value || '').trim();
  if (currentValue) return currentValue;

  if (/apk|aab/i.test(field.key)) {
    const packageInfo = state.status?.packageInfo;
    const matchedPackage = packageInfo?.packages?.find((item) => item.code === platform.code);
    return matchedPackage?.apk?.path || matchedPackage?.expectedApkPath || (matchedPackage ? `${packageInfo.versionDir}/${matchedPackage.dir}` : packageInfo?.versionDir) || '/';
  }

  return state.status?.activeProject?.rootPath || state.status?.projectRoot || '/';
}

/**
 * 创建或复用应用市场文件选择弹窗。
 *
 * @returns {HTMLElement} 弹窗 DOM。
 */
function getStoreFilePickerModal() {
  let modal = document.querySelector('#storeFilePickerModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'storeFilePickerModal';
  modal.className = 'path-picker-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="path-picker-dialog" role="dialog" aria-modal="true" aria-label="选择上传文件">
      <div class="path-picker-header">
        <strong>选择上传文件</strong>
        <button type="button" data-picker-close>关闭</button>
      </div>
      <div class="path-picker-current">
        <span>当前目录</span>
        <code data-picker-current></code>
      </div>
      <div class="path-picker-actions">
        <button type="button" data-picker-parent>上一级</button>
        <button type="button" data-picker-use>使用所选文件</button>
      </div>
      <div class="path-picker-list" data-picker-list></div>
      <div class="path-picker-selected">将写入：<code data-picker-selected>未选择</code></div>
    </div>
  `;
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.matches('[data-picker-close]')) closeStoreFilePicker();
  });
  modal.querySelector('[data-picker-parent]').addEventListener('click', () => {
    loadStorePickerDirectory(modal.dataset.parentPath, activeFilePicker?.field).catch((error) => showToast(error.message || '读取文件列表失败', 'error'));
  });
  modal.querySelector('[data-picker-use]').addEventListener('click', () => applySelectedStoreFile());
  document.body.appendChild(modal);
  return modal;
}

/**
 * 加载文件选择器当前目录。
 *
 * @param {string} directoryPath 目标目录或文件路径。
 * @param {object} field 字段 schema。
 * @returns {Promise<void>} 加载完成。
 */
async function loadStorePickerDirectory(directoryPath, field) {
  const modal = getStoreFilePickerModal();
  const extensions = getAllowedExtensions(field);
  const result = await requestJson(`/api/files/list?path=${encodeURIComponent(directoryPath || '/')}&includeFiles=1&extensions=${encodeURIComponent(extensions.join(','))}`);
  modal.dataset.currentPath = result.path;
  modal.dataset.parentPath = result.parentPath;
  modal.querySelector('[data-picker-current]').textContent = result.path;

  const list = modal.querySelector('[data-picker-list]');
  list.innerHTML = '';
  if (!result.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = extensions.length ? `当前目录下没有匹配文件：${extensions.join(', ')}` : '当前目录下没有可选文件。';
    list.appendChild(empty);
    return;
  }

  result.entries.forEach((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `picker-entry ${entry.isDirectory ? 'directory' : 'file'}`;
    button.textContent = `${entry.isDirectory ? '目录' : '文件'}：${entry.name}`;
    button.addEventListener('click', () => {
      if (entry.isDirectory) {
        loadStorePickerDirectory(entry.path, field).catch((error) => showToast(error.message || '读取文件列表失败', 'error'));
        return;
      }
      activeFilePicker.selectedPath = entry.path;
      modal.querySelector('[data-picker-selected]').textContent = entry.path;
      list.querySelectorAll('.picker-entry.selected').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
    });
    list.appendChild(button);
  });
}

/**
 * 根据字段类型限制可选文件后缀。
 *
 * @param {object} field 字段 schema。
 * @returns {string[]} 小写文件后缀列表。
 */
function getAllowedExtensions(field) {
  const key = `${field.key || ''} ${field.label || ''}`.toLowerCase();
  if (/apk|aab/.test(key)) return ['.apk', '.aab'];
  if (/ipa/.test(key)) return ['.ipa'];
  if (/icon|screenshot|snapshot|image|img|截图|图标/.test(key)) return ['.png', '.jpg', '.jpeg', '.webp'];
  if (/pdf|cert|licence|license|资质|证书|版权/.test(key)) return ['.pdf', '.png', '.jpg', '.jpeg'];
  if (/video|视频/.test(key)) return ['.mp4', '.m4a', '.mov'];
  return [];
}

/**
 * 把选择的文件路径写回当前字段。
 *
 * @returns {void}
 */
function applySelectedStoreFile() {
  if (!activeFilePicker?.selectedPath) {
    showToast('请先选择一个文件', 'error');
    return;
  }

  const { input, field, selectedPath } = activeFilePicker;
  if (field.type === 'list') {
    const lines = String(input.value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!lines.includes(selectedPath)) lines.push(selectedPath);
    input.value = lines.join('\n');
  } else {
    input.value = selectedPath;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  closeStoreFilePicker();
}

/**
 * 关闭应用市场文件选择弹窗。
 *
 * @returns {void}
 */
function closeStoreFilePicker() {
  const modal = document.querySelector('#storeFilePickerModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.hidden = true;
  activeFilePicker = null;
}

/**
 * 收集当前可见商店 tab 的配置并合并回完整 stores。
 *
 * DOM 中只有当前 tab 的字段，所以必须从 state.status 复制完整 stores，
 * 再覆盖当前可见字段，避免保存一个平台时把其它平台配置清空。
 *
 * @returns {object} 可提交给 /api/store-config 的完整 stores 配置。
 */
function collectStoreConfig() {
  const stores = structuredClone(state.status.storeConfig.stores || {});
  elements.storeConfig.querySelectorAll('[data-store][data-key]').forEach((input) => {
    const store = input.dataset.store;
    const key = input.dataset.key;
    const type = input.dataset.type;
    stores[store] ||= {};

    if (type === 'checkbox') {
      stores[store][key] = input.checked;
    } else if (type === 'segmented') {
      stores[store][key] = input.dataset.valueType === 'number' ? Number(input.value) : input.value;
    } else if (type === 'number') {
      stores[store][key] = input.value === '' ? '' : Number(input.value);
    } else if (type === 'list') {
      stores[store][key] = input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    } else {
      stores[store][key] = input.value;
    }
  });
  return stores;
}

/**
 * 保存 Android 应用商店配置。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 保存和状态刷新完成。
 */
export async function saveStoreConfig(refreshStatus) {
  const stores = collectStoreConfig();
  await requestJson('/api/store-config', {
    method: 'POST',
    body: JSON.stringify({ stores }),
  });
  appendLog({ time: new Date().toISOString(), line: '上传配置已保存到 stores.local.json' });
  await refreshStatus();
}
