const { getAccessUrls } = require("./access");
const { appendBuildLog, getBuildProgress, startBuild, stopBuild } = require("./android-build");
const { deleteUploadRun, readCurrentNotes, readDb, readStoreConfig, writeCurrentNotes, writeIosConfig, writeStoreConfig } = require("./db");
const { readRequestJson, sendJson } = require("./http-utils");
const { scanInstallPreview } = require("./install-preview");
const { getIosReleaseProgress, startIosRelease, stopIosRelease } = require("./ios-release");
const { deletePackages, scanIosPackage, scanPackages } = require("./packages");
const { listBuildProcesses, stopBuildProcesses } = require("./processes");
const { deleteProject, getActiveProject, getProjectContext, inspectProjectPath, listLocalDirectories, saveProject, setActiveProject } = require("./projects");
const runtime = require("./state");
const { getStoreUploadProgress, runStoreUpload, stopStoreUpload } = require("./stores");

/**
 * 判断当前是否有 iOS 发布任务运行。
 *
 * @returns {boolean} true 表示 iOS 打包或上传正在运行。
 */
function isIosReleaseRunning() {
  return Boolean(runtime.activeIosBuild || runtime.activeIosUpload || runtime.iosReleaseProgress.running);
}

/**
 * 处理 /api/* 接口请求。
 *
 * @param {import("http").IncomingMessage} req HTTP 请求对象。
 * @param {import("http").ServerResponse & {__apiLog?: object}} res HTTP 响应对象。
 * @param {string} pathname 已解析出的请求路径。
 * @returns {Promise<void>} 接口处理完成后直接写入响应。
 */
