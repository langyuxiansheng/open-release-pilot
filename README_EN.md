# Open Release Pilot

[中文](./README.md) | [English](./README_EN.md)

Open Release Pilot is a local visual release dashboard for Flutter apps. It brings project profiles, Android multi-channel package builds, iOS IPA builds, distribution-channel configuration, release records, and LAN-based install previews into one local web console.

Repository: <https://github.com/langyuxiansheng/open-release-pilot>

## Use Cases

- You maintain one or more Flutter apps and need a repeatable Android channel-package workflow.
- You want to manage iOS IPA builds, App Store Connect upload parameters, and release history in one local tool.
- You need to maintain package paths, release notes, review notes, and upload parameters for channels such as Pgyer, Huawei, Xiaomi, and Tencent App Store.
- You want a local release dashboard without deploying a remote database or backend service.

## Features

- Project management: maintain multiple Flutter/Android project roots, version files, output directories, channel lists, and package-name templates.
- Android builds: select channels, build release APKs, inspect progress/logs/output paths, stop tasks, and delete current-version channel packages.
- iOS release workflow: build IPA only, build and upload to App Store Connect, or build and prepare for TestFlight.
- Distribution management: maintain app-store settings, per-channel release notes, review notes, asset paths, and upload history.
- Local data storage: project settings, release records, and sensitive parameters are stored under local files by default. No remote database is required.
- Install preview: generate LAN install links for current Android packages so devices on the same network can test quickly.
- Theme modes: system, light, and dark.

## Screenshots

### Build Workbench

![Build Workbench](./screenshots/workbench.png)

### Distribution Management

![Distribution Management](./screenshots/distribution.png)

### Project Management

![Project Management](./screenshots/projects.png)

## Tech Stack

- Native Node.js HTTP server, no Express dependency.
- Static HTML/CSS/ES Modules frontend, no build step.
- Shell scripts for Android and iOS build execution.
- JSON files as local persistent storage.

## Requirements

| Dependency | Requirement |
| --- | --- |
| Node.js | `>= 18` |
| npm | Used only to run `npm start`; the project currently has no third-party runtime dependencies |
| Flutter | Required when building Android/iOS packages for the target app |
| Android build environment | Android SDK, Gradle, signing configuration, and related setup are provided by the target Flutter project |
| Xcode | macOS + Xcode toolchain is required for IPA builds or App Store Connect uploads |

## Quick Start

```bash
git clone https://github.com/langyuxiansheng/open-release-pilot.git
cd open-release-pilot
npm start
```

After startup, the terminal prints local access URLs, for example:

```text
Open Release Pilot: http://127.0.0.1:8787
Open Release Pilot LAN: http://192.168.1.10:8787
```

On first use, open Project Management and replace the demo project root with your real Flutter project path.

For complete setup steps, release workflows, and security precautions, see the [User Guide](./docs/USER_GUIDE_EN.md).

## Startup Commands

| Command | Description |
| --- | --- |
| `npm start` | Start the local release dashboard, equivalent to `./start.sh` |
| `npm run start:raw` | Run `node server.js` directly without port checks |
| `./start.sh --port 8788` | Start on a specific port |
| `./start.sh --status` | Check current port usage |
| `./start.sh --stop` | Stop the Open Release Pilot service on the current port |
| `./start.sh --kill-port` | Stop an old service from this project before starting when the port is occupied |

## Project Structure

```text
open-release-pilot/
├── config/
│   └── stores.example.json          # Example store config without real secrets
├── data/                            # Local runtime data, ignored by Git by default
├── docs/                            # User guides and project documentation
├── public/                          # Frontend pages, styles, and modules
├── scripts/
│   ├── build_android_channels.sh    # Android multi-channel build script
│   ├── build_ios_release.sh         # iOS IPA build script
│   └── start_panel.sh               # Local server startup script
├── server/                          # Node.js server modules
├── server.js                        # Server entry
├── start.sh                         # Root startup entry
├── package.json
└── README.md
```

## Pages

| Page | Description |
| --- | --- |
| Build Workbench | View version/output/database status, run Android/iOS builds, inspect logs, manage build processes, and preview install links |
| Distribution | Maintain app-store configuration, global release notes, per-channel notes, and upload records |
| Project Management | Maintain target project roots, version rules, output directories, naming templates, and channel lists |

## Local Data And Config Files

| File | Commit? | Description |
| --- | --- | --- |
| `config/stores.example.json` | Yes | Open-source example config with placeholder values only |
| `config/stores.local.json` | No | Optional local initialization config for private account notes, keys, package names, and similar data |
| `data/projects-db.json` | No | Project list, per-project iOS settings, and store settings |
| `data/release-db.json` | No | Version records, Android package scan snapshots, build records, and upload records |
| `data/*.log` / `data/*.tmp` | No | Local runtime logs or temporary files |

