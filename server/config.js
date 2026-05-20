const path = require("path");

// Open Release Pilot 是一个本机发布面板：
// 1. 扫描/管理目标 Flutter 项目的 Android APK 和 iOS IPA。
// 2. 启动本项目内的打包脚本，并通过 SSE 把日志推给前端。
// 3. 把发布配置、更新日志等本机数据写入当前项目的 data 或 config 目录。
// 目标 Flutter 项目可通过 RELEASE_PROJECT_ROOT / FLUTTER_PROJECT_ROOT 配置；
// 开源版本只提供占位默认值，真实项目路径请在面板的项目管理中配置。
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_TARGET_PROJECT_ROOT = path.join(process.env.HOME || "", "Projects/flutter_app");
const PROJECT_ROOT = path.resolve(process.env.RELEASE_PROJECT_ROOT || process.env.FLUTTER_PROJECT_ROOT || process.env.PROJECT_ROOT || DEFAULT_TARGET_PROJECT_ROOT);
const PANEL_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PANEL_ROOT, "public");
const DATA_DIR = path.join(PANEL_ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "release-db.json");
const PROJECTS_DB_FILE = path.join(DATA_DIR, "projects-db.json");
const LOCAL_STORE_CONFIG = path.join(PANEL_ROOT, "config/stores.local.json");
const EXAMPLE_STORE_CONFIG = path.join(PANEL_ROOT, "config/stores.example.json");
const ANDROID_BUILD_SCRIPT = path.join(PANEL_ROOT, "scripts/build_android_channels.sh");
const IOS_BUILD_SCRIPT = path.join(PANEL_ROOT, "scripts/build_ios_release.sh");
const DESKTOP_ANDROID_DIR = path.join(process.env.HOME || "", "Desktop/AndroidPackages");
const DESKTOP_IOS_DIR = path.join(process.env.HOME || "", "Desktop/IosPackages");

// 项目配置默认值。后续所有构建、扫描和上传都从 data/projects-db.json 读取当前项目；
// 这里仅作为首次启动时的种子配置，不把示例路径散落到各业务模块。
const DEFAULT_PROJECT_CONFIG = {
  id: "demo",
  name: "Demo Flutter App",
  type: "flutter",
  rootPath: PROJECT_ROOT,
  appSlug: "demo_app",
  versionFile: "android/local.properties",
  versionNamePattern: "^flutter\\.versionName=(.+)$",
  versionCodePattern: "^flutter\\.versionCode=(.+)$",
  androidOutputRoot: DESKTOP_ANDROID_DIR,
  iosOutputRoot: DESKTOP_IOS_DIR,
  androidApkSource: "build/app/outputs/flutter-apk/app-release.apk",
  apkNameTemplate: "release-{versionName}-{versionCode}-{channel}.apk",
  ipaNameTemplate: "{appSlug}-{versionName}-{versionCode}.ipa",
  channels: [
    { code: "PGYER", dir: "pgyer", name: "蒲公英" },
    { code: "XIAOMI", dir: "小米", name: "小米" },
    { code: "HUAWEI", dir: "华为", name: "华为" },
    { code: "SJQQ", dir: "sjqq", name: "应用宝" },
    { code: "WANDOUJIA", dir: "豌豆荚", name: "豌豆荚" },
    { code: "DEV360", dir: "360", name: "360手机助手" },
  ],
};

// iOS 发布配置默认值。真正的 Apple API Key 等敏感信息会写入本机 release-db.json，
// 不写入 Git；前端只负责展示和保存这些字段，具体构建/上传由服务端执行。
const DEFAULT_IOS_CONFIG = {
  releaseTarget: "build-only",
  exportOptionsPlist: "ios/AdHocExportOptions.plist",
  appStoreExportOptionsPlist: "ios/AppStoreExportOptions.plist",
  outputDir: "",
  appStoreConnectUploadTool: "xcrun altool",
  appleKeyId: "",
  appleIssuerId: "",
  applePrivateKeyPath: "",
  bundleId: "com.example.app",
  appAppleId: "",
  teamId: "",
  testFlightBetaNote: "",
  skipExistingIpa: true,
};

