const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { buildTokenCacheKey, clearCachedToken, computeExpiresAt, getOrRefreshToken } = require("../token-cache");

const DEFAULT_API_BASE_URL = "https://connect-api.cloud.huawei.com";
const DEFAULT_TOKEN_PATH = "/api/oauth2/v1/token";
const DEFAULT_UPLOAD_URL_PATH = "/api/publish/v2/upload-url";
const DEFAULT_APP_FILE_INFO_PATH = "/api/publish/v2/app-file-info";
const DEFAULT_APP_INFO_PATH = "/api/publish/v2/app-info";
const DEFAULT_SUBMIT_PATH = "/api/publish/v2/app-submit";

/**
 * 规范化华为 Connect API 配置。
 *
 * 这里统一补齐接口路径和默认值，避免 uploader 的每个步骤重复处理字段兜底。
 *
 * @param {object} config 当前项目中的 huawei 配置。
 * @returns {object} 合并默认值后的华为配置。
 */
function normalizeHuaweiConfig(config = {}) {
  const apiClientJsonPath = resolveApiClientJsonPath(config.apiClientJsonPath);
  const apiClient = readApiClientJson(apiClientJsonPath);
  const filePath = config.apkPath || config.aabPath || "";
  const suffixFromPath = path.extname(filePath).replace(".", "").toLowerCase();
  return {
    ...config,
    apiClientJsonPath,
    clientId: config.clientId || apiClient.clientId || "",
    clientSecret: config.clientSecret || apiClient.clientSecret || "",
    developerId: config.developerId || apiClient.developerId || "",
    apiBaseUrl: trimTrailingSlash(config.apiBaseUrl || DEFAULT_API_BASE_URL),
    tokenPath: normalizePath(config.tokenPath || DEFAULT_TOKEN_PATH),
    uploadUrlPath: normalizePath(config.uploadUrlPath || DEFAULT_UPLOAD_URL_PATH),
    appFileInfoPath: normalizePath(config.appFileInfoPath || DEFAULT_APP_FILE_INFO_PATH),
    appInfoPath: normalizePath(config.appInfoPath || DEFAULT_APP_INFO_PATH),
    submitPath: normalizePath(config.submitPath || DEFAULT_SUBMIT_PATH),
    fileSuffix: (config.fileSuffix || suffixFromPath || "apk").toLowerCase(),
    fileType: config.fileType === "" || config.fileType === undefined ? 5 : Number(config.fileType),
    lang: config.lang || "zh-CN",
    apkPath: filePath,
  };
}

/**
 * 读取华为后台下载的 agc-apiclient-*.json。
 *
 * 该文件包含 Connect API Client ID / Secret。这里只返回标准字段，
 * 不在日志中输出原始 JSON，避免密钥泄露。
 *
 * @param {string} filePath API Client JSON 本机路径。
 * @returns {{clientId: string, clientSecret: string, developerId: string, type: string, configurationVersion: string}} 解析结果。
 */
function readApiClientJson(filePath) {
  const resolvedPath = resolveLocalPath(filePath);
  if (!resolvedPath) return {};
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`华为 API Client JSON 文件不存在：${resolvedPath}`);
  }
  const data = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  return {
    clientId: data.client_id || data.clientId || "",
    clientSecret: data.client_secret || data.clientSecret || "",
    developerId: data.developer_id || data.developerId || "",
    type: data.type || "",
    configurationVersion: data.configuration_version || data.configurationVersion || "",
  };
}

/**
 * 导入华为 API Client JSON，并生成可合并到 huawei 配置的字段。
 *
 * @param {string} filePath API Client JSON 本机路径。
 * @returns {object} 可写入 huawei 配置的字段。
 */
function importApiClientJson(filePath) {
  const resolvedPath = resolveApiClientJsonPath(filePath);
  const data = readApiClientJson(resolvedPath);
  if (!data.clientId || !data.clientSecret) {
    throw new Error("华为 API Client JSON 缺少 client_id 或 client_secret。");
  }
  return {
    apiClientJsonPath: resolvedPath,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    developerId: data.developerId,
  };
}

/**
 * 换取华为 Connect API access token。
 *
 * access token 是短效凭据，只缓存在当前 Node 进程内，不写入本地数据库。
 * 后续业务步骤会优先复用未过期 token，减少 token 接口调用次数。
 *
 * @param {object} config 规范化后的华为配置。
 * @returns {Promise<object>} token 响应摘要，包含 accessToken、expiresIn。
 */
