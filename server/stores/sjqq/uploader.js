const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { readStoreConfig, readCurrentNotes, recordUploadRun } = require("../../db");

const DEFAULT_API_BASE_URL = "https://p.open.qq.com/open_file/developer_api";
const DEFAULT_CONTENT_TYPE = "application/x-www-form-urlencoded";

// update_app 只接收应用宝文档里的业务字段。这里明确白名单，
// 避免把 access_secret、本地文件路径、前端分组字段等内部配置误传给开放平台。
const UPDATE_PARAM_KEYS = [
  "distribution_end",
  "pkg_name",
  "app_id",
  "app_name",
  "modify_app_name_reason",
  "category",
  "modify_category_reason",
  "operator",
  "developer",
  "introduce",
  "one_word_summary",
  "age_level",
  "icon_file_serial_number",
  "snapshots_file_serial_number",
  "screen_size",
  "language",
  "ipv6",
  "device_type",
  "feature",
  "deploy_type",
  "deploy_time",
  "copyright_elec_cert_file_serial_number",
  "copyright_licences_file_serial_number",
  "is_soft_delegation",
  "soft_delegation_file_serial_number",
  "soft_delegation_period_type",
  "soft_delegation_start_time",
  "soft_delegation_end_time",
  "special_ind_category",
  "other_copyright_file_serial_number",
  "security_reports_file_serial_number",
  "apk32_flag",
  "apk64_flag",
  "apk32_file_serial_number",
  "apk32_file_md5",
  "apk64_file_serial_number",
  "apk64_file_md5",
  "login_flag",
  "login_account",
  "pay_type",
  "pay_promise_file_serial_number",
  "demo_video_flag",
  "demo_video_file_serial_number",
];

// 本地文件字段和 update_app 里的流水号字段映射。真实上传时会先调用
// /get_file_upload_info 换取 serial_number，再把流水号写入对应 update_app 字段。
const FILE_FIELD_RULES = [
  { localKey: "iconPath", targetKey: "icon_file_serial_number", type: "img", multiple: false },
  { localKey: "screenshotPaths", targetKey: "snapshots_file_serial_number", type: "img", multiple: true },
  { localKey: "copyrightElecCertPath", targetKey: "copyright_elec_cert_file_serial_number", type: "pdf", multiple: false },
  { localKey: "copyrightLicencePaths", targetKey: "copyright_licences_file_serial_number", type: "img", multiple: true },
  { localKey: "softDelegationFilePaths", targetKey: "soft_delegation_file_serial_number", type: "img", multiple: true },
  { localKey: "otherCopyrightFilePaths", targetKey: "other_copyright_file_serial_number", type: "img", multiple: true },
  { localKey: "securityReportPaths", targetKey: "security_reports_file_serial_number", type: "img", multiple: true },
  { localKey: "payPromisePath", targetKey: "pay_promise_file_serial_number", type: "pdf", multiple: false },
  { localKey: "demoVideoPath", targetKey: "demo_video_file_serial_number", type: "video", multiple: false },
];

/**
 * 执行应用宝上传入口。
 *
 * action=precheck 只做本地配置和文件检查；
 * action=upload 会真实调用应用宝接口、COS 预签名上传和 update_app；
 * action=status 只查询最近更新审核状态。
 *
 * @param {{action?: string}} options 前端传入的上传动作。
 * @returns {Promise<object>} 上传/预检/查询结果。
 */
async function runSjqqUpload(options = {}) {
  const action = options.action || "precheck";
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const config = getSjqqConfig();
  const startedAt = new Date().toISOString();

  if (action === "status") {
    const result = await queryUpdateStatus(config);
    recordUploadRun(createUploadRunRecord("sjqq", action, startedAt, result));
    return result;
  }

  const precheck = buildUploadPrecheck(config);
  if (action !== "upload") return precheck;

  if (!precheck.ok) {
    updateProgress({
      phase: "precheck",
      percent: 10,
      statusText: "预检未通过",
      detail: "应用宝配置未通过预检",
    });
    const result = { ...precheck, message: "应用宝配置未通过预检，已取消真实上传。" };
    recordUploadRun(createUploadRunRecord("sjqq", action, startedAt, result));
    return result;
  }

  updateProgress({
    phase: "precheck",
    percent: 12,
    statusText: "预检通过",
    detail: "应用宝配置和文件路径已确认",
  });
  const uploadResult = await uploadAndSubmit(config, precheck, updateProgress, signal);
  recordUploadRun(createUploadRunRecord("sjqq", action, startedAt, uploadResult));
  return uploadResult;
}

