const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { clearStoreState, readCurrentNotes, readStoreConfig, readStoreState, recordUploadRun, writeStoreState } = require("../../db");
const { compactObject, formatBytes, isBlank, limitObjectSize, maskSecret, parseJsonResponse, resolveLocalPath, throwIfAborted } = require("../common");
const { buildTokenCacheKey, clearCachedToken, computeExpiresAt, getOrRefreshToken } = require("../token-cache");

const STORE_KEY = "honor";
const HONOR_DOCS_URL = "https://developer.honor.com/cn/doc/guides/101359";
const LEGACY_API_BASE_URL = "https://appmarket-openapi-drcn.cloud.honor.com";
const DEFAULT_TOKEN_URL = "https://iam.developer.honor.com/auth/token";
const DEFAULT_API_BASE_URL = "https://appmarket-openapi-drcn.cloud.hihonor.com";
const DEFAULT_TIMEOUT_MS = 120000;
const HONOR_APK_FILE_TYPE = 100;
const HONOR_RELEASE_AUDIT_LABELS = {
  0: "审核中",
  1: "审核通过",
  2: "审核不通过",
  3: "未提交审核或其他非审核状态",
};
const HONOR_CURRENT_RELEASE_AUDIT_LABELS = {
  0: "审核中",
  1: "审核通过",
  2: "审核不通过",
  3: "其他非审核状态",
  4: "编辑中，未提交审核",
};

const ACTION_LABELS = {
  upload: "一键执行荣耀发布",
  precheck: "荣耀预检",
  "token-check": "获取/校验 Token",
  "query-app-id": "查询 APPID",
  "query-app-detail": "查询应用详情",
  "upload-package": "上传 APK",
  "update-file-info": "绑定应用文件",
  "update-language-info": "更新多语言信息",
  "submit-review": "提交审核",
  "query-audit-status": "查询审核状态",
  "query-current-release": "查询当前版本",
  "revoke-review": "撤销审核",
  "reset-state": "重置流程状态",
};

/**
 * 执行荣耀 API 传包服务入口。
 *
 * 当前按荣耀“API传包服务指引”的更新发布链路实现：
 * 1. 获取账号级 access_token。
 * 2. 根据包名查询 APPID，或复用用户手动配置的 appId。
 * 3. 获取 APK 文件上传路径并上传文件。
 * 4. 绑定应用文件信息。
 * 5. 可选更新多语言 newFeature，并按 submitForReview 开关提交审核。
 *
 * @param {{action?: string, updateProgress?: Function, signal?: AbortSignal}} options 上传动作。
 * @returns {Promise<object>} 预检、上传或撤销审核结果。
 */
async function runHonorUpload(options = {}) {
  const action = options.action || "precheck";
  if (action === "upload") return runHonorFullUpload(options);
  return runHonorAction(action, options);
}

/**
 * 执行荣耀一键发布流程。
 *
 * 一键流程与华为一样按明确步骤串联，并把每一步摘要写回结果：
 * 预检 -> Token -> 查询 APPID -> 上传 APK -> 绑定文件 -> 更新版本说明 ->
 * 可选提交审核 -> 可选查询审核状态。
 *
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} 一键流程结果。
 */
