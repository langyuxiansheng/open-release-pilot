const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { readCurrentNotes, readStoreConfig, recordUploadRun, writeStoreState } = require("../../db");
const { compactObject, formatBytes, isBlank, md5FileSync: md5File, resolveLocalPath, splitLines, throwIfAborted } = require("../common");

const STORE_KEY = "xiaomi";
const DEFAULT_BASE_URL = "https://api.developer.xiaomi.com/devupload";

/**
 * 执行小米自动发布入口。
 *
 * action=precheck 只检查本地配置和文件；
 * action=query-package 调用 /dev/query 查询应用基础信息；
 * action=query-categories 调用 /dev/category 查询可用分类；
 * action=upload 调用 /dev/push 推送更新包和应用信息。
 *
 * @param {{action?: string, updateProgress?: Function, signal?: AbortSignal}} options 上传动作。
 * @returns {Promise<object>} 预检、查询或上传结果。
 */
async function runXiaomiUpload(options = {}) {
  const action = options.action || "precheck";
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const config = getXiaomiConfig();
  const startedAt = new Date().toISOString();

  if (action === "query-categories") {
    const result = await queryCategories(config, signal);
    recordUploadRun(createUploadRunRecord(action, startedAt, result));
    return result;
  }

  if (action === "query-package") {
    const result = await queryPackage(config, signal);
    recordUploadRun(createUploadRunRecord(action, startedAt, result));
    return result;
  }

  if (action === "revoke-review") {
    updateProgress({
      phase: "unsupported",
      percent: 100,
      statusText: "撤销接口未开放",
      detail: "小米文档 FAQ 说明审核状态查询暂未开放，当前没有可确认的撤销审核接口。",
    });
    const result = {
      ok: false,
      store: STORE_KEY,
      action,
      message: "小米暂未接入自动撤销审核接口，请到小米开放平台后台人工处理审核中的版本。",
      warnings: ["当前官方自动发布文档未提供可确认的撤销审核接口。"],
    };
    recordUploadRun(createUploadRunRecord(action, startedAt, result));
    return result;
  }

  const precheck = buildUploadPrecheck(config);
  if (action !== "upload") return precheck;

  if (!precheck.ok) {
    updateProgress({
      phase: "precheck",
      percent: 10,
      statusText: "预检未通过",
      detail: "小米配置未通过预检",
    });
    const result = { ...precheck, message: "小米配置未通过预检，已取消真实上传。" };
    recordUploadRun(createUploadRunRecord(action, startedAt, result));
    return result;
  }

  try {
    updateProgress({
      phase: "precheck",
      percent: 12,
      statusText: "预检通过",
      detail: "小米配置和文件路径已确认",
    });
    const result = await pushApp(config, precheck, updateProgress, signal);
    recordUploadRun(createUploadRunRecord(action, startedAt, result));
    return result;
  } catch (error) {
    const result = {
      ok: false,
      store: STORE_KEY,
      action,
      message: `小米自动发布失败：${error.message}`,
      precheck,
    };
    recordUploadRun(createUploadRunRecord(action, startedAt, result));
    return result;
  }
}

/**
 * 读取并规范化小米发布配置。
 *
 * @returns {object} 小米发布配置。
 */
function getXiaomiConfig() {
  return normalizeXiaomiConfig(readStoreConfig().stores.xiaomi || {});
}

/**
 * 兼容早期配置字段，并补齐接口默认地址。
 *
 * 小米文档里的 password 是开发者站申请的自动发布接口密码；
 * 早期面板字段误命名为 privateKey，这里继续读取以免旧配置失效。
 *
 * @param {object} config 原始配置。
 * @returns {object} 规范化后的配置。
 */
function normalizeXiaomiConfig(config) {
  return {
    ...config,
    baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    apiPassword: config.apiPassword || config.password || config.privateKey || "",
    publicKey: config.publicKey || "",
    publicKeyPath: config.publicKeyPath || "",
    packageName: config.packageName || "",
    brief: config.brief || config.shortDesc || "",
  };
}

/**
 * 构建小米上传预检结果。
 *
 * @param {object} config 小米发布配置。
 * @returns {object} 预检结果。
 */