async function handleApi(req, res, pathname) {
  res.__apiLog = {
    method: req.method,
    pathname,
    startedAt: Date.now(),
  };

  try {
    // /api/status 是页面首次加载和手动刷新时的完整快照。
    // 打包中的高频进度刷新不要调用它，否则会覆盖用户正在编辑的表单内容。
    if (req.method === "GET" && pathname === "/api/status") {
      return sendJson(res, 200, {
        projectRoot: getActiveProject().rootPath,
        activeProject: getActiveProject(),
        projects: getProjectContext(),
        access: getAccessUrls(),
        buildRunning: Boolean(runtime.activeBuild),
        buildProgress: getBuildProgress(),
        iosBuildRunning: isIosReleaseRunning(),
        iosReleaseProgress: getIosReleaseProgress(),
        storeUploadProgress: getStoreUploadProgress(),
        packageInfo: scanPackages(),
        iosPackageInfo: scanIosPackage(),
        releaseNotes: readCurrentNotes(),
        database: {
          path: require("./config").DB_FILE,
          data: readDb(),
        },
        storeConfig: readStoreConfig(),
      });
    }

    if (req.method === "POST" && pathname === "/api/notes") {
      // 更新日志按当前版本保存，Android 商店文案和 iOS TestFlight 说明都可以复用。
      const body = await readRequestJson(req);
      return sendJson(res, 200, { ok: true, ...writeCurrentNotes(body.text) });
    }

    if (req.method === "POST" && pathname === "/api/projects/active") {
      // 切换当前项目后，后续扫描、打包、iOS 发布和上传配置都以该项目为准。
      const body = await readRequestJson(req);
      return sendJson(res, 200, { ok: true, projects: setActiveProject(body.projectId) });
    }

    if (req.method === "POST" && pathname === "/api/projects/save") {
      // 保存项目基础配置：路径、输出目录、命名模板和渠道列表。
      const body = await readRequestJson(req);
      return sendJson(res, 200, { ok: true, projects: saveProject(body.project || {}) });
    }

    if (req.method === "POST" && pathname === "/api/projects/inspect") {
      // 根据本机目录自动识别 Flutter/Android 项目，返回可回填到项目表单的默认配置。
      const body = await readRequestJson(req);
      return sendJson(res, 200, inspectProjectPath(body.path));
    }

    if (req.method === "GET" && pathname === "/api/files/list") {
      // 本地文件浏览器默认只返回目录；应用市场包路径选择会传 includeFiles=1。
      const url = new URL(req.url, "http://localhost");
      const extensions = String(url.searchParams.get("extensions") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return sendJson(res, 200, listLocalDirectories(url.searchParams.get("path"), {
        includeFiles: url.searchParams.get("includeFiles") === "1",
        extensions,
      }));
    }

    if (req.method === "POST" && pathname === "/api/projects/delete") {
      // 删除项目配置，不删除任何 Flutter 工程文件或构建产物。
      const body = await readRequestJson(req);
      return sendJson(res, 200, { ok: true, projects: deleteProject(body.projectId) });
    }

    if (req.method === "POST" && pathname === "/api/store-config") {
      // 安卓商店配置写入 stores.local.json，这个文件应被 .gitignore 忽略。
      const body = await readRequestJson(req);
      writeStoreConfig(body.stores || {});
      return sendJson(res, 200, { ok: true, storeConfig: readStoreConfig() });
    }

    if (req.method === "POST" && pathname === "/api/ios-config") {
      // iOS 配置写入 release-db.json，包含本机路径和 Apple API Key 元数据。
      const body = await readRequestJson(req);
      return sendJson(res, 200, { ok: true, iosConfig: writeIosConfig(body.config || {}) });
    }

    if (req.method === "POST" && pathname === "/api/build") {
      // Android 构建入口：只负责启动脚本，实时日志走 /api/build/events。
      const body = await readRequestJson(req);
      return sendJson(res, 200, startBuild(body.channels || []));
    }

    if (req.method === "GET" && pathname === "/api/build/progress") {
      // 轻量进度接口：前端打包中每秒轮询，只返回构建状态和派生耗时。
      return sendJson(res, 200, {
        buildRunning: Boolean(runtime.activeBuild),
        buildProgress: getBuildProgress(),
      });
    }

    if (req.method === "POST" && pathname === "/api/build/stop") {
      // 停止当前服务进程内 activeBuild 指向的 Android 构建。
      return sendJson(res, 200, stopBuild());
    }

    if (req.method === "POST" && pathname === "/api/packages/delete") {
      // 删除当前版本已存在的渠道包。请求体只允许传渠道 code，不允许传文件路径。
      const body = await readRequestJson(req);
      const result = deletePackages(body.channels || []);
      if (result.deleted.length > 0) appendBuildLog(result.message);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && pathname === "/api/install-preview") {
      // 返回当前版本安装包目录的局域网访问地址，前端用它生成扫码入口。
      return sendJson(res, 200, scanInstallPreview());
    }

    if (req.method === "GET" && pathname === "/api/processes") {
      // 查询发布台相关后台进程，用于发现手动启动或残留的脚本/构建工具。
      return sendJson(res, 200, await listBuildProcesses());
    }

    if (req.method === "POST" && pathname === "/api/processes/stop") {
      // 一键停止后台发布构建：按发布脚本进程组发 SIGTERM。
      return sendJson(res, 200, await stopBuildProcesses());
    }

    if (req.method === "POST" && pathname === "/api/ios-release") {
      // iOS 发布入口：保存配置由前端先调 /api/ios-config 完成，这里只启动任务。
      return sendJson(res, 200, startIosRelease());
    }

    if (req.method === "GET" && pathname === "/api/ios-release/progress") {
      // iOS 轻量进度接口：打包/上传期间轮询，不刷新整页表单。
      return sendJson(res, 200, {
        iosBuildRunning: isIosReleaseRunning(),
        iosReleaseProgress: getIosReleaseProgress(),
      });
    }

    if (req.method === "POST" && pathname === "/api/ios-release/stop") {
      // 停止当前服务进程内启动的 iOS 打包或上传任务。
      return sendJson(res, 200, stopIosRelease());
    }

    if (req.method === "POST" && pathname === "/api/upload") {
      // Android 商店上传入口。路由层不写具体平台协议；
      // 不同应用市场的签名、字段、文件上传都交给 server/stores 下的独立服务。
      const body = await readRequestJson(req);
      return sendJson(res, 200, await runStoreUpload(body));
    }

    if (req.method === "GET" && pathname === "/api/upload/progress") {
      // 应用市场上传进度接口：前端执行上传时轮询，不刷新整页表单。
      return sendJson(res, 200, {
        uploadRunning: getStoreUploadProgress().running,
        storeUploadProgress: getStoreUploadProgress(),
      });
    }

    if (req.method === "POST" && pathname === "/api/upload/stop") {
      // 终止当前应用市场上传任务。具体 HTTP 请求由各 uploader 接收 signal 后自行退出。
      return sendJson(res, 200, stopStoreUpload());
    }

    if (req.method === "POST" && pathname === "/api/upload-runs/delete") {
      // 删除单条上传历史记录；只修改 release-db.json，不删除任何安装包文件。
      const body = await readRequestJson(req);
      return sendJson(res, 200, deleteUploadRun(body.id));
    }

    if (req.method === "GET" && pathname === "/api/build/events") {
      console.log(`[api] ${req.method} ${pathname} 200 stream-open`);
      // Android 构建日志 SSE。新连接会先回放内存里的最近日志，再接收实时日志。
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      runtime.buildClients.add(res);
      runtime.buildLogs.forEach((entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
      req.on("close", () => {
        runtime.buildClients.delete(res);
        console.log(`[api] ${req.method} ${pathname} stream-close`);
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/ios-release/events") {
      console.log(`[api] ${req.method} ${pathname} 200 stream-open`);
      // iOS 构建/上传日志 SSE，和 Android 分开是为了保留不同任务的来源语义。
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      runtime.iosBuildClients.add(res);
      runtime.iosBuildLogs.forEach((entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
      req.on("close", () => {
        runtime.iosBuildClients.delete(res);
        console.log(`[api] ${req.method} ${pathname} stream-close`);
      });
      return;
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
}

module.exports = {
  handleApi,
};
