import { elements } from './state.js';
import { formatDate } from './utils.js';

/**
 * 追加一条构建日志到日志窗口。
 *
 * 安卓构建、iOS 构建和上传预检都写到同一个窗口，iOS 日志会由调用方加前缀区分来源。
 * 页面端只追加当前浏览器可见日志；服务端 SSE 内存日志仍由 server.js 控制上限。
 *
 * @param {{time: string, line: string}} entry 日志时间和内容。
 * @returns {void}
 */
export function appendLog(entry) {
  const line = `[${formatDate(entry.time)}] ${entry.line}`;
  elements.buildLog.textContent += `${line}\n`;
  elements.buildLog.scrollTop = elements.buildLog.scrollHeight;
}

/**
 * 清空当前页面日志窗口。
 *
 * @returns {void}
 */
export function clearLog() {
  // 这里只清空当前页面显示；服务端 SSE 内存日志仍会在刷新连接时回放最近记录。
  elements.buildLog.textContent = '';
}