function buildUploadPrecheck(config) {
  const missing = [];
  const warnings = [];
  if (!config.enabled) missing.push("enabled");
  ["userName", "apiPassword", "packageName", "apkPath", "appName", "privacyUrl", "iconPath"].forEach((key) => {
    if (isBlank(config[key])) missing.push(key);
  });
  if (isBlank(getUpdateDescription(config))) missing.push("releaseNotes");
  if (isBlank(getPublicKeyText(config))) missing.push("publicKey/publicKeyPath");

  const plannedFiles = collectPlannedFiles(config);
  plannedFiles.forEach((file) => {
    if (!fs.existsSync(file.path)) missing.push(`${file.localKey}: ${file.path}`);
  });
  ["apkPath", "secondApkPath"].forEach((key) => {
    if (!isBlank(config[key]) && path.extname(config[key]).toLowerCase() !== ".apk") {
      missing.push(`${key} 必须是 .apk 文件`);
    }
  });

  const requestData = buildPushRequestData(config);
  return {
    ok: missing.length === 0 && warnings.length === 0,
    store: STORE_KEY,
    action: "precheck",
    message: missing.length === 0 && warnings.length === 0 ? "小米自动发布预检通过。" : "小米自动发布预检未通过。",
    missing,
    warnings,
    plannedFiles: plannedFiles.map((file) => ({
      localKey: file.localKey,
      formName: file.formName,
      path: file.path,
      exists: fs.existsSync(file.path),
    })),
    updateFields: getRequestAppInfoFields(requestData),
  };
}

/**
 * 查询小米应用基础信息。
 *
 * @param {object} config 小米发布配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 查询结果。
 */
async function queryPackage(config, signal) {
  const missing = getCredentialMissing(config, ["packageName"]);
  if (missing.length > 0) {
    return {
      ok: false,
      store: STORE_KEY,
      action: "query-package",
      message: "小米应用查询缺少必填配置。",
      missing,
    };
  }

  const requestData = { packageName: config.packageName, userName: config.userName };
  const response = await requestXiaomiJson(config, "/dev/query", requestData, [], 30_000, signal);
  const apiOk = isXiaomiSuccess(response);
  const canUpdateVersion = canUpdateXiaomiVersion(response);
  const apiMessage = getXiaomiMessage(response, "小米应用查询完成。");
  return {
    ok: apiOk && canUpdateVersion,
    store: STORE_KEY,
    action: "query-package",
    message: buildQueryPackageMessage(response, apiOk, canUpdateVersion, apiMessage),
    warnings: buildQueryPackageWarnings(apiOk, canUpdateVersion, response),
    appExists: Boolean(response.packageInfo || response.appInfo || response.data?.appInfo),
    canUpdateVersion,
    apiOk,
    response,
  };
}

/**
 * 查询小米开发者后台分类列表。
 *
 * @param {object} config 小米发布配置。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 查询结果。
 */
async function queryCategories(config, signal) {
  const response = await requestJsonUrl(`${trimBaseUrl(config.baseUrl)}/dev/category`, 30_000, signal);
  const categories = normalizeXiaomiCategories(response.categories || response.data?.categories || []);
  if (categories.length > 0) {
    writeStoreState(STORE_KEY, {
      categories,
      categoriesQueriedAt: new Date().toISOString(),
    });
  }
  return {
    ok: isXiaomiSuccess(response),
    store: STORE_KEY,
    action: "query-categories",
    message: getXiaomiMessage(response, "小米分类查询完成。"),
    categories,
    response,
  };
}

/**
 * 推送小米应用更新。
 *
 * @param {object} config 小米发布配置。
 * @param {object} precheck 已通过的预检结果。
 * @param {Function} updateProgress 进度回调。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} 上传结果。
 */
