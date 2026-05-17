const childProcess = require("child_process");
const path = require("path");
const { DEFAULT_IOS_CONFIG, IOS_BUILD_SCRIPT } = require("./config");
const { readDb, readIosConfig, readVersion, writeDb } = require("./db");
const { scanIosPackage } = require("./packages");
const { getActiveProject } = require("./projects");
const runtime = require("./state");
const { formatDuration } = require("./utils");

runtime.iosReleaseProgress = createIdleIosReleaseProgress();

/**
 * 创建 iOS 发布进度的空闲状态。
 *
 * @returns {object} iOS 发布阶段、百分比、目标和耗时信息。
 */
function createIdleIosReleaseProgress() {
  // iOS 进度不是 Xcode 内部编译百分比，而是发布流程阶段进度：
  // 准备 -> 打包 -> 可选上传 -> 完成/失败/终止。
  return {
    running: false,
    stopping: false,
    phase: "idle",
    releaseTarget: DEFAULT_IOS_CONFIG.releaseTarget,
    statusText: "空闲",
    detail: "等待开始 iOS 发布",
    percent: 0,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    exitCode: null,
    uploadExitCode: null,
  };
}

/**
 * 获取当前 iOS 发布进度快照。
 *
 * @returns {object} 包含实时耗时的 iOS 发布进度。
 */
function getIosReleaseProgress() {
  // 运行中动态计算 elapsedMs，任务结束后保留最后一次写入的耗时。
  const progress = runtime.iosReleaseProgress;
  const now = Date.now();
  const elapsedMs = progress.startedAt && progress.running ? now - new Date(progress.startedAt).getTime() : progress.elapsedMs;
  let percent = progress.percent;
  if (progress.running && progress.phase === "building") {
    percent = Math.min(68, Math.max(percent, 12 + Math.floor(elapsedMs / 1000)));
  } else if (progress.running && progress.phase === "uploading") {
    percent = Math.min(96, Math.max(percent, 78 + Math.floor(elapsedMs / 3000)));
  }
  return {
    ...progress,
    percent,
    elapsedMs,
    elapsedText: formatDuration(elapsedMs),
  };
}

/**
 * 合并更新 iOS 发布进度。
 *
 * @param {object} patch 需要覆盖到 iosReleaseProgress 上的局部字段。
 * @returns {void}
 */
function updateIosReleaseProgress(patch) {
  // phase 是服务端和前端之间的轻量状态协议，前端只负责展示，不反推业务逻辑。
  runtime.iosReleaseProgress = {
    ...runtime.iosReleaseProgress,
    ...patch,
  };
}

/**
 * 追加 iOS 构建/上传日志并通过 SSE 广播。
 *
 * @param {string} line iOS 脚本或上传工具输出的一行日志。
 * @returns {void}
 */
function appendIosBuildLog(line) {
  // iOS 构建和上传使用独立 SSE 队列，前端展示时会加 [iOS] 前缀。
  // 与 Android 日志分开缓存，避免两个任务同时运行时互相覆盖。
  runtime.iosBuildLogs.push({ time: new Date().toISOString(), line });
  if (runtime.iosBuildLogs.length > 800) runtime.iosBuildLogs.shift();
  const payload = `data: ${JSON.stringify(runtime.iosBuildLogs[runtime.iosBuildLogs.length - 1])}\n\n`;
  for (const client of runtime.iosBuildClients) client.write(payload);
}

/**
 * 停止当前服务启动的 iOS 发布任务。
 *
 * @returns {{stopped: boolean, message: string}} 停止结果。
 */
function stopIosRelease() {
  // iOS 任务可能处于 Xcode 打包阶段，也可能已经进入 App Store Connect 上传阶段。
  // 两段分别记录进程对象，因此停止时优先杀正在运行的具体进程组。
  const targetProcess = runtime.activeIosUpload || runtime.activeIosBuild;
  if (!targetProcess) {
    return { stopped: false, message: "当前没有正在运行的 iOS 发布任务。" };
  }

  updateIosReleaseProgress({
    stopping: true,
    statusText: runtime.activeIosUpload ? "正在终止上传" : "正在终止打包",
    detail: "已发送终止信号，等待 iOS 发布进程退出。",
  });
  appendIosBuildLog("收到终止 iOS 发布任务指令。");

  try {
    process.kill(-targetProcess.pid, "SIGTERM");
  } catch (error) {
    targetProcess.kill("SIGTERM");
  }
  return { stopped: true, message: "已发送终止信号，等待 iOS 发布进程退出。" };
}

/**
 * 根据 iOS 发布配置生成脚本环境变量。
 *
 * @param {object} config iOS 发布配置。
 * @returns {NodeJS.ProcessEnv} 传给 build_ios_release.sh 的环境变量集合。
 */
