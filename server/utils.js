const fs = require("fs");
const os = require("os");

/**
 * 读取 UTF-8 文本文件。
 *
 * @param {string} filePath 需要读取的本机文件路径。
 * @returns {string} 文件文本内容。
 */
function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/**
 * 读取 JSON 文件，不存在时返回兜底值。
 *
 * @param {string} filePath JSON 文件路径。
 * @param {unknown} fallback 文件不存在时返回的默认值。
 * @returns {unknown} 解析后的 JSON 数据或 fallback。
 */
function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(readText(filePath));
}

/**
 * 将毫秒耗时格式化为中文短文本。
 *
 * @param {number} ms 毫秒耗时。
 * @returns {string} 例如 "12秒" 或 "3分08秒"。
 */
function formatDuration(ms) {
  if (!ms) return "0秒";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

/**
 * 获取当前机器可用于手机访问的局域网 IPv4 地址。
 *
 * @returns {string[]} 非 internal 的 IPv4 地址列表。
 */
function getLocalIPv4Addresses() {
  // 手机扫码安装需要局域网地址，127.0.0.1 只能本机访问。
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

/**
 * 转义 HTML 文本。
 *
 * @param {unknown} value 需要插入 HTML 的值。
 * @returns {string} 已转义的安全文本。
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

module.exports = {
  readText,
  readJsonIfExists,
  formatDuration,
  getLocalIPv4Addresses,
  escapeHtml,
};
