import { requestJson } from './api.js';
import { appendLog } from './log.js';
import { elements } from './state.js';
import { formatDate } from './utils.js';

/**
 * 渲染发布台相关后台进程列表。
 *
 * 这里展示的是后端限定后的进程列表，只包含当前发布脚本和同进程组里的构建子进程，
 * 避免误导用户去停其它项目。
 *
 * @param {object} snapshot 后端 /api/processes 返回的进程快照。
 * @returns {void}
 */
export function renderProcesses(snapshot) {
  // 进程列表来自后端过滤后的结果。前端不做 ps 命令、不直接 kill PID，
  // 这样权限和安全边界都集中在 server.js 中维护。
  elements.processPanel.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'process-summary';
  header.textContent = `${snapshot.count || 0} 个发布构建进程 / ${snapshot.checkedAt ? formatDate(snapshot.checkedAt) : '-'}`;
  elements.processPanel.appendChild(header);

  if (!snapshot.processes?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '没有发现发布台相关的后台打包进程。';
    elements.processPanel.appendChild(empty);
    return;
  }

  snapshot.processes.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'process-row';
    const meta = document.createElement('div');
    meta.className = 'process-meta';
    meta.textContent = `PID ${item.pid} / PGID ${item.pgid} / ${item.kind === 'script' ? '脚本' : '子进程'}`;
    const command = document.createElement('div');
    command.className = 'process-command';
    command.textContent = item.command;
    row.append(meta, command);
    elements.processPanel.appendChild(row);
  });
}

/**
 * 刷新后台进程列表。
 *
 * 它不会触碰表单内容，适合用户打包中随时查看残留进程。
 *
 * @returns {Promise<object>} 后端返回的进程快照。
 */
export async function refreshProcesses() {
  // 后台进程查询可能比普通 UI 刷新慢一点，所以保持独立函数。
  // 用户点击“刷新进程”时不会影响渠道包、更新日志或配置表单。
  const snapshot = await requestJson('/api/processes');
  renderProcesses(snapshot);
  return snapshot;
}

/**
 * 停止发布台相关后台构建进程组。
 *
 * @param {Function} refreshBuildProgress Android 构建进度刷新函数。
 * @returns {Promise<void>} 停止请求和界面刷新完成。
 */
export async function stopProcesses(refreshBuildProgress) {
  // 停止后立即刷新进程和进度。进程收到 SIGTERM 后可能需要几秒退出，
  // 所以用户可以继续点“刷新进程”确认是否还有残留。
  const result = await requestJson('/api/processes/stop', { method: 'POST', body: '{}' });
  appendLog({ time: new Date().toISOString(), line: result.message });
  await refreshProcesses();
  await refreshBuildProgress();
}
