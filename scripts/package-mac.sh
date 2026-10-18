#!/usr/bin/env bash
#
# 打包 macOS 桌面应用 PocketDesk.app（同时支持 Intel 与 Apple 芯片），产物放到 server/dist/
#
# 用法：scripts/package-mac.sh [--install]
#   --install  打包后安排后台安装并重启服务，失败时自动回退
# 环境变量：PD_BUILD_NUMBER 指定构建号；SDKROOT 可指定与编译器匹配的 macOS SDK。
# 应用图标由 App 的 1024 图标生成；版本号取 app/pubspec.yaml。
set -euo pipefail

# 使用与当前 Xcode 匹配的 SDK，避免命令行工具与 Xcode 的 SDK 混用。
export SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.3}"

root="$(cd "$(dirname "$0")/.." && pwd)"
server="$root/server"
dist="$server/dist"
app="$dist/PocketDesk.app"
version="$(sed -n 's/^version: *\([0-9.]*\).*/\1/p' "$root/app/pubspec.yaml")"
build="${PD_BUILD_NUMBER:-$(date +%s)}"
release="$version+$build"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1、两种架构分别编译后合并（窗口依赖系统网页引擎，需要开启 cgo）
cd "$server"
for arch in arm64 amd64; do
  cc="clang -arch $([ "$arch" = amd64 ] && echo x86_64 || echo arm64)"
  CGO_ENABLED=1 GOOS=darwin GOARCH=$arch CC="$cc" go build -trimpath -ldflags "-s -w -X main.version=$release" -o "$work/pocketdesk-$arch" ./cmd/pocketdesk
done

# 2、应用目录结构与信息
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
lipo -create -output "$app/Contents/MacOS/pocketdesk" "$work/pocketdesk-arm64" "$work/pocketdesk-amd64"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>com.pocketdesk.desktop</string>
	<key>CFBundleName</key><string>PocketDesk</string>
	<key>CFBundleDisplayName</key><string>PocketDesk</string>
	<key>CFBundleExecutable</key><string>pocketdesk</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$version</string>
	<key>CFBundleVersion</key><string>$build</string>
	<key>LSMinimumSystemVersion</key><string>12.3</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST

# 3、图标：由 App 的 1024 图标生成各尺寸
src="$root/app/ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png"
set_dir="$work/AppIcon.iconset"
mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s "$src" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$src" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$app/Contents/Resources/AppIcon.icns"

# 4、本机签名（未上架分发时系统要求至少有本地签名才能运行）
# 指定按应用标识识别：每次重新打包后，系统仍认得这是同一个应用，已允许的「屏幕录制」等权限不会失效
codesign --force --deep -s - -r='designated => identifier "com.pocketdesk.desktop"' "$app"
echo "已打包：${app}（版本 ${release}）"

# 5、交给独立后台任务安装，避免服务退出时连带终止安装脚本
if [ "${1:-}" = "--install" ]; then
  python3 "$root/scripts/install-mac.py" --app "$app" --background --delay 60
fi