/**
 * 从本地商店配置中读取应用宝配置。
 *
 * @returns {object} stores.local.json 或 stores.example.json 中的 sjqq 配置。
 */
function getSjqqConfig() {
  return normalizeSjqqConfig(readStoreConfig().stores.sjqq || {});
}

/**
 * 兼容早期 stores.local.json 里的字段命名。
 *
 * 之前应用宝还是人工配置时用的是 packageName/appId/clientSecret；
 * 接入官方接口后字段改为文档原名 pkg_name/app_id/access_secret。
 *
 * @param {object} config 原始应用宝配置。
 * @returns {object} 补齐别名和默认接口地址后的配置。
 */
function normalizeSjqqConfig(config) {
  return {
    ...config,
    apiBaseUrl: config.apiBaseUrl || DEFAULT_API_BASE_URL,
    contentType: config.contentType || DEFAULT_CONTENT_TYPE,
    pkg_name: config.pkg_name || config.packageName || "",
    app_id: config.app_id || config.appId || "",
    access_secret: config.access_secret || config.clientSecret || "",
  };
}

/**
 * 构建应用宝上传预检结果。
 *
 * 预检阶段不会访问外部网络，只验证必填参数、可变更字段和本地文件是否存在。
 *
 * @param {object} config 应用宝发布配置。
 * @returns {{ok: boolean, store: string, message: string, missing: string[], plannedFiles: object[], updateFields: string[]}} 预检结果。
 */
function buildUploadPrecheck(config) {
  const missing = [];
  const warnings = [];
  if (!config.enabled) missing.push("enabled");
  ["user_id", "access_secret", "pkg_name", "app_id"].forEach((key) => {
    if (isBlank(config[key])) missing.push(key);
  });

  const plannedFiles = collectPlannedFiles(config);
  plannedFiles.forEach((file) => {
    if (!fs.existsSync(file.path)) missing.push(`${file.localKey}: ${file.path}`);
  });

  const updateParams = buildUpdateParams(config, {});
  const changedFields = Object.keys(updateParams).filter((key) => !["pkg_name", "app_id", "deploy_type"].includes(key));
  if (changedFields.length === 0 && plannedFiles.length === 0) {
    warnings.push("没有检测到 APK、截图、资质文件或基础信息变更字段。");
  }

  return {
    ok: missing.length === 0 && warnings.length === 0,
    store: "sjqq",
    message: missing.length === 0 && warnings.length === 0 ? "应用宝上传预检通过。" : "应用宝上传预检未通过。",
    missing,
    warnings,
    plannedFiles: plannedFiles.map((file) => ({
      localKey: file.localKey,
      targetKey: file.targetKey,
      fileType: file.fileType,
      path: file.path,
      exists: fs.existsSync(file.path),
    })),
    updateFields: Object.keys(updateParams),
  };
}

/**
 * 上传文件并提交 update_app。
 *
 * @param {object} config 应用宝发布配置。
 * @param {object} precheck 已通过的预检结果。
 * @returns {Promise<object>} 应用宝接口返回和本地执行摘要。
 */
