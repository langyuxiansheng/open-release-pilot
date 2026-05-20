const fs = require("fs");
const path = require("path");
const {
  DATA_DIR,
  DB_FILE,
  DEFAULT_IOS_CONFIG,
  EXAMPLE_STORE_CONFIG,
  STORE_FIELD_SCHEMAS,
  STORE_PLATFORMS,
} = require("./config");
const { readJsonIfExists, readText } = require("./utils");
const { getActiveProject, writeActiveProjectIosConfig, writeActiveProjectStores } = require("./projects");

const MAX_UPLOAD_RUNS = 200;

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 创建 release-db.json 的默认结构。
 *
 * @returns {object} 本地文件数据库的空数据结构。
 */
function createEmptyDb() {
  // schemaVersion 预留给后续本地文件数据库升级；读库时会和默认结构合并，
  // 所以旧版本 release-db.json 缺字段时不会导致页面白屏。
  return {
    schemaVersion: 1,
    versions: {},
    buildRuns: [],
    iosBuildRuns: [],
    iosUploadRuns: [],
    uploadRuns: [],
    storeStates: {},
    iosConfig: DEFAULT_IOS_CONFIG,
  };
}

/**
 * 从 android/local.properties 读取 Flutter 版本号。
 *
 * @returns {{versionName: string, versionCode: string, projectId: string, versionFile: string, warning?: string}} 当前 versionName 和 versionCode。
 */
function readVersion() {
  // 每个项目可以指定自己的版本文件和匹配规则；默认兼容 Flutter
  // android/local.properties 里的 flutter.versionName / flutter.versionCode。
  const project = getActiveProject();
  const versionFile = path.join(project.rootPath, project.versionFile);
  if (!fs.existsSync(versionFile)) {
    // 开源默认配置只是占位路径，首次启动时不应该因为缺少真实 Flutter 工程而白屏。
    // 前端会展示 warning，用户配置自己的项目后再进入正常扫描流程。
    return {
      versionName: "",
      versionCode: "",
      projectId: project.id,
      versionFile,
      warning: `版本文件不存在：${versionFile}`,
    };
  }
  const localProperties = readText(versionFile);
  const versionName = localProperties.match(new RegExp(project.versionNamePattern, "m"))?.[1]?.trim() || "";
  const versionCode = localProperties.match(new RegExp(project.versionCodePattern, "m"))?.[1]?.trim() || "";
  return {
    versionName,
    versionCode,
    projectId: project.id,
    versionFile,
    warning: versionName && versionCode ? "" : `未能从版本文件解析出完整版本号：${versionFile}`,
  };
}

/**
 * 读取本地 release-db.json，并和默认结构合并。
 *
 * @returns {object} 本地发布数据库。
 */
function readDb() {
  // 读取本地文件数据库时和默认结构合并，确保新增字段后老数据仍可用。
  // 这里不会写回磁盘，只有保存配置/扫描包/记录构建结果时才写。
  const db = readJsonIfExists(DB_FILE, createEmptyDb());
  return {
    ...createEmptyDb(),
    ...db,
    versions: db.versions || {},
    buildRuns: db.buildRuns || [],
    iosBuildRuns: db.iosBuildRuns || [],
    iosUploadRuns: db.iosUploadRuns || [],
    uploadRuns: db.uploadRuns || [],
    storeStates: db.storeStates || {},
    iosConfig: { ...DEFAULT_IOS_CONFIG, ...(db.iosConfig || {}) },
  };
}

/**
 * 写入本地 release-db.json。
 *
 * @param {object} db 需要落盘的发布数据库对象。
 * @returns {void}
 */
