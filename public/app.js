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
  renderStores(status.storeConfig, { refreshStatus });
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
  const storeLabel = getActiveStoreLabel();
  // 预检前先保存当前 tab 表单，避免用户刚改完 vivo/OPPO 配置但未点保存时，
  // 服务端仍按旧的本地数据库执行预检。
  await saveStoreConfig(refreshStatus);
  const result = await requestJson('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ storeKey: state.activeStoreKey, action: 'precheck' }),
  });
  appendUploadResult(result);
  if (!result.ok) throw new Error(formatUploadFailure(result, `${storeLabel} 上传预检未通过`));
}

/**
 * 执行当前选中的 Android 商店真实上传。
 *
 * 当前平台由应用市场配置区域的 tab 决定。这里保留浏览器确认，
 * 避免误触后直接把包提交到外部应用市场。
 *
 * @returns {Promise<void>} 上传接口调用完成。
 */
async function executeUpload() {
  const storeKey = state.activeStoreKey || 'sjqq';
  const storeLabel = getActiveStoreLabel(storeKey);
  if (!window.confirm(`确认要执行 ${storeLabel} 真实上传吗？`)) return;
  // 顶部“执行上传”是当前 tab 的主操作入口，必须先落盘当前表单；
  // 否则 vivo 这类依赖 access_key、versionCode、APK 路径的接口会拿到旧配置。
  await saveStoreConfig(refreshStatus);
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
  if (!result.ok) throw new Error(formatUploadFailure(result, `${storeLabel} 上传流程失败`));
}

/**
 * 顺序上传所有已启用并已接入自动上传服务的平台。
 *
 * 服务端会按当前项目保存的 enabled 配置筛选平台；未接入自动上传的平台只会被跳过。
 * 批量上传仍然复用同一个终止按钮，用户中途停止时服务端会中断后续平台。
 *
 * @returns {Promise<void>} 批量上传完成。
 */
async function executeAllUploads() {
  if (!window.confirm('确认要上传所有已启用且已接入自动上传的平台吗？')) return;
  renderStoreUploadProgress({
    running: true,
    store: '全部平台',
    percent: 1,
    statusText: '准备上传全部平台',
    detail: '正在初始化批量上传任务',
    elapsedText: '0秒',
  });
  state.status = {
    ...(state.status || {}),
    storeUploadProgress: { running: true, store: '全部平台', action: 'upload-all' },
  };
  const result = await requestJson('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ action: 'upload-all' }),
  });
  appendUploadResult(result);
  await refreshStoreUploadProgress();
  await refreshStatus();
  if (!result.ok) throw new Error(formatUploadFailure(result, '批量上传存在失败'));
}

/**
 * 顺序撤销所有已启用并已接入自动服务的平台审核。
 *
 * 撤销审核是高风险操作，因此入口只提供批量危险按钮；每个平台内部是否真的支持
 * 自动撤销由对应 uploader 返回明确结果，不支持的平台会写入失败原因和上传记录。
 *
 * @returns {Promise<boolean|void>} false 表示用户取消；否则批量撤销完成。
 */
