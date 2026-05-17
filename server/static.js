const fs = require("fs");
const path = require("path");
const { PUBLIC_DIR } = require("./config");

/**
 * 返回 public 目录里的前端静态文件。
 *
 * @param {import("http").ServerResponse} res HTTP 响应对象。
 * @param {string} pathname 请求路径。
 * @returns {void}
 */
function serveStatic(res, pathname) {
  // 只允许访问 public 目录下的静态文件，path.normalize + startsWith 防止路径穿越。
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  const contentType = ext === ".js" ? "application/javascript; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

module.exports = {
  serveStatic,
};
