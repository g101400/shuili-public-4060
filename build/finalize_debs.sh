#!/usr/bin/env bash
# 最终收口：用修复后的 build_deb*.py（safe_rm=rename 残留）重建两通道全部 6×deb
# 公开轮：stage public → electron --dir ×3 → amd64 deb ×3 + mips deb ×3 → releases/
# 内部轮：stage internal → electron --dir ×3 → amd64 deb ×3 + mips deb ×3 → releases/internal/
set -u
PR="$(cd "$(dirname "$0")/.." && pwd)"
WPR="$(cd "$PR" && pwd -W)"
SK="C:/Users/admin/.workbuddy/skills/oneclick-four-platforms"
cd "$PR" || exit 1

set_channel() {
  for a in shuili gujian shipin; do
    sed -i "s/window.__BUILD_CHANNEL__ = \"[a-z]*\"/window.__BUILD_CHANNEL__ = \"$1\"/" "${a}_app/index.html"
  done
}
restore_source() {
  for a in shuili shipin; do
    [ -f "${a}_app/.data.real.json" ] && cp -f "${a}_app/.data.real.json" "${a}_app/data.json"
    [ -f "${a}_app/.data.real.js" ] && cp -f "${a}_app/.data.real.js" "${a}_app/data.js"
    [ -f "${a}_app/.data.real.app.js" ] && cp -f "${a}_app/.data.real.app.js" "${a}_app/js/app.js"
    [ -f "${a}_app/.data.real.io.js" ] && cp -f "${a}_app/.data.real.io.js" "${a}_app/js/io.js"
    [ -f "${a}_app/.data.real.ai.js" ] && cp -f "${a}_app/.data.real.ai.js" "${a}_app/js/ai.js"
    [ -f "${a}_app/.data.real.pmx.js" ] && cp -f "${a}_app/.data.real.pmx.js" "${a}_app/platform_matrix.js"
  done
  set_channel public
}
trap restore_source EXIT

declare -A APPNAME=( [shuili]="水利工程一张图" [gujian]="古建景点打卡" [shipin]="视频设备运维一张图" )
declare -A UOSDIR=( [shuili]="three_platforms/uos/uos_app" [gujian]="uos_gujian" [shipin]="uos_shipin" )
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

