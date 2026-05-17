const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { readCurrentNotes, readDb, readStoreConfig, recordUploadRun } = require("../../db");

const DEFAULT_GET_TOKEN_URL = "https://www.pgyer.com/apiv2/app/getCOSToken";
const DEFAULT_BUILD_INFO_URL = "https://www.pgyer.com/apiv2/app/buildInfo";
const DEFAULT_POLL_ATTEMPTS = 20;
const DEFAULT_POLL_INTERVAL_MS = 3000;

/**
 * 执行蒲公英上传入口。
 *
 * action=precheck 只检查本地配置和包路径；
 * action=upload 会按蒲公英快速上传流程申请 COS Token、上传文件并轮询 buildInfo；
 * action=status 只根据 buildKey 查询最近一次蒲公英处理结果。
 *
 * @param {{action?: string, buildKey?: string}} options 前端传入的上传动作。
 * @returns {Promise<object>} 上传、预检或状态查询结果。
 */
async function runPgyerUpload(options = {}) {
  const action = options.action || "precheck";
  const updateProgress = typeof options.updateProgress === "function" ? options.updateProgress : () => {};
  const signal = options.signal;
  const config = getPgyerConfig();
  const startedAt = new Date().toISOString();

  if (action === "status") {
    const result = await queryBuildInfo(config, options.buildKey || getLastPgyerBuildKey());
    recordUploadRun(createUploadRunRecord("pgyer", action, startedAt, result));
    return result;
  }

  const precheck = buildUploadPrecheck(config);
  if (action !== "upload") return precheck;

  if (!precheck.ok) {
    updateProgress({
      phase: "precheck",
      percent: 10,
      statusText: "预检未通过",
      detail: precheck.message,
    });
    const result = { ...precheck, message: "蒲公英配置未通过预检，已取消真实上传。" };
    recordUploadRun(createUploadRunRecord("pgyer", action, startedAt, result));
    return result;
  }

  try {
    updateProgress({
      phase: "precheck",
      percent: 12,
      statusText: "预检通过",
      detail: "本地配置和安装包路径已确认",
    });
    const uploadResult = await uploadPackage(config, precheck, updateProgress, signal);
    recordUploadRun(createUploadRunRecord("pgyer", action, startedAt, uploadResult));
    return uploadResult;
  } catch (error) {
    const result = {
      ok: false,
      store: "pgyer",
      action,
      message: `蒲公英上传失败：${error.message}`,
      precheck,
    };
    recordUploadRun(createUploadRunRecord("pgyer", action, startedAt, result));
    return result;
  }
}

/**
 * 从当前项目的商店配置中读取蒲公英配置。
 *
 * @returns {object} 合并别名和默认地址后的蒲公英配置。
 */
function getPgyerConfig() {
  return normalizePgyerConfig(readStoreConfig().stores.pgyer || {});
}

/**
 * 补齐蒲公英新版快速上传接口默认值。
 *
 * 新版上传只把 getCOSToken 作为固定入口；真正的文件上传地址由 token 接口返回，
 * 服务端随后把文件传到 COS endpoint，最后通过 buildInfo 查询处理结果。
 *
 * @param {object} config 原始蒲公英配置。
 * @returns {object} 可直接用于上传服务的配置。
 */
function normalizePgyerConfig(config) {
  const packagePath = config.apkPath || config.ipaPath || config.packagePath || "";
  return {
    ...config,
    apiKey: config.apiKey || config._api_key || "",
    buildType: inferBuildType(packagePath),
    buildInstallType: config.buildInstallType || config.installType || "",
    buildPassword: Number(config.buildInstallType || config.installType) === 2 ? (config.buildPassword || config.password || "") : "",
    buildInstallDate: config.buildInstallDate || config.installDate || "",
    buildInstallStartDate: config.buildInstallStartDate || config.installStartDate || "",
    buildInstallEndDate: config.buildInstallEndDate || config.installEndDate || "",
    buildChannelShortcut: config.buildChannelShortcut || config.channelShortcut || "",
    packagePath,
  };
}

/**
 * 构建蒲公英上传预检结果。
 *
 * 预检阶段不会访问外部网络，只检查启用状态、API Key、包路径和会提交的元数据字段。
 *
 * @param {object} config 蒲公英发布配置。
 * @returns {{ok: boolean, store: string, message: string, missing: string[], warnings: string[], plannedFiles: object[], updateFields: string[]}} 预检结果。
 */