async function executeAllRevokes() {
  if (!window.confirm('确认要撤销所有已启用平台的当前审核吗？该操作可能影响正在审核的版本。')) return false;
  renderStoreUploadProgress({
    running: true,
    store: '全部平台',
    action: 'revoke-all',
    percent: 1,
    statusText: '准备撤销审核',
    detail: '正在初始化批量撤销任务',
    elapsedText: '0秒',
  });
  state.status = {
    ...(state.status || {}),
    storeUploadProgress: { running: true, store: '全部平台', action: 'revoke-all' },
  };
  const result = await requestJson('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ action: 'revoke-all' }),
  });
  appendUploadResult(result);
  await refreshStoreUploadProgress();
  await refreshStatus();
  if (!result.ok) throw new Error(formatUploadFailure(result, '批量撤销审核存在失败或不支持的平台'));
  return true;
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
  if (Array.isArray(result.results) && result.results.length > 0) {
    appendLog({
      time: new Date().toISOString(),
      line: `平台结果：${result.results.map((item) => `${item.storeName || item.store}:${item.ok ? '成功' : '失败'}`).join('、')}`,
    });
  }
  if (Array.isArray(result.skipped) && result.skipped.length > 0) {
    appendLog({
      time: new Date().toISOString(),
      line: `已跳过平台：${result.skipped.map((item) => item.name || item.store).join('、')}`,
    });
  }
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
  if (result.taskState) {
    appendLog({ time: new Date().toISOString(), line: `任务状态：${formatGenericTaskState(result.taskState, result.taskStateLabel)}` });
  }
  if (Array.isArray(result.steps) && result.steps.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `执行步骤：${result.steps.map((step) => `${step.action}:${step.ok ? '成功' : '失败'}`).join(' -> ')}` });
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
  if (elements.uploadAllButton) elements.uploadAllButton.disabled = Boolean(progress?.running);
  if (elements.revokeAllButton) elements.revokeAllButton.disabled = Boolean(progress?.running);
}

/**
 * 获取当前上传配置 tab 的平台名称。
 *
 * @param {string} [storeKey=state.activeStoreKey] 平台 key。
 * @returns {string} 用户可读平台名称。
 */
function getActiveStoreLabel(storeKey = state.activeStoreKey) {
  const platforms = state.status?.storeConfig?.platforms || [];
  const platform = platforms.find((item) => item.key === storeKey);
  return platform?.name || storeKey || '当前平台';
}

const UPLOAD_RUNS_PAGE_SIZE = 10;

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
  state.uploadRuns = runs;
  renderUploadRunFilterOptions(runs);

  const filteredRuns = filterUploadRuns(runs);
  if (runs.length === 0) {
    state.uploadRunsPage = 1;
    elements.uploadRunsPanel.innerHTML = '<div class="empty-state">暂无上传记录</div>';
    return;
  }
  if (filteredRuns.length === 0) {
    state.uploadRunsPage = 1;
    elements.uploadRunsPanel.innerHTML = '<div class="empty-state">没有匹配的上传记录</div>';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / UPLOAD_RUNS_PAGE_SIZE));
  state.uploadRunsPage = Math.min(Math.max(Number(state.uploadRunsPage || 1), 1), totalPages);
  const startIndex = (state.uploadRunsPage - 1) * UPLOAD_RUNS_PAGE_SIZE;
  const pageRuns = filteredRuns.slice(startIndex, startIndex + UPLOAD_RUNS_PAGE_SIZE);

  const rows = pageRuns.map((run) => {
    const status = run.ok ? '成功' : '失败';
    const time = formatDateTime(run.finishedAt || run.startedAt);
    const files = Array.isArray(run.uploadedFiles) ? run.uploadedFiles.length : 0;
    const buildKey = run.buildKey ? `<code>${escapeHtml(run.buildKey)}</code>` : '-';
    const action = getUploadRunActionLabel(run);
    const resultMessage = normalizeUploadRunText(formatUploadRunResult(run));
    return `
      <tr>
        <td class="run-time">${escapeHtml(time)}</td>
        <td class="run-store">${escapeHtml(run.store || '-')}</td>
        <td class="run-action">${escapeHtml(action)}</td>
        <td class="run-status-cell"><span class="run-status ${run.ok ? 'ok' : 'fail'}">${status}</span></td>
        <td class="run-files">${files}</td>
        <td class="run-build-key">${buildKey}</td>
        <td class="run-result" title="${escapeHtml(resultMessage || '-')}">${escapeHtml(resultMessage || '-')}</td>
        <td class="run-operate">
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
          <th>动作</th>
          <th>状态</th>
          <th>文件</th>
          <th>buildKey</th>
          <th>结果</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="upload-runs-pagination">
      <span>第 ${state.uploadRunsPage} / ${totalPages} 页，共 ${filteredRuns.length} / ${runs.length} 条</span>
      <div class="button-row">
        <button class="table-action" type="button" data-upload-runs-prev ${state.uploadRunsPage <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="table-action" type="button" data-upload-runs-next ${state.uploadRunsPage >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    </div>
  `;
  elements.uploadRunsPanel.querySelectorAll('[data-upload-run-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteUploadRun(button.dataset.uploadRunDelete));
  });
  elements.uploadRunsPanel.querySelector('[data-upload-runs-prev]')?.addEventListener('click', () => {
    state.uploadRunsPage = Math.max(1, state.uploadRunsPage - 1);
    renderUploadRuns(runs);
  });
  elements.uploadRunsPanel.querySelector('[data-upload-runs-next]')?.addEventListener('click', () => {
    state.uploadRunsPage = Math.min(totalPages, state.uploadRunsPage + 1);
    renderUploadRuns(runs);
  });
}