`.gitignore` already ignores local data, packages, signing files, certificates, and common secret files. Before publishing a fork or mirror, still scan the repository for real App IDs, Bundle IDs, Apple Team IDs, API keys, test accounts, phone numbers, private paths, and private release notes.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Local HTTP service port |
| `HOST` | `0.0.0.0` | Listen address; the default allows devices on the same LAN to access install-preview pages |
| `RELEASE_PROJECT_ROOT` | Empty | Target Flutter project root, higher priority than `FLUTTER_PROJECT_ROOT` |
| `FLUTTER_PROJECT_ROOT` | Empty | Target Flutter project root |
| `PROJECT_ROOT` | Empty | Compatibility variable for older target-project configuration |
| `BUILD_CHANNELS` | Empty | Used by the Android script; comma-separated channel codes, for example `PGYER,XIAOMI` |
| `ORP_ANDROID_OUTPUT_ROOT` | `~/Desktop/AndroidPackages` | Android package output root |
| `ORP_IOS_OUTPUT_ROOT` | `~/Desktop/IosPackages` | iOS IPA output root |
| `ORP_ANDROID_APK_SOURCE` | `build/app/outputs/flutter-apk/app-release.apk` | Source APK path after Flutter build |
| `ORP_APP_SLUG` | `app` | App slug used in output file names |
| `ORP_APK_NAME_TEMPLATE` | `release-{versionName}-{versionCode}-{channel}.apk` | Android APK file-name template |
| `ORP_IPA_NAME_TEMPLATE` | `{appSlug}-{versionName}-{versionCode}.ipa` | iOS IPA file-name template |
| `ORP_VERSION_NAME` | Auto-detected | Fallback version name for the iOS script |
| `ORP_VERSION_CODE` | Auto-detected | Fallback build number for the iOS script |
| `IOS_EXPORT_OPTIONS_PLIST` | `ios/AdHocExportOptions.plist` | iOS export options plist |
| `IOS_OUTPUT_DIR` | Empty | Output directory for the current iOS IPA build |

## Project Configuration

Project configuration is stored in `data/projects-db.json`. Prefer editing it from the Project Management page. If you edit the JSON manually, keep field types valid.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Unique project ID; use letters, numbers, underscores, or dashes |
| `name` | string | Project name shown in the dashboard |
| `type` | string | `flutter`, `android`, or `unknown` |
| `rootPath` | string | Target Flutter/Android project root |
| `appSlug` | string | App slug used in output file names |
| `versionFile` | string | Version file relative to `rootPath`; Flutter default is `android/local.properties` |
| `versionNamePattern` | string | Regex for extracting version name from the version file; must include the first capture group |
| `versionCodePattern` | string | Regex for extracting build number from the version file; must include the first capture group |
| `androidOutputRoot` | string | Android channel-package output root |
| `iosOutputRoot` | string | iOS IPA output root |
| `androidApkSource` | string | Source APK relative path after Flutter/Gradle build |
| `apkNameTemplate` | string | APK file-name template; supports `{appSlug}`, `{versionName}`, `{versionCode}`, `{channel}` |
| `ipaNameTemplate` | string | IPA file-name template; supports `{appSlug}`, `{versionName}`, `{versionCode}` |
| `channels` | array | Android channel list; each item contains `code`, `dir`, and `name` |
| `iosConfig` | object | iOS release configuration for the current project |
| `stores` | object | Distribution-store configuration for the current project |

Channel example:

```json
[
  { "code": "PGYER", "dir": "pgyer", "name": "Pgyer" },
  { "code": "XIAOMI", "dir": "xiaomi", "name": "Xiaomi" },
  { "code": "HUAWEI", "dir": "huawei", "name": "Huawei" }
]
```

Naming-template examples:

```text
{appSlug}-{versionName}-{versionCode}-{channel}.apk
{appSlug}-{versionName}-{versionCode}.ipa
```

## iOS Release Configuration

| Field | Description |
| --- | --- |
| `releaseTarget` | Release target: `build-only`, `app-store-connect`, or `testflight` |
| `exportOptionsPlist` | ExportOptions plist used for build-only IPA generation |
| `appStoreExportOptionsPlist` | ExportOptions plist used for App Store Connect/TestFlight upload flows |
| `outputDir` | IPA output directory; empty means `{iosOutputRoot}/{versionName}` |
| `appStoreConnectUploadTool` | Upload tool note field, default `xcrun altool` |
| `appleKeyId` | App Store Connect API Key ID |
| `appleIssuerId` | App Store Connect Issuer ID |
| `applePrivateKeyPath` | `.p8` private-key path; use a private local path |
| `bundleId` | iOS Bundle ID |
| `appAppleId` | Apple App ID |
| `teamId` | Apple Team ID |
| `testFlightBetaNote` | TestFlight beta note |
| `skipExistingIpa` | Whether to skip rebuilding when the target IPA already exists |

## Distribution Store Configuration

Store fields are defined by `STORE_FIELD_SCHEMAS` in `server/config.js`, and the frontend renders forms from that schema. The open-source example contains only placeholder values. Real secrets should stay in local config or in `data/projects-db.json` after saving from the page, and must not be committed.

