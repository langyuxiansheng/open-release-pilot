/**
 * 格式化后端返回的 ISO 时间。
 *
 * @param {string} value ISO 时间字符串。
 * @returns {string} 中文本地时间文本；空值返回空字符串。
 */
export function formatDate(value) {
  // 后端统一返回 ISO 时间；前端统一转中文本地时间，避免每个渲染函数重复处理。
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
