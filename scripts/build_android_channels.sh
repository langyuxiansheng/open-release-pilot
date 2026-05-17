#!/usr/bin/env bash
set -euo pipefail

# 本地安卓多渠道正式包脚本：
# 1. 通过 --dart-define=TAG_CHANNEL=xxx 把渠道值编进 Dart 代码。
# 2. 每个渠道构建完成后立即复制到桌面版本目录下对应渠道文件夹，避免下一个渠道覆盖 app-release.apk。

PROJECT_DIR="${RELEASE_PROJECT_ROOT:-${FLUTTER_PROJECT_ROOT:-${HOME}/Projects/flutter_app}}"
cd "$PROJECT_DIR"

VERSION_NAME="$(grep -E '^flutter.versionName=' android/local.properties | cut -d '=' -f 2 | tr -d '[:space:]')"
VERSION_CODE="$(grep -E '^flutter.versionCode=' android/local.properties | cut -d '=' -f 2 | tr -d '[:space:]')"
if [[ -z "$VERSION_NAME" || -z "$VERSION_CODE" ]]; then
  echo "读取 android/local.properties 里的版本号失败，请确认 flutter.versionName / flutter.versionCode 已配置。"
  exit 1
fi

OUTPUT_ROOT="${ORP_ANDROID_OUTPUT_ROOT:-${HOME}/Desktop/AndroidPackages}"
OUTPUT_DIR="${OUTPUT_ROOT}/${VERSION_NAME}"
APK_PATH="${ORP_ANDROID_APK_SOURCE:-build/app/outputs/flutter-apk/app-release.apk}"
APP_SLUG="${ORP_APP_SLUG:-app}"

# 不要把带花括号的默认模板直接写进 ${VAR:-default}。
# Bash 会把默认值里的第一个 } 当成参数展开结束符，导致模板被意外拼接成
# release-{versionName}-build.apk-{versionCode}-{channel}.apk} 这类错误值。
if [[ -n "${ORP_APK_NAME_TEMPLATE:-}" ]]; then
  APK_NAME_TEMPLATE="$ORP_APK_NAME_TEMPLATE"
else
  APK_NAME_TEMPLATE="release-{versionName}-{versionCode}-{channel}.apk"
fi

mkdir -p "$OUTPUT_DIR"

if [[ "$APK_NAME_TEMPLATE" != *.apk ]]; then
  echo "APK 命名模板配置错误：${APK_NAME_TEMPLATE}"
  echo "模板必须以 .apk 结尾，并且只能使用 {versionName}、{versionCode}、{channel}、{appSlug}。"
  exit 1
fi

# 输出目录沿用桌面旧包的分类命名：中文商店名和少量小写英文目录混用。
# 如后续新增渠道，只需要在这里补一行 “构建渠道=目录名”。
if [[ -n "${ORP_CHANNEL_DIRS:-}" ]]; then
  IFS='|' read -r -a CHANNEL_DIRS <<< "$ORP_CHANNEL_DIRS"
else
  CHANNEL_DIRS=(
    "PGYER=pgyer"
    "XIAOMI=小米"
    "HUAWEI=华为"
    "SJQQ=sjqq"
    "WANDOUJIA=豌豆荚"
    "DEV360=360"
  )
fi

# BUILD_CHANNELS 用于发布面板按勾选渠道构建，例如：BUILD_CHANNELS="PGYER,XIAOMI"。
# 未传时保持命令行脚本的旧行为：构建 CHANNEL_DIRS 里的全部渠道。
if [[ -n "${BUILD_CHANNELS:-}" ]]; then
  IFS=',' read -r -a REQUESTED_CHANNELS <<< "$BUILD_CHANNELS"
  FILTERED_CHANNEL_DIRS=()
  for CHANNEL_ITEM in "${CHANNEL_DIRS[@]}"; do
    CHANNEL="${CHANNEL_ITEM%%=*}"
    for REQUESTED_CHANNEL in "${REQUESTED_CHANNELS[@]}"; do
      REQUESTED_CHANNEL="$(echo "$REQUESTED_CHANNEL" | tr -d '[:space:]')"
      if [[ "$CHANNEL" == "$REQUESTED_CHANNEL" ]]; then
        FILTERED_CHANNEL_DIRS+=("$CHANNEL_ITEM")
        break
      fi
    done
  done
  CHANNEL_DIRS=("${FILTERED_CHANNEL_DIRS[@]}")
