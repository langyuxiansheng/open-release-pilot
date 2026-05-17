const fs = require("fs");
const path = require("path");
const { IOS_RELEASE_TARGETS } = require("./config");
const { readIosConfig, readVersion, savePackageSnapshot } = require("./db");
const { getActiveProject } = require("./projects");

/**
 * 读取安装包文件元信息。
 *
 * @param {string} filePath 安装包文件路径。
 * @returns {null|{path: string, size: number, sizeText: string, updatedAt: string}} 文件信息，不存在时返回 null。
 */
function getPackageFileInfo(filePath) {
  // 文件扫描统一返回 path/size/mtime，前端只负责展示。
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    sizeText: `${(stat.size / 1024 / 1024).toFixed(1)} MB`,
    updatedAt: stat.mtime.toISOString(),
  };
}

/**
 * 扫描当前版本 Android 渠道包。
 *
 * @returns {{versionName: string, versionCode: string, versionDir: string, packages: object[]}} 当前版本包扫描结果。
 */
function scanPackages() {
  // Android 渠道包优先按当前命名模板扫描；如果历史脚本输出过异常文件名，
  // 再按版本号/构建号/渠道在对应目录里兜底查找，方便用户在面板里识别和删除。
  const project = getActiveProject();
  const version = readVersion();
  const { versionName, versionCode } = version;
  const hasVersion = Boolean(versionName && versionCode);
  const versionDir = hasVersion ? path.join(project.androidOutputRoot, versionName) : "";
  const packages = project.channels.map((channel) => {
    if (!hasVersion) {
      return {
        ...channel,
        apk: null,
        expectedApkPath: "",
      };
    }
    const apkName = renderTemplate(project.apkNameTemplate, { versionName, versionCode, channel: channel.code, appSlug: project.appSlug });
    const apkPath = path.join(versionDir, channel.dir, apkName);
    const fallbackApkPath = findExistingChannelApk(path.join(versionDir, channel.dir), { versionName, versionCode, channel: channel.code });
    return {
      ...channel,
      apk: getPackageFileInfo(apkPath) || getPackageFileInfo(fallbackApkPath),
      expectedApkPath: apkPath,
    };
  });
  const packageInfo = { projectId: project.id, versionName, versionCode, versionDir, packages, warning: version.warning || "" };
  // 占位项目或版本文件缺失时不要写入空版本记录；只返回可渲染状态，
  // 让开源首启页面保持可用，并引导用户先完成项目配置。
  if (hasVersion) savePackageSnapshot(packageInfo);
  return packageInfo;
}

/**
 * 在渠道目录中兜底查找当前版本和渠道的 APK。
 *
 * 旧版本脚本或用户手动改名时，文件名可能不是当前模板计算出的精确名称。
 * 面板扫描时先认标准命名，找不到再按 versionName/versionCode/channel 查找，
 * 这样仍然可以展示并删除已存在的异常命名包。
 *
 * @param {string} channelDir 渠道输出目录。
 * @param {{versionName: string, versionCode: string, channel: string}} info 当前版本和渠道。
 * @returns {string} 找到的 APK 路径，找不到返回空字符串。
 */
function findExistingChannelApk(channelDir, info) {
  if (!fs.existsSync(channelDir) || !fs.statSync(channelDir).isDirectory()) return "";
  const candidates = fs.readdirSync(channelDir)
    .filter((name) => name.endsWith(".apk") || name.includes(".apk"))
    .filter((name) => name.includes(info.versionName) && name.includes(info.versionCode) && name.includes(info.channel))
    .map((name) => path.join(channelDir, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || "";
}

/**
 * 扫描当前版本 iOS IPA。
 *
 * @returns {{versionName: string, versionCode: string, outputDir: string, ipa: object|null, releaseTargets: object[], config: object}} iOS 包状态。
 */
function scanIosPackage() {
  // iOS 当前只扫描最终复制到桌面 iOS 包目录的 IPA。
  // build/ios/ipa 里的临时产物由脚本负责查找和复制，不在面板里直接展示。
  const project = getActiveProject();
  const version = readVersion();
  const { versionName, versionCode } = version;
  const config = readIosConfig();
  const hasVersion = Boolean(versionName && versionCode);
  const outputDir = hasVersion ? (config.outputDir || path.join(project.iosOutputRoot, versionName)) : "";
  const ipaName = hasVersion ? renderTemplate(project.ipaNameTemplate, { versionName, versionCode, appSlug: project.appSlug }) : "";
  const ipaPath = hasVersion ? path.join(outputDir, ipaName) : "";
  return {
    projectId: project.id,
    versionName,
    versionCode,
    outputDir,
    ipa: hasVersion ? getPackageFileInfo(ipaPath) : null,
    releaseTargets: IOS_RELEASE_TARGETS,
    config,
    warning: version.warning || "",
  };
}

/**
 * 删除当前版本指定渠道的 APK。
 *
 * @param {string[]} channelCodes 需要删除 APK 的渠道 code 列表。
 * @returns {{deleted: object[], skipped: object[], packageInfo: object, message: string}} 删除结果。
 */
function deletePackages(channelCodes) {
  // 删除只接受渠道 code，不接受前端传入的文件路径。
  // 真实 APK 路径由 scanPackages 按当前版本重新计算，避免前端伪造路径误删其它文件。
  const requestedCodes = new Set((Array.isArray(channelCodes) ? channelCodes : []).map((code) => String(code).trim()));
  if (requestedCodes.size === 0) {
    return { deleted: [], skipped: [], packageInfo: scanPackages(), message: "没有选择需要删除的渠道包。" };
  }

  const packageInfo = scanPackages();
  const deleted = [];
  const skipped = [];
  const allowedChannels = new Set(getActiveProject().channels.map((channel) => channel.code));

  packageInfo.packages.forEach((item) => {
    if (!requestedCodes.has(item.code)) return;
    if (!allowedChannels.has(item.code)) {
      skipped.push({ code: item.code, reason: "未知渠道" });
      return;
    }
    if (!item.apk?.path || !fs.existsSync(item.apk.path)) {
      skipped.push({ code: item.code, reason: "未找到已存在的 APK" });
      return;
    }

    // 删除路径只来自 scanPackages 计算结果，确保只能删除当前版本目录下的渠道 APK。
    fs.unlinkSync(item.apk.path);
    deleted.push({ code: item.code, path: item.apk.path });
  });

  const nextPackageInfo = scanPackages();
  const message = deleted.length > 0 ? `已删除 ${deleted.length} 个渠道包。` : "没有删除任何渠道包。";
  return { deleted, skipped, packageInfo: nextPackageInfo, message };
}

/**
 * 渲染安装包命名模板。
 *
 * @param {string} template 文件名模板。
 * @param {Record<string, string>} values 可替换变量。
 * @returns {string} 渲染后的文件名。
 */
function renderTemplate(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

module.exports = {
  getPackageFileInfo,
  scanPackages,
  scanIosPackage,
  deletePackages,
  renderTemplate,
};