async function pushApp(config, precheck, updateProgress, signal) {
  throwIfAborted(signal);
  updateProgress({
    phase: "query",
    percent: 18,
    statusText: "读取小米应用信息",
    detail: "正在调用 /dev/query 读取已有应用基础信息",
  });
  const queryResult = await queryPackage(config, signal);
  if (!queryResult.canUpdateVersion) {
    const detail = queryResult.apiOk
      ? "小米查询成功，但当前不允许版本更新，请检查应用状态或先在开发者平台处理。"
      : queryResult.message;
    updateProgress({
      phase: "query",
      percent: 100,
      statusText: queryResult.apiOk ? "小米暂不允许更新" : "小米查询失败",
      detail,
    });
    return {
      ok: false,
      store: STORE_KEY,
      action: "upload",
      message: queryResult.message,
      warnings: queryResult.warnings,
      precheck,
      queryPackage: {
        ok: queryResult.ok,
        message: queryResult.message,
        apiOk: queryResult.apiOk,
        appExists: queryResult.appExists,
        canUpdateVersion: false,
      },
    };
  }
  const apkVersionCheck = checkApkVersionForXiaomiUpdate(config.apkPath, queryResult.response);
  if (!apkVersionCheck.ok) {
    updateProgress({
      phase: "version-check",
      percent: 100,
      statusText: "版本号不满足更新条件",
      detail: apkVersionCheck.message,
    });
    return {
      ok: false,
      store: STORE_KEY,
      action: "upload",
      message: apkVersionCheck.message,
      warnings: apkVersionCheck.warnings,
      precheck,
      queryPackage: {
        ok: queryResult.ok,
        message: queryResult.message,
        packageInfo: summarizeXiaomiPackageInfo(queryResult.response?.packageInfo),
      },
      localApk: apkVersionCheck.localApk,
    };
  }
  const remoteAppInfo = queryResult.ok ? extractRemoteAppInfo(queryResult.response) : {};

  updateProgress({
    phase: "sign",
    percent: 25,
    statusText: "生成 SIG",
    detail: "正在计算 RequestData 和文件 MD5",
  });
  const requestData = buildPushRequestData(config, remoteAppInfo);
  const files = collectPlannedFiles(config);

  updateProgress({
    phase: "uploading",
    percent: 35,
    statusText: "推送应用",
    detail: `正在上传 ${files.length} 个文件到小米 /dev/push`,
  });
  const response = await requestXiaomiJson(config, "/dev/push", requestData, files, 180_000, signal, (uploaded, total) => {
    const percent = total > 0 ? 35 + Math.round((uploaded / total) * 58) : 80;
    updateProgress({
      phase: "uploading",
      percent,
      statusText: "推送应用",
      detail: `已上传 ${formatBytes(uploaded)} / ${formatBytes(total)}`,
    });
  });

  const ok = isXiaomiSuccess(response);
  return {
    ok,
    store: STORE_KEY,
    action: "upload",
    message: ok ? "小米 /dev/push 已提交，请到小米开放平台确认审核结果。" : getXiaomiMessage(response, "小米 /dev/push 提交失败。"),
    precheck,
    queryPackage: {
      ok: queryResult.ok,
      message: queryResult.message,
      packageInfo: summarizeXiaomiPackageInfo(queryResult.response?.packageInfo),
    },
    uploadedFiles: files.map((file) => ({
      localKey: file.localKey,
      formName: file.formName,
      path: file.path,
    })),
    updateFields: getRequestAppInfoFields(requestData),
    response,
  };
}

/**
 * 构建 /dev/push 的 RequestData。
 *
 * @param {object} config 小米发布配置。
 * @returns {object} RequestData 对象。
 */
function buildPushRequestData(config, remoteAppInfo = {}) {
  const releaseNotes = getUpdateDescription(config);
  const appInfo = compactObject({
    packageName: config.packageName,
    appName: config.appName || remoteAppInfo.appName,
    publisherName: config.publisherName || remoteAppInfo.publisherName,
    category: config.category || remoteAppInfo.category,
    keyWords: config.keyWords || remoteAppInfo.keyWords,
    versionName: config.versionName || remoteAppInfo.versionName,
    desc: config.desc || remoteAppInfo.desc,
    brief: config.brief || config.shortDesc || remoteAppInfo.brief,
    updateDesc: releaseNotes,
    price: config.price || remoteAppInfo.price,
    privacyUrl: config.privacyUrl || remoteAppInfo.privacyUrl,
    web: config.web || remoteAppInfo.web,
    onlineTime: config.onlineTime,
    suitableType: config.suitableType || remoteAppInfo.suitableType,
    testAccount: buildTestAccountPayload(config),
  });

  return compactObject({
    userName: config.userName,
    synchroType: 1,
    appInfo: JSON.stringify(appInfo),
  });
}

/**
 * 读取 RequestData.appInfo 里的提交字段。
 *
 * 官方参数表要求 RequestData 是 JSON 字符串，且 appInfo 是其中的 JSON 字符串。
 * 历史记录需要展示 appInfo 字段名，所以这里把字符串解析回对象后提取 key；
 * 同时兼容早期对象形态。
 *
 * @param {object} requestData 小米 RequestData。
 * @returns {string[]} appInfo 字段名。
 */
function getRequestAppInfoFields(requestData) {
  if (requestData.appInfo && typeof requestData.appInfo === "object") return Object.keys(requestData.appInfo);
  try {
    return Object.keys(JSON.parse(requestData.appInfo || "{}"));
  } catch (error) {
    return [];
  }
}

/**
 * 从 /dev/query 响应里提取可复用的应用基础信息。
 *
 * 小米响应结构可能随后台接口调整而变化，这里只做宽松提取；
 * 取不到时不会阻塞更新包上传，仍然以用户在面板填写的更新说明和 APK 为主。
 *
 * @param {object} response /dev/query 响应。
 * @returns {object} 可合并进 RequestData.appInfo 的字段。
 */
