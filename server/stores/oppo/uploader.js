const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { clearStoreState, readCurrentNotes, readStoreConfig, readStoreState, recordUploadRun, writeStoreState } = require("../../db");
const { compactObject, formatBytes, isBlank, limitObjectSize, maskSecret, parseJsonResponse, resolveLocalPath, throwIfAborted } = require("../common");
const { buildTokenCacheKey, clearCachedToken, computeExpiresAt, getOrRefreshToken } = require("../token-cache");

const STORE_KEY = "oppo";
const OPPO_DOCS_URL = "https://open.oppomobile.com/documentation/page/info?id=10999";
const DEFAULT_API_BASE_URL = "https://oop-openapi-cn.heytapmobi.com";
const DEFAULT_TIMEOUT_MS = 120000;

const ACTION_LABELS = {
  upload: "一键执行 OPPO 发布",
  precheck: "OPPO 预检",
  "token-check": "获取/校验 Token",
  "query-app-info": "查询应用详情",
  "upload-apk": "上传 APK",
  "upload-assets": "上传资源文件",
  "publish-version": "发布版本",
  "query-task": "查询任务状态",
  "revoke-review": "撤销审核",
  "reset-state": "重置流程状态",
};

const OPPO_TASK_STATE_LABELS = {
  1: "待处理",
  2: "处理成功",
  3: "处理失败",
};

const OPPO_FIELD_LABELS = {
  enabled: "启用接口更新",
  clientId: "Client ID",
  clientSecret: "Client Secret",
  packageName: "包名",
  versionCode: "版本号 version_code",
  apkPath: "APK 路径",
  appName: "应用名称",
  secondCategoryId: "二级分类",
  thirdCategoryId: "三级分类",
  summary: "一句话简介",
  detailDesc: "应用介绍",
  updateDesc: "更新说明",
  privacyUrl: "隐私政策 URL",
  businessUsername: "联系人姓名",
  businessEmail: "联系人邮箱",
  businessMobile: "联系人手机号",
  ageLevel: "适龄等级",
  adaptiveEquipment: "适配设备",
  iconPath: "图标文件",
  screenshotPaths: "竖版截图",
  copyrightPath: "软件版权证明",
  testDesc: "测试说明/审核备注",
  uploadedApk: "已上传 APK",
  "uploadedApk.url": "已上传 APK URL",
  "uploadedApk.md5": "已上传 APK MD5",
};

/**
 * 执行 OPPO API 传包服务入口。
 *
 * OPPO 官方链路是：获取 access_token -> 获取文件上传配置 ->
 * 上传 APK 和图片/资质资源 -> 调用 /resource/v1/app/upd 发布版本 -> 查询任务状态。
 *
 * @param {{action?: string, updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} OPPO 步骤结果。
 */
async function runOppoUpload(options = {}) {
  const action = options.action || "precheck";
  if (action === "upload") return runOppoFullUpload(options);
  return runOppoAction(action, options);
}

/**
 * 执行 OPPO 一键发布流程。
 *
 * 一键流程会清空旧步骤状态，避免上一次上传 APK 返回的 url/md5 被误用于本次发布。
 *
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} 一键流程结果。
 */
