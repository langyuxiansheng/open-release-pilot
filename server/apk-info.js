const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getActiveProject } = require("./projects");

/**
 * 解析本机 APK 的基础包信息。
 *
 * 这里统一走 Android SDK build-tools/aapt，避免每个应用市场上传服务都各自
 * 解析一次 APK。调用方只需要关心 packageName、versionName、versionCode，
 * 这些字段可以用于表单自动回填、上传预检和线上版本比对。
 *
 * @param {string} rawApkPath 用户选择或手动输入的 APK 路径。
 * @returns {{ok: boolean, message?: string, apkPath?: string, packageName?: string, versionName?: string, versionCode?: string}} APK 信息。
 */
function readApkInfo(rawApkPath) {
  const apkPath = resolveApkPath(rawApkPath);
  if (!apkPath) {
    return { ok: false, message: "APK 路径不能为空。" };
  }
  if (!fs.existsSync(apkPath)) {
    return { ok: false, message: `APK 文件不存在：${apkPath}` };
  }
  if (path.extname(apkPath).toLowerCase() !== ".apk") {
    return { ok: false, message: `当前文件不是 APK：${apkPath}` };
  }

  const aapt = findAaptBinary();
  if (!aapt) {
    return { ok: false, message: "未找到 Android SDK build-tools/aapt，无法读取 APK 信息。" };
  }

  const result = spawnSync(aapt, ["dump", "badging", apkPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "aapt 执行失败").trim();
    return { ok: false, message: `读取 APK 信息失败：${detail}` };
  }

  const packageLine = String(result.stdout || "").split(/\r?\n/).find((line) => line.startsWith("package:"));
  if (!packageLine) {
    return { ok: false, message: "aapt 输出中没有 package 信息。" };
  }

  return {
    ok: true,
    apkPath,
    packageName: packageLine.match(/name='([^']+)'/)?.[1] || "",
    versionCode: packageLine.match(/versionCode='([^']+)'/)?.[1] || "",
    versionName: packageLine.match(/versionName='([^']+)'/)?.[1] || "",
  };
}

/**
 * 解析用户输入的 APK 路径。
 *
 * 文件选择器返回的是绝对路径；手动输入相对路径时，优先按当前项目根目录解析，
 * 这样通用面板切换项目后仍能读取各项目自己的构建产物。
 *
 * @param {string} rawApkPath 原始路径。
 * @returns {string} 可用于 fs/aapt 的绝对路径。
 */
function resolveApkPath(rawApkPath) {
  const normalized = String(rawApkPath || "").trim();
  if (!normalized) return "";
  if (path.isAbsolute(normalized)) return normalized;
  return path.resolve(getActiveProject().rootPath, normalized);
}

/**
 * 查找本机 Android SDK 的 aapt。
 *
 * @returns {string} aapt 绝对路径；找不到时返回空字符串。
 */
function findAaptBinary() {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || "", "Library/Android/sdk"),
  ].filter(Boolean);

  for (const sdkRoot of sdkRoots) {
    const buildToolsDir = path.join(sdkRoot, "build-tools");
    if (!fs.existsSync(buildToolsDir)) continue;
    const versions = fs.readdirSync(buildToolsDir)
      .map((name) => ({ name, file: path.join(buildToolsDir, name, "aapt") }))
      .filter((item) => fs.existsSync(item.file))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const latest = versions.at(-1);
    if (latest) return latest.file;
  }
  return "";
}

module.exports = {
  findAaptBinary,
  readApkInfo,
  resolveApkPath,
};
