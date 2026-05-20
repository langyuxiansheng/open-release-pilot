const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { clearStoreState, readCurrentNotes, readStoreConfig, readStoreState, recordUploadRun, writeStoreState } = require("../../db");
const { compactObject, formatBytes, isBlank, limitObjectSize, parseJsonResponse, resolveLocalPath, throwIfAborted } = require("../common");

const STORE_KEY = "vivo";
const VIVO_DOCS_URL = "https://dev.vivo.com.cn/documentCenter/doc/326";
const DEFAULT_API_BASE_URL = "https://developer-api.vivo.com.cn/router/rest";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_FORMAT = "json";
const DEFAULT_VERSION = "1.0";
const DEFAULT_SIGN_METHOD = "hmac";
const DEFAULT_TARGET_APP_KEY = "developer";
const DEFAULT_APK_UPLOAD_METHOD = "app.upload.apk.app";

const ACTION_LABELS = {
  upload: "一键执行 vivo 更新",
  precheck: "vivo 预检",
  "query-app-info": "查询应用详情",
  "upload-apk": "上传 APK",
  "upload-assets": "上传资源文件",
  "submit-update": "提交应用更新",
  "query-task": "查询异步任务",
  "revoke-review": "撤销审核",
  "reset-state": "重置流程状态",
};

const VIVO_TASK_STATUS_LABELS = {
  1: "待处理",
  2: "正在处理中",
  3: "处理成功",
  4: "处理失败",
};

const VIVO_STATUS_LABELS = {
  1: "待审核",
  2: "审核中",
  3: "审核通过",
  4: "审核不通过",
};

/**
 * 执行 vivo API 传包服务入口。
 *
 * vivo 官方文件上传方式的更新链路是：
 * 1. app.query.details 查询当前应用。
 * 2. app.upload.apk.app 上传 APK 并获取 serialnumber。
 * 3. 可选调用 app.upload.icon / app.upload.screenshot 上传 icon 和截图，获得 serialnumber。
 * 4. app.sync.update.app 用 serialnumber、versionCode、fileMd5 等字段提交同步更新。
 * 5. 如需排查下载文件方式任务，可调用 app.query.task.status 查询异步任务状态。
 *
 * @param {{action?: string, updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} vivo 步骤结果。
 */
async function runVivoUpload(options = {}) {
  const action = options.action || "precheck";
  if (action === "upload") return runVivoFullUpload(options);
  return runVivoAction(action, options);
}

/**
 * 执行 vivo 一键更新流程。
 *
 * 一键流程会先清空旧步骤状态，避免上一次 APK 上传返回的 serialnumber
 * 被误用于本次 app.sync.update.app 提交。
 *
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} 一键流程结果。
 */