/**
 * 整理上传记录的结果展示文案。
 *
 * 老记录可能只保存了“查询完成”，但同时带有 auditResult 结构；
 * 这里把审核状态补到结果列，避免用户打开上传记录时看不到实际审核结果。
 *
 * @param {object} run 上传记录。
 * @returns {string} 结果列文案。
 */
function formatUploadRunResult(run) {
  const message = run.message || '';
  if (run.taskState) {
    const taskState = typeof run.taskState === 'object' && run.taskState !== null ? run.taskState : { task_state: run.taskState };
    const parts = [message].filter(Boolean);
    const taskParts = [run.taskStateLabel || (taskState.task_state === undefined && taskState.status === undefined ? '未返回任务状态' : `状态码 ${taskState.task_state ?? taskState.status}`)];
    if (taskState.version_code) taskParts.push(`version_code: ${taskState.version_code}`);
    if (taskState.err_msg) taskParts.push(`错误原因: ${taskState.err_msg}`);
    if (taskState.packageName) taskParts.push(`包名: ${taskState.packageName}`);
    if (taskState.errorReason) taskParts.push(`错误原因: ${taskState.errorReason}`);
    parts.push(taskParts.join('，'));
    return parts.join(' / ');
  }
  if (!run.auditResult) return message;
  const auditResult = typeof run.auditResult === 'object' && run.auditResult !== null ? run.auditResult : { auditResult: run.auditResult };
  const parts = [message].filter(Boolean);
  const auditParts = [run.auditResultLabel || (auditResult.auditResult === undefined ? '未返回审核状态' : `状态码 ${auditResult.auditResult}`)];
  if (auditResult.releaseId) auditParts.push(`releaseId: ${auditResult.releaseId}`);
  if (auditResult.versionName) auditParts.push(`版本: ${auditResult.versionName}${auditResult.versionCode ? `(${auditResult.versionCode})` : ''}`);
  if (auditResult.auditMessage) auditParts.push(`审核意见: ${auditResult.auditMessage}`);
  parts.push(auditParts.join('，'));
  return parts.join(' / ');
}

/**
 * 把上传记录里的接口消息规整成适合表格展示的纯文本。
 *
 * 某些平台会把后台审核报告链接以 HTML 片段返回。表格里直接展示这段文本会
 * 撑宽列宽，也影响搜索体验；这里只提取可读内容和链接地址。
 *
 * @param {string} value 原始结果文本。
 * @returns {string} 规整后的纯文本。
 */
function normalizeUploadRunText(value) {
  return String(value || '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_, href, text) => `${stripHtml(text)}：${href}`)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 去掉 HTML 标签，仅保留文本内容。
 *
 * @param {string} value 原始 HTML 片段。
 * @returns {string} 文本内容。
 */
function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, '').trim();
}

/**
 * 把不同平台的任务状态对象整理成日志文本。
 *
 * OPPO 使用 task_state/err_msg，vivo 使用 status/errorReason。这里做一个通用
 * 兼容，避免每个平台的 appendUploadResult 都写一份日志格式化逻辑。
 *
 * @param {object} taskState 任务状态对象。
 * @param {string} taskStateLabel 后端转换后的状态文案。
 * @returns {string} 可读任务状态。
 */