function buildUploadPrecheck(config) {
  const missing = [];
  const warnings = [];
  if (!config.enabled) missing.push("未启用蒲公英上传");
  if (isBlank(config.apiKey)) missing.push("缺少蒲公英 API Key");
  if (isBlank(config.packagePath)) missing.push("缺少安装包路径");

  const plannedFiles = [];
  if (!isBlank(config.packagePath)) {
    plannedFiles.push({
      localKey: path.extname(config.packagePath).toLowerCase() === ".ipa" ? "ipaPath" : "apkPath",
      fileType: inferBuildType(config.packagePath),
      path: config.packagePath,
      exists: fs.existsSync(config.packagePath),
    });
  }

  plannedFiles.forEach((file) => {
    if (!file.exists) missing.push(`安装包文件不存在：${file.path}`);
  });
  if (!isBlank(config.packagePath) && !["android", "apk", "ios", "ipa", "harmonyos", "hap"].includes(config.buildType)) {
    missing.push("安装包类型：仅支持 .apk / .ipa / .hap 文件");
  }

  const uploadParams = buildTokenParams(config);
  return {
    ok: missing.length === 0 && warnings.length === 0,
    store: "pgyer",
    message: missing.length === 0 && warnings.length === 0
      ? "蒲公英上传预检通过。"
      : `蒲公英上传预检未通过：${[...missing, ...warnings].join("；")}`,
    missing,
    warnings,
    plannedFiles,
    updateFields: getUserFacingSubmitFields(uploadParams),
  };
}

/**
 * 执行蒲公英快速上传流程。
 *
 * @param {object} config 蒲公英发布配置。
 * @param {object} precheck 已通过的预检结果。
 * @returns {Promise<object>} 上传和 buildInfo 查询结果。
 */
async function uploadPackage(config, precheck, updateProgress, signal) {
  throwIfAborted(signal);
  updateProgress({
    phase: "token",
    percent: 20,
    statusText: "获取上传凭证",
    detail: "正在向蒲公英申请 COS 上传凭证",
  });
  const tokenResponse = await requestPgyerJson(DEFAULT_GET_TOKEN_URL, buildTokenParams(config), 30_000, "POST", signal);
  const tokenData = assertPgyerSuccess(tokenResponse, "获取 COS 上传凭证");
  const endpoint = tokenData.endpoint;
  const formParams = tokenData.params || {};
  const buildKey = tokenData.key || tokenData.buildKey || formParams.key;

  if (isBlank(endpoint)) throw new Error("getCOSToken 未返回 endpoint。");
  if (isBlank(buildKey)) throw new Error("getCOSToken 未返回 buildKey/key。");

  updateProgress({
    phase: "uploading",
    percent: 35,
    statusText: "上传安装包",
    detail: `正在上传 ${path.basename(config.packagePath)}`,
  });
  throwIfAborted(signal);
  await uploadFileToCos(endpoint, formParams, config.packagePath, buildKey, updateProgress, signal);
  updateProgress({
    phase: "buildInfo",
    percent: 88,
    statusText: "查询处理结果",
    detail: "安装包已上传，正在等待蒲公英解析结果",
  });
  const buildInfo = await pollBuildInfo(config, buildKey, updateProgress, signal);
  return {
    ok: Boolean(buildInfo.ok),
    store: "pgyer",
    action: "upload",
    message: buildInfo.ok ? "蒲公英安装包已上传并获取到 buildInfo。" : buildInfo.message,
    precheck,
    buildKey,
    uploadedFiles: [{
      localKey: path.extname(config.packagePath).toLowerCase() === ".ipa" ? "ipaPath" : "apkPath",
      fileType: config.buildType,
      path: config.packagePath,
      buildKey,
    }],
    updateFields: getUserFacingSubmitFields(buildTokenParams(config)),
    response: buildInfo.response,
  };
}

/**
 * 构建 getCOSToken 请求参数。
 *
 * @param {object} config 蒲公英发布配置。
 * @returns {object} 蒲公英 token 接口参数。
 */
function buildTokenParams(config) {
  const releaseNotes = config.releaseNotes || readCurrentNotes();
  return compactParams({
    _api_key: config.apiKey,
    buildType: config.buildType,
    buildInstallType: config.buildInstallType,
    buildPassword: config.buildPassword,
    buildDescription: config.buildDescription,
    buildUpdateDescription: config.buildUpdateDescription || releaseNotes,
    oversea: config.oversea,
    buildInstallDate: config.buildInstallDate,
    buildInstallStartDate: config.buildInstallStartDate,
    buildInstallEndDate: config.buildInstallEndDate,
    buildChannelShortcut: config.buildChannelShortcut,
  });
}

