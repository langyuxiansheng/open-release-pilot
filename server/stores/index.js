const { runManualStoreUpload } = require("./manual-uploader");
const { readStoreConfig } = require("../db");
const { runHuaweiAction, runHuaweiFullUpload } = require("./huawei/uploader");
const { runHonorUpload } = require("./honor/uploader");
const { runOppoUpload } = require("./oppo/uploader");
const { runPgyerUpload } = require("./pgyer/uploader");
const { finishStoreUploadProgress, getStoreUploadProgress, markStoreUploadStopping, startStoreUploadProgress, updateStoreUploadProgress } = require("./progress");
const { runSjqqUpload } = require("./sjqq/uploader");
const { runVivoUpload } = require("./vivo/uploader");
const { runXiaomiUpload } = require("./xiaomi/uploader");
const runtime = require("../state");

const STORE_UPLOADERS = {
  huawei: runHuaweiStoreUpload,
  honor: runHonorUpload,
  oppo: runOppoUpload,
  pgyer: runPgyerUpload,
  sjqq: runSjqqUpload,
  vivo: runVivoUpload,
  xiaomi: runXiaomiUpload,
};

const PROGRESS_ACTIONS = new Set(["upload", "upload-all", "upload-package", "upload-apk", "upload-assets", "submit-update", "revoke-review", "revoke-all"]);

/**
 * 兼容顶部“上传预检/执行上传”按钮的华为入口。
 *
 * 华为真实流程仍然以分步骤按钮为主；这里把通用 upload 动作映射为“上传包体”，
 * 避免用户在华为 tab 点击顶部上传按钮时落到人工上传兜底。
 *
 * @param {object} options 通用上传参数。
 * @returns {Promise<object>} 华为步骤结果。
 */
function runHuaweiStoreUpload(options = {}) {
  if (options.action === "upload") return runHuaweiFullUpload(options);
  const action = options.action || "precheck";
  return runHuaweiAction(action, options);
}

/**
 * 读取当前项目中已启用并且已经接入自动 uploader 的平台。
 *
 * 一键上传不能把人工渠道也放进真实上传链路，否则用户会看到一批必然失败的任务；
 * 因此这里按 enabled 过滤后，再只保留 STORE_UPLOADERS 已实现的平台。
 *
 * @returns {{enabledStores: object[], uploadableStores: object[], skippedStores: object[]}} 平台分组。
 */
function getEnabledUploadStores() {
  const storeConfig = readStoreConfig();
  const platforms = storeConfig.platforms || [];
  const stores = storeConfig.stores || {};
  const enabledStores = platforms
    .filter((platform) => stores[platform.key]?.enabled)
    .map((platform) => ({
      key: platform.key,
      code: platform.code || platform.key,
      name: platform.name || platform.key,
      uploadSupport: platform.uploadSupport || "manual",
    }));

  // api-pending 表示该平台只有独立配置/预检服务，真实外部上传接口尚未开启。
  // 一键上传不应把这种平台计入失败任务；用户仍可在对应 tab 里单独执行预检。
  const uploadableStores = enabledStores.filter((platform) => STORE_UPLOADERS[platform.key] && platform.uploadSupport !== "api-pending");
  const skippedStores = enabledStores
    .filter((platform) => !STORE_UPLOADERS[platform.key] || platform.uploadSupport === "api-pending")
    .map((platform) => ({
      store: platform.key,
      name: platform.name,
      ok: false,
      skipped: true,
      message: platform.uploadSupport === "api-pending"
        ? `${platform.name} 已预留接口配置，但真实自动上传尚未开启，已跳过一键上传。`
        : `${platform.name} 暂未接入自动上传服务，已跳过。`,
    }));
  return { enabledStores, uploadableStores, skippedStores };
}

/**
 * 顺序上传所有已启用且已接入自动上传服务的平台。
 *
 * 每个平台的上传协议差异很大，所以这里不直接处理包体和签名，
 * 只负责串联各平台 uploader、映射总进度、收集汇总结果。
 *
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 上传选项。
 * @returns {Promise<object>} 全平台上传汇总。
 */
async function runAllEnabledStoreUploads(options = {}) {
  const { enabledStores, uploadableStores, skippedStores } = getEnabledUploadStores();
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const results = [];

  if (enabledStores.length === 0) {
    return {
      ok: false,
      store: "all",
      action: "upload-all",
      message: "没有已启用的应用市场，请先在对应平台配置里开启启用开关。",
      results,
      skipped: skippedStores,
    };
  }

  if (uploadableStores.length === 0) {
    return {
      ok: false,
      store: "all",
      action: "upload-all",
      message: "已启用的平台暂未接入自动上传服务，无法执行一键上传。",
      results,
      skipped: skippedStores,
    };
  }

  updateProgress({
    phase: "starting",
    percent: 2,
    statusText: "准备上传全部平台",
    detail: `将上传 ${uploadableStores.map((item) => item.name).join("、")}`,
  });

  for (let index = 0; index < uploadableStores.length; index += 1) {
    throwIfAborted(signal);
    const platform = uploadableStores[index];
    const uploader = STORE_UPLOADERS[platform.key];
    const basePercent = 5 + (index / uploadableStores.length) * 90;
    const spanPercent = 90 / uploadableStores.length;
    updateProgress({
      store: platform.key,
      phase: "uploading",
      percent: basePercent,
      statusText: `上传 ${platform.name}`,
      detail: `正在执行第 ${index + 1}/${uploadableStores.length} 个平台`,
    });

    try {
      const result = await uploader({
        ...options,
        storeKey: platform.key,
        action: "upload",
        updateProgress: (patch = {}) => {
          const childPercent = Number(patch.percent || 0);
          updateProgress({
            ...patch,
            store: platform.key,
            percent: basePercent + (childPercent / 100) * spanPercent,
            statusText: `${platform.name} / ${patch.statusText || "上传中"}`,
          });
        },
        signal,
      });
      results.push({ ...result, store: platform.key, storeName: platform.name });
    } catch (error) {
      results.push({
        ok: false,
        store: platform.key,
        storeName: platform.name,
        action: "upload",
        message: error.message || `${platform.name} 上传失败。`,
      });
    }
  }

  const failed = results.filter((result) => !result.ok);
  const uploadedFiles = results.flatMap((result) => result.uploadedFiles || []);
  return {
    ok: failed.length === 0,
    store: "all",
    action: "upload-all",
    message: failed.length === 0
      ? `已完成 ${results.length} 个平台上传。`
      : `已完成 ${results.length} 个平台上传，其中 ${failed.length} 个失败。`,
    results,
    skipped: skippedStores,
    uploadedFiles,
  };
}