function getIosBuildEnv(config) {
  // iOS 构建脚本通过环境变量接收导出 plist 和输出目录。
  // build-only 用 AdHoc plist；上传 App Store Connect/TestFlight 用 app-store plist。
  const exportOptionsPlist = config.releaseTarget === "build-only" ? config.exportOptionsPlist || DEFAULT_IOS_CONFIG.exportOptionsPlist : config.appStoreExportOptionsPlist || DEFAULT_IOS_CONFIG.appStoreExportOptionsPlist;
  const project = getActiveProject();
  const version = readVersion();
  return {
    ...process.env,
    RELEASE_PROJECT_ROOT: project.rootPath,
    FLUTTER_PROJECT_ROOT: project.rootPath,
    ORP_VERSION_NAME: version.versionName,
    ORP_VERSION_CODE: version.versionCode,
    ORP_APP_SLUG: project.appSlug,
    ORP_IOS_OUTPUT_ROOT: project.iosOutputRoot,
    ORP_IPA_NAME_TEMPLATE: project.ipaNameTemplate,
    IOS_EXPORT_OPTIONS_PLIST: exportOptionsPlist,
    IOS_OUTPUT_DIR: config.outputDir || "",
  };
}

/**
 * 上传 IPA 到 App Store Connect。
 *
 * @param {string|undefined} ipaPath IPA 文件路径。
 * @param {object} config iOS 发布配置，包含 Apple API Key 信息。
 * @param {string} target 发布目标，例如 app-store-connect 或 testflight。
 * @returns {Promise<{skipped: boolean, exitCode: number|null}>} 上传结果。
 */
function runAppStoreUpload(ipaPath, config, target) {
  // 上传动作只在 IPA 已存在且用户选择非 build-only 时执行。
  // 这里仍使用 xcrun altool；后续如果切换 notarytool / transporter，可集中替换此函数。
  if (!ipaPath || !require("fs").existsSync(ipaPath)) {
    appendIosBuildLog("没有找到 IPA，跳过 App Store Connect 上传。");
    updateIosReleaseProgress({
      phase: "failed",
      running: false,
      percent: 100,
      statusText: "上传失败",
      detail: "没有找到 IPA，无法上传。",
      finishedAt: new Date().toISOString(),
      elapsedMs: runtime.iosReleaseProgress.startedAt ? Date.now() - new Date(runtime.iosReleaseProgress.startedAt).getTime() : runtime.iosReleaseProgress.elapsedMs,
      uploadExitCode: 1,
    });
    return Promise.resolve({ skipped: true, exitCode: 1 });
  }

  if (!config.appleKeyId || !config.appleIssuerId) {
    appendIosBuildLog("缺少 Apple Key ID 或 Issuer ID，无法上传到 App Store Connect。");
    updateIosReleaseProgress({
      phase: "failed",
      running: false,
      percent: 100,
      statusText: "上传失败",
      detail: "缺少 Apple Key ID 或 Issuer ID。",
      finishedAt: new Date().toISOString(),
      elapsedMs: runtime.iosReleaseProgress.startedAt ? Date.now() - new Date(runtime.iosReleaseProgress.startedAt).getTime() : runtime.iosReleaseProgress.elapsedMs,
      uploadExitCode: 1,
    });
    return Promise.resolve({ skipped: true, exitCode: 1 });
  }

  // altool 会在本机 Xcode 工具链里读取 API Key。私钥可以放在 Apple 默认目录，
  // 也可以通过 API_PRIVATE_KEYS_DIR 指向 .p8 所在目录，避免把密钥写进仓库。
  const uploadEnv = { ...process.env };
  const project = getActiveProject();
  if (config.applePrivateKeyPath) {
    uploadEnv.API_PRIVATE_KEYS_DIR = path.dirname(path.resolve(project.rootPath, config.applePrivateKeyPath));
  }

  appendIosBuildLog(`开始上传到 App Store Connect，目标：${target}`);
  updateIosReleaseProgress({
    phase: "uploading",
    running: true,
    percent: 78,
    statusText: "正在上传",
    detail: target === "testflight" ? "正在上传到 App Store Connect，等待 Apple 处理后进入 TestFlight。" : "正在上传到 App Store Connect。",
  });
  return new Promise((resolve) => {
    // 使用 App Store Connect API Key 上传，避免在脚本里保存 Apple ID 密码。
    runtime.activeIosUpload = childProcess.spawn("xcrun", ["altool", "--upload-app", "--type", "ios", "--file", ipaPath, "--apiKey", config.appleKeyId, "--apiIssuer", config.appleIssuerId], {
      cwd: project.rootPath,
      detached: true,
      shell: false,
      env: uploadEnv,
    });

    runtime.activeIosUpload.stdout.on("data", (chunk) => {
      chunk.toString().split(/\r?\n/).filter(Boolean).forEach(appendIosBuildLog);
    });
    runtime.activeIosUpload.stderr.on("data", (chunk) => {
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => appendIosBuildLog(`[stderr] ${line}`));
    });
    runtime.activeIosUpload.on("close", (code, signal) => {
      const wasStopping = runtime.iosReleaseProgress.stopping;
      appendIosBuildLog(`App Store Connect 上传结束，退出码：${code}`);
      runtime.activeIosUpload = null;
      updateIosReleaseProgress({
        phase: wasStopping ? "stopped" : code === 0 ? "completed" : "failed",
        running: false,
        percent: 100,
        statusText: wasStopping ? "已终止" : code === 0 ? "上传完成" : "上传失败",
        detail: signal ? `上传进程已退出，信号：${signal}` : code === 0 ? "IPA 已上传到 App Store Connect。" : `上传失败，退出码：${code ?? "无"}。`,
        finishedAt: new Date().toISOString(),
        elapsedMs: runtime.iosReleaseProgress.startedAt ? Date.now() - new Date(runtime.iosReleaseProgress.startedAt).getTime() : runtime.iosReleaseProgress.elapsedMs,
        uploadExitCode: code,
      });
      resolve({ skipped: false, exitCode: code });
    });
  });
}

