# -*- coding: utf-8 -*-
"""
同步三套最新前端到 Win/UOS 五个目标 jingmi_app + iOS PWA 三个目录（约束1：同源保证风格一致）。
映射：
  水利 shuili_app -> win11/jingmi_app, uos_app/jingmi_app, ios/shuili_pwa
  古建 gujian_app -> win11_gujian/jingmi_app, uos_gujian/jingmi_app, ios/gujian_pwa
  视频 shipin_app -> win11_shipin/jingmi_app, uos_shipin/jingmi_app, ios/shipin_pwa
排除垃圾：node_modules/.git/__pycache__/*.apk/docs(已在源内)--仅同步运行所需
PWA 目录仅拷贝运行所需文件；sw.js/manifest.webmanifest/icon-*/platform_matrix.js/prep_data.py 等为 PWA 专有，
shutil.copy2 只复制不删除，这些文件会被保留，不会被源目录覆盖或移除。
"""
import os, shutil

ROOT = r"D:/Users/WorkBuddy/shuili"
WIN = r"D:/Users/WorkBuddy/win11"

EXCLUDE_DIRS = {".git", "node_modules", "__pycache__", "docs", "source_data"}   # docs/含内部组织名，严禁进公开包（2026-09-04）
# ⚠️ 必须排除 package.json：三端 web 源目录(shuili_app/gujian_app/shipin_app)为给龙芯
# build_deb_mips.py 提供 productName/name 而放置了最小 package.json，若同步进 jingmi_app
# 会覆盖 electron 的 package.json（含 main/build/scripts）→ 静默破坏 electron 打包。
EXCLUDE_FILES = {"package.json", "data.geojson", "data.json.real"}   # data.geojson=真实地理数据，严禁进公开包


def _is_junk(fn):
    # 2026-09-04（坑16延伸）：备份/中间数据文件严禁进构建目标——
    # .bak_* 会被打进 APK/PWA/asar/deb（实测 9 个）；data.public.* / .data.real.* 是双通道 staging 中间件；
    # data.geojson = 真实地理数据，公开包泄露实锤（asar 内 316 处真实词）
    return (".bak" in fn or fn.startswith(".data.real")
            or ".public." in fn or fn.endswith((".log", ".mjs", ".cjs"))
            or fn in ("data.geojson",))

MAPS = [
    ("shuili_app", os.path.join(WIN, "jingmi_app")),
    ("shuili_app", os.path.join(ROOT, "three_platforms/uos/uos_app/jingmi_app")),
    ("shuili_app", os.path.join(ROOT, "three_platforms/ios/shuili_pwa")),
    ("gujian_app", os.path.join(ROOT, "win11_gujian/jingmi_app")),
    ("gujian_app", os.path.join(ROOT, "uos_gujian/jingmi_app")),
    ("gujian_app", os.path.join(ROOT, "three_platforms/ios/gujian_pwa")),
    ("shipin_app", os.path.join(ROOT, "win11_shipin/jingmi_app")),
    ("shipin_app", os.path.join(ROOT, "uos_shipin/jingmi_app")),
    ("shipin_app", os.path.join(ROOT, "three_platforms/ios/shipin_pwa")),
    # 安卓 APK（约束：三端四平台同步；apk 端也必须随源更新）
    ("shuili_app", r"D:/Users/WorkBuddy/android_build/ShuiLiApp/app/src/main/assets/www"),
    ("gujian_app", r"D:/Users/WorkBuddy/android_build/GujianApp/app/src/main/assets/www"),
    ("shipin_app", r"D:/Users/WorkBuddy/android_build/ShipinApp/app/src/main/assets/www"),
]

def sync_dir(src, dst):
    os.makedirs(dst, exist_ok=True)
    copied = 0
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        rel = os.path.relpath(root, src)
        tgt_root = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(tgt_root, exist_ok=True)
        for fn in files:
            if fn in EXCLUDE_FILES or _is_junk(fn):
                continue
            s = os.path.join(root, fn)
            d = os.path.join(tgt_root, fn)
            shutil.copy2(s, d)
            copied += 1
    return copied

for src_rel, dst in MAPS:
    src = os.path.join(ROOT, src_rel)
    n = sync_dir(src, dst)
    # 目标历史垃圾清除（copy2 只增不删：源已排除的 .bak_* 等在目标残留会被打进包，坑16）
    removed = 0
    for root, dirs, files in os.walk(dst):
        # docs/ 含内部组织名，历史同步残留一并清除（含路径中间的 docs 目录）
        parts = set(os.path.normpath(root).split(os.sep))
        if "docs" in parts:
            for fn in list(files):
                try:
                    os.remove(os.path.join(root, fn))
                    removed += 1
                except OSError:
                    pass
            continue
        for fn in list(files):
            if _is_junk(fn):
                try:
                    os.remove(os.path.join(root, fn))
                    removed += 1
                except OSError:
                    pass
    print(f"{src_rel} -> {dst}: {n} 文件已同步（清除目标垃圾 {removed}）")
print("DONE")