/**
 * 顺序撤销所有已启用并已接入平台服务的审核任务。
 *
 * 撤销审核比上传更敏感：不是所有应用市场都开放自动撤销接口。
 * 聚合层只负责把动作分发到各平台 uploader，并把平台返回的“不支持原因”
 * 原样汇总给前端，避免用户误以为所有平台都已经被真实撤销。
 *
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 撤销选项。
 * @returns {Promise<object>} 全平台撤销汇总。
 */
async function runAllEnabledStoreRevokes(options = {}) {
  const { enabledStores, uploadableStores, skippedStores } = getEnabledUploadStores();
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const results = [];

  if (enabledStores.length === 0) {
    return {
      ok: false,
      store: "all",
      action: "revoke-all",
      message: "没有已启用的应用市场，请先在对应平台配置里开启启用开关。",
      results,
      skipped: skippedStores,
    };
  }

  if (uploadableStores.length === 0) {
    return {
      ok: false,
      store: "all",
      action: "revoke-all",
      message: "已启用的平台暂未接入自动撤销审核服务，无法执行一键撤销。",
      results,
      skipped: skippedStores,
    };
  }

  updateProgress({
    phase: "starting",
    percent: 2,
    statusText: "准备撤销全部平台审核",
    detail: `将处理 ${uploadableStores.map((item) => item.name).join("、")}`,
  });

  for (let index = 0; index < uploadableStores.length; index += 1) {
    throwIfStoreTaskAborted(signal, "应用市场一键撤销已被终止。");
    const platform = uploadableStores[index];
    const uploader = STORE_UPLOADERS[platform.key];
    const basePercent = 5 + (index / uploadableStores.length) * 90;
    const spanPercent = 90 / uploadableStores.length;
    updateProgress({
      store: platform.key,
      phase: "revoke",
      percent: basePercent,
      statusText: `撤销 ${platform.name}`,
      detail: `正在执行第 ${index + 1}/${uploadableStores.length} 个平台`,
    });

    try {
      const result = await uploader({
        ...options,
        storeKey: platform.key,
        action: "revoke-review",
        updateProgress: (patch = {}) => {
          const childPercent = Number(patch.percent || 0);
          updateProgress({
            ...patch,
            store: platform.key,
            percent: basePercent + (childPercent / 100) * spanPercent,
            statusText: `${platform.name} / ${patch.statusText || "撤销审核中"}`,
          });
        },
        signal,
      });
      results.push({ ...result, store: platform.key, storeName: platform.name });
    } catch (error) {
      results.push({
        ok: false,
        store: platform.key,
        storeName: platform.name,
        action: "revoke-review",
        message: error.message || `${platform.name} 撤销审核失败。`,
      });
    }
  }

  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    store: "all",
    action: "revoke-all",
    message: failed.length === 0
      ? `已完成 ${results.length} 个平台撤销审核。`
      : `已完成 ${results.length} 个平台撤销审核，其中 ${failed.length} 个失败或不支持。`,
    results,
    skipped: skippedStores,
  };
}

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
  if (!PROGRESS_ACTIONS.has(action)) {
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

  const progressStore = ["upload-all", "revoke-all"].includes(action) ? "全部平台" : storeKey;
  startStoreUploadProgress({ store: progressStore, action });
  const controller = new AbortController();
  runtime.activeStoreUpload = {
    controller,
    store: progressStore,
    action,
    startedAt: new Date().toISOString(),
  };
  const updateProgress = (patch) => updateStoreUploadProgress({ store: progressStore, action, ...patch });
  try {
    let result;
    if (action === "upload-all") {
      result = await runAllEnabledStoreUploads({ ...options, updateProgress, signal: controller.signal });
    } else if (action === "revoke-all") {
      result = await runAllEnabledStoreRevokes({ ...options, updateProgress, signal: controller.signal });
    } else {
      result = uploader
        ? await uploader({ ...options, updateProgress, signal: controller.signal })
        : await runManualStoreUpload(storeKey, { ...options, updateProgress, signal: controller.signal });
    }
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
 * 如果上传任务被用户终止则中断后续平台。
 *
 * @param {AbortSignal} signal 终止信号。
 * @returns {void}
 */
function throwIfAborted(signal) {
  throwIfStoreTaskAborted(signal, "应用市场一键上传已被终止。");
}

/**
 * 如果应用市场批量任务被终止则中断后续平台。
 *
 * @param {AbortSignal} signal 终止信号。
 * @param {string} message 终止错误文案。
 * @returns {void}
 */
function throwIfStoreTaskAborted(signal, message) {
  if (signal?.aborted) throw new Error(message);
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
