#!/usr/bin/env bash
#
# 打包安卓安装包（按 CPU 架构拆分），产物放到 app/build/app/outputs/flutter-apk/
#
# 项目路径含中文时 Gradle 会失败，所以先把 app 同步到纯英文的临时目录打包，完成后拷回项目内的标准输出位置。
#
# 用法：scripts/build-apk.sh
# 环境变量：
#   PD_BUILD_NUMBER   基础构建号，默认当前 Unix 秒数；Flutter 的分架构包还会加上 ABI 偏移
#   PD_BUILD_DIR      临时打包目录，默认 ${TMPDIR}/pocketdesk-apk
#   GRADLE_USER_HOME  Gradle 缓存目录，默认 ~/.cache/pocketdesk-gradle（与原有缓存共用，避免重复下载）
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/app"
work="${PD_BUILD_DIR:-${TMPDIR:-/tmp}/pocketdesk-apk}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.cache/pocketdesk-gradle}"
# 不沿用 pubspec 中的开发构建号，避免新代码被 Android 判为降级。
build="${PD_BUILD_NUMBER:-$(date +%s)}"
if ! [[ "$build" =~ ^[1-9][0-9]{0,9}$ ]] || (( build > 2099996000 )); then
  echo "PD_BUILD_NUMBER 必须为 1–2099996000 的整数（预留 ABI 版本号偏移）" >&2
  exit 1
fi

# 1、同步源码到英文路径（保留上次的构建缓存）
mkdir -p "$work"
rsync -a --delete --exclude build --exclude .dart_tool --exclude android/.kotlin --exclude android/.gradle "$src/" "$work/app/"

# 2、打包；下载依赖偶尔被网络中断，失败时重试一次
cd "$work/app"
flutter build apk --release --split-per-abi --build-number "$build" || flutter build apk --release --split-per-abi --build-number "$build"

# 3、拷回项目内的标准输出位置
out="$src/build/app/outputs/flutter-apk"
mkdir -p "$out"
apks=(app-armeabi-v7a-release.apk app-arm64-v8a-release.apk app-x86_64-release.apk)
for apk in "${apks[@]}"; do
  cp "build/app/outputs/flutter-apk/$apk" "$out/$apk"
done
echo
echo "本次安装包（基础构建号 ${build}）："
for apk in "${apks[@]}"; do
  ls -lh "$out/$apk"
done
