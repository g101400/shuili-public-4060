# -*- coding: utf-8 -*-
"""
古建单通道同步：把 gujian_app 最新前端同步到 4 个原生壳的 www 目录（约束1：同源保证风格一致）。
仓库相对路径，不写死工作区绝对路径；仅古建映射。
  古建 gujian_app -> build/targets/win11/jingmi_app
                    -> build/targets/uos/jingmi_app
                    -> build/targets/android/app/src/main/assets/www
                    -> build/targets/ios/gujian_pwa
排除垃圾：node_modules/.git/__pycache__/docs(含内部组织名，严禁进公开包)。
排除文件：package.json（勿覆盖 electron 的 package.json）、data.geojson（真实地理数据）。
"""
import os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("GUJIAN_ROOT") or os.path.dirname(HERE)   # 仓库根 = gujian_app
TGT = os.path.join(ROOT, "build", "targets")

EXCLUDE_DIRS = {".git", "node_modules", "__pycache__", "docs", "source_data"}
EXCLUDE_FILES = {"package.json", "data.geojson", "data.json.real"}


def _is_junk(fn):
    return (".bak" in fn or fn.startswith(".data.real")
            or ".public." in fn or fn.endswith((".log", ".mjs", ".cjs"))
            or fn in ("data.geojson",))


MAPS = [
    ("gujian_app", os.path.join(TGT, "win11", "jingmi_app")),
    ("gujian_app", os.path.join(TGT, "uos", "jingmi_app")),
    ("gujian_app", os.path.join(TGT, "android", "app", "src", "main", "assets", "www")),
    ("gujian_app", os.path.join(TGT, "ios", "gujian_pwa")),
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


if __name__ == "__main__":
    for src_rel, dst in MAPS:
        src = os.path.join(ROOT, src_rel)
        if not os.path.isdir(src):
            print("!! 源目录不存在，跳过: %s" % src)
            continue
        n = sync_dir(src, dst)
        # 目标历史垃圾清除（copy2 只增不删：源已排除的 .bak_* 等在目标残留会被打进包）
        removed = 0
        for root, dirs, files in os.walk(dst):
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
        print("%s -> %s: %d 文件已同步（清除目标垃圾 %d）" % (src_rel, dst, n, removed))
    print("DONE")