async function runHonorFullUpload(options = {}) {
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const config = getHonorConfig();
  const startedAt = new Date().toISOString();
  const steps = [];

  try {
    clearStoreState(STORE_KEY);
    updateProgress({ phase: "precheck", percent: 6, statusText: "荣耀预检", detail: "正在检查配置和 APK 路径" });
    throwIfAborted(signal);
    const precheck = buildHonorPrecheck(config);
    steps.push(pickStepSummary(precheck));
    if (!precheck.ok) {
      const result = { ...precheck, action: "upload", message: "荣耀一键发布预检未通过，已取消后续步骤。", steps };
      recordUploadRun(createUploadRunRecord("upload", startedAt, result));
      return result;
    }

    updateProgress({ phase: "token", percent: 14, statusText: "获取荣耀 Token", detail: "正在请求 Publish-API access_token" });
    const tokenResult = await tokenCheck(config, signal);
    steps.push(pickStepSummary(tokenResult));
    if (!tokenResult.ok) return recordAndReturnFullUploadFailure(startedAt, tokenResult.message, steps, tokenResult);

    updateProgress({ phase: "query-app", percent: 24, statusText: "查询荣耀 APPID", detail: config.appId ? "使用配置里的 APPID" : `按包名查询：${config.packageName}` });
    const appIdResult = await queryAppIdStep(config, signal);
    steps.push(pickStepSummary(appIdResult));
    if (!appIdResult.ok) return recordAndReturnFullUploadFailure(startedAt, appIdResult.message, steps, appIdResult);

    updateProgress({ phase: "upload-package", percent: 40, statusText: "上传荣耀 APK", detail: "正在获取上传路径并上传文件" });
    const uploadResult = await uploadPackageStep(config, {
      signal,
      updateProgress: (patch = {}) =>
        updateProgress({
          ...patch,
          percent: 40 + Math.round(Number(patch.percent || 0) * 0.32),
        }),
    });
    steps.push(pickStepSummary(uploadResult));
    if (!uploadResult.ok) return recordAndReturnFullUploadFailure(startedAt, uploadResult.message, steps, uploadResult);

    updateProgress({ phase: "update-file-info", percent: 76, statusText: "绑定应用文件", detail: "正在调用 update-file-info" });
    const fileInfoResult = await updateFileInfoStep(config, signal);
    steps.push(pickStepSummary(fileInfoResult));
    if (!fileInfoResult.ok) return recordAndReturnFullUploadFailure(startedAt, fileInfoResult.message, steps, fileInfoResult);

    updateProgress({ phase: "update-language-info", percent: 84, statusText: "更新版本说明", detail: "正在更新荣耀多语言 newFeature" });
    const languageResult = await updateLanguageInfoStep(config, signal);
    steps.push(pickStepSummary(languageResult));
    if (!languageResult.ok && !languageResult.skipped) return recordAndReturnFullUploadFailure(startedAt, languageResult.message, steps, languageResult);

    let submitResult = null;
    let auditResult = null;
    if (config.submitForReview) {
      updateProgress({ phase: "submit-review", percent: 92, statusText: "提交荣耀审核", detail: "正在调用 submit-audit" });
      submitResult = await submitReviewStep(config, signal);
      steps.push(pickStepSummary(submitResult));
      if (!submitResult.ok) return recordAndReturnFullUploadFailure(startedAt, submitResult.message, steps, submitResult);

      updateProgress({ phase: "query-audit", percent: 97, statusText: "查询审核状态", detail: "正在调用 get-audit-result" });
      auditResult = await queryAuditStatusStep(config, signal);
      steps.push(pickStepSummary(auditResult));
      if (!auditResult.ok) return recordAndReturnFullUploadFailure(startedAt, auditResult.message, steps, auditResult);
    }

    updateProgress({
      phase: "done",
      percent: 100,
      statusText: config.submitForReview ? "荣耀发布已提交" : "荣耀 APK 已上传",
      detail: config.submitForReview ? "荣耀审核提交请求已返回" : "已上传并绑定 APK，未提交审核",
    });
    const result = {
      ok: true,
      store: STORE_KEY,
      action: "upload",
      message: config.submitForReview && auditResult?.auditResultLabel
        ? `荣耀一键发布流程已完成，并已提交审核；当前审核状态：${auditResult.auditResultLabel}。`
        : config.submitForReview
          ? "荣耀一键发布流程已完成，并已提交审核。"
          : "荣耀一键发布流程已完成，未提交审核。",
      steps,
      uploadedFiles: uploadResult.uploadedFiles || [],
      releaseId: submitResult?.releaseId || "",
      auditResult: auditResult?.auditResult || null,
      auditResultLabel: auditResult?.auditResultLabel || "",
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
    recordUploadRun(createUploadRunRecord("upload", startedAt, result));
    return result;
  } catch (error) {
    const result = {
      ok: false,
      store: STORE_KEY,
      action: "upload",
      message: `荣耀一键发布流程失败：${error.message}`,
      steps,
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
    recordUploadRun(createUploadRunRecord("upload", startedAt, result));
    return result;
  }
}

/**
 * 执行荣耀单步骤发布动作。
 *
 * @param {string} action 动作名。
 * @param {{updateProgress?: Function, signal?: AbortSignal}} options 执行选项。
 * @returns {Promise<object>} 单步骤结果。
 */
async function runHonorAction(action = "precheck", options = {}) {
  const startedAt = new Date().toISOString();
  const config = getHonorConfig();
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  let result;

  try {
    if (action === "precheck") result = buildHonorPrecheck(config);
    else if (action === "reset-state") result = resetHonorState();
    else if (action === "token-check") result = await tokenCheck(config, signal);
    else if (action === "query-app-id") result = await queryAppIdStep(config, signal);
    else if (action === "query-app-detail") result = await queryAppDetailStep(config, signal);
    else if (action === "upload-package") result = await uploadPackageStep(config, { signal, updateProgress, resetState: true });
    else if (action === "update-file-info") result = await updateFileInfoStep(config, signal);
    else if (action === "update-language-info") result = await updateLanguageInfoStep(config, signal);
    else if (action === "submit-review") result = await submitReviewStep(config, signal);
    else if (action === "query-audit-status") result = await queryAuditStatusStep(config, signal);
    else if (action === "query-current-release") result = await queryCurrentReleaseStep(config, signal);
    else if (action === "revoke-review") result = await revokeReviewStep(updateProgress);
    else result = buildFailure(`未知荣耀发布动作：${action}`, []);
  } catch (error) {
    result = buildFailure(error.message || "荣耀发布步骤执行失败。", []);
  }

  if (!["precheck", "reset-state"].includes(action)) recordUploadRun(createUploadRunRecord(action, startedAt, result));
  return result;
}

/**
 * 读取并规范化荣耀发布配置。
 *
 * @returns {object} 荣耀发布配置。
 */
function getHonorConfig() {
  return normalizeHonorConfig(readStoreConfig().stores.honor || {});
}

/**
 * 补齐荣耀 API 默认地址和更新发布默认值。
 *
 * @param {object} config 原始配置。
 * @returns {object} 规范化后的配置。
 */
function normalizeHonorConfig(config = {}) {
  const rawTokenUrl = config.tokenUrl || DEFAULT_TOKEN_URL;
  const rawApiBaseUrl = config.apiBaseUrl || DEFAULT_API_BASE_URL;
  return {
    ...config,
    docsUrl: config.docsUrl || HONOR_DOCS_URL,
    tokenUrl: rawTokenUrl,
    // OpenAPI 网关使用 hihonor.com，旧 honor.com 默认地址会自动迁移。
    apiBaseUrl: trimBaseUrl(rawApiBaseUrl === LEGACY_API_BASE_URL ? DEFAULT_API_BASE_URL : rawApiBaseUrl),
    // 早期荣耀还是人工配置时字段叫 appKey。这里兼容读取，避免升级后
    // 用户之前记录的 Client ID 看起来像丢失；保存新配置后会使用 clientId。
    clientId: config.clientId || config.appKey || "",
    packageName: config.packageName || "",
    languageId: config.languageId || "zh-CN",
    releaseType: config.releaseType === undefined || config.releaseType === "" ? 1 : Number(config.releaseType),
    forceUpdate: config.forceUpdate === undefined || config.forceUpdate === "" ? 0 : Number(config.forceUpdate),
  };
}

/**
 * 构建荣耀发布预检结果。
 *
 * appId 可以留空：真实上传时会按包名调用 get-app-id 自动查询。
 * 更新发布当前只接 APK 文件，文档中的 APK 文件类型编码为 100。
 *
 * @param {object} config 荣耀发布配置。
 * @returns {object} 预检结果。
 */
function buildHonorPrecheck(config) {
  const missing = [];
  const warnings = [];
  if (!config.enabled) missing.push("enabled");
  ["clientId", "clientSecret", "packageName", "apkPath"].forEach((key) => {
    if (isBlank(config[key])) missing.push(key);
  });
  if (isBlank(getUpdateDescription(config))) missing.push("releaseNotes");
  if (config.releaseType === 2 && isBlank(config.releaseTime)) missing.push("releaseTime");

  const apkPath = resolveLocalPath(config.apkPath);
  if (!isBlank(config.apkPath)) {
    if (!fs.existsSync(apkPath)) missing.push(`apkPath: ${apkPath}`);
    if (path.extname(apkPath).toLowerCase() !== ".apk") {
      missing.push("apkPath 必须是 .apk 文件；当前荣耀 API 传包文档只列出 APK 应用包 fileType=100。");
    }
  }
  if (isBlank(config.appId)) warnings.push("appId 留空时会在上传流程中按包名自动查询。");
  if (isBlank(config.appName) || isBlank(config.intro)) {
    warnings.push("应用名称或应用介绍留空时，会尝试从荣耀 get-app-detail 读取后再更新 newFeature。");
  }

  const plannedFiles = collectPlannedFiles(config);
  return {
    ok: missing.length === 0,
    store: STORE_KEY,
    action: "precheck",
    message: missing.length === 0 ? "荣耀发布配置预检通过。" : "荣耀发布配置预检未通过。",
    missing,
    warnings,
    docsUrl: config.docsUrl || HONOR_DOCS_URL,
    plannedFiles,
    updateFields: getHonorUpdateFields(config),
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 校验荣耀 Token 获取能力。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} Token 校验结果。
 */
async function tokenCheck(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "token-check" };

  const token = await requestAccessToken(config, signal);
  const state = writeStoreState(STORE_KEY, {
    tokenCheckedAt: new Date().toISOString(),
    tokenExpiresIn: token.expiresIn,
    tokenFromCache: Boolean(token.fromCache),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "token-check",
    message: token.fromCache ? "荣耀 Token 校验成功，已复用缓存。" : "荣耀 Token 校验成功，已刷新缓存。",
    response: sanitizeTokenResponse(token.response),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 查询荣耀 APPID 并写入流程状态。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 查询结果。
 */
async function queryAppIdStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "packageName"]);
  if (!required.ok) return { ...required, action: "query-app-id" };

  const token = await requestAccessToken(config, signal);
  // 即使用户手动填写了 APPID，也先按包名真实查询一次。
  // 这样可以提前验证 client_id/client_secret 换出的 token 是否真的具备
  // Publish API 权限，避免一键流程跳过查询后到上传路径接口才暴露权限问题。
  const response = await queryAppIdResponse(config, token.accessToken, signal);
  const matched = (response.data || []).find((item) => item.packageName === config.packageName) || response.data?.[0];
  if (!matched?.appId) return buildFailure(`荣耀未查询到该包名的 APPID：${config.packageName}`, ["appId"]);
  if (!isBlank(config.appId) && String(config.appId) !== String(matched.appId)) {
    return buildFailure(`荣耀配置 APPID 与包名查询结果不一致：配置=${config.appId}，接口=${matched.appId}`, ["appId"]);
  }

  const state = writeStoreState(STORE_KEY, {
    appId: matched.appId,
    appIdQueriedAt: new Date().toISOString(),
    lastAppIdQuery: sanitizeHonorResponse(response),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-app-id",
    message: `荣耀 APPID 查询成功：${matched.appId}`,
    appId: matched.appId,
    response: sanitizeHonorResponse(response),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 查询荣耀应用详情，用于确认账号和 APPID 是否匹配。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 查询结果。
 */
async function queryAppDetailStep(config, signal) {
  const appIdResult = await ensureHonorAppId(config, signal);
  if (!appIdResult.ok) return { ...appIdResult, action: "query-app-detail" };

  const token = await requestAccessToken(config, signal);
  const response = await queryAppDetail(config, token.accessToken, appIdResult.appId, signal);
  const state = writeStoreState(STORE_KEY, {
    appDetailQueriedAt: new Date().toISOString(),
    lastAppDetail: sanitizeAppDetail(response),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-app-detail",
    message: "荣耀应用详情查询完成。",
    response: sanitizeAppDetail(response),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 上传荣耀 APK，包含获取上传路径和 multipart 上传。
 *
 * @param {object} config 荣耀配置。
 * @param {{signal?: AbortSignal, updateProgress?: Function, resetState?: boolean}} options 执行选项。
 * @returns {Promise<object>} 上传结果。
 */
async function uploadPackageStep(config, options = {}) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "packageName", "apkPath"]);
  if (!required.ok) return { ...required, action: "upload-package" };
  const apkPath = resolveLocalPath(config.apkPath);
  if (!fs.existsSync(apkPath)) return buildFailure(`荣耀 APK 文件不存在：${apkPath}`, ["apkPath"]);
  if (options.resetState) clearStoreState(STORE_KEY);

  const appIdResult = await ensureHonorAppId(config, options.signal);
  if (!appIdResult.ok) return { ...appIdResult, action: "upload-package" };

  const token = await requestAccessToken(config, options.signal);
  const uploadFile = buildUploadFile(apkPath);
  options.updateProgress?.({ phase: "upload-url", percent: 10, statusText: "获取上传路径", detail: uploadFile.fileName });
  const uploadPath = await requestFileUploadPath(config, token.accessToken, appIdResult.appId, uploadFile, options.signal);

  options.updateProgress?.({ phase: "uploading", percent: 20, statusText: "上传荣耀 APK", detail: uploadFile.fileName });
  const uploadResponse = await uploadFileToHonor(config, token.accessToken, appIdResult.appId, uploadPath, apkPath, options.signal, (uploaded, total) => {
    options.updateProgress?.({
      phase: "uploading",
      percent: 20 + Math.round((uploaded / Math.max(total, 1)) * 75),
      statusText: "上传荣耀 APK",
      detail: `${uploadFile.fileName} ${formatBytes(uploaded)} / ${formatBytes(total)}`,
    });
  });
  const uploadedObjectId = extractUploadedObjectId(uploadResponse, uploadPath);

  const state = writeStoreState(STORE_KEY, {
    appId: appIdResult.appId,
    uploadedPackage: {
      objectId: uploadedObjectId,
      uploadPathObjectId: uploadPath.objectId,
      fileName: uploadFile.fileName,
      fileSize: uploadFile.fileSize,
      fileSha256: uploadFile.fileSha256,
      sourcePath: apkPath,
      uploadedAt: new Date().toISOString(),
      uploadUrl: uploadPath.uploadUrl,
      uploadResponse: sanitizeHonorResponse(uploadResponse),
    },
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "upload-package",
    message: "荣耀 APK 上传完成，下一步可以绑定应用文件。",
    appId: appIdResult.appId,
    uploadedFiles: [
      {
        fileName: uploadFile.fileName,
        path: apkPath,
        objectId: uploadedObjectId,
        fileSha256: uploadFile.fileSha256,
      },
    ],
    response: { objectId: uploadedObjectId, uploadPathObjectId: uploadPath.objectId, fileName: uploadPath.fileName, expireTime: uploadPath.expireTime },
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 绑定已上传 APK 到荣耀应用文件信息。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 绑定结果。
 */
async function updateFileInfoStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "update-file-info" };
  const state = readStoreState(STORE_KEY);
  const uploadedPackage = state.uploadedPackage || {};
  const appId = config.appId || state.appId;
  const objectId = resolveBindableObjectId(uploadedPackage, state.lastObjectId);
  if (isBlank(appId)) return buildFailure("缺少荣耀 APPID，请先执行“查询 APPID”。", ["appId"]);
  if (isBlank(objectId)) return buildFailure("缺少可绑定的荣耀 objectId，请重新执行“上传 APK”。", ["uploadedPackage.objectId"]);

  const token = await requestAccessToken(config, signal);
  const response = await updateFileInfo(config, token.accessToken, appId, objectId, signal);
  const nextState = writeStoreState(STORE_KEY, {
    fileInfoUpdatedAt: new Date().toISOString(),
    lastFileInfoResponse: sanitizeHonorResponse(response),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "update-file-info",
    message: "荣耀应用文件信息已绑定。",
    response: sanitizeHonorResponse(response),
    state: sanitizeStateForResponse(nextState),
  };
}

/**
 * 请求荣耀账号级 access_token。
 *
 * 荣耀 token 是账号级短效凭据。这里仅缓存在当前 Node 进程内，过期前一分钟
 * 自动失效；真实刷新失败时不会覆盖已有缓存，业务错误会直接返回给调用方。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<{accessToken: string, expiresIn: number|string, tokenType: string, response: object}>} access_token 摘要。
 */
async function requestAccessToken(config, signal) {
  const cacheKey = getHonorTokenCacheKey(config);
  return getOrRefreshToken(cacheKey, async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString();
    const response = await requestRaw(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
      signal,
    });
    const json = parseJsonResponse(response.text, "荣耀 Token");
    if (!json.access_token) throw new Error(`荣耀 Token 响应缺少 access_token：${response.text.slice(0, 300)}`);
    const accessToken = String(json.access_token || "").trim();
    const expiresIn = json.expires_in;
    return {
      accessToken,
      expiresIn,
      expiresAt: computeExpiresAt(expiresIn, "ttl"),
      tokenType: json.token_type || "Bearer",
      response: json,
    };
  });
}

/**
 * 生成荣耀 token 缓存 key。
 *
 * @param {object} config 荣耀配置。
 * @returns {string} 缓存 key。
 */
function getHonorTokenCacheKey(config) {
  return buildTokenCacheKey(STORE_KEY, [config.tokenUrl, config.clientId, config.clientSecret]);
}

/**
 * 根据包名查询荣耀 APPID 原始响应。
 *
 * 单步骤面板需要把接口响应摘要展示出来，所以这里保留完整响应；
 * 调用方再根据包名挑选真正使用的 appId。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} get-app-id 原始响应。
 */
function queryAppIdResponse(config, token, signal) {
  return requestHonorJson(config, `/openapi/v1/publish/get-app-id?pkgName=${encodeURIComponent(config.packageName)}`, {
    method: "GET",
    token,
    signal,
  });
}

/**
 * 查询荣耀应用详情，用于更新多语言信息时继承 appName/intro 等必填字段。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {string|number} appId APPID。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 应用详情。
 */
function queryAppDetail(config, token, appId, signal) {
  return requestHonorJson(config, `/openapi/v1/publish/get-app-detail?appId=${encodeURIComponent(appId)}`, {
    method: "GET",
    token,
    signal,
  });
}

/**
 * 获取荣耀文件上传路径。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {string|number} appId APPID。
 * @param {object} uploadFile 文件摘要。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 上传路径对象。
 */
async function requestFileUploadPath(config, token, appId, uploadFile, signal) {
  const json = await requestHonorJson(config, `/openapi/v1/publish/get-file-upload-url?appId=${encodeURIComponent(appId)}`, {
    method: "POST",
    token,
    body: [uploadFile],
    signal,
  });
  const uploadPath = (json.data || []).find((item) => item.fileName === uploadFile.fileName) || json.data?.[0];
  if (!uploadPath?.objectId) throw new Error(`荣耀上传路径响应缺少 objectId：${JSON.stringify(json).slice(0, 300)}`);
  return uploadPath;
}

/**
 * 上传 APK 文件到荣耀。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {string|number} appId APPID。
 * @param {object} uploadPath 上传路径对象。
 * @param {string} filePath 本地 APK 路径。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @param {Function} onProgress 上传进度回调。
 * @returns {Promise<object>} 上传响应。
 */
async function uploadFileToHonor(config, token, appId, uploadPath, filePath, signal, onProgress) {
  // 荣耀文档要求上传资源文件时使用 get-file-upload-url 返回的 uploadUrl。
  // 这个 URL 与 objectId 是一组临时授权信息，不能随意重新拼接，否则可能
  // 命中不同网关上下文并返回 objectId is not exists。
  const url = uploadPath.uploadUrl || `${config.apiBaseUrl}/openapi/v1/publish/file-upload?appId=${encodeURIComponent(appId)}&objectId=${encodeURIComponent(uploadPath.objectId)}`;
  const json = await requestMultipartFile(url, {
    token,
    filePath,
    signal,
    onProgress,
  });
  assertHonorSuccess(json, "荣耀上传应用文件失败");
  return json;
}

/**
 * 从上传响应中提取最终可绑定的 objectId。
 *
 * 文档示例里 file-upload 只返回 code/msg，但实际接口如果返回 data.objectId
 * 或 data[0].objectId，应优先使用上传接口确认后的 ID；否则从
 * get-file-upload-url 返回的 uploadUrl 中读取原始 objectId 字符串。
 *
 * @param {object} uploadResponse 上传接口响应。
 * @param {object} uploadPath 获取上传路径响应项。
 * @returns {string|number} 可用于 update-file-info 的 objectId。
 */
function extractUploadedObjectId(uploadResponse, uploadPath) {
  return uploadResponse?.data?.objectId || uploadResponse?.data?.[0]?.objectId || uploadResponse?.objectId || extractObjectIdFromUrl(uploadPath?.uploadUrl) || uploadPath?.objectId;
}

/**
 * 绑定荣耀应用文件信息。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {string|number} appId APPID。
 * @param {string|number} objectId 文件对象 ID。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 接口响应。
 */
function updateFileInfo(config, token, appId, objectId, signal) {
  const objectIdValue = normalizeHonorObjectId(objectId);
  const bodyText = buildUpdateFileInfoBodyText(objectIdValue);
  return requestHonorJson(config, `/openapi/v1/publish/update-file-info?appId=${encodeURIComponent(appId)}`, {
    method: "POST",
    token,
    bodyText,
    signal,
  });
}

/**
 * 规范化荣耀 objectId。
 *
 * 荣耀文档声明 objectId 是 Long。JSON 里传字符串有时也可用，但为了和
 * 文档一致，这里在安全整数范围内转成 Number；超出范围则保持字符串，
 * 避免 JS number 精度损失。
 *
 * @param {string|number} objectId 文件对象 ID。
 * @returns {string|number} 规范化后的 objectId。
 */
function normalizeHonorObjectId(objectId) {
  if (typeof objectId === "number") return objectId;
  const text = String(objectId || "").trim();
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (Number.isSafeInteger(value)) return value;
  }
  return objectId;
}

/**
 * 构建 update-file-info 请求体。
 *
 * objectId 是荣耀 Long 类型。超过 JS 安全整数范围时不能转 Number，
 * 但也不能按字符串提交，所以这里直接把数字文本写进 JSON。
 *
 * @param {string|number} objectId 可绑定 objectId。
 * @returns {string} JSON 请求体。
 */
function buildUpdateFileInfoBodyText(objectId) {
  const text = String(objectId || "").trim();
  if (/^\d+$/.test(text)) return `{"bindingFileList":[{"objectId":${text}}]}`;
  return JSON.stringify({ bindingFileList: [{ objectId }] });
}

/**
 * 解析绑定应用文件时应使用的 objectId。
 *
 * 荣耀 objectId 是 Long，可能超过 JavaScript 安全整数范围。优先从
 * uploadUrl 的 query 中读取原始字符串，避免 JSON.parse 后的数字精度丢失。
 *
 * @param {object} uploadedPackage 上传状态。
 * @param {string|number|undefined} fallbackObjectId 旧状态兜底 ID。
 * @returns {string|number} 可绑定 objectId。
 */
function resolveBindableObjectId(uploadedPackage = {}, fallbackObjectId) {
  const urlObjectId = extractObjectIdFromUrl(uploadedPackage.uploadUrl);
  if (!isBlank(urlObjectId)) return urlObjectId;
  if (typeof uploadedPackage.objectId === "number" && !Number.isSafeInteger(uploadedPackage.objectId)) return "";
  if (!isBlank(uploadedPackage.objectId)) return uploadedPackage.objectId;
  if (typeof fallbackObjectId === "number" && !Number.isSafeInteger(fallbackObjectId)) return "";
  return fallbackObjectId;
}

/**
 * 从荣耀 uploadUrl 中提取原始 objectId。
 *
 * @param {string} url 荣耀返回的上传 URL。
 * @returns {string} 原始 objectId 字符串。
 */
function extractObjectIdFromUrl(url) {
  try {
    return new URL(String(url || "")).searchParams.get("objectId") || "";
  } catch (error) {
    return "";
  }
}

/**
 * 更新荣耀多语言信息。
 *
 * 该步骤只负责把更新日志写入 newFeature。荣耀接口要求 appName 和 intro
 * 同时存在，所以配置没填时会先查询应用详情继承原有语言配置，避免覆盖空值。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 更新结果。
 */
async function updateLanguageInfoStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "update-language-info" };

  const newFeature = getUpdateDescription(config);
  if (isBlank(newFeature)) {
    return {
      ok: true,
      skipped: true,
      store: STORE_KEY,
      action: "update-language-info",
      message: "荣耀更新日志为空，已跳过多语言 newFeature 更新。",
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
  }

  const appIdResult = await ensureHonorAppId(config, signal);
  if (!appIdResult.ok) return { ...appIdResult, action: "update-language-info" };

  const token = await requestAccessToken(config, signal);
  let appDetail = {};
  try {
    appDetail = await queryAppDetail(config, token.accessToken, appIdResult.appId, signal);
  } catch (error) {
    // 应用详情只用于继承 appName/intro。查询失败时仍允许用户手动填写字段后继续。
    appDetail = { code: -1, msg: error.message, data: {} };
  }

  const inherited = findLanguageInfo(appDetail, config.languageId);
  const languageItem = compactObject({
    languageId: config.languageId,
    appName: config.appName || inherited?.appName,
    intro: config.intro || inherited?.intro,
    briefIntro: config.briefIntro || inherited?.briefIntro,
    newFeature,
  });

  if (isBlank(languageItem.appName) || isBlank(languageItem.intro)) {
    return {
      ok: true,
      skipped: true,
      store: STORE_KEY,
      action: "update-language-info",
      message: "荣耀多语言信息缺少 appName 或 intro，已跳过 newFeature 更新。",
      warnings: ["请在荣耀配置中补应用名称和应用介绍，或先确认 get-app-detail 能读取原有语言配置。"],
      state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
    };
  }

  const response = await requestHonorJson(config, `/openapi/v1/publish/update-language-info?appId=${encodeURIComponent(appIdResult.appId)}`, {
    method: "POST",
    token: token.accessToken,
    body: {
      languageInfoList: [languageItem],
      setAll: 0,
    },
    signal,
  });
  const state = writeStoreState(STORE_KEY, {
    languageInfoUpdatedAt: new Date().toISOString(),
    lastLanguageInfoResponse: sanitizeHonorResponse(response),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "update-language-info",
    message: "荣耀版本说明已更新。",
    response: sanitizeHonorResponse(response),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 提交荣耀审核。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {string|number} appId APPID。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<{response: object, releaseId: string}>} 提交响应。
 */
async function submitAudit(config, token, appId, signal) {
  const body = compactObject({
    forceUpdate: config.forceUpdate,
    testAccount: config.testAccount,
    testPassword: config.testPassword,
    testComment: config.auditNotes || config.testComment,
    releaseType: config.releaseType || 1,
    releaseTime: config.releaseType === 2 ? config.releaseTime : "",
  });
  const response = await requestHonorJson(config, `/openapi/v1/publish/submit-audit?appId=${encodeURIComponent(appId)}`, {
    method: "POST",
    token,
    body,
    signal,
  });
  return {
    response,
    releaseId: response.data || "",
  };
}

/**
 * 查询荣耀审核状态。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {string|number} appId APPID。
 * @param {string} releaseId 发布流程 ID。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 审核状态。
 */
async function queryAuditResult(config, token, appId, releaseId, signal) {
  const response = await requestHonorJson(config, "/openapi/v1/publish/get-audit-result", {
    method: "POST",
    token,
    body: {
      appId: [{ appId: Number(appId), releaseId }],
    },
    signal,
  });
  return response.data?.[0] || response.data || response;
}

/**
 * 查询荣耀当前线上/提审中的最新版本状态。
 *
 * 这个接口只依赖 APPID，不依赖 submit-audit 返回的 releaseId；
 * 当用户没有保存 releaseId，或只是想确认当前版本审核状态时，比
 * get-audit-result 更适合作为页面上的“快速查询”入口。
 *
 * @param {object} config 荣耀配置。
 * @param {string} token access_token。
 * @param {string|number} appId APPID。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 当前版本与审核状态。
 */
async function queryCurrentRelease(config, token, appId, signal) {
  const response = await requestHonorJson(config, `/openapi/v1/publish/get-app-current-release?appId=${encodeURIComponent(appId)}`, {
    method: "GET",
    token,
    signal,
  });
  return response.data || response;
}

/**
 * 提交荣耀审核步骤。
 *
 * 提审是会影响版本流转的动作，必须显式开启 submitForReview；
 * 这样“一键上传但不提审”和“上传并提审”的行为在页面上保持清晰。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 提审结果。
 */
async function submitReviewStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "submit-review" };
  if (!config.submitForReview) return buildFailure("荣耀提交审核开关未开启，已拒绝调用 submit-audit。", ["submitForReview"]);

  const appIdResult = await ensureHonorAppId(config, signal);
  if (!appIdResult.ok) return { ...appIdResult, action: "submit-review" };

  const token = await requestAccessToken(config, signal);
  const audit = await submitAudit(config, token.accessToken, appIdResult.appId, signal);
  const state = writeStoreState(STORE_KEY, {
    reviewSubmittedAt: new Date().toISOString(),
    lastReleaseId: audit.releaseId,
    lastSubmitReviewResponse: sanitizeHonorResponse(audit.response),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "submit-review",
    message: audit.releaseId ? `荣耀提交审核已返回：${audit.releaseId}` : "荣耀提交审核已返回。",
    releaseId: audit.releaseId,
    response: sanitizeHonorResponse(audit.response),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 查询荣耀审核状态步骤。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 审核查询结果。
 */
async function queryAuditStatusStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "query-audit-status" };

  const state = readStoreState(STORE_KEY);
  const appId = config.appId || state.appId;
  const releaseId = state.lastReleaseId || config.releaseId;
  if (isBlank(appId)) return buildFailure("缺少荣耀 APPID，请先执行“查询 APPID”。", ["appId"]);
  if (isBlank(releaseId)) return buildFailure("缺少荣耀 releaseId，请先执行“提交审核”。", ["releaseId"]);

  const token = await requestAccessToken(config, signal);
  const auditResult = await queryAuditResult(config, token.accessToken, appId, releaseId, signal);
  const auditSummary = formatHonorAuditResult(auditResult, "release");
  const nextState = writeStoreState(STORE_KEY, {
    auditStatusQueriedAt: new Date().toISOString(),
    lastAuditResult: auditResult,
    lastAuditResultLabel: auditSummary.label,
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-audit-status",
    message: `荣耀审核状态查询完成：${auditSummary.text}`,
    auditResult,
    auditResultLabel: auditSummary.label,
    state: sanitizeStateForResponse(nextState),
  };
}

/**
 * 查询荣耀当前版本审核状态步骤。
 *
 * get-audit-result 需要 releaseId；当前版本查询只需要 APPID。
 * 页面保留两个入口，可以分别覆盖“刚提交的审核单”和“当前版本状态”。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 当前版本查询结果。
 */
async function queryCurrentReleaseStep(config, signal) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret"]);
  if (!required.ok) return { ...required, action: "query-current-release" };

  const appIdResult = await ensureHonorAppId(config, signal);
  if (!appIdResult.ok) return { ...appIdResult, action: "query-current-release" };

  const token = await requestAccessToken(config, signal);
  const currentRelease = await queryCurrentRelease(config, token.accessToken, appIdResult.appId, signal);
  const auditSummary = formatHonorAuditResult(currentRelease, "current");
  const nextState = writeStoreState(STORE_KEY, {
    currentReleaseQueriedAt: new Date().toISOString(),
    lastCurrentRelease: currentRelease,
    lastCurrentReleaseLabel: auditSummary.label,
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-current-release",
    message: `荣耀当前版本查询完成：${auditSummary.text}`,
    appId: appIdResult.appId,
    auditResult: currentRelease,
    auditResultLabel: auditSummary.label,
    state: sanitizeStateForResponse(nextState),
  };
}

/**
 * 撤销荣耀审核。
 *
 * 当前荣耀公开文档页没有明确给出撤销审核接口。这里保留统一入口，
 * 页面可以给出清晰反馈，避免用户误以为点击后已经撤销成功。
 *
 * @param {Function} updateProgress 进度回调。
 * @returns {object} 不支持结果。
 */
function revokeReviewStep(updateProgress) {
  updateProgress?.({
    phase: "unsupported",
    percent: 100,
    statusText: "荣耀暂不支持撤销审核",
    detail: "当前接入文档没有提供撤销审核接口，请到荣耀开发者后台人工处理。",
  });
  return {
    ok: false,
    store: STORE_KEY,
    action: "revoke-review",
    message: "荣耀暂未接入撤销审核接口：当前荣耀 API传包服务文档未提供撤销审核路由。",
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 请求荣耀 JSON 接口，并校验 code=0。
 *
 * @param {object} config 荣耀配置。
 * @param {string} apiPath 接口路径或完整 URL。
 * @param {{method?: string, token: string, body?: object, bodyText?: string, signal?: AbortSignal}} options 请求选项。
 * @returns {Promise<object>} JSON 响应。
 */
async function requestHonorJson(config, apiPath, options) {
  const bodyText = options.bodyText !== undefined ? options.bodyText : options.body === undefined ? "" : JSON.stringify(options.body);
  const url = apiPath.startsWith("http") ? apiPath : `${config.apiBaseUrl}${apiPath}`;
  const headers = {
    Authorization: buildAuthorizationHeader(options.token),
  };
  if (bodyText) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(bodyText);
  }
  const response = await requestRaw(url, {
    method: options.method || "GET",
    headers,
    body: bodyText,
    signal: options.signal,
  });
  const json = parseJsonResponse(response.text, "荣耀接口");
  if (!options._tokenRetried && isHonorTokenExpired(json)) {
    clearCachedToken(getHonorTokenCacheKey(config));
    const freshToken = await requestAccessToken(config, options.signal);
    return requestHonorJson(config, apiPath, { ...options, token: freshToken.accessToken, _tokenRetried: true });
  }
  assertHonorSuccess(json, `荣耀接口请求失败：${options.method || "GET"} ${apiPath}`);
  return json;
}

/**
 * 判断荣耀业务接口是否明确提示 access_token 过期。
 *
 * @param {object} json 荣耀响应 JSON。
 * @returns {boolean} 是否可以刷新 token 后重试。
 */
function isHonorTokenExpired(json) {
  return Number(json?.code) === 10003;
}

/**
 * 发送普通 HTTP 请求并返回文本。
 *
 * @param {string} url 请求地址。
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

    const req = transport.request(
      {
        method: options.method || "GET",
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        timeout: DEFAULT_TIMEOUT_MS,
        headers: options.headers || {},
      },
      (res) => {
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
      },
    );

    req.on("timeout", () => req.destroy(new Error(`请求超时：${url}`)));
    req.on("error", reject);
    options.signal?.addEventListener("abort", () => req.destroy(new Error("上传任务已终止")), { once: true });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 使用 multipart/form-data 上传单个文件。
 *
 * @param {string} url 上传地址。
 * @param {{token: string, filePath: string, signal?: AbortSignal, onProgress?: Function}} options 上传选项。
 * @returns {Promise<object>} JSON 响应。
 */
function requestMultipartFile(url, options) {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const boundary = `----open-release-pilot-honor-${Date.now().toString(16)}`;
  const fileName = path.basename(options.filePath);
  const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/vnd.android.package-archive\r\n\r\n`);
  const fileEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileSize = fs.statSync(options.filePath).size;
  const contentLength = fileHeader.length + fileSize + fileEnd.length;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }

    const req = transport.request(
      {
        method: "POST",
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
          Authorization: buildAuthorizationHeader(options.token),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": contentLength,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`荣耀文件上传 HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          resolve(parseJsonResponse(text, "荣耀文件上传"));
        });
      },
    );

    let uploaded = 0;
    let activeStream = null;
    req.on("timeout", () => req.destroy(new Error(`荣耀文件上传超时：${url}`)));
    req.on("error", reject);
    options.signal?.addEventListener(
      "abort",
      () => {
        activeStream?.destroy(new Error("上传任务已终止"));
        req.destroy(new Error("上传任务已终止"));
      },
      { once: true },
    );

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
 * 构建荣耀上传文件摘要。
 *
 * @param {string} filePath 本地 APK 路径。
 * @returns {{fileName: string, fileType: number, fileSize: number, fileSha256: string}} 文件摘要。
 */
function buildUploadFile(filePath) {
  return {
    fileName: path.basename(filePath),
    fileType: HONOR_APK_FILE_TYPE,
    fileSize: fs.statSync(filePath).size,
    fileSha256: sha256File(filePath),
  };
}

/**
 * 收集荣耀发布计划使用的本地文件。
 *
 * @param {object} config 荣耀配置。
 * @returns {object[]} 文件列表。
 */
function collectPlannedFiles(config) {
  const files = [];
  if (!isBlank(config.apkPath)) {
    const apkPath = resolveLocalPath(config.apkPath);
    files.push({
      localKey: "apkPath",
      formName: "file",
      fileType: HONOR_APK_FILE_TYPE,
      path: apkPath,
      exists: fs.existsSync(apkPath),
      fileSha256: fs.existsSync(apkPath) ? sha256File(apkPath) : "",
    });
  }
  return files;
}

/**
 * 计算荣耀上传/发布会涉及的字段。
 *
 * @param {object} config 荣耀配置。
 * @returns {string[]} 字段列表。
 */
function getHonorUpdateFields(config) {
  return ["client_credentials", "get-app-id", "get-file-upload-url", "file-upload", "update-file-info", "update-language-info", ...(config.submitForReview ? ["submit-audit"] : [])];
}

/**
 * 从应用详情中查找指定语言配置。
 *
 * @param {object} appDetail get-app-detail 响应。
 * @param {string} languageId 语言 ID。
 * @returns {object|undefined} 语言配置。
 */
function findLanguageInfo(appDetail, languageId) {
  const list = appDetail?.data?.languageInfo || appDetail?.languageInfo || [];
  return list.find((item) => item.languageId === languageId) || list[0];
}

/**
 * 读取渠道更新说明，优先使用荣耀单独配置，留空时复用全局更新日志。
 *
 * @param {object} config 荣耀配置。
 * @returns {string} 更新说明。
 */
function getUpdateDescription(config) {
  return String(config.releaseNotes || readCurrentNotes() || "").trim();
}

/**
 * 确保当前流程已有荣耀 APPID。
 *
 * 优先级：用户配置 appId -> release-db 流程状态 -> 实时按包名查询。
 * 这样分步骤执行时，上传/绑定/提审都能复用前一步结果。
 *
 * @param {object} config 荣耀配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} APPID 查询结果。
 */
async function ensureHonorAppId(config, signal) {
  const state = readStoreState(STORE_KEY);
  if (!isBlank(config.appId)) {
    return { ok: true, store: STORE_KEY, action: "query-app-id", appId: config.appId, state: sanitizeStateForResponse(state) };
  }
  if (!isBlank(state.appId)) {
    return { ok: true, store: STORE_KEY, action: "query-app-id", appId: state.appId, state: sanitizeStateForResponse(state) };
  }
  return queryAppIdStep(config, signal);
}

/**
 * 校验指定字段是否存在。
 *
 * @param {object} config 当前平台配置。
 * @param {string[]} fields 必填字段列表。
 * @returns {object} 校验结果。
 */
function requireFields(config, fields) {
  const missing = fields.filter((key) => {
    if (key === "enabled") return !config.enabled;
    return isBlank(config[key]);
  });
  return missing.length === 0 ? { ok: true, store: STORE_KEY } : buildFailure("荣耀发布配置预检未通过。", missing);
}

/**
 * 构建标准失败响应。
 *
 * @param {string} message 失败说明。
 * @param {string[]} missing 缺失字段或文件。
 * @returns {object} 失败响应。
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
 * 重置荣耀分步骤流程状态。
 *
 * @returns {object} 重置结果。
 */
function resetHonorState() {
  clearStoreState(STORE_KEY);
  return {
    ok: true,
    store: STORE_KEY,
    action: "reset-state",
    message: "荣耀流程状态已重置。",
    state: {},
  };
}

/**
 * 统一记录一键流程失败并返回结果。
 *
 * @param {string} startedAt 开始时间。
 * @param {string} message 失败说明。
 * @param {object[]} steps 已执行步骤摘要。
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
 * 抽取流程步骤摘要，避免一键结果把大段接口响应写入日志。
 *
 * @param {object} result 单步骤结果。
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
 * 把荣耀审核结果转换成用户能直接理解的状态文案。
 *
 * 荣耀有两个查询接口：get-audit-result 查询指定 releaseId，
 * get-app-current-release 查询当前版本；两者的 auditResult=3/4 语义不同，
 * 所以这里按来源分别映射，避免页面只显示一个数字。
 *
 * @param {object} auditResult 荣耀审核结果对象。
 * @param {"release"|"current"} source 查询来源。
 * @returns {{label: string, text: string}} 审核状态摘要。
 */
function formatHonorAuditResult(auditResult = {}, source = "release") {
  const labels = source === "current" ? HONOR_CURRENT_RELEASE_AUDIT_LABELS : HONOR_RELEASE_AUDIT_LABELS;
  const rawCode = auditResult?.auditResult;
  const code = rawCode === undefined || rawCode === null || rawCode === "" ? "" : Number(rawCode);
  const label = Number.isFinite(code) && labels[code] ? labels[code] : rawCode === undefined ? "未返回审核状态" : `未知状态(${rawCode})`;
  const details = [];
  if (!isBlank(auditResult.releaseId)) details.push(`releaseId: ${auditResult.releaseId}`);
  if (!isBlank(auditResult.versionName)) details.push(`版本: ${auditResult.versionName}${isBlank(auditResult.versionCode) ? "" : `(${auditResult.versionCode})`}`);
  if (!isBlank(auditResult.auditMessage)) details.push(`审核意见: ${auditResult.auditMessage}`);
  if (!isBlank(auditResult.auditAttachment)) details.push(`附件: ${auditResult.auditAttachment}`);
  return {
    label,
    text: details.length > 0 ? `${label}，${details.join("，")}` : label,
  };
}

/**
 * 隐藏荣耀 token 响应里的真实 access_token。
 *
 * @param {object} response Token 原始响应。
 * @returns {object} 可展示摘要。
 */
function sanitizeTokenResponse(response = {}) {
  return {
    ...response,
    access_token: response.access_token ? maskSecret(response.access_token) : undefined,
  };
}

/**
 * 压缩荣耀接口响应，避免上传记录写入过大的原始对象。
 *
 * @param {object} response 原始响应。
 * @returns {object} 可保存响应摘要。
 */
function sanitizeHonorResponse(response = {}) {
  return limitObjectSize(response, { maxLength: 4000, previewLength: 1200 });
}

/**
 * 压缩荣耀应用详情响应。
 *
 * @param {object} response get-app-detail 原始响应。
 * @returns {object} 可保存应用详情摘要。
 */
function sanitizeAppDetail(response = {}) {
  return limitObjectSize(response, { maxLength: 4000, previewLength: 1200 });
}

/**
 * 清理流程状态，避免把敏感响应或过大对象直接返回给前端。
 *
 * @param {object} stateInfo 原始状态。
 * @returns {object} 前端步骤条使用的状态。
 */
function sanitizeStateForResponse(stateInfo = {}) {
  return compactObject({
    tokenCheckedAt: stateInfo.tokenCheckedAt,
    tokenExpiresIn: stateInfo.tokenExpiresIn,
    appId: stateInfo.appId,
    appIdQueriedAt: stateInfo.appIdQueriedAt,
    appDetailQueriedAt: stateInfo.appDetailQueriedAt,
    uploadedPackage: stateInfo.uploadedPackage,
    fileInfoUpdatedAt: stateInfo.fileInfoUpdatedAt,
    languageInfoUpdatedAt: stateInfo.languageInfoUpdatedAt,
    reviewSubmittedAt: stateInfo.reviewSubmittedAt,
    auditStatusQueriedAt: stateInfo.auditStatusQueriedAt,
    currentReleaseQueriedAt: stateInfo.currentReleaseQueriedAt,
    lastReleaseId: stateInfo.lastReleaseId,
    lastAuditResult: stateInfo.lastAuditResult,
    lastAuditResultLabel: stateInfo.lastAuditResultLabel,
    lastCurrentRelease: stateInfo.lastCurrentRelease,
    lastCurrentReleaseLabel: stateInfo.lastCurrentReleaseLabel,
  });
}

/**
 * 构建荣耀文档要求的 Authorization 认证头。
 *
 * 荣耀公开文档所有 Publish API 都写的是 Authorization: Bearer ${access_token}。
 *
 * @param {string} token access_token 或 Bearer token。
 * @returns {string} Authorization 头值。
 */
function buildAuthorizationHeader(token) {
  const raw = String(token || "")
    .trim()
    .replace(/^Bearer\s+/i, "");
  return `Bearer ${raw}`;
}

/**
 * 校验荣耀业务接口 code 是否成功。
 *
 * @param {object} json 响应 JSON。
 * @param {string} prefix 错误前缀。
 * @returns {void}
 */
function assertHonorSuccess(json, prefix, context = {}) {
  if (Number(json?.code) === 0) return;
  const detail = json?.msg || json?.message || JSON.stringify(json).slice(0, 300);
  const advice = getHonorErrorAdvice(json);
  const contextText = Object.keys(context).length > 0 ? `；诊断：${JSON.stringify(context)}` : "";
  throw new Error(`${prefix}：${detail}${advice ? `；建议：${advice}` : ""}${contextText}`);
}

/**
 * 根据荣耀业务错误码补充可操作建议。
 *
 * 10002 在荣耀文档里是 access_token 非合法格式。我们已经验证
 * Authorization: Bearer 和 Authorization: raw 都会返回 10002，
 * 因此它更可能是当前 API Client 没有 Publish API/传包服务权限，
 * 或者使用了错误类型的 API 密钥，而不是前端/后端把 token 放错 header。
 *
 * @param {object} json 荣耀接口响应。
 * @returns {string} 排查建议。
 */
function getHonorErrorAdvice(json) {
  if (Number(json?.code) === 10001) return "荣耀网关没有读取到 access_token，请确认请求没有被代理层移除 Authorization header。";
  if (Number(json?.code) === 10002) return "access_token 已被荣耀网关读取但不被当前 Publish API 接受，请在荣耀后台确认 API Client 类型、应用分发/传包服务权限，以及该 Client 是否绑定当前应用。";
  if (Number(json?.code) === 10003) return "access_token 已过期，请重新执行 Token 校验或重新发起发布流程。";
  return "";
}

/**
 * 计算文件 SHA256。
 *
 * @param {string} filePath 文件路径。
 * @returns {string} 小写十六进制 SHA256。
 */
function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
    actionLabel: getActionLabel(action),
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: Boolean(result.ok),
    message: result.message || "",
    uploadedFiles: result.uploadedFiles || [],
    updateFields: result.updateFields || [],
    warnings: result.warnings || [],
    appId: result.appId || undefined,
    releaseId: result.releaseId || undefined,
    auditResult: result.auditResult || undefined,
    auditResultLabel: result.auditResultLabel || undefined,
    docsUrl: result.docsUrl || HONOR_DOCS_URL,
  };
}

/**
 * 获取上传记录里的动作名称。
 *
 * @param {string} action 动作名。
 * @returns {string} 中文动作名称。
 */
function getActionLabel(action) {
  return ACTION_LABELS[action] || `荣耀 ${action}`;
}

/**
 * 去掉 URL 末尾斜杠。
 *
 * @param {string} value URL。
 * @returns {string} 规范化 URL。
 */
function trimBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

module.exports = {
  runHonorUpload,
  buildHonorPrecheck,
  normalizeHonorConfig,
};
