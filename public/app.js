import {
  deleteSelectedPackages,
  refreshBuildProgress,
  renderBuildProgress,
  renderPackages,
  startBuild,
  stopBuild,
  toggleSelectAllChannels,
} from './modules/android.js';
import { requestJson } from './modules/api.js';
import { refreshInstallPreview } from './modules/install-preview.js';
import { refreshIosReleaseProgress, renderIosRelease, saveIosConfig, startIosRelease, stopIosRelease } from './modules/ios.js';
import { appendLog, clearLog } from './modules/log.js';
import { refreshProcesses, stopProcesses } from './modules/processes.js';
import { createNewProjectDraft, deleteCurrentProject, renderProjects, saveProject } from './modules/projects.js';
import { elements, state } from './modules/state.js';
import { renderStores, saveStoreConfig } from './modules/stores.js';
import { applyTheme, bindThemeEvents } from './modules/theme.js';
import { bindActionButton, initSideNavIndicator, showToast } from './modules/ui.js';

/**
 * 刷新发布面板完整状态。
 *
 * 后端会同时返回 Android 包、iOS 包、本地数据库和商店配置。
 * 所有用户操作结束后都调用它，让页面与本地文件数据库保持一致。
 *
 * @returns {Promise<void>} 状态刷新完成。
 */
async function refreshStatus() {
  // 完整刷新会重绘所有区域，也会把 releaseNotes 文本框重置成数据库内容。
  // 因此打包中用 refreshBuildProgress 做轻量刷新，避免用户输入被覆盖。
  const status = await requestJson('/api/status');
  state.status = status;

  const { packageInfo } = status;
  const projectPath = document.createElement('span');
  projectPath.textContent = `项目路径：${status.projectRoot}`;
  elements.projectRoot.replaceChildren(projectPath);
  elements.versionText.textContent = `${packageInfo.versionName}+${packageInfo.versionCode}`;
  elements.versionDir.textContent = packageInfo.versionDir;
  elements.buildState.textContent = status.buildRunning ? '打包中' : '空闲';
  elements.iosBuildState.textContent = status.iosBuildRunning ? '发布中' : '空闲';
  elements.databasePath.textContent = status.database.path;
  elements.stopBuildButton.disabled = !status.buildRunning;
  elements.iosReleaseButton.disabled = status.iosBuildRunning;
  elements.stopIosReleaseButton.disabled = !status.iosBuildRunning;

  renderPackages(packageInfo);
  renderProjects(status.projects);
  renderQuickProjectSelector(status.projects, status.buildRunning || status.iosBuildRunning);
  renderBuildProgress(status.buildProgress);
  renderIosRelease(status.iosPackageInfo, status.iosReleaseProgress);
  renderStoreUploadProgress(status.storeUploadProgress);
  renderUploadRuns(status.database?.data?.uploadRuns || []);
  renderStores(status.storeConfig);
  elements.releaseNotes.value = status.releaseNotes || '';

  await refreshProcesses();
  await refreshInstallPreview();
}

/**
 * 渲染顶部项目快速切换器。
 *
 * 项目管理页负责完整编辑项目配置；顶部选择器只处理高频“切换当前项目后继续打包”
 * 这个动作。构建任务运行中会禁用切换，避免当前项目路径在构建过程中被改掉。
 *
 * @param {object} projectContext 后端返回的项目上下文。
 * @param {boolean} buildBusy Android 或 iOS 构建是否运行中。
 * @returns {void}
 */
function renderQuickProjectSelector(projectContext, buildBusy) {
  const selector = elements.quickProjectSelector;
  if (!selector || !projectContext?.projects) return;

  selector.innerHTML = '';
  projectContext.projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name ? `${project.name} (${project.id})` : project.id;
    option.selected = project.id === projectContext.activeProjectId;
    selector.appendChild(option);
  });

  selector.disabled = Boolean(buildBusy);
  selector.title = buildBusy ? '构建任务运行中，暂时不能切换项目。' : '切换当前发布项目';
}