async function runOppoFullUpload(options = {}) {
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const config = getOppoConfig();
  const startedAt = new Date().toISOString();
  const steps = [];

  try {
    clearStoreState(STORE_KEY);
    updateProgress({ phase: "precheck", percent: 6, statusText: "OPPO 预检", detail: "正在检查发布配置和 APK 路径" });
    throwIfAborted(signal);
    const precheck = buildOppoPrecheck(config);
    steps.push(pickStepSummary(precheck));
    if (!precheck.ok) {
      const result = { ...precheck, action: "upload", message: `OPPO 一键发布预检未通过，已取消后续步骤：${formatOppoReasons(precheck.missing, precheck.warnings)}`, steps };
      recordUploadRun(createUploadRunRecord("upload", startedAt, result));
      return result;
    }

    updateProgress({ phase: "token", percent: 16, statusText: "获取 OPPO Token", detail: "正在调用 /developer/v1/token" });
    const tokenResult = await tokenCheck(config, signal);
    steps.push(pickStepSummary(tokenResult));
    if (!tokenResult.ok) return recordAndReturnFullUploadFailure(startedAt, tokenResult.message, steps, tokenResult);

    updateProgress({ phase: "query-app", percent: 28, statusText: "查询 OPPO 应用详情", detail: `按包名查询：${config.packageName}` });
    const appInfoResult = await queryAppInfoStep(config, signal);
    steps.push(pickStepSummary(appInfoResult));
    if (!appInfoResult.ok) return recordAndReturnFullUploadFailure(startedAt, appInfoResult.message, steps, appInfoResult);

    updateProgress({ phase: "upload-apk", percent: 42, statusText: "上传 OPPO APK", detail: "正在获取一次性上传地址并上传文件" });
    const uploadApkResult = await uploadApkStep(config, {
      signal,
      updateProgress: (patch = {}) =>
        updateProgress({
          ...patch,
          percent: 42 + Math.round(Number(patch.percent || 0) * 0.34),
        }),
    });
    steps.push(pickStepSummary(uploadApkResult));
    if (!uploadApkResult.ok) return recordAndReturnFullUploadFailure(startedAt, uploadApkResult.message, steps, uploadApkResult);

    updateProgress({ phase: "upload-assets", percent: 76, statusText: "上传 OPPO 资源文件", detail: "正在上传图标、截图和资质文件" });
    const uploadAssetsResult = await uploadAssetsStep(config, {
      signal,
      updateProgress: (patch = {}) =>
        updateProgress({
          ...patch,
          percent: 76 + Math.round(Number(patch.percent || 0) * 0.12),
        }),
    });
    steps.push(pickStepSummary(uploadAssetsResult));
    if (!uploadAssetsResult.ok) return recordAndReturnFullUploadFailure(startedAt, uploadAssetsResult.message, steps, uploadAssetsResult);

    updateProgress({ phase: "publish-version", percent: 90, statusText: "发布 OPPO 版本", detail: "正在调用 /resource/v1/app/upd" });
    const publishResult = await publishVersionStep(config, signal);
    steps.push(pickStepSummary(publishResult));
    if (!publishResult.ok) return recordAndReturnFullUploadFailure(startedAt, publishResult.message, steps, publishResult);

    updateProgress({ phase: "query-task", percent: 97, statusText: "查询 OPPO 任务状态", detail: "正在调用 /resource/v1/app/task-state" });
    const taskResult = await queryTaskStep(config, signal);
    steps.push(pickStepSummary(taskResult));

    updateProgress({ phase: "done", percent: 100, statusText: "OPPO 发布已提交", detail: taskResult.ok ? taskResult.message : "版本发布请求已返回，任务状态查询未完成" });
    const result = {
      ok: publishResult.ok,
      store: STORE_KEY,
      action: "upload",
      message: taskResult.ok ? `OPPO 一键发布已提交：${formatOppoTaskState(taskResult.taskState).text}` : "OPPO 一键发布已提交，任务状态查询未完成。",
      steps,
      uploadedFiles: [...(uploadApkResult.uploadedFiles || []), ...(uploadAssetsResult.uploadedFiles || [])],
      updateFields: publishResult.updateFields || [],
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
      message: `OPPO 一键发布流程失败：${error.message}`,
      steps,
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
    recordUploadRun(createUploadRunRecord("upload", startedAt, result));
    return result;
  }
}

/**
 * 执行 OPPO 单步骤动作。
 *
 * @param {string} action 动作名。
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} 单步骤结果。
 */
async function runOppoAction(action = "precheck", options = {}) {
  const startedAt = new Date().toISOString();
  const config = getOppoConfig();
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  let result;

  try {
    if (action === "precheck") result = buildOppoPrecheck(config);
    else if (action === "reset-state") result = resetOppoState();
    else if (action === "token-check") result = await tokenCheck(config, signal);
    else if (action === "query-app-info") result = await queryAppInfoStep(config, signal);
    else if (action === "upload-apk") result = await uploadApkStep(config, { signal, updateProgress, resetState: true });
    else if (action === "upload-assets") result = await uploadAssetsStep(config, { signal, updateProgress });
    else if (action === "publish-version") result = await publishVersionStep(config, signal);
    else if (action === "query-task") result = await queryTaskStep(config, signal);
    else if (action === "revoke-review") result = revokeReviewStep(updateProgress);
    else result = buildFailure(`未知 OPPO 发布动作：${action}`, []);
  } catch (error) {
    result = buildFailure(error.message || "OPPO 发布步骤执行失败。", []);
  }

  if (!["precheck", "reset-state"].includes(action)) recordUploadRun(createUploadRunRecord(action, startedAt, result));
  return result;
}

/**
 * 读取并规范化 OPPO 配置。
 *
 * @returns {object} OPPO 配置。
 */
function getOppoConfig() {
  return normalizeOppoConfig(readStoreConfig().stores.oppo || {});
}

/**
 * 补齐 OPPO 默认地址和字段别名。
 *
 * @param {object} config 原始配置。
 * @returns {object} 规范化后的配置。
 */
function normalizeOppoConfig(config = {}) {
  return {
    ...config,
    docsUrl: config.docsUrl || OPPO_DOCS_URL,
    apiBaseUrl: trimBaseUrl(config.apiBaseUrl || DEFAULT_API_BASE_URL),
    tokenPath: config.tokenPath || "/developer/v1/token",
    uploadConfigPath: config.uploadConfigPath || "/resource/v1/upload/get-upload-url",
    appInfoPath: config.appInfoPath || "/resource/v1/app/info",
    publishPath: config.publishPath || "/resource/v1/app/upd",
    taskStatePath: config.taskStatePath || "/resource/v1/app/task-state",
    clientId: config.clientId || config.appKey || "",
    packageName: config.packageName || config.pkg_name || "",
    versionCode: config.versionCode || config.version_code || "",
    apkPath: config.apkPath || config.packagePath || "",
    cpuCode: config.cpuCode === undefined || config.cpuCode === "" ? 0 : Number(config.cpuCode),
    onlineType: config.onlineType === undefined || config.onlineType === "" ? 1 : Number(config.onlineType),
    updateDesc: String(config.updateDesc || config.releaseNotes || readCurrentNotes() || "").trim(),
  };
}

/**
 * 构建 OPPO 预检结果。
 *
 * OPPO /resource/v1/app/upd 发布版本接口要求字段较多。这里把文档中的
 * 普通应用必填项都提前列出，避免真实调用后才看到一长串平台错误。
 *
 * @param {object} config OPPO 配置。
 * @returns {object} 预检结果。
 */
function buildOppoPrecheck(config) {
  const missing = [];
  const warnings = [];
  if (!config.enabled) missing.push("enabled");
  [
    "clientId",
    "clientSecret",
    "packageName",
    "versionCode",
    "apkPath",
    "appName",
    "secondCategoryId",
    "thirdCategoryId",
    "summary",
    "detailDesc",
    "updateDesc",
    "privacyUrl",
    "businessUsername",
    "businessEmail",
    "businessMobile",
    "ageLevel",
    "adaptiveEquipment",
  ].forEach((field) => {
    if (isBlank(config[field])) missing.push(field);
  });

  const apkPath = resolveLocalPath(config.apkPath);
  if (!isBlank(config.apkPath) && !fs.existsSync(apkPath)) missing.push(`APK 不存在：${apkPath}`);
  const uploadedAssets = readStoreState(STORE_KEY).uploadedAssets || {};
  getOppoAssetDescriptors(config)
    .filter((asset) => asset.required || asset.paths.length > 0)
    .forEach((asset) => {
      const hasLegacyUrl = toPathList(config[legacyOppoUrlKey(asset.submitKey)]).some((item) => /^https?:\/\//i.test(item));
      const hasUploadedUrl = uploadedUrls(uploadedAssets[asset.submitKey]).length > 0;
      if (asset.required && asset.paths.length === 0 && !hasLegacyUrl && !hasUploadedUrl) missing.push(asset.configKey);
      asset.paths.forEach((filePath) => {
        const resolvedPath = resolveLocalPath(filePath);
        if (!fs.existsSync(resolvedPath)) missing.push(`${asset.label}不存在：${resolvedPath}`);
        else {
          const validation = validateOppoAssetFile(asset, resolvedPath);
          missing.push(...validation.errors);
          warnings.push(...validation.warnings);
        }
      });
    });
  const screenshotCount = Math.max(toPathList(config.screenshotPaths).length, uploadedUrls(uploadedAssets.pic_url).length, toPathList(config.picUrl).length);
  if (screenshotCount > 0 && screenshotCount < 2) missing.push("OPPO pic_url 竖版截图不能少于两张，建议上传 3-5 张。");
  if (isBlank(config.testDesc) && isBlank(config.auditNotes)) missing.push("testDesc");
  if (!isBlank(config.summary) && String(config.summary).length > 13) warnings.push("OPPO 发布版本文档要求 summary 不多于 13 个字符。");
  if (!isBlank(config.detailDesc) && String(config.detailDesc).length < 20) warnings.push("OPPO detail_desc 要求不少于 20 个字。");
  if (!isBlank(config.updateDesc) && String(config.updateDesc).length < 5) warnings.push("OPPO update_desc 要求不少于 5 个字。");

  return {
    ok: missing.length === 0,
    store: STORE_KEY,
    action: "precheck",
    message: missing.length === 0 ? "OPPO 发布配置预检通过。" : `OPPO 发布配置预检未通过：${formatOppoReasons(missing, warnings)}`,
    missing,
    warnings,
    plannedFiles: [
      ...(isBlank(config.apkPath) ? [] : [{ localKey: "apkPath", formName: "file", type: "apk", path: apkPath, exists: fs.existsSync(apkPath) }]),
      ...getOppoAssetDescriptors(config).flatMap((asset) =>
        asset.paths.map((filePath) => {
          const resolvedPath = resolveLocalPath(filePath);
          return { localKey: asset.configKey, formName: "file", type: asset.uploadType, path: resolvedPath, exists: fs.existsSync(resolvedPath) };
        }),
      ),
    ],
    updateFields: getOppoPublishFields(config),
    docsUrl: OPPO_DOCS_URL,
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 获取并校验 OPPO access_token。
 *
 * @param {object} config OPPO 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} Token 校验结果。
 */
async function tokenCheck(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "token-check" };

  const token = await requestAccessToken(config, signal);
  const state = writeStoreState(STORE_KEY, {
    tokenCheckedAt: new Date().toISOString(),
    tokenExpiresAt: token.expireIn ? new Date(Number(token.expireIn) * 1000).toISOString() : "",
    tokenFromCache: Boolean(token.fromCache),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "token-check",
    message: token.fromCache ? "OPPO Token 获取成功，已复用缓存。" : "OPPO Token 获取成功，已刷新缓存。",
    token: {
      access_token: maskSecret(token.accessToken),
      expire_in: token.expireIn,
    },
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 查询 OPPO 普通包应用详情步骤。
 *
 * @param {object} config OPPO 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 应用详情结果。
 */
async function queryAppInfoStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "packageName"]);
  if (!required.ok) return { ...required, action: "query-app-info" };

  const token = await requestAccessToken(config, signal);
  const appInfo = await requestOppoApi(config, config.appInfoPath, {
    method: "GET",
    token: token.accessToken,
    params: compactObject({
      pkg_name: config.packageName,
      version_code: config.versionCode || undefined,
    }),
    signal,
  });
  const state = writeStoreState(STORE_KEY, {
    appInfoQueriedAt: new Date().toISOString(),
    appInfo: sanitizeOppoResponse(appInfo.data),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-app-info",
    message: `OPPO 应用详情查询完成：${appInfo.data?.app_name || config.packageName}`,
    appInfo: sanitizeOppoResponse(appInfo.data),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 上传 OPPO APK 步骤。
 *
 * @param {object} config OPPO 配置。
 * @param {{signal?: AbortSignal, updateProgress?: Function, resetState?: boolean}} options 执行选项。
 * @returns {Promise<object>} 上传结果。
 */
async function uploadApkStep(config, options = {}) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "apkPath"]);
  if (!required.ok) return { ...required, action: "upload-apk" };
  const apkPath = resolveLocalPath(config.apkPath);
  if (!fs.existsSync(apkPath)) return buildFailure(`OPPO APK 文件不存在：${apkPath}`, ["apkPath"]);
  if (options.resetState) clearStoreState(STORE_KEY);

  const token = await requestAccessToken(config, options.signal);
  const uploadConfig = await getUploadConfig(config, token.accessToken, options.signal);
  options.updateProgress?.({ phase: "uploading", percent: 10, statusText: "上传 OPPO APK", detail: path.basename(apkPath) });
  const uploadResponse = await uploadFileToOppo(uploadConfig, apkPath, "apk", options.signal, (uploaded, total) => {
    options.updateProgress?.({
      phase: "uploading",
      percent: 10 + Math.round((uploaded / Math.max(total, 1)) * 85),
      statusText: "上传 OPPO APK",
      detail: `${path.basename(apkPath)} ${formatBytes(uploaded)} / ${formatBytes(total)}`,
    });
  });
  const uploadedApk = uploadResponse.data || uploadResponse;
  const state = writeStoreState(STORE_KEY, {
    uploadedApk: {
      ...uploadedApk,
      sourcePath: apkPath,
      uploadedAt: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "upload-apk",
    message: `OPPO APK 上传完成：${uploadedApk.url || path.basename(apkPath)}`,
    uploadedFiles: [{ fileName: path.basename(apkPath), path: apkPath, url: uploadedApk.url, md5: uploadedApk.md5 }],
    response: sanitizeOppoResponse(uploadedApk),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 上传 OPPO 发布版本所需的图片、截图和资质文件。
 *
 * OPPO 文件上传接口要求每个新文件都重新获取一次 upload_url/sign，所以这里按
 * 文件顺序逐个申请上传配置、逐个 multipart 上传，并把远端 URL 写入流程状态。
 *
 * @param {object} config OPPO 配置。
 * @param {{signal?: AbortSignal, updateProgress?: Function}} options 上传选项。
 * @returns {Promise<object>} 资源上传结果。
 */
async function uploadAssetsStep(config, options = {}) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "upload-assets" };

  const assets = getOppoAssetDescriptors(config).filter((asset) => asset.required || asset.paths.length > 0);
  const missing = [];
  assets.forEach((asset) => {
    if (asset.required && asset.paths.length === 0) missing.push(asset.configKey);
    asset.paths.forEach((filePath) => {
      const resolvedPath = resolveLocalPath(filePath);
      if (/^https?:\/\//i.test(resolvedPath)) missing.push(`${asset.label}必须选择本地文件，不能直接填写远端 URL：${resolvedPath}`);
      else if (!fs.existsSync(resolvedPath)) missing.push(`${asset.label}不存在：${resolvedPath}`);
      else {
        const validation = validateOppoAssetFile(asset, resolvedPath);
        missing.push(...validation.errors);
      }
    });
  });
  if (missing.length > 0) return { ...buildFailure("OPPO 资源文件预检未通过。", missing), action: "upload-assets" };

  const files = assets.flatMap((asset) =>
    asset.paths.map((filePath, index) => ({
      ...asset,
      index,
      path: resolveLocalPath(filePath),
    })),
  );
  if (files.length === 0) {
    return {
      ok: true,
      store: STORE_KEY,
      action: "upload-assets",
      skipped: true,
      message: "没有需要上传的 OPPO 资源文件。",
      uploadedFiles: [],
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
  }

  const token = await requestAccessToken(config, options.signal);
  const uploadedAssets = {};
  const uploadedFiles = [];
  let completed = 0;

  for (const file of files) {
    throwIfAborted(options.signal);
    const uploadConfig = await getUploadConfig(config, token.accessToken, options.signal);
    options.updateProgress?.({
      phase: "uploading",
      percent: Math.round((completed / files.length) * 100),
      statusText: `上传 OPPO ${file.label}`,
      detail: path.basename(file.path),
    });
    const uploadResponse = await uploadFileToOppo(uploadConfig, file.path, file.uploadType, options.signal, (uploaded, total) => {
      options.updateProgress?.({
        phase: "uploading",
        percent: Math.round(((completed + uploaded / Math.max(total, 1)) / files.length) * 100),
        statusText: `上传 OPPO ${file.label}`,
        detail: `${path.basename(file.path)} ${formatBytes(uploaded)} / ${formatBytes(total)}`,
      });
    });
    const uploaded = uploadResponse.data || uploadResponse;
    uploadedAssets[file.submitKey] ||= [];
    uploadedAssets[file.submitKey].push({
      ...uploaded,
      sourcePath: file.path,
      uploadedAt: new Date().toISOString(),
    });
    uploadedFiles.push({ fileName: path.basename(file.path), path: file.path, url: uploaded.url, md5: uploaded.md5, submitKey: file.submitKey });
    completed += 1;
  }

  const state = writeStoreState(STORE_KEY, { uploadedAssets });
  return {
    ok: true,
    store: STORE_KEY,
    action: "upload-assets",
    message: `OPPO 资源文件上传完成：${uploadedFiles.length} 个文件。`,
    uploadedFiles,
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 调用 OPPO 发布版本步骤。
 *
 * @param {object} config OPPO 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 发布结果。
 */
async function publishVersionStep(config, signal) {
  const precheck = buildOppoPrecheck(config);
  if (!precheck.ok) return { ...precheck, action: "publish-version", message: `OPPO 发布版本预检未通过：${formatOppoReasons(precheck.missing, precheck.warnings)}` };

  const state = readStoreState(STORE_KEY);
  const uploadedApk = state.uploadedApk;
  if (!uploadedApk?.url || !uploadedApk?.md5) return buildFailure("缺少已上传 APK 的 url/md5，请先执行“上传 APK”。", ["uploadedApk.url", "uploadedApk.md5"]);
  const assetRequirements = ensureRequiredUploadedAssets(config, state.uploadedAssets || {});
  if (!assetRequirements.ok) return { ...assetRequirements, action: "publish-version", message: "OPPO 发布版本缺少已上传资源文件，请先执行“上传资源文件”。" };

  const token = await requestAccessToken(config, signal);
  const publishParams = buildPublishVersionParams(config, uploadedApk, state.uploadedAssets || {});
  const response = await requestOppoApi(config, config.publishPath, {
    method: "POST",
    token: token.accessToken,
    params: publishParams,
    signal,
  });
  const nextState = writeStoreState(STORE_KEY, {
    versionPublishedAt: new Date().toISOString(),
    lastPublishResponse: sanitizeOppoResponse(response.data || response),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "publish-version",
    message: response.data?.message ? `OPPO 发布版本已返回：${response.data.message}` : "OPPO 发布版本请求已返回。",
    response: sanitizeOppoResponse(response.data || response),
    updateFields: Object.keys(publishParams),
    state: sanitizeStateForResponse(nextState),
  };
}

/**
 * 查询 OPPO 发布版本任务状态。
 *
 * @param {object} config OPPO 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 任务状态。
 */
async function queryTaskStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "packageName", "versionCode"]);
  if (!required.ok) return { ...required, action: "query-task" };

  const token = await requestAccessToken(config, signal);
  const response = await requestOppoApi(config, config.taskStatePath, {
    method: "POST",
    token: token.accessToken,
    params: {
      pkg_name: config.packageName,
      version_code: String(config.versionCode),
    },
    signal,
  });
  const taskState = response.data || {};
  const taskSummary = formatOppoTaskState(taskState);
  const state = writeStoreState(STORE_KEY, {
    taskStateQueriedAt: new Date().toISOString(),
    lastTaskState: taskState,
    lastTaskStateLabel: taskSummary.label,
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-task",
    message: `OPPO 任务状态查询完成：${taskSummary.text}`,
    taskState,
    taskStateLabel: taskSummary.label,
    state: sanitizeStateForResponse(state),
  };
}

/**
 * OPPO 当前文档没有开放撤销审核接口。
 *
 * @param {Function} updateProgress 进度回调。
 * @returns {object} 不支持结果。
 */
function revokeReviewStep(updateProgress) {
  updateProgress?.({
    phase: "unsupported",
    percent: 100,
    statusText: "OPPO 暂不支持撤销审核",
    detail: "当前 API 传包文档未提供撤销审核接口，请到 OPPO 开放平台后台人工处理。",
  });
  return {
    ok: false,
    store: STORE_KEY,
    action: "revoke-review",
    message: "OPPO 暂未接入撤销审核接口：当前 OPPO API传包文档未提供撤销审核路由。",
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 获取 OPPO access_token。
 *
 * OPPO token 有调用次数/有效期限制，当前进程会缓存到 expire_in 前一分钟。
 * 文件上传的 upload_url/sign 仍然每个文件单独获取，不和 access_token 缓存混用。
 *
 * @param {object} config OPPO 配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<{accessToken: string, expireIn: number|string}>} Token。
 */
async function requestAccessToken(config, signal) {
  const cacheKey = getOppoTokenCacheKey(config);
  return getOrRefreshToken(cacheKey, async () => {
    const url = new URL(`${config.apiBaseUrl}${config.tokenPath}`);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("client_secret", config.clientSecret);
    const json = await requestJson(url.toString(), { method: "GET", signal }, "OPPO Token");
    assertOppoSuccess(json, "OPPO 获取 Token 失败");
    const accessToken = json.data?.access_token || json.data?.accessToken || "";
    if (isBlank(accessToken)) throw new Error(`OPPO Token 响应缺少 access_token：${JSON.stringify(json).slice(0, 300)}`);
    const expireIn = json.data?.expire_in || json.data?.expireIn || "";
    return {
      accessToken,
      expireIn,
      expiresAt: computeExpiresAt(expireIn, "epochSeconds"),
    };
  });
}

/**
 * 生成 OPPO token 缓存 key。
 *
 * @param {object} config OPPO 配置。
 * @returns {string} 缓存 key。
 */
function getOppoTokenCacheKey(config) {
  return buildTokenCacheKey(STORE_KEY, [config.apiBaseUrl, config.tokenPath, config.clientId, config.clientSecret]);
}

/**
 * 获取 OPPO 一次性文件上传配置。
 *
 * @param {object} config OPPO 配置。
 * @param {string} accessToken access_token。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<{upload_url: string, sign: string}>} 上传配置。
 */
async function getUploadConfig(config, accessToken, signal) {
  const response = await requestOppoApi(config, config.uploadConfigPath, {
    method: "GET",
    token: accessToken,
    params: {},
    signal,
  });
  const uploadConfig = response.data || {};
  if (!uploadConfig.upload_url || !uploadConfig.sign) {
    throw new Error(`OPPO 上传配置缺少 upload_url/sign：${JSON.stringify(response).slice(0, 300)}`);
  }
  return uploadConfig;
}

/**
 * 上传文件到 OPPO 返回的 upload_url。
 *
 * @param {{upload_url: string, sign: string}} uploadConfig 上传配置。
 * @param {string} filePath 本地文件路径。
 * @param {"apk"|"photo"|"resource"} type 文件类型。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @param {Function} onProgress 上传进度回调。
 * @returns {Promise<object>} OPPO 文件上传响应。
 */
async function uploadFileToOppo(uploadConfig, filePath, type, signal, onProgress = () => {}) {
  const response = await requestMultipartFile(uploadConfig.upload_url, {
    fields: {
      type,
      sign: uploadConfig.sign,
    },
    filePath,
    signal,
    onProgress,
  });
  assertOppoSuccess(response, "OPPO 文件上传失败");
  return response;
}

/**
 * 按 OPPO 发布字段定义需要走文件上传的资源。
 *
 * uploadType 对应文件上传接口的 type：图片用 photo，APK 用 apk，PDF/压缩包等用 resource。
 * submitKey 对应最终发布版本接口的字段名。
 *
 * @param {object} config OPPO 配置。
 * @returns {object[]} 资源描述列表。
 */
function getOppoAssetDescriptors(config) {
  return [
    { configKey: "iconPath", submitKey: "icon_url", label: "图标", uploadType: "photo", required: true, paths: toUploadPathList(config.iconPath) },
    { configKey: "screenshotPaths", submitKey: "pic_url", label: "竖版截图", uploadType: "photo", required: true, paths: toUploadPathList(config.screenshotPaths) },
    { configKey: "landscapeScreenshotPaths", submitKey: "landscape_pic_url", label: "横版截图", uploadType: "photo", required: false, paths: toUploadPathList(config.landscapeScreenshotPaths) },
    { configKey: "copyrightPath", submitKey: "copyright_url", label: "软件版权证明", uploadType: "resource", required: true, paths: toUploadPathList(config.copyrightPath) },
    { configKey: "electronicCertPath", submitKey: "electronic_cert_url", label: "电子版权证书", uploadType: "resource", required: false, paths: toUploadPathList(config.electronicCertPath) },
    { configKey: "specialPaths", submitKey: "special_url", label: "特殊类证书", uploadType: "photo", required: false, paths: toUploadPathList(config.specialPaths) },
    { configKey: "specialFilePath", submitKey: "special_file_url", label: "特殊类证书压缩包", uploadType: "resource", required: false, paths: toUploadPathList(config.specialFilePath) },
  ];
}

/**
 * 校验 OPPO 资源文件的本地规格。
 *
 * OPPO 发布接口会在 /resource/v1/app/upd 阶段校验远端 URL 指向的资源规格。
 * 如果不提前校验，用户会看到“icon_url 图片宽度不符合要求”这类远端错误，
 * 但很难定位到本机哪张图有问题。这里在上传资源前直接检查尺寸、格式和大小。
 *
 * @param {object} asset OPPO 资源描述。
 * @param {string} filePath 本地文件路径。
 * @returns {{errors: string[], warnings: string[]}} 校验结果。
 */
function validateOppoAssetFile(asset, filePath) {
  if (asset.submitKey === "icon_url") return validateOppoIconFile(filePath);
  if (["pic_url", "landscape_pic_url", "special_url"].includes(asset.submitKey)) return validateOppoPhotoFile(asset, filePath);
  return validateOppoResourceFile(asset, filePath);
}

/**
 * 校验 OPPO 图标文件。
 *
 * 官方要求 icon_url 为 512x512 PNG 且小于 1M；这次用户遇到的
 * “图片宽度不符合要求”就是该校验没有提前拦截导致的。
 *
 * @param {string} filePath 本地图标路径。
 * @returns {{errors: string[], warnings: string[]}} 校验结果。
 */
function validateOppoIconFile(filePath) {
  const result = { errors: [], warnings: [] };
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".png") result.errors.push(`OPPO 图标必须是 PNG：${filePath}`);
  const size = safeFileSize(filePath);
  if (size > 1024 * 1024) result.errors.push(`OPPO 图标必须小于 1M：${filePath} 当前 ${formatBytes(size)}`);
  const image = readImageMetadata(filePath);
  if (!image.ok) result.errors.push(`OPPO 图标读取失败：${image.message}`);
  else if (image.width !== 512 || image.height !== 512) result.errors.push(`OPPO 图标尺寸必须是 512x512：${filePath} 当前 ${image.width}x${image.height}`);
  return result;
}

/**
 * 校验 OPPO 图片资源。
 *
 * 截图类资源文档要求 jpg/png 且小于 1M；尺寸不同业务位可能略有差异，
 * 因此前端文案给建议尺寸，这里只对过大的文件和明显不支持的格式做硬拦截。
 *
 * @param {object} asset OPPO 资源描述。
 * @param {string} filePath 本地图片路径。
 * @returns {{errors: string[], warnings: string[]}} 校验结果。
 */
function validateOppoPhotoFile(asset, filePath) {
  const result = { errors: [], warnings: [] };
  const ext = path.extname(filePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) result.errors.push(`${asset.label}必须是 JPG 或 PNG：${filePath}`);
  const size = safeFileSize(filePath);
  if (size > 1024 * 1024) result.errors.push(`${asset.label}必须小于 1M：${filePath} 当前 ${formatBytes(size)}`);
  const image = readImageMetadata(filePath);
  if (!image.ok) result.errors.push(`${asset.label}读取失败：${image.message}`);
  return result;
}

/**
 * 校验 OPPO 资质文件。
 *
 * 资质文件的大小限制在文档和后台会按资源位变化，这里先校验文件非空；
 * 更严格的类型约束由字段后缀、文件选择器和 OPPO 远端接口继续兜底。
 *
 * @param {object} asset OPPO 资源描述。
 * @param {string} filePath 本地文件路径。
 * @returns {{errors: string[], warnings: string[]}} 校验结果。
 */
function validateOppoResourceFile(asset, filePath) {
  const result = { errors: [], warnings: [] };
  if (safeFileSize(filePath) <= 0) result.errors.push(`${asset.label}文件为空：${filePath}`);
  return result;
}

/**
 * 读取图片基础元数据。
 *
 * 当前只解析 PNG/JPEG 的宽高，足够覆盖 OPPO 图标和截图预检。
 * 不引入 sharp/imagesize 等依赖，避免这个本地工具需要额外安装原生包。
 *
 * @param {string} filePath 图片路径。
 * @returns {{ok: boolean, width?: number, height?: number, type?: string, message?: string}} 图片元数据。
 */
function readImageMetadata(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24) return { ok: false, message: "图片文件过小或已损坏。" };

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      ok: true,
      type: "png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegMetadata(buffer);
  }

  return { ok: false, message: "只支持读取 PNG/JPG 图片尺寸。" };
}

/**
 * 从 JPEG 数据中读取宽高。
 *
 * JPEG 尺寸存储在 SOF 段中，需要顺序跳过 APP/量化表等段。
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
      return {
        ok: true,
        type: "jpeg",
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return { ok: false, message: "未找到 JPEG 尺寸信息。" };
}

/**
 * 校验发布版本必需的资源是否已经上传完成。
 *
 * @param {object} config OPPO 配置。
 * @param {object} uploadedAssets 已上传资源状态。
 * @returns {object} 校验结果。
 */
function ensureRequiredUploadedAssets(config, uploadedAssets = {}) {
  const missing = getOppoAssetDescriptors(config)
    .filter((asset) => asset.required)
    .filter((asset) => {
      if (uploadedUrls(uploadedAssets[asset.submitKey]).length > 0) return false;
      return toPathList(config[legacyOppoUrlKey(asset.submitKey)]).every((item) => !/^https?:\/\//i.test(item));
    })
    .map((asset) => `${asset.submitKey}（${asset.label}）`);
  return missing.length === 0 ? { ok: true, store: STORE_KEY } : buildFailure("OPPO 发布版本缺少已上传资源文件。", missing);
}

/**
 * 根据 OPPO 发布字段找到兼容旧配置的 URL 字段名。
 *
 * @param {string} submitKey OPPO 发布版本接口字段。
 * @returns {string} 旧配置字段名。
 */
function legacyOppoUrlKey(submitKey) {
  return {
    icon_url: "iconUrl",
    pic_url: "picUrl",
    landscape_pic_url: "landscapePicUrl",
    copyright_url: "copyrightUrl",
    electronic_cert_url: "electronicCertUrl",
    special_url: "specialUrl",
    special_file_url: "specialFileUrl",
  }[submitKey] || submitKey;
}

/**
 * 把路径配置统一成数组。
 *
 * 支持数组、多行字符串、逗号分隔字符串；http URL 会作为旧配置兼容值保留，
 * 但后续存在性检查会提示用户改为本地文件路径。
 *
 * @param {unknown} value 原始路径配置。
 * @returns {string[]} 路径数组。
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
 * 新版字段只接受本地路径；远端 URL 属于旧配置兼容值，不应再次上传。
 *
 * @param {unknown} value 原始路径配置。
 * @returns {string[]} 本地路径数组。
 */
function toUploadPathList(value) {
  return toPathList(value).filter((item) => !/^https?:\/\//i.test(item));
}

/**
 * 读取已上传资源 URL 列表。
 *
 * @param {object[]|object|undefined} assets 上传资源对象。
 * @returns {string[]} URL 列表。
 */
function uploadedUrls(assets) {
  const list = Array.isArray(assets) ? assets : assets ? [assets] : [];
  return list.map((asset) => asset?.url).filter(Boolean);
}

/**
 * 读取第一个已上传资源 URL。
 *
 * @param {object[]|object|undefined} assets 上传资源对象。
 * @returns {string} URL。
 */
function firstUploadedUrl(assets) {
  return uploadedUrls(assets)[0] || "";
}

/**
 * 构建 OPPO 发布版本参数。
 *
 * @param {object} config OPPO 配置。
 * @param {object} uploadedApk APK 上传结果。
 * @param {object} uploadedAssets 资源文件上传结果，按 OPPO 提交字段分组。
 * @returns {object} 发布版本参数。
 */
function buildPublishVersionParams(config, uploadedApk, uploadedAssets = {}) {
  return compactObject({
    pkg_name: config.packageName,
    version_code: String(config.versionCode),
    apk_url: JSON.stringify([{ url: uploadedApk.url, md5: uploadedApk.md5, cpu_code: Number(config.cpuCode || 0) }]),
    app_name: config.appName,
    second_category_id: config.secondCategoryId,
    third_category_id: config.thirdCategoryId,
    summary: config.summary,
    detail_desc: config.detailDesc,
    update_desc: config.updateDesc,
    privacy_source_url: config.privacyUrl,
    icon_url: firstUploadedUrl(uploadedAssets.icon_url) || config.iconUrl,
    pic_url: uploadedUrls(uploadedAssets.pic_url).join(",") || config.picUrl,
    landscape_pic_url: uploadedUrls(uploadedAssets.landscape_pic_url).join(",") || config.landscapePicUrl,
    online_type: Number(config.onlineType || 1),
    sche_online_time: Number(config.onlineType) === 2 ? config.scheduledReleaseTime : "",
    test_desc: config.auditNotes || config.testDesc,
    electronic_cert_url: firstUploadedUrl(uploadedAssets.electronic_cert_url) || config.electronicCertUrl,
    copyright_url: firstUploadedUrl(uploadedAssets.copyright_url) || config.copyrightUrl,
    icp_url: config.icpUrl,
    special_url: uploadedUrls(uploadedAssets.special_url).join(",") || config.specialUrl,
    special_file_url: firstUploadedUrl(uploadedAssets.special_file_url) || config.specialFileUrl,
    business_username: config.businessUsername,
    business_email: config.businessEmail,
    business_mobile: config.businessMobile,
    business_qq: config.businessQq,
    business_position: config.businessPosition,
    business_address: config.businessAddress,
    age_level: config.ageLevel,
    adaptive_equipment: config.adaptiveEquipment,
    adaptive_type: config.adaptiveType,
  });
}

/**
 * 调用 OPPO 业务接口，并自动补公共参数和 api_sign。
 *
 * @param {object} config OPPO 配置。
 * @param {string} apiPath 接口路径。
 * @param {{method?: string, token: string, params?: object, signal?: AbortSignal}} options 请求选项。
 * @returns {Promise<object>} JSON 响应。
 */
async function requestOppoApi(config, apiPath, options) {
  const method = options.method || "GET";
  const params = compactObject({
    ...(options.params || {}),
    access_token: options.token,
    timestamp: Math.floor(Date.now() / 1000),
  });
  params.api_sign = signOppoParams(params, config.clientSecret);
  const url = new URL(apiPath.startsWith("http") ? apiPath : `${config.apiBaseUrl}${apiPath}`);

  if (method === "GET") {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const json = await requestJson(url.toString(), { method, signal: options.signal }, "OPPO 接口");
    if (!options._tokenRetried && isOppoTokenExpired(json)) {
      clearCachedToken(getOppoTokenCacheKey(config));
      const freshToken = await requestAccessToken(config, options.signal);
      return requestOppoApi(config, apiPath, { ...options, token: freshToken.accessToken, _tokenRetried: true });
    }
    assertOppoSuccess(json, `OPPO 接口请求失败：GET ${apiPath}`);
    return json;
  }

  const bodyText = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const json = await requestJson(url.toString(), {
    method,
    body: bodyText,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(bodyText),
    },
    signal: options.signal,
  }, "OPPO 接口");
  if (!options._tokenRetried && isOppoTokenExpired(json)) {
    clearCachedToken(getOppoTokenCacheKey(config));
    const freshToken = await requestAccessToken(config, options.signal);
    return requestOppoApi(config, apiPath, { ...options, token: freshToken.accessToken, _tokenRetried: true });
  }
  assertOppoSuccess(json, `OPPO 接口请求失败：${method} ${apiPath}`);
  return json;
}

/**
 * 生成 OPPO api_sign。
 *
 * 签名规则来自 OPPO API传包能力文档：除 api_sign 外的全部请求参数按 ASCII
 * 升序排序，拼接为 k=v&k2=v2，再用 client_secret 做 HmacSHA256。
 *
 * @param {object} params 请求参数。
 * @param {string} clientSecret OPPO client_secret。
 * @returns {string} 小写十六进制签名。
 */
function signOppoParams(params, clientSecret) {
  const source = Object.keys(params)
    .filter((key) => key !== "api_sign" && params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHmac("sha256", clientSecret).update(source, "utf8").digest("hex");
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
 * @param {string} url OPPO upload_url。
 * @param {{fields: object, filePath: string, signal?: AbortSignal, onProgress?: Function}} options 上传选项。
 * @returns {Promise<object>} JSON 响应。
 */
function requestMultipartFile(url, options) {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const boundary = `----open-release-pilot-oppo-${Date.now().toString(16)}`;
  const fieldBuffers = Object.entries(options.fields || {}).map(([key, value]) => (
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
  ));
  const fileName = path.basename(options.filePath);
  const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${getUploadContentType(options.filePath)}\r\n\r\n`);
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
          reject(new Error(`OPPO 文件上传 HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        resolve(parseJsonResponse(text, "OPPO 文件上传"));
      });
    });

    let uploaded = 0;
    let activeStream = null;
    req.on("timeout", () => req.destroy(new Error(`OPPO 文件上传超时：${url}`)));
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
 * 根据文件后缀设置 multipart Content-Type。
 *
 * OPPO 上传接口按 type 区分文件用途，但合理的 MIME 能帮助网关正确识别图片、
 * PDF、压缩包等资源；未知类型使用二进制流兜底。
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
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".rar": "application/vnd.rar",
    ".mp4": "video/mp4",
  }[ext] || "application/octet-stream";
}

/**
 * 校验 OPPO errno 是否成功。
 *
 * @param {object} json 响应 JSON。
 * @param {string} prefix 错误前缀。
 * @returns {void}
 */
function assertOppoSuccess(json, prefix) {
  if (Number(json?.errno) === 0) return;
  const detail = json?.data?.message || json?.message || JSON.stringify(json).slice(0, 300);
  throw new Error(`${prefix}：${detail}`);
}

/**
 * 判断 OPPO 业务接口是否明确提示 access_token 失效。
 *
 * @param {object} json OPPO 响应 JSON。
 * @returns {boolean} 是否可以刷新 token 后重试。
 */
function isOppoTokenExpired(json) {
  const text = `${json?.errno ?? ""} ${json?.data?.message || ""} ${json?.message || ""}`.toLowerCase();
  return /access[_-]?token|token/.test(text) && /过期|失效|invalid|expired|expire|unauthorized/.test(text);
}

/**
 * 解析 OPPO 任务状态。
 *
 * @param {object} taskState 任务状态响应 data。
 * @returns {{label: string, text: string}} 可读状态。
 */
function formatOppoTaskState(taskState = {}) {
  const code = Number(taskState.task_state);
  const label = OPPO_TASK_STATE_LABELS[code] || (taskState.task_state === undefined ? "未返回任务状态" : `未知状态(${taskState.task_state})`);
  const details = [];
  if (!isBlank(taskState.version_code)) details.push(`version_code: ${taskState.version_code}`);
  if (!isBlank(taskState.err_msg)) details.push(`错误原因: ${taskState.err_msg}`);
  return {
    label,
    text: details.length > 0 ? `${label}，${details.join("，")}` : label,
  };
}

/**
 * 重置 OPPO 流程状态。
 *
 * @returns {object} 重置结果。
 */
function resetOppoState() {
  clearStoreState(STORE_KEY);
  return {
    ok: true,
    store: STORE_KEY,
    action: "reset-state",
    message: "OPPO 流程状态已重置。",
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
 * 整理 OPPO 预检失败原因。
 *
 * 接口日志和上传记录很多位置只展示 message。这里把 missing/warnings 压缩进
 * 主提示，并把内部字段名翻译成中文，避免用户只看到“预检未通过”。
 *
 * @param {string[]} missing 阻断项。
 * @param {string[]} warnings 提醒项。
 * @returns {string} 可直接展示的原因文案。
 */
function formatOppoReasons(missing = [], warnings = []) {
  const errors = missing.map(formatOppoReason).filter(Boolean);
  const tips = warnings.map(formatOppoReason).filter(Boolean);
  const parts = [];
  if (errors.length > 0) parts.push(`需处理：${errors.join("；")}`);
  if (tips.length > 0) parts.push(`提示：${tips.join("；")}`);
  return parts.join("。") || "请检查 OPPO 发布配置。";
}

/**
 * 格式化单条 OPPO 失败原因。
 *
 * @param {string} reason 原始字段名或错误文本。
 * @returns {string} 用户可读文案。
 */
function formatOppoReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return "";
  return OPPO_FIELD_LABELS[text] || text;
}

/**
 * 清理 OPPO 流程状态供前端步骤条展示。
 *
 * @param {object} stateInfo 原始状态。
 * @returns {object} 前端状态。
 */
function sanitizeStateForResponse(stateInfo = {}) {
  return compactObject({
    tokenCheckedAt: stateInfo.tokenCheckedAt,
    tokenExpiresAt: stateInfo.tokenExpiresAt,
    appInfoQueriedAt: stateInfo.appInfoQueriedAt,
    appInfo: stateInfo.appInfo,
    uploadedApk: stateInfo.uploadedApk,
    uploadedAssets: stateInfo.uploadedAssets,
    versionPublishedAt: stateInfo.versionPublishedAt,
    taskStateQueriedAt: stateInfo.taskStateQueriedAt,
    lastTaskState: stateInfo.lastTaskState,
    lastTaskStateLabel: stateInfo.lastTaskStateLabel,
  });
}

/**
 * 压缩 OPPO 响应对象，避免上传记录过大。
 *
 * @param {object} response 原始响应。
 * @returns {object} 响应摘要。
 */
function sanitizeOppoResponse(response = {}) {
  return limitObjectSize(response);
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
    actionLabel: ACTION_LABELS[action] || `OPPO ${action}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: Boolean(result.ok),
    message: result.message || "",
    uploadedFiles: result.uploadedFiles || [],
    updateFields: result.updateFields || [],
    warnings: result.warnings || [],
    taskState: result.taskState || undefined,
    taskStateLabel: result.taskStateLabel || undefined,
    docsUrl: result.docsUrl || OPPO_DOCS_URL,
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
  return missing.length === 0 ? { ok: true, store: STORE_KEY } : buildFailure("OPPO 发布配置预检未通过。", missing);
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
 * 获取 OPPO 发布版本会提交的字段。
 *
 * @param {object} config OPPO 配置。
 * @returns {string[]} 字段列表。
 */
function getOppoPublishFields(config) {
  return Object.keys(buildPublishVersionParams(config, { url: "{uploadedApk.url}", md5: "{uploadedApk.md5}" }, {
    icon_url: [{ url: "{uploadedAssets.icon_url}" }],
    pic_url: [{ url: "{uploadedAssets.pic_url}" }],
    landscape_pic_url: [{ url: "{uploadedAssets.landscape_pic_url}" }],
    copyright_url: [{ url: "{uploadedAssets.copyright_url}" }],
    electronic_cert_url: [{ url: "{uploadedAssets.electronic_cert_url}" }],
    special_url: [{ url: "{uploadedAssets.special_url}" }],
    special_file_url: [{ url: "{uploadedAssets.special_file_url}" }],
  }));
}

/**
 * 安全读取文件大小。
 *
 * @param {string} filePath 本地文件路径。
 * @returns {number} 文件字节数；读取失败时返回 0。
 */
function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
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
  runOppoUpload,
  buildOppoPrecheck,
  normalizeOppoConfig,
};
