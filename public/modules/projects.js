import { requestJson } from './api.js';
import { appendLog } from './log.js';
import { elements, state } from './state.js';
import { showToast } from './ui.js';

const PATH_FIELD_KEYS = new Set(['rootPath', 'androidOutputRoot', 'iosOutputRoot']);
const TEMPLATE_SAMPLE = {
  versionName: '3.5.0',
  versionCode: '68',
  channel: 'XIAOMI',
  appSlug: 'demo-app',
};

/**
 * 渲染项目管理面板。
 *
 * 项目配置是整个发布面板的入口：路径、输出目录、文件命名和渠道列表都会影响
 * Android/iOS 打包、安装包扫描、扫码安装和上传配置。
 *
 * @param {object} projectContext 后端 /api/status 返回的 projects 上下文。
 * @returns {void}
 */
export function renderProjects(projectContext) {
  if (!elements.projectPanel || !projectContext?.projects) return;
  elements.projectPanel.innerHTML = '';

  const activeProject = projectContext.projects.find((project) => project.id === projectContext.activeProjectId) || projectContext.projects[0];
  elements.projectPanel.appendChild(createProjectToolbar(projectContext, activeProject));
  elements.projectPanel.appendChild(createProjectForm(activeProject));
  elements.projectPanel.appendChild(createRequiredFields(projectContext.requiredFields || []));
  elements.projectPanel.appendChild(createTemplateHelp(activeProject));
  updateTemplatePreview();
}

/**
 * 创建项目选择器。
 *
 * @param {object} projectContext 项目上下文。
 * @param {object} activeProject 当前项目。
 * @returns {HTMLElement} 项目选择器 DOM。
 */
function createProjectToolbar(projectContext, activeProject) {
  const toolbar = document.createElement('div');
  toolbar.className = 'project-toolbar';

  const selectorWrap = document.createElement('label');
  selectorWrap.className = 'project-select-field';
  const label = document.createElement('span');
  label.textContent = '当前项目';
  const select = document.createElement('select');
  select.id = 'projectSelector';
  projectContext.projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = `${project.name} (${project.id})`;
    option.selected = project.id === activeProject.id;
    select.appendChild(option);
  });
  select.addEventListener('change', async () => {
    select.disabled = true;
    await requestJson('/api/projects/active', {
      method: 'POST',
      body: JSON.stringify({ projectId: select.value }),
    });
    appendLog({ time: new Date().toISOString(), line: `已切换项目：${select.value}` });
    showToast('当前项目已切换', 'success');
    window.dispatchEvent(new CustomEvent('orp:project-switched', {
      detail: { projectId: select.value },
    }));
  });
  selectorWrap.append(label, select);

  const dbPath = document.createElement('div');
  dbPath.className = 'config-path';
  dbPath.textContent = `项目配置数据库：${projectContext.path}`;

  const inspectButton = document.createElement('button');
  inspectButton.type = 'button';
  inspectButton.textContent = '识别项目配置';
  inspectButton.addEventListener('click', () => inspectCurrentProject().catch((error) => {
    appendLog({ time: new Date().toISOString(), line: error.message });
    showToast(error.message || '项目识别失败', 'error');
  }));

  const toolbarMeta = document.createElement('div');
  toolbarMeta.className = 'project-toolbar-meta';
  toolbarMeta.append(inspectButton, dbPath);

  toolbar.append(selectorWrap, toolbarMeta);
  return toolbar;
}

/**
 * 创建当前项目配置表单。
 *
 * @param {object} project 当前项目配置。
 * @returns {HTMLElement} 项目表单 DOM。
 */