/**
 * 切换当前项目并刷新发布状态。
 *
 * @param {string} projectId 目标项目 ID。
 * @returns {Promise<void>} 切换和刷新完成。
 */
async function switchActiveProject(projectId) {
  if (!projectId || projectId === state.status?.projects?.activeProjectId) return;
  await requestJson('/api/projects/active', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
  appendLog({ time: new Date().toISOString(), line: `已切换项目：${projectId}` });
  await refreshStatus();
  showToast('当前项目已切换', 'success');
}

/**
 * 保存全局更新日志。
 *
 * 安卓商店、iOS TestFlight 说明都可以选择复用这份文案。
 *
 * @returns {Promise<void>} 保存和状态刷新完成。
 */
async function saveNotes() {
  // 保存更新日志后做一次完整刷新，确保数据库快照和 textarea 一致。
  await requestJson('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ text: elements.releaseNotes.value }),
  });
  await refreshStatus();
}

/**
 * 执行 Android 商店上传预检。
 *
 * 预检只检查本地配置和文件是否齐全，不会调用应用宝外部接口。
 *
 * @returns {Promise<void>} 预检请求完成。
 */
async function uploadPrecheck() {
  const result = await requestJson('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ storeKey: state.activeStoreKey, action: 'precheck' }),
  });
  appendUploadResult(result);
  if (!result.ok) throw new Error(formatUploadFailure(result, '上传预检未通过'));
}

/**
 * 执行 Android 商店真实上传。
 *
 * 目前服务端只接了应用宝 SJQQ；点击后会申请 COS 预签名、上传文件并提交 update_app。
 * 这里保留浏览器确认，避免误触后直接把包提交到外部应用市场。
 *
 * @returns {Promise<void>} 上传接口调用完成。
 */
async function executeUpload() {
  const storeKey = state.activeStoreKey || 'sjqq';
  if (!window.confirm(`确认要执行 ${storeKey} 真实上传吗？`)) return;
  renderStoreUploadProgress({
    running: true,
    store: storeKey,
    percent: 1,
    statusText: '准备上传',
    detail: '正在初始化上传任务',
    elapsedText: '0秒',
  });
  state.status = {
    ...(state.status || {}),
    storeUploadProgress: { running: true, store: storeKey },
  };
  const result = await requestJson('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ storeKey, action: 'upload' }),
  });
  appendUploadResult(result);
  await refreshStoreUploadProgress();
  await refreshStatus();
  if (!result.ok) throw new Error(formatUploadFailure(result, '上传流程失败'));
}

/**
 * 终止当前应用市场上传任务。
 *
 * @returns {Promise<void>} 终止请求完成。
 */
async function stopStoreUpload() {
  const result = await requestJson('/api/upload/stop', { method: 'POST' });
  appendLog({ time: new Date().toISOString(), line: result.message || '已发送终止上传指令。' });
  await refreshStoreUploadProgress();
  if (!result.ok) throw new Error(result.message || '当前没有可终止的上传任务');
}

/**
 * 把上传失败结果整理成适合 toast 展示的短消息。
 *
 * 后端会返回 message、missing、warnings；按钮反馈如果只显示 message，
 * 用户就只能看到“预检未通过”这种总标题，不知道具体缺哪一项。
 *
 * @param {object} result /api/upload 返回结果。
 * @param {string} fallback 默认失败标题。
 * @returns {string} 带具体原因的错误消息。
 */
function formatUploadFailure(result, fallback) {
  const reasons = [
    ...(Array.isArray(result.missing) ? result.missing : []),
    ...(Array.isArray(result.warnings) ? result.warnings : []),
  ].filter(Boolean);
  if (reasons.length > 0) return `${result.message || fallback}：${reasons.join('；')}`;
  return result.message || fallback;
}

/**
 * 把上传接口返回的摘要写入构建日志窗口。
 *
 * @param {object} result /api/upload 返回结果。
 * @returns {void}
 */