// 前端 radio 使用这个枚举。服务端根据 releaseTarget 决定只构建 IPA，
// 还是在 IPA 构建成功后继续调用 App Store Connect 上传命令。
const IOS_RELEASE_TARGETS = [
  {
    key: "build-only",
    label: "仅打包 IPA",
    actionLabel: "执行：仅打包 IPA",
    summary: "只生成当前版本 IPA，不上传到 Apple。",
    steps: ["运行 flutter build ipa", "目标 IPA 已存在时跳过重新打包", "复制 IPA 到桌面 iOS 包目录"],
  },
  {
    key: "app-store-connect",
    label: "上传到 App Store Connect",
    actionLabel: "执行：打包并上传",
    summary: "先确保 IPA 存在，再上传到 App Store Connect；不会自动提交 App Store 审核。",
    steps: ["运行 iOS 打包脚本", "目标 IPA 已存在时复用已有 IPA", "使用 xcrun altool 上传到 App Store Connect"],
  },
  {
    key: "testflight",
    label: "上传并用于 TestFlight",
    actionLabel: "执行：打包并上传 TestFlight",
    summary: "先确保 IPA 存在，再上传到 App Store Connect；Apple 处理后可在 TestFlight 中继续配置测试。",
    steps: ["运行 iOS 打包脚本", "目标 IPA 已存在时复用已有 IPA", "上传到 App Store Connect，等待 Apple 处理后进入 TestFlight"],
  },
];

// Android 打包脚本当前真正会构建的渠道列表。
// 这里必须和 scripts/build_android_channels.sh 保持一致，因为扫描包、进度和删除 APK 都依赖它。
const CHANNELS = [
  { code: "PGYER", dir: "pgyer", name: "蒲公英" },
  { code: "XIAOMI", dir: "小米", name: "小米" },
  { code: "HUAWEI", dir: "华为", name: "华为" },
  { code: "SJQQ", dir: "sjqq", name: "应用宝" },
  { code: "WANDOUJIA", dir: "豌豆荚", name: "豌豆荚" },
  { code: "DEV360", dir: "360", name: "360手机助手" },
];

// 后台进程面板只展示这些发布台相关的脚本/构建工具。
// 注意：这里不是直接用来全局 pkill 的宽泛匹配，而是结合“发布脚本进程组”做收敛。
const PROCESS_SCAN_COMMANDS = ["build_android_channels.sh", "build_ios_release.sh", "flutter build", "gradle", "xcodebuild", "altool"];

// 安卓应用商店 tabs 的平台定义。uploadSupport 表示目前面板对该平台的自动上传能力。
const STORE_PLATFORMS = [
  { key: "pgyer", code: "PGYER", name: "蒲公英", channelDir: "pgyer", uploadSupport: "api" },
  { key: "huawei", code: "HUAWEI", name: "华为", channelDir: "华为", uploadSupport: "api" },
  { key: "honor", code: "HONOR", name: "荣耀", channelDir: "荣耀", uploadSupport: "api-update" },
  { key: "xiaomi", code: "XIAOMI", name: "小米", channelDir: "小米", uploadSupport: "api" },
  { key: "oppo", code: "OPPO", name: "OPPO", channelDir: "oppo", uploadSupport: "api-update" },
  { key: "vivo", code: "VIVO", name: "vivo", channelDir: "vivo", uploadSupport: "api-update" },
  { key: "sjqq", code: "SJQQ", name: "应用宝", channelDir: "sjqq", uploadSupport: "api-update" },
];

// 每个平台都保留独立发布说明。用户可以一键从全局更新日志复制，
// 但后续编辑和保存都是各渠道自己的配置，不会被全局更新日志自动覆盖。
const STORE_RELEASE_FIELDS = [
  { key: "releaseNotes", label: "渠道发布说明", type: "release-notes", note: "独立保存到当前渠道配置；点击“引用全局更新日志”只会复制一次，不会自动同步。" },
  { key: "auditNotes", label: "审核备注", type: "textarea", note: "给审核人员看的补充说明、测试路径、特殊权限说明等。" },
];

