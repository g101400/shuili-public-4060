#!/usr/bin/env bash
# 古建景点打卡 单通道构建入口（self-contained 总编排）
# 流程：① 确保通道=public（单通道，无脱敏/无内部轮）② 预生成骨架 ③ 同步到 4 原生壳 ④ 四端打包 ⑤（可选）上传网盘
# 用法：bash build_guijian.sh            # 默认自动上传网盘（bdpan 未登录则优雅跳过）
#       AUTO_UPLOAD=0 bash build_guijian.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PR="$(cd "$SCRIPT_DIR/.." && pwd)"          # 仓库根 = gujian_app
cd "$PR" || exit 1

echo "===== 古建单通道构建（channel=public，单通道）====="

# ① 单通道：始终 public（与仓库内 index.html 默认一致；这里幂等兜底）
sed -i 's/window.__BUILD_CHANNEL__ = "[a-z]*"/window.__BUILD_CHANNEL__ = "public"/' index.html

# ② 骨架（保险；build_all 内部也会做）
[ -f data.json ] && ( node gen_kb_skeleton.mjs >/dev/null ) || true

# ③ 同步到 4 原生壳（win11/uos/android/ios 的 www）
python "$SCRIPT_DIR/sync_guijian.py" || { echo "!! 同步失败"; exit 1; }

# ④ 四端打包
bash "$SCRIPT_DIR/build_all_guijian.sh" || { echo "!! 构建失败"; exit 1; }

# ⑤ 发版后自动上传百度网盘（可选，未登录/CLI 缺失时优雅跳过）
if [ "${AUTO_UPLOAD:-1}" = "1" ]; then
  echo "===== 自动上传百度网盘 ====="
  bash "$SCRIPT_DIR/upload_release.sh" || echo "  (网盘上传未完成——不影响本地产物，登录 bdpan 后重跑 scripts/upload_release.sh 即可)"
fi

echo "===== 古建构建完成 ====="
ls -l releases | grep -E "V2\.4" | awk '{print $9}'