function appendUploadResult(result) {
  appendLog({ time: new Date().toISOString(), line: result.message || '上传接口已返回。' });
  if (Array.isArray(result.missing) && result.missing.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `缺少配置或文件：${result.missing.join('、')}` });
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `上传预警：${result.warnings.join('、')}` });
  }
  if (Array.isArray(result.plannedFiles) && result.plannedFiles.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `计划上传文件：${result.plannedFiles.length} 个。` });
  }
  if (Array.isArray(result.uploadedFiles) && result.uploadedFiles.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `已上传文件：${result.uploadedFiles.length} 个。` });
  }
  if (Array.isArray(result.updateFields) && result.updateFields.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `提交字段：${result.updateFields.join(', ')}` });
  }
}

/**
 * 渲染应用市场上传进度。
 *
 * 这个进度是所有渠道共用的，不关心蒲公英、应用宝各自内部接口细节；
 * 服务端只返回“当前阶段、百分比、详情和耗时”，前端负责稳定展示。
 *
 * @param {object} progress 后端 storeUploadProgress。
 * @returns {void}
 */
function renderStoreUploadProgress(progress = {}) {
  if (!elements.storeUploadProgressTitle || !elements.storeUploadProgressBar) return;
  const percent = Number(progress?.percent || 0);
  const storeLabel = progress?.store ? `${progress.store} / ` : '';
  elements.storeUploadProgressTitle.textContent = `${storeLabel}${progress?.statusText || '空闲'} / ${percent}%`;
  elements.storeUploadProgressBar.style.width = `${percent}%`;
  elements.storeUploadElapsedText.textContent = `用时：${progress?.elapsedText || '0秒'}`;
  elements.storeUploadProgressDetail.textContent = progress?.detail || '等待执行上传';
  if (elements.stopUploadButton) elements.stopUploadButton.disabled = !progress?.running;
  if (elements.uploadExecuteButton) elements.uploadExecuteButton.disabled = Boolean(progress?.running);
}

/**
 * 渲染应用市场上传历史记录。
 *
 * 上传记录来自 release-db.json 的 uploadRuns，页面只展示执行摘要，不展示密钥。
 *
 * @param {object[]} runs 上传记录列表。
 * @returns {void}
 */
function renderUploadRuns(runs = []) {
  if (!elements.uploadRunsPanel) return;
  const recentRuns = runs.slice(0, 12);
  if (recentRuns.length === 0) {
    elements.uploadRunsPanel.innerHTML = '<div class="empty-state">暂无上传记录</div>';
    return;
  }

  const rows = recentRuns.map((run) => {
    const status = run.ok ? '成功' : '失败';
    const time = formatDateTime(run.finishedAt || run.startedAt);
    const files = Array.isArray(run.uploadedFiles) ? run.uploadedFiles.length : 0;
    const buildKey = run.buildKey ? `<code>${escapeHtml(run.buildKey)}</code>` : '-';
    return `
      <tr>
        <td>${escapeHtml(time)}</td>
        <td>${escapeHtml(run.store || '-')}</td>
        <td><span class="run-status ${run.ok ? 'ok' : 'fail'}">${status}</span></td>
        <td>${files}</td>
        <td>${buildKey}</td>
        <td>${escapeHtml(run.message || '-')}</td>
        <td>
          <button class="table-action danger" type="button" data-upload-run-delete="${escapeHtml(run.id || '')}">删除</button>
        </td>
      </tr>
    `;
  }).join('');

  elements.uploadRunsPanel.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>时间</th>
          <th>渠道</th>
          <th>状态</th>
          <th>文件</th>
          <th>buildKey</th>
          <th>结果</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  elements.uploadRunsPanel.querySelectorAll('[data-upload-run-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteUploadRun(button.dataset.uploadRunDelete));
  });
}

/**
 * 删除单条上传记录。
 *
 * @param {string} runId 上传记录 id。
 * @returns {Promise<void>} 删除和页面刷新完成。
 */
