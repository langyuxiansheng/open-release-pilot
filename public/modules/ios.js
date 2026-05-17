import { requestJson } from './api.js';
import { appendLog } from './log.js';
import { elements, state } from './state.js';
import { formatDate } from './utils.js';

/**
 * 渲染 iOS 发布配置和 IPA 状态。
 *
 * iOS 与安卓商店配置分开：iOS 发布目标是“构建/上传动作”，安卓 tabs 是“各商店账号和参数配置”，
 * 两者不要混用。
 *
 * @param {object} packageInfo 后端返回的 iosPackageInfo。
 * @returns {void}
 */
export function renderIosRelease(packageInfo, progress = {}) {
  elements.iosReleasePanel.innerHTML = '';
  const config = packageInfo.config || {};
  const activeTarget = getActiveIosTarget(packageInfo.releaseTargets, config.releaseTarget);
  elements.iosReleaseButton.textContent = activeTarget?.actionLabel || '执行 iOS 发布';
  elements.iosReleaseButton.disabled = Boolean(progress?.running);
  elements.stopIosReleaseButton.disabled = !progress?.running;

  let summary = createIosSummary(packageInfo, activeTarget);
  elements.iosReleasePanel.appendChild(summary);

  elements.iosReleasePanel.appendChild(createIosProgress());
  renderIosReleaseProgress(progress);

  // 展示当前版本 IPA 是否已经存在。脚本支持断点续打，已存在时会跳过重新构建。
  const status = document.createElement('div');
  status.className = 'ios-status';
  status.textContent = packageInfo.ipa
    ? `IPA：${packageInfo.ipa.sizeText} / ${formatDate(packageInfo.ipa.updatedAt)} / ${packageInfo.ipa.path}`
    : `未找到 IPA，预期输出目录：${packageInfo.outputDir}`;
  elements.iosReleasePanel.appendChild(status);

  const targets = document.createElement('div');
  targets.className = 'target-options';
  packageInfo.releaseTargets.forEach((target) => {
    // 目标选择只影响下一次执行 iOS 发布；保存前不会写入本地数据库。
    const row = document.createElement('label');
    row.className = `target-option ${target.key === activeTarget?.key ? 'active' : ''}`;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'iosReleaseTarget';
    input.value = target.key;
    input.checked = config.releaseTarget === target.key;
    input.addEventListener('change', () => {
      // 只要用户切换目标，就即时刷新说明和执行按钮文案，让“下一步会发生什么”保持可见。
      config.releaseTarget = target.key;
      elements.iosReleaseButton.textContent = target.actionLabel || '执行 iOS 发布';
      targets.querySelectorAll('.target-option').forEach((item) => item.classList.remove('active'));
      row.classList.add('active');

      const nextSummary = createIosSummary(packageInfo, target);
      summary.replaceWith(nextSummary);
      summary = nextSummary;

      const nextFlow = createIosFlow(target, packageInfo.ipa);
      flow.replaceWith(nextFlow);
      flow = nextFlow;
    });

    const content = document.createElement('span');
    content.className = 'target-content';
    const title = document.createElement('strong');
    title.textContent = target.label;
    const desc = document.createElement('span');
    desc.textContent = target.summary || '';
    content.append(title, desc);
    row.append(input, content);
    targets.appendChild(row);
  });
  elements.iosReleasePanel.appendChild(targets);

  let flow = createIosFlow(activeTarget, packageInfo.ipa);
  elements.iosReleasePanel.appendChild(flow);

  const grid = document.createElement('div');
  grid.className = 'ios-grid';
  // build-only 使用 AdHoc ExportOptions；上传 App Store Connect/TestFlight 使用 app-store ExportOptions。
  // 服务端会根据 releaseTarget 自动选择对应 plist，这里同时展示两份路径方便维护。
  [
    ['exportOptionsPlist', 'AdHoc ExportOptions.plist'],
    ['appStoreExportOptionsPlist', 'App Store ExportOptions.plist'],
    ['outputDir', '输出目录'],
    ['appleKeyId', 'Apple Key ID'],
    ['appleIssuerId', 'Apple Issuer ID'],
    ['applePrivateKeyPath', '.p8 私钥路径'],
    ['bundleId', 'Bundle ID'],
    ['appAppleId', 'App Apple ID'],
    ['teamId', 'Team ID'],
  ].forEach(([key, label]) => {
    grid.appendChild(createIosField(key, label, config[key] || ''));
  });
  elements.iosReleasePanel.appendChild(grid);

  const betaNote = createIosField('testFlightBetaNote', 'TestFlight 测试说明', config.testFlightBetaNote || '', true);
  elements.iosReleasePanel.appendChild(betaNote);
}