function writeDb(db) {
  // 使用临时文件 + rename 做原子替换，降低进程中断时写出半截 JSON 的概率。
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(db, null, 2)}\n`);
  fs.renameSync(tmpFile, DB_FILE);
}

/**
 * 生成版本记录 key。
 *
 * @param {{versionName: string, versionCode: string}} version 版本信息。
 * @returns {string} 形如 "3.5.0+68" 的版本 key。
 */
function getVersionKey(version) {
  return `${version.projectId || getActiveProject().id}:${version.versionName}+${version.versionCode}`;
}

/**
 * 确保本地数据库里存在当前版本记录。
 *
 * @param {object} db 本地发布数据库对象。
 * @param {{versionName: string, versionCode: string}} [version=readVersion()] 目标版本信息。
 * @returns {{key: string, record: object}} 版本 key 和版本记录对象。
 */
function ensureVersionRecord(db, version = readVersion()) {
  // 每个版本用 versionName+versionCode 做 key，避免同名版本但构建号不同互相覆盖。
  const key = getVersionKey(version);
  db.versions[key] ||= {
    projectId: version.projectId || getActiveProject().id,
    versionName: version.versionName,
    versionCode: version.versionCode,
    releaseNotes: "",
    packages: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { key, record: db.versions[key] };
}

/**
 * 保存当前 Android 包扫描快照到本地数据库。
 *
 * @param {object} packageInfo scanPackages 返回的包信息。
 * @returns {object} 更新后的版本记录。
 */
function savePackageSnapshot(packageInfo) {
  // 扫描包时同步更新当前版本快照。这样即使用户只刷新页面，
  // release-db.json 里也能保留最近一次看到的 APK 状态。
  const db = readDb();
  const { key, record } = ensureVersionRecord(db, packageInfo);
  record.packages = Object.fromEntries(packageInfo.packages.map((item) => [item.code, item.apk]));
  record.versionDir = packageInfo.versionDir;
  record.updatedAt = new Date().toISOString();
  db.versions[key] = record;
  writeDb(db);
  return record;
}

/**
 * 读取当前版本更新日志。
 *
 * @returns {string} 当前版本 releaseNotes。
 */
function readCurrentNotes() {
  const db = readDb();
  const { record } = ensureVersionRecord(db);
  return record.releaseNotes || "";
}

/**
 * 写入当前版本更新日志。
 *
 * @param {string} text 更新日志文本。
 * @returns {{releaseNotes: string, database: object}} 写入后的更新日志和数据库。
 */
function writeCurrentNotes(text) {
  const db = readDb();
  const { record } = ensureVersionRecord(db);
  record.releaseNotes = String(text || "");
  record.updatedAt = new Date().toISOString();
  writeDb(db);
  return { releaseNotes: record.releaseNotes, database: db };
}

/**
 * 读取 iOS 发布配置。
 *
 * @returns {object} 合并默认值后的 iOS 配置。
 */
function readIosConfig() {
  return { ...DEFAULT_IOS_CONFIG, ...(getActiveProject().iosConfig || {}) };
}

/**
 * 写入 iOS 发布配置。
 *
 * @param {object} config 前端提交的 iOS 配置局部或完整对象。
 * @returns {object} 合并默认值后的最终 iOS 配置。
 */
function writeIosConfig(config) {
  // iOS 配置包含本机密钥路径和 Apple API Key 元数据，只写入当前项目配置数据库。
  return writeActiveProjectIosConfig(config);
}

/**
 * 读取 Android 应用商店配置。
 *
 * @returns {{usingLocalConfig: boolean, path: string, localPath: string, platforms: object[], schemas: object, stores: object}} 商店配置上下文。
 */
function readStoreConfig() {
  // 商店账号和发布参数随项目保存，避免多个 Flutter App 共用同一套包名和密钥。
  const project = getActiveProject();
  const exampleStores = readJsonIfExists(EXAMPLE_STORE_CONFIG, {});
  const projectStores = project.stores || {};
  const stores = { ...exampleStores };
  Object.entries(projectStores).forEach(([key, value]) => {
    // 项目配置可能来自旧版本 schema。合并示例默认值后，
    // 新增字段会直接显示在前端，不需要用户手工编辑 JSON。
    stores[key] = { ...(exampleStores[key] || {}), ...(value || {}) };
  });
  return {
    usingLocalConfig: true,
    path: require("./config").PROJECTS_DB_FILE,
    localPath: require("./config").PROJECTS_DB_FILE,
    platforms: STORE_PLATFORMS,
    schemas: STORE_FIELD_SCHEMAS,
    states: readStoreState(),
    stores,
  };
}

/**
 * 写入本机 Android 应用商店配置。
 *
 * @param {object} stores 各平台配置值。
 * @returns {void}
 */
function writeStoreConfig(stores) {
  // 商店配置可能包含密钥，只写入 data/projects-db.json，不提交到 Git。
  writeActiveProjectStores(stores);
}

/**
 * 记录一次 Android 商店上传动作。
 *
 * 上传记录只保存执行摘要，不保存 access_secret、Apple 私钥路径等敏感参数；
 * 这样发布面板后续可以展示历史结果，同时不会把密钥写入日志或数据库历史里。
 *
 * @param {object} run 上传动作摘要。
 * @returns {object} 写入后的上传动作摘要。
 */
function recordUploadRun(run) {
  const db = readDb();
  // 上传记录只保存摘要，200 条对本地 JSON 读写仍然很轻；
  // 超出后自动保留最近记录，避免 release-db.json 长期无限增长。
  db.uploadRuns = [run, ...db.uploadRuns].slice(0, MAX_UPLOAD_RUNS);
  writeDb(db);
  return run;
}

/**
 * 删除一条 Android 商店上传记录。
 *
 * 只删除 release-db.json 里的执行摘要，不删除 APK/IPA 文件，也不改任何渠道配置。
 *
 * @param {string} runId uploadRuns 里的记录 id。
 * @returns {{ok: boolean, deleted: boolean, uploadRuns: object[], message: string}} 删除结果。
 */
function deleteUploadRun(runId) {
  const id = String(runId || "").trim();
  const db = readDb();
  const beforeCount = db.uploadRuns.length;
  db.uploadRuns = db.uploadRuns.filter((run) => run.id !== id);
  const deleted = db.uploadRuns.length !== beforeCount;
  if (deleted) writeDb(db);
  return {
    ok: deleted,
    deleted,
    uploadRuns: db.uploadRuns,
    message: deleted ? "上传记录已删除。" : "未找到要删除的上传记录。",
  };
}

/**
 * 读取当前项目的应用商店分步骤发布状态。
 *
 * 华为这类接口需要“上传包体 -> 更新包信息 -> 查询/提交”分步执行，
 * 中间产物不能让用户手填，所以写入 release-db.json 的 storeStates。
 *
 * @param {string} [storeKey] 平台 key；不传时返回当前项目全部平台状态。
 * @returns {object} 当前项目的分步骤执行状态。
 */
function readStoreState(storeKey) {
  const db = readDb();
  const projectId = getActiveProject().id;
  const projectStates = db.storeStates?.[projectId] || {};
  return storeKey ? projectStates[storeKey] || {} : projectStates;
}

/**
 * 合并写入当前项目某个应用商店的分步骤发布状态。
 *
 * 只保存必要的执行摘要和下一步所需的非密钥字段，不保存 access token、
 * clientSecret 这类敏感或短效凭据。
 *
 * @param {string} storeKey 平台 key，例如 huawei。
 * @param {object} patch 需要合并保存的状态片段。
 * @returns {object} 写入后的平台状态。
 */
function writeStoreState(storeKey, patch) {
  const db = readDb();
  const projectId = getActiveProject().id;
  db.storeStates ||= {};
  db.storeStates[projectId] ||= {};
  const previous = db.storeStates[projectId][storeKey] || {};
  db.storeStates[projectId][storeKey] = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeDb(db);
  return db.storeStates[projectId][storeKey];
}

/**
 * 清空当前项目某个应用商店的分步骤发布状态。
 *
 * 华为这类流程会把“已上传包体 fileDestUrl”等中间状态写入本地库；
 * 当用户重新执行一键流程或重新上传包体时，旧状态必须清掉，
 * 否则页面会误以为后续步骤仍然对应当前这次发布。
 *
 * @param {string} storeKey 平台 key，例如 huawei。
 * @returns {object} 清空后的平台状态，固定为空对象。
 */
function clearStoreState(storeKey) {
  const db = readDb();
  const projectId = getActiveProject().id;
  if (!db.storeStates?.[projectId]?.[storeKey]) return {};

  delete db.storeStates[projectId][storeKey];
  if (Object.keys(db.storeStates[projectId]).length === 0) {
    delete db.storeStates[projectId];
  }
  writeDb(db);
  return {};
}

module.exports = {
  createEmptyDb,
  readVersion,
  readDb,
  writeDb,
  getVersionKey,
  ensureVersionRecord,
  savePackageSnapshot,
  readCurrentNotes,
  writeCurrentNotes,
  readIosConfig,
  writeIosConfig,
  readStoreConfig,
  writeStoreConfig,
  recordUploadRun,
  deleteUploadRun,
  readStoreState,
  writeStoreState,
  clearStoreState,
};