function formatGenericTaskState(taskState = {}, taskStateLabel = '') {
  const result = typeof taskState === 'object' && taskState !== null ? taskState : { task_state: taskState };
  const rawStatus = result.task_state ?? result.status;
  const parts = [taskStateLabel || (rawStatus === undefined ? '未返回任务状态' : `状态码 ${rawStatus}`)];
  if (result.version_code) parts.push(`version_code: ${result.version_code}`);
  if (result.packageName) parts.push(`包名: ${result.packageName}`);
  if (result.err_msg) parts.push(`错误原因: ${result.err_msg}`);
  if (result.errorReason) parts.push(`错误原因: ${result.errorReason}`);
  return parts.join('，');
}

/**
 * 渲染上传记录筛选下拉选项。
 *
 * 渠道和动作来自当前数据库记录，刷新状态后会自动补齐新平台或新动作；
 * 当前已选值如果仍然存在就保留，避免用户筛选时页面刷新后条件丢失。
 *
 * @param {object[]} runs 上传记录列表。
 * @returns {void}
 */
function renderUploadRunFilterOptions(runs) {
  renderSelectOptions(elements.uploadRunsStoreFilter, getUniqueUploadRunValues(runs, (run) => run.store), '全部渠道', state.uploadRunsStoreFilter);
  renderSelectOptions(elements.uploadRunsActionFilter, getUniqueUploadRunValues(runs, getUploadRunActionLabel), '全部动作', state.uploadRunsActionFilter);
  if (elements.uploadRunsStatusFilter) elements.uploadRunsStatusFilter.value = state.uploadRunsStatusFilter || '';
  if (elements.uploadRunsSearch && elements.uploadRunsSearch.value !== state.uploadRunsQuery) {
    elements.uploadRunsSearch.value = state.uploadRunsQuery || '';
  }
}

/**
 * 重绘一个筛选 select 的选项。
 *
 * @param {HTMLSelectElement|null} select 下拉框。
 * @param {string[]} values 选项值。
 * @param {string} emptyLabel 空值文案。
 * @param {string} selectedValue 当前选中值。
 * @returns {void}
 */
function renderSelectOptions(select, values, emptyLabel, selectedValue) {
  if (!select) return;
  const current = selectedValue || '';
  select.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = emptyLabel;
  select.appendChild(empty);
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = value === current;
    select.appendChild(option);
  });
  select.value = values.includes(current) ? current : '';
  if (select === elements.uploadRunsStoreFilter) state.uploadRunsStoreFilter = select.value;
  if (select === elements.uploadRunsActionFilter) state.uploadRunsActionFilter = select.value;
}

/**
 * 读取上传记录某一维度的去重值。
 *
 * @param {object[]} runs 上传记录列表。
 * @param {(run: object) => unknown} getter 取值函数。
 * @returns {string[]} 排序后的选项。
 */