/**
 * 创建 iOS 发布进度展示区。
 *
 * @returns {HTMLElement} 进度 DOM。
 */
function createIosProgress() {
  const wrapper = document.createElement('div');
  wrapper.className = 'ios-progress';

  const meta = document.createElement('div');
  meta.className = 'progress-meta';
  const title = document.createElement('strong');
  title.id = 'iosProgressTitle';
  title.textContent = '空闲 / 0%';
  const elapsed = document.createElement('span');
  elapsed.id = 'iosElapsedText';
  elapsed.textContent = '用时：0秒';
  meta.append(title, elapsed);

  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  bar.setAttribute('aria-label', 'iOS 发布进度');
  const value = document.createElement('div');
  value.id = 'iosProgressBar';
  value.className = 'progress-bar-value';
  bar.appendChild(value);

  const detail = document.createElement('div');
  detail.id = 'iosProgressDetail';
  detail.className = 'progress-detail';
  detail.textContent = '等待开始 iOS 发布';

  wrapper.append(meta, bar, detail);
  return wrapper;
}

/**
 * 渲染 iOS 发布进度。
 *
 * @param {object} progress 后端 /api/ios-release/progress 返回的进度对象。
 * @returns {void}
 */
export function renderIosReleaseProgress(progress = {}) {
  const title = document.querySelector('#iosProgressTitle');
  const bar = document.querySelector('#iosProgressBar');
  const detail = document.querySelector('#iosProgressDetail');
  const elapsed = document.querySelector('#iosElapsedText');
  if (!title || !bar || !detail || !elapsed) return;

  const percent = Number(progress.percent || 0);
  title.textContent = `${progress.statusText || '空闲'} / ${percent}%`;
  bar.style.width = `${percent}%`;
  detail.textContent = progress.detail || '等待开始 iOS 发布';
  elapsed.textContent = `用时：${progress.elapsedText || '0秒'}`;
  elements.iosReleaseButton.disabled = Boolean(progress.running);
  elements.stopIosReleaseButton.disabled = !progress.running;
}

/**
 * 读取当前选中的 iOS 发布目标。
 *
 * @param {object[]} targets 服务端返回的发布目标列表。
 * @param {string} releaseTarget 当前配置里的目标 key。
 * @returns {object|undefined} 当前目标配置。
 */
function getActiveIosTarget(targets, releaseTarget) {
  return targets.find((target) => target.key === releaseTarget) || targets[0];
}

/**
 * 创建 iOS 发布模块顶部说明。
 *
 * @param {object} packageInfo 后端返回的 iosPackageInfo。
 * @param {object|undefined} activeTarget 当前选择的发布目标。
 * @returns {HTMLElement} 顶部说明 DOM。
 */
function createIosSummary(packageInfo, activeTarget) {
  const summary = document.createElement('div');
  summary.className = 'ios-action-summary';

  const title = document.createElement('strong');
  title.textContent = activeTarget?.summary || '选择发布目标后点击执行。';

  const body = document.createElement('span');
  body.textContent = packageInfo.ipa
    ? '当前版本已经有 IPA：上传目标会直接复用这个 IPA；仅打包目标会跳过重新构建。'
    : '当前版本还没有 IPA：执行时会先打包 IPA；选择上传目标时，打包成功后继续上传。';

  const note = document.createElement('span');
  note.textContent = '“保存 iOS 配置”只保存表单；真正打包或上传从“执行”按钮开始。';

  summary.append(title, body, note);
  return summary;
}

/**
 * 创建当前目标的执行流程说明。
 *
 * @param {object|undefined} activeTarget 当前选择的发布目标。
 * @param {object|null} ipa 当前版本 IPA 信息。
 * @returns {HTMLElement} 执行步骤 DOM。
 */
