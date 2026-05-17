const childProcess = require("child_process");
const { ANDROID_BUILD_SCRIPT } = require("./config");
const { readDb, writeDb } = require("./db");
const { scanPackages } = require("./packages");
const { getActiveProject } = require("./projects");
const runtime = require("./state");
const { formatDuration } = require("./utils");

runtime.buildProgress = createIdleBuildProgress();

const TEMPLATE_SAMPLE_VALUES = {
  versionName: "3.5.0",
  versionCode: "68",
  channel: "PGYER",
  appSlug: "demo-app",
};

const TEMPLATE_ALLOWED_KEYS = new Set(Object.keys(TEMPLATE_SAMPLE_VALUES));

/**
 * 创建 Android 总构建进度的空闲状态。
 *
 * @returns {object} 包含总进度、当前渠道和各渠道状态的进度对象。
 */
function createIdleBuildProgress() {
  // Android 进度不是 Flutter 内部编译百分比，而是“渠道完成度”。
  // 脚本每进入/跳过/完成一个渠道会输出 release-panel 标记，服务端据此更新这些字段。
  const projectChannels = getActiveProject().channels;
  const channels = Object.fromEntries(projectChannels.map((channel) => [channel.code, createIdleChannelProgress()]));
  return {
    running: false,
    stopping: false,
    selectedChannels: projectChannels.map((channel) => channel.code),
    currentChannel: "",
    currentIndex: 0,
    total: projectChannels.length,
    completed: 0,
    skipped: 0,
    percent: 0,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    statusText: "空闲",
    exitCode: null,
    channels,
  };
}

/**
 * 创建单个渠道的空闲进度状态。
 *
 * @returns {object} 单渠道状态、百分比、起止时间和耗时。
 */
function createIdleChannelProgress() {
  return {
    status: "idle",
    percent: 0,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
  };
}

/**
 * 根据本次勾选渠道创建各渠道初始状态。
 *
 * @param {string[]} selectedCodes 本次需要构建的渠道 code 列表。
 * @returns {Record<string, object>} key 为渠道 code 的单渠道进度表。
 */
function createSelectedChannelProgress(selectedCodes) {
  const selected = new Set(selectedCodes);
  return Object.fromEntries(getActiveProject().channels.map((channel) => [
    channel.code,
    {
      ...createIdleChannelProgress(),
      status: selected.has(channel.code) ? "pending" : "idle",
    },
  ]));
}

/**
 * 规范化并过滤前端传入的渠道 code。
 *
 * @param {unknown[]} channelCodes 前端传入的渠道 code 列表。
 * @returns {string[]} 去重后且存在于 CHANNELS 中的合法渠道 code。
 */
function normalizeChannelCodes(channelCodes) {
  const allowed = new Set(getActiveProject().channels.map((channel) => channel.code));
  const normalized = (Array.isArray(channelCodes) ? channelCodes : [])
    .map((code) => String(code).trim())
    .filter((code) => allowed.has(code));
  return [...new Set(normalized)];
}

/**
 * 获取当前 Android 构建进度快照。
 *
 * @returns {object} 包含实时总耗时和各渠道实时耗时的构建进度。
 */
function getBuildProgress() {
  // elapsedMs 在任务运行中实时计算，任务结束后固定为 close 事件记录的耗时。
  const progress = runtime.buildProgress;
  const now = Date.now();
  const elapsedMs = progress.startedAt && progress.running ? now - new Date(progress.startedAt).getTime() : progress.elapsedMs;
  const channels = Object.fromEntries(Object.entries(progress.channels || {}).map(([code, channel]) => {
    const channelElapsedMs = channel.startedAt && channel.status === "building" ? now - new Date(channel.startedAt).getTime() : channel.elapsedMs;
    const channelPercent = channel.status === "building" ? Math.min(95, Math.max(channel.percent || 5, 5 + Math.floor(channelElapsedMs / 1000) * 2)) : channel.percent;
    return [code, {
      ...channel,
      percent: channelPercent,
      elapsedMs: channelElapsedMs,
      elapsedText: formatDuration(channelElapsedMs),
    }];
  }));
  return {
    ...progress,
    channels,
    elapsedMs,
    elapsedText: formatDuration(elapsedMs),
  };
}