function extractRemoteAppInfo(response = {}) {
  const source = response.appInfo || response.data?.appInfo || response.data || response.result || {};
  return compactObject({
    appName: source.appName || source.app_name || source.name,
    publisherName: source.publisherName || source.publisher_name || source.publisher,
    category: source.category || source.categoryName || source.category_id,
    keyWords: source.keyWords || source.keywords || source.key_words,
    versionName: source.versionName || source.version_name,
    desc: source.desc || source.description || source.introduce,
    brief: source.brief || source.shortDesc || source.summary || source.one_word_summary,
    price: source.price,
    privacyUrl: source.privacyUrl || source.privacy_url,
    web: source.web || source.website || source.officialWebsite,
    suitableType: source.suitableType || source.suitable_type,
  });
}

/**
 * 上传前校验 APK 版本号是否满足小米更新条件。
 *
 * 小米 /dev/query 的 updateVersion=true 只说明当前应用允许进入更新流程；
 * /dev/push 还会校验 APK 自身版本。真实上传失败时小米只返回
 * “未知异常,不满足应用更新条件”，所以这里先用 aapt 读取 APK manifest，
 * 发现 versionCode 没有高于线上版本时直接给出明确原因。
 *
 * @param {string} apkPath 本地 APK 路径。
 * @param {object} queryResponse /dev/query 响应。
 * @returns {{ok: boolean, message: string, warnings: string[], localApk?: object}} 校验结果。
 */
function checkApkVersionForXiaomiUpdate(apkPath, queryResponse = {}) {
  const packageInfo = queryResponse.packageInfo || {};
  const remoteVersionCode = Number(packageInfo.onlineVersionCode ?? packageInfo.versionCode);
  if (!Number.isFinite(remoteVersionCode)) {
    return {
      ok: true,
      message: "小米查询响应没有返回可比对的线上 versionCode，跳过本地版本号预校验。",
      warnings: ["未能读取小米线上 versionCode。"],
    };
  }

  const localApk = readApkBadging(apkPath);
  if (!localApk.ok) {
    return {
      ok: true,
      message: "未能读取本地 APK 版本号，跳过本地版本号预校验。",
      warnings: [localApk.message],
    };
  }

  const localVersionCode = Number(localApk.versionCode);
  if (!Number.isFinite(localVersionCode)) {
    return {
      ok: true,
      message: "本地 APK versionCode 不是数字，跳过本地版本号预校验。",
      warnings: [`本地 APK versionCode=${localApk.versionCode}`],
      localApk,
    };
  }

  if (localVersionCode <= remoteVersionCode) {
    return {
      ok: false,
      message: `小米更新包 versionCode 必须高于线上版本；当前 APK versionCode=${localVersionCode}，小米线上 versionCode=${remoteVersionCode}。请提升 Android 构建号后重新打包。`,
      warnings: [],
      localApk,
    };
  }

  return {
    ok: true,
    message: `APK versionCode=${localVersionCode} 高于小米线上 versionCode=${remoteVersionCode}。`,
    warnings: [],
    localApk,
  };
}

/**
 * 读取 APK manifest 基础信息。
 *
 * @param {string} apkPath 本地 APK 路径。
 * @returns {{ok: boolean, message?: string, packageName?: string, versionCode?: string, versionName?: string}} APK 信息。
 */
function readApkBadging(apkPath) {
  if (isBlank(apkPath) || !fs.existsSync(apkPath)) {
    return { ok: false, message: `APK 文件不存在：${apkPath || "-"}` };
  }
  const aapt = findAaptBinary();
  if (!aapt) {
    return { ok: false, message: "未找到 Android SDK build-tools/aapt，无法预校验 APK versionCode。" };
  }
  const result = spawnSync(aapt, ["dump", "badging", apkPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
  });
  if (result.status !== 0) {
    return { ok: false, message: `读取 APK 信息失败：${result.stderr || result.stdout || "aapt 执行失败"}`.trim() };
  }
  const packageLine = String(result.stdout || "").split(/\r?\n/).find((line) => line.startsWith("package:"));
  if (!packageLine) return { ok: false, message: "aapt 输出中没有 package 信息。" };
  return {
    ok: true,
    packageName: packageLine.match(/name='([^']+)'/)?.[1] || "",
    versionCode: packageLine.match(/versionCode='([^']+)'/)?.[1] || "",
    versionName: packageLine.match(/versionName='([^']+)'/)?.[1] || "",
  };
}

/**
 * 查找本机 Android SDK 的 aapt。
 *
 * @returns {string} aapt 绝对路径；找不到时返回空字符串。
 */