// 应用宝 API 更新能力来自腾讯应用开放平台“API更新应用信息”文档。
// 该接口只支持已上线应用做版本/基础信息更新，不支持新应用首发。
// 前端只保留用户必须维护的字段；timestamp、sign、file_type、file_name、
// serial_number、md5、接口路由等流转字段都由 server/stores/sjqq/uploader.js 生成。
const SJQQ_FIELD_SCHEMAS = [
  { key: "enabled", label: "启用接口更新", type: "checkbox", note: "开启后才会进入后续应用宝上传/更新流程。" },
  { key: "user_id", label: "user_id", type: "text", note: "公共参数必填。开放平台主账号 UserID；应用宝文档说明子账号暂不支持调用 API。" },
  { key: "access_secret", label: "access_secret", type: "password", note: "申请 API 发布接口后分配的接入密钥；仅用于后端生成 HmacSHA256 签名，不会作为业务参数提交。" },
  { key: "pkg_name", label: "pkg_name 包名", type: "text", note: "请求应用详情、文件上传、应用更新、审核状态查询都需要的应用包名。" },
  { key: "app_id", label: "app_id 应用 ID", type: "text", note: "应用宝后台安卓应用管理首页中的应用 id。" },
  { key: "apkPath", label: "32位/兼容 APK 路径", type: "text", note: "可选。需要更新安装包时填写；后端会自动请求 /get_file_upload_info、上传 COS、生成 apk32_file_serial_number 和 MD5。" },
  { key: "apk64Path", label: "64位 APK 路径", type: "text", note: "可选。若应用宝要求单独上传 64 位包则填写；后端会自动生成 apk64_file_serial_number 和 MD5。" },
  {
    key: "deploy_type",
    label: "发布类型",
    type: "segmented",
    valueType: "number",
    note: "update_app 必填。立即发布表示审核通过后自动上线；定时发布时才显示发布时间。",
    options: [
      { label: "审核通过后立即发布", value: 1 },
      { label: "定时发布", value: 2 },
    ],
  },
  { key: "deploy_time", label: "定时发布时间", type: "number", visibleWhen: { key: "deploy_type", equals: 2 }, note: "deploy_type 为定时发布时必填，秒级时间戳，北京时间，必须晚于当前时间。" },
];