function createProjectForm(project) {
  const form = document.createElement('div');
  form.className = 'project-form';
  const fields = [
    ['id', '项目 ID', project.id, '保存后作为数据库 key，建议使用英文、数字、横线。'],
    ['name', '项目名称', project.name, '面板展示名称。'],
    ['type', '项目类型', project.type || 'flutter', '可识别 flutter / android；当前打包脚本优先适配 Flutter。'],
    ['rootPath', '项目根目录', project.rootPath, '必须存在；选择后可点击“识别项目配置”自动回填。'],
    ['appSlug', '应用短名', project.appSlug, '用于 IPA 文件名和后续开源配置示例。'],
    ['versionFile', '版本文件', project.versionFile, 'Flutter 默认 android/local.properties；Android 原生项目可用 app/build.gradle。'],
    ['versionNamePattern', 'versionName 匹配规则', project.versionNamePattern, '从版本文件读取版本号的正则；识别项目时会自动回填。'],
    ['versionCodePattern', 'versionCode 匹配规则', project.versionCodePattern, '从版本文件读取构建号的正则；识别项目时会自动回填。'],
    ['androidOutputRoot', 'Android 输出根目录', project.androidOutputRoot, '可以不存在；输出 APK 时会自动创建版本和渠道目录。'],
    ['iosOutputRoot', 'iOS 输出根目录', project.iosOutputRoot, '可以不存在；输出 IPA 时会自动创建版本目录。'],
    ['androidApkSource', 'Flutter APK 产物路径', project.androidApkSource, '相对 Flutter 项目根目录，例如 build/app/outputs/flutter-apk/app-release.apk。'],
    ['apkNameTemplate', 'APK 命名模板', project.apkNameTemplate, '可选使用 {versionName}、{versionCode}、{channel}、{appSlug}，底部会实时预览。'],
    ['ipaNameTemplate', 'IPA 命名模板', project.ipaNameTemplate, '可选使用 {appSlug}、{versionName}、{versionCode}，底部会实时预览。'],
  ];

  fields.forEach(([key, label, value, note]) => {
    form.appendChild(createProjectField(key, label, value, note));
  });
  form.appendChild(createProjectField('channelsText', 'Android 渠道列表', channelsToText(project.channels), '每行 CODE=目录=显示名，例如 XIAOMI=小米=小米。', true));
  form.addEventListener('input', updateTemplatePreview);
  return form;
}

/**
 * 创建项目配置输入项。
 *
 * @param {string} key 字段 key。
 * @param {string} labelText 标签。
 * @param {string} value 当前值。
 * @param {string} note 说明。
 * @param {boolean} [multiline=false] 是否多行。
 * @returns {HTMLElement} 字段 DOM。
 */
function createProjectField(key, labelText, value, note, multiline = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'project-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = multiline ? document.createElement('textarea') : document.createElement('input');
  input.dataset.projectKey = key;
  input.value = value || '';
  const hint = document.createElement('div');
  hint.className = 'field-note';
  hint.textContent = note;
  if (PATH_FIELD_KEYS.has(key)) {
    const row = document.createElement('div');
    row.className = 'path-input-row';
    const browseButton = document.createElement('button');
    browseButton.type = 'button';
    browseButton.textContent = '选择';
    browseButton.addEventListener('click', () => openPathPicker(input));
    row.append(input, browseButton);
    wrapper.append(label, row, hint);
    return wrapper;
  }
  wrapper.append(label, input, hint);
  return wrapper;
}

/**
 * 展示 Flutter 项目适配所需的关键配置。
 *
 * @param {object[]} fields 必填字段说明。
 * @returns {HTMLElement} 说明 DOM。
 */
function createRequiredFields(fields) {
  const box = document.createElement('div');
  box.className = 'required-fields';
  const title = document.createElement('strong');
  title.textContent = '适配 Flutter 项目需要配置这些参数';
  const list = document.createElement('div');
  list.className = 'required-field-list';
  fields.forEach((field) => {
    const item = document.createElement('div');
    item.innerHTML = `<b>${field.label}</b><span>${field.note}</span>`;
    list.appendChild(item);
  });
  box.append(title, list);
  return box;
}

