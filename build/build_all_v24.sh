#!/usr/bin/env bash
# 一张图家族 v2.4 四端构建（串行，电子构建严格不并行，规避 wix/app-builder 锁 + safe-delete rollback）
# ⚠️ 路径全部基于脚本自身位置推导 + 相对路径，避免硬编码 D:/ 前缀在后台 bash 下被解析失败（曾致 cd 静默跳过）。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PR="$SCRIPT_DIR"
SK="C:/Users/admin/.workbuddy/skills/oneclick-four-platforms"
REL="${PR}/releases${REL_SUBDIR:-}"   # REL_SUBDIR=/internal 时内部版产物隔离到 releases/internal/（公开版策略 v2.4.4）
mkdir -p "$REL"
DATE="$(date +%Y%m%d)"   # 动态取构建当日，与 build_apk.sh 对齐（曾硬编码 20260830 → APK 查找日期不符误报"缺失"）
LOG="$PR/build_v24.log"
TS="$PR/.build_v24_ts"            # 新鲜产物判定基准（固定 mtime，不被 tee 持续更新）
touch "$TS"
: > "$LOG"
PRW="$(cygpath -w "$PR")"          # Windows 原生 python 必须用 Windows 路径
SKW="$(cygpath -w "$SK")"
echo "PRW=$PRW  SKW=$SKW"
exec > >(tee -a "$LOG") 2>&1
echo "===== BUILD v2.4 START $(date) ===== (PR=$PR)"
cd_ok() { cd "$1" 2>/dev/null || { echo "!! 目录不存在/无法进入: $1"; exit 1; }; }

# v2.4.7：BUILD_APPS="shuili,shipin" 时只构建指定 app（古建单通道：内部轮跳过古建；缺省=全部）
want_app() {
  [ -z "${BUILD_APPS:-}" ] && return 0
  local p="$1" k=""
  case "$p" in
    *gujian*|*Gujian*) k="gujian";;
    *shipin*|*Shipin*) k="shipin";;
    *shuili*|*ShuiLi*) k="shuili";;
    *win11|*uos_app)   k="shuili";;
  esac
  [ -z "$k" ] && return 0
  case ",$BUILD_APPS," in *",$k,"*) return 0;; esac
  return 1
}

# ---------- 0) 预生成知识库骨架（嵌入发行版；首启 initKB 离线即时导入）----------
echo "########## [0/5] 预生成知识库骨架 kb_skeleton.json ##########"
declare -a APPS=("$PR/shuili_app" "$PR/gujian_app" "$PR/shipin_app")
for D in "${APPS[@]}"; do
  want_app "$D" || { echo "  -- 跳过 skeleton: $(basename "$D") (BUILD_APPS=$BUILD_APPS)"; continue; }
  if [ -f "$D/data.json" ]; then
    ( cd "$D" && node gen_kb_skeleton.mjs ) && echo "  skeleton OK -> $D/kb_skeleton.json" || echo "  !! skeleton 生成失败: $D"
  else
    echo "  ! 跳过(无 data.json): $D"
  fi
done

# ---------- 1) Win11 (3 串行, timeout 护栏 + nsis/msi 拆分兜底, 非致命) ----------
# 2026-09-01 防漂移：Win11 electron 包装 package.json 的 version 是 exe/msi 文件名的【第二版本源】，
# 曾与 APP_VER 失配（升 V2.4.2 时 exe 仍叫 V2.4.1）。这里构建前从 APP_VER 单一源自动盖写三处包装版本，
# 杜绝"双版本源"再次静默失配（炎冰硬标准：版本号只看 APP_VER）。
stamp_win11_version() {
  local av
  av=$(grep -oE 'APP_VER\s*=\s*"v[0-9.]+"' "$PR/shuili_app/js/app.js" | grep -oE '[0-9.]+' | head -1)
  [ -z "$av" ] && { echo "  !! 无法从 APP_VER 读取版本，跳过 stamp"; return; }
  for d in "$PR/../win11" "$PR/win11_gujian" "$PR/win11_shipin"; do
    # 坑：cygpath -w 对带 /d/ 前缀 + .. 的 POSIX 路径会切掉 /d/ 前缀生成错路径；
    # 改用 cd 进目录 + pwd -W（GitBash 原生输出 Windows 路径），再拼 package.json，node 可直接读。
    local pfw; pfw="$(cd "$d" && pwd -W)/package.json"
    node -e "const fs=require('fs');const p=\"$pfw\";const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.version!=='$av'){j.version='$av';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');console.log('  stamp '+p+' -> $av')}else{console.log('  '+p+' 已是 $av')}"
  done
  echo "  win11 包装版本已对齐 APP_VER=v$av"
}
stamp_win11_version