/**
 * 合并更新 Android 总构建进度。
 *
 * @param {object} patch 需要覆盖到 buildProgress 上的局部字段。
 * @returns {void}
 */
function updateBuildProgress(patch) {
  // 所有进度字段都通过这个函数合并，确保 percent/statusText 的派生逻辑保持一致。
  runtime.buildProgress = {
    ...runtime.buildProgress,
    ...patch,
    channels: patch.channels || runtime.buildProgress.channels,
  };
  const progress = runtime.buildProgress;
  const total = progress.total || getActiveProject().channels.length || 1;
  progress.percent = Math.min(100, Math.round(((progress.completed + progress.skipped) / total) * 100));
  if (progress.running && progress.currentChannel) {
    progress.statusText = progress.stopping ? `正在终止：${progress.currentChannel}` : `正在打 ${progress.currentChannel}`;
  } else if (progress.running) {
    progress.statusText = progress.stopping ? "正在终止" : "打包中";
  } else if (progress.exitCode === null) {
    progress.statusText = "空闲";
  } else if (progress.exitCode === 0) {
    progress.statusText = "已完成";
  } else {
    progress.statusText = progress.stopping ? "已终止" : "失败";
  }
}

/**
 * 合并更新某一个 Android 渠道的构建进度。
 *
 * @param {string} channelCode 渠道 code，例如 PGYER、XIAOMI。
 * @param {object} patch 需要覆盖到该渠道进度上的局部字段。
 * @returns {void}
 */
function updateChannelProgress(channelCode, patch) {
  if (!channelCode || !runtime.buildProgress.channels?.[channelCode]) return;
  runtime.buildProgress.channels = {
    ...runtime.buildProgress.channels,
    [channelCode]: {
      ...runtime.buildProgress.channels[channelCode],
      ...patch,
    },
  };
}

/**
 * 追加 Android 构建日志并通过 SSE 广播。
 *
 * @param {string} line 构建脚本输出的一行日志。
 * @returns {void}
 */
function appendBuildLog(line) {
  // release-panel 标记只用于更新进度，不展示给用户，避免日志窗口混入协议行。
  if (parseAndroidBuildProgress(line)) return;
  runtime.buildLogs.push({ time: new Date().toISOString(), line });
  if (runtime.buildLogs.length > 800) runtime.buildLogs.shift();
  const payload = `data: ${JSON.stringify(runtime.buildLogs[runtime.buildLogs.length - 1])}\n\n`;
  for (const client of runtime.buildClients) client.write(payload);
}

/**
 * 解析构建脚本输出的进度标记。
 *
 * @param {string} line 构建脚本输出的一行日志。
 * @returns {boolean} 是否是面板协议标记。
 */
function parseAndroidBuildProgress(line) {
  // 这些标记是脚本和面板之间的轻量协议，避免前端解析普通构建日志。
  const marker = "::release-panel::";
  if (!line.startsWith(marker)) return false;
  const defaultTotal = getActiveProject().channels.length;
  const [event, channel = "", rawIndex = "0", rawTotal = `${defaultTotal}`] = line.slice(marker.length).split("|");
  const currentIndex = Number(rawIndex) || 0;
  const total = Number(rawTotal) || defaultTotal;

  if (event === "android-total") {
    updateBuildProgress({ total: Number(channel) || defaultTotal });
    return true;
  }

  if (event === "android-channel-start") {
    updateChannelProgress(channel, {
      status: "building",
      percent: 5,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: 0,
    });
    updateBuildProgress({ currentChannel: channel, currentIndex, total });
    return true;
  }

  if (event === "android-channel-skip") {
    const finishedAt = new Date().toISOString();
    updateChannelProgress(channel, {
      status: "skipped",
      percent: 100,
      finishedAt,
      elapsedMs: 0,
    });
    updateBuildProgress({
      currentChannel: channel,
      currentIndex,
      total,
      skipped: runtime.buildProgress.skipped + 1,
    });
    return true;
  }

  if (event === "android-channel-done") {
    const finishedAt = new Date().toISOString();
    const startedAt = runtime.buildProgress.channels?.[channel]?.startedAt;
    updateChannelProgress(channel, {
      status: "done",
      percent: 100,
      finishedAt,
      elapsedMs: startedAt ? Date.now() - new Date(startedAt).getTime() : 0,
    });
    updateBuildProgress({
      currentChannel: channel,
      currentIndex,
      total,
      completed: runtime.buildProgress.completed + 1,
    });
    return true;
  }

  if (event === "android-all-done") {
    updateBuildProgress({ total: Number(channel) || total, completed: runtime.buildProgress.completed });
    return true;
  }

  return true;
}

