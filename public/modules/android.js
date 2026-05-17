import { requestJson } from './api.js';
import { appendLog } from './log.js';
import { elements, state } from './state.js';
import { formatDate } from './utils.js';

/**
 * 渲染 Android 渠道包列表。
 *
 * 这里展示的是脚本已经输出到桌面目录的 APK 状态，不直接代表“商店上传状态”。
 * 上传状态后续应从 uploadRuns 或真实发布接口结果里单独读取。
 *
 * @param {object} packageInfo 后端 /api/status 返回的 packageInfo。
 * @returns {void}
 */
export function renderPackages(packageInfo) {
  if (!packageInfo?.packages) return;
  // 每次刷新包列表时保留渠道勾选状态。勾选不再只代表删除，
  // 它是“本次要操作的渠道集合”：开始打包只打这些渠道，删除只删这些渠道里已存在的 APK。
  elements.packageList.innerHTML = '';
  packageInfo.packages.forEach((item) => {
    const channelProgress = state.status?.buildProgress?.channels?.[item.code];

    const row = document.createElement('div');
    row.className = `package-row ${channelProgress?.status === 'building' ? 'building' : ''}`;

    const selector = document.createElement('label');
    selector.className = 'package-selector';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedChannelCodes.has(item.code);
    checkbox.addEventListener('change', () => {
      // 这里只记录渠道 code。打包由后端校验渠道是否合法，删除由后端重新计算 APK 路径。
      if (checkbox.checked) state.selectedChannelCodes.add(item.code);
      else state.selectedChannelCodes.delete(item.code);
      updateChannelActionButtons();
    });
    selector.appendChild(checkbox);

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = `${item.name} (${item.code})`;

    const badge = document.createElement('div');
    const status = channelProgress?.status || 'idle';
    badge.className = `badge ${status === 'building' ? 'building' : item.apk ? 'ok' : 'missing'}`;
    badge.textContent = getChannelStatusText(status, item.apk);

    const detail = document.createElement('div');
    detail.className = 'apk-path';
    detail.textContent = getChannelDetailText(packageInfo, item, channelProgress);

    row.append(selector, name, badge, detail);
    elements.packageList.appendChild(row);
  });
  updateChannelActionButtons();
}

/**
 * 获取渠道行展示的状态文本。
 *
 * @param {string} status 后端维护的单渠道构建状态。
 * @param {object|null} apk 当前渠道 APK 信息。
 * @returns {string} 展示在状态徽标里的中文文本。
 */
function getChannelStatusText(status, apk) {
  if (status === 'building') return '打包中';
  if (status === 'pending') return '等待中';
  if (status === 'done') return '已完成';
  if (status === 'skipped') return '已跳过';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已终止';
  return apk ? '已存在' : '未输出';
}

/**
 * 获取渠道行右侧详情文本。
 *
 * @param {object} packageInfo 当前版本包扫描信息。
 * @param {object} item 当前渠道包信息。
 * @param {object|undefined} channelProgress 当前渠道构建进度。
 * @returns {string} 渠道包路径、构建耗时或进度详情。
 */
function getChannelDetailText(packageInfo, item, channelProgress) {
  if (channelProgress?.status === 'building') {
    return `用时 ${channelProgress.elapsedText || '0秒'} / ${channelProgress.percent || 0}%`;
  }
  if (['done', 'skipped', 'failed', 'stopped'].includes(channelProgress?.status)) {
    return `用时 ${channelProgress.elapsedText || '0秒'} / ${item.apk?.path || `${packageInfo.versionDir}/${item.dir}`}`;
  }
  return item.apk
    ? `${item.apk.sizeText} / ${formatDate(item.apk.updatedAt)} / ${item.apk.path}`
    : `${packageInfo.versionDir}/${item.dir}`;
}

/**
 * 根据当前渠道勾选状态更新操作按钮可用状态。
 *
 * @returns {void}
 */
function updateChannelActionButtons() {
  // 打包按钮需要至少选择一个渠道；删除按钮还要求选中的渠道里存在 APK。
  const selectedCount = state.selectedChannelCodes.size;
  const packages = state.status?.packageInfo?.packages || [];
  const selectedExistingCount = packages.filter((item) => item.apk && state.selectedChannelCodes.has(item.code)).length;
  elements.buildButton.disabled = Boolean(state.status?.buildRunning) || selectedCount === 0;
  elements.deletePackagesButton.disabled = selectedExistingCount === 0;
  elements.selectAllChannelsButton.textContent = selectedCount === packages.length ? '取消全选' : '全选渠道';
}

