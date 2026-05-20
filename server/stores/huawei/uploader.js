const fs = require("fs");
const path = require("path");
const { clearStoreState, readStoreConfig, readStoreState, recordUploadRun, writeStoreState } = require("../../db");
const { isBlank, throwIfAborted } = require("../common");
const {
  normalizeHuaweiConfig,
  importApiClientJson,
  queryAppInfo,
  requestAccessToken,
  requestUploadUrl,
  submitReview,
  updatePackageInfo,
  uploadPackageFile,
} = require("./client");

const STORE_KEY = "huawei";

const ACTION_LABELS = {
  upload: "一键执行华为发布",
  precheck: "预检配置",
  "token-check": "获取/校验 Token",
  "upload-package": "上传包体",
  "update-package-info": "更新应用包信息",
  "query-package-info": "查询包信息",
  "submit-review": "提交审核",
  "revoke-review": "撤销审核",
  "reset-state": "重置流程状态",
};

/**
 * 执行华为一键发布流程。
 *
 * 顶部“执行上传”按钮会调用这个方法，按固定顺序自动串联：
 * 预检 -> Token 校验 -> 上传包体 -> 更新应用包信息 -> 查询包信息；
 * 只有 submitForReview 开关打开时才继续提交审核。
 *
 * @param {{updateProgress?: Function, signal?: AbortSignal, config?: object}} options 执行选项。
 * @returns {Promise<object>} 一键流程结果。
 */
async function runHuaweiFullUpload(options = {}) {
  const startedAt = new Date().toISOString();
  const config = getHuaweiConfig(options.config || {});
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const steps = [];

  try {
    // 一键流程代表一轮新的华为发布链路，启动时先清空旧中间状态。
    // 这样前端步骤条不会把上一次的包体上传/提交审核误展示为当前进度。
    clearStoreState(STORE_KEY);
    updateProgress({ phase: "precheck", percent: 8, statusText: "华为预检", detail: "正在检查配置和安装包路径" });
    throwIfAborted(signal);
    const precheck = buildPrecheck(config);
    steps.push(pickStepSummary(precheck));
    if (!precheck.ok) {
      const result = {
        ...precheck,
        action: "upload",
        message: "华为一键发布预检未通过，已取消后续步骤。",
        steps,
      };
      recordUploadRun(createHuaweiRunRecord("upload", startedAt, result));
      return result;
    }

    updateProgress({ phase: "token", percent: 18, statusText: "校验 Token", detail: "正在校验华为 Connect API Client" });
    throwIfAborted(signal);
    const tokenResult = await tokenCheck(config);
    steps.push(pickStepSummary(tokenResult));
    if (!tokenResult.ok) return recordAndReturnFullUploadFailure(startedAt, "华为 Token 校验失败，已停止一键流程。", steps, tokenResult);

    updateProgress({ phase: "uploading", percent: 42, statusText: "上传包体", detail: "正在上传 APK/AAB 到华为" });
    throwIfAborted(signal);
    const uploadResult = await uploadPackage(config);
    steps.push(pickStepSummary(uploadResult));
    if (!uploadResult.ok) return recordAndReturnFullUploadFailure(startedAt, "华为包体上传失败，已停止一键流程。", steps, uploadResult);

    updateProgress({ phase: "packageInfo", percent: 75, statusText: "更新包信息", detail: "正在调用华为应用包信息更新接口" });
    throwIfAborted(signal);
    const updateResult = await updatePackage(config);
    steps.push(pickStepSummary(updateResult));
    if (!updateResult.ok) return recordAndReturnFullUploadFailure(startedAt, "华为应用包信息更新失败，已停止一键流程。", steps, updateResult);

    updateProgress({ phase: "query", percent: 90, statusText: "查询包信息", detail: "正在查询华为侧应用信息" });
    throwIfAborted(signal);
    const queryResult = await queryPackage(config);
    steps.push(pickStepSummary(queryResult));
    if (!queryResult.ok) return recordAndReturnFullUploadFailure(startedAt, "华为包信息查询失败。", steps, queryResult);

    let submitResult = null;
    if (config.submitForReview) {
      updateProgress({ phase: "submit", percent: 96, statusText: "提交审核", detail: "正在调用华为提交审核接口" });
      throwIfAborted(signal);
      submitResult = await submitPackageReview(config);
      steps.push(pickStepSummary(submitResult));
      if (!submitResult.ok) return recordAndReturnFullUploadFailure(startedAt, "华为提交审核失败。", steps, submitResult);
    }

    const result = {
      ok: true,
      store: STORE_KEY,
      action: "upload",
      message: config.submitForReview ? "华为一键发布流程已完成，并已提交审核。" : "华为一键发布流程已完成，未提交审核。",
      steps,
      uploadedFiles: uploadResult.uploadedFiles || [],
      response: {
        upload: uploadResult.response,
        updatePackageInfo: updateResult.response,
        queryPackageInfo: queryResult.response,
        submitReview: submitResult?.response,
      },
      state: queryResult.state,
    };
    recordUploadRun(createHuaweiRunRecord("upload", startedAt, result));
    return result;
  } catch (error) {
    const result = {
      ok: false,
      store: STORE_KEY,
      action: "upload",
      message: `华为一键发布流程失败：${error.message}`,
      steps,
    };
    recordUploadRun(createHuaweiRunRecord("upload", startedAt, result));
    return result;
  }
}

