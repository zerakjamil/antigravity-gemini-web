#!/bin/bash
set -euo pipefail

if [[ $# != 1 ]]; then
    echo "Usage: $0 OUTPUT_DIRECTORY" >&2
    exit 2
fi

launcher_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
repo_dir="$(cd -- "$launcher_dir/.." && pwd -P)"
if [[ ! -f "$repo_dir/node_modules/playwright-core/package.json" ]]; then
    echo "Run npm ci in the bridge repository before building the app." >&2
    exit 1
fi
mkdir -p -- "$1"
output_dir="$(cd -- "$1" && pwd -P)"
app_name="Gemini Web Bridge.app"
destination="$output_dir/$app_name"
if [[ -e "$destination" || -L "$destination" ]]; then
    echo "App already exists at $destination. Move it or use another output directory." >&2
    exit 1
fi

stage="$(mktemp -d "$output_dir/.gemini-web-bridge.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
app="$stage/$app_name"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
resources="$app/Contents/Resources/gemini-web-bridge"
mkdir -p "$resources/node_modules"
cp "$repo_dir"/{browser-login,browser,desktop,server,tls,verify-web}.mjs "$resources/"
cp -R "$repo_dir/node_modules/playwright-core" "$resources/node_modules/"

host_arch="$(uname -m)"
xcrun swiftc -swift-version 6 -target "${host_arch}-apple-macosx14.0" \
    -module-cache-path "$stage/module-cache" -O -framework AppKit "$launcher_dir/main.swift" \
    -o "$app/Contents/MacOS/GeminiWebBridge"
plist="$app/Contents/Info.plist"
plutil -create xml1 "$plist"
plutil -insert CFBundleIdentifier -string 'local.gemini-web-bridge.launcher' "$plist"
plutil -insert CFBundleName -string 'Gemini Web Bridge' "$plist"
plutil -insert CFBundleExecutable -string 'GeminiWebBridge' "$plist"
plutil -insert CFBundlePackageType -string 'APPL' "$plist"
plutil -insert CFBundleVersion -string '1' "$plist"

mv -n -- "$app" "$output_dir/"
if [[ -d "$app" ]]; then
    echo "App already exists at $destination." >&2
    exit 1
fi
printf '%s\n' "$destination"
