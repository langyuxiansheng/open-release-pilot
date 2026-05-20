# Open Release Pilot 使用说明书

[中文](./USER_GUIDE.md) | [English](./USER_GUIDE_EN.md)

本文档面向第一次接入 Open Release Pilot 的开发者，重点说明从启动、项目配置、打包、上传到日常维护时需要注意的事项。项目介绍、字段索引和 API 列表可继续查看根目录 [README.md](../README.md)。

## 1. 使用前准备

在使用发布面板前，请先确认目标 Flutter 项目本身可以独立完成构建。

| 检查项 | 说明 |
| --- | --- |
| Node.js | 建议 `>= 18`，用于启动本地 Web 面板 |
| Flutter | 目标项目需要能正常执行 `flutter build apk` 或 `flutter build ipa` |
| Android 环境 | Android SDK、Gradle、签名配置、渠道读取逻辑由目标项目自行准备 |
| iOS 环境 | macOS、Xcode、证书、描述文件和 ExportOptions plist 需要在目标项目中配置好 |
| 应用市场账号 | 需要提前在各平台后台申请 API 权限、密钥、应用 ID、包名等信息 |

建议先在目标 Flutter 项目里手动跑一次：

```bash
flutter pub get
flutter build apk --release
```

iOS 发布前建议手动确认：

```bash
flutter build ipa --export-options-plist=ios/AdHocExportOptions.plist
```

如果目标项目本身无法构建，Open Release Pilot 只会把真实错误日志展示出来，不会替你修复 Flutter、Gradle、Xcode 或签名环境。

## 2. 启动发布面板

```bash
git clone https://github.com/langyuxiansheng/open-release-pilot.git
cd open-release-pilot
npm start
```

启动成功后，终端会输出本机和局域网地址：