async function requestAccessToken(config) {
  const cacheKey = getHuaweiTokenCacheKey(config);
  return getOrRefreshToken(cacheKey, async () => {
    const response = await requestJson(config, config.tokenPath, {
      method: "POST",
      body: {
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      },
    });
    const accessToken = response.access_token || response.accessToken || response.token;
    if (!accessToken) {
      throw new Error(formatTokenResponseError(response));
    }
    const expiresIn = response.expires_in || response.expiresIn || "";
    return {
      accessToken,
      expiresIn,
      expiresAt: computeExpiresAt(expiresIn, "ttl"),
      response: omitTokenFields(response),
    };
  });
}

/**
 * 生成华为 token 缓存 key。
 *
 * @param {object} config 华为配置。
 * @returns {string} 缓存 key。
 */
function getHuaweiTokenCacheKey(config) {
  return buildTokenCacheKey("huawei", [config.apiBaseUrl, config.tokenPath, config.clientId, config.clientSecret]);
}

/**
 * 把华为 token 业务错误转换成可操作的中文提示。
 *
 * 例如 ret.code=203886599 / "the type of clientId not match" 通常表示填入的是
 * 项目 OAuth Client ID，而不是 AppGallery Connect API 客户端 ID。
 *
 * @param {object} response 华为 token 响应。
 * @returns {string} 可展示给用户的错误原因。
 */
function formatTokenResponseError(response) {
  const ret = response?.ret || {};
  const code = ret.code ?? response?.code ?? "";
  const message = ret.msg || response?.message || "";
  if (Number(code) === 203886599 || /type of clientId not match/i.test(message)) {
    return [
      "华为 Token 校验失败：Client ID 类型不匹配。",
      "请确认填写的是 AppGallery Connect Connect API 客户端的 Client ID / Client Secret，",
      "不是项目里的 OAuth Client、应用 ID、包名或 HMS Core App ID。",
      "可在 AppGallery Connect 后台的用户与访问/API 客户端相关页面创建或查看 Connect API 客户端。",
    ].join("");
  }
  if (message || code) {
    return `华为 Token 校验失败：${message || "未知错误"}${code ? `（code: ${code}）` : ""}`;
  }
  return `华为 token 响应缺少 access_token：${safeStringify(response)}`;
}

/**
 * 获取华为安装包上传授权。
 *
 * 华为上传包体通常先调用 upload-url 获取上传地址和 authCode，再把本地包传到该地址。
 *
 * @param {object} config 规范化后的华为配置。
 * @param {string} accessToken 华为 Connect API access token。
 * @returns {Promise<object>} 上传授权信息。
 */
async function requestUploadUrl(config, accessToken) {
  const query = {
    appId: config.appId,
    suffix: config.fileSuffix,
  };
  const response = await requestJson(config, config.uploadUrlPath, {
    method: "GET",
    accessToken,
    query,
  });
  const uploadUrl = response.uploadUrl || response.upload_url;
  const authCode = response.authCode || response.auth_code;
  if (!uploadUrl || !authCode) {
    throw new Error(`华为上传授权响应缺少 uploadUrl/authCode：${safeStringify(response)}`);
  }
  return { uploadUrl, authCode, response };
}

/**
 * 使用上传授权上传 APK/AAB 文件。
 *
 * 上传使用 multipart/form-data，并用文件流写入，避免大包一次性读入内存。
 *
 * @param {string} uploadUrl 华为返回的上传地址。
 * @param {string} authCode 华为返回的上传授权码。
 * @param {string} filePath 本地 APK/AAB 路径。
 * @returns {Promise<object>} 上传服务返回的文件信息。
 */
