#!/bin/sh
# Fetch ffmpeg.wasm 0.12 from npm into /tmp/mosh-dl (downloads kept apart from the repo),
# then vendor the ESM builds of @ffmpeg/ffmpeg and @ffmpeg/util into vendor/ so the
# worker loads from the same origin on GitHub Pages. The core (~31 MB) is not vendored:
# the app loads it from jsDelivr with toBlobURL; the Node test uses the copy in /tmp.
set -eu
FFMPEG_V=0.12.15
UTIL_V=0.12.2
CORE_V=0.12.10
DL=/tmp/mosh-dl
REPO=$(cd "$(dirname "$0")/.." && pwd)

rm -rf "$DL"
mkdir -p "$DL/ffmpeg" "$DL/util" "$DL/core"
curl -fsSL "https://registry.npmjs.org/@ffmpeg/ffmpeg/-/ffmpeg-$FFMPEG_V.tgz" | tar -xz -C "$DL/ffmpeg"
curl -fsSL "https://registry.npmjs.org/@ffmpeg/util/-/util-$UTIL_V.tgz" | tar -xz -C "$DL/util"
curl -fsSL "https://registry.npmjs.org/@ffmpeg/core/-/core-$CORE_V.tgz" | tar -xz -C "$DL/core"

rm -rf "$REPO/vendor"
mkdir -p "$REPO/vendor/ffmpeg" "$REPO/vendor/util"
cp "$DL/ffmpeg/package/dist/esm/"*.js "$REPO/vendor/ffmpeg/"
cp "$DL/util/package/dist/esm/"*.js "$REPO/vendor/util/"
cp "$DL/ffmpeg/package/LICENSE"* "$REPO/vendor/ffmpeg/" 2>/dev/null || true
cp "$DL/util/package/LICENSE"* "$REPO/vendor/util/" 2>/dev/null || true
printf '@ffmpeg/ffmpeg %s\n@ffmpeg/util %s\n@ffmpeg/core %s (loaded from jsDelivr)\n' "$FFMPEG_V" "$UTIL_V" "$CORE_V" > "$REPO/vendor/VERSIONS"

echo "== vendored"; ls -la "$REPO/vendor/ffmpeg" "$REPO/vendor/util"
echo "== core"; ls -la "$DL/core/package/dist/esm" "$DL/core/package/dist/umd"
echo "== bare imports in vendored files (should be none)"
grep -nE "from ['\"][^./]" "$REPO/vendor/ffmpeg/"*.js "$REPO/vendor/util/"*.js || echo "none"
