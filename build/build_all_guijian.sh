#!/usr/bin/env bash
# 古建景点打卡 单通道四端构建（self-contained 版：原生壳在 build/targets/）
# 路径全部基于脚本自身位置推导 + 相对路径，不写死工作区绝对路径。
# 仅构建 gujian（单通道，无脱敏/无内部轮）。对应 family 参考见同目录 build_all_v24.sh（三端版）。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PR="$(cd "$SCRIPT_DIR/.." && pwd)"          # 仓库根 = gujian_app
SK="$SCRIPT_DIR"                            # build_deb.py / build_deb_mips.py / verify_myml_ar.py 同目录
REL="${PR}/releases${REL_SUBDIR:-}"
mkdir -p "$REL"
DATE="$(date +%Y%m%d)"
LOG="$PR/build_v24.log"
TS="$PR/.build_v24_ts"
touch "$TS"
: > "$LOG"
PRW="$(cygpath -w "$PR")"
SKW="$(cygpath -w "$SK")"
echo "PRW=$PRW  SKW=$SKW"
exec > >(tee -a "$LOG") 2>&1
echo "===== BUILD gujian $(date) (PR=$PR) ====="
cd_ok() { cd "$1" 2>/dev/null || { echo "!! 目录不存在/无法进入: $1"; exit 1; }; }

# 版本单一源：APP_VER（古建单通道，只认 gujian_app）
VER="$(grep -oE 'APP_VER\s*=\s*"v[0-9.]+"' "$PR/js/app.js" | grep -oE '[0-9.]+' | head -1)"
[ -z "$VER" ] && { echo "!! 无法从 APP_VER 读取版本，中止"; exit 1; }
VERU="V${VER}"
echo "版本单一源 APP_VER=v$VER (产物前缀 $VERU)"

# Win11 包装版本对齐 APP_VER（防双版本源失配）
stamp_win11_version() {
  local av="$VER"
  local d="$PR/build/targets/win11"
  [ -d "$d" ] || { echo "  (跳过 win11 版本对齐：目录不存在 $d)"; return; }
  local pfw; pfw="$(cd "$d" && pwd -W)/package.json"
  node -e "const fs=require('fs');const p=\"$pfw\";const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.version!=='$av'){j.version='$av';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');console.log('  stamp '+p+' -> $av')}else{console.log('  '+p+' 已是 $av')}"
  echo "  win11 包装版本已对齐 APP_VER=v$av"
}
stamp_win11_version

# ---------- 0) 预生成知识库骨架（嵌入发行版）----------
echo "########## [0/5] 预生成知识库骨架 kb_skeleton.json ##########"
if [ -f "$PR/data.json" ]; then
  ( cd "$PR" && node gen_kb_skeleton.mjs ) && echo "  skeleton OK -> $PR/kb_skeleton.json" || echo "  !! skeleton 生成失败"
else
  echo "  ! 跳过(无 data.json)"
fi