async function uploadAndSubmit(config, precheck, updateProgress = () => {}, signal) {
  const uploadedSerials = {};
  const uploadedFiles = [];
  const plannedFiles = collectPlannedFiles(config);

  for (const [index, file] of plannedFiles.entries()) {
    throwIfAborted(signal);
    updateProgress({
      phase: "uploading",
      percent: plannedFiles.length > 0 ? 20 + Math.round((index / plannedFiles.length) * 55) : 70,
      statusText: "上传文件",
      detail: `正在上传 ${path.basename(file.path)}`,
    });
    const uploadInfo = await requestFileUploadInfo(config, file, signal);
    await uploadFileToPreSignUrl(uploadInfo.pre_sign_url, file.path, signal);
    uploadedFiles.push({
      localKey: file.localKey,
      targetKey: file.targetKey,
      fileType: file.fileType,
      path: file.path,
      serialNumber: uploadInfo.serial_number,
    });
    appendSerialNumber(uploadedSerials, file.targetKey, uploadInfo.serial_number);

    if (file.targetKey === "apk32_file_serial_number") {
      uploadedSerials.apk32_file_md5 = md5File(file.path);
      uploadedSerials.apk32_flag = config.apk32_flag || 1;
    }
    if (file.targetKey === "apk64_file_serial_number") {
      uploadedSerials.apk64_file_md5 = md5File(file.path);
      uploadedSerials.apk64_flag = config.apk64_flag || 1;
    }
  }

  updateProgress({
    phase: "submit",
    percent: 85,
    statusText: "提交应用更新",
    detail: "文件上传完成，正在提交应用宝 update_app",
  });
  const updateParams = buildUpdateParams(config, uploadedSerials);
  throwIfAborted(signal);
  const updateResponse = await callSjqqApi(config, config.updateAppRoute || "/update_app", updateParams, 60_000, signal);
  const ok = Number(updateResponse.ret) === 0;
  return {
    ok,
    store: "sjqq",
    message: ok ? "应用宝 update_app 已提交。" : `应用宝 update_app 提交失败：${updateResponse.msg || updateResponse.ret}`,
    precheck,
    uploadedFiles,
    updateFields: Object.keys(updateParams),
    response: updateResponse,
  };
}

/**
 * 查询应用宝应用更新审核状态。
 *
 * @param {object} config 应用宝发布配置。
 * @returns {Promise<object>} 审核状态接口结果。
 */
async function queryUpdateStatus(config) {
  const missing = [];
  ["user_id", "access_secret", "pkg_name", "app_id"].forEach((key) => {
    if (isBlank(config[key])) missing.push(key);
  });
  if (missing.length > 0) {
    return {
      ok: false,
      store: "sjqq",
      message: "应用宝审核状态查询缺少必填配置。",
      missing,
    };
  }

  const response = await callSjqqApi(config, config.queryUpdateStatusRoute || "/query_app_update_status", {
    pkg_name: config.pkg_name,
    app_id: config.app_id,
  }, 15_000);
  return {
    ok: Number(response.ret) === 0,
    store: "sjqq",
    message: response.msg || "应用宝审核状态查询完成。",
    response,
  };
}

/**
 * 申请单个文件的 COS 预签名上传信息。
 *
 * @param {object} config 应用宝发布配置。
 * @param {object} file 待上传文件描述。
 * @returns {Promise<{pre_sign_url: string, serial_number: string}>} 预签名 URL 和文件流水号。
 */
async function requestFileUploadInfo(config, file, signal) {
  const response = await callSjqqApi(config, config.fileUploadRoute || "/get_file_upload_info", {
    pkg_name: config.pkg_name,
    app_id: config.app_id,
    file_type: file.fileType,
    file_name: path.basename(file.path),
  }, 60_000, signal);
  if (Number(response.ret) !== 0 || !response.pre_sign_url || !response.serial_number) {
    throw new Error(`应用宝获取文件上传信息失败：${response.msg || response.ret || "未知错误"}`);
  }
  return response;
}

/**
 * 调用应用宝开放平台表单接口。
 *
 * @param {object} config 应用宝发布配置。
 * @param {string} route 接口路由，例如 /update_app。
 * @param {object} businessParams 业务参数。
 * @param {number} timeoutMs 请求超时时间，单位毫秒。
 * @returns {Promise<object>} JSON 响应体。
 */
