const fs = require("fs");
const path = require("path");
const {
  DATA_DIR,
  DB_FILE,
  DEFAULT_IOS_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  EXAMPLE_STORE_CONFIG,
  LOCAL_STORE_CONFIG,
  PROJECTS_DB_FILE,
} = require("./config");
const { readJsonIfExists } = require("./utils");

fs.mkdirSync(DATA_DIR, { recursive: true });

const TEMPLATE_SAMPLE_VALUES = {
  versionName: "3.5.0",
  versionCode: "68",
  channel: "XIAOMI",
  appSlug: "demo-app",
};

const TEMPLATE_ALLOWED_KEYS = new Set(Object.keys(TEMPLATE_SAMPLE_VALUES));

/**
 * 创建项目配置数据库的默认内容。
 *
 * @returns {{schemaVersion: number, activeProjectId: string, projects: object[]}} 默认项目数据库。
 */
function createDefaultProjectsDb() {
  const project = normalizeProject({
    ...DEFAULT_PROJECT_CONFIG,
    iosConfig: readInitialIosConfig(),
    stores: readInitialStoreConfig(),
  });
  return {
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
  };
}

/**
 * 读取首次迁移时的 iOS 配置。
 *
 * @returns {object} iOS 配置。
 */
function readInitialIosConfig() {
  const legacyDb = readJsonIfExists(DB_FILE, {});
  return { ...DEFAULT_IOS_CONFIG, ...(legacyDb.iosConfig || {}) };
}

/**
 * 读取项目配置数据库。
 *
 * @returns {{schemaVersion: number, activeProjectId: string, projects: object[]}} 项目数据库。
 */
function readProjectsDb() {
  if (!fs.existsSync(PROJECTS_DB_FILE)) {
    const initialDb = createDefaultProjectsDb();
    writeProjectsDb(initialDb);
    return initialDb;
  }
  const db = readJsonIfExists(PROJECTS_DB_FILE, createDefaultProjectsDb());
  const projects = Array.isArray(db.projects) && db.projects.length > 0
    ? db.projects.map(normalizeProject)
    : createDefaultProjectsDb().projects;
  const activeProjectId = projects.some((project) => project.id === db.activeProjectId)
    ? db.activeProjectId
    : projects[0].id;
  return {
    schemaVersion: 1,
    activeProjectId,
    projects,
  };
}

/**
 * 写入项目配置数据库。
 *
 * @param {object} db 项目配置数据库。
 * @returns {void}
 */