```text
Open Release Pilot: http://127.0.0.1:8787
Open Release Pilot LAN: http://192.168.1.10:8787
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 默认启动 |
| `./start.sh --port 8788` | 指定端口启动 |
| `./start.sh --status` | 查看端口占用 |
| `./start.sh --stop` | 停止当前端口上的服务 |
| `HOST=127.0.0.1 npm start` | 只允许本机访问 |

默认 `HOST=0.0.0.0` 是为了方便手机通过局域网访问安装包预览。如果你只在电脑上使用，建议改成 `HOST=127.0.0.1`。

## 3. 首次配置项目

首次打开页面后，先进入「项目管理」。

1. 点击或编辑示例项目。
2. 把 `项目根目录` 改成你的 Flutter 项目路径。
3. 确认版本文件，Flutter 默认是 `android/local.properties`。
4. 配置 Android 输出目录和 iOS 输出目录。
5. 配置 APK / IPA 文件名模板。
6. 配置渠道列表。
7. 保存项目，再回到「打包工作台」刷新状态。

项目配置会保存到 `data/projects-db.json`。这个文件可能包含本机路径、包名、应用市场配置和密钥，默认已被 `.gitignore` 忽略，不要提交。

## 4. 版本号读取规则

默认读取：

```text
android/local.properties
```

默认匹配：

```text
flutter.versionName=1.0.0
flutter.versionCode=1
```

如果你的版本号来自 `pubspec.yaml`、`build.gradle` 或自定义文件，可以在「项目管理」里修改：

| 字段 | 说明 |
| --- | --- |
| `versionFile` | 相对项目根目录的版本文件路径 |
| `versionNamePattern` | 提取版本名的正则，第一个捕获组为结果 |
| `versionCodePattern` | 提取构建号的正则，第一个捕获组为结果 |

注意：如果版本文件不存在，页面会显示 warning，但不会阻止面板启动。真正打包前必须把版本号配置正确。

## 5. Android 打包流程

进入「打包工作台」后：

1. 勾选需要构建的渠道。
2. 点击 Android 构建按钮。
3. 面板会启动 `scripts/build_android_channels.sh`。
4. 脚本进入目标 Flutter 项目目录。
5. 每个渠道执行一次：

```bash
flutter build apk --release --dart-define="TAG_CHANNEL=${CHANNEL}"
```

构建完成后，APK 会复制到：

```text
{androidOutputRoot}/{versionName}/{channel.dir}/{apkNameTemplate}
```

例如：

```text
~/Desktop/AndroidPackages/1.0.0/xiaomi/demo_app-1.0.0-1-XIAOMI.apk
```

### 断点续打

如果目标渠道 APK 已存在且文件非空，脚本会跳过该渠道。需要强制重打时，可以在页面删除当前渠道包，或手动删除对应 APK 后重新执行。

### 渠道值接入

脚本通过 `--dart-define=TAG_CHANNEL=xxx` 传入渠道值。你的 Flutter 项目需要自己读取这个值，例如：

```dart
const channel = String.fromEnvironment('TAG_CHANNEL');
```

如果目标项目没有使用 `TAG_CHANNEL`，仍然可以构建，但包内不会体现渠道差异。

## 6. iOS 构建和上传

iOS 支持三种目标：

| 目标 | 说明 |
| --- | --- |
| 仅打包 IPA | 只执行 IPA 构建和复制 |
| 上传到 App Store Connect | 先确保 IPA 存在，再调用上传命令 |
| 上传并用于 TestFlight | 上传到 App Store Connect，等待 Apple 处理后再到后台继续配置 |

iOS 脚本会执行：

```bash
flutter build ipa --export-options-plist="$IOS_EXPORT_OPTIONS_PLIST"
```

输出路径：

```text
{iosOutputRoot}/{versionName}/{ipaNameTemplate}
```

注意：

- 证书、描述文件、Bundle ID、Team ID 和 ExportOptions plist 必须和目标项目匹配。
- `.p8` 私钥路径只应保存在本机，不要提交。
- 当前上传使用 `xcrun altool` 路径，后续如果 Apple 工具链调整，需要按本机 Xcode 版本验证。
- TestFlight 上传成功不等于自动提交审核，仍需要在 App Store Connect 后台确认处理状态。

## 7. 分发管理和应用市场配置

进入「分发管理」后，可以维护全局更新日志、各渠道发布说明、审核备注、APK 路径、素材路径和 API 密钥。

当前项目仍在持续完善中，能力状态建议按下面理解：

| 平台 | 当前状态 |
| --- | --- |
| 蒲公英 | 打包后上传流程已可用于实际发布 |
| 华为 | 已接入 API 流程，仍建议先在测试应用上验证权限和字段 |
| 小米 | 已接入自动发布相关字段和签名逻辑，仍建议先预检再真实提交 |
| 应用宝 | 主要面向已上线应用的信息/包更新，不适合新应用首发 |
| 荣耀 | 已接入 API 更新流程，提交审核开关需谨慎开启 |
| OPPO | 已接入 API 更新流程，分类、素材、联系人等字段需要按后台要求填全 |
| vivo | 已接入 API 更新流程，版本号、包名、素材和签名参数需要严格匹配 |

建议顺序：

1. 先只配置 `enabled=false`，保存基础字段。
2. 填写 APK 路径和发布说明。
3. 使用平台预检或查询按钮确认账号、包名、应用 ID。
4. 打开 `enabled`。
5. 先关闭 `submitForReview` 执行上传或更新。
6. 确认后台状态无误后，再决定是否提交审核。

## 8. 本地数据说明

| 文件 | 用途 | 是否提交 |
| --- | --- | --- |
| `config/stores.example.json` | 开源示例配置 | 可以提交 |
| `config/stores.local.json` | 本机私有初始化配置 | 不要提交 |
| `data/projects-db.json` | 项目、iOS 和应用市场配置 | 不要提交 |
| `data/release-db.json` | 版本、构建和上传记录 | 不要提交 |
| `data/*.log` | 本地日志 | 不要提交 |

如果你 fork 后要公开发布，建议执行一次敏感信息检查：

```bash
git status --short
git check-ignore -v config/stores.local.json data/projects-db.json data/release-db.json
```

也可以按你的真实包名、手机号、账号、Team ID、App ID、API Key 关键字做全文搜索。

## 9. 安全注意事项

- 不要把发布面板暴露到公网。
- 不要提交 `data/*.json`、`config/stores.local.json`、`.env`、签名文件、证书和私钥。
- 不要在 `config/stores.example.json` 中写真实密钥、真实包名或测试账号。
- 局域网安装预览会暴露安装包下载链接，只应在可信网络使用。
- 文件选择和预览接口会读取本机文件路径，只应在自己的开发机运行。
- 上传前确认 APK/IPA 版本号、包名、签名证书和渠道值。
- 开启 `submitForReview` 前，先确认平台后台的应用状态和字段要求。
- API 密钥失效、平台接口字段调整、平台审核规则变化都可能导致上传失败，需要以各平台后台最新规则为准。

## 10. 常见问题

### 页面提示版本文件不存在

说明当前项目根目录还是示例路径，或 `versionFile` 配置不对。进入「项目管理」修改项目根目录和版本文件路径。

### Android 构建成功但找不到 APK

检查 `androidApkSource` 是否等于目标项目真实输出路径。Flutter 默认通常是：

```text
build/app/outputs/flutter-apk/app-release.apk
```

如果你的项目使用 flavor、product flavors 或自定义 Gradle 输出路径，需要在项目配置里修改。

### 某个渠道被跳过

目标输出目录里已经存在非空 APK。删除对应 APK 后再重新构建。

### iOS 上传失败

优先检查 Xcode 登录状态、证书、描述文件、ExportOptions plist、Bundle ID、Team ID、API Key ID、Issuer ID 和 `.p8` 私钥路径。

### 应用市场上传失败

先看页面日志和上传记录。常见原因包括 API 权限未开通、包名不匹配、版本号重复、素材尺寸不符合、审核字段缺失、签名算法或密钥错误。

## 11. 维护建议

- 一个 Flutter App 建议对应一个项目配置，不要多个 App 共用同一套商店密钥。
- 每次发版前先更新全局更新日志，再按渠道复制或调整发布说明。
- 真实上传前先做一次本地包扫描，确认页面展示的 APK/IPA 正是要发布的文件。
- 对外开源或同步仓库前，先检查 `.gitignore` 和 `git status`。
- 平台 API 仍可能变化，建议先在测试应用或非提交审核模式下验证，再用于正式应用。