# ---------- 1) Win11 (EXE/MSI) ----------
echo "########## [1/5] Win11 EXE/MSI ##########"
NAME="古建景点打卡"; D="$PR/build/targets/win11"
echo "--- Win11 $NAME ($D) ---"
cd_ok "$D" || true
export ELECTRON_CACHE="$D/.ecache"; export npm_config_cache="$D/.npmcache"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://cdn.npmmirror.com/binaries/electron-builder-binaries"
sleep 3
taskkill /F /IM app-builder.exe 2>/dev/null; taskkill /F /IM light.exe 2>/dev/null; taskkill /F /IM candle.exe 2>/dev/null; taskkill /F /IM makensis.exe 2>/dev/null
rm -rf win-unpacked release 2>/dev/null
ok=0
for attempt in 1 2; do
  echo "  pack:all attempt $attempt (timeout 3600s)"
  timeout 3600 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE npm run pack:all 2>&1 | tail -6
  rc=${PIPESTATUS[0]}
  if [ "$rc" -eq 0 ]; then ok=1; break; fi
  echo "  !! attempt $attempt rc=$rc (124=挂死)，拆 nsis/msi 重试"
  timeout 480 env -u NODE_OPTIONS npm run pack:nsis 2>&1 | tail -3
  timeout 480 env -u NODE_OPTIONS npm run pack:msi  2>&1 | tail -3
  if ls release/*_win64.exe release/*_win64.msi >/dev/null 2>&1; then ok=1; break; fi
done
cp -f release/*_win64.exe "$REL/" 2>/dev/null && echo "  cp exe OK -> $(ls -t release/*_win64.exe | head -1 | xargs basename)" || echo "  !! exe 缺失"
cp -f release/*_win64.msi "$REL/" 2>/dev/null && echo "  cp msi OK -> $(ls -t release/*_win64.msi | head -1 | xargs basename)" || echo "  !! msi 缺失"
[ "$ok" -eq 0 ] && echo "  ### 警告: $NAME Win 未成功（疑似孤儿进程持锁，需手动清理后重试）###"

# ---------- 2) UOS amd64 (Electron) ----------
echo "########## [2/5] UOS amd64 deb ##########"
NAME="古建景点打卡"; D="$PR/build/targets/uos"; BIN="gujian-daka"
echo "--- UOS amd64 $NAME ($D) ---"
cd_ok "$D" || exit 1
DW="$(cygpath -w "$D")"
taskkill /F /IM app-builder.exe 2>/dev/null; taskkill /F /IM light.exe 2>/dev/null; taskkill /F /IM candle.exe 2>/dev/null; taskkill /F /IM makensis.exe 2>/dev/null
sleep 3
[ -d release/linux-unpacked ] && mv release/linux-unpacked "release/linux-unpacked.old_$(date +%H%M%S)" 2>/dev/null
PL="$PR/build_v24_packlinux_$NAME.log"
timeout 3600 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE npx electron-builder --linux --x64 --dir > "$PL" 2>&1
rc=$?
if [ $rc -ne 0 ]; then echo "  !! pack:linux 失败 rc=$rc（日志 $PL）"; else
  LU="$D/release/linux-unpacked"
  miss=""
  [ -f "$LU/$BIN" ] || miss="$miss 主程序$BIN"
  for crit in icudtl.dat libEGL.so libGLESv2.so libffmpeg.so chrome-sandbox chrome_100_percent.pak; do
    [ -f "$LU/$crit" ] || miss="$miss $crit"
  done
  if [ -n "$miss" ]; then echo "  !! linux-unpacked 残缺:$miss → 跳过打包（勿交付坏 deb）"; else
    echo "  linux-unpacked 完整性 OK（主程序+6 核心文件在）"
    DL="$PR/build_v24_deb_$NAME.log"
    timeout 600 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE python "$SKW/build_deb.py" "$DW" > "$DL" 2>&1
    rc=${PIPESTATUS[0]}
    if [ $rc -ne 0 ]; then echo "  !! build_deb.py 失败 rc=$rc（含 self_verify，日志 $DL）"; else
      DEB="$(ls -t "$D"/release/*_linux_amd64.deb 2>/dev/null | head -1)"
      if [ -n "$DEB" ]; then cp -f "$DEB" "$REL/" && echo "  cp amd64 deb OK -> $(basename "$DEB")"; else echo "  !! amd64 deb 缺失"; fi
      python "$PRW/verify_myml_ar.py" "$(cygpath -w "$DEB")" >/dev/null 2>&1 || { echo "  !! 铁律校验未过 → 从 releases 撤回 $(basename "$DEB")"; rm -f "$REL/$(basename "$DEB")"; }
    fi
  fi
fi

# ---------- 3) UOS mips64el (浏览器壳，直接从 gujian_app 源构建) ----------
echo "########## [3/5] UOS mips64el deb ##########"
NAME="古建景点打卡"; D="$PR"
echo "--- UOS mips64el $NAME ($D) ---"
ML="$PR/build_v24_mips_$NAME.log"
timeout 600 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE python "$SKW/build_deb_mips.py" "$(cygpath -w "$D")" > "$ML" 2>&1
rc=${PIPESTATUS[0]}
if [ $rc -ne 0 ]; then echo "  !! build_deb_mips.py 失败 rc=$rc（日志 $ML）"; else
  f=$(find "$PR" -maxdepth 1 -name "${NAME}V*_linux_mips64el.deb" -newer "$TS" | head -1)
  if [ -n "$f" ]; then cp -f "$f" "$REL/" && echo "  cp mips deb OK -> $(basename "$f")"; else echo "  !! mips deb 缺失(新鲜)"; fi
  python "$PRW/verify_myml_ar.py" "$(cygpath -w "$f")" >/dev/null 2>&1 || { echo "  !! 铁律校验未过 → 从 releases 撤回 $(basename "$f")"; rm -f "$REL/$(basename "$f")"; }
fi

# ---------- 4) Android APK ----------
echo "########## [4/5] Android APK ##########"
NAME="古建景点打卡"; D="$PR/build/targets/android"
echo "--- Android $NAME ($D) ---"
cd_ok "$D"
bash build_apk.sh 2>&1 | tail -8
f=$(find "$REL" -maxdepth 1 -name "${NAME}V*_4060.apk" -newer "$TS" | head -1)
[ -n "$f" ] && echo "  APK OK -> $(basename "$f")" || echo "  !! APK 缺失(新鲜)"

# ---------- 5) iOS PWA zip ----------
echo "########## [5/5] iOS PWA zip ##########"
NAME="古建景点打卡"; D="gujian_pwa"
echo "--- iOS PWA $NAME ($D) ---"
PY_SRC="$(cygpath -w "$PR/build/targets/ios/$D")"
PY_REL="$(cygpath -w "$REL")"
python - "$PY_SRC" "$PY_REL" "$NAME" <<'PY'
import os, zipfile, sys, re
SRC, REL, NAME = sys.argv[1], sys.argv[2], sys.argv[3]
ver = "V2.4"
try:
    ap = os.path.join(SRC, "js", "app.js")
    if os.path.exists(ap):
        m = re.search(r'APP_VER\s*=\s*"v([0-9.]+)"', open(ap, encoding="utf-8", errors="ignore").read())
        if m: ver = "V" + m.group(1)
except Exception:
    pass
out = os.path.join(REL, "%s%s_PWA_https.zip" % (NAME, ver))
EX = {'.md','.apk','.log'}
def _junk(fn):
    return ('.bak' in fn or fn.startswith('.data.real') or '.public.' in fn or fn == 'data.geojson'
            or fn.endswith(('.mjs','.cjs')))
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in {'.git','node_modules','.trash'}]
        for fn in files:
            if os.path.splitext(fn)[1].lower() in EX or _junk(fn): continue
            full = os.path.join(root, fn)
            arc = os.path.relpath(full, SRC).replace(os.sep, "/")
            z.write(full, arc)
print("  PWA zip OK ->", os.path.basename(out), os.path.getsize(out), "bytes")
PY

rm -f "$TS"
echo "===== BUILD gujian DONE $(date) ====="
echo "===== releases/ v$VER 产物 ====="
ls -la "$REL" | grep -E "${VERU}" | tail -40