function findAaptBinary() {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || "", "Library/Android/sdk"),
  ].filter(Boolean);
  for (const sdkRoot of sdkRoots) {
    const buildToolsDir = path.join(sdkRoot, "build-tools");
    if (!fs.existsSync(buildToolsDir)) continue;
    const versions = fs.readdirSync(buildToolsDir)
      .map((name) => ({ name, file: path.join(buildToolsDir, name, "aapt") }))
      .filter((item) => fs.existsSync(item.file))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const latest = versions.at(-1);
    if (latest) return latest.file;
  }
  return "";
}

/**
 * 生成可写入结果记录的小米包信息摘要。
 *
 * @param {object|undefined} packageInfo 小米查询返回的 packageInfo。
 * @returns {object} 包信息摘要。
 */
function summarizeXiaomiPackageInfo(packageInfo = {}) {
  return compactObject({
    appName: packageInfo.appName,
    packageName: packageInfo.packageName,
    onlineVersionCode: packageInfo.onlineVersionCode,
    versionCode: packageInfo.versionCode,
    versionName: packageInfo.versionName,
  });
}

/**
 * 读取小米版本更新说明。
 *
 * 渠道发布说明优先，其次兼容早期 updateDesc/buildUpdateDescription，
 * 最后才使用全局更新日志，避免全局文案主动覆盖渠道专属文案。
 *
 * @param {object} config 小米配置。
 * @returns {string} 更新说明。
 */
function getUpdateDescription(config) {
  return config.releaseNotes || config.updateDesc || config.buildUpdateDescription || readCurrentNotes();
}

/**
 * 构建小米审核测试账号字段。
 *
 * 前端按小米后台样式拆成“登录方式 / 账号 / 密码 / 注册准入码”展示；
 * 真正提交时在后端拼成平台接口能接收的结构，避免用户直接编辑 JSON。
 *
 * @param {object} config 小米配置。
 * @returns {object|undefined} 测试账号结构。
 */
function buildTestAccountPayload(config) {
  const loginType = config.testLoginType || "账号密码登录";
  const account = config.testAccount || config.loginAccount || "";
  const password = config.testPassword || config.loginPassword || "";
  const registerCode = config.testRegisterCode || "-";
  const auditNotes = config.auditNotes || "";

  if (isBlank(account) && isBlank(password) && isBlank(auditNotes)) {
    return isBlank(config.testAccountJson) ? undefined : String(config.testAccountJson);
  }

  // 小米示例里的测试账号字段使用短键：t=登录方式，a=账号，p=密码，c=注册/准入码。
  // 前端展示中文标签，提交接口时在这里转换，避免用户维护难读的 JSON。
  const accountItem = compactObject({
    t: getXiaomiLoginTypeCode(loginType),
    a: account,
    p: password,
    c: isBlank(registerCode) ? "-" : registerCode,
  });
  return JSON.stringify({
    zh_CN: {
      accounts: accountItem.a ? [accountItem] : [],
      auditNotes,
    },
  });
}

/**
 * 转换小米测试账号登录方式编码。
 *
 * @param {string} loginType 前端展示的登录方式。
 * @returns {number} 小米测试账号 t 字段。
 */
function getXiaomiLoginTypeCode(loginType) {
  if (String(loginType).includes("验证码")) return 2;
  return 1;
}

/**
 * 汇总 /dev/push 计划上传的文件字段。
 *
 * @param {object} config 小米配置。
 * @returns {object[]} 文件字段列表。
 */
function collectPlannedFiles(config) {
  const files = [];
  addFile(files, "apkPath", "apk", config.apkPath);
  addFile(files, "secondApkPath", "secondApk", config.secondApkPath);
  addFile(files, "iconPath", "icon", config.iconPath);
  splitLines(config.screenshotPaths).slice(0, 5).forEach((filePath, index) => {
    addFile(files, "screenshotPaths", `screenshot_${index + 1}`, filePath);
  });
  splitLines(config.screenshotPadPaths).slice(0, 5).forEach((filePath, index) => {
    addFile(files, "screenshotPadPaths", `screenshot_pad_${index + 1}`, filePath);
  });
  return files;
}

/**
 * 规范化小米分类列表。
 *
 * @param {object[]} categories 分类接口返回。
 * @returns {{id: number|string, name: string}[]} 前端可直接渲染的分类列表。
 */
function normalizeXiaomiCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .map((item) => ({
      id: item.categoryId ?? item.id ?? item.value,
      name: item.categoryName || item.name || item.label || String(item.categoryId ?? item.id ?? ""),
    }))
    .filter((item) => !isBlank(item.id) && !isBlank(item.name));
}