function uploadPackageFile(uploadUrl, authCode, filePath) {
  const boundary = `----open-release-pilot-${Date.now().toString(16)}`;
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const header = Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="authCode"`,
    "",
    authCode,
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    "Content-Type: application/octet-stream",
    "",
  ].join("\r\n") + "\r\n");
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const parsedUrl = new URL(uploadUrl);
  const client = parsedUrl.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const req = client.request(parsedUrl, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": header.length + fileSize + footer.length,
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        const body = parseMaybeJson(raw);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`华为包体上传失败：HTTP ${res.statusCode} ${safeStringify(body)}`));
          return;
        }
        resolve(normalizeUploadResponse(body, filePath, fileSize));
      });
    });
    req.on("error", reject);
    req.write(header);
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", () => req.end(footer));
    stream.pipe(req, { end: false });
  });
}

/**
 * 更新华为应用包信息。
 *
 * 该步骤对应华为文档里的“应用包信息更新”接口：把已上传文件的目标地址、
 * 文件名、大小等信息关联到目标 App。
 *
 * @param {object} config 规范化后的华为配置。
 * @param {string} accessToken 华为 Connect API access token。
 * @param {object} fileInfo 上一步上传得到的文件信息。
 * @returns {Promise<object>} 华为包信息更新响应。
 */
function updatePackageInfo(config, accessToken, fileInfo) {
  return requestJson(config, config.appFileInfoPath, {
    method: "PUT",
    accessToken,
    query: { appId: config.appId },
    body: {
      lang: config.lang,
      fileType: config.fileType,
      files: [buildAppFileInfo(fileInfo)],
    },
  });
}

/**
 * 查询华为应用信息。
 *
 * 当前先做最通用的 app-info 查询，主要用于确认接口鉴权和应用 ID 是否可用。
 *
 * @param {object} config 规范化后的华为配置。
 * @param {string} accessToken 华为 Connect API access token。
 * @returns {Promise<object>} 华为应用信息响应。
 */
function queryAppInfo(config, accessToken) {
  return requestJson(config, config.appInfoPath, {
    method: "GET",
    accessToken,
    query: { appId: config.appId },
  });
}

/**
 * 提交华为审核。
 *
 * 这个动作风险较高，调用前由 uploader 再校验 submitForReview 开关。
 *
 * @param {object} config 规范化后的华为配置。
 * @param {string} accessToken 华为 Connect API access token。
 * @returns {Promise<object>} 提交审核接口响应。
 */
function submitReview(config, accessToken) {
  return requestJson(config, config.submitPath, {
    method: "POST",
    accessToken,
    query: { appId: config.appId },
    body: {},
  });
}

/**
 * 发起华为 Connect API JSON 请求。
 *
 * @param {object} config 规范化后的华为配置。
 * @param {string} apiPath 接口路径。
 * @param {{method?: string, accessToken?: string, query?: object, body?: object}} options 请求参数。
 * @returns {Promise<object>} JSON 响应体。
 */
async function requestJson(config, apiPath, options = {}) {
  const url = buildApiUrl(config.apiBaseUrl, apiPath, options.query);
  const headers = { "Content-Type": "application/json" };
  if (options.accessToken) {
    // 华为 Publishing API 的业务接口需要同时携带 client_id 和 Bearer token。
    // 只带 Authorization 会返回 205524993 / client token auth failed。
    headers.Authorization = `Bearer ${options.accessToken}`;
    headers.client_id = config.clientId;
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const raw = await response.text();
  const body = parseMaybeJson(raw);
  if (!response.ok) {
    if (options.accessToken && !options._tokenRetried && isHuaweiTokenExpired(response.status, body)) {
      clearCachedToken(getHuaweiTokenCacheKey(config));
      const freshToken = await requestAccessToken(config);
      return requestJson(config, apiPath, { ...options, accessToken: freshToken.accessToken, _tokenRetried: true });
    }
    throw new Error(formatHuaweiHttpError(response.status, body));
  }
  return body;
}

/**
 * 判断华为业务接口是否明确表示 token 已过期/失效。
 *
 * @param {number} status HTTP 状态码。
 * @param {object} body 响应体。
 * @returns {boolean} 是否可以刷新 token 后重试。
 */
function isHuaweiTokenExpired(status, body) {
  const ret = body?.ret || {};
  const code = ret.code ?? body?.code ?? "";
  const message = ret.msg || body?.message || "";
  return status === 401 || /token.*(expired|invalid)|client token auth failed/i.test(message) || Number(code) === 205524993;
}

/**
 * 格式化华为业务接口 HTTP 错误。
 *
 * @param {number} status HTTP 状态码。
 * @param {object} body 响应体。
 * @returns {string} 用户可操作的错误信息。
 */
function formatHuaweiHttpError(status, body) {
  const ret = body?.ret || {};
  const code = ret.code ?? body?.code ?? "";
  const message = ret.msg || body?.message || "";
  if (Number(code) === 205524993 || /client token auth failed/i.test(message)) {
    return [
      "华为接口鉴权失败：client token auth failed。",
      "通常是业务接口缺少 client_id 请求头、Token 与 Client ID 不匹配，或 API Client 没有当前应用权限。",
      `HTTP ${status}，code: ${code}`,
    ].join("");
  }
  return `华为接口请求失败：HTTP ${status} ${safeStringify(body)}`;
}

/**
 * 拼接 API URL。
 *
 * @param {string} baseUrl 接口域名。
 * @param {string} apiPath 接口路径。
 * @param {object} [query={}] 查询参数。
 * @returns {string} 完整 URL。
 */
function buildApiUrl(baseUrl, apiPath, query = {}) {
  const url = new URL(`${trimTrailingSlash(baseUrl)}${normalizePath(apiPath)}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  return url.toString();
}

/**
 * 从上传响应中提取后续包信息更新需要的字段。
 *
 * 华为不同文档/返回示例里可能出现 fileDestUlr 拼写，因此这里同时兼容
 * fileDestUrl 和 fileDestUlr，避免下一步更新包信息时丢字段。
 *
 * @param {object} body 上传接口响应。
 * @param {string} filePath 本地文件路径。
 * @param {number} fileSize 本地文件大小。
 * @returns {object} 标准化后的文件信息。
 */
