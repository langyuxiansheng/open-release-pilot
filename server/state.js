// 发布面板服务端运行态。这里的数据只存在于当前 node 进程内，
// 构建历史和配置持久化仍然写入 release-db.json 或 stores.local.json。
const runtime = {
  activeBuild: null,
  activeIosBuild: null,
  activeIosUpload: null,
  activeStoreUpload: null,
  buildProgress: null,
  iosReleaseProgress: null,
  storeUploadProgress: null,
  buildClients: new Set(),
  iosBuildClients: new Set(),
  buildLogs: [],
  iosBuildLogs: [],
};

module.exports = runtime;