function callSjqqApi(config, route, businessParams, timeoutMs, signal) {
  const apiBaseUrl = String(config.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const url = `${apiBaseUrl}${normalizeRoute(route)}`;
  const params = buildSignedParams(config, businessParams);
  return requestFormJson(url, params, timeoutMs, config.contentType || DEFAULT_CONTENT_TYPE, signal);
}

/**
 * 构建带公共参数和 sign 的应用宝请求参数。
 *
 * @param {object} config 应用宝发布配置。
 * @param {object} businessParams 业务参数。
 * @returns {object} 最终请求参数。
 */
function buildSignedParams(config, businessParams) {
  const params = compactParams({
    user_id: config.user_id,
    timestamp: Math.floor(Date.now() / 1000),
    ...businessParams,
  });
  params.sign = signParams(params, config.access_secret);
  return params;
}

/**
 * 按应用宝文档计算 HmacSHA256 签名。
 *
 * 文档要求：除 sign 外的所有公共参数和业务参数按 ASCII 升序排序，
 * 用 k=v 通过 & 拼接，参数名和值不做 URL 编码，再用 access_secret 做 HmacSHA256。
 *
 * @param {object} params 待签名参数。
 * @param {string} accessSecret 应用宝 API 接入密钥。
 * @returns {string} 小写十六进制签名。
 */
function signParams(params, accessSecret) {
  const source = Object.keys(params)
    .filter((key) => key !== "sign" && !isBlank(params[key]))
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHmac("sha256", String(accessSecret || "")).update(source).digest("hex");
}

/**
 * 发送 application/x-www-form-urlencoded 请求并解析 JSON。
 *
 * @param {string} url 请求 URL。
 * @param {object} params 表单参数。
 * @param {number} timeoutMs 超时时间。
 * @param {string} contentType Content-Type。
 * @returns {Promise<object>} JSON 响应。
 */
function requestFormJson(url, params, timeoutMs, contentType, signal) {
  const body = new URLSearchParams(params).toString();
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
      headers: {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`应用宝接口 HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`应用宝接口返回不是 JSON：${text.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`应用宝接口请求超时：${url}`)));
    req.on("error", reject);
    signal?.addEventListener("abort", () => req.destroy(new Error("上传任务已终止")), { once: true });
    req.end(body);
  });
}

/**
 * 通过 COS 预签名 URL 上传文件原始内容。
 *
 * 应用宝文档示例使用 PUT + application/octet-stream，并同步读取整个文件。
 *
 * @param {string} preSignUrl COS 预签名 URL。
 * @param {string} filePath 本地文件路径。
 * @returns {Promise<void>} 上传完成。
 */