/**
 * 启动 Android 多渠道构建。
 *
 * @param {string[]} [channelCodes=[]] 前端勾选的渠道 code 列表。
 * @returns {{started: boolean, message: string}} 启动结果。
 */
function startBuild(channelCodes = []) {
  // activeBuild 是并发锁，防止用户连续点击导致多个 release 构建同时抢资源。
  if (runtime.activeBuild) {
    return { started: false, message: "已有打包任务正在运行。" };
  }

  const project = getActiveProject();
  const templateCheck = validateAndroidApkTemplate(project.apkNameTemplate);
  if (!templateCheck.ok) {
    return {
      started: false,
      message: `APK 命名模板配置错误：${templateCheck.message}`,
    };
  }

  const selectedChannels = normalizeChannelCodes(channelCodes);
  if (selectedChannels.length === 0) {
    return { started: false, message: "请先至少选择一个需要打包的渠道。" };
  }

  runtime.buildLogs.length = 0;
  const startedAt = new Date().toISOString();
  runtime.buildProgress = createIdleBuildProgress();
  updateBuildProgress({
    running: true,
    selectedChannels,
    total: selectedChannels.length,
    channels: createSelectedChannelProgress(selectedChannels),
    startedAt,
    elapsedMs: 0,
    statusText: "准备打包",
  });
  appendBuildLog(`开始执行 scripts/build_android_channels.sh，渠道：${selectedChannels.join(",")}`);
  appendBuildLog(`当前 APK 命名模板：${project.apkNameTemplate}`);

  runtime.activeBuild = childProcess.spawn(ANDROID_BUILD_SCRIPT, {
    cwd: project.rootPath,
    // detached 让脚本成为独立进程组；终止时可以杀 -pid，连同 flutter/gradle 子进程一起退出。
    detached: true,
    shell: false,
    env: {
      ...process.env,
      BUILD_CHANNELS: selectedChannels.join(","),
      RELEASE_PROJECT_ROOT: project.rootPath,
      FLUTTER_PROJECT_ROOT: project.rootPath,
      ORP_ANDROID_OUTPUT_ROOT: project.androidOutputRoot,
      ORP_ANDROID_APK_SOURCE: project.androidApkSource,
      ORP_APK_NAME_TEMPLATE: project.apkNameTemplate,
      ORP_APP_SLUG: project.appSlug,
      ORP_CHANNEL_DIRS: project.channels.map((channel) => `${channel.code}=${channel.dir}`).join("|"),
    },
  });

  runtime.activeBuild.stdout.on("data", (chunk) => {
    chunk.toString().split(/\r?\n/).filter(Boolean).forEach(appendBuildLog);
  });

  runtime.activeBuild.stderr.on("data", (chunk) => {
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => appendBuildLog(`[stderr] ${line}`));
  });

  runtime.activeBuild.on("close", (code, signal) => {
    // close 事件代表脚本和管道都已经结束；这里统一收尾进度、扫描最终 APK、
    // 并把一次构建记录写入本地数据库，方便后续查看历史。
    const finishedAt = new Date().toISOString();
    const wasStopping = runtime.buildProgress.stopping;
    const finishedAtMs = Date.now();
    const nextChannels = Object.fromEntries(Object.entries(runtime.buildProgress.channels || {}).map(([channelCode, channel]) => {
      if (channel.status !== "building" && channel.status !== "pending") return [channelCode, channel];
      const failedStatus = wasStopping ? "stopped" : "failed";
      return [channelCode, {
        ...channel,
        status: failedStatus,
        finishedAt,
        elapsedMs: channel.startedAt ? finishedAtMs - new Date(channel.startedAt).getTime() : channel.elapsedMs,
      }];
    }));
    updateBuildProgress({
      running: false,
      finishedAt,
      elapsedMs: Date.now() - new Date(startedAt).getTime(),
      exitCode: code ?? 1,
      statusText: wasStopping ? "已终止" : code === 0 ? "已完成" : "失败",
      channels: nextChannels,
    });
    runtime.activeBuild = null;
    appendBuildLog(`打包任务结束，退出码：${code ?? "无"}${signal ? `，信号：${signal}` : ""}`);
    const db = readDb();
    const packageInfo = scanPackages();
    db.buildRuns.unshift({
      id: `${Date.now()}`,
      versionName: packageInfo.versionName,
      versionCode: packageInfo.versionCode,
      startedAt,
      finishedAt,
      exitCode: code,
      signal,
      packages: Object.fromEntries(packageInfo.packages.map((item) => [item.code, item.apk])),
    });
    db.buildRuns = db.buildRuns.slice(0, 50);
    writeDb(db);
  });

  return { started: true, message: "打包任务已启动。" };
}