| Platform | Automation | Key Fields |
| --- | --- | --- |
| Pgyer `pgyer` | API upload | `enabled`, `apiKey`, `apkPath`, `buildDescription`, `installType`, `password`, `buildUpdateDescription`, `releaseNotes` |
| Huawei `huawei` | API parameter template | `enabled`, `clientId`, `clientSecret`, `appId`, `packageName`, `apkPath`, `releaseType`, `submitForReview`, `releaseNotes` |
| Xiaomi `xiaomi` | API parameter template | `enabled`, `baseUrl`, `userName`, `publicKey`, `privateKey`, `packageName`, `apkPath`, `appName`, `privacyUrl`, `testAccountJson` |
| Tencent App Store `sjqq` | API app-info update | `enabled`, `user_id`, `access_secret`, `pkg_name`, `app_id`, `apkPath`, `feature`, `deploy_type`, `login_account` |
| Honor `honor` | Manual-upload template | `developerUrl`, `account`, `appId`, `packageName`, `apkPath`, `iconPath`, `screenshotPaths`, `privacyUrl` |
| OPPO `oppo` | Manual-upload template | `developerUrl`, `account`, `appId`, `packageName`, `apkPath`, `iconPath`, `screenshotPaths`, `privacyUrl` |
| vivo `vivo` | Manual-upload template | `developerUrl`, `account`, `appId`, `packageName`, `apkPath`, `iconPath`, `screenshotPaths`, `privacyUrl` |

Common field notes:

- `enabled`: whether to include the platform in upload/precheck flows.
- `apkPath`: local APK path, usually selected through the page file picker.
- `releaseNotes`: per-channel release notes, saved independently from global release notes.
- `auditNotes`: notes for store reviewers, such as test accounts, permission notes, or special review paths.
- `submitForReview`: whether to submit for review after upload. Keep it off until the package and API integration are verified.
- `clientSecret`, `apiKey`, `privateKey`, `access_secret`: sensitive fields that should only be stored locally.

## API Overview

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/status` | GET | Full dashboard snapshot including project, version, package scan, local database, and store config |
| `/api/projects/save` | POST | Save project configuration |
| `/api/projects/active` | POST | Switch active project |
| `/api/projects/inspect` | POST | Inspect a local path and detect Flutter/Android project metadata |
| `/api/notes` | POST | Save global release notes for the current version |
| `/api/build` | POST | Start Android channel builds |
| `/api/build/progress` | GET | Get Android build progress |
| `/api/build/events` | GET | Android build-log SSE stream |
| `/api/packages/delete` | POST | Delete selected channel packages for the current version |
| `/api/ios-config` | POST | Save iOS release configuration |
| `/api/ios-release` | POST | Start iOS build/upload flow |
| `/api/ios-release/progress` | GET | Get iOS release progress |
| `/api/ios-release/events` | GET | iOS build/upload log SSE stream |
| `/api/store-config` | POST | Save distribution-store configuration |
| `/api/upload` | POST | Run store upload or precheck |
| `/api/upload/progress` | GET | Get store upload progress |
| `/api/upload-runs/delete` | POST | Delete one upload history record |
| `/api/install-preview` | GET | Get install-preview information |
| `/api/processes` | GET | List release-related background processes |

## Android Build Flow

`scripts/build_android_channels.sh` enters the target project root, reads the version, and runs per channel:

```bash
flutter build apk --release --dart-define="TAG_CHANNEL=${CHANNEL}"
```

After each channel build completes, the source APK is copied to:

```text
{androidOutputRoot}/{versionName}/{channel.dir}/{apkNameTemplate}
```

The script supports resume-by-skip: if a target channel package already exists and is non-empty, that channel is skipped. To force rebuilding a channel, delete the target APK from the dashboard or remove it manually.

## iOS Build Flow

`scripts/build_ios_release.sh` enters the target project root, reads the version, and runs:

```bash
flutter build ipa --export-options-plist="$IOS_EXPORT_OPTIONS_PLIST"
```

After a successful build, `build/ios/ipa/*.ipa` is copied to:

```text
{iosOutputRoot}/{versionName}/{ipaNameTemplate}
```

When `releaseTarget` is `app-store-connect` or `testflight`, the server calls `xcrun altool` after the IPA exists. API keys and private keys must stay on the local machine.

## Security Notes

- Do not commit `data/*.json`, `config/stores.local.json`, `.env`, signing files, certificates, `.p8`, `.p12`, or `.mobileprovision`.
- Do not put real package names, Apple Team IDs, App Store Connect API keys, store secrets, or test account passwords in open-source examples.
- The dashboard exposes local file browsing. Run it only on trusted networks and do not expose it to the public internet.
- `HOST=0.0.0.0` is useful for LAN install previews. If you only need local access, use `HOST=127.0.0.1 npm start`.
- Keep `submitForReview` disabled until the package and API integration are verified.

## Open Source Notice

Open Release Pilot is an open-source project:

<https://github.com/langyuxiansheng/open-release-pilot>

This project is licensed under the [Apache License 2.0](./LICENSE). You may use, copy, modify, distribute, and build upon this project under the terms of the license.

Copyright (c) 2026 langyuxiansheng.