/**
 * 追加单个文件字段。
 *
 * @param {object[]} files 文件列表。
 * @param {string} localKey 本地配置字段。
 * @param {string} formName 小米表单字段名。
 * @param {string} filePath 文件路径。
 * @returns {void}
 */
function addFile(files, localKey, formName, filePath) {
  if (isBlank(filePath)) return;
  files.push({ localKey, formName, path: String(filePath).trim() });
}

/**
 * 请求小米接口并解析 JSON。
 *
 * @param {object} config 小米配置。
 * @param {string} route 接口路由。
 * @param {object} requestData RequestData 对象。
 * @param {object[]} files 文件字段。
 * @param {number} timeoutMs 超时时间。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @param {Function} onProgress 上传进度回调。
 * @returns {Promise<object>} JSON 响应。
 */
function requestXiaomiJson(config, route, requestData, files, timeoutMs, signal, onProgress) {
  const requestDataText = JSON.stringify(requestData);
  const sigText = buildSigText(config, requestDataText, files);
  return requestMultipartJson(`${trimBaseUrl(config.baseUrl)}${route}`, {
    RequestData: requestDataText,
    SIG: sigText,
  }, files, timeoutMs, signal, onProgress);
}

/**
 * 构建小米 SIG。
 *
 * SIG 明文包含 RequestData MD5、每个文件 MD5 和接口 password；
 * 明文用小米公钥 RSA 加密后转为 hex 字符串提交。
 *
 * @param {object} config 小米配置。
 * @param {string} requestDataText RequestData JSON 字符串。
 * @param {object[]} files 文件字段。
 * @returns {string} 加密后的 SIG。
 */
function buildSigText(config, requestDataText, files) {
  const sig = [
    { name: "RequestData", hash: md5Buffer(Buffer.from(requestDataText)) },
    ...files.map((file) => ({ name: file.formName, hash: md5File(file.path) })),
  ];
  const source = JSON.stringify({ sig, password: config.apiPassword });
  return encryptByXiaomiPublicKey(normalizePublicKey(getPublicKeyText(config)), source);
}

/**
 * 按小米示例分块 RSA 加密 SIG 明文。
 *
 * 小米证书是 1024 位 RSA，PKCS#1 v1.5 单块最大只能加密 117 字节；
 * 推送包时 SIG 明文包含多个文件 MD5，长度会超过单块限制，所以必须按
 * keySize/8 - 11 分块加密后拼接 hex。
 *
 * @param {string} publicKeyPem PEM 格式公钥。
 * @param {string} source SIG 明文。
 * @returns {string} 分块加密后的十六进制 SIG。
 */