/**
 * 创建命名模板变量说明和预览区域。
 *
 * @param {object} project 当前项目。
 * @returns {HTMLElement} 模板说明 DOM。
 */
function createTemplateHelp(project) {
  const box = document.createElement('div');
  box.className = 'template-help';

  const title = document.createElement('strong');
  title.textContent = '命名模板变量说明';

  const variables = document.createElement('div');
  variables.className = 'template-variable-list';
  [
    ['{versionName}', '版本号，例如 3.5.0。'],
    ['{versionCode}', '构建号，例如 68。'],
    ['{channel}', 'Android 渠道代码，例如 XIAOMI。'],
    ['{appSlug}', '应用短名，例如 demo_app。'],
  ].forEach(([name, note]) => {
    const item = document.createElement('div');
    const code = document.createElement('code');
    const text = document.createElement('span');
    code.textContent = name;
    text.textContent = note;
    item.append(code, text);
    variables.appendChild(item);
  });

  const preview = document.createElement('div');
  preview.className = 'template-preview';
  preview.innerHTML = `
    <div><b>APK 预览</b><span data-template-preview="apk"></span></div>
    <div><b>IPA 预览</b><span data-template-preview="ipa"></span></div>
  `;

  box.append(title, variables, preview);
  return box;
}

/**
 * 根据表单当前值刷新 APK/IPA 命名预览。
 *
 * @returns {void}
 */
function updateTemplatePreview() {
  const project = collectProjectForm();
  const values = { ...TEMPLATE_SAMPLE, appSlug: project.appSlug || TEMPLATE_SAMPLE.appSlug };
  const apkPreview = elements.projectPanel.querySelector('[data-template-preview="apk"]');
  const ipaPreview = elements.projectPanel.querySelector('[data-template-preview="ipa"]');
  if (apkPreview) apkPreview.textContent = renderTemplate(project.apkNameTemplate || '', values);
  if (ipaPreview) ipaPreview.textContent = renderTemplate(project.ipaNameTemplate || '', values);
}

/**
 * 调用后端识别当前项目根目录并回填表单。
 *
 * @returns {Promise<void>} 识别完成。
 */
async function inspectCurrentProject() {
  const project = collectProjectForm();
  if (!project.rootPath) throw new Error('请先填写或选择项目根目录。');
  const result = await requestJson('/api/projects/inspect', {
    method: 'POST',
    body: JSON.stringify({ path: project.rootPath }),
  });
  const nextProject = {
    ...project,
    ...result.project,
    androidOutputRoot: project.androidOutputRoot || result.project.androidOutputRoot,
    iosOutputRoot: project.iosOutputRoot || result.project.iosOutputRoot,
    channels: project.channels?.length ? project.channels : result.project.channels,
  };
  applyProjectToForm(nextProject);
  updateTemplatePreview();
  appendLog({ time: new Date().toISOString(), line: `已识别 ${result.type} 项目：${nextProject.name}` });
  (result.warnings || []).forEach((warning) => appendLog({ time: new Date().toISOString(), line: `项目识别提示：${warning}` }));
  showToast('项目配置已识别并回填', 'success');
}

/**
 * 将项目配置写回当前表单。
 *
 * @param {object} project 项目配置。
 * @returns {void}
 */
function applyProjectToForm(project) {
  elements.projectPanel.querySelectorAll('[data-project-key]').forEach((input) => {
    const key = input.dataset.projectKey;
    if (key === 'channelsText') input.value = channelsToText(project.channels || []);
    else input.value = project[key] || '';
  });
}

/**
 * 收集当前项目表单。
 *
 * @returns {object} 项目配置。
 */
function collectProjectForm() {
  const current = getActiveProjectFromState();
  const project = { ...current };
  elements.projectPanel.querySelectorAll('[data-project-key]').forEach((input) => {
    const key = input.dataset.projectKey;
    if (key === 'channelsText') project.channels = textToChannels(input.value);
    else project[key] = input.value.trim();
  });
  return project;
}

