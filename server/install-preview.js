const fs = require("fs");
const path = require("path");
const { getAccessUrls } = require("./access");
const { scanPackages } = require("./packages");
const { escapeHtml } = require("./utils");

/**
 * 生成某个 APK 的手机下载 URL。
 *
 * @param {string} baseUrl 面板可被手机访问的基础地址。
 * @param {object} packageInfo scanPackages 返回的当前版本包信息。
 * @param {object} item packageInfo.packages 中的单个渠道项。
 * @returns {string} APK 下载 URL；没有 APK 时返回空字符串。
 */
function getPackageUrl(baseUrl, packageInfo, item) {
  if (!item.apk) return "";
  const fileName = path.basename(item.apk.path);
  return `${baseUrl}/install/android/${encodeURIComponent(packageInfo.versionName)}/${encodeURIComponent(item.dir)}/${encodeURIComponent(fileName)}`;
}

/**
 * 扫描当前版本安装包预览信息。
 *
 * @returns {{checkedAt: string, folderPath: string, folderUrl: string, access: object, packages: object[]}} 手机扫码安装预览数据。
 */
function scanInstallPreview() {
  // 安装预览只面向当前版本目录，避免手机端看到历史版本里可能已经废弃的包。
  const packageInfo = scanPackages();
  const access = getAccessUrls();
  const folderPath = packageInfo.versionDir;
  const folderUrl = `${access.primaryUrl}/install/android/${encodeURIComponent(packageInfo.versionName)}/`;
  return {
    checkedAt: new Date().toISOString(),
    folderPath,
    folderUrl,
    access,
    packages: packageInfo.packages.map((item) => ({
      code: item.code,
      name: item.name,
      dir: item.dir,
      apk: item.apk,
      url: getPackageUrl(access.primaryUrl, packageInfo, item),
    })),
  };
}

/**
 * 发送 HTML 响应。
 *
 * @param {import("http").ServerResponse} res HTTP 响应对象。
 * @param {string} html HTML 文本。
 * @returns {void}
 */
function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

/**
 * 返回手机端安装包目录页。
 *
 * @param {import("http").ServerResponse} res HTTP 响应对象。
 * @param {string} versionName URL 中的版本名。
 * @returns {void}
 */
function serveInstallPage(res, versionName) {
  // 手机端目录页只列出当前版本扫描到的 APK，并提供原生下载链接。
  const packageInfo = scanPackages();
  if (versionName !== packageInfo.versionName) {
    res.writeHead(404);
    res.end("Version not found");
    return;
  }
  const packages = packageInfo.packages.filter((item) => item.apk);
  const rows = packages.map((item) => {
    const fileName = path.basename(item.apk.path);
    const href = `/install/android/${encodeURIComponent(packageInfo.versionName)}/${encodeURIComponent(item.dir)}/${encodeURIComponent(fileName)}`;
    return `<a class="apk" href="${href}"><strong>${escapeHtml(item.name)} (${escapeHtml(item.code)})</strong><span>${escapeHtml(item.apk.sizeText)} / ${escapeHtml(fileName)}</span></a>`;
  }).join("");
  sendHtml(res, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open Release Pilot ${escapeHtml(versionName)} 安装包</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 18px; background: #f5f6f8; color: #1f2933; }
    h1 { font-size: 20px; margin: 0 0 6px; }
    p { color: #697586; font-size: 13px; margin: 0 0 16px; word-break: break-all; }
    .list { display: grid; gap: 10px; }
    .apk { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; color: inherit; display: grid; gap: 6px; padding: 14px; text-decoration: none; }
    .apk strong { font-size: 16px; }
    .apk span { color: #697586; font-size: 12px; word-break: break-all; }
    .empty { background: #fff2e4; border-radius: 8px; color: #a45500; padding: 14px; }
  </style>
</head>
<body>
  <h1>Open Release Pilot ${escapeHtml(versionName)} 安装包</h1>
  <p>${escapeHtml(packageInfo.versionDir)}</p>
  <div class="list">${rows || '<div class="empty">当前版本目录下没有可安装 APK。</div>'}</div>
</body>
</html>`);
}

/**
 * 返回指定 APK 文件下载响应。
 *
 * @param {import("http").ServerResponse} res HTTP 响应对象。
 * @param {string} versionName URL 中的版本名。
 * @param {string} channelDir 渠道目录名。
 * @param {string} fileName APK 文件名。
 * @returns {void}
 */
function serveInstallApk(res, versionName, channelDir, fileName) {
  // APK 下载路径必须落在当前版本目录下，防止通过 URL 拼接访问任意本机文件。
  const packageInfo = scanPackages();
  if (versionName !== packageInfo.versionName) {
    res.writeHead(404);
    res.end("Version not found");
    return;
  }
  const versionDir = path.resolve(packageInfo.versionDir);
  const filePath = path.resolve(versionDir, channelDir, fileName);
  if (!filePath.startsWith(versionDir) || !fs.existsSync(filePath) || path.extname(filePath) !== ".apk") {
    res.writeHead(404);
    res.end("APK not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * 分发 /install/android/* 安装预览请求。
 *
 * @param {import("http").ServerResponse} res HTTP 响应对象。
 * @param {string} pathname 请求路径。
 * @returns {void}
 */
function serveInstall(res, pathname) {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "install" || parts[1] !== "android" || !parts[2]) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (parts.length === 3) return serveInstallPage(res, parts[2]);
  if (parts.length === 5) return serveInstallApk(res, parts[2], parts[3], parts[4]);
  res.writeHead(404);
  res.end("Not found");
}

module.exports = {
  getPackageUrl,
  scanInstallPreview,
  serveInstall,
};