async function deleteUploadRun(runId) {
  if (!runId) return;
  if (!window.confirm('确认删除这条上传记录吗？')) return;
  const result = await requestJson('/api/upload-runs/delete', {
    method: 'POST',
    body: JSON.stringify({ id: runId }),
  });
  appendLog({ time: new Date().toISOString(), line: result.message || '上传记录已处理。' });
  if (!result.ok) {
    showToast(result.message || '上传记录删除失败', 'error');
    return;
  }
  renderUploadRuns(result.uploadRuns || []);
  showToast('上传记录已删除', 'success');
}

/**
 * 格式化本地时间。
 *
 * @param {string} value ISO 时间字符串。
 * @returns {string} 本地时间文案。
 */
function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 转义 HTML，避免上传记录里的接口消息影响页面结构。
 *
 * @param {unknown} value 原始值。
 * @returns {string} 安全文本。
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 轻量刷新应用市场上传进度。
 *
 * @returns {Promise<void>} 进度刷新完成。
 */
async function refreshStoreUploadProgress() {
  const status = await requestJson('/api/upload/progress');
  state.status = {
    ...(state.status || {}),
    storeUploadProgress: status.storeUploadProgress,
  };
  renderStoreUploadProgress(status.storeUploadProgress);
}

/**
 * 绑定页面按钮事件。
 *
 * @returns {void}
 */
function bindPageEvents() {
  bindThemeEvents();
  bindActionButton(elements.refreshButton, refreshStatus, {
    pending: '刷新中',
    success: '页面状态已刷新',
  });
  elements.quickProjectSelector?.addEventListener('change', () => {
    switchActiveProject(elements.quickProjectSelector.value).catch((error) => {
      appendLog({ time: new Date().toISOString(), line: error.message });
      showToast(error.message || '项目切换失败', 'error');
      renderQuickProjectSelector(state.status?.projects, state.status?.buildRunning || state.status?.iosBuildRunning);
    });
  });
  window.addEventListener('orp:project-switched', () => {
    // 项目管理页的下拉选择已经完成 /api/projects/active，这里只拉取最新状态并局部重绘。
    // 这样不会触发浏览器整页 reload，也不会断开侧边栏和当前页面路由状态。
    refreshStatus().catch((error) => {
      appendLog({ time: new Date().toISOString(), line: error.message });
      showToast(error.message || '项目状态刷新失败', 'error');
    });
  });
  bindActionButton(elements.newProjectButton, createNewProjectDraft, {
    success: '已创建项目草稿',
  });
  bindActionButton(elements.saveProjectButton, () => saveProject(refreshStatus), {
    pending: '保存中',
    success: '项目配置已保存',
  });
  bindActionButton(elements.deleteProjectButton, () => deleteCurrentProject(refreshStatus), {
    pending: '删除中',
    success: '项目配置已删除',
  });
  bindActionButton(elements.selectAllChannelsButton, toggleSelectAllChannels, {
    success: '渠道选择已更新',
  });
  bindActionButton(elements.refreshPackagesButton, refreshStatus, {
    pending: '扫描中',
    success: 'Android 包状态已刷新',
  });
  bindActionButton(elements.buildButton, () => startBuild(refreshStatus), {
    pending: '启动中',
    success: '打包任务已启动',
  });
  bindActionButton(elements.stopBuildButton, () => stopBuild(refreshStatus), {
    pending: '终止中',
    success: '已发送终止打包指令',
  });
  bindActionButton(elements.deletePackagesButton, () => deleteSelectedPackages(refreshStatus), {
    pending: '删除中',
    success: '选中渠道包已处理',
  });
  bindActionButton(elements.refreshProcessesButton, refreshProcesses, {
    pending: '刷新中',
    success: '后台进程已刷新',
  });
  bindActionButton(elements.refreshInstallPreviewButton, refreshInstallPreview, {
    pending: '刷新中',
    success: '安装包预览已刷新',
  });
  bindActionButton(elements.stopProcessesButton, () => stopProcesses(refreshBuildProgress), {
    pending: '停止中',
    success: '已发送停止后台构建指令',
  });
  bindActionButton(elements.saveNotesButton, saveNotes, {
    pending: '保存中',
    success: '更新日志已保存',
  });
  bindActionButton(elements.saveStoreConfigButton, () => saveStoreConfig(refreshStatus), {
    pending: '保存中',
    success: '上传配置已保存',
  });
  bindActionButton(elements.saveIosConfigButton, () => saveIosConfig(refreshStatus), {
    pending: '保存中',
    success: 'iOS 配置已保存',
  });
  bindActionButton(elements.iosReleaseButton, () => startIosRelease(refreshStatus), {
    pending: '执行中',
    success: 'iOS 发布任务已启动',
  });
  bindActionButton(elements.stopIosReleaseButton, stopIosRelease, {
    pending: '停止中',
    success: '已发送停止 iOS 发布指令',
  });
  bindActionButton(elements.uploadButton, uploadPrecheck, {
    pending: '预检中',
    success: '上传预检已完成',
  });
  bindActionButton(elements.uploadExecuteButton, executeUpload, {
    pending: '上传中',
    success: '上传流程已结束',
  });
  bindActionButton(elements.stopUploadButton, stopStoreUpload, {
    pending: '终止中',
    success: '已发送终止上传指令',
  });
  bindActionButton(elements.clearLogButton, () => {
    clearLog();
    showToast('当前页面日志已清空', 'success');
  });
}