/**
 * 执行华为分步骤发布动作。
 *
 * 华为发布流程不适合做成“一键上传”：上传授权、包体上传、包信息更新、
 * 查询和提交审核都是独立步骤，所以这里按 action 明确执行单一步骤。
 *
 * @param {string} action 操作名。
 * @returns {Promise<object>} 操作结果。
 */
async function runHuaweiAction(action = "precheck", options = {}) {
  const startedAt = new Date().toISOString();
  const config = getHuaweiConfig(options.config || {});
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  let result;

  try {
    if (action === "import-client") result = importClientConfig(config);
    else if (action === "precheck") result = buildPrecheck(config);
    else if (action === "reset-state") result = resetHuaweiState();
    else if (action === "token-check") result = await tokenCheck(config);
    else if (action === "upload-package") result = await uploadPackage(config, { resetState: true });
    else if (action === "update-package-info") result = await updatePackage(config);
    else if (action === "query-package-info") result = await queryPackage(config);
    else if (action === "submit-review") result = await submitPackageReview(config);
    else if (action === "revoke-review") result = await revokePackageReview(config, updateProgress);
    else result = buildFailure(`未知华为发布动作：${action}`, []);
  } catch (error) {
    result = buildFailure(error.message || "华为发布步骤执行失败。", []);
  }

  // 预检只是本地表单校验，不写入上传历史；真实接口动作才记录执行摘要。
  if (!["precheck", "import-client", "reset-state"].includes(action)) recordUploadRun(createHuaweiRunRecord(action, startedAt, result));
  return result;
}

/**
 * 读取并规范化华为本地配置。
 *
 * @returns {object} 华为配置。
 */
function getHuaweiConfig(override = {}) {
  return normalizeHuaweiConfig({ ...(readStoreConfig().stores.huawei || {}), ...override });
}

/**
 * 构建华为预检结果。
 *
 * 预检只检查本地参数和文件，不访问华为接口；每个真实步骤还会再次调用它，
 * 保证用户修改配置但忘记保存时能得到明确失败原因。
 *
 * @param {object} config 华为配置。
 * @returns {object} 预检结果。
 */
