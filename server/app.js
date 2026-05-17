const http = require("http");
const { HOST, PORT } = require("./config");
const { getAccessUrls } = require("./access");
const { serveInstall } = require("./install-preview");
const { handleApi } = require("./routes");
const { serveStatic } = require("./static");

/**
 * HTTP 服务入口。
 *
 * @param {import("http").IncomingMessage} req HTTP 请求对象。
 * @param {import("http").ServerResponse} res HTTP 响应对象。
 * @returns {void}
 */
const server = http.createServer((req, res) => {
  // 简单路由：/api/* 走 JSON API，/install/android/* 走手机安装页，其它路径走 public 静态文件。
  const { pathname } = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname);
    return;
  }
  if (pathname.startsWith("/install/android/")) {
    serveInstall(res, pathname);
    return;
  }
  serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  const access = getAccessUrls();
  console.log(`Open Release Pilot: ${access.localUrl}`);
  if (access.lanUrls.length > 0) console.log(`Open Release Pilot LAN: ${access.lanUrls.join(", ")}`);
});

module.exports = server;