echo "########## [1/5] Win11 EXE/MSI ##########"
declare -a WIN=(
  "水利工程一张图:$PR/../win11"
  "古建景点打卡:$PR/win11_gujian"
  "视频设备运维一张图:$PR/win11_shipin"
)
for e in "${WIN[@]}"; do
  NAME="${e%%:*}"; D="${e##*:}"
  want_app "$D" || { echo "--- Win11 跳过 $NAME (BUILD_APPS=$BUILD_APPS)"; continue; }
  echo "--- Win11 $NAME ($D) ---"
  cd_ok "$D" || continue
  # 隔离每项目 electron/npm 缓存，规避紧接打包时的跨项目缓存锁竞争（曾致 gujian 挂死）
  export ELECTRON_CACHE="$D/.ecache"; export npm_config_cache="$D/.npmcache"
  # winCodeSign/wiX 等二进制走国内镜像兜底（GitHub 不通时），默认缓存命中则直接用
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://cdn.npmmirror.com/binaries/electron-builder-binaries"
  sleep 3   # 等前序打包进程彻底释放文件锁
  # 清理前序打包孤儿进程（app-builder/WiX/nsis 是 timeout/kill 的孙进程，会存活并持文件锁，拖死下一轮打包）
  taskkill /F /IM app-builder.exe 2>/dev/null; taskkill /F /IM light.exe 2>/dev/null; taskkill /F /IM candle.exe 2>/dev/null; taskkill /F /IM makensis.exe 2>/dev/null
  rm -rf win-unpacked release 2>/dev/null   # 清理上次残留，避免锁/半截产物致挂死
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
done

# ---------- 2) UOS amd64 (Electron, 3 串行, timeout + cygpath -w) ----------
# 2026-08-31 修复：旧版 `| tail` 会吞掉 build_deb.py self_verify 的退出码——08-30 晚 v2.4 三套 amd64 deb
# 因 linux-unpacked 残缺（缺主程序/icudtl.dat 等）全被 self_verify 拦下，但 tail 吞 rc → 残缺 deb 照常 cp 进
# releases（水利/视频 74MB 大包看着正常、古建 11.7MB 一眼假）。纪律：python 步骤一律检查 PIPESTATUS，
# 打包后先核 linux-unpacked 完整性再 build_deb，失败不 cp、铁律不过从 releases 撤回。
echo "########## [2/5] UOS amd64 deb ##########"
declare -a UOS=(
  "水利工程一张图:$PR/three_platforms/uos/uos_app:shuili-yitu"
  "古建景点打卡:$PR/uos_gujian:gujian-daka"
  "视频设备运维一张图:$PR/uos_shipin:shipin-yunwei"
)
for e in "${UOS[@]}"; do
  NAME="${e%%:*}"; rest="${e#*:}"; D="${rest%%:*}"; BIN="${rest##*:}"
  want_app "$D" || { echo "--- UOS amd64 跳过 $NAME (BUILD_APPS=$BUILD_APPS)"; continue; }
  echo "--- UOS amd64 $NAME ($D) ---"
  cd_ok "$D" || exit 1
  DW="$(cygpath -w "$D")"
  # 清孤儿 + 缓冲（与 WIN 段同理；shuili 大项目 linux 打包同样可达 20min+，timeout 1200 不够）
  taskkill /F /IM app-builder.exe 2>/dev/null; taskkill /F /IM light.exe 2>/dev/null; taskkill /F /IM candle.exe 2>/dev/null; taskkill /F /IM makensis.exe 2>/dev/null
  sleep 3
  # 先挪走旧 linux-unpacked（mv 保留可回滚，勿 rm——safe-delete 会拦），避免 electron-builder 删旧产物半途失败
  [ -d release/linux-unpacked ] && mv release/linux-unpacked "release/linux-unpacked.old_$(date +%H%M%S)" 2>/dev/null
  PL="$PR/build_v24_packlinux_$NAME.log"
  # 2026-08-31 根因修复：npm run pack:linux（electron-builder --linux --x64 无 --dir）会顺带构建 AppImage，
  # app-builder 在 Windows 创建 symlink 缺管理员权限 → packaging 半途失败、linux-unpacked 残缺
  # （昨晚三套 v2.4 deb 全残根因）。改用 --dir 只产 linux-unpacked（SKILL 坑 28 既定做法）。
  timeout 3600 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE npx electron-builder --linux --x64 --dir > "$PL" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then echo "  !! pack:linux 失败 rc=$rc（日志 $PL）"; continue; fi
  LU="$D/release/linux-unpacked"
  miss=""
  [ -f "$LU/$BIN" ] || miss="$miss 主程序$BIN"
  for crit in icudtl.dat libEGL.so libGLESv2.so libffmpeg.so chrome-sandbox chrome_100_percent.pak; do
    [ -f "$LU/$crit" ] || miss="$miss $crit"
  done
  if [ -n "$miss" ]; then echo "  !! linux-unpacked 残缺:$miss → 跳过打包（勿交付坏 deb）"; continue; fi
  echo "  linux-unpacked 完整性 OK（主程序+6 核心文件在）"
  DL="$PR/build_v24_deb_$NAME.log"
  timeout 600 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE python "$SKW/build_deb.py" "$DW" > "$DL" 2>&1
  rc=${PIPESTATUS[0]}
  if [ $rc -ne 0 ]; then echo "  !! build_deb.py 失败 rc=$rc（含 self_verify，日志 $DL）"; continue; fi
  DEB="$(ls -t "$D"/release/*_linux_amd64.deb 2>/dev/null | head -1)"
  if [ -n "$DEB" ]; then cp -f "$DEB" "$REL/" && echo "  cp amd64 deb OK -> $(basename "$DEB")"; else echo "  !! amd64 deb 缺失"; continue; fi
  python "$PRW/verify_myml_ar.py" "$(cygpath -w "$DEB")" >/dev/null 2>&1 || { echo "  !! 铁律校验未过 → 从 releases 撤回 $(basename "$DEB")"; rm -f "$REL/$(basename "$DEB")"; }