function buildPrecheck(config) {
  const missing = [];
  const warnings = [];

  if (!config.enabled) missing.push("enabled");
  ["clientId", "clientSecret", "appId", "packageName", "apkPath", "fileSuffix", "fileType"].forEach((key) => {
    if (isBlank(config[key])) missing.push(key);
  });

  if (config.apkPath && !fs.existsSync(config.apkPath)) {
    missing.push(`apkPath: ${config.apkPath}`);
  }

  if (config.apkPath && fs.existsSync(config.apkPath)) {
    const actualSuffix = path.extname(config.apkPath).replace(".", "").toLowerCase();
    if (actualSuffix && actualSuffix !== config.fileSuffix) {
      warnings.push(`包路径后缀为 ${actualSuffix}，但配置的文件后缀是 ${config.fileSuffix}。`);
    }
  }

  if (!config.submitForReview) {
    warnings.push("提交审核开关未开启，后续只能上传和更新包信息，不会提交审核。");
  }

  const state = readStoreState(STORE_KEY);
  return {
    ok: missing.length === 0,
    store: STORE_KEY,
    action: "precheck",
    message: missing.length === 0 ? "华为发布预检通过。" : "华为发布预检未通过。",
    missing,
    warnings,
    plannedFiles: config.apkPath ? [{
      localKey: "apkPath",
      fileType: config.fileSuffix,
      path: config.apkPath,
      exists: fs.existsSync(config.apkPath),
    }] : [],
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 从华为 API Client JSON 导入 Client ID / Secret。
 *
 * 只返回可合并到前端配置表单的字段，日志和历史记录不会打印 clientSecret。
 *
 * @param {object} config 华为配置。
 * @returns {object} 导入结果。
 */
function importClientConfig(config) {
  if (isBlank(config.apiClientJsonPath)) {
    return buildFailure("请先填写华为 API Client JSON 路径。", ["apiClientJsonPath"]);
  }
  const importedConfig = importApiClientJson(config.apiClientJsonPath);
  return {
    ok: true,
    store: STORE_KEY,
    action: "import-client",
    message: "华为 API Client JSON 已读取，Client ID / Secret 已回填到表单。",
    config: importedConfig,
    state: sanitizeStateForResponse(readStoreState(STORE_KEY)),
  };
}

/**
 * 清空华为分步骤流程状态。
 *
 * 这个动作只影响 release-db.json 中的 huawei 状态，不修改上传配置、
 * 不删除本地 APK/AAB，也不会调用任何华为外部接口。
 *
 * @returns {object} 重置结果。
 */
function resetHuaweiState() {
  clearStoreState(STORE_KEY);
  return {
    ok: true,
    store: STORE_KEY,
    action: "reset-state",
    message: "华为流程状态已重置。",
    state: {},
  };
}

/**
 * 校验 token 获取能力。
 *
 * @param {object} config 华为配置。
 * @returns {Promise<object>} token 校验结果。
 */
async function tokenCheck(config) {
  const precheck = requireFields(config, ["enabled", "clientId", "clientSecret", "appId"]);
  if (!precheck.ok) return precheck;

  const token = await requestAccessToken(config);
  const state = writeStoreState(STORE_KEY, {
    tokenCheckedAt: new Date().toISOString(),
    tokenExpiresIn: token.expiresIn,
    tokenFromCache: Boolean(token.fromCache),
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "token-check",
    message: token.fromCache ? "华为 Token 校验成功，已复用缓存。" : "华为 Token 校验成功，已刷新缓存。",
    response: token.response,
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 上传华为 APK/AAB 包体。
 *
 * @param {object} config 华为配置。
 * @param {{resetState?: boolean}} options 上传选项。
 * @returns {Promise<object>} 包体上传结果。
 */
async function uploadPackage(config, options = {}) {
  const precheck = buildPrecheck(config);
  if (!precheck.ok) return { ...precheck, action: "upload-package", message: "华为配置未通过预检，已取消包体上传。" };

  // 重新上传包体时，后面的“包信息更新/查询/提交审核”都必须重新做。
  // 因此先清空旧状态，再写入这次上传成功后的 fileDestUrl。
  if (options.resetState) clearStoreState(STORE_KEY);
  const token = await requestAccessToken(config);
  const uploadAuth = await requestUploadUrl(config, token.accessToken);
  const fileInfo = await uploadPackageFile(uploadAuth.uploadUrl, uploadAuth.authCode, config.apkPath);
  if (!fileInfo.fileDestUrl) {
    throw new Error(`华为包体上传响应缺少 fileDestUrl，无法继续更新应用包信息。响应摘要：${JSON.stringify(summarizeUploadResponse(fileInfo.raw))}`);
  }
  const state = writeStoreState(STORE_KEY, {
    uploadedPackage: {
      fileName: fileInfo.fileName,
      fileDestUrl: fileInfo.fileDestUrl,
      size: fileInfo.size,
      suffix: config.fileSuffix,
      sourcePath: config.apkPath,
      uploadedAt: new Date().toISOString(),
    },
  });

  return {
    ok: true,
    store: STORE_KEY,
    action: "upload-package",
    message: "华为包体上传完成，下一步可以更新应用包信息。",
    uploadedFiles: [{
      localKey: "apkPath",
      fileType: config.fileSuffix,
      path: config.apkPath,
      fileName: fileInfo.fileName,
      size: fileInfo.size,
    }],
    response: summarizeUploadResponse(fileInfo.raw),
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 调用华为应用包信息更新接口。
 *
 * @param {object} config 华为配置。
 * @returns {Promise<object>} 包信息更新结果。
 */
async function updatePackage(config) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "appId", "fileType", "lang"]);
  if (!required.ok) return required;

  const state = readStoreState(STORE_KEY);
  if (!state.uploadedPackage?.fileDestUrl) {
    return buildFailure("缺少已上传包体信息，请先执行“上传包体”。", ["uploadedPackage.fileDestUrl"]);
  }

  const token = await requestAccessToken(config);
  const response = await updatePackageInfo(config, token.accessToken, state.uploadedPackage);
  const nextState = writeStoreState(STORE_KEY, {
    packageInfoUpdatedAt: new Date().toISOString(),
    lastPackageInfoResponse: response,
  });

  return {
    ok: true,
    store: STORE_KEY,
    action: "update-package-info",
    message: "华为应用包信息已更新，建议继续查询包信息确认状态。",
    response,
    state: sanitizeStateForResponse(nextState),
  };
}

/**
 * 查询华为应用信息。
 *
 * @param {object} config 华为配置。
 * @returns {Promise<object>} 查询结果。
 */
async function queryPackage(config) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "appId"]);
  if (!required.ok) return required;

  const token = await requestAccessToken(config);
  const response = await queryAppInfo(config, token.accessToken);
  const state = writeStoreState(STORE_KEY, {
    packageInfoQueriedAt: new Date().toISOString(),
    lastPackageInfoQuery: response,
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "query-package-info",
    message: "华为应用信息查询完成。",
    response,
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 提交华为审核。
 *
 * @param {object} config 华为配置。
 * @returns {Promise<object>} 提交审核结果。
 */
async function submitPackageReview(config) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "appId"]);
  if (!required.ok) return required;

  if (!config.submitForReview) {
    return buildFailure("华为“允许提交审核”开关未开启，已阻止真实提交审核。", ["submitForReview"]);
  }

  const token = await requestAccessToken(config);
  const response = await submitReview(config, token.accessToken);
  const state = writeStoreState(STORE_KEY, {
    reviewSubmittedAt: new Date().toISOString(),
    lastSubmitReviewResponse: response,
  });
  return {
    ok: true,
    store: STORE_KEY,
    action: "submit-review",
    message: "华为提交审核接口已调用，请继续在后台确认审核状态。",
    response,
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 撤销华为审核。
 *
 * 华为发布流程已经把“提交审核”接入到独立步骤；撤销审核同样需要官方明确的
 * Connect API 路由和请求体后才能真实执行。当前先把动作接入统一任务进度、
 * 上传记录和前端危险操作区，避免用户误触“一键撤销”时没有任何反馈。
 *
 * @param {object} config 华为配置。
 * @param {Function} updateProgress 任务进度回调。
 * @returns {Promise<object>} 撤销动作结果。
 */
async function revokePackageReview(config, updateProgress = () => {}) {
  const required = requireFields(config, ["enabled", "clientId", "clientSecret", "appId"]);
  if (!required.ok) return { ...required, action: "revoke-review" };

  updateProgress({
    phase: "revoke",
    percent: 100,
    statusText: "撤销接口未接入",
    detail: "华为撤销审核需要确认官方 Connect API 路由，当前不会猜测调用。",
  });
  const state = writeStoreState(STORE_KEY, {
    lastReviewRevokeCheckedAt: new Date().toISOString(),
    lastReviewRevokeMessage: "当前未配置华为撤销审核接口。",
  });
  return {
    ok: false,
    store: STORE_KEY,
    action: "revoke-review",
    message: "华为暂未接入自动撤销审核接口，请先到 AppGallery Connect 后台人工撤销；确认官方撤销审核接口后可在 huawei/uploader.js 单独补接。",
    warnings: ["为了避免误调用不确定接口，当前不会猜测华为撤销审核路由。"],
    state: sanitizeStateForResponse(state),
  };
}

/**
 * 按动作要求校验必填字段。
 *
 * @param {object} config 华为配置。
 * @param {string[]} keys 必填字段。
 * @returns {object} 校验结果。
 */
function requireFields(config, keys) {
  const missing = keys.filter((key) => key === "enabled" ? !config.enabled : isBlank(config[key]));
  return missing.length === 0
    ? { ok: true }
    : buildFailure("华为发布配置缺少必填字段。", missing);
}

/**
 * 创建华为执行失败结果。
 *
 * @param {string} message 失败原因。
 * @param {string[]} missing 缺少字段。
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
 * 创建上传历史记录。
 *
 * @param {string} action 执行动作。
 * @param {string} startedAt 开始时间。
 * @param {object} result 执行结果。
 * @returns {object} 可写入 release-db.json 的历史记录。
 */
function createHuaweiRunRecord(action, startedAt, result) {
  return {
    id: `${Date.now()}-${STORE_KEY}-${action}`,
    store: STORE_KEY,
    action,
    actionLabel: ACTION_LABELS[action] || action,
    ok: Boolean(result.ok),
    message: result.message || "",
    startedAt,
    finishedAt: new Date().toISOString(),
    uploadedFiles: result.uploadedFiles || [],
    missing: result.missing || [],
  };
}

/**
 * 记录并返回一键流程失败。
 *
 * @param {string} startedAt 开始时间。
 * @param {string} message 失败文案。
 * @param {object[]} steps 已执行步骤摘要。
 * @param {object} failedResult 失败步骤结果。
 * @returns {object} 已记录的失败结果。
 */
function recordAndReturnFullUploadFailure(startedAt, message, steps, failedResult) {
  const result = {
    ok: false,
    store: STORE_KEY,
    action: "upload",
    message: failedResult.message || message,
    missing: failedResult.missing || [],
    warnings: failedResult.warnings || [],
    steps,
    uploadedFiles: failedResult.uploadedFiles || [],
    state: failedResult.state,
  };
  recordUploadRun(createHuaweiRunRecord("upload", startedAt, result));
  return result;
}

/**
 * 提取步骤摘要，避免一键结果里塞入过大的接口响应。
 *
 * @param {object} result 单步骤结果。
 * @returns {object} 步骤摘要。
 */
function pickStepSummary(result) {
  return {
    action: result.action,
    ok: Boolean(result.ok),
    message: result.message || "",
    missing: result.missing || [],
    warnings: result.warnings || [],
  };
}

/**
 * 清理返回给前端的华为步骤状态。
 *
 * @param {object} state 本地数据库中的原始状态。
 * @returns {object} 不含敏感凭据的状态摘要。
 */
function sanitizeStateForResponse(state = {}) {
  return {
    tokenCheckedAt: state.tokenCheckedAt || "",
    tokenExpiresIn: state.tokenExpiresIn || "",
    uploadedPackage: state.uploadedPackage || null,
    packageInfoUpdatedAt: state.packageInfoUpdatedAt || "",
    packageInfoQueriedAt: state.packageInfoQueriedAt || "",
    reviewSubmittedAt: state.reviewSubmittedAt || "",
    lastReviewRevokeCheckedAt: state.lastReviewRevokeCheckedAt || "",
    updatedAt: state.updatedAt || "",
  };
}

/**
 * 缩减上传响应，避免把过大的原始响应直接写入前端日志。
 *
 * @param {object} response 华为上传服务响应。
 * @returns {object} 响应摘要。
 */
function summarizeUploadResponse(response) {
  if (!response || typeof response !== "object") return {};
  return {
    result: response.result,
    code: response.code,
    message: response.message,
    ret: response.ret,
    dataKeys: response.data && typeof response.data === "object" ? Object.keys(response.data) : undefined,
    resultKeys: response.result && typeof response.result === "object" ? Object.keys(response.result) : undefined,
    fileInfoList: Array.isArray(response.fileInfoList) ? response.fileInfoList.map((item) => ({
      fileName: item.fileName,
      fileDestUrl: item.fileDestUrl || item.fileDestUlr || item.file_dest_url || item.destUrl || item.destUlr || item.url,
      size: item.size,
    })) : undefined,
  };
}

module.exports = {
  ACTION_LABELS,
  runHuaweiAction,
  runHuaweiFullUpload,
};
