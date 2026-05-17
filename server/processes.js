const childProcess = require("child_process");
const { ANDROID_BUILD_SCRIPT, IOS_BUILD_SCRIPT, PROCESS_SCAN_COMMANDS } = require("./config");
const { appendBuildLog, updateBuildProgress } = require("./android-build");
const { updateIosReleaseProgress } = require("./ios-release");
const runtime = require("./state");

/**
 * 读取当前系统进程快照。
 *
 * @returns {Promise<Array<{pid: number, ppid: number, pgid: number, command: string}>>} 进程列表。
 */
function runPsSnapshot() {
  // 使用 ps 快照而不是长期订阅进程事件，原因是发布面板只需要用户点击时查看/清理。
  // 输出列固定为 pid/ppid/pgid/command，pgid 用于一键停止整个脚本进程组。
  return new Promise((resolve, reject) => {
    childProcess.execFile("ps", ["-axo", "pid=,ppid=,pgid=,command="], { maxBuffer: 1024 * 1024 * 4 }, (error, stdout) => {
      if (error) return reject(error);
      const processes = stdout
        .split(/\r?\n/)
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
          if (!match) return null;
          return {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            command: match[4],
          };
        })
        .filter(Boolean);
      resolve(processes);
    });
  });
}

/**
 * 判断某个进程是否是发布台打包脚本。
 *
 * @param {{command: string}} processInfo ps 快照中的单个进程。
 * @returns {boolean} true 表示命中发布脚本。
 */
function isReleaseScriptProcess(processInfo) {
  return processInfo.command.includes(ANDROID_BUILD_SCRIPT) || processInfo.command.includes(IOS_BUILD_SCRIPT) || processInfo.command.includes("build_android_channels.sh") || processInfo.command.includes("build_ios_release.sh");
}

/**
 * 判断某个进程是否像发布构建工具子进程。
 *
 * @param {{command: string}} processInfo ps 快照中的单个进程。
 * @returns {boolean} true 表示命中 flutter/gradle/xcodebuild/altool 等构建工具关键字。
 */
function isLikelyBuildToolProcess(processInfo) {
  // 这个判断只在“已确认属于发布脚本进程组”后作为子进程展示过滤使用，
  // 不作为全机器停止条件，避免影响用户其它项目。
  return PROCESS_SCAN_COMMANDS.some((keyword) => processInfo.command.includes(keyword));
}

/**
 * 查询发布台相关后台构建进程。
 *
 * @returns {Promise<{checkedAt: string, count: number, processes: object[]}>} 已过滤的发布构建进程列表。
 */
async function listBuildProcesses() {
  const processes = await runPsSnapshot();
  const scriptProcesses = processes.filter(isReleaseScriptProcess);
  const trackedGroups = new Set(scriptProcesses.map((item) => item.pgid));
  if (runtime.activeBuild?.pid) trackedGroups.add(runtime.activeBuild.pid);
  if (runtime.activeIosBuild?.pid) trackedGroups.add(runtime.activeIosBuild.pid);
  if (runtime.activeIosUpload?.pid) trackedGroups.add(runtime.activeIosUpload.pid);

  // 进程组是发布台终止构建的边界。脚本启动 flutter/gradle/xcodebuild 后，
  // 子进程通常会留在同一个进程组里，因此展示同组构建工具可以定位残留后台任务。
  const releaseProcesses = processes
    .filter((item) => isReleaseScriptProcess(item) || (trackedGroups.has(item.pgid) && isLikelyBuildToolProcess(item)))
    .sort((a, b) => a.pid - b.pid)
    .map((item) => ({
      ...item,
      kind: isReleaseScriptProcess(item) ? "script" : "child",
      killable: true,
    }));

  return {
    checkedAt: new Date().toISOString(),
    count: releaseProcesses.length,
    processes: releaseProcesses,
  };
}

/**
 * 停止发布台相关的后台构建进程组。
 *
 * @returns {Promise<{stopped: boolean, message: string, killed: object[], failed: object[], before: object}>} 停止结果和停止前进程快照。
 */
async function stopBuildProcesses() {
  // 这个入口用于“后台进程”面板的一键停止。它先列出发布脚本相关进程，
  // 再按进程组发 SIGTERM，边界比直接 pkill flutter/gradle 更安全。
  const snapshot = await listBuildProcesses();
  const groups = [...new Set(snapshot.processes.map((item) => item.pgid).filter(Boolean))];
  const killed = [];
  const failed = [];

  groups.forEach((pgid) => {
    try {
      // 优先杀进程组，确保脚本和它拉起的 flutter/gradle/xcodebuild 一起退出。
      process.kill(-pgid, "SIGTERM");
      killed.push({ pgid, signal: "SIGTERM" });
    } catch (error) {
      failed.push({ pgid, error: error.message });
    }
  });

  if (runtime.activeBuild) updateBuildProgress({ stopping: true });
  if (runtime.activeIosBuild || runtime.activeIosUpload) {
    updateIosReleaseProgress({
      stopping: true,
      statusText: "正在终止 iOS 发布",
      detail: "已向 iOS 发布相关后台进程发送终止信号。",
    });
  }
  if (killed.length > 0) appendBuildLog(`已向 ${killed.length} 个后台构建进程组发送终止信号。`);

  return {
    stopped: killed.length > 0,
    message: killed.length > 0 ? "已发送终止信号，稍后可刷新进程列表确认。" : "没有找到发布台相关的后台打包进程。",
    killed,
    failed,
    before: snapshot,
  };
}

module.exports = {
  listBuildProcesses,
  stopBuildProcesses,
};
