const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PANEL_ROOT } = require("../config");

/**
 * 判断值是否为空。
 *
 * 数组按长度判断；字符串会 trim；0 和 false 都不是空值。
 *
 * @param {unknown} value 待检查值。
 * @returns {boolean} true 表示空值。
 */
function isBlank(value) {
  if (Array.isArray(value)) return value.length === 0;
  return value === undefined || value === null || (typeof value === "string" ? value.trim() === "" : String(value).trim() === "");
}

/**
 * 删除对象里的空值字段，但保留 0 和 false。
 *
 * @param {object} object 原始对象。
 * @returns {object} 清理后的对象。
 */
function compactObject(object = {}) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => !isBlank(value)));
}

/**
 * 删除请求参数里的空值字段。
 *
 * @param {object} params 原始参数。
 * @returns {object} 清理后的参数。
 */
function compactParams(params = {}) {
  return compactObject(params);
}

/**
 * 格式化字节数。
 *
 * @param {number} bytes 字节数。
 * @returns {string} 适合进度和预检提示展示的大小。
 */
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 如果上传任务已被终止，立即抛出统一错误。
 *
 * @param {AbortSignal|undefined} signal 任务终止信号。
 * @param {string} [message="上传任务已终止"] 错误文案。
 * @returns {void}
 */
function throwIfAborted(signal, message = "上传任务已终止") {
  if (signal?.aborted) throw new Error(message);
}

/**
 * 等待指定毫秒数，并支持 AbortSignal 中断。
 *
 * @param {number} ms 等待时间，单位毫秒。
 * @param {AbortSignal|undefined} signal 任务终止信号。
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
 * 解析本机配置路径。
 *
 * 相对路径默认相对面板项目根目录；http/https 地址原样返回，供兼容旧配置使用。
 *
 * @param {string} filePath 用户配置路径。
 * @returns {string} 绝对路径或 URL。
 */
function resolveLocalPath(filePath) {
  const value = String(filePath || "");
  if (/^https?:\/\//i.test(value)) return value;
  if (path.isAbsolute(value)) return value;
  return path.join(PANEL_ROOT, value);
}

/**
 * 计算文件 MD5。
 *
 * @param {string} filePath 本地文件路径。
 * @returns {string} 小写十六进制 MD5。
 */
function md5FileSync(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * 解析 JSON 响应。
 *
 * @param {string} text 响应文本。
 * @param {string} label 接口名称。
 * @returns {object} JSON 对象。
 */
function parseJsonResponse(text, label) {
  try {
    return JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`${label}返回不是 JSON：${String(text || "").slice(0, 300)}`);
  }
}

/**
 * 压缩对象大小，避免上传记录写入过大的原始响应。
 *
 * @param {object} object 原始对象。
 * @param {{maxLength?: number, previewLength?: number}} [options] 限制参数。
 * @returns {object} 可保存对象。
 */
function limitObjectSize(object = {}, options = {}) {
  const maxLength = options.maxLength || 6000;
  const previewLength = options.previewLength || maxLength;
  const text = JSON.stringify(object || {});
  if (text.length <= maxLength) return object || {};
  return {
    code: object?.code,
    msg: object?.msg || object?.message,
    truncated: true,
    preview: text.slice(0, previewLength),
  };
}

/**
 * 脱敏密钥类字符串。
 *
 * @param {string} value 原始密钥。
 * @returns {string} 脱敏结果。
 */
function maskSecret(value) {
  const text = String(value || "");
  if (text.length <= 8) return text ? "****" : "";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

/**
 * 拆分多行文本。
 *
 * @param {unknown} value 原始值。
 * @returns {string[]} 文本列表。
 */
function splitLines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  compactObject,
  compactParams,
  delay,
  formatBytes,
  isBlank,
  limitObjectSize,
  maskSecret,
  md5FileSync,
  parseJsonResponse,
  resolveLocalPath,
  splitLines,
  throwIfAborted,
};