function getUniqueUploadRunValues(runs, getter) {
  return [...new Set(runs.map((run) => String(getter(run) || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 根据当前搜索和筛选条件过滤上传记录。
 *
 * 搜索会覆盖记录里用于排查的所有摘要字段：id、渠道、动作、状态、时间、消息、
 * buildKey、上传文件、提交字段、warnings、queryPackage、localApk、平台响应摘要等。
 *
 * @param {object[]} runs 上传记录列表。
 * @returns {object[]} 过滤后的记录。
 */
function filterUploadRuns(runs) {
  const query = String(state.uploadRunsQuery || '').trim().toLowerCase();
  const store = String(state.uploadRunsStoreFilter || '').trim();
  const action = String(state.uploadRunsActionFilter || '').trim();
  const status = String(state.uploadRunsStatusFilter || '').trim();
  return runs.filter((run) => {
    if (store && String(run.store || '') !== store) return false;
    if (action && getUploadRunActionLabel(run) !== action) return false;
    if (status === 'ok' && !run.ok) return false;
    if (status === 'fail' && run.ok) return false;
    if (!query) return true;
    return buildUploadRunSearchText(run).includes(query);
  });
}

/**
 * 构建单条上传记录的搜索文本。
 *
 * @param {object} run 上传记录。
 * @returns {string} 小写搜索文本。
 */
function buildUploadRunSearchText(run) {
  const derived = {
    statusText: run.ok ? '成功 ok success' : '失败 fail error',
    actionText: getUploadRunActionLabel(run),
    startedAtText: formatDateTime(run.startedAt),
    finishedAtText: formatDateTime(run.finishedAt),
  };
  return collectSearchValues({ ...run, ...derived }).join(' ').toLowerCase();
}

/**
 * 递归收集对象里的可搜索文本。
 *
 * @param {unknown} value 任意值。
 * @returns {string[]} 文本数组。
 */
function collectSearchValues(value) {
  if (value === undefined || value === null) return [];
  if (['string', 'number', 'boolean'].includes(typeof value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectSearchValues);
  if (typeof value === 'object') return Object.values(value).flatMap(collectSearchValues);
  return [];
}

/**
 * 把上传历史中的 action 转成可读文案。
 *
 * 撤销审核和上传共用 uploadRuns 表；加上动作列后，用户可以区分
 * “上传失败”和“撤销审核不支持/失败”，排查发布事故时更直接。
 *
 * @param {object} run 上传历史记录。
 * @returns {string} 动作文案。
 */
function getUploadRunActionLabel(run) {
  if (run.actionLabel) return run.actionLabel;
  const labels = {
    upload: '上传发布',
    'upload-all': '一键上传',
    precheck: '预检',
    status: '状态查询',
    'revoke-review': '撤销审核',
    'revoke-all': '一键撤销',
    'submit-review': '提交审核',
    'token-check': 'Token 校验',
    'upload-package': '上传包体',
    'upload-apk': '上传 APK',
    'update-package-info': '更新包信息',
    'query-package-info': '查询包信息',
    'query-package': '查询应用',
    'query-categories': '查询分类',
    'query-app-info': '查询应用详情',
    'submit-update': '提交更新',
    'query-task': '查询任务',
  };
  return labels[run.action] || run.action || '-';
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
    success: '当前平台上传已结束',
  });
  bindActionButton(elements.uploadAllButton, executeAllUploads, {
    pending: '批量上传中',
    success: '批量上传流程已结束',
  });
  bindActionButton(elements.revokeAllButton, executeAllRevokes, {
    pending: '撤销中',
    success: '批量撤销流程已结束',
  });
  bindActionButton(elements.stopUploadButton, stopStoreUpload, {
    pending: '终止中',
    success: '已发送终止上传指令',
  });
  bindActionButton(elements.clearLogButton, () => {
    clearLog();
    showToast('当前页面日志已清空', 'success');
  });
  bindUploadRunFilterEvents();
}

/**
 * 绑定上传记录筛选控件。
 *
 * 筛选只影响前端表格，不修改 release-db.json；输入搜索词或切换筛选项时回到第一页。
 *
 * @returns {void}
 */
function bindUploadRunFilterEvents() {
  elements.uploadRunsSearch?.addEventListener('input', () => {
    state.uploadRunsQuery = elements.uploadRunsSearch.value;
    state.uploadRunsPage = 1;
    renderUploadRuns(state.uploadRuns || []);
  });
  elements.uploadRunsStoreFilter?.addEventListener('change', () => {
    state.uploadRunsStoreFilter = elements.uploadRunsStoreFilter.value;
    state.uploadRunsPage = 1;
    renderUploadRuns(state.uploadRuns || []);
  });
  elements.uploadRunsActionFilter?.addEventListener('change', () => {
    state.uploadRunsActionFilter = elements.uploadRunsActionFilter.value;
    state.uploadRunsPage = 1;
    renderUploadRuns(state.uploadRuns || []);
  });
  elements.uploadRunsStatusFilter?.addEventListener('change', () => {
    state.uploadRunsStatusFilter = elements.uploadRunsStatusFilter.value;
    state.uploadRunsPage = 1;
    renderUploadRuns(state.uploadRuns || []);
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
