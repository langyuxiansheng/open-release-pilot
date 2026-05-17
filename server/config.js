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
  apkNameTemplate: "{appSlug}-{versionName}-{versionCode}-{channel}.apk",
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
  { key: "honor", code: "HONOR", name: "荣耀", channelDir: "荣耀", uploadSupport: "manual" },
  { key: "xiaomi", code: "XIAOMI", name: "小米", channelDir: "小米", uploadSupport: "api" },
  { key: "oppo", code: "OPPO", name: "OPPO", channelDir: "oppo", uploadSupport: "manual" },
  { key: "vivo", code: "VIVO", name: "vivo", channelDir: "vivo", uploadSupport: "manual" },
  { key: "sjqq", code: "SJQQ", name: "应用宝", channelDir: "sjqq", uploadSupport: "api-update" },
];

// 每个平台都保留独立发布说明。用户可以一键从全局更新日志复制，
// 但后续编辑和保存都是各渠道自己的配置，不会被全局更新日志自动覆盖。
const STORE_RELEASE_FIELDS = [
  { key: "releaseNotes", label: "渠道发布说明", type: "release-notes", note: "独立保存到当前渠道配置；点击“引用全局更新日志”只会复制一次，不会自动同步。" },
  { key: "auditNotes", label: "审核备注", type: "textarea", note: "给审核人员看的补充说明、测试路径、特殊权限说明等。" },
];

// 多个平台暂时没有稳定自动上传接口时，共用一组人工发布配置字段。
const COMMON_MANUAL_FIELDS = [
  { key: "enabled", label: "启用", type: "checkbox", note: "只控制发布台是否纳入后续上传/预检流程，不影响构建脚本。" },
  { key: "uploadMode", label: "上传方式", type: "text", note: "manual 表示人工上传；api 表示后续接入自动上传。" },
  { key: "developerUrl", label: "开发者后台", type: "text", note: "对应平台后台地址，方便发布时跳转。" },
  { key: "account", label: "账号备注", type: "text", note: "只记录账号名或负责人，不建议填写密码。" },
  { key: "appId", label: "平台 App ID", type: "text", note: "平台后台里的应用 ID，没有就留空。" },
  { key: "appKey", label: "App Key / Client ID", type: "text", note: "平台如果提供应用级 Key 或客户端 ID，在这里记录。" },
  { key: "clientSecret", label: "Client Secret / 密钥", type: "password", note: "平台接口密钥或 Secret；没有自动接口权限时可留空。" },
  { key: "packageName", label: "包名", type: "text", note: "Android applicationId，默认 com.example.app。" },
  { key: "apkPath", label: "APK 路径", type: "text", note: "人工上传或后续接口上传时使用的本地 APK 路径。" },
  { key: "iconPath", label: "图标路径", type: "text", note: "平台要求单独上传图标时填写。" },
  { key: "screenshotPaths", label: "截图路径", type: "list", note: "商店详情页截图路径，一行一个。" },
  { key: "privacyUrl", label: "隐私政策 URL", type: "text", note: "大多数平台审核必填。" },
  { key: "scheduledReleaseTime", label: "定时上线时间", type: "text", note: "平台支持定时发布时填写；格式按平台后台要求。" },
  { key: "submitForReview", label: "上传后提交审核", type: "checkbox", note: "真实接入自动发布前建议保持关闭，先上传草稿或人工确认。" },
  ...STORE_RELEASE_FIELDS,
  { key: "note", label: "备注", type: "textarea", note: "记录接口权限、审核要求、人工上传步骤等。" },
];