/**
 * 保存当前项目配置。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 保存完成。
 */
export async function saveProject(refreshStatus) {
  const project = collectProjectForm();
  validateProjectTemplates(project);
  await requestJson('/api/projects/save', {
    method: 'POST',
    body: JSON.stringify({ project }),
  });
  appendLog({ time: new Date().toISOString(), line: `项目配置已保存：${project.name || project.id}` });
  await refreshStatus();
}

/**
 * 新建一个 Flutter 项目配置草稿。
 *
 * @returns {void}
 */
export function createNewProjectDraft() {
  const base = getActiveProjectFromState();
  const draft = {
    ...base,
    id: `project-${Date.now()}`,
    name: '新 Flutter 项目',
    rootPath: '',
    appSlug: 'flutter-app',
  };
  renderProjects({
    ...state.status.projects,
    activeProjectId: draft.id,
    projects: [...state.status.projects.projects.filter((project) => project.id !== draft.id), draft],
  });
}

/**
 * 删除当前项目配置。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 删除完成。
 */
export async function deleteCurrentProject(refreshStatus) {
  const project = getActiveProjectFromState();
  if (!window.confirm(`确认删除项目配置「${project.name}」吗？不会删除 Flutter 工程文件。`)) return;
  await requestJson('/api/projects/delete', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id }),
  });
  appendLog({ time: new Date().toISOString(), line: `项目配置已删除：${project.name}` });
  await refreshStatus();
}

/**
 * 从状态快照读取当前项目。
 *
 * @returns {object} 当前项目配置。
 */
function getActiveProjectFromState() {
  const context = state.status?.projects;
  return context?.projects?.find((project) => project.id === context.activeProjectId) || context?.projects?.[0] || {};
}

/**
 * 渠道数组转为可编辑文本。
 *
 * @param {object[]} channels 渠道列表。
 * @returns {string} 多行文本。
 */
function channelsToText(channels = []) {
  return channels.map((channel) => `${channel.code}=${channel.dir}=${channel.name}`).join('\n');
}

/**
 * 渠道文本转数组。
 *
 * @param {string} text 多行渠道配置。
 * @returns {object[]} 渠道列表。
 */
function textToChannels(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code = '', dir = '', name = ''] = line.split('=');
      return {
        code: code.trim().toUpperCase(),
        dir: dir.trim() || code.trim(),
        name: name.trim() || code.trim(),
      };
    });
}

/**
 * 在浏览器端提前校验命名模板。
 *
 * 后端也会做同样校验；这里先给用户即时反馈，避免点击保存后才从接口错误里反推
 * 模板格式问题。变量是可选的，输出目录已经按版本和渠道拆分；这里仅校验后缀、
 * 路径分隔符、未知变量和花括号是否正常。
 *
 * @param {object} project 项目配置。
 * @returns {void}
 */
function validateProjectTemplates(project) {
  validateTemplate('APK 命名模板', project.apkNameTemplate, {
    extension: '.apk',
  });
  validateTemplate('IPA 命名模板', project.ipaNameTemplate, {
    extension: '.ipa',
  });
}

/**
 * 校验单个文件命名模板是否可渲染为合法文件名。
 *
 * @param {string} label 字段名称。
 * @param {string} template 模板文本。
 * @param {{extension: string}} options 校验选项。
 * @returns {void}
 */