/**
 * 把蒲公英真实提交字段转换成用户能理解的摘要。
 *
 * getCOSToken 里的字段名属于平台协议，前端日志只需要知道会提交哪些发布信息；
 * 接口 URL、buildKey、COS 参数这些流程状态不会出现在这里。
 *
 * @param {object} params getCOSToken 请求参数。
 * @returns {string[]} 用户可读的提交字段。
 */
function getUserFacingSubmitFields(params) {
  const labels = {
    buildType: "安装包类型（自动识别）",
    buildInstallType: "安装方式",
    buildPassword: "安装密码",
    buildDescription: "应用介绍",
    buildUpdateDescription: "版本更新说明",
    oversea: "海外加速",
    buildInstallDate: "安装有效期",
    buildInstallStartDate: "安装开始时间",
    buildInstallEndDate: "安装结束时间",
    buildChannelShortcut: "渠道短链",
  };
  return Object.keys(params)
    .filter((key) => key !== "_api_key")
    .map((key) => labels[key] || key);
}

/**
 * 查询蒲公英 buildInfo。
 *
 * @param {object} config 蒲公英配置。
 * @param {string} buildKey getCOSToken 返回的 key。
 * @returns {Promise<object>} 查询结果。
 */
async function queryBuildInfo(config, buildKey, signal) {
  const missing = [];
  if (isBlank(config.apiKey)) missing.push("apiKey");
  if (isBlank(buildKey)) missing.push("buildKey");
  if (missing.length > 0) {
    return {
      ok: false,
      store: "pgyer",
      action: "status",
      message: "蒲公英 buildInfo 查询缺少必填配置。",
      missing,
    };
  }

  try {
    const response = await requestPgyerJson(DEFAULT_BUILD_INFO_URL, {
      _api_key: config.apiKey,
      buildKey,
    }, 30_000, "GET", signal);
    const data = assertPgyerSuccess(response, "查询 buildInfo");
    return {
      ok: true,
      store: "pgyer",
      action: "status",
      message: "蒲公英 buildInfo 查询完成。",
      buildKey,
      response: data,
    };
  } catch (error) {
    return {
      ok: false,
      store: "pgyer",
      action: "status",
      message: error.message,
      buildKey,
    };
  }
}

/**
 * 轮询蒲公英 buildInfo，等待上传后的应用解析完成。
 *
 * @param {object} config 蒲公英配置。
 * @param {string} buildKey getCOSToken 返回的 key。
 * @returns {Promise<object>} 最近一次 buildInfo 查询结果。
 */
async function pollBuildInfo(config, buildKey, updateProgress = () => {}, signal) {
  let lastResult = null;
  for (let index = 0; index < DEFAULT_POLL_ATTEMPTS; index += 1) {
    throwIfAborted(signal);
    updateProgress({
      phase: "buildInfo",
      percent: Math.min(98, 88 + index),
      statusText: "查询处理结果",
      detail: `正在查询蒲公英处理结果，第 ${index + 1} 次`,
    });
    lastResult = await queryBuildInfo(config, buildKey, signal);
    if (lastResult.ok) return lastResult;
    await delay(DEFAULT_POLL_INTERVAL_MS, signal);
  }
  return {
    ok: false,
    store: "pgyer",
    action: "status",
    message: `蒲公英 buildInfo 在 ${DEFAULT_POLL_ATTEMPTS} 次轮询后仍未就绪：${lastResult?.message || "未知状态"}`,
    buildKey,
    response: lastResult?.response,
  };
}

/**
 * 发送蒲公英表单接口请求并解析 JSON。
 *
 * @param {string} url 请求地址。
 * @param {object} params 表单参数。
 * @param {number} timeoutMs 超时时间。
 * @param {string} [method="POST"] HTTP 方法，buildInfo 使用 GET。
 * @returns {Promise<object>} JSON 响应。
 */
function requestPgyerJson(url, params, timeoutMs, method = "POST", signal) {
  const body = new URLSearchParams(params).toString();
  const requestUrl = new URL(url);
  const requestMethod = String(method || "POST").toUpperCase();
  if (requestMethod === "GET" && body) {
    requestUrl.search = requestUrl.search ? `${requestUrl.search}&${body}` : `?${body}`;
  }
  const transport = requestUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }
    const headers = {};
    if (requestMethod !== "GET") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = transport.request({
      method: requestMethod,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: timeoutMs,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`蒲公英接口 HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`蒲公英接口返回不是 JSON：${text.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`蒲公英接口请求超时：${url}`)));
    req.on("error", reject);
    signal?.addEventListener("abort", () => req.destroy(new Error("上传任务已终止")), { once: true });
    req.end(requestMethod === "GET" ? undefined : body);
  });
}