// 商店发布参数说明来自各平台公开文档和后台发布流程。这里的字段是“发布配置模板”，
// 不是所有平台都已经实现自动上传；uploadSupport 会明确标出 api/manual，避免误操作。
const STORE_FIELD_SCHEMAS = {
  pgyer: [
    { key: "enabled", label: "启用上传", type: "checkbox", note: "开启后才会进入上传流程。" },
    { key: "apiKey", label: "蒲公英 API Key", type: "password", note: "填写蒲公英后台 API 信息页里的 API Key；不是账号密码、User Key 或访问 Token。" },
    { key: "apkPath", label: "安装包路径", type: "text", note: "选择要上传到蒲公英的 APK 或 IPA；服务端会自动识别安装包类型。" },
    { key: "buildDescription", label: "应用介绍", type: "textarea", note: "蒲公英 buildDescription；应用在安装页展示的介绍。" },
    {
      key: "installType",
      label: "安装方式",
      type: "segmented",
      valueType: "number",
      note: "公开安装不需要密码；密码安装时才会显示安装密码。",
      options: [
        { label: "公开安装", value: 1 },
        { label: "密码安装", value: 2 },
        { label: "邀请安装", value: 3 },
      ],
    },
    { key: "password", label: "安装密码", type: "password", visibleWhen: { key: "installType", equals: 2 }, note: "仅安装方式为密码安装时填写。" },
    { key: "oversea", label: "海外加速", type: "number", note: "蒲公英 oversea；按平台文档填写，留空使用后台默认。" },
    { key: "channelShortcut", label: "渠道短链", type: "text", note: "蒲公英 buildChannelShortcut；用于固定安装页短链。" },
    { key: "releaseNotes", label: "渠道发布说明", type: "release-notes", note: "蒲公英 buildUpdateDescription；独立保存到蒲公英配置，留空时后端使用全局更新日志。" },
  ],
  huawei: [
    { key: "enabled", label: "启用上传", type: "checkbox", note: "开启后才会进入上传流程。" },
    { key: "apiClientJsonPath", label: "API Client JSON 路径", type: "text", note: "华为后台下载的 agc-apiclient-*.json；填写后可自动读取 Client ID / Secret。" },
    { key: "clientId", label: "Connect API Client ID", type: "text", note: "AppGallery Connect 的 Connect API 客户端 ID；不要填 OAuth Client、应用 ID 或包名。" },
    { key: "clientSecret", label: "Connect API Client Secret", type: "password", note: "与 Connect API Client ID 配套的密钥，只保存在本机项目配置数据库。" },
    { key: "developerId", label: "Developer ID", type: "text", note: "从 API Client JSON 读取，主要用于核对账号归属。" },
    { key: "appId", label: "App ID", type: "text", note: "华为 AppGallery Connect 应用 ID，不是 Android 包名。" },
    { key: "packageName", label: "包名", type: "text", note: "Android applicationId，用于人工核对包体和应用配置。" },
    { key: "apkPath", label: "APK/AAB 路径", type: "text", note: "本地安装包路径；每个渠道可单独选择不同包。" },
    { key: "fileSuffix", label: "文件后缀", type: "segmented", options: [{ label: "APK", value: "apk" }, { label: "AAB", value: "aab" }], note: "上传授权接口使用的 suffix，按实际包类型选择。" },
    { key: "fileType", label: "文件类型编码", type: "number", note: "应用包信息更新接口的 fileType。APK/AAB 通常使用 5；如后台文档调整可手动修改。" },
    { key: "lang", label: "语言", type: "text", note: "包信息更新使用的语言标识，默认 zh-CN。" },
    { key: "apiBaseUrl", label: "Connect API 地址", type: "text", note: "默认 https://connect-api.cloud.huawei.com。" },
    { key: "tokenPath", label: "Token 路径", type: "text", note: "默认 /api/oauth2/v1/token，由后端自动拼接调用。" },
    { key: "uploadUrlPath", label: "上传授权路径", type: "text", note: "默认 /api/publish/v2/upload-url，用于获取上传 URL 和 authCode。" },
    { key: "appFileInfoPath", label: "包信息更新路径", type: "text", note: "默认 /api/publish/v2/app-file-info，对应华为“应用包信息更新”接口。" },
    { key: "appInfoPath", label: "应用信息查询路径", type: "text", note: "默认 /api/publish/v2/app-info，用于执行后查询华为侧应用信息。" },
    { key: "submitPath", label: "提交审核路径", type: "text", note: "默认 /api/publish/v2/app-submit，只有打开下方开关才允许提交。" },
    { key: "submitForReview", label: "允许提交审核", type: "checkbox", note: "安全开关。关闭时“提交审核”按钮只会提示，不会真实调用华为提交接口。" },
    ...STORE_RELEASE_FIELDS,
  ],
  xiaomi: [
    { key: "enabled", label: "启用上传", type: "checkbox", note: "开启后才会进入上传流程。" },
    { key: "userName", label: "userName", type: "text", note: "小米自动发布文档要求填写开发者站登录邮箱。若填写小米数字 ID，可能查询成功但查不到已上架应用。" },
    { key: "apiPassword", label: "接口密码 password", type: "password", note: "小米自动发布接口 password；后端只用于生成 SIG，不作为明文日志输出。旧配置 privateKey 会自动兼容读取。" },
    { key: "publicKeyPath", label: "公钥证书路径", type: "text", note: "小米分配的 dev.xiaomi.api.public.cer；后端会自动从证书中提取公钥生成 SIG，不需要在前端粘贴公钥文本。" },
    { key: "packageName", label: "包名", type: "text", note: "Android applicationId。" },
    { key: "apkPath", label: "APK 路径", type: "text", note: "更新包上传使用的 APK。小米新增应用字段暂不展示，基础信息会在后端 /dev/query 后用于兜底。" },
    { key: "secondApkPath", label: "第二 APK 路径", type: "text", note: "小米官方字段 secondApk。双包上传时填写，单 APK 更新可留空。" },
    { key: "appName", label: "应用名称", type: "text", note: "小米 /dev/push 的 appInfo.appName。若 /dev/query 能返回则可保持和后台一致，否则这里手动填写。" },
    { key: "category", label: "分类", type: "xiaomi-category", valueType: "number", note: "先点击小米步骤里的“查询分类”获取官方分类列表；选择后保存配置，下次会自动回显。" },
    { key: "desc", label: "应用介绍 desc", type: "textarea", note: "官方字段 appInfo.desc，新增应用必选；当前面板主要走更新流程，留空时后端不会提交该字段。" },
    { key: "brief", label: "一句话简介 brief", type: "text", note: "官方字段 appInfo.brief，新增应用必选；当前面板主要走更新流程，留空时后端不会提交该字段，旧配置 shortDesc 会兼容读取。" },
    { key: "privacyUrl", label: "隐私政策 URL", type: "text", note: "小米 /dev/push 的 appInfo.privacyUrl，更新包也建议显式提交。" },
    { key: "iconPath", label: "icon 图标路径", type: "text", note: "本地配置保存为 iconPath；提交小米 /dev/push 时会映射为官方 multipart 文件字段 icon，并参与 SIG 里的 icon MD5。" },
    { key: "screenshotPaths", label: "手机截图路径", type: "list", note: "官方文件字段 screenshot_1 到 screenshot_5；新增应用时必填，更新包可按需要补充，一行一个。" },
    { key: "screenshotPadPaths", label: "平板截图路径", type: "list", note: "官方文件字段 screenshot_pad_1 到 screenshot_pad_5；平板应用新增时必填，更新包可按需要补充，一行一个。" },
    { key: "xiaomiTestAccountSection", label: "测试账号", type: "section", note: "这里按小米后台样式拆开填写；提交接口时后端会拼成平台要求的测试账号结构。" },
    {
      key: "testLoginType",
      label: "登录方式",
      type: "segmented",
      note: "按小米后台“测试账号”格式展示；提交时后端会拼接成 appInfo.testAccount。",
      options: [
        { label: "账号密码登录", value: "账号密码登录" },
        { label: "手机号验证码登录", value: "手机号验证码登录" },
      ],
    },
    { key: "testAccount", label: "账号", type: "text", note: "小米审核测试账号。" },
    { key: "testPassword", label: "密码", type: "password", note: "小米审核测试密码；保存到本机项目配置，不输出到日志。" },
    { key: "testRegisterCode", label: "注册/准入码", type: "text", note: "没有准入码时留空，提交给小米时会显示为 -。" },
    ...STORE_RELEASE_FIELDS,
  ],
  honor: [
    { key: "enabled", label: "启用荣耀发布", type: "checkbox", note: "开启后才会进入荣耀预检、一键上传和上传记录流程。" },
    { key: "clientId", label: "client_id", type: "text", note: "荣耀管理中心 > 开放能力 > 凭证 > API密钥 中申请的 Client_id。" },
    { key: "clientSecret", label: "client_secret", type: "password", note: "荣耀 API密钥中的秘钥，用于换取账号级 access_token，只保存在本机项目配置数据库。" },
    { key: "appId", label: "APPID", type: "text", note: "可选。留空时后端会按包名调用 get-app-id 自动查询。" },
    { key: "packageName", label: "包名 pkgName", type: "text", note: "Android applicationId；用于自动查询 APPID，并校验 APK 包名。" },
    { key: "apkPath", label: "APK 路径", type: "text", note: "荣耀 API 传包服务的 APK 文件；文档中 APK 应用包 fileType=100。" },
    { key: "languageId", label: "语言", type: "text", note: "更新多语言 newFeature 时使用，默认 zh-CN。" },
    { key: "appName", label: "应用名称", type: "text", note: "可选。更新版本说明时若留空，会尝试从 get-app-detail 继承当前语言的应用名称。" },
    { key: "intro", label: "应用介绍", type: "textarea", note: "可选。更新版本说明时若留空，会尝试从 get-app-detail 继承当前语言的应用介绍。" },
    { key: "briefIntro", label: "一句话简介", type: "text", note: "可选。荣耀字段 briefIntro；留空时不主动提交或从原语言信息继承。" },
    { key: "tokenUrl", label: "Token 地址", type: "text", note: "默认 https://iam.developer.honor.com/auth/token；JWT issuer 可能显示 hihonor.com，这是荣耀 IAM 内部域。" },
    { key: "apiBaseUrl", label: "OpenAPI 地址", type: "text", note: "默认 https://appmarket-openapi-drcn.cloud.hihonor.com；旧 honor.com 默认地址会自动兼容迁移。" },
    { key: "forceUpdate", label: "强制更新", type: "segmented", valueType: "number", options: [{ label: "非强制更新", value: 0 }, { label: "强制更新", value: 1 }], note: "submit-audit 的 forceUpdate，默认非强制更新。" },
    { key: "releaseType", label: "发布类型", type: "segmented", valueType: "number", options: [{ label: "全网发布", value: 1 }, { label: "指定时间发布", value: 2 }], note: "当前面板暂不开放分阶段发布；如需分阶段发布，后续单独做步骤配置。" },
    { key: "releaseTime", label: "指定发布时间", type: "text", visibleWhen: { key: "releaseType", equals: 2 }, note: "releaseType=指定时间发布时必填，格式 yyyy-MM-dd'T'HH:mm:ssZZ，例如 2024-01-01T01:01:01+0800。" },
    { key: "testAccount", label: "测试账号", type: "text", note: "可选。提交审核时传给荣耀审核人员。" },
    { key: "testPassword", label: "测试密码", type: "password", note: "可选。提交审核时传给荣耀审核人员。" },
    { key: "submitForReview", label: "上传后提交审核", type: "checkbox", note: "安全开关。关闭时只上传 APK 并绑定文件，不自动 submit-audit。" },
    ...STORE_RELEASE_FIELDS,
    { key: "note", label: "备注", type: "textarea", note: "记录荣耀接口权限、审核要求、人工补充步骤等。" },
  ],
  oppo: [
    { key: "enabled", label: "启用 OPPO 发布", type: "checkbox", note: "开启后才会进入 OPPO 预检、一键发布和上传记录流程。" },
    { key: "clientId", label: "client_id", type: "text", note: "OPPO 开放平台 > 管理中心 > 我的 API > 服务端应用 中分配的 client_id。" },
    { key: "clientSecret", label: "client_secret", type: "password", note: "与 client_id 配套的密钥；后端用于获取 access_token 和生成 HmacSHA256 api_sign。" },
    { key: "packageName", label: "包名 pkg_name", type: "text", note: "Android applicationId；OPPO 查询详情、发布版本和任务状态都需要。" },
    { key: "versionCode", label: "版本号 version_code", type: "text", note: "OPPO 文档中的版本号字段，通常对应 Android versionCode。" },
    { key: "apkPath", label: "APK 路径", type: "text", note: "本地 APK。后端会先获取 OPPO 一次性 upload_url/sign，再上传并生成 apk_url。" },
    { key: "cpuCode", label: "CPU 包类型", type: "segmented", valueType: "number", options: [{ label: "非多包", value: 0 }, { label: "32 位", value: 32 }, { label: "64 位", value: 64 }], note: "OPPO ApkInfo.cpu_code；普通单包使用 0。" },
    { key: "appName", label: "应用名称 app_name", type: "text", note: "OPPO 发布版本必填。" },
    { key: "secondCategoryId", label: "二级分类", type: "oppo-category-second", valueType: "number", note: "OPPO second_category_id，本地内置官方资源分类对照表，选择后会联动三级分类。" },
    { key: "thirdCategoryId", label: "三级分类", type: "oppo-category-third", valueType: "number", note: "OPPO third_category_id，必须和二级分类匹配，保存后发布接口仍按 ID 提交。" },
    { key: "summary", label: "一句话简介 summary", type: "text", note: "OPPO 要求不多于 13 个字符，不能包含标点符号和空格。" },
    { key: "detailDesc", label: "软件介绍 detail_desc", type: "textarea", note: "OPPO 发布版本必填，文档要求不少于 20 个字。" },
    { key: "privacyUrl", label: "隐私政策 URL", type: "text", note: "OPPO privacy_source_url，发布版本必填。" },
    { key: "iconPath", label: "图标文件 icon_url", type: "image-file", note: "本地 512*512 PNG，小于 1M；发布时后端会先走 OPPO 文件上传接口并回填 icon_url。" },
    { key: "screenshotPaths", label: "竖版截图 pic_url", type: "image-list", note: "本地截图 3-5 张，至少 2 张，jpg/png；建议 1080*1920，单张小于 1M。发布时会上传后用英文逗号拼成 pic_url。" },
    { key: "landscapeScreenshotPaths", label: "横版截图 landscape_pic_url", type: "image-list", note: "可选。本地横版截图 3-5 张，jpg/png；建议 1915*1080，单张小于 1M。发布时会上传后拼成 landscape_pic_url。" },
    { key: "onlineType", label: "发布类型", type: "segmented", valueType: "number", options: [{ label: "审核后立即发布", value: 1 }, { label: "定时发布", value: 2 }], note: "OPPO online_type。" },
    { key: "scheduledReleaseTime", label: "定时发布时间", type: "text", visibleWhen: { key: "onlineType", equals: 2 }, note: "online_type=2 时必填，格式 2006-01-02 15:04:05。" },
    { key: "testDesc", label: "测试附加说明 test_desc", type: "textarea", note: "OPPO 发布版本必填，最多 400 字；渠道审核备注会优先作为提交值。" },
    { key: "copyrightPath", label: "软件版权证明 copyright_url", type: "file", note: "普通应用/合作应用发布版本必填；本地文件会通过 OPPO 文件上传接口上传后回填 copyright_url。" },
    { key: "electronicCertPath", label: "电子版权证书", type: "file", note: "可选。PDF 格式文件，不能超过 20MB；上传后提交 electronic_cert_url。" },
    { key: "icpUrl", label: "ICP 备案 URL/备案号", type: "text", note: "OPPO icp_url，可选。" },
    { key: "specialPaths", label: "特殊类证书", type: "image-list", note: "可选。jpg/png 图片，每张小于 1M；上传后用英文逗号拼成 special_url。" },
    { key: "specialFilePath", label: "特殊类证书压缩包", type: "file", note: "可选。rar/zip 文件，大小不能超过 30M；上传后提交 special_file_url。" },
    { key: "businessUsername", label: "商务联系人姓名", type: "text", note: "OPPO business_username，发布版本必填。" },
    { key: "businessEmail", label: "商务联系人邮箱", type: "text", note: "OPPO business_email，发布版本必填。" },
    { key: "businessMobile", label: "商务联系人电话", type: "text", note: "OPPO business_mobile，发布版本必填。" },
    { key: "businessQq", label: "商务联系人 QQ", type: "text", note: "OPPO business_qq，可选。" },
    { key: "ageLevel", label: "年龄分级 age_level", type: "number", note: "普通应用必填，示例 3。" },
    { key: "adaptiveEquipment", label: "适配设备", type: "segmented", valueType: "number", options: [{ label: "手机", value: 4 }, { label: "平板", value: 5 }, { label: "手机和平板", value: 6 }], note: "OPPO adaptive_equipment。" },
    { key: "adaptiveType", label: "适配方式", type: "segmented", valueType: "number", options: [{ label: "横竖屏自适应", value: 1 }, { label: "平行视窗", value: 2 }], note: "OPPO adaptive_type，可选。" },
    { key: "apiBaseUrl", label: "OpenAPI 地址", type: "text", note: "默认 https://oop-openapi-cn.heytapmobi.com。" },
    ...STORE_RELEASE_FIELDS,
    { key: "note", label: "备注", type: "textarea", note: "记录 OPPO API 权限、分类 ID 来源、人工补充步骤等。" },
  ],
  vivo: [
    { key: "enabled", label: "启用 vivo 发布", type: "checkbox", note: "开启后才会进入 vivo 预检、一键更新和上传记录流程。" },
    { key: "accessKey", label: "access_key", type: "text", note: "vivo 开放平台 API 传包服务分配的 access_key。" },
    { key: "accessSecret", label: "access_secret", type: "password", note: "vivo API 传包服务密钥；后端只用于 HmacSHA256 签名，不写入日志。" },
    { key: "packageName", label: "包名 packageName", type: "text", note: "Android applicationId；查询详情、上传 APK、提交更新都需要。" },
    { key: "versionCode", label: "版本号 versionCode", type: "number", note: "app.sync.update.app 必填，必须和 APK 内版本号一致。" },
    { key: "apkPath", label: "APK 路径", type: "text", note: "本地 APK。后端会自动计算 MD5，调用 app.upload.apk.app 后拿 serialnumber。" },
    { key: "onlineType", label: "上架类型", type: "segmented", valueType: "number", options: [{ label: "实时上架", value: 1 }, { label: "定时上架", value: 2 }], note: "vivo onlineType，官方字典：1 实时上架，2 定时上架。" },
    { key: "scheOnlineTime", label: "定时上架时间", type: "text", visibleWhen: { key: "onlineType", equals: 2 }, note: "onlineType=2 时必填，格式 yyyy-MM-dd HH:mm:ss。" },
    { key: "compatibleDevice", label: "兼容设备", type: "segmented", valueType: "number", options: [{ label: "手机", value: 1 }, { label: "手机和平板", value: 2 }, { label: "平板", value: 3 }], note: "app.sync.update.app 必填，按 vivo 文档填写。" },
    // vivo 应用更新接口有大量可选资料字段。默认面板只保留更新包常用项，
    // detailDesc/mainTitle 等旧配置字段不再默认提交，避免隐藏字段继续影响发布。
    { key: "iconPath", label: "icon 图标文件", type: "image-file", note: "可选。选择本地图标后，后端会先调用 app.upload.icon 获取流水号，再提交到 app.sync.update.app 的 icon 字段。" },
    { key: "screenshotPaths", label: "截图文件", type: "image-list", note: "可选。选择 3-5 张截图后，后端会逐张调用 app.upload.screenshot，再把流水号用英文逗号拼到 screenshot 字段。" },
    { key: "apiBaseUrl", label: "OpenAPI 地址", type: "text", note: "默认 https://developer-api.vivo.com.cn/router/rest；沙箱环境可改为 https://sandbox-developer-api.vivo.com.cn/router/rest。" },
    ...STORE_RELEASE_FIELDS,
    { key: "note", label: "备注", type: "textarea", note: "记录 vivo API 权限、流水号来源、人工补充步骤等。" },
  ],
  sjqq: SJQQ_FIELD_SCHEMAS,
};

module.exports = {
  PORT,
  HOST,
  PROJECT_ROOT,
  PANEL_ROOT,
  PUBLIC_DIR,
  DATA_DIR,
  DB_FILE,
  PROJECTS_DB_FILE,
  LOCAL_STORE_CONFIG,
  EXAMPLE_STORE_CONFIG,
  ANDROID_BUILD_SCRIPT,
  IOS_BUILD_SCRIPT,
  DESKTOP_ANDROID_DIR,
  DESKTOP_IOS_DIR,
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_IOS_CONFIG,
  IOS_RELEASE_TARGETS,
  CHANNELS,
  PROCESS_SCAN_COMMANDS,
  STORE_PLATFORMS,
  STORE_FIELD_SCHEMAS,
};