function uploadFileToPreSignUrl(preSignUrl, filePath, signal) {
  const requestUrl = new URL(preSignUrl);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const body = fs.readFileSync(filePath);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }
    const req = transport.request({
      method: "PUT",
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: 120_000,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        reject(new Error(`COS 文件上传失败 HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error(`COS 文件上传超时：${filePath}`)));
    req.on("error", reject);
    signal?.addEventListener("abort", () => req.destroy(new Error("上传任务已终止")), { once: true });
    req.end(body);
  });
}

/**
 * 汇总当前配置中计划上传的本地文件。
 *
 * @param {object} config 应用宝发布配置。
 * @returns {object[]} 待上传文件列表。
 */
function collectPlannedFiles(config) {
  const files = [];
  const addFile = (localKey, targetKey, filePath, type) => {
    if (isBlank(filePath)) return;
    files.push({
      localKey,
      targetKey,
      path: String(filePath).trim(),
      fileType: inferFileType(filePath, type),
    });
  };

  const apk32Path = config.apk32Path || config.apkPath;
  addFile(config.apk32Path ? "apk32Path" : "apkPath", "apk32_file_serial_number", apk32Path, "apk");
  addFile("apk64Path", "apk64_file_serial_number", config.apk64Path, "apk");

  FILE_FIELD_RULES.forEach((rule) => {
    const value = config[rule.localKey];
    if (rule.multiple) {
      normalizeList(value).forEach((filePath) => addFile(rule.localKey, rule.targetKey, filePath, rule.type));
    } else {
      addFile(rule.localKey, rule.targetKey, value, rule.type);
    }
  });
  return files;
}

/**
 * 构建 update_app 业务参数。
 *
 * @param {object} config 应用宝发布配置。
 * @param {object} uploadedSerials 本轮文件上传得到的流水号和 MD5。
 * @returns {object} update_app 业务参数。
 */
function buildUpdateParams(config, uploadedSerials) {
  const params = {};
  UPDATE_PARAM_KEYS.forEach((key) => {
    if (!isBlank(config[key])) params[key] = config[key];
  });
  params.pkg_name = config.pkg_name;
  params.app_id = config.app_id;
  params.deploy_type = isBlank(params.deploy_type) ? 1 : params.deploy_type;

  // 如果渠道发布说明已填写但 feature 为空，默认用发布说明作为版本特性。
  // 全局更新日志只作为兜底，不会主动覆盖已经保存到渠道配置里的文案。
  if (isBlank(params.feature)) {
    const fallbackFeature = config.releaseNotes || readCurrentNotes();
    if (!isBlank(fallbackFeature)) params.feature = fallbackFeature;
  }

  return compactParams({ ...params, ...uploadedSerials });
}

/**
 * 根据目标字段追加上传流水号。
 *
 * 多文件字段要求用竖线分隔，所以同一个 targetKey 会累积为 serial1|serial2。
 *
 * @param {object} serials 流水号容器。
 * @param {string} targetKey update_app 目标字段。
 * @param {string} serialNumber 应用宝返回的流水号。
 * @returns {void}
 */
function appendSerialNumber(serials, targetKey, serialNumber) {
  if (!serials[targetKey]) {
    serials[targetKey] = serialNumber;
    return;
  }
  serials[targetKey] = `${serials[targetKey]}|${serialNumber}`;
}

/**
 * 根据文件后缀推断应用宝 file_type。
 *
 * @param {string} filePath 文件路径。
 * @param {string} fallback 默认类型。
 * @returns {string} img / apk / pdf / video / txt。
 */
function inferFileType(filePath, fallback) {
  const ext = path.extname(String(filePath)).toLowerCase();
  if (ext === ".apk") return "apk";
  if ([".png", ".jpg", ".jpeg"].includes(ext)) return "img";
  if (ext === ".pdf") return "pdf";
  if ([".mp4", ".m4a"].includes(ext)) return "video";
  if (ext === ".txt") return "txt";
  return fallback || "txt";
}

/**
 * 计算文件 MD5。
 *
 * @param {string} filePath 文件路径。
 * @returns {string} 小写十六进制 MD5。
 */
function md5File(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * 删除空值参数，但保留 0 和 false。
 *
 * @param {object} params 原始参数。
 * @returns {object} 清理后的参数。
 */
function compactParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => !isBlank(value)));
}

/**
 * 判断值是否为空。
 *
 * @param {unknown} value 任意值。
 * @returns {boolean} true 表示不应参与提交。
 */
function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * 把多行文本或数组统一成字符串数组。
 *
 * @param {unknown} value 配置值。
 * @returns {string[]} 文件路径列表。
 */
function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (isBlank(value)) return [];
  return String(value).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

/**
 * 清理接口路由。
 *
 * 文档中部分路由带空格，例如 “/ get_file_upload_info”，真实请求需要去掉空格。
 *
 * @param {string} route 路由配置。
 * @returns {string} 以 / 开头的路由。
 */
function normalizeRoute(route) {
  const cleaned = String(route || "").replace(/\s+/g, "");
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

/**
 * 如果上传任务已被终止，立即抛出统一错误。
 *
 * @param {AbortSignal|undefined} signal 任务终止信号。
 * @returns {void}
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("上传任务已终止");
}

/**
 * 生成写入本地数据库的上传记录。
 *
 * @param {string} store 平台 key。
 * @param {string} action 动作。
 * @param {string} startedAt 开始时间。
 * @param {object} result 执行结果。
 * @returns {object} uploadRuns 记录。
 */
function createUploadRunRecord(store, action, startedAt, result) {
  return {
    id: `${Date.now()}-${store}-${action}`,
    store,
    action,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: Boolean(result.ok),
    message: result.message || "",
    uploadedFiles: result.uploadedFiles || [],
    updateFields: result.updateFields || [],
  };
}

module.exports = {
  runSjqqUpload,
  buildUploadPrecheck,
  signParams,
};