/**
 * 连接 Android 构建日志 SSE。
 *
 * EventSource 会保持长连接，服务端每产生一行 Android 构建日志就推到页面。
 *
 * @returns {void}
 */
function connectAndroidBuildEvents() {
  const events = new EventSource('/api/build/events');
  events.onmessage = (event) => {
    // 收到结束日志后做完整刷新，重新扫描 APK 文件并记录最终状态。
    appendLog(JSON.parse(event.data));
    if (event.data.includes('打包任务结束')) refreshStatus();
  };
}

/**
 * 连接 iOS 发布日志 SSE。
 *
 * iOS 构建和 App Store Connect 上传都走这条流，前端统一追加到构建日志窗口。
 *
 * @returns {void}
 */
function connectIosReleaseEvents() {
  const iosEvents = new EventSource('/api/ios-release/events');
  iosEvents.onmessage = (event) => {
    // iOS 的 SSE 和 Android 分开，但最终仍写入同一个日志窗口，方便发布时按时间线查看。
    const entry = JSON.parse(event.data);
    appendLog({ ...entry, line: `[iOS] ${entry.line}` });
    if (entry.line.includes('iOS 打包结束') || entry.line.includes('App Store Connect 上传结束')) {
      refreshStatus();
    }
  };
}

/**
 * 启动发布任务轮询器。
 *
 * Android/iOS 发布进行中每秒轻量刷新一次状态，用来更新总用时、阶段和当前百分比。
 *
 * @returns {void}
 */
function startBuildPolling() {
  setInterval(() => {
    // 运行中才轮询。空闲状态不请求进度接口，减少本机服务无意义的 IO。
    if (state.status?.buildRunning) {
      refreshBuildProgress().catch(() => {});
      refreshProcesses().catch(() => {});
    }
    if (state.status?.iosBuildRunning) {
      refreshIosReleaseProgress().catch(() => {});
      refreshProcesses().catch(() => {});
    }
    if (state.status?.storeUploadProgress?.running) {
      refreshStoreUploadProgress().catch(() => {});
    }
  }, 1000);
}

bindPageEvents();
initSideNavIndicator();
connectAndroidBuildEvents();
connectIosReleaseEvents();
startBuildPolling();
applyTheme();

// 页面首次加载时拉取后端状态。失败也写进日志窗口，方便启动服务或端口异常时排查。
refreshStatus().catch((error) => appendLog({ time: new Date().toISOString(), line: error.message }));
