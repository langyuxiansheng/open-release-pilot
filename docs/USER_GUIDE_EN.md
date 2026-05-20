# Open Release Pilot User Guide

[中文](./USER_GUIDE.md) | [English](./USER_GUIDE_EN.md)

This guide is for developers who are integrating Open Release Pilot for the first time. It covers startup, project setup, builds, uploads, local data, and operational precautions. For the project overview, configuration reference, and API list, see [README_EN.md](../README_EN.md).

## 1. Before You Start

Before using the dashboard, make sure the target Flutter project can build independently.

| Check | Description |
| --- | --- |
| Node.js | `>= 18` is recommended for running the local web dashboard |
| Flutter | The target project must be able to run `flutter build apk` or `flutter build ipa` |
| Android environment | Android SDK, Gradle, signing setup, and channel logic are provided by the target project |
| iOS environment | macOS, Xcode, certificates, provisioning profiles, and ExportOptions plist must be ready in the target project |
| Store accounts | API permissions, keys, app IDs, package names, and related data must be prepared in each store console |

It is recommended to run this once inside the target Flutter project:

```bash
flutter pub get
flutter build apk --release
```

Before iOS release work, also verify:

```bash
flutter build ipa --export-options-plist=ios/AdHocExportOptions.plist
```

If the target project cannot build on its own, Open Release Pilot will only show the real build logs. It does not fix Flutter, Gradle, Xcode, signing, or certificate issues for the target app.

## 2. Start The Dashboard

```bash
git clone https://github.com/langyuxiansheng/open-release-pilot.git
cd open-release-pilot
npm start
```

After startup, the terminal prints local and LAN URLs:

```text
Open Release Pilot: http://127.0.0.1:8787
Open Release Pilot LAN: http://192.168.1.10:8787
```

Common commands:

| Command | Purpose |
| --- | --- |
| `npm start` | Start with defaults |
| `./start.sh --port 8788` | Start on a custom port |
| `./start.sh --status` | Check port usage |
| `./start.sh --stop` | Stop the service on the current port |
| `HOST=127.0.0.1 npm start` | Allow local access only |

The default `HOST=0.0.0.0` is useful for LAN install previews. If you only use the dashboard from your computer, prefer `HOST=127.0.0.1`.

## 3. First Project Setup

Open Project Management first.

1. Edit the demo project.
2. Replace `Project Root` with your Flutter project path.
3. Confirm the version file. The Flutter default is `android/local.properties`.
4. Configure Android and iOS output directories.
5. Configure APK / IPA file-name templates.
6. Configure the channel list.
7. Save the project, then return to the Build Workbench and refresh the status.

Project settings are stored in `data/projects-db.json`. This file may contain local paths, package names, store settings, and secrets. It is ignored by `.gitignore` and should not be committed.

## 4. Version Detection

Default file:

```text
android/local.properties
```

Default format:

```text
flutter.versionName=1.0.0
flutter.versionCode=1
```

If your version comes from `pubspec.yaml`, `build.gradle`, or another custom file, update these fields in Project Management:

| Field | Description |
| --- | --- |
| `versionFile` | Version file path relative to the project root |
| `versionNamePattern` | Regex for version name; the first capture group is used |
| `versionCodePattern` | Regex for build number; the first capture group is used |

If the version file does not exist, the dashboard shows a warning but still starts. Real builds require a valid version configuration.

## 5. Android Build Flow

In Build Workbench:

1. Select the channels to build.
2. Start the Android build.
3. The dashboard runs `scripts/build_android_channels.sh`.
4. The script enters the target Flutter project directory.
5. Each channel runs:

```bash
flutter build apk --release --dart-define="TAG_CHANNEL=${CHANNEL}"
```

After each build, the APK is copied to:

```text
{androidOutputRoot}/{versionName}/{channel.dir}/{apkNameTemplate}
```

Example:

```text
~/Desktop/AndroidPackages/1.0.0/xiaomi/demo_app-1.0.0-1-XIAOMI.apk
```

### Resume By Skip

If the target channel APK already exists and is non-empty, the script skips that channel. To force a rebuild, delete the target APK from the dashboard or remove the file manually.

### Channel Value Integration

The script passes the channel through `--dart-define=TAG_CHANNEL=xxx`. Your Flutter app should read it itself, for example:

```dart
const channel = String.fromEnvironment('TAG_CHANNEL');
```

If the target project does not use `TAG_CHANNEL`, builds still work, but the package content will not differ by channel.

## 6. iOS Build And Upload

iOS has three targets:

| Target | Description |
| --- | --- |
| Build IPA only | Build and copy the IPA only |
| Upload to App Store Connect | Ensure the IPA exists, then run the upload command |
| Upload for TestFlight | Upload to App Store Connect and continue TestFlight setup after Apple processing |

The iOS script runs:

```bash
flutter build ipa --export-options-plist="$IOS_EXPORT_OPTIONS_PLIST"
```

Output path:

```text
{iosOutputRoot}/{versionName}/{ipaNameTemplate}
```

Notes:

- Certificates, provisioning profiles, Bundle ID, Team ID, and ExportOptions plist must match the target project.
- `.p8` private-key paths should stay local and must not be committed.
- Upload currently uses the `xcrun altool` path. If Apple changes the Xcode toolchain, verify behavior against your local Xcode version.
- A successful TestFlight upload does not automatically submit the app for review. Confirm processing status in App Store Connect.

## 7. Distribution And Store Settings

In Distribution, you can manage global release notes, per-channel release notes, review notes, APK paths, asset paths, and API secrets.

The project is still being improved. Treat the current capability status as follows:

| Platform | Current Status |
| --- | --- |
| Pgyer | Package upload flow is ready for practical release use |
| Huawei | API flow is integrated; verify permissions and fields with a test app first |
| Xiaomi | Auto-release fields and signing logic are integrated; precheck before real submission |
| Tencent App Store | Mainly for updating already published apps; not suitable for first release of a new app |
| Honor | API update flow is integrated; enable submit-for-review carefully |
| OPPO | API update flow is integrated; category, assets, and contact fields must meet console requirements |
| vivo | API update flow is integrated; version, package name, assets, and signing parameters must match strictly |

Recommended sequence:

1. Keep `enabled=false` and save base fields first.
2. Fill APK path and release notes.
3. Use platform query or precheck actions to verify account, package name, and app ID.
4. Turn on `enabled`.
5. Keep `submitForReview` disabled for the first upload/update.
6. Confirm the store console state, then decide whether to submit for review.

## 8. Local Data

| File | Purpose | Commit? |
| --- | --- | --- |
| `config/stores.example.json` | Open-source example config | Yes |
| `config/stores.local.json` | Private local initialization config | No |
| `data/projects-db.json` | Project, iOS, and store settings | No |
| `data/release-db.json` | Version, build, and upload records | No |
| `data/*.log` | Local logs | No |

Before publishing a fork or mirror, run a quick secret check:

```bash
git status --short
git check-ignore -v config/stores.local.json data/projects-db.json data/release-db.json
```

Also search the repository for your real package names, phone numbers, accounts, Team IDs, App IDs, and API keys.

## 9. Security Notes

- Do not expose the dashboard to the public internet.
- Do not commit `data/*.json`, `config/stores.local.json`, `.env`, signing files, certificates, or private keys.
- Do not put real secrets, package names, or test accounts in `config/stores.example.json`.
- LAN install previews expose package download links, so use them only on trusted networks.
- File selection and preview APIs read local file paths, so run the dashboard only on your own development machine.
- Before uploading, confirm APK/IPA version, package name, signing certificate, and channel value.
- Before enabling `submitForReview`, confirm store-console status and required fields.
- API keys may expire, store API fields may change, and review rules may change. Always follow the latest rules in each store console.

## 10. FAQ

### The dashboard says the version file does not exist

The current project root is still the demo path, or `versionFile` is incorrect. Open Project Management and update the project root and version file path.

### Android build succeeds but the APK cannot be found

Check whether `androidApkSource` matches the real output path of the target project. Flutter commonly outputs:

```text
build/app/outputs/flutter-apk/app-release.apk
```

If your project uses flavors, product flavors, or custom Gradle outputs, update the project configuration.

### A channel is skipped

The target output directory already has a non-empty APK. Delete that APK and rebuild.

### iOS upload fails

Check Xcode account state, certificates, provisioning profiles, ExportOptions plist, Bundle ID, Team ID, API Key ID, Issuer ID, and `.p8` private-key path first.

### Store upload fails

Check dashboard logs and upload records first. Common causes include missing API permission, package-name mismatch, duplicate version number, invalid asset dimensions, missing review fields, wrong signing algorithm, or wrong secrets.

## 11. Maintenance Suggestions

- Use one project profile per Flutter app. Do not share one store-secret set across multiple apps.
- Before every release, update global release notes first, then copy or adjust per-channel notes.
- Before real upload, scan local packages once and confirm the dashboard is showing the exact APK/IPA you intend to publish.
- Before open-sourcing or syncing a repository, check `.gitignore` and `git status`.
- Store APIs can change. Verify with a test app or non-submit mode before using the flow on a production app.