function writeProjectsDb(db) {
  const normalized = {
    schemaVersion: 1,
    activeProjectId: db.activeProjectId,
    projects: db.projects.map(normalizeProject),
  };
  const tmpFile = `${PROJECTS_DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(tmpFile, PROJECTS_DB_FILE);
}

/**
 * 获取当前激活项目。
 *
 * @returns {object} 当前项目配置。
 */
function getActiveProject() {
  const db = readProjectsDb();
  return db.projects.find((project) => project.id === db.activeProjectId) || db.projects[0];
}

/**
 * 获取前端项目管理上下文。
 *
 * @returns {{path: string, activeProjectId: string, projects: object[], requiredFields: object[]}} 项目配置上下文。
 */
function getProjectContext() {
  const db = readProjectsDb();
  return {
    path: PROJECTS_DB_FILE,
    activeProjectId: db.activeProjectId,
    projects: db.projects,
    requiredFields: [
      { key: "name", label: "项目名称", note: "发布面板里展示的名称。" },
      { key: "rootPath", label: "项目根目录", note: "必须存在；Flutter 项目通常包含 pubspec.yaml，Android 项目通常包含 settings.gradle 或 build.gradle。" },
      { key: "versionFile", label: "版本文件", note: "Flutter 默认 android/local.properties；Android 原生项目可用 app/build.gradle。" },
      { key: "appSlug", label: "应用短名", note: "用于 IPA 文件名，例如 demo_app-3.5.0-68.ipa。" },
      { key: "androidOutputRoot", label: "Android 输出根目录", note: "可以不存在；打包脚本输出时会自动创建 <根目录>/<版本号>/<渠道目录>。" },
      { key: "iosOutputRoot", label: "iOS 输出根目录", note: "可以不存在；iOS 打包脚本输出时会自动创建 <根目录>/<版本号>。" },
      { key: "channels", label: "渠道列表", note: "每行 CODE=目录=显示名，例如 XIAOMI=小米=小米。" },
    ],
  };
}

/**
 * 设置当前激活项目。
 *
 * @param {string} projectId 项目 id。
 * @returns {object} 更新后的项目上下文。
 */
function setActiveProject(projectId) {
  const db = readProjectsDb();
  if (!db.projects.some((project) => project.id === projectId)) {
    throw new Error("项目不存在，无法切换。");
  }
  db.activeProjectId = projectId;
  writeProjectsDb(db);
  return getProjectContext();
}

/**
 * 保存或新增项目配置。
 *
 * @param {object} project 前端提交的项目配置。
 * @returns {object} 更新后的项目上下文。
 */
function saveProject(project) {
  const db = readProjectsDb();
  const index = db.projects.findIndex((item) => item.id === sanitizeProjectId(project.id || project.name));
  const base = index >= 0 ? db.projects[index] : {};
  const normalized = normalizeProject({
    ...base,
    ...project,
    iosConfig: project.iosConfig || base.iosConfig,
    stores: project.stores || base.stores,
  });
  validateProject(normalized);
  if (index >= 0) db.projects[index] = { ...db.projects[index], ...normalized };
  else db.projects.push(normalized);
  db.activeProjectId = normalized.id;
  writeProjectsDb(db);
  return getProjectContext();
}

/**
 * 校验项目配置是否足够用于 Flutter 打包和扫描。
 *
 * @param {object} project 项目配置。
 * @returns {void}
 */
function validateProject(project) {
  if (!project.name) throw new Error("项目名称不能为空。");
  if (!project.rootPath || !fs.existsSync(project.rootPath)) throw new Error("项目根目录不存在。");
  if (!fs.statSync(project.rootPath).isDirectory()) throw new Error("项目根目录必须是文件夹。");
  if (!fs.existsSync(path.join(project.rootPath, project.versionFile))) throw new Error("版本文件不存在，请检查 versionFile。");
  if (!project.channels.length) throw new Error("至少需要配置一个 Android 渠道。");
  validateFileNameTemplate("APK 命名模板", project.apkNameTemplate, {
    extension: ".apk",
  });
  validateFileNameTemplate("IPA 命名模板", project.ipaNameTemplate, {
    extension: ".ipa",
  });
}

/**
 * 校验安装包命名模板是否能稳定渲染为文件名。
 *
 * 模板变量是可选能力，不是必填约束；目录结构已经按版本和渠道拆分，文件名可以
 * 完全由用户决定。这里仅拦截无法渲染或会越过输出目录边界的模板。
 *
 * @param {string} label 模板字段名称。
 * @param {string} template 用户填写的模板。
 * @param {{extension: string}} options 校验规则。
 * @returns {void}
 */
function validateFileNameTemplate(label, template, options) {
  const value = String(template || "").trim();
  if (!value) throw new Error(`${label}不能为空。`);
  if (!value.endsWith(options.extension)) throw new Error(`${label}必须以 ${options.extension} 结尾。`);
  if (value.includes("/") || value.includes("\\")) throw new Error(`${label}只能是文件名，不能包含路径分隔符。`);

  const tokens = [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const unknownToken = tokens.find((token) => !TEMPLATE_ALLOWED_KEYS.has(token));
  if (unknownToken) throw new Error(`${label}使用了不支持的变量：{${unknownToken}}。`);

  const rendered = renderFileNameTemplate(value, TEMPLATE_SAMPLE_VALUES);
  if (rendered.includes("{") || rendered.includes("}")) throw new Error(`${label}仍有未替换变量，请检查花括号。`);
  if (!rendered || rendered === options.extension) throw new Error(`${label}渲染结果无效。`);
}

/**
 * 用样例值渲染命名模板，供服务端保存前校验使用。
 *
 * @param {string} template 模板文本。
 * @param {Record<string, string>} values 样例变量。
 * @returns {string} 渲染结果。
 */
function renderFileNameTemplate(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

/**
 * 识别本机项目目录并生成可回填的项目配置。
 *
 * @param {string} inputPath 用户选择或输入的项目根目录。
 * @returns {{ok: boolean, path: string, type: string, project: object, detected: object, warnings: string[]}} 识别结果。
 */
function inspectProjectPath(inputPath) {
  const rootPath = path.resolve(String(inputPath || "").trim());
  if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error("项目根目录不存在，无法识别。");
  }

  const pubspecPath = path.join(rootPath, "pubspec.yaml");
  const androidLocalProperties = path.join(rootPath, "android/local.properties");
  const appBuildGradle = findFirstExisting(rootPath, ["app/build.gradle", "app/build.gradle.kts", "build.gradle", "build.gradle.kts"]);
  const settingsGradle = findFirstExisting(rootPath, ["settings.gradle", "settings.gradle.kts"]);
  const isFlutter = fs.existsSync(pubspecPath);
  const isAndroid = Boolean(settingsGradle || appBuildGradle || fs.existsSync(path.join(rootPath, "android")));
  const type = isFlutter ? "flutter" : isAndroid ? "android" : "unknown";
  const warnings = [];
  if (type === "unknown") warnings.push("未识别到 Flutter 或 Android Gradle 项目标识，请确认项目根目录是否正确。");

  const pubspecInfo = isFlutter ? parsePubspec(pubspecPath) : {};
  const gradleInfo = appBuildGradle ? parseGradleFile(appBuildGradle) : {};
  const projectName = pubspecInfo.name || parseSettingsName(settingsGradle) || path.basename(rootPath);
  const versionFile = fs.existsSync(androidLocalProperties)
    ? "android/local.properties"
    : appBuildGradle
      ? path.relative(rootPath, appBuildGradle)
      : DEFAULT_PROJECT_CONFIG.versionFile;
  const versionPatterns = getVersionPatterns(versionFile);
  const project = normalizeProject({
    id: sanitizeProjectId(projectName),
    name: projectName,
    type,
    rootPath,
    appSlug: sanitizeProjectId(projectName),
    versionFile,
    versionNamePattern: versionPatterns.versionNamePattern,
    versionCodePattern: versionPatterns.versionCodePattern,
    androidApkSource: isFlutter ? DEFAULT_PROJECT_CONFIG.androidApkSource : "app/build/outputs/apk/release/app-release.apk",
    ipaNameTemplate: isFlutter ? DEFAULT_PROJECT_CONFIG.ipaNameTemplate : "{appSlug}-{versionName}-{versionCode}.ipa",
  });

  return {
    ok: true,
    path: rootPath,
    type,
    project,
    detected: {
      pubspec: fs.existsSync(pubspecPath),
      androidLocalProperties: fs.existsSync(androidLocalProperties),
      settingsGradle: Boolean(settingsGradle),
      gradleFile: appBuildGradle ? path.relative(rootPath, appBuildGradle) : "",
      pubspecName: pubspecInfo.name || "",
      pubspecVersion: pubspecInfo.version || "",
      gradleApplicationId: gradleInfo.applicationId || gradleInfo.namespace || "",
      gradleVersionName: gradleInfo.versionName || "",
      gradleVersionCode: gradleInfo.versionCode || "",
    },
    warnings,
  };
}

/**
 * 浏览本机目录，供前端路径/文件选择器使用。
 *
 * @param {string} inputPath 当前目录路径。
 * @param {{includeFiles?: boolean, extensions?: string[]}} [options={}] 浏览选项。
 * @returns {{path: string, parentPath: string, entries: object[]}} 目录和可选文件列表。
 */
function listLocalDirectories(inputPath, options = {}) {
  const fallback = process.env.HOME || "/";
  const targetPath = path.resolve(String(inputPath || fallback));
  const currentPath = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
    ? targetPath
    : fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()
      ? path.dirname(targetPath)
      : fallback;
  const parentPath = path.dirname(currentPath);
  const extensions = new Set((options.extensions || []).map((ext) => String(ext).trim().toLowerCase()).filter(Boolean));
  const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      if (!options.includeFiles || !entry.isFile()) return false;
      if (extensions.size === 0) return true;
      return extensions.has(path.extname(entry.name).toLowerCase());
    })
    .map((entry) => {
      const fullPath = path.join(currentPath, entry.name);
      return {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? "directory" : "file",
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
  return { path: currentPath, parentPath, entries };
}

/**
 * 读取可在前端预览的本机图片文件。
 *
 * 这个接口只服务发布配置里的图标/截图预览，因此严格限制后缀；
 * 其它任意文件路径仍然只能在文件选择器中显示路径，不能通过浏览器读取内容。
 *
 * @param {string} inputPath 图片文件路径。
 * @returns {{path: string, contentType: string, stream: import("fs").ReadStream}} 图片流信息。
 */
function openLocalImagePreview(inputPath) {
  const filePath = path.resolve(String(inputPath || "").trim());
  const imageTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const ext = path.extname(filePath).toLowerCase();
  if (!imageTypes[ext]) throw new Error("只支持预览 png、jpg、jpeg、webp、gif 图片。");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error("图片文件不存在。");
  return {
    path: filePath,
    contentType: imageTypes[ext],
    stream: fs.createReadStream(filePath),
  };
}

/**
 * 删除项目配置。
 *
 * @param {string} projectId 项目 id。
 * @returns {object} 更新后的项目上下文。
 */
function deleteProject(projectId) {
  const db = readProjectsDb();
  if (db.projects.length <= 1) throw new Error("至少需要保留一个项目。");
  db.projects = db.projects.filter((project) => project.id !== projectId);
  if (!db.projects.some((project) => project.id === db.activeProjectId)) {
    db.activeProjectId = db.projects[0].id;
  }
  writeProjectsDb(db);
  return getProjectContext();
}

/**
 * 写入当前项目的 iOS 发布配置。
 *
 * @param {object} config iOS 配置。
 * @returns {object} 合并后的 iOS 配置。
 */
function writeActiveProjectIosConfig(config) {
  const project = getActiveProject();
  return updateActiveProject((current) => ({
    ...current,
    iosConfig: { ...DEFAULT_IOS_CONFIG, ...(current.iosConfig || {}), ...config },
  })).projects.find((item) => item.id === project.id).iosConfig;
}

/**
 * 写入当前项目的商店发布配置。
 *
 * @param {object} stores 商店配置。
 * @returns {object} 写入后的商店配置。
 */
function writeActiveProjectStores(stores) {
  const project = getActiveProject();
  return updateActiveProject((current) => ({
    ...current,
    stores,
  })).projects.find((item) => item.id === project.id).stores;
}

/**
 * 更新当前项目。
 *
 * @param {(project: object) => object} updater 项目更新函数。
 * @returns {object} 更新后的项目数据库。
 */
function updateActiveProject(updater) {
  const db = readProjectsDb();
  db.projects = db.projects.map((project) => project.id === db.activeProjectId ? normalizeProject(updater(project)) : project);
  writeProjectsDb(db);
  return readProjectsDb();
}

/**
 * 规范化项目配置，补齐默认值并清理不合法字段。
 *
 * @param {object} project 原始项目配置。
 * @returns {object} 规范化后的项目配置。
 */
function normalizeProject(project = {}) {
  const id = sanitizeProjectId(project.id || project.name || DEFAULT_PROJECT_CONFIG.id);
  const rootPath = path.resolve(project.rootPath || DEFAULT_PROJECT_CONFIG.rootPath);
  return {
    ...DEFAULT_PROJECT_CONFIG,
    ...project,
    id,
    name: String(project.name || id).trim(),
    type: project.type || "flutter",
    rootPath,
    appSlug: sanitizeProjectId(project.appSlug || project.name || id),
    versionFile: project.versionFile || DEFAULT_PROJECT_CONFIG.versionFile,
    androidOutputRoot: project.androidOutputRoot || DEFAULT_PROJECT_CONFIG.androidOutputRoot,
    iosOutputRoot: project.iosOutputRoot || DEFAULT_PROJECT_CONFIG.iosOutputRoot,
    androidApkSource: project.androidApkSource || DEFAULT_PROJECT_CONFIG.androidApkSource,
    apkNameTemplate: project.apkNameTemplate || DEFAULT_PROJECT_CONFIG.apkNameTemplate,
    ipaNameTemplate: project.ipaNameTemplate || DEFAULT_PROJECT_CONFIG.ipaNameTemplate,
    channels: normalizeChannels(project.channels || DEFAULT_PROJECT_CONFIG.channels),
    iosConfig: { ...DEFAULT_IOS_CONFIG, ...(project.iosConfig || {}) },
    stores: project.stores || readInitialStoreConfig(),
  };
}

/**
 * 查找第一个存在的相对路径。
 *
 * @param {string} rootPath 根目录。
 * @param {string[]} candidates 候选相对路径。
 * @returns {string} 存在的绝对路径，不存在时返回空字符串。
 */
function findFirstExisting(rootPath, candidates) {
  return candidates.map((candidate) => path.join(rootPath, candidate)).find((candidatePath) => fs.existsSync(candidatePath)) || "";
}

/**
 * 解析 pubspec.yaml 的 name 和 version。
 *
 * @param {string} filePath pubspec.yaml 路径。
 * @returns {{name?: string, version?: string}} 基础信息。
 */
function parsePubspec(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return {
    name: text.match(/^name:\s*["']?([^"'\s#]+)["']?/m)?.[1],
    version: text.match(/^version:\s*["']?([^"'\s#]+)["']?/m)?.[1],
  };
}

/**
 * 解析 Gradle 配置中的包名和版本号。
 *
 * @param {string} filePath build.gradle 或 build.gradle.kts 路径。
 * @returns {{namespace?: string, applicationId?: string, versionName?: string, versionCode?: string}} Gradle 信息。
 */
function parseGradleFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return {
    namespace: text.match(/namespace\s*[= ]\s*["']([^"']+)["']/)?.[1],
    applicationId: text.match(/applicationId\s*[= ]\s*["']([^"']+)["']/)?.[1],
    versionName: text.match(/versionName\s*[= ]\s*["']([^"']+)["']/)?.[1],
    versionCode: text.match(/versionCode\s*[= ]\s*(\d+)/)?.[1],
  };
}

/**
 * 从 settings.gradle 读取 rootProject.name。
 *
 * @param {string} filePath settings.gradle 路径。
 * @returns {string} 项目名。
 */
function parseSettingsName(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const text = fs.readFileSync(filePath, "utf8");
  return text.match(/rootProject\.name\s*=\s*["']([^"']+)["']/)?.[1] || "";
}

/**
 * 根据版本文件选择默认版本匹配规则。
 *
 * @param {string} versionFile 版本文件相对路径。
 * @returns {{versionNamePattern: string, versionCodePattern: string}} 匹配规则。
 */
function getVersionPatterns(versionFile) {
  if (/build\.gradle(\.kts)?$/.test(versionFile)) {
    return {
      versionNamePattern: "versionName\\s*[= ]\\s*[\"']([^\"']+)[\"']",
      versionCodePattern: "versionCode\\s*[= ]\\s*(\\d+)",
    };
  }
  return {
    versionNamePattern: DEFAULT_PROJECT_CONFIG.versionNamePattern,
    versionCodePattern: DEFAULT_PROJECT_CONFIG.versionCodePattern,
  };
}

/**
 * 规范化渠道列表。
 *
 * @param {unknown} channels 渠道数组。
 * @returns {object[]} 合法渠道列表。
 */
function normalizeChannels(channels) {
  return (Array.isArray(channels) ? channels : [])
    .map((channel) => ({
      code: String(channel.code || "").trim().toUpperCase(),
      dir: String(channel.dir || channel.code || "").trim(),
      name: String(channel.name || channel.code || "").trim(),
    }))
    .filter((channel) => channel.code && channel.dir && channel.name);
}

/**
 * 读取首次启动时的商店配置。
 *
 * @returns {object} 商店配置。
 */
function readInitialStoreConfig() {
  const source = fs.existsSync(LOCAL_STORE_CONFIG) ? LOCAL_STORE_CONFIG : EXAMPLE_STORE_CONFIG;
  return readJsonIfExists(source, {});
}

/**
 * 清理项目 id 和 appSlug。
 *
 * @param {string} value 原始值。
 * @returns {string} 可用于文件名和数据库 key 的 id。
 */
function sanitizeProjectId(value) {
  return String(value || "project")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

module.exports = {
  getActiveProject,
  getProjectContext,
  inspectProjectPath,
  listLocalDirectories,
  openLocalImagePreview,
  setActiveProject,
  saveProject,
  deleteProject,
  writeActiveProjectIosConfig,
  writeActiveProjectStores,
  normalizeChannels,
};
