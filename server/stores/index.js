const { runManualStoreUpload } = require("./manual-uploader");
const { runPgyerUpload } = require("./pgyer/uploader");
const { finishStoreUploadProgress, getStoreUploadProgress, markStoreUploadStopping, startStoreUploadProgress, updateStoreUploadProgress } = require("./progress");
const { runSjqqUpload } = require("./sjqq/uploader");
const runtime = require("../state");

const STORE_UPLOADERS = {
  pgyer: runPgyerUpload,
  sjqq: runSjqqUpload,
};

/**
 * 统一应用商店上传入口。
 *
 * 路由层只关心“用户要对哪个 store 执行什么动作”；具体平台需要哪些参数、
 * 如何签名、如何上传文件、是否支持预检，都由平台自己的 uploader 模块负责。
 *
 * @param {{storeKey?: string, store?: string, action?: string}} options 前端上传请求。
 * @returns {Promise<object>} 上传、预检或状态查询结果。
 */
async function runStoreUpload(options = {}) {
  const storeKey = String(options.storeKey || options.store || "sjqq").trim().toLowerCase();
  const uploader = STORE_UPLOADERS[storeKey];
  const action = options.action || "precheck";
  if (action !== "upload") {
    if (!uploader) return runManualStoreUpload(storeKey, options);
    return uploader(options);
  }

  if (getStoreUploadProgress().running) {
    return {
      ok: false,
      store: storeKey,
      action,
      message: "已有应用市场上传任务正在执行，请等待当前任务结束。",
    };
  }

  startStoreUploadProgress({ store: storeKey, action });
  const controller = new AbortController();
  runtime.activeStoreUpload = {
    controller,
    store: storeKey,
    action,
    startedAt: new Date().toISOString(),
  };
  const updateProgress = (patch) => updateStoreUploadProgress({ store: storeKey, action, ...patch });
  try {
    const result = uploader
      ? await uploader({ ...options, updateProgress, signal: controller.signal })
      : await runManualStoreUpload(storeKey, { ...options, updateProgress, signal: controller.signal });
    finishStoreUploadProgress(result);
    return result;
  } catch (error) {
    finishStoreUploadProgress({
      ok: false,
      message: error.message || "应用市场上传失败",
    });
    throw error;
  } finally {
    runtime.activeStoreUpload = null;
  }
}

/**
 * 终止当前应用市场上传任务。
 *
 * @returns {object} 终止请求结果。
 */
function stopStoreUpload() {
  const activeUpload = runtime.activeStoreUpload;
  if (!activeUpload || !getStoreUploadProgress().running) {
    return {
      ok: false,
      message: "当前没有正在执行的应用市场上传任务。",
      storeUploadProgress: getStoreUploadProgress(),
    };
  }

  markStoreUploadStopping();
  activeUpload.controller.abort();
  return {
    ok: true,
    message: "已发送终止上传指令。",
    storeUploadProgress: getStoreUploadProgress(),
  };
}

module.exports = {
  getStoreUploadProgress,
  runStoreUpload,
  stopStoreUpload,
};
