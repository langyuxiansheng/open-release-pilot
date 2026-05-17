/**
 * 发起 JSON API 请求。
 *
 * 后端所有发布面板接口都返回 JSON；错误时优先展示后端 message/error，
 * 这样用户在日志窗口里看到的是服务端给出的真实失败原因。
 *
 * @param {string} path API 路径。
 * @param {RequestInit} [options={}] fetch 选项。
 * @returns {Promise<object>} 后端 JSON 响应体。
 */
export async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || body.message || '请求失败');
  return body;
}