// 应用宝 API 更新能力来自腾讯应用开放平台“API更新应用信息”文档。
// 该接口只支持已经成功发布上线的应用做版本/基础信息更新，不支持新应用首发；
// 因此这里保留 query / upload / update / status 四段参数，方便后续 uploader 直接按路由实现。
const SJQQ_FIELD_SCHEMAS = [
  { key: "account", label: "账号备注", type: "text", note: "只记录主账号或负责人；文档说明子账号暂不支持调用 API。" },
  { key: "enabled", label: "启用接口更新", type: "checkbox", note: "开启后才会进入后续应用宝上传/更新流程。" },
  { key: "developerUrl", label: "开发者后台", type: "text", note: "用于人工核对应用 id、包名和申请 API 发布接口权限。" },
  { key: "docsUrl", label: "接口文档", type: "text", note: "腾讯开放平台 API 更新应用信息文档地址。" },
  { key: "apiBaseUrl", label: "正式环境服务地址", type: "text", note: "文档正式环境： https://p.open.qq.com/open_file/developer_api。" },
  { key: "contentType", label: "Content-Type", type: "text", note: "文档要求无特殊说明时使用 application/x-www-form-urlencoded。" },
  { key: "signAlgorithm", label: "签名算法", type: "text", note: "除 sign 外的公共参数和业务参数按 ASCII 升序拼接后，用 access_secret 做 HmacSHA256。" },
  { key: "user_id", label: "user_id", type: "text", note: "开发者在开放平台注册后分配的 UserID；必须使用主账号。" },
  { key: "access_secret", label: "access_secret", type: "password", note: "在账户管理 - API发布接口申请开通后分配的接入密钥。" },

  { key: "querySection", label: "查询应用详情 /query_app_detail", type: "section", note: "应用更新前建议先查询详情；更新接口未变更字段不要传，或按需要参考查询结果原样传入。" },
  { key: "queryAppDetailRoute", label: "查询详情路由", type: "text", note: "POST 路由：/query_app_detail。" },
  { key: "pkg_name", label: "pkg_name 包名", type: "text", note: "请求应用详情、文件上传、应用更新、审核状态查询都需要的应用包名。" },
  { key: "app_id", label: "app_id 应用 ID", type: "text", note: "应用宝后台安卓应用管理首页中的应用 id。" },

  { key: "uploadSection", label: "获取文件上传信息 /get_file_upload_info", type: "section", note: "先拿 COS 预签名 URL 和 serial_number，再把 serial_number 传给 update_app；每天最多 100 次文件上传信息调用。" },
  { key: "fileUploadRoute", label: "文件上传信息路由", type: "text", note: "POST 路由：/get_file_upload_info。文档原文路由里有空格，这里按实际 URL 去掉空格保存。" },
  { key: "file_type", label: "file_type 默认类型", type: "text", note: "可选 img / apk / pdf / video / txt；自动上传时会按文件后缀分别传。" },
  { key: "apkPath", label: "APK 路径", type: "text", note: "本地 APK 路径；后续上传适配器会先换取预签名 URL，再上传原始文件数据。" },
  { key: "apk32Path", label: "32位/兼容包路径", type: "text", note: "需要单独上传 32 位或 32&64 位兼容包时填写。" },
  { key: "apk64Path", label: "64位包路径", type: "text", note: "需要单独上传 64 位包时填写。" },
  { key: "iconPath", label: "图标路径", type: "text", note: "512x512、200KB 以内 PNG 直角图标。" },
  { key: "screenshotPaths", label: "截图路径", type: "list", note: "4-5 张 JPG/PNG；建议 1080x1920，所有截图宽高一致，单张不超过 1M。" },
  { key: "copyrightElecCertPath", label: "电子版权证书路径", type: "text", note: "5M 以内 PDF；需要更新版权证明时上传。" },
  { key: "copyrightLicencePaths", label: "软著版权证明路径", type: "list", note: "最少 1 张最多 10 张，JPG/PNG，单张 10M 以内。" },
  { key: "softDelegationFilePaths", label: "软著转授权文件路径", type: "list", note: "软著资质包含转授权时上传，可多文件。" },
  { key: "otherCopyrightFilePaths", label: "其他版权/行业资质路径", type: "list", note: "ICP、发布承诺函、特殊行业资质等材料，可多文件。" },
  { key: "securityReportPaths", label: "安全评估材料路径", type: "list", note: "含社交、弹幕、私信、即时通信等功能时通常需要安全评估报告和安全承诺书。" },
  { key: "payPromisePath", label: "支付/提现承诺函路径", type: "text", note: "pay_type 为 2 时需要上传无支付仅提现承诺函。" },
  { key: "demoVideoPath", label: "配套设备视频路径", type: "text", note: "demo_video_flag 为 1 时需要上传 500M 以内 mp4/m4a 操作视频。" },

  { key: "updateSection", label: "应用更新 /update_app", type: "section", note: "用于提交基础信息和文件 serial_number；接口每天最多 50 次，含 APK 时建议超时时间 60 秒以上。" },
  { key: "updateAppRoute", label: "应用更新路由", type: "text", note: "POST 路由：/update_app。" },
  { key: "distribution_end", label: "distribution_end 分发终端", type: "text", note: "PC端/车载端/平板端/其他智能设备端对应 4 位二进制字符串，例如 1001；空值沿用上次选择。" },
  { key: "app_name", label: "app_name 应用名称", type: "text", note: "1 自然年最多修改 2 次；不变更则留空，修改后通常需要重新上传软著。" },
  { key: "modify_app_name_reason", label: "modify_app_name_reason 改名原因", type: "textarea", note: "仅修改应用名称时填写。" },
  { key: "category", label: "category 应用分类", type: "number", note: "软件分类示例：19 社交；31003/35002/35004 等禁止变更分类按文档约束处理。" },
  { key: "modify_category_reason", label: "modify_category_reason 改分类原因", type: "textarea", note: "仅修改应用分类时填写。" },
  { key: "operator", label: "operator 应用运营方", type: "text", note: "不变更则留空。" },
  { key: "developer", label: "developer 应用研发方", type: "text", note: "不变更则留空。" },
  { key: "introduce", label: "introduce 应用简介", type: "textarea", note: "商店详情页长简介；字符串不要包含 emoji。" },
  { key: "one_word_summary", label: "one_word_summary 一句话简介", type: "text", note: "商店短简介；字符串不要包含 emoji。" },
  { key: "age_level", label: "age_level 年龄分级", type: "number", note: "可选 3/8/12/16/18。" },
  { key: "screen_size", label: "screen_size 屏幕尺寸", type: "number", note: "0 全部，1 480*320 以上，2 640*480 以上，3 960*720 以上。" },
  { key: "language", label: "language 语言", type: "number", note: "0 中文，1 英文，2 多语言。" },
  { key: "ipv6", label: "ipv6 是否支持 IPv6", type: "number", note: "0 支持，1 不支持；文档更新接口字段名为 ipv6。" },
  { key: "device_type", label: "device_type 设备类型", type: "number", note: "0 Phone，1 Pad，2 同时支持 Phone 和 Pad。" },
  { key: "feature", label: "feature 版本特性说明", type: "textarea", note: "应用宝更新接口的版本特性说明；可从下方渠道发布说明复制整理。" },
  { key: "deploy_type", label: "deploy_type 发布类型", type: "number", note: "必填：1 审核通过后立即发布，2 定时发布。" },
  { key: "deploy_time", label: "deploy_time 定时发布时间", type: "number", note: "deploy_type 为 2 时必填，秒级时间戳，北京时间，必须晚于当前时间。" },
  { key: "icon_file_serial_number", label: "icon_file_serial_number 图标流水号", type: "text", note: "图标上传后返回的 serial_number；不变更图标则留空。" },
  { key: "snapshots_file_serial_number", label: "snapshots_file_serial_number 截图流水号", type: "text", note: "多张截图 serial_number 用竖线分隔。" },
  { key: "copyright_elec_cert_file_serial_number", label: "copyright_elec_cert_file_serial_number", type: "text", note: "电子版权证书文件上传流水号。" },
  { key: "copyright_licences_file_serial_number", label: "copyright_licences_file_serial_number", type: "text", note: "软著版权证明图片流水号，多张用竖线分隔。" },
  { key: "is_soft_delegation", label: "is_soft_delegation 是否转授权", type: "number", note: "0 否，1 是；为 1 时需补转授权相关字段。" },
  { key: "soft_delegation_file_serial_number", label: "soft_delegation_file_serial_number", type: "text", note: "转授权文件流水号，多张用竖线分隔。" },
  { key: "soft_delegation_period_type", label: "soft_delegation_period_type", type: "number", note: "0 指定有效期，1 永久有效。" },
  { key: "soft_delegation_start_time", label: "soft_delegation_start_time", type: "number", note: "转授权起始时间，秒级时间戳。" },
  { key: "soft_delegation_end_time", label: "soft_delegation_end_time", type: "number", note: "转授权结束时间，秒级时间戳。" },
  { key: "special_ind_category", label: "special_ind_category 特殊行业分类 JSON", type: "textarea", note: "按文档传 {\"checkedKeys\":[\"1-1\"],\"status\":true} 这类 JSON 字符串；不涉及则留空。" },
  { key: "other_copyright_file_serial_number", label: "other_copyright_file_serial_number", type: "text", note: "其他版权证明/行业资质文件流水号，多张用竖线分隔。" },
  { key: "security_reports_file_serial_number", label: "security_reports_file_serial_number", type: "text", note: "安全评估报告和安全承诺书流水号，多张用竖线分隔。" },
  { key: "apk32_flag", label: "apk32_flag 上传32位/兼容包", type: "number", note: "1 是，2 否；填 1 时需要 apk32_file_serial_number。" },
  { key: "apk64_flag", label: "apk64_flag 上传64位包", type: "number", note: "1 是，2 否；填 1 时需要 apk64_file_serial_number。" },
  { key: "apk32_file_serial_number", label: "apk32_file_serial_number", type: "text", note: "32 位或 32&64 位兼容包上传流水号。" },
  { key: "apk32_file_md5", label: "apk32_file_md5", type: "text", note: "上传 32 位或兼容包时必传的 MD5 值。" },
  { key: "apk64_file_serial_number", label: "apk64_file_serial_number", type: "text", note: "64 位安装包上传流水号。" },
  { key: "apk64_file_md5", label: "apk64_file_md5", type: "text", note: "上传 64 位包时必传的 MD5 值。" },
  { key: "login_flag", label: "login_flag 是否登录", type: "number", note: "1 是，2 否；为 1 时必须提供测试账号。" },
  { key: "login_account", label: "login_account 测试账号", type: "textarea", note: "格式建议：账号：xxx 密码：xxx，便于审核。" },
  { key: "pay_type", label: "pay_type 支付类型", type: "number", note: "1 无支付无提现，2 无支付仅提现，3 含支付。" },
  { key: "pay_promise_file_serial_number", label: "pay_promise_file_serial_number", type: "text", note: "pay_type 为 2 时需要该承诺函流水号。" },
  { key: "demo_video_flag", label: "demo_video_flag 是否涉及配套设备", type: "number", note: "1 是，2 否。" },
  { key: "demo_video_file_serial_number", label: "demo_video_file_serial_number", type: "text", note: "配套设备操作视频上传流水号。" },

  { key: "statusSection", label: "审核状态 /query_app_update_status", type: "section", note: "提交更新后用包名和应用 id 查询审核状态：1 审核中，2 驳回，3 通过，8 开发者主动撤销。" },
  { key: "queryUpdateStatusRoute", label: "审核状态路由", type: "text", note: "POST 路由：/query_app_update_status。文档原文有空格，这里按实际 URL 去掉空格保存。" },
  { key: "lastAuditStatus", label: "最近审核状态", type: "text", note: "后续接入真实查询接口后可写入最近一次返回的 audit_status。" },
  { key: "lastAuditReason", label: "最近审核原因", type: "textarea", note: "后续接入真实查询接口后可写入 audit_reason。" },
  ...STORE_RELEASE_FIELDS,
  { key: "note", label: "备注", type: "textarea", note: "记录接口权限状态、审核注意事项、哪些字段需要保持不变等。" },
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
    { key: "buildUpdateDescription", label: "版本更新说明", type: "textarea", note: "蒲公英 buildUpdateDescription；留空时使用该渠道发布说明或全局更新日志。" },
    { key: "oversea", label: "海外加速", type: "number", note: "蒲公英 oversea；按平台文档填写，留空使用后台默认。" },
    { key: "channelShortcut", label: "渠道短链", type: "text", note: "蒲公英 buildChannelShortcut；用于固定安装页短链。" },
    ...STORE_RELEASE_FIELDS,
  ],
  huawei: [
    { key: "enabled", label: "启用上传", type: "checkbox", note: "开启后才会进入上传流程。" },
    { key: "clientId", label: "Client ID", type: "text", note: "AppGallery Connect API 客户端 ID。" },
    { key: "clientSecret", label: "Client Secret", type: "password", note: "AppGallery Connect API 客户端密钥。" },
    { key: "appId", label: "App ID", type: "text", note: "华为 AppGallery Connect 应用 ID。" },
    { key: "packageName", label: "包名", type: "text", note: "Android applicationId。" },
    { key: "fileSuffix", label: "文件类型", type: "text", note: "通常为 apk，后续也可扩展 aab。" },
    { key: "apkPath", label: "APK/AAB 路径", type: "text", note: "AppGallery Connect 文件上传使用的本地包路径。" },
    { key: "releaseType", label: "发布类型", type: "text", note: "full / phased / scheduled / open-testing 等，按 AppGallery Connect 能力填写。" },
    { key: "releaseTime", label: "定时上线时间", type: "text", note: "定时发布时填写。" },
    { key: "phasedPercent", label: "灰度比例", type: "number", note: "分阶段发布时填写灰度比例。" },
    { key: "submitForReview", label: "上传后提交审核", type: "checkbox", note: "真实接入前建议保持关闭，先只上传草稿。" },
    ...STORE_RELEASE_FIELDS,
  ],
  xiaomi: [
    { key: "enabled", label: "启用上传", type: "checkbox", note: "开启后才会进入上传流程。" },
    { key: "baseUrl", label: "接口地址", type: "text", note: "小米开发者应用自动发布接口地址。" },
    { key: "userName", label: "userName", type: "text", note: "小米开放平台账号/接口用户名。" },
    { key: "publicKey", label: "公钥", type: "textarea", note: "小米接口分配的公钥，用于生成 SIG。" },
    { key: "privateKey", label: "privateKey", type: "password", note: "小米接口签名私钥。" },
    { key: "packageName", label: "包名", type: "text", note: "Android applicationId。" },
    { key: "synchroType", label: "同步类型", type: "number", note: "小米发布接口同步类型。" },
    { key: "apkPath", label: "APK 路径", type: "text", note: "应用推送接口 apk 文件字段，新增和更新时必传。" },
    { key: "secondApkPath", label: "第二 APK 路径", type: "text", note: "双包发布时使用 secondApk。" },
    { key: "appName", label: "应用名称", type: "text", note: "商店展示名称。" },
    { key: "publisherName", label: "开发者名称", type: "text", note: "小米后台开发者名称。" },
    { key: "category", label: "分类", type: "text", note: "小米后台分类标识。" },
    { key: "keyWords", label: "关键词", type: "text", note: "应用搜索关键词。" },
    { key: "desc", label: "应用描述", type: "textarea", note: "商店详情页描述。" },
    { key: "brief", label: "一句话简介", type: "text", note: "商店短简介。" },
    { key: "privacyUrl", label: "隐私政策 URL", type: "text", note: "商店审核必填。" },
    { key: "web", label: "官网 URL", type: "text", note: "应用官网或落地页。" },
    { key: "onlineTime", label: "上线时间", type: "text", note: "留空通常表示尽快上线，具体格式按小米后台要求。" },
    { key: "suitableType", label: "适龄类型", type: "number", note: "小米适龄/内容分级参数。" },
    { key: "iconPath", label: "图标路径", type: "text", note: "本地应用图标路径。" },
    { key: "screenshotPaths", label: "截图路径", type: "list", note: "本地截图路径列表。" },
    { key: "padScreenshotPaths", label: "平板截图路径", type: "list", note: "screenshot_pad_1 到 screenshot_pad_5，一行一个。" },
    { key: "testAccountJson", label: "测试账号 JSON", type: "textarea", note: "审核测试账号和说明。" },
    ...STORE_RELEASE_FIELDS,
  ],
  honor: COMMON_MANUAL_FIELDS,
  oppo: COMMON_MANUAL_FIELDS,
  vivo: COMMON_MANUAL_FIELDS,
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
