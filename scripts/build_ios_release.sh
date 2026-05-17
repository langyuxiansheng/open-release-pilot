#!/usr/bin/env bash
set -euo pipefail

# 本地 iOS 正式包脚本：
# 1. 只负责构建 IPA，不直接上传，方便发布面板按目标决定后续动作。
# 2. 支持断点续打：目标 IPA 已存在且非空时直接跳过，避免重复等待 Xcode 构建。

PROJECT_DIR="${RELEASE_PROJECT_ROOT:-${FLUTTER_PROJECT_ROOT:-${HOME}/Projects/flutter_app}}"
cd "$PROJECT_DIR"

trim_value() {
  printf "%s" "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:];]+$//; s/^"//; s/"$//'
}

read_xcconfig_value() {
  local file_path="$1"
  local key="$2"
  [[ -f "$file_path" ]] || return 0
  awk -F '=' -v key="$key" '$1 == key { value = $0; sub(/^[^=]*=/, "", value); } END { if (value != "") print value; }' "$file_path" | tr -d '[:space:]'
}

read_plist_value() {
  local file_path="$1"
  local key="$2"
  [[ -f "$file_path" ]] || return 0
  /usr/libexec/PlistBuddy -c "Print :${key}" "$file_path" 2>/dev/null || true
}

resolve_ios_build_variable() {
  local raw_value
  raw_value="$(trim_value "$1")"
  case "$raw_value" in
    *FLUTTER_BUILD_NAME*)
      printf "%s" "$IOS_FLUTTER_BUILD_NAME"
      ;;
    *FLUTTER_BUILD_NUMBER*)
      printf "%s" "$IOS_FLUTTER_BUILD_NUMBER"
      ;;
    *)
      printf "%s" "$raw_value"
      ;;
  esac
}

read_pbxproj_value() {
  local file_path="$1"
  local key="$2"
  [[ -f "$file_path" ]] || return 0
  awk -v key="$key" '
    index($0, key " = ") {
      value = $0;
      sub(".*" key " = ", "", value);
      sub(";.*", "", value);
      gsub("\"", "", value);
      print value;
      exit;
    }
  ' "$file_path"
}

pick_first_file() {
  local preferred="$1"
  local pattern="$2"
  if [[ -f "$preferred" ]]; then
    printf "%s" "$preferred"
    return
  fi
  [[ -d ios ]] || return 0
  find ios -path "*/Pods*" -prune -o -path "$pattern" -type f -print 2>/dev/null | head -n 1 || true
}

# iOS 脚本不直接读取 android/local.properties。
# 发布面板会在服务端按当前项目配置统一解析版本号，然后通过环境变量传进来；
# 如果用户绕过面板单独运行脚本，则依次兜底读取 iOS 工程配置和 Flutter 标准 pubspec.yaml。
VERSION_NAME="${ORP_VERSION_NAME:-}"
VERSION_CODE="${ORP_VERSION_CODE:-}"

IOS_GENERATED_XCCONFIG="ios/Flutter/Generated.xcconfig"
IOS_FLUTTER_BUILD_NAME="$(read_xcconfig_value "$IOS_GENERATED_XCCONFIG" "FLUTTER_BUILD_NAME")"
IOS_FLUTTER_BUILD_NUMBER="$(read_xcconfig_value "$IOS_GENERATED_XCCONFIG" "FLUTTER_BUILD_NUMBER")"
if [[ -z "$VERSION_NAME" && -n "$IOS_FLUTTER_BUILD_NAME" ]]; then
  VERSION_NAME="$IOS_FLUTTER_BUILD_NAME"
fi
if [[ -z "$VERSION_CODE" && -n "$IOS_FLUTTER_BUILD_NUMBER" ]]; then
  VERSION_CODE="$IOS_FLUTTER_BUILD_NUMBER"
fi

if [[ -z "$VERSION_NAME" || -z "$VERSION_CODE" ]]; then
  INFO_PLIST="$(pick_first_file "ios/Runner/Info.plist" "*/Info.plist")"
  PLIST_VERSION_NAME="$(resolve_ios_build_variable "$(read_plist_value "$INFO_PLIST" "CFBundleShortVersionString")")"
  PLIST_VERSION_CODE="$(resolve_ios_build_variable "$(read_plist_value "$INFO_PLIST" "CFBundleVersion")")"
  if [[ -z "$VERSION_NAME" && -n "$PLIST_VERSION_NAME" ]]; then
    VERSION_NAME="$PLIST_VERSION_NAME"
  fi
  if [[ -z "$VERSION_CODE" && -n "$PLIST_VERSION_CODE" ]]; then
    VERSION_CODE="$PLIST_VERSION_CODE"
  fi