function validateTemplate(label, template, options) {
  const value = String(template || '').trim();
  if (!value) throw new Error(`${label}不能为空。`);
  if (!value.endsWith(options.extension)) throw new Error(`${label}必须以 ${options.extension} 结尾。`);
  if (value.includes('/') || value.includes('\\')) throw new Error(`${label}只能填写文件名，不能包含路径。`);

  const tokens = [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const unknownToken = tokens.find((token) => !(token in TEMPLATE_SAMPLE));
  if (unknownToken) throw new Error(`${label}使用了不支持的变量：{${unknownToken}}。`);

  const rendered = renderTemplate(value, TEMPLATE_SAMPLE);
  if (rendered.includes('{') || rendered.includes('}')) throw new Error(`${label}仍有未替换变量，请检查花括号。`);
}

/**
 * 打开本地目录选择弹窗。
 *
 * 浏览器原生 file input 不能稳定返回本机绝对路径；这里通过本机 Node 服务读取目录列表，
 * 用户点选目录后再把绝对路径写回表单输入框。
 *
 * @param {HTMLInputElement} input 需要写入路径的输入框。
 * @returns {void}
 */
function openPathPicker(input) {
  const modal = getPathPickerModal();
  modal.dataset.targetKey = input.dataset.projectKey;
  modal.querySelector('[data-picker-selected]').textContent = input.value || '未选择';
  modal.classList.add('open');
  modal.removeAttribute('hidden');
  loadPickerDirectory(input.value || '/').catch((error) => {
    appendLog({ time: new Date().toISOString(), line: error.message });
    showToast(error.message || '读取目录失败', 'error');
  });
}

/**
 * 创建或复用目录选择弹窗。
 *
 * @returns {HTMLElement} 弹窗 DOM。
 */
function getPathPickerModal() {
  let modal = document.querySelector('#pathPickerModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'pathPickerModal';
  modal.className = 'path-picker-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="path-picker-dialog" role="dialog" aria-modal="true" aria-label="选择本机目录">
      <div class="path-picker-header">
        <strong>选择本机目录</strong>
        <button type="button" data-picker-close>关闭</button>
      </div>
      <div class="path-picker-current">
        <span>当前目录</span>
        <code data-picker-current></code>
      </div>
      <div class="path-picker-actions">
        <button type="button" data-picker-parent>上一级</button>
        <button type="button" data-picker-use>使用当前目录</button>
      </div>
      <div class="path-picker-list" data-picker-list></div>
      <div class="path-picker-selected">将写入：<code data-picker-selected></code></div>
    </div>
  `;
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.matches('[data-picker-close]')) closePathPicker();
  });
  modal.querySelector('[data-picker-parent]').addEventListener('click', () => {
    loadPickerDirectory(modal.dataset.parentPath).catch((error) => showToast(error.message || '读取目录失败', 'error'));
  });
  modal.querySelector('[data-picker-use]').addEventListener('click', () => {
    const input = elements.projectPanel.querySelector(`[data-project-key="${modal.dataset.targetKey}"]`);
    if (input) {
      input.value = modal.dataset.currentPath || '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    closePathPicker();
  });
  document.body.appendChild(modal);
  return modal;
}

/**
 * 加载目录选择器中的目录列表。
 *
 * @param {string} directoryPath 目标目录。
 * @returns {Promise<void>} 加载完成。
 */
async function loadPickerDirectory(directoryPath) {
  const modal = getPathPickerModal();
  const result = await requestJson(`/api/files/list?path=${encodeURIComponent(directoryPath || '/')}`);
  modal.dataset.currentPath = result.path;
  modal.dataset.parentPath = result.parentPath;
  modal.querySelector('[data-picker-current]').textContent = result.path;

  const list = modal.querySelector('[data-picker-list]');
  list.innerHTML = '';
  if (!result.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '当前目录下没有可选文件夹。';
    list.appendChild(empty);
    return;
  }
  result.entries.forEach((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.name;
    button.addEventListener('click', () => loadPickerDirectory(entry.path));
    list.appendChild(button);
  });
}

/**
 * 关闭路径选择器。
 *
 * @returns {void}
 */
function closePathPicker() {
  const modal = document.querySelector('#pathPickerModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.hidden = true;
}

/**
 * 渲染命名模板。
 *
 * @param {string} template 模板文本。
 * @param {Record<string, string>} values 可替换变量。
 * @returns {string} 渲染结果。
 */
function renderTemplate(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}