/**
 * 启动 iOS 发布任务。
 *
 * @returns {{started: boolean, message: string}} 启动结果。
 */
function startIosRelease() {
  // iOS 发布任务包括“构建 IPA”和“可选上传 App Store Connect”两段。
  // activeIosBuild/activeIosUpload 分别锁住构建和上传阶段，避免重复启动。
  if (runtime.activeIosBuild || runtime.activeIosUpload || runtime.iosReleaseProgress.running) {
    return { started: false, message: "已有 iOS 发布任务正在运行。" };
  }

  runtime.iosBuildLogs.length = 0;
  const startedAt = new Date().toISOString();
  const config = readIosConfig();
  const project = getActiveProject();
  appendIosBuildLog(`开始 iOS 发布任务：${config.releaseTarget}`);
  runtime.iosReleaseProgress = createIdleIosReleaseProgress();
  updateIosReleaseProgress({
    running: true,
    stopping: false,
    phase: "building",
    releaseTarget: config.releaseTarget,
    statusText: "正在打包",
    detail: "正在执行 iOS 打包脚本；如果目标 IPA 已存在，脚本会跳过重新构建。",
    percent: 12,
    startedAt,
    elapsedMs: 0,
    exitCode: null,
    uploadExitCode: null,
  });

  runtime.activeIosBuild = childProcess.spawn(IOS_BUILD_SCRIPT, {
    cwd: project.rootPath,
    // iOS 脚本同样独立成进程组，后台进程面板才能一键停止脚本及 xcodebuild 子进程。
    detached: true,
    shell: false,
    env: getIosBuildEnv(config),
  });

  runtime.activeIosBuild.stdout.on("data", (chunk) => {
    chunk.toString().split(/\r?\n/).filter(Boolean).forEach(appendIosBuildLog);
  });
  runtime.activeIosBuild.stderr.on("data", (chunk) => {
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => appendIosBuildLog(`[stderr] ${line}`));
  });
  runtime.activeIosBuild.on("close", async (code, signal) => {
    appendIosBuildLog(`iOS 打包结束，退出码：${code}`);
    const wasStopping = runtime.iosReleaseProgress.stopping;
    runtime.activeIosBuild = null;
    const packageInfo = scanIosPackage();
    let uploadResult = { skipped: true, exitCode: null };
    if (wasStopping) {
      updateIosReleaseProgress({
        phase: "stopped",
        running: false,
        percent: 100,
        statusText: "已终止",
        detail: signal ? `iOS 打包进程已终止，信号：${signal}` : "iOS 打包任务已终止。",
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - new Date(startedAt).getTime(),
        exitCode: code ?? 1,
      });
    } else if (code === 0 && config.releaseTarget !== "build-only") {
      updateIosReleaseProgress({
        phase: "uploading",
        running: true,
        percent: 72,
        statusText: "准备上传",
        detail: "IPA 已准备好，正在启动 App Store Connect 上传。",
        exitCode: code,
      });
      uploadResult = await runAppStoreUpload(packageInfo.ipa?.path, config, config.releaseTarget);
    } else {
      updateIosReleaseProgress({
        phase: code === 0 ? "completed" : "failed",
        running: false,
        percent: 100,
        statusText: code === 0 ? "打包完成" : "打包失败",
        detail: code === 0 ? "IPA 已输出到目标目录。" : `iOS 打包失败，退出码：${code ?? "无"}。`,
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - new Date(startedAt).getTime(),
        exitCode: code ?? 1,
      });
    }

    const db = readDb();
    db.iosBuildRuns.unshift({
      id: `${Date.now()}`,
      versionName: packageInfo.versionName,
      versionCode: packageInfo.versionCode,
      releaseTarget: config.releaseTarget,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      ipa: packageInfo.ipa,
    });
    db.iosBuildRuns = db.iosBuildRuns.slice(0, 50);
    if (!uploadResult.skipped) {
      db.iosUploadRuns.unshift({
        id: `${Date.now()}-upload`,
        versionName: packageInfo.versionName,
        versionCode: packageInfo.versionCode,
        releaseTarget: config.releaseTarget,
        ipa: packageInfo.ipa,
        finishedAt: new Date().toISOString(),
        exitCode: uploadResult.exitCode,
      });
      db.iosUploadRuns = db.iosUploadRuns.slice(0, 50);
    }
    writeDb(db);
  });

  return { started: true, message: "iOS 发布任务已启动。" };
}

module.exports = {
  appendIosBuildLog,
  getIosReleaseProgress,
  startIosRelease,
  stopIosRelease,
  updateIosReleaseProgress,
};