async function runVivoFullUpload(options = {}) {
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const config = getVivoConfig();
  const startedAt = new Date().toISOString();
  const steps = [];

  try {
    clearStoreState(STORE_KEY);
    updateProgress({ phase: "precheck", percent: 6, statusText: "vivo 预检", detail: "正在检查 access_key、APK 路径和更新字段" });
    throwIfAborted(signal);
    const precheck = buildVivoPrecheck(config);
    steps.push(pickStepSummary(precheck));
    if (!precheck.ok) {
      const result = { ...precheck, action: "upload", message: "vivo 一键更新预检未通过，已取消后续步骤。", steps };
      recordUploadRun(createUploadRunRecord("upload", startedAt, result));
      return result;
    }

    updateProgress({ phase: "query-app-info", percent: 18, statusText: "查询 vivo 应用详情", detail: `按包名查询：${config.packageName}` });
    const appInfoResult = await queryAppInfoStep(config, signal);
    steps.push(pickStepSummary(appInfoResult));
    if (!appInfoResult.ok) return recordAndReturnFullUploadFailure(startedAt, appInfoResult.message, steps, appInfoResult);

    updateProgress({ phase: "upload-apk", percent: 35, statusText: "上传 vivo APK", detail: "正在调用 app.upload.apk.app" });
    const uploadApkResult = await uploadApkStep(config, {
      signal,
      updateProgress: (patch = {}) =>
        updateProgress({
          ...patch,
          percent: 35 + Math.round(Number(patch.percent || 0) * 0.42),
        }),
    });
    steps.push(pickStepSummary(uploadApkResult));
    if (!uploadApkResult.ok) return recordAndReturnFullUploadFailure(startedAt, uploadApkResult.message, steps, uploadApkResult);

    updateProgress({ phase: "upload-assets", percent: 78, statusText: "上传 vivo 资源文件", detail: "正在按需上传 icon 和截图" });
    const uploadAssetsResult = await uploadAssetsStep(config, {
      signal,
      updateProgress: (patch = {}) =>
        updateProgress({
          ...patch,
          percent: 78 + Math.round(Number(patch.percent || 0) * 0.1),
        }),
    });
    steps.push(pickStepSummary(uploadAssetsResult));
    if (!uploadAssetsResult.ok) return recordAndReturnFullUploadFailure(startedAt, uploadAssetsResult.message, steps, uploadAssetsResult);

    updateProgress({ phase: "submit-update", percent: 90, statusText: "提交 vivo 应用更新", detail: "正在调用 app.sync.update.app" });
    const submitResult = await submitUpdateStep(config, signal);
    steps.push(pickStepSummary(submitResult));
    if (!submitResult.ok) return recordAndReturnFullUploadFailure(startedAt, submitResult.message, steps, submitResult);

    updateProgress({ phase: "query-task", percent: 96, statusText: "查询 vivo 任务状态", detail: "正在调用 app.query.task.status" });
    const taskResult = await queryTaskStep(config, signal);
    steps.push(pickStepSummary(taskResult));

    updateProgress({
      phase: "done",
      percent: 100,
      statusText: "vivo 更新已提交",
      detail: taskResult.ok ? taskResult.message : "同步更新接口已返回，任务状态查询未完成",
    });
    const result = {
      ok: submitResult.ok,
      store: STORE_KEY,
      action: "upload",
      message: taskResult.ok ? `vivo 一键更新已提交：${formatVivoTaskState(taskResult.taskState).text}` : "vivo 一键更新已提交，任务状态查询未完成。",
      steps,
      uploadedFiles: [...(uploadApkResult.uploadedFiles || []), ...(uploadAssetsResult.uploadedFiles || [])],
      updateFields: submitResult.updateFields || [],
      taskState: taskResult.taskState || null,
      taskStateLabel: taskResult.taskStateLabel || "",
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
    recordUploadRun(createUploadRunRecord("upload", startedAt, result));
    return result;
  } catch (error) {
    const result = {
      ok: false,
      store: STORE_KEY,
      action: "upload",
      message: `vivo 一键更新流程失败：${error.message}`,
      steps,
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
    recordUploadRun(createUploadRunRecord("upload", startedAt, result));
    return result;
  }
}

/**
 * 执行 vivo 单步骤动作。
 *
 * @param {string} action 动作名。
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} 单步骤结果。
 */
async function runVivoAction(action = "precheck", options = {}) {
  const startedAt = new Date().toISOString();
  const config = getVivoConfig();
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  let result;

  try {
    if (action === "precheck") result = buildVivoPrecheck(config);
    else if (action === "reset-state") result = resetVivoState();
    else if (action === "query-app-info") result = await queryAppInfoStep(config, signal);
    else if (action === "upload-apk") result = await uploadApkStep(config, { signal, updateProgress, resetState: true });
    else if (action === "upload-assets") result = await uploadAssetsStep(config, { signal, updateProgress });
    else if (action === "submit-update") result = await submitUpdateStep(config, signal);
    else if (action === "query-task") result = await queryTaskStep(config, signal);
    else if (action === "revoke-review") result = revokeReviewStep(updateProgress);
    else result = buildFailure(`未知 vivo 发布动作：${action}`, []);
  } catch (error) {
    result = buildFailure(error.message || "vivo 发布步骤执行失败。", []);
  }

  if (!["precheck", "reset-state"].includes(action)) recordUploadRun(createUploadRunRecord(action, startedAt, result));
  return result;
}

/**
 * 读取并规范化 vivo 配置。
 *
 * @returns {object} vivo 配置。
 */
function getVivoConfig() {
  return normalizeVivoConfig(readStoreConfig().stores.vivo || {});
}

/**
 * 补齐 vivo 默认接口参数和早期字段别名。
 *
 * @param {object} config 原始配置。
 * @returns {object} 规范化后的配置。
 */
function normalizeVivoConfig(config = {}) {
  return {
    ...config,
    docsUrl: config.docsUrl || VIVO_DOCS_URL,
    apiBaseUrl: trimBaseUrl(config.apiBaseUrl || DEFAULT_API_BASE_URL),
    format: config.format || DEFAULT_FORMAT,
    apiVersion: config.apiVersion || DEFAULT_VERSION,
    signMethod: config.signMethod || config.sign_method || DEFAULT_SIGN_METHOD,
    targetAppKey: config.targetAppKey || config.target_app_key || DEFAULT_TARGET_APP_KEY,
    apkUploadMethod: config.apkUploadMethod || config.apk_upload_method || DEFAULT_APK_UPLOAD_METHOD,
    accessKey: config.accessKey || config.appKey || config.access_key || "",
    accessSecret: config.accessSecret || config.clientSecret || config.access_secret || "",
    packageName: config.packageName || config.pkg_name || "",
    versionCode: config.versionCode || config.version_code || "",
    apkPath: config.apkPath || config.packagePath || "",
    iconPath: config.iconPath || "",
    screenshotPaths: config.screenshotPaths || [],
    updateDesc: String(config.releaseNotes || config.updateDesc || readCurrentNotes() || "").trim(),
    remark: String(config.auditNotes || config.remark || "").trim(),
    onlineType: config.onlineType === undefined || config.onlineType === "" ? 1 : Number(config.onlineType),
    compatibleDevice: config.compatibleDevice === undefined || config.compatibleDevice === "" ? 2 : Number(config.compatibleDevice),
  };
}

/**
 * 构建 vivo 发布配置预检结果。
 *
 * app.sync.update.app 的更新流程必须有 access_key、access_secret、包名、
 * versionCode、APK、onlineType 和 compatibleDevice。APK serialnumber 和 fileMd5
 * 由后端上传步骤自动生成，不让用户在前端手填。
 *
 * @param {object} config vivo 配置。
 * @returns {object} 预检结果。
 */
function buildVivoPrecheck(config) {
  const missing = [];
  const warnings = [];
  if (!config.enabled) missing.push("enabled");
  ["accessKey", "accessSecret", "packageName", "versionCode", "apkPath", "onlineType", "compatibleDevice"].forEach((field) => {
    if (isBlank(config[field])) missing.push(field);
  });

  const apkPath = resolveLocalPath(config.apkPath);
  if (!isBlank(config.apkPath) && !fs.existsSync(apkPath)) missing.push(`APK 不存在：${apkPath}`);
  getVivoAssetDescriptors(config)
    .filter((asset) => asset.paths.length > 0)
    .forEach((asset) => {
      asset.paths.forEach((filePath) => {
        const resolvedPath = resolveLocalPath(filePath);
        if (!fs.existsSync(resolvedPath)) missing.push(`${asset.label}不存在：${resolvedPath}`);
        else {
          const validation = validateVivoAssetFile(asset, resolvedPath);
          missing.push(...validation.errors);
          warnings.push(...validation.warnings);
        }
      });
    });
  const screenshotCount = toPathList(config.screenshotPaths).length;
  if (screenshotCount > 0 && (screenshotCount < 3 || screenshotCount > 5)) missing.push("vivo 截图要求 3-5 张。");
  if (Number(config.onlineType) === 2 && isBlank(config.scheOnlineTime)) missing.push("scheOnlineTime");
  if (!isBlank(config.updateDesc) && (config.updateDesc.length < 5 || config.updateDesc.length > 200)) warnings.push("vivo updateDesc 长度要求 5~200 个字符。");
  if (!isBlank(config.remark) && (config.remark.length < 10 || config.remark.length > 200)) warnings.push("vivo remark 审核留言长度要求 10~200 个字符。");

  return {
    ok: missing.length === 0,
    store: STORE_KEY,
    action: "precheck",
    message: missing.length === 0 ? "vivo 发布配置预检通过。" : "vivo 发布配置预检未通过。",
    missing,
    warnings,
    plannedFiles: isBlank(config.apkPath) ? [] : [{ localKey: "apkPath", formName: "file", type: "apk", path: apkPath, exists: fs.existsSync(apkPath) }],
    updateFields: getVivoUpdateFields(config),
    docsUrl: VIVO_DOCS_URL,
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 上传 vivo 更新接口需要的 icon、截图等资源。
 *
 * vivo 网页文档的文件上传方式和 OPPO 类似：先把本地资源上传到 vivo，
 * 得到 serialnumber，再在 app.sync.update.app 中传 icon/screenshot 等字段。
 * 当前自动接入最常用的 icon 和截图，其它资质字段仍保留手填流水号兼容模式。
 *
 * @param {object} config vivo 配置。
 * @param {{signal?: AbortSignal, updateProgress?: Function}} options 上传选项。
 * @returns {Promise<object>} 上传结果。
 */
async function uploadAssetsStep(config, options = {}) {
  const required = requireFields(config, ["enabled", "accessKey", "accessSecret", "packageName"]);
  if (!required.ok) return { ...required, action: "upload-assets" };

  const assets = getVivoAssetDescriptors(config).filter((asset) => asset.paths.length > 0);
  const missing = [];
  assets.forEach((asset) => {
    asset.paths.forEach((filePath) => {
      const resolvedPath = resolveLocalPath(filePath);
      if (!fs.existsSync(resolvedPath)) missing.push(`${asset.label}不存在：${resolvedPath}`);
      else missing.push(...validateVivoAssetFile(asset, resolvedPath).errors);
    });
  });
  const screenshotCount = toPathList(config.screenshotPaths).length;
  if (screenshotCount > 0 && (screenshotCount < 3 || screenshotCount > 5)) missing.push("vivo 截图要求 3-5 张。");
  if (missing.length > 0) return { ...buildFailure("vivo 资源文件预检未通过。", missing), action: "upload-assets" };

  const files = assets.flatMap((asset) =>
    asset.paths.map((filePath) => ({
      ...asset,
      path: resolveLocalPath(filePath),
    })),
  );
  if (files.length === 0) {
    return {
      ok: true,
      store: STORE_KEY,
      action: "upload-assets",
      skipped: true,
      message: "没有需要上传的 vivo 资源文件。",
      uploadedFiles: [],
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
  }

  const uploadedAssets = {};
  const uploadedFiles = [];
  let completed = 0;
  for (const file of files) {
    throwIfAborted(options.signal);
    options.updateProgress?.({
      phase: "uploading",
      percent: Math.round((completed / files.length) * 100),
      statusText: `上传 vivo ${file.label}`,
      detail: path.basename(file.path),
    });
    const uploadResponse = await requestVivoMultipartApi(config, file.method, {
      fields: { packageName: config.packageName },
      filePath: file.path,
      contentType: getUploadContentType(file.path),
      signal: options.signal,
      onProgress: (uploaded, total) => {
        options.updateProgress?.({
          phase: "uploading",
          percent: Math.round(((completed + uploaded / Math.max(total, 1)) / files.length) * 100),
          statusText: `上传 vivo ${file.label}`,
          detail: `${path.basename(file.path)} ${formatBytes(uploaded)} / ${formatBytes(total)}`,
        });
      },
    });
    const uploaded = uploadResponse.data || {};
    if (isBlank(uploaded.serialnumber)) throw new Error(`vivo ${file.label}上传响应缺少 serialnumber：${JSON.stringify(uploadResponse).slice(0, 300)}`);
    uploadedAssets[file.submitKey] ||= [];
    uploadedAssets[file.submitKey].push({
      ...sanitizeVivoResponse(uploaded),
      sourcePath: file.path,
      uploadedAt: new Date().toISOString(),
    });
    uploadedFiles.push({ fileName: path.basename(file.path), path: file.path, serialnumber: uploaded.serialnumber, submitKey: file.submitKey });
    completed += 1;
  }

  const state = writeStoreState(STORE_KEY, { uploadedAssets });
  return {
    ok: true,
    store: STORE_KEY,
    action: "upload-assets",
    message: `vivo 资源文件上传完成：${uploadedFiles.length} 个文件。`,
    uploadedFiles,
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 查询 vivo 应用详情。
 *
 * @param {object} config vivo 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 应用详情结果。
 */
async function queryAppInfoStep(config, signal) {
  const required = requireFields(config, ["enabled", "accessKey", "accessSecret", "packageName"]);
  if (!required.ok) return { ...required, action: "query-app-info" };

  const response = await requestVivoApi(config, "app.query.details", {
    params: { packageName: config.packageName },
    signal,
  });
  const appInfo = response.data || {};
  const statusLabel = formatVivoAppStatus(appInfo);
  const state = writeStoreState(STORE_KEY, {
    appInfoQueriedAt: new Date().toISOString(),
    appInfo: sanitizeVivoResponse(appInfo),
    appStatusLabel: statusLabel,
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-app-info",
    message: `vivo 应用详情查询完成：${appInfo.mainTitle || config.packageName}${statusLabel ? `，${statusLabel}` : ""}`,
    appInfo: sanitizeVivoResponse(appInfo),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 上传 vivo APK 并保存下一步需要的 serialnumber 和 fileMd5。
 *
 * @param {object} config vivo 配置。
 * @param {{signal?: AbortSignal, updateProgress?: Function, resetState?: boolean}} options 执行选项。
 * @returns {Promise<object>} 上传结果。
 */
async function uploadApkStep(config, options = {}) {
  const required = requireFields(config, ["enabled", "accessKey", "accessSecret", "packageName", "apkPath"]);
  if (!required.ok) return { ...required, action: "upload-apk" };
  const apkPath = resolveLocalPath(config.apkPath);
  if (!fs.existsSync(apkPath)) return buildFailure(`vivo APK 文件不存在：${apkPath}`, ["apkPath"]);
  if (options.resetState) clearStoreState(STORE_KEY);

  const fileMd5 = await md5File(apkPath);
  options.updateProgress?.({ phase: "uploading", percent: 8, statusText: "上传 vivo APK", detail: `${path.basename(apkPath)} MD5 已计算` });
  const uploadResponse = await requestVivoMultipartApi(config, config.apkUploadMethod, {
    fields: compactObject({
      packageName: config.packageName,
      fileMd5,
      stageType: config.stageType,
    }),
    filePath: apkPath,
    signal: options.signal,
    onProgress: (uploaded, total) => {
      options.updateProgress?.({
        phase: "uploading",
        percent: 8 + Math.round((uploaded / Math.max(total, 1)) * 88),
        statusText: "上传 vivo APK",
        detail: `${path.basename(apkPath)} ${formatBytes(uploaded)} / ${formatBytes(total)}`,
      });
    },
  });
  const uploadedApk = uploadResponse.data || {};
  if (isBlank(uploadedApk.serialnumber)) {
    throw new Error(`vivo APK 上传响应缺少 serialnumber：${JSON.stringify(uploadResponse).slice(0, 300)}`);
  }
  const state = writeStoreState(STORE_KEY, {
    uploadedApk: {
      ...sanitizeVivoResponse(uploadedApk),
      fileMd5: uploadedApk.fileMd5 || fileMd5,
      sourcePath: apkPath,
      uploadedAt: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "upload-apk",
    message: `vivo APK 上传完成：${uploadedApk.serialnumber}`,
    uploadedFiles: [{ fileName: path.basename(apkPath), path: apkPath, serialnumber: uploadedApk.serialnumber, md5: uploadedApk.fileMd5 || fileMd5 }],
    response: sanitizeVivoResponse(uploadedApk),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 提交 vivo 应用更新。
 *
 * @param {object} config vivo 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 提交结果。
 */
async function submitUpdateStep(config, signal) {
  const precheck = buildVivoPrecheck(config);
  if (!precheck.ok) return { ...precheck, action: "submit-update", message: "vivo 应用更新预检未通过。" };

  const state = readStoreState(STORE_KEY);
  const uploadedApk = state.uploadedApk;
  if (!uploadedApk?.serialnumber || !uploadedApk?.fileMd5) {
    return buildFailure("缺少已上传 APK 的 serialnumber/fileMd5，请先执行“上传 APK”。", ["uploadedApk.serialnumber", "uploadedApk.fileMd5"]);
  }

  const updateParams = buildUpdateParams(config, uploadedApk, state.uploadedAssets || {});
  const response = await requestVivoApi(config, "app.sync.update.app", {
    params: updateParams,
    signal,
  });
  const nextState = writeStoreState(STORE_KEY, {
    updateSubmittedAt: new Date().toISOString(),
    lastUpdateResponse: sanitizeVivoResponse(response.data || response),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "submit-update",
    message: response.msg ? `vivo 应用更新已返回：${response.msg}` : "vivo 应用更新请求已返回。",
    response: sanitizeVivoResponse(response.data || response),
    updateFields: Object.keys(updateParams),
    state: sanitizeStateForResponse(nextState),
  };
}

/**
 * 查询 vivo 异步任务状态。
 *
 * 文件上传方式的 app.sync.update.app 是同步接口，这个查询主要用于面板统一展示
 * 和排查下载文件方式或平台侧异步处理状态。如果 vivo 返回未命中任务，也会把原始
 * 原因展示给用户，不阻断已经成功的同步更新提交。
 *
 * @param {object} config vivo 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 任务状态结果。
 */
async function queryTaskStep(config, signal) {
  const required = requireFields(config, ["enabled", "accessKey", "accessSecret", "packageName"]);
  if (!required.ok) return { ...required, action: "query-task" };

  try {
    const response = await requestVivoApi(config, "app.query.task.status", {
      params: {
        packageName: config.packageName,
        packetType: 0,
      },
      signal,
    });
    const taskState = response.data || {};
    const taskSummary = formatVivoTaskState(taskState);
    const state = writeStoreState(STORE_KEY, {
      taskStateQueriedAt: new Date().toISOString(),
      lastTaskState: taskState,
      lastTaskStateLabel: taskSummary.label,
    });
    return {
      ok: true,
      store: STORE_KEY,
      action: "query-task",
      message: `vivo 任务状态查询完成：${taskSummary.text}`,
      taskState,
      taskStateLabel: taskSummary.label,
      state: sanitizeStateForResponse(state),
    };
  } catch (error) {
    // 文件上传方式的 app.sync.update.app 是同步接口；部分账号没有可查询的异步任务。
    // 这里把查询失败写入步骤状态和记录，但不让一键更新因为“状态查询”反向失败。
    const taskState = { errorReason: error.message };
    const state = writeStoreState(STORE_KEY, {
      taskStateQueriedAt: new Date().toISOString(),
      lastTaskState: taskState,
      lastTaskStateLabel: "查询失败",
    });
    return {
      ok: false,
      store: STORE_KEY,
      action: "query-task",
      message: `vivo 任务状态查询失败：${error.message}`,
      warnings: [error.message],
      taskState,
      taskStateLabel: "查询失败",
      state: sanitizeStateForResponse(state),
    };
  }
}

/**
 * vivo 当前公开 API 传包文档未提供撤销审核接口。
 *
 * @param {Function} updateProgress 进度回调。
 * @returns {object} 不支持结果。
 */
function revokeReviewStep(updateProgress) {
  updateProgress?.({
    phase: "unsupported",
    percent: 100,
    statusText: "vivo 暂不支持撤销审核",
    detail: "当前 vivo API 传包文档未提供撤销审核接口，请到 vivo 开放平台后台人工处理。",
  });
  return {
    ok: false,
    store: STORE_KEY,
    action: "revoke-review",
    message: "vivo 暂未接入撤销审核接口：当前 vivo API 传包文档未提供撤销审核路由。",
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 构建 vivo 应用更新参数。
 *
 * @param {object} config vivo 配置。
 * @param {object} uploadedApk APK 上传结果。
 * @param {object} uploadedAssets 资源文件上传结果，按 app.sync.update.app 字段分组。
 * @returns {object} app.sync.update.app 业务参数。
 */
function buildUpdateParams(config, uploadedApk, uploadedAssets = {}) {
  const iconSerialnumber = firstVivoSerial(uploadedAssets.icon);
  const screenshotSerialnumbers = vivoSerials(uploadedAssets.screenshot).join(",");
  return compactObject({
    packageName: config.packageName,
    versionCode: Number(config.versionCode),
    apk: uploadedApk.serialnumber,
    fileMd5: uploadedApk.fileMd5,
    onlineType: Number(config.onlineType || 1),
    updateDesc: config.updateDesc,
    // 默认面板只允许通过本地文件上传更新 icon/截图，避免隐藏的旧 serialnumber
    // 留在 stores.local.json 里时，用户看不见却仍被提交到 vivo。
    icon: iconSerialnumber,
    screenshot: screenshotSerialnumbers,
    scheOnlineTime: Number(config.onlineType) === 2 ? config.scheOnlineTime : "",
    remark: config.remark,
    compatibleDevice: Number(config.compatibleDevice || 2),
  });
}

/**
 * 获取 vivo 自动上传资源定义。
 *
 * 网页文档当前明确给出 icon 文件上传 method=app.upload.icon、
 * 截图文件上传 method=app.upload.screenshot，两者返回的 serialnumber
 * 分别提交到 app.sync.update.app 的 icon 和 screenshot 字段。
 *
 * @param {object} config vivo 配置。
 * @returns {object[]} 资源描述列表。
 */
function getVivoAssetDescriptors(config) {
  return [
    { configKey: "iconPath", submitKey: "icon", label: "icon 图标", method: "app.upload.icon", paths: toUploadPathList(config.iconPath) },
    { configKey: "screenshotPaths", submitKey: "screenshot", label: "截图", method: "app.upload.screenshot", paths: toUploadPathList(config.screenshotPaths) },
  ];
}

/**
 * 校验 vivo 资源文件规格。
 *
 * @param {object} asset vivo 资源描述。
 * @param {string} filePath 本地文件路径。
 * @returns {{errors: string[], warnings: string[]}} 校验结果。
 */
function validateVivoAssetFile(asset, filePath) {
  if (asset.submitKey === "icon") return validateVivoIconFile(filePath);
  if (asset.submitKey === "screenshot") return validateVivoScreenshotFile(filePath);
  return { errors: [], warnings: [] };
}

/**
 * 校验 vivo icon 文件。
 *
 * 网页文档要求 jpg/png、长宽相等、不低于 256x256、不超过 512x512、50KB 内。
 *
 * @param {string} filePath 本地图标路径。
 * @returns {{errors: string[], warnings: string[]}} 校验结果。
 */
function validateVivoIconFile(filePath) {
  const result = { errors: [], warnings: [] };
  const ext = path.extname(filePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) result.errors.push(`vivo icon 只支持 JPG/PNG：${filePath}`);
  const size = safeFileSize(filePath);
  if (size > 50 * 1024) result.errors.push(`vivo icon 文件不能超过 50KB：${filePath} 当前 ${formatBytes(size)}`);
  const image = readImageMetadata(filePath);
  if (!image.ok) result.errors.push(`vivo icon 读取失败：${image.message}`);
  else {
    if (image.width !== image.height) result.errors.push(`vivo icon 必须长宽相等：${filePath} 当前 ${image.width}x${image.height}`);
    if (image.width < 256 || image.height < 256 || image.width > 512 || image.height > 512) result.errors.push(`vivo icon 尺寸必须在 256x256 到 512x512 之间：${filePath} 当前 ${image.width}x${image.height}`);
  }
  return result;
}

/**
 * 校验 vivo 截图文件。
 *
 * 网页文档要求竖图 1080x1920、jpg/png、单张不超过 2MB。
 *
 * @param {string} filePath 本地截图路径。
 * @returns {{errors: string[], warnings: string[]}} 校验结果。
 */
function validateVivoScreenshotFile(filePath) {
  const result = { errors: [], warnings: [] };
  const ext = path.extname(filePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) result.errors.push(`vivo 截图只支持 JPG/PNG：${filePath}`);
  const size = safeFileSize(filePath);
  if (size > 2 * 1024 * 1024) result.errors.push(`vivo 截图不能超过 2MB：${filePath} 当前 ${formatBytes(size)}`);
  const image = readImageMetadata(filePath);
  if (!image.ok) result.errors.push(`vivo 截图读取失败：${image.message}`);
  else if (image.width !== 1080 || image.height !== 1920) result.errors.push(`vivo 截图尺寸必须是 1080x1920：${filePath} 当前 ${image.width}x${image.height}`);
  return result;
}

/**
 * 读取已上传资源 serialnumber 列表。
 *
 * @param {object[]|object|undefined} assets 上传资源对象。
 * @returns {string[]} serialnumber 列表。
 */
function vivoSerials(assets) {
  const list = Array.isArray(assets) ? assets : assets ? [assets] : [];
  return list.map((asset) => asset?.serialnumber || asset?.serialNumber).filter(Boolean);
}

/**
 * 读取第一个资源 serialnumber。
 *
 * @param {object[]|object|undefined} assets 上传资源对象。
 * @returns {string} serialnumber。
 */
function firstVivoSerial(assets) {
  return vivoSerials(assets)[0] || "";
}

/**
 * 把配置值统一为列表。
 *
 * @param {unknown} value 原始配置。
 * @returns {string[]} 列表。
 */
function toPathList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 读取待上传本地文件路径。
 *
 * @param {unknown} value 原始路径配置。
 * @returns {string[]} 本地路径列表。
 */
function toUploadPathList(value) {
  return toPathList(value).filter((item) => !/^https?:\/\//i.test(item));
}

/**
 * 根据文件后缀返回上传 MIME。
 *
 * @param {string} filePath 本地文件路径。
 * @returns {string} MIME 类型。
 */
function getUploadContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".apk": "application/vnd.android.package-archive",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
  }[ext] || "application/octet-stream";
}

/**
 * 调用 vivo JSON 业务接口。
 *
 * @param {object} config vivo 配置。
 * @param {string} methodName vivo method。
 * @param {{params?: object, signal?: AbortSignal}} options 请求选项。
 * @returns {Promise<object>} JSON 响应。
 */
async function requestVivoApi(config, methodName, options = {}) {
  const params = signVivoParams(config, methodName, options.params || {});
  const bodyText = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const response = await requestJson(config.apiBaseUrl, {
    method: "POST",
    body: bodyText,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(bodyText),
    },
    signal: options.signal,
  }, `vivo ${methodName}`);
  assertVivoSuccess(response, `vivo 接口请求失败：${methodName}`);
  return response;
}

/**
 * 调用 vivo multipart 文件上传接口。
 *
 * @param {object} config vivo 配置。
 * @param {string} methodName vivo method。
 * @param {{fields?: object, filePath: string, signal?: AbortSignal, onProgress?: Function}} options 上传选项。
 * @returns {Promise<object>} JSON 响应。
 */
async function requestVivoMultipartApi(config, methodName, options = {}) {
  if (isBlank(methodName)) {
    throw new Error("vivo 文件上传 method 为空，请检查服务端默认配置。");
  }
  const signedFields = signVivoParams(config, methodName, options.fields || {});
  const response = await requestMultipartFile(config.apiBaseUrl, {
    fields: signedFields,
    filePath: options.filePath,
    contentType: options.contentType,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  assertVivoSuccess(response, `vivo 文件上传失败：${methodName}`);
  return response;
}

/**
 * 生成 vivo 公共参数和 sign。
 *
 * 官方规则：公共参数和业务参数按 ASCII 排序，拼接成 k=v&k2=v2，
 * 使用 access_secret 做 HmacSHA256，上传文件接口签名时不包含 file。
 *
 * @param {object} config vivo 配置。
 * @param {string} methodName vivo method。
 * @param {object} businessParams 业务参数。
 * @returns {object} 带 sign 的完整参数。
 */
function signVivoParams(config, methodName, businessParams = {}) {
  const params = compactObject({
    ...businessParams,
    access_key: config.accessKey,
    timestamp: Date.now(),
    method: methodName,
    format: config.format || DEFAULT_FORMAT,
    v: config.apiVersion || DEFAULT_VERSION,
    sign_method: config.signMethod || DEFAULT_SIGN_METHOD,
    target_app_key: config.targetAppKey || DEFAULT_TARGET_APP_KEY,
  });
  params.sign = crypto
    .createHmac("sha256", config.accessSecret)
    .update(buildSortedQuery(params), "utf8")
    .digest("hex");
  return params;
}

/**
 * 发送 JSON 接口请求。
 *
 * @param {string} url 请求 URL。
 * @param {{method?: string, headers?: object, body?: string, signal?: AbortSignal}} options 请求选项。
 * @param {string} label 接口名称。
 * @returns {Promise<object>} JSON 响应。
 */
function requestJson(url, options = {}, label = "接口") {
  return requestRaw(url, options).then((response) => parseJsonResponse(response.text, label));
}

/**
 * 发送普通 HTTP 请求并返回文本。
 *
 * @param {string} url 请求 URL。
 * @param {{method?: string, headers?: object, body?: string, signal?: AbortSignal}} options 请求选项。
 * @returns {Promise<{statusCode: number, text: string}>} 响应文本。
 */
function requestRaw(url, options = {}) {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }

    const req = transport.request({
      method: options.method || "GET",
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        resolve({ statusCode: res.statusCode, text });
      });
    });

    req.on("timeout", () => req.destroy(new Error(`请求超时：${url}`)));
    req.on("error", reject);
    options.signal?.addEventListener("abort", () => req.destroy(new Error("上传任务已终止")), { once: true });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 发送 multipart/form-data 文件上传请求。
 *
 * @param {string} url vivo router/rest 地址。
 * @param {{fields: object, filePath: string, signal?: AbortSignal, onProgress?: Function}} options 上传选项。
 * @returns {Promise<object>} JSON 响应。
 */
function requestMultipartFile(url, options) {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const boundary = `----open-release-pilot-vivo-${Date.now().toString(16)}`;
  const fieldBuffers = Object.entries(options.fields || {}).map(([key, value]) => (
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${value}\r\n`)
  ));
  const fileName = path.basename(options.filePath);
  const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${options.contentType || "application/vnd.android.package-archive"}\r\n\r\n`);
  const fileEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileSize = fs.statSync(options.filePath).size;
  const contentLength = fieldBuffers.reduce((sum, buffer) => sum + buffer.length, 0) + fileHeader.length + fileSize + fileEnd.length;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }
    const req = transport.request({
      method: "POST",
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": contentLength,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`vivo 文件上传 HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        resolve(parseJsonResponse(text, "vivo 文件上传"));
      });
    });

    let uploaded = 0;
    let activeStream = null;
    req.on("timeout", () => req.destroy(new Error(`vivo 文件上传超时：${url}`)));
    req.on("error", reject);
    options.signal?.addEventListener("abort", () => {
      activeStream?.destroy(new Error("上传任务已终止"));
      req.destroy(new Error("上传任务已终止"));
    }, { once: true });

    fieldBuffers.forEach((buffer) => req.write(buffer));
    req.write(fileHeader);
    activeStream = fs.createReadStream(options.filePath);
    activeStream.on("data", (chunk) => {
      uploaded += chunk.length;
      options.onProgress?.(uploaded, fileSize);
    });
    activeStream.on("error", reject);
    activeStream.on("end", () => req.end(fileEnd));
    activeStream.pipe(req, { end: false });
  });
}

/**
 * 校验 vivo code/subCode 是否成功。
 *
 * @param {object} json 响应 JSON。
 * @param {string} prefix 错误前缀。
 * @returns {void}
 */
function assertVivoSuccess(json, prefix) {
  const code = Number(json?.code);
  const subCode = json?.subCode === undefined || json?.subCode === null ? "" : String(json.subCode);
  if (code === 0 && (subCode === "" || subCode === "0")) return;
  const parts = [];
  const message = pickVivoErrorMessage(json);
  if (message) parts.push(message);
  if (subCode && subCode !== "0") parts.push(`subCode=${subCode}`);
  const missingParam = pickVivoMissingParam(json);
  if (missingParam) parts.push(`缺少参数：${missingParam}`);
  if (parts.length === 0) parts.push(JSON.stringify(json).slice(0, 300));
  throw new Error(`${prefix}：${parts.join("，")}`);
}

/**
 * 提取 vivo 错误信息。
 *
 * vivo 不同接口返回可能使用 msg、message、data.message 等字段。集中提取后，
 * 前端日志能看到具体失败原因，不会只显示 undefined。
 *
 * @param {object} json vivo 响应。
 * @returns {string} 错误信息。
 */
function pickVivoErrorMessage(json = {}) {
  return json.msg || json.message || json.errorMsg || json.error_msg || json.data?.msg || json.data?.message || "";
}

/**
 * 尝试提取 vivo “缺少参数”里的参数名。
 *
 * @param {object} json vivo 响应。
 * @returns {string} 参数名或空字符串。
 */
function pickVivoMissingParam(json = {}) {
  return json.param || json.parameter || json.missingParam || json.missing_param || json.data?.param || json.data?.missingParam || "";
}

/**
 * 重置 vivo 流程状态。
 *
 * @returns {object} 重置结果。
 */
function resetVivoState() {
  clearStoreState(STORE_KEY);
  return {
    ok: true,
    store: STORE_KEY,
    action: "reset-state",
    message: "vivo 流程状态已重置。",
    state: {},
  };
}

/**
 * 统一记录一键流程失败并返回结果。
 *
 * @param {string} startedAt 开始时间。
 * @param {string} message 失败说明。
 * @param {object[]} steps 步骤摘要。
 * @param {object} failedResult 失败步骤结果。
 * @returns {object} 一键失败响应。
 */
function recordAndReturnFullUploadFailure(startedAt, message, steps, failedResult) {
  const result = {
    ok: false,
    store: STORE_KEY,
    action: "upload",
    message,
    steps,
    missing: failedResult?.missing || [],
    warnings: failedResult?.warnings || [],
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
  recordUploadRun(createUploadRunRecord("upload", startedAt, result));
  return result;
}

/**
 * 抽取一键流程步骤摘要。
 *
 * @param {object} result 步骤结果。
 * @returns {object} 简短步骤摘要。
 */
function pickStepSummary(result) {
  return {
    action: result.action,
    ok: Boolean(result.ok),
    skipped: Boolean(result.skipped),
    message: result.message || "",
    missing: result.missing || [],
    warnings: result.warnings || [],
  };
}

/**
 * 清理 vivo 流程状态供前端步骤条展示。
 *
 * @param {object} stateInfo 原始状态。
 * @returns {object} 前端状态。
 */
function sanitizeStateForResponse(stateInfo = {}) {
  return compactObject({
    appInfoQueriedAt: stateInfo.appInfoQueriedAt,
    appInfo: stateInfo.appInfo,
    appStatusLabel: stateInfo.appStatusLabel,
    uploadedApk: stateInfo.uploadedApk,
    updateSubmittedAt: stateInfo.updateSubmittedAt,
    lastUpdateResponse: stateInfo.lastUpdateResponse,
    taskStateQueriedAt: stateInfo.taskStateQueriedAt,
    lastTaskState: stateInfo.lastTaskState,
    lastTaskStateLabel: stateInfo.lastTaskStateLabel,
  });
}

/**
 * 创建上传记录摘要。
 *
 * @param {string} action 动作名。
 * @param {string} startedAt 开始时间。
 * @param {object} result 执行结果。
 * @returns {object} uploadRuns 记录。
 */
function createUploadRunRecord(action, startedAt, result) {
  return {
    id: `${Date.now()}-${STORE_KEY}-${action}`,
    store: STORE_KEY,
    action,
    actionLabel: ACTION_LABELS[action] || `vivo ${action}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: Boolean(result.ok),
    message: result.message || "",
    uploadedFiles: result.uploadedFiles || [],
    updateFields: result.updateFields || [],
    warnings: result.warnings || [],
    taskState: result.taskState || undefined,
    taskStateLabel: result.taskStateLabel || undefined,
    docsUrl: result.docsUrl || VIVO_DOCS_URL,
  };
}

/**
 * 校验指定字段是否存在。
 *
 * @param {object} config 当前平台配置。
 * @param {string[]} fields 必填字段。
 * @returns {object} 校验结果。
 */
function requireFields(config, fields) {
  const missing = fields.filter((key) => {
    if (key === "enabled") return !config.enabled;
    return isBlank(config[key]);
  });
  return missing.length === 0 ? { ok: true, store: STORE_KEY } : buildFailure("vivo 发布配置预检未通过。", missing);
}

/**
 * 构建失败结果。
 *
 * @param {string} message 失败说明。
 * @param {string[]} missing 缺失字段。
 * @returns {object} 失败结果。
 */
function buildFailure(message, missing = []) {
  return {
    ok: false,
    store: STORE_KEY,
    message,
    missing,
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 获取 vivo 更新接口会提交的字段。
 *
 * @param {object} config vivo 配置。
 * @returns {string[]} 字段列表。
 */
function getVivoUpdateFields(config) {
  return Object.keys(buildUpdateParams(config, { serialnumber: "{uploadedApk.serialnumber}", fileMd5: "{uploadedApk.fileMd5}" }));
}

/**
 * 格式化 vivo 查询详情里的审核状态。
 *
 * @param {object} appInfo 应用详情。
 * @returns {string} 可读状态。
 */
function formatVivoAppStatus(appInfo = {}) {
  const parts = [];
  if (!isBlank(appInfo.saleStatus)) parts.push(`上架状态 ${appInfo.saleStatus}`);
  if (!isBlank(appInfo.status)) parts.push(`审核状态 ${VIVO_STATUS_LABELS[Number(appInfo.status)] || appInfo.status}`);
  if (!isBlank(appInfo.unPassReason)) parts.push(`不通过原因：${appInfo.unPassReason}`);
  return parts.join("，");
}

/**
 * 解析 vivo 异步任务状态。
 *
 * @param {object} taskState 任务状态响应 data。
 * @returns {{label: string, text: string}} 可读状态。
 */
function formatVivoTaskState(taskState = {}) {
  const code = Number(taskState.status);
  const label = VIVO_TASK_STATUS_LABELS[code] || (taskState.status === undefined ? "未返回任务状态" : `未知状态(${taskState.status})`);
  const details = [];
  if (!isBlank(taskState.packageName)) details.push(`包名: ${taskState.packageName}`);
  if (!isBlank(taskState.errorReason)) details.push(`错误原因: ${taskState.errorReason}`);
  return {
    label,
    text: details.length > 0 ? `${label}，${details.join("，")}` : label,
  };
}

/**
 * 计算文件 MD5。
 *
 * @param {string} filePath 本地文件路径。
 * @returns {Promise<string>} 小写 MD5。
 */
function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * 安全读取文件大小。
 *
 * @param {string} filePath 本地文件路径。
 * @returns {number} 文件字节数。
 */
function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

/**
 * 读取 PNG/JPEG 宽高。
 *
 * 不引入额外依赖，避免本地发布面板需要安装 sharp 等原生包。
 *
 * @param {string} filePath 图片路径。
 * @returns {{ok: boolean, width?: number, height?: number, type?: string, message?: string}} 图片元数据。
 */
function readImageMetadata(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24) return { ok: false, message: "图片文件过小或已损坏。" };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ok: true, type: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return readJpegMetadata(buffer);
  return { ok: false, message: "只支持读取 PNG/JPG 图片尺寸。" };
}

/**
 * 从 JPEG SOF 段读取宽高。
 *
 * @param {Buffer} buffer JPEG 文件内容。
 * @returns {{ok: boolean, width?: number, height?: number, type?: string, message?: string}} JPEG 元数据。
 */
function readJpegMetadata(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return { ok: false, message: "JPEG 段格式异常。" };
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return { ok: false, message: "JPEG 段长度异常。" };
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { ok: true, type: "jpeg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { ok: false, message: "未找到 JPEG 尺寸信息。" };
}

/**
 * 构建 ASCII 排序后的签名源串。
 *
 * @param {object} params 请求参数。
 * @returns {string} 排序后的 k=v&k2=v2。
 */
function buildSortedQuery(params = {}) {
  return Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

/**
 * 压缩 vivo 响应对象，避免上传记录过大。
 *
 * @param {object} response 原始响应。
 * @returns {object} 响应摘要。
 */
function sanitizeVivoResponse(response = {}) {
  return limitObjectSize(response);
}

/**
 * 移除 URL 结尾斜杠。
 *
 * @param {string} url 地址。
 * @returns {string} 规范化地址。
 */
function trimBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

module.exports = {
  runVivoUpload,
  buildVivoPrecheck,
  normalizeVivoConfig,
};
