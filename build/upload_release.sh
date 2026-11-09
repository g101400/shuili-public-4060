#!/usr/bin/env bash
# v2.4.7：发版产物自动上传百度网盘（bdpan CLI，路径限制在 /apps/bdpan 下）
# 布局：/apps/bdpan/一张图发布/<app>/<channel>/…
#   水利/感知：public（releases/，脱敏）+ internal（releases/internal/，真实）
#   古建：单通道 → public 目录（releases/ 中古建产物）
# 每个目录附带 latest.json（version/app/channel/date/notes/download），供升级检测与人工下载。
# 未安装/未登录 bdpan 时优雅跳过（exit 0），不阻塞构建；登录后重跑即可补传。
set -u
PR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PR" || exit 1
export PATH="$PATH:/c/Users/admin/AppData/Local/bdpan:$HOME/.local/bin"

command -v bdpan >/dev/null 2>&1 || { echo "  (bdpan CLI 未安装，跳过上传)"; exit 0; }
bdpan whoami 2>&1 | grep -q "未登录" && { echo "  (bdpan 未登录，跳过上传——执行 bash C:/Users/admin/.workbuddy/skills/bdpan-storage/scripts/login.sh 扫码后重跑 scripts/upload_release.sh)"; exit 0; }

VER="$(grep -oE 'APP_VER\s*=\s*"v[0-9.]+"' js/app.js | grep -oE '[0-9.]+' | head -1)"
[ -z "$VER" ] && { echo "  !! 无法读取版本"; exit 1; }
VERU="V$VER"
DATE="$(date +%Y-%m-%d)"
BASE="一张图发布"
# ⚠️ 坑28：原生 python 不认 Git Bash 的 /tmp → 临时目录放项目内（Windows 可见路径）
TMP="$PR/.upload_tmp"
mkdir -p "$TMP"

up() {  # up <本地文件> <远端相对路径>
  bdpan upload "$1" "$2" >/dev/null 2>&1 && echo "  ↑ $(basename "$1") -> $2" || { echo "  !! 上传失败: $(basename "$1")"; return 1; }
}

mk_latest() {  # mk_latest <app> <channel> <appname> <notes...>
  local app="$1" ch="$2" appname="$3"; shift 3
  python - "$TMP/latest_${app}_${ch}.json" "$app" "$ch" "$VER" "$DATE" "$appname" <<'PY'
import json, sys
out, app, ch, ver, date, appname = sys.argv[1:7]
json.dump({"app": app, "channel": ch, "version": "v" + ver, "date": date, "appname": appname,
           "notes": [appname + " v" + ver + " 发布（" + date + "）"], "download": "", "extract": ""},
          open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}

upload_dir() {  # upload_dir <本地目录> <远端目录> <app> <channel> <过滤正则> <appname>
  local src="$1" rdir="$2" app="$3" ch="$4" filt="$5" appname="$6"
  local n=0 f
  while IFS= read -r f; do
    bdpan mkdir "$rdir" >/dev/null 2>&1
    up "$f" "$rdir/$(basename "$f")" && n=$((n+1))
  done < <(find "$src" -maxdepth 1 -type f -name "*${VERU}*" 2>/dev/null | grep -E "$filt")
  [ "$n" -eq 0 ] && { echo "  [$app/$ch] 无 $VERU 产物，跳过"; return 0; }
  mk_latest "$app" "$ch" "$appname"
  # share 为付费接口，失败不阻塞；download 字段留空由发布人补直读地址
  SHARE_OUT="$(bdpan share "$rdir" -d 30 2>/dev/null | tr -d '\r')"
  LINK="$(echo "$SHARE_OUT" | grep -oE 'https?://pan\.baidu\.com/s/[0-9A-Za-z_-]+' | head -1)"
  CODE="$(echo "$SHARE_OUT" | grep -oE '提取码[：: ]*[0-9a-zA-Z]{4}' | grep -oE '[0-9a-zA-Z]{4}$' | head -1)"
  python - "$TMP/latest_${app}_${ch}.json" "$LINK" "$CODE" <<'PY'
import json, sys
p, link, code = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p, encoding="utf-8"))
d["download"] = link or ""
d["extract"] = code or ""
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
  up "$TMP/latest_${app}_${ch}.json" "$rdir/latest.json" && n=$((n+1))
  echo "  [$app/$ch] 完成：$n 个文件（分享链接: ${LINK:-未生成}）"
}

echo "  版本 $VERU → 网盘 $BASE/"

# 古建：单通道 → public 目录（releases/ 中古建产物）
upload_dir "releases" "$BASE/gujian/public" "gujian" "public" "古建景点打卡" "古建景点打卡"

# 清理临时目录（改名残留，避免 safe-delete 拦截）
mv "$TMP" "$TMP.done" 2>/dev/null || true
echo "  上传流程结束"
exit 0