fi

if [[ "${#CHANNEL_DIRS[@]}" -eq 0 ]]; then
  echo "没有匹配到需要构建的渠道，请检查 BUILD_CHANNELS。"
  exit 1
fi

echo "开始构建安卓正式包：${VERSION_NAME}+${VERSION_CODE}"
echo "输出目录：${OUTPUT_DIR}"
echo "APK 命名模板：${APK_NAME_TEMPLATE}"
echo "::release-panel::android-total|${#CHANNEL_DIRS[@]}"

echo "当前版本目录下已有子文件夹："
find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort || true

CHANNEL_INDEX=0
for CHANNEL_ITEM in "${CHANNEL_DIRS[@]}"; do
  CHANNEL_INDEX=$((CHANNEL_INDEX + 1))
  CHANNEL="${CHANNEL_ITEM%%=*}"
  CHANNEL_DIR_NAME="${CHANNEL_ITEM#*=}"
  CHANNEL_OUTPUT_DIR="${OUTPUT_DIR}/${CHANNEL_DIR_NAME}"
  TARGET_APK_NAME="${APK_NAME_TEMPLATE//\{versionName\}/${VERSION_NAME}}"
  TARGET_APK_NAME="${TARGET_APK_NAME//\{versionCode\}/${VERSION_CODE}}"
  TARGET_APK_NAME="${TARGET_APK_NAME//\{channel\}/${CHANNEL}}"
  TARGET_APK_NAME="${TARGET_APK_NAME//\{appSlug\}/${APP_SLUG}}"
  if [[ "$TARGET_APK_NAME" == *"{"* || "$TARGET_APK_NAME" == *"}"* ]]; then
    echo "APK 命名模板渲染失败：${APK_NAME_TEMPLATE} -> ${TARGET_APK_NAME}"
    echo "请检查模板变量是否只使用 {versionName}、{versionCode}、{channel}、{appSlug}。"
    exit 1
  fi
  TARGET_APK="${CHANNEL_OUTPUT_DIR}/${TARGET_APK_NAME}"

  echo
  mkdir -p "$CHANNEL_OUTPUT_DIR"

  # 支持断点续打：上次中断后如果当前渠道包已经完整输出，重跑脚本时直接跳过。
  # 如需强制重打某个渠道，先删除对应目录下的 APK 再执行脚本。
  if [[ -s "$TARGET_APK" ]]; then
    echo "::release-panel::android-channel-skip|${CHANNEL}|${CHANNEL_INDEX}|${#CHANNEL_DIRS[@]}"
    echo "==> 跳过渠道：${CHANNEL}，已存在：${TARGET_APK}"
    continue
  fi

  echo "::release-panel::android-channel-start|${CHANNEL}|${CHANNEL_INDEX}|${#CHANNEL_DIRS[@]}"
  echo "==> 构建渠道：${CHANNEL}"
  flutter build apk --release --dart-define="TAG_CHANNEL=${CHANNEL}"

  if [[ ! -f "$APK_PATH" ]]; then
    echo "渠道 ${CHANNEL} 构建结束，但没有找到 APK：${APK_PATH}"
    exit 1
  fi

  cp "$APK_PATH" "$TARGET_APK"
  echo "::release-panel::android-channel-done|${CHANNEL}|${CHANNEL_INDEX}|${#CHANNEL_DIRS[@]}"
  echo "已输出：${TARGET_APK}"
done

echo
echo "::release-panel::android-all-done|${#CHANNEL_DIRS[@]}"
echo "全部渠道构建完成："
find "$OUTPUT_DIR" -mindepth 2 -maxdepth 2 -type f -name "*.apk" -print | sort
