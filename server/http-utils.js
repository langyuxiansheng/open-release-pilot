/**
 * 发送 JSON 响应并记录接口日志。
 *
 * @param {import("http").ServerResponse & {__apiLog?: object}} res HTTP 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body JSON 响应体。
 * @returns {void}
 */
function sendJson(res, status, body) {
  // API 统一返回 JSON，前端 requestJson 会按 error/message 字段展示失败原因。
  logApiResponse(res, status, body);
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * 输出 API 请求日志。
 *
 * @param {import("http").ServerResponse & {__apiLog?: object}} res 带有 __apiLog 元信息的响应对象。
 * @param {number} status HTTP 状态码。
 * @param {object} body JSON 响应体，用于提取 message/error。
 * @returns {void}
 */
function logApiResponse(res, status, body) {
  // 接口日志只输出方法、路径、状态、耗时和简短结果，不打印请求体/响应体。
  // 发布配置里可能包含商店 API Key、Apple Key ID、私钥路径等敏感信息，不能写入终端日志。
  const meta = res.__apiLog;
  if (!meta) return;
  const duration = Date.now() - meta.startedAt;
  const message = body?.message || body?.error || "";
  const suffix = message ? ` - ${message}` : "";
  console.log(`[api] ${meta.method} ${meta.pathname} ${status} ${duration}ms${suffix}`);
}

/**
 * 读取 JSON 请求体。
 *
 * @param {import("http").IncomingMessage} req HTTP 请求对象。
 * @returns {Promise<object>} 解析后的请求体对象。
 */
function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

module.exports = {
  sendJson,
  readRequestJson,
};