build_channel_debs() {  # $1 = releases 子目录（""=public, "/internal"）
  local SUB="$1" a D f
  for a in shuili gujian shipin; do
    D="$PR/${UOSDIR[$a]}"
    echo "--- electron --dir: ${APPNAME[$a]} ---"
    ( cd "$D" && env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE timeout 900 npx electron-builder --linux --x64 --dir >/dev/null 2>&1 ) || { echo "!! electron 失败: $a"; return 1; }
    # linux-unpacked 完整性
    local BIN MISS=""
    BIN=$(ls "$D/release/linux-unpacked/" 2>/dev/null | grep -vE "resources|locales|chrome_100|chrome_crashpad|icudtl|libEGL|libGLESv2|libffmpeg|chrome-sandbox|v8_context|LICENSE|version|chrome_" | head -1)
    [ -f "$D/release/linux-unpacked/$BIN" ] || MISS=" 主程序"
    for crit in icudtl.dat libEGL.so libGLESv2.so libffmpeg.so chrome-sandbox chrome_100_percent.pak; do
      [ -f "$D/release/linux-unpacked/$crit" ] || MISS="$MISS $crit"
    done
    [ -n "$MISS" ] && { echo "!! linux-unpacked 残缺:$MISS → $a"; return 1; }
    echo "--- amd64 deb: ${APPNAME[$a]} ---"
    env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE timeout 600 python "$SK/build_deb.py" "$(cygpath -w "$D")" >/dev/null 2>&1 || { echo "!! ${a} amd64 失败"; return 1; }
    f=$(ls -t "$D"/release/*_linux_amd64.deb 2>/dev/null | head -1)
    [ -f "$f" ] || { echo "!! amd64 缺失: $a"; return 1; }
    python "$WPR/verify_myml_ar.py" "$(cygpath -w "$f")" >/dev/null 2>&1 || { echo "!! 铁律未过: ${APPNAME[$a]}"; return 1; }
    cp -f "$f" "$PR/releases$SUB/" && echo "  OK -> releases$SUB/$(basename "$f")"
    echo "--- mips deb: ${APPNAME[$a]} ---"
    env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE timeout 600 python "$SK/build_deb_mips.py" "$(cygpath -w "$PR/${a}_app")" >/dev/null 2>&1 || { echo "!! ${a} mips 失败"; return 1; }
    f="${PR}/${APPNAME[$a]}V2.4.4_linux_mips64el.deb"
    [ -f "$f" ] || { echo "!! mips 缺失: $a"; return 1; }
    python "$WPR/verify_myml_ar.py" "$(cygpath -w "$f")" >/dev/null 2>&1 || { echo "!! 铁律未过: ${APPNAME[$a]}"; return 1; }
    cp -f "$f" "$PR/releases$SUB/" && echo "  OK -> releases$SUB/$(basename "$f")"
  done
}

stage_channel() {  # $1 = public|internal
  if [ "$1" = "public" ]; then
    python scripts/make_public_data.py >/dev/null || return 1
    for a in shuili shipin; do
      cp -f "${a}_app/data.json" "${a}_app/.data.real.json"
      cp -f "${a}_app/data.js" "${a}_app/.data.real.js"
      cp -f "${a}_app/js/app.js" "${a}_app/.data.real.app.js"
      cp -f "${a}_app/js/io.js" "${a}_app/.data.real.io.js"
      cp -f "${a}_app/js/ai.js" "${a}_app/.data.real.ai.js"
      cp -f "${a}_app/platform_matrix.js" "${a}_app/.data.real.pmx.js"
      cp -f "${a}_app/data.public.json" "${a}_app/data.json"
      cp -f "${a}_app/data.public.js" "${a}_app/data.js"
      cp -f "${a}_app/js/app.public.js" "${a}_app/js/app.js"
      cp -f "${a}_app/js/io.public.js" "${a}_app/js/io.js"
      cp -f "${a}_app/js/ai.public.js" "${a}_app/js/ai.js"
      cp -f "${a}_app/platform_matrix.public.js" "${a}_app/platform_matrix.js"
    done
    set_channel public
  else
    for a in shuili shipin; do
      cp -f "${a}_app/.data.real.json" "${a}_app/data.json"
      cp -f "${a}_app/.data.real.js" "${a}_app/data.js"
      cp -f "${a}_app/.data.real.app.js" "${a}_app/js/app.js" 2>/dev/null
      cp -f "${a}_app/.data.real.io.js" "${a}_app/js/io.js" 2>/dev/null
      cp -f "${a}_app/.data.real.ai.js" "${a}_app/js/ai.js" 2>/dev/null
      cp -f "${a}_app/.data.real.pmx.js" "${a}_app/platform_matrix.js" 2>/dev/null
    done
    set_channel internal
  fi
  for a in shuili gujian shipin; do ( cd "${a}_app" && node gen_kb_skeleton.mjs >/dev/null 2>&1 ); done
  python sync_targets.py >/dev/null || return 1
}

echo "===== [1] 公开 deb ×6 ====="
stage_channel public || { echo "!! public staging 失败"; exit 1; }
build_channel_debs "" || { echo "!! 公开 deb 失败"; exit 1; }

echo "===== [2] internal deb ×6 ====="
stage_channel internal || { echo "!! internal staging 失败"; exit 1; }
build_channel_debs "/internal" || { echo "!! internal deb 失败"; exit 1; }

restore_source
python sync_targets.py >/dev/null 2>&1 || true
trap - EXIT

echo "===== deb 收口完成 ====="
echo -n "releases/ 件数: "; ls "$PR/releases" | grep -c "V2.4.4"
echo -n "releases/internal/ 件数: "; ls "$PR/releases/internal" | grep -c "V2.4.4"