/**
 * 上传安装包到 getCOSToken 返回的 COS endpoint。
 *
 * COS 表单上传需要保留蒲公英返回的所有 params，并追加 file 字段。
 * 这里使用流式上传，避免把较大的 APK/IPA 一次性读入内存。
 *
 * @param {string} endpoint COS 上传地址。
 * @param {object} params getCOSToken 返回的 params。
 * @param {string} filePath 本地安装包路径。
 * @param {string} buildKey getCOSToken 返回的 key。
 * @returns {Promise<void>} 上传完成。
 */
function uploadFileToCos(endpoint, params, filePath, buildKey, updateProgress = () => {}, signal) {
  const requestUrl = new URL(endpoint);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const boundary = `----open-release-pilot-${Date.now().toString(16)}`;
  const stat = fs.statSync(filePath);
  const formParams = { ...params };
  if (isBlank(formParams.key) && !isBlank(buildKey)) formParams.key = buildKey;
  if (isBlank(formParams["x-cos-meta-file-name"])) formParams["x-cos-meta-file-name"] = path.basename(filePath);

  const fieldBuffers = Object.entries(compactParams(formParams)).map(([key, value]) => (
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
  ));
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = [...fieldBuffers, fileHeader, closing]
    .reduce((sum, buffer) => sum + buffer.length, 0) + stat.size;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }
    let fileStream = null;
    const req = transport.request({
      method: "POST",
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: 180_000,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": contentLength,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`蒲公英 COS 上传失败 HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`));
      });
    });

    req.on("timeout", () => req.destroy(new Error(`蒲公英 COS 上传超时：${filePath}`)));
    req.on("error", reject);
    signal?.addEventListener("abort", () => {
      fileStream?.destroy(new Error("上传任务已终止"));
      req.destroy(new Error("上传任务已终止"));
    }, { once: true });
    fieldBuffers.forEach((buffer) => req.write(buffer));
    req.write(fileHeader);

    let uploadedBytes = 0;
    fileStream = fs.createReadStream(filePath);
    fileStream.on("error", reject);
    fileStream.on("data", (chunk) => {
      uploadedBytes += chunk.length;
      const filePercent = stat.size > 0 ? uploadedBytes / stat.size : 0;
      updateProgress({
        phase: "uploading",
        percent: 35 + Math.round(filePercent * 50),
        statusText: "上传安装包",
        detail: `已上传 ${formatBytes(uploadedBytes)} / ${formatBytes(stat.size)}`,
      });
    });
    fileStream.on("end", () => req.end(closing));
    fileStream.pipe(req, { end: false });
  });
}

/**
 * 校验蒲公英接口响应是否成功。
 *
 * @param {object} response 蒲公英 JSON 响应。
 * @param {string} actionName 当前动作名称，用于错误消息。
 * @returns {object} response.data。
 */
function assertPgyerSuccess(response, actionName) {
  if (Number(response.code) === 0) return response.data || {};
  if (String(response.message || response.msg || "").includes("_api_key not found")) {
    throw new Error(`蒲公英${actionName}失败：蒲公英不认可当前 API Key，请检查是否填写的是蒲公英后台 API 信息页里的 API Key。`);
  }
  throw new Error(`蒲公英${actionName}失败：${response.message || response.msg || response.code || "未知错误"}`);
}

/**
 * 从上传历史里读取最近一次蒲公英 buildKey。
 *
 * buildKey 是接口流转状态，不属于用户需要维护的表单配置；记录在 uploadRuns
 * 里即可，前端点“查询状态”时服务端自动取最近一次上传结果。
 *
 * @returns {string} 最近一次蒲公英上传的 buildKey。
 */
function getLastPgyerBuildKey() {
  const runs = readDb().uploadRuns || [];
  return runs.find((run) => run.store === "pgyer" && run.buildKey)?.buildKey || "";
}


/**
 * 根据文件后缀推断蒲公英 buildType。
 *
 * @param {string} filePath 安装包路径。
 * @returns {string} android / ios / 空字符串。
 */
function inferBuildType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".apk" || ext === ".aab") return "android";
  if (ext === ".ipa") return "ios";
  return "";
}

/**
 * 格式化上传字节数。
 *
 * @param {number} bytes 字节数。
 * @returns {string} 适合进度详情展示的大小。
 */
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
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
 * 等待指定毫秒数。
 *
 * @param {number} ms 等待时间，单位毫秒。
 * @returns {Promise<void>} 延时 Promise。
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("上传任务已终止"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("上传任务已终止"));
    }, { once: true });
  });
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
    buildKey: result.buildKey || "",
  };
}

module.exports = {
  runPgyerUpload,
  buildUploadPrecheck,
  normalizePgyerConfig,
};