fi

if [[ -z "$VERSION_NAME" || -z "$VERSION_CODE" ]]; then
  PBXPROJ_FILE="$(pick_first_file "ios/Runner.xcodeproj/project.pbxproj" "*/project.pbxproj")"
  PBX_VERSION_NAME="$(resolve_ios_build_variable "$(read_pbxproj_value "$PBXPROJ_FILE" "MARKETING_VERSION")")"
  PBX_VERSION_CODE="$(resolve_ios_build_variable "$(read_pbxproj_value "$PBXPROJ_FILE" "CURRENT_PROJECT_VERSION")")"
  if [[ -z "$VERSION_NAME" && -n "$PBX_VERSION_NAME" ]]; then
    VERSION_NAME="$PBX_VERSION_NAME"
  fi
  if [[ -z "$VERSION_CODE" && -n "$PBX_VERSION_CODE" ]]; then
    VERSION_CODE="$PBX_VERSION_CODE"
  fi
fi

if [[ -z "$VERSION_NAME" || -z "$VERSION_CODE" ]]; then
  PUBSPEC_VERSION="$(awk -F ':' '/^version:/ { value = $0; sub(/^version:[[:space:]]*/, "", value); sub(/[[:space:]]+#.*$/, "", value); print value; exit; }' pubspec.yaml 2>/dev/null | tr -d '[:space:]"')"
  if [[ "$PUBSPEC_VERSION" == *"+"* ]]; then
    VERSION_NAME="${VERSION_NAME:-${PUBSPEC_VERSION%%+*}}"
    VERSION_CODE="${VERSION_CODE:-${PUBSPEC_VERSION##*+}}"
  fi
fi
if [[ -z "$VERSION_NAME" || -z "$VERSION_CODE" ]]; then
  echo "读取 iOS 版本号失败：请通过 ORP_VERSION_NAME / ORP_VERSION_CODE 传入，或检查 ios/Flutter/Generated.xcconfig、Info.plist、project.pbxproj、pubspec.yaml。"
  exit 1
fi

EXPORT_OPTIONS_PLIST="${IOS_EXPORT_OPTIONS_PLIST:-ios/AdHocExportOptions.plist}"
OUTPUT_ROOT="${ORP_IOS_OUTPUT_ROOT:-${HOME}/Desktop/IosPackages}"
OUTPUT_DIR="${IOS_OUTPUT_DIR:-${OUTPUT_ROOT}/${VERSION_NAME}}"
APP_SLUG="${ORP_APP_SLUG:-app}"

# 不要把带花括号的默认模板直接写进 ${VAR:-default}。
# Bash 会把默认值里的第一个 } 当成参数展开结束符，导致模板被意外拼接。
if [[ -n "${ORP_IPA_NAME_TEMPLATE:-}" ]]; then
  IPA_NAME_TEMPLATE="$ORP_IPA_NAME_TEMPLATE"
else
  IPA_NAME_TEMPLATE="{appSlug}-{versionName}-{versionCode}.ipa"
fi

TARGET_IPA_NAME="${IPA_NAME_TEMPLATE//\{appSlug\}/${APP_SLUG}}"
TARGET_IPA_NAME="${TARGET_IPA_NAME//\{versionName\}/${VERSION_NAME}}"
TARGET_IPA_NAME="${TARGET_IPA_NAME//\{versionCode\}/${VERSION_CODE}}"
TARGET_IPA="${OUTPUT_DIR}/${TARGET_IPA_NAME}"

mkdir -p "$OUTPUT_DIR"

echo "开始构建 iOS IPA：${VERSION_NAME}+${VERSION_CODE}"
echo "导出配置：${EXPORT_OPTIONS_PLIST}"
echo "输出目录：${OUTPUT_DIR}"

if [[ -s "$TARGET_IPA" ]]; then
  echo "已存在 IPA，跳过构建：${TARGET_IPA}"
  exit 0
fi

flutter build ipa --export-options-plist="$EXPORT_OPTIONS_PLIST"

BUILT_IPA="$(find build/ios/ipa -maxdepth 1 -type f -name "*.ipa" -print | head -n 1)"
if [[ -z "$BUILT_IPA" || ! -f "$BUILT_IPA" ]]; then
  echo "iOS 构建结束，但没有在 build/ios/ipa 找到 IPA。"
  exit 1
fi

cp "$BUILT_IPA" "$TARGET_IPA"
echo "已输出：${TARGET_IPA}"