function normalizeUploadResponse(body, filePath, fileSize) {
  const items = findUploadFileInfoList(body);
  const item = items[0] || body;
  const fileDestUrl = pickFirstString(item, ["fileDestUrl", "fileDestUlr", "file_dest_url", "destUrl", "destUlr", "url"]);
  return {
    raw: body,
    fileName: pickFirstString(item, ["fileName", "file_name", "name"]) || path.basename(filePath),
    fileDestUrl,
    size: Number(item?.size || item?.fileSize || item?.file_size || fileSize),
  };
}

/**
 * 从华为上传响应中递归寻找 fileInfoList。
 *
 * 上传服务的返回结构在不同示例里可能是顶层 fileInfoList，也可能包在
 * result / data / UploadFileRsp 下面，递归查找能减少对单一示例的依赖。
 *
 * @param {object} value 上传响应。
 * @returns {object[]} 文件信息列表。
 */
function findUploadFileInfoList(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findUploadFileInfoList(item);
      if (result.length) return result;
    }
    return [];
  }
  if (Array.isArray(value.fileInfoList)) return value.fileInfoList;
  if (Array.isArray(value.files)) return value.files;
  for (const child of Object.values(value)) {
    const result = findUploadFileInfoList(child);
    if (result.length) return result;
  }
  return [];
}

/**
 * 从对象里按多个候选字段取第一个字符串值。
 *
 * @param {object} object 数据对象。
 * @param {string[]} keys 候选字段名。
 * @returns {string} 第一个非空字符串。
 */
function pickFirstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

/**
 * 构建 app-file-info 接口的文件对象。
 *
 * @param {object} fileInfo 标准化文件信息。
 * @returns {object} 华为包信息更新接口 files 数组元素。
 */
function buildAppFileInfo(fileInfo) {
  if (!fileInfo?.fileDestUrl) {
    throw new Error("缺少华为已上传文件地址，请先执行“上传包体”。");
  }
  return {
    fileName: fileInfo.fileName,
    fileDestUrl: fileInfo.fileDestUrl,
    size: Number(fileInfo.size || 0),
  };
}

/**
 * 解析 JSON 字符串；非 JSON 时返回原始文本包装对象。
 *
 * @param {string} raw 原始响应文本。
 * @returns {object} 解析后的对象。
 */
function parseMaybeJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * 移除 token 类敏感字段。
 *
 * @param {object} value 原始响应对象。
 * @returns {object} 可安全记录的响应摘要。
 */
function omitTokenFields(value) {
  const clone = { ...(value || {}) };
  delete clone.access_token;
  delete clone.accessToken;
  delete clone.token;
  return clone;
}

/**
 * 安全序列化错误上下文。
 *
 * @param {unknown} value 需要序列化的值。
 * @returns {string} JSON 字符串。
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 规范化接口路径。
 *
 * @param {string} value 路径值。
 * @returns {string} 以 / 开头的路径。
 */
function normalizePath(value) {
  return String(value || "").startsWith("/") ? String(value || "") : `/${value || ""}`;
}

/**
 * 去掉 URL 末尾斜杠。
 *
 * @param {string} value URL。
 * @returns {string} 无尾斜杠 URL。
 */
function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

/**
 * 解析本机路径，支持 ~/xxx。
 *
 * @param {string} value 用户填写的路径。
 * @returns {string} 绝对路径或空字符串。
 */
function resolveLocalPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return process.env.HOME || text;
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2));
  return path.resolve(text);
}

/**
 * 解析华为 API Client JSON 路径。
 *
 * 用户没有手动填写时，自动查找当前项目 config/agc-apiclient-*.json；
 * 只有找到唯一文件时才自动使用，避免多个华为账号文件时误选。
 *
 * @param {string} value 用户填写的路径。
 * @returns {string} 绝对路径或空字符串。
 */
function resolveApiClientJsonPath(value) {
  const explicitPath = resolveLocalPath(value);
  if (explicitPath) return explicitPath;
  const configDir = path.resolve(__dirname, "../../../config");
  if (!fs.existsSync(configDir)) return "";
  const matches = fs.readdirSync(configDir)
    .filter((name) => /^agc-apiclient-.*\.json$/i.test(name))
    .map((name) => path.join(configDir, name));
  return matches.length === 1 ? matches[0] : "";
}

module.exports = {
  normalizeHuaweiConfig,
  importApiClientJson,
  requestAccessToken,
  requestUploadUrl,
  uploadPackageFile,
  updatePackageInfo,
  queryAppInfo,
  submitReview,
};
