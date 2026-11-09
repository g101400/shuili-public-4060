#!/usr/bin/env bash
# 编译 古建打卡 Android APK（WebApp 外壳，内嵌 PWA）
# 用法（Git Bash）：  bash build_apk.sh
set -e

# 自包含：路径基于脚本位置推导（不再写死工作区绝对路径）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # build/targets/android
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"     # 仓库根 = shuili
SOURCE="$REPO"                                  # PWA 源 = gujian_app
PROJECT="$SCRIPT_DIR"                           # 自包含安卓工程 = build/targets/android
ASSETS="$PROJECT/app/src/main/assets/www"       # 由 sync 再生
RELEASE_DIR="$REPO/releases"
# 工具链：可经环境变量覆盖（默认沿用原工作区位置；缺失时请自行设置 JDK/GRADLE）
ANDROID_BUILD="${ANDROID_BUILD:-/d/Users/WorkBuddy/android_build}"
JDK="${JDK:-$ANDROID_BUILD/jdk/jdk-17.0.12+7}"
GRADLE="${GRADLE:-$ANDROID_BUILD/gradle-8.10/bin/gradle}"
OUT_APK="$SOURCE/ShuiliYitu-debug.apk"

export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"

echo "[1/3] 同步 PWA 资源到 APK 资源目录..."
# 清空旧 assets/www（生成物，非个人文件），避免残留被排除的中间文件（data.json 等）
PWDIR=$(cygpath -w "$ASSETS" 2>/dev/null || echo "$ASSETS")
powershell.exe -NoProfile -Command "Remove-Item -Recurse -Force '$PWDIR\\*' -ErrorAction SilentlyContinue" 2>/dev/null || true
mkdir -p "$ASSETS"
# 用 tar 管道整体复制：避免 find -exec 在超大环境下 spawn 失败（exec() 环境块超限）
# 排除：文档(docs/*.md)、中间文件(prep_data.py/data.geojson/data.json)、构建垃圾(_smoke2.py/_verify_v21.js/*.log/prep_*.py/source_data) 与 APK 本体
cd "$SOURCE"
tar --exclude='./docs' --exclude='*.md' \
    --exclude='./prep_data.py' --exclude='./data.geojson' --exclude='./data.json' \
    --exclude='./_smoke2.py' --exclude='./_verify_v21.js' --exclude='*.log' \
    --exclude='./prep_*.py' --exclude='./source_data' \
    --exclude='*.apk' --exclude='*.bak*' --exclude='.data.real.*' \
    --exclude='*.public.*' --exclude='*.internalkeep*' --exclude='*.mjs' --exclude='*.cjs' -cf - . | ( cd "$ASSETS" && tar -xf - )
# 确保离线内嵌数据 data.js 最新（APK 场景不 fetch）；无则不复制，避免硬失败
if [ -f "$SOURCE/data.js" ]; then
  cp "$SOURCE/data.js" "$ASSETS/data.js"
fi

echo "[2/3] 编译 debug APK..."
# --no-daemon 规避 Windows Gradle 守护进程残留文件锁(拒绝访问 graph.bin)；clean 由 Gradle 自身清理构建产物
"$GRADLE" --no-daemon -p "$PROJECT" clean assembleDebug

echo "[3/3] 取出 APK..."
APK=$(find "$PROJECT/app/build/outputs/apk/debug" -name '*.apk' | head -1)
cp "$APK" "$OUT_APK"
echo "完成 -> $OUT_APK"
ls -lh "$OUT_APK"

echo "[归档] 按 <名称>V<版本>_<日期>_4060 命名规则留存一份到 releases/..."
APP_NAME="水利工程基础信息一张图"
APP_VER=$(sed -n 's/.*APP_VER[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ASSETS/js/app.js" | head -1)
# 归档名剥离 APP_VER 前导小写 v，避免 Vv 双 V
APP_VER_CLEAN=$(echo "$APP_VER" | sed 's/^v//')
DATE=$(date +%Y%m%d)
RELEASE_DIR="/d/Users/WorkBuddy/shuili/releases"
mkdir -p "$RELEASE_DIR"
if [ -z "$APP_VER" ]; then
  echo "!! 未能从 $ASSETS/js/app.js 解析 APP_VER，跳过归档（APK 本体已生成于 $OUT_APK）"
else
  REL_NAME="ShuiliYituV${APP_VER_CLEAN}_${DATE}.apk"
  if cp "$OUT_APK" "$RELEASE_DIR/$REL_NAME"; then
    echo "归档 -> $RELEASE_DIR/$REL_NAME"
  else
    echo "!! 归档复制失败（APK 本体已生成于 $OUT_APK，但未写入 releases/）"
    exit 1
  fi
fi