/**
 * 渲染 Android 总构建进度。
 *
 * 百分比来自“已完成/已跳过渠道数”，当前渠道由脚本输出的 release-panel 标记驱动，
 * 因此能显示正在打哪个渠道。
 *
 * @param {object} progress 后端 /api/build/progress 返回的 buildProgress。
 * @returns {void}
 */
export function renderBuildProgress(progress) {
  // 这里展示的是渠道级进度，不是 Flutter/Gradle 内部编译进度。
  // 如果未来脚本输出更细粒度标记，可以在不改 UI 结构的情况下扩展 progress 字段。
  const percent = Number(progress?.percent || 0);
  const total = Number(progress?.total || 0);
  const completed = Number(progress?.completed || 0);
  const skipped = Number(progress?.skipped || 0);
  const currentIndex = Number(progress?.currentIndex || 0);
  const current = progress?.currentChannel || '-';

  elements.buildProgressTitle.textContent = `${progress?.statusText || '空闲'} / ${percent}%`;
  elements.buildProgressBar.style.width = `${percent}%`;
  elements.buildElapsedText.textContent = `用时：${progress?.elapsedText || '0秒'}`;
  elements.buildProgressDetail.textContent = total > 0
    ? `当前渠道：${currentIndex ? `第 ${currentIndex}/${total} 个，` : ''}${current}；完成 ${completed} 个，跳过 ${skipped} 个。`
    : '等待开始打包';
}

/**
 * 轻量刷新 Android 构建进度。
 *
 * 打包期间高频调用这个接口，避免整页 refreshStatus 覆盖用户正在编辑的更新日志、
 * 商店配置或 iOS 配置。
 *
 * @returns {Promise<void>} 进度刷新完成。
 */
export async function refreshBuildProgress() {
  const status = await requestJson('/api/build/progress');
  state.status = {
    ...(state.status || {}),
    buildRunning: status.buildRunning,
    buildProgress: status.buildProgress,
  };
  elements.buildState.textContent = status.buildRunning ? '打包中' : '空闲';
  elements.stopBuildButton.disabled = !status.buildRunning;
  renderBuildProgress(status.buildProgress);
  renderPackages(state.status.packageInfo);
}

/**
 * 按当前勾选渠道启动 Android 构建。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 启动请求和状态刷新完成。
 */
export async function startBuild(refreshStatus) {
  // 开始打包后立即刷新完整状态，让按钮禁用、进度条和后台进程列表同步更新。
  const channels = [...state.selectedChannelCodes];
  const result = await requestJson('/api/build', {
    method: 'POST',
    body: JSON.stringify({ channels }),
  });
  appendLog({ time: new Date().toISOString(), line: result.message });
  await refreshStatus();
}

/**
 * 停止当前 Android 构建任务。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 停止请求和状态刷新完成。
 */
export async function stopBuild(refreshStatus) {
  // 这个按钮只停止当前服务记录的 activeBuild。
  // 如果用户手动在终端启动了脚本，应使用“后台进程”里的停止发布构建。
  const result = await requestJson('/api/build/stop', { method: 'POST', body: '{}' });
  appendLog({ time: new Date().toISOString(), line: result.message });
  await refreshStatus();
}

/**
 * 删除当前勾选渠道中已存在的 APK。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 删除请求和状态刷新完成。
 */
export async function deleteSelectedPackages(refreshStatus) {
  const channels = [...state.selectedChannelCodes];
  if (channels.length === 0) return;
  const confirmed = window.confirm(`确定删除 ${channels.length} 个已存在的渠道包吗？删除后这些渠道下次打包会重新构建。`);
  if (!confirmed) return;

  // 只提交渠道 code。服务端会根据当前 versionName/versionCode 和 CHANNELS 列表计算文件路径，
  // 前端不把本地文件路径作为删除依据。
  const result = await requestJson('/api/packages/delete', {
    method: 'POST',
    body: JSON.stringify({ channels }),
  });
  appendLog({ time: new Date().toISOString(), line: result.message });
  await refreshStatus();
}

/**
 * 切换渠道全选状态。
 *
 * @returns {void}
 */
export function toggleSelectAllChannels() {
  const packages = state.status?.packageInfo?.packages || [];
  if (state.selectedChannelCodes.size === packages.length) {
    state.selectedChannelCodes.clear();
  } else {
    packages.forEach((item) => state.selectedChannelCodes.add(item.code));
  }
  renderPackages(state.status.packageInfo);
}
