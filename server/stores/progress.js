const runtime = require("../state");

runtime.storeUploadProgress = createIdleStoreUploadProgress();

/**
 * 创建空闲态的应用市场上传进度。
 *
 * 这个进度只保存在当前 Node 进程内，用于前端实时查看“正在上传哪个渠道、
 * 上传到哪一步、用了多久”。上传历史仍然由各 uploader 写入 release-db.json。
 *
 * @returns {object} 上传进度对象。
 */
function createIdleStoreUploadProgress() {
  return {
    running: false,
    store: "",
    action: "",
    phase: "idle",
    percent: 0,
    statusText: "空闲",
    detail: "等待执行上传",
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    elapsedText: "0秒",
    ok: null,
    stopping: false,
  };
}

/**
 * 读取当前上传进度，并派生耗时文本。
 *
 * @returns {object} 当前上传进度快照。
 */
function getStoreUploadProgress() {
  const progress = runtime.storeUploadProgress || createIdleStoreUploadProgress();
  const elapsedMs = progress.startedAt && progress.running
    ? Date.now() - new Date(progress.startedAt).getTime()
    : progress.elapsedMs;
  return {
    ...progress,
    elapsedMs: elapsedMs || 0,
    elapsedText: formatDuration(elapsedMs || 0),
  };
}

/**
 * 开始一次应用市场上传进度。
 *
 * @param {{store: string, action: string}} options 上传平台和动作。
 * @returns {object} 新进度对象。
 */
function startStoreUploadProgress(options = {}) {
  runtime.storeUploadProgress = {
    ...createIdleStoreUploadProgress(),
    running: true,
    store: options.store || "",
    action: options.action || "upload",
    phase: "starting",
    percent: 1,
    statusText: "准备上传",
    detail: "正在初始化上传任务",
    startedAt: new Date().toISOString(),
  };
  return getStoreUploadProgress();
}

/**
 * 更新当前应用市场上传进度。
 *
 * @param {object} patch 需要覆盖的进度字段。
 * @returns {object} 更新后的进度对象。
 */
function updateStoreUploadProgress(patch = {}) {
  const current = runtime.storeUploadProgress || createIdleStoreUploadProgress();
  runtime.storeUploadProgress = {
    ...current,
    ...patch,
    percent: clampPercent(patch.percent ?? current.percent),
  };
  return getStoreUploadProgress();
}

/**
 * 结束当前应用市场上传进度。
 *
 * @param {{ok?: boolean, message?: string}} result 上传结果摘要。
 * @returns {object} 结束后的进度对象。
 */
function finishStoreUploadProgress(result = {}) {
  const current = runtime.storeUploadProgress || createIdleStoreUploadProgress();
  const elapsedMs = current.startedAt ? Date.now() - new Date(current.startedAt).getTime() : current.elapsedMs;
  runtime.storeUploadProgress = {
    ...current,
    running: false,
    phase: result.ok ? "done" : "failed",
    percent: result.ok ? 100 : Math.max(Number(current.percent || 0), 1),
    statusText: result.ok ? "上传完成" : "上传失败",
    detail: result.message || (result.ok ? "上传流程已完成" : "上传流程失败"),
    finishedAt: new Date().toISOString(),
    elapsedMs,
    elapsedText: formatDuration(elapsedMs),
    ok: Boolean(result.ok),
    stopping: false,
  };
  return getStoreUploadProgress();
}

/**
 * 标记当前上传任务正在终止。
 *
 * @returns {object} 更新后的进度对象。
 */
function markStoreUploadStopping() {
  return updateStoreUploadProgress({
    stopping: true,
    statusText: "正在终止上传",
    detail: "已发送终止请求，正在等待当前网络请求退出",
  });
}

/**
 * 把毫秒转换成短耗时文案。
 *
 * @param {number} ms 毫秒。
 * @returns {string} 例如 8秒 / 2分05秒。
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}分${rest}秒`;
}

/**
 * 限制百分比在 0-100。
 *
 * @param {number} value 百分比。
 * @returns {number} 合法百分比。
 */
function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

module.exports = {
  getStoreUploadProgress,
  startStoreUploadProgress,
  updateStoreUploadProgress,
  finishStoreUploadProgress,
  markStoreUploadStopping,
};