/**
 * 启动构建前校验 Android APK 命名模板。
 *
 * 项目管理保存时已经有校验，但构建入口仍然要做一次兜底：有人可能手动改
 * data/projects-db.json，或浏览器旧页面保存了异常值。这里提前拦住，避免脚本
 * 启动后才发现包名渲染成 release-xxx.apk-xxx.apk} 这类异常结果。模板变量
 * 是可选的，目录结构会按版本和渠道拆分，文件名本身不强制包含任何变量。
 *
 * @param {string} template 当前项目配置里的 APK 命名模板。
 * @returns {{ok: boolean, message: string}} 校验结果。
 */
function validateAndroidApkTemplate(template) {
  const value = String(template || "").trim();
  if (!value) return { ok: false, message: "模板不能为空。" };
  if (!value.endsWith(".apk")) return { ok: false, message: "模板必须以 .apk 结尾。" };
  if (value.includes("/") || value.includes("\\")) return { ok: false, message: "模板只能是文件名，不能包含路径。" };

  const tokens = [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const unknownToken = tokens.find((token) => !TEMPLATE_ALLOWED_KEYS.has(token));
  if (unknownToken) return { ok: false, message: `不支持变量 {${unknownToken}}。` };

  const rendered = value.replace(/\{(\w+)\}/g, (_, key) => TEMPLATE_SAMPLE_VALUES[key] ?? "");
  if (rendered.includes("{") || rendered.includes("}")) return { ok: false, message: "模板里还有未闭合或未替换的花括号。" };
  return { ok: true, message: "" };
}

/**
 * 停止当前服务启动的 Android 构建任务。
 *
 * @returns {{stopped: boolean, message: string}} 停止结果。
 */
function stopBuild() {
  if (!runtime.activeBuild) {
    return { stopped: false, message: "当前没有正在运行的打包任务。" };
  }
  updateBuildProgress({ stopping: true });
  appendBuildLog("收到终止打包任务指令。");
  try {
    process.kill(-runtime.activeBuild.pid, "SIGTERM");
  } catch (error) {
    runtime.activeBuild.kill("SIGTERM");
  }
  return { stopped: true, message: "已发送终止信号，等待构建进程退出。" };
}

module.exports = {
  appendBuildLog,
  getBuildProgress,
  startBuild,
  stopBuild,
  updateBuildProgress,
};