function encryptByXiaomiPublicKey(publicKeyPem, source) {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const keyBytes = Math.ceil((keyObject.asymmetricKeyDetails?.modulusLength || 1024) / 8);
  const maxChunkSize = keyBytes - 11;
  const sourceBuffer = Buffer.from(source, "utf8");
  const chunks = [];

  for (let offset = 0; offset < sourceBuffer.length; offset += maxChunkSize) {
    chunks.push(crypto.publicEncrypt({
      key: keyObject,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, sourceBuffer.subarray(offset, offset + maxChunkSize)));
  }
  return Buffer.concat(chunks).toString("hex");
}

/**
 * 发送 multipart/form-data 请求。
 *
 * @param {string} url 请求 URL。
 * @param {object} fields 普通表单字段。
 * @param {object[]} files 文件字段。
 * @param {number} timeoutMs 超时时间。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @param {Function} onProgress 上传进度回调。
 * @returns {Promise<object>} JSON 响应。
 */
function requestMultipartJson(url, fields, files, timeoutMs, signal, onProgress = () => {}) {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const boundary = `----open-release-pilot-xiaomi-${Date.now().toString(16)}`;
  const fieldBuffers = Object.entries(fields).map(([key, value]) => (
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
  ));
  const fileHeaders = files.map((file) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.formName}"; filename="${path.basename(file.path)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ));
  const fileStats = files.map((file) => fs.statSync(file.path));
  const fileSeparators = files.map(() => Buffer.from("\r\n"));
  const closing = Buffer.from(`--${boundary}--\r\n`);
  const contentLength = [...fieldBuffers, ...fileHeaders, ...fileSeparators, closing]
    .reduce((sum, buffer) => sum + buffer.length, 0) + fileStats.reduce((sum, stat) => sum + stat.size, 0);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }

    const req = transport.request({
      method: "POST",
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: timeoutMs,
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
          reject(new Error(`小米接口 HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`小米接口返回不是 JSON：${text.slice(0, 200)}`));
        }
      });
    });

    let activeStream = null;
    req.on("timeout", () => req.destroy(new Error(`小米接口请求超时：${url}`)));
    req.on("error", reject);
    signal?.addEventListener("abort", () => {
      activeStream?.destroy(new Error("上传任务已终止"));
      req.destroy(new Error("上传任务已终止"));
    }, { once: true });

    fieldBuffers.forEach((buffer) => req.write(buffer));
    writeFilesSequentially(req, files, fileHeaders, fileSeparators, closing, (stream) => {
      activeStream = stream;
    }, onProgress).catch(reject);
  });
}

/**
 * 顺序写入 multipart 文件流。
 *
 * @param {import("http").ClientRequest} req HTTP 请求对象。
 * @param {object[]} files 文件字段。
 * @param {Buffer[]} headers 文件头。
 * @param {Buffer[]} separators 文件分隔符。
 * @param {Buffer} closing 结束边界。
 * @param {Function} setActiveStream 保存当前文件流。
 * @param {Function} onProgress 进度回调。
 * @returns {Promise<void>} 写入完成。
 */
async function writeFilesSequentially(req, files, headers, separators, closing, setActiveStream, onProgress) {
  const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file.path).size, 0);
  let uploadedBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    req.write(headers[index]);
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(files[index].path);
      setActiveStream(stream);
      stream.on("data", (chunk) => {
        uploadedBytes += chunk.length;
        onProgress(uploadedBytes, totalBytes);
      });
      stream.on("error", reject);
      stream.on("end", () => {
        req.write(separators[index]);
        resolve();
      });
      stream.pipe(req, { end: false });
    });
  }
  req.end(closing);
}

/**
 * 查询普通 JSON URL。
 *
 * @param {string} url 请求地址。
 * @param {number} timeoutMs 超时时间。
 * @param {AbortSignal|undefined} signal 终止信号。
 * @returns {Promise<object>} JSON 响应。
 */
function requestJsonUrl(url, timeoutMs, signal) {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }
    const req = transport.request({
      method: "POST",
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`小米接口 HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`小米接口返回不是 JSON：${text.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`小米接口请求超时：${url}`)));
    req.on("error", reject);
    signal?.addEventListener("abort", () => req.destroy(new Error("上传任务已终止")), { once: true });
    req.end();
  });
}

/**
 * 读取小米公钥文本。
 *
 * @param {object} config 小米配置。
 * @returns {string} 公钥文本。
 */
function getPublicKeyText(config) {
  if (!isBlank(config.publicKey)) return extractPublicKeyPem(Buffer.from(String(config.publicKey).trim()));
  if (!isBlank(config.publicKeyPath)) {
    const certPath = resolveLocalPath(config.publicKeyPath);
    if (fs.existsSync(certPath)) return extractPublicKeyPem(fs.readFileSync(certPath));
  }
  return "";
}

/**
 * 从小米 .cer 证书或 PEM 公钥文本中提取 RSA 公钥。
 *
 * 小米提供的是 dev.xiaomi.api.public.cer 证书文件；SIG 生成时真正需要的是
 * 证书里的 SubjectPublicKeyInfo。这里在后端提取，前端只维护证书路径即可。
 *
 * @param {Buffer} content 证书或公钥文件内容。
 * @returns {string} PEM public key。
 */
function extractPublicKeyPem(content) {
  const text = content.toString("utf8").trim();
  if (text.includes("BEGIN PUBLIC KEY")) return text;
  if (text.includes("BEGIN CERTIFICATE")) {
    return new crypto.X509Certificate(text).publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  try {
    return new crypto.X509Certificate(content).publicKey.export({ type: "spki", format: "pem" }).toString();
  } catch (error) {
    return text;
  }
}

/**
 * 规范化公钥为 PEM 格式。
 *
 * @param {string} publicKey 公钥文本。
 * @returns {string} PEM 公钥。
 */
function normalizePublicKey(publicKey) {
  const trimmed = String(publicKey || "").trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) return trimmed;
  const body = trimmed.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") || trimmed;
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

/**
 * 校验接口凭据缺失项。
 *
 * @param {object} config 小米配置。
 * @param {string[]} extraKeys 额外必填字段。
 * @returns {string[]} 缺失字段。
 */
function getCredentialMissing(config, extraKeys = []) {
  const missing = [];
  ["userName", "apiPassword", ...extraKeys].forEach((key) => {
    if (isBlank(config[key])) missing.push(key);
  });
  if (isBlank(getPublicKeyText(config))) missing.push("publicKey/publicKeyPath");
  return missing;
}

/**
 * 判断小米响应是否成功。
 *
 * @param {object} response 响应 JSON。
 * @returns {boolean} true 表示成功。
 */
function isXiaomiSuccess(response) {
  const status = response?.status ?? response?.result ?? response?.code;
  if (status === undefined) return false;
  const normalized = String(status).toLowerCase();
  return Number(status) === 0 || normalized === "success" || normalized === "ok";
}

/**
 * 判断 /dev/query 是否允许执行版本更新。
 *
 * 小米查询接口的 result=0 只表示查询调用成功，不等于可以更新。
 * 当前面板只做更新包，因此必须以 updateVersion=true 作为继续 /dev/push 的条件。
 *
 * @param {object} response /dev/query 响应。
 * @returns {boolean} true 表示可以按更新流程继续。
 */
function canUpdateXiaomiVersion(response = {}) {
  if (!isXiaomiSuccess(response)) return false;
  return response.updateVersion === true || response.data?.updateVersion === true;
}

/**
 * 构建小米查询应用结果文案。
 *
 * 接口明确返回错误时必须优先展示原始错误，例如“密码错误”；
 * 只有接口成功但没有应用数据时，才提示需要先去小米后台新增/上架。
 *
 * @param {object} response 小米响应。
 * @param {boolean} apiOk 接口是否成功。
 * @param {boolean} appExists 是否查询到应用。
 * @param {string} apiMessage 接口原始消息。
 * @returns {string} 用户可读消息。
 */
function buildQueryPackageMessage(response, apiOk, canUpdateVersion, apiMessage) {
  if (!apiOk) {
    const code = response?.result ?? response?.code ?? response?.status;
    return `小米应用查询失败：${apiMessage || "未知错误"}${code === undefined ? "" : `（${code}）`}`;
  }
  if (canUpdateVersion) return apiMessage || "小米应用查询完成，可以更新版本。";
  return `小米查询成功，但当前账号下不允许更新这个包：${formatXiaomiQueryFlags(response)}。请确认 userName 是否为小米开发者站登录邮箱、包名是否和后台应用一致、该应用是否属于这个开发者账号。`;
}

/**
 * 构建小米查询应用预警。
 *
 * @param {boolean} apiOk 接口是否成功。
 * @param {boolean} appExists 是否查询到应用。
 * @returns {string[]} 预警列表。
 */
function buildQueryPackageWarnings(apiOk, canUpdateVersion, response) {
  if (!apiOk) return ["请先修正小米接口账号、密码、公钥证书或包名配置。"];
  if (!canUpdateVersion) return [`当前面板只支持小米 updateVersion=true 的版本更新流程；接口返回 ${formatXiaomiQueryFlags(response)}。如果应用已上架，优先检查 userName 是否填了登录邮箱而不是小米数字 ID。`];
  return [];
}

/**
 * 格式化小米查询能力标志。
 *
 * @param {object} response /dev/query 响应。
 * @returns {string} 标志摘要。
 */
function formatXiaomiQueryFlags(response = {}) {
  return [
    `updateVersion=${Boolean(response.updateVersion)}`,
    `updateInfo=${Boolean(response.updateInfo)}`,
    `create=${Boolean(response.create)}`,
    `packageInfo=${response.packageInfo ? "有" : "无"}`,
  ].join("，");
}

/**
 * 提取小米响应消息。
 *
 * @param {object} response 响应 JSON。
 * @param {string} fallback 默认消息。
 * @returns {string} 响应消息。
 */
function getXiaomiMessage(response, fallback) {
  return response?.message || response?.msg || response?.reason || fallback;
}

/**
 * 计算 Buffer MD5。
 *
 * @param {Buffer} buffer 数据。
 * @returns {string} 小写十六进制 MD5。
 */
function md5Buffer(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

/**
 * 解析 JSON 字段，失败时保留原文本。
 *
 * @param {string} value 原始文本。
 * @returns {unknown} JSON 对象或文本。
 */
function parseJsonOrText(value) {
  if (isBlank(value)) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

/**
 * 去掉接口根地址末尾斜杠。
 *
 * @param {string} value 接口根地址。
 * @returns {string} 标准根地址。
 */
function trimBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * 创建上传历史记录。
 *
 * @param {string} action 动作。
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
    queryPackage: result.queryPackage || undefined,
    localApk: result.localApk || undefined,
  };
}

/**
 * 获取历史记录动作名称。
 *
 * @param {string} action 动作。
 * @returns {string} 动作文案。
 */
function getActionLabel(action) {
  const labels = {
    upload: "小米自动发布",
    precheck: "小米预检",
    "query-package": "小米查询应用",
    "query-categories": "小米查询分类",
    "revoke-review": "小米撤销审核",
  };
  return labels[action] || action;
}

module.exports = {
  runXiaomiUpload,
  buildUploadPrecheck,
  normalizeXiaomiConfig,
  buildSigText,
};