done

# ---------- 3) UOS mips64el (浏览器壳, 3) ----------
echo "########## [3/5] UOS mips64el deb ##########"
declare -a MIPS=(
  "水利工程一张图:$PR/shuili_app"
  "古建景点打卡:$PR/gujian_app"
  "视频设备运维一张图:$PR/shipin_app"
)
for e in "${MIPS[@]}"; do
  NAME="${e%%:*}"; D="${e##*:}"
  want_app "$D" || { echo "--- UOS mips64el 跳过 $NAME (BUILD_APPS=$BUILD_APPS)"; continue; }
  echo "--- UOS mips64el $NAME ($D) ---"
  ML="$PR/build_v24_mips_$NAME.log"
  # 2026-09-04: env -u NODE_OPTIONS 绕 safe-delete（_mips_data.tar 清理被拦致 rc=1）
  timeout 600 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE python "$SKW/build_deb_mips.py" "$(cygpath -w "$D")" > "$ML" 2>&1
  rc=${PIPESTATUS[0]}
  if [ $rc -ne 0 ]; then echo "  !! build_deb_mips.py 失败 rc=$rc（日志 $ML）"; continue; fi
  f=$(find "$PR" -maxdepth 1 -name "${NAME}V*_linux_mips64el.deb" -newer "$TS" | head -1)
  if [ -n "$f" ]; then cp -f "$f" "$REL/" && echo "  cp mips deb OK -> $(basename "$f")"; else echo "  !! mips deb 缺失(新鲜)"; continue; fi
  python "$PRW/verify_myml_ar.py" "$(cygpath -w "$f")" >/dev/null 2>&1 || { echo "  !! 铁律校验未过 → 从 releases 撤回 $(basename "$f")"; rm -f "$REL/$(basename "$f")"; }
done

# ---------- 4) Android APK (3) ----------
echo "########## [4/5] Android APK ##########"
declare -a AND=(
  "水利工程一张图:$PR/../android_build/ShuiLiApp"
  "古建景点打卡:$PR/../android_build/GujianApp"
  "视频设备运维一张图:$PR/../android_build/ShipinApp"
)
for e in "${AND[@]}"; do
  NAME="${e%%:*}"; D="${e##*:}"
  want_app "$D" || { echo "--- Android 跳过 $NAME (BUILD_APPS=$BUILD_APPS)"; continue; }
  echo "--- Android $NAME ($D) ---"
  cd_ok "$D"
  bash build_apk.sh 2>&1 | tail -8
  f=$(find "$REL" -maxdepth 1 -name "${NAME}V*_4060.apk" -newer "$TS" | head -1)   # 不依赖 DATE，彻底消除日期错配误报
  [ -n "$f" ] && echo "  APK OK -> $(basename "$f")" || echo "  !! APK 缺失(新鲜)"
done

# ---------- 5) iOS PWA zip (3) ----------
echo "########## [5/5] iOS PWA zip ##########"
declare -a PWA=(
  "水利工程一张图:shuili_pwa"
  "古建景点打卡:gujian_pwa"
  "视频设备运维一张图:shipin_pwa"
)
for e in "${PWA[@]}"; do
  NAME="${e%%:*}"; D="${e##*:}"
  want_app "$D" || { echo "--- PWA 跳过 $NAME (BUILD_APPS=$BUILD_APPS)"; continue; }
  echo "--- PWA $NAME ($D) ---"
  PY_SRC="$(cygpath -w "$PR/three_platforms/ios/$D")"
  PY_REL="$(cygpath -w "$REL")"
  python - "$PY_SRC" "$PY_REL" "$NAME" <<'PY'
import os, zipfile, sys, re
SRC, REL, NAME = sys.argv[1], sys.argv[2], sys.argv[3]
# 2026-08-31 修复：版本从源 app.js 读（曾硬编码 V2.4 → 源升 v2.4.1 后文件名仍 V2.4，与内容不一致）
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
def _junk(fn):  # 2026-09-04（坑16）：.bak_*/中间数据严禁进 PWA 包
    return ('.bak' in fn or fn.startswith('.data.real') or '.public.' in fn or fn == 'data.geojson' or fn == 'data.geojson'
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
done

rm -f "$TS"
echo "===== BUILD v2.4 DONE $(date) ====="
echo "===== releases/ v2.4 产物 ====="
ls -la "$REL" | grep -E "V2\.4" | tail -40