function createIosFlow(activeTarget, ipa) {
  const flow = document.createElement('div');
  flow.className = 'ios-flow';

  const title = document.createElement('strong');
  title.textContent = '点击执行后会做这些事';
  flow.appendChild(title);

  const steps = activeTarget?.steps || [];
  steps.forEach((step, index) => {
    const item = document.createElement('div');
    item.className = 'ios-flow-step';
    const marker = document.createElement('span');
    marker.textContent = `${index + 1}`;
    const text = document.createElement('p');
    text.textContent = step;
    item.append(marker, text);
    flow.appendChild(item);
  });

  if (activeTarget?.key !== 'build-only') {
    const uploadNote = document.createElement('div');
    uploadNote.className = 'ios-flow-note';
    uploadNote.textContent = activeTarget?.key === 'testflight'
      ? 'TestFlight 测试说明目前只保存在本地配置里；上传完成后仍需要到 App Store Connect/TestFlight 页面确认测试信息和测试组。'
      : ipa
      ? '当前会上传已扫描到的 IPA；如果你想重新打包后再上传，需要先删除旧 IPA 或更新版本号。'
      : '上传前必须先打出 IPA，并且 Apple Key ID、Issuer ID、.p8 私钥路径需要配置正确。';
    flow.appendChild(uploadNote);
  }

  return flow;
}

/**
 * 创建 iOS 配置字段。
 *
 * iOS 配置字段目前固定，不走 schema。原因是 iOS 发布字段数量少，
 * 且和 Apple 工具链强相关，固定字段更容易读懂和排查。
 *
 * @param {string} key 配置字段 key。
 * @param {string} labelText 展示标签文本。
 * @param {string} value 当前字段值。
 * @param {boolean} [multiline=false] 是否使用 textarea。
 * @returns {HTMLElement} iOS 配置字段 DOM。
 */
function createIosField(key, labelText, value, multiline = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'store-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = multiline ? document.createElement('textarea') : document.createElement('input');
  input.dataset.iosKey = key;
  input.value = value;
  wrapper.append(label, input);
  return wrapper;
}

/**
 * 收集页面当前 iOS 发布配置。
 *
 * @returns {object} 可提交给 /api/ios-config 的配置对象。
 */
function collectIosConfig() {
  // 从当前 DOM 收集 iOS 配置。这里不做密钥校验，
  // 缺失 Apple API Key 等问题由服务端上传前给出明确日志。
  const config = { ...(state.status.iosPackageInfo.config || {}) };
  const selectedTarget = elements.iosReleasePanel.querySelector('input[name="iosReleaseTarget"]:checked');
  if (selectedTarget) config.releaseTarget = selectedTarget.value;
  elements.iosReleasePanel.querySelectorAll('[data-ios-key]').forEach((input) => {
    config[input.dataset.iosKey] = input.value;
  });
  return config;
}

/**
 * 保存 iOS 发布配置。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 保存和状态刷新完成。
 */
export async function saveIosConfig(refreshStatus) {
  await requestJson('/api/ios-config', {
    method: 'POST',
    body: JSON.stringify({ config: collectIosConfig() }),
  });
  appendLog({ time: new Date().toISOString(), line: 'iOS 配置已保存到 release-db.json' });
  await refreshStatus();
}

/**
 * 保存 iOS 配置并启动 iOS 发布任务。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 保存、启动和状态刷新完成。
 */
export async function startIosRelease(refreshStatus) {
  // iOS 发布前先保存当前页面配置，避免用户改了目标或 API Key 后忘记点保存。
  await saveIosConfig(refreshStatus);
  const result = await requestJson('/api/ios-release', { method: 'POST', body: '{}' });
  appendLog({ time: new Date().toISOString(), line: result.message });
  await refreshStatus();
}

/**
 * 轻量刷新 iOS 发布进度。
 *
 * @returns {Promise<object>} 后端返回的 iOS 进度快照。
 */
export async function refreshIosReleaseProgress() {
  const status = await requestJson('/api/ios-release/progress');
  state.status = {
    ...(state.status || {}),
    iosBuildRunning: status.iosBuildRunning,
    iosReleaseProgress: status.iosReleaseProgress,
  };
  elements.iosBuildState.textContent = status.iosBuildRunning ? '发布中' : '空闲';
  renderIosReleaseProgress(status.iosReleaseProgress);
  return status;
}

/**
 * 停止当前 iOS 发布任务。
 *
 * @returns {Promise<void>} 停止请求和进度刷新完成。
 */
export async function stopIosRelease() {
  const result = await requestJson('/api/ios-release/stop', { method: 'POST', body: '{}' });
  appendLog({ time: new Date().toISOString(), line: result.message });
  await refreshIosReleaseProgress();
}
