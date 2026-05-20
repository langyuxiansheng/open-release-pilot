/**
 * 发布面板前端共享状态。
 *
 * 这个对象只保存浏览器侧的瞬时状态，不直接代表本地文件数据库。
 * 后端真实状态仍然以 /api/status、/api/build/progress 等接口返回为准。
 *
 * @type {{
 *   status: object|null,
 *   activePage: string,
 *   activeStoreKey: string,
 *   uploadRunsPage: number,
 *   uploadRunsQuery: string,
 *   uploadRunsStoreFilter: string,
 *   uploadRunsActionFilter: string,
 *   uploadRunsStatusFilter: string,
 *   uploadRuns: object[],
 *   themePreference: string,
 *   selectedChannelCodes: Set<string>
 * }}
 */
export const state = {
  // 后端 /api/status 的完整快照。页面保存配置时会基于这份快照做增量合并，
  // 避免只保存当前可见 tab 时丢掉其它平台配置。
  status: null,
  // 当前后台页面。这里只保存 hash 路由 key，不直接保存 DOM id，方便后续新增页面。
  activePage: decodeURIComponent(window.location.hash || '').replace('#', '') || 'workbench',
  // 上传配置区域当前打开的平台 tab。服务端刷新后继续保留当前 tab，减少配置时的跳动。
  activeStoreKey: '',
  // 上传记录分页页码。记录来自本地 JSON 数据库，前端分页避免一次渲染过长表格。
  uploadRunsPage: 1,
  // 上传记录筛选条件只属于浏览器当前页面，不写入后端数据库。
  uploadRunsQuery: '',
  uploadRunsStoreFilter: '',
  uploadRunsActionFilter: '',
  uploadRunsStatusFilter: '',
  uploadRuns: [],
  // 主题偏好只属于当前浏览器，不写入后端数据库。取值：system / light / dark。
  themePreference: localStorage.getItem('release-panel-theme') || 'system',
  // 用户在“渠道包”区域勾选的渠道。它同时用于“按选中渠道打包”和“删除选中渠道已存在 APK”。
  // 前端只保存渠道 code，真实构建列表和删除路径都由后端校验。
  selectedChannelCodes: new Set(),
};

/**
 * 发布面板常用 DOM 节点缓存。
 *
 * 所有模块共享同一份节点引用，后续增删页面区域时只需要先在这里补入口，
 * 再由对应模块读取，避免每个功能文件里散落 querySelector。
 */
export const elements = {
  pageTitle: document.querySelector('#pageTitle'),
  projectRoot: document.querySelector('#projectRoot'),
  projectPanel: document.querySelector('#projectPanel'),
  versionText: document.querySelector('#versionText'),
  versionDir: document.querySelector('#versionDir'),
  buildState: document.querySelector('#buildState'),
  iosBuildState: document.querySelector('#iosBuildState'),
  databasePath: document.querySelector('#databasePath'),
  packageList: document.querySelector('#packageList'),
  iosReleasePanel: document.querySelector('#iosReleasePanel'),
  releaseNotes: document.querySelector('#releaseNotes'),
  storeConfig: document.querySelector('#storeConfig'),
  processPanel: document.querySelector('#processPanel'),
  installPreviewPanel: document.querySelector('#installPreviewPanel'),
  buildLog: document.querySelector('#buildLog'),
  buildProgressTitle: document.querySelector('#buildProgressTitle'),
  buildProgressBar: document.querySelector('#buildProgressBar'),
  buildProgressDetail: document.querySelector('#buildProgressDetail'),
  buildElapsedText: document.querySelector('#buildElapsedText'),
  storeUploadProgressTitle: document.querySelector('#storeUploadProgressTitle'),
  storeUploadProgressBar: document.querySelector('#storeUploadProgressBar'),
  storeUploadProgressDetail: document.querySelector('#storeUploadProgressDetail'),
  storeUploadElapsedText: document.querySelector('#storeUploadElapsedText'),
  uploadRunsPanel: document.querySelector('#uploadRunsPanel'),
  uploadRunsSearch: document.querySelector('#uploadRunsSearch'),
  uploadRunsStoreFilter: document.querySelector('#uploadRunsStoreFilter'),
  uploadRunsActionFilter: document.querySelector('#uploadRunsActionFilter'),
  uploadRunsStatusFilter: document.querySelector('#uploadRunsStatusFilter'),
  quickProjectSelector: document.querySelector('#quickProjectSelector'),
  refreshButton: document.querySelector('#refreshButton'),
  refreshPackagesButton: document.querySelector('#refreshPackagesButton'),
  newProjectButton: document.querySelector('#newProjectButton'),
  saveProjectButton: document.querySelector('#saveProjectButton'),
  deleteProjectButton: document.querySelector('#deleteProjectButton'),
  selectAllChannelsButton: document.querySelector('#selectAllChannelsButton'),
  buildButton: document.querySelector('#buildButton'),
  stopBuildButton: document.querySelector('#stopBuildButton'),
  deletePackagesButton: document.querySelector('#deletePackagesButton'),
  refreshProcessesButton: document.querySelector('#refreshProcessesButton'),
  refreshInstallPreviewButton: document.querySelector('#refreshInstallPreviewButton'),
  stopProcessesButton: document.querySelector('#stopProcessesButton'),
  saveNotesButton: document.querySelector('#saveNotesButton'),
  saveStoreConfigButton: document.querySelector('#saveStoreConfigButton'),
  saveIosConfigButton: document.querySelector('#saveIosConfigButton'),
  iosReleaseButton: document.querySelector('#iosReleaseButton'),
  stopIosReleaseButton: document.querySelector('#stopIosReleaseButton'),
  uploadButton: document.querySelector('#uploadButton'),
  uploadExecuteButton: document.querySelector('#uploadExecuteButton'),
  uploadAllButton: document.querySelector('#uploadAllButton'),
  revokeAllButton: document.querySelector('#revokeAllButton'),
  stopUploadButton: document.querySelector('#stopUploadButton'),
  clearLogButton: document.querySelector('#clearLogButton'),
  themeOptions: document.querySelectorAll('[data-theme-option]'),
  pages: document.querySelectorAll('[data-page]'),
  pageLinks: document.querySelectorAll('[data-page-link]'),
  sideNavLinks: document.querySelectorAll('.side-nav a'),
  toastViewport: document.querySelector('#toastViewport'),
};
