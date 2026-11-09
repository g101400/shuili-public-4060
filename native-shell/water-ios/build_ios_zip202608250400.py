#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
水利工程基础信息一张图（water）· iOS 可托管 PWA ZIP 生成器 (V3.29)
--------------------------------------------------
把「water webroot」+「PWA 壳（manifest/sw/icons/readme）」打包成可托管到 HTTPS 的离线 PWA。

PWA 壳来源：上一版 iOS zip 内已含的 manifest.webmanifest / sw.js / icons/ / DEPLOY_README.txt
（这些不是 webroot 的一部分，仅 iOS 托管需要，故从上一版 ZIP 抽取复用）。

用法：
  python3 native-shell/water-ios/build_ios_zip.py
产物：
  native-shell/water-ios/apple-package/水利工程一张图_iOS_3.29_20260822_可托管.zip
"""
import os, re, json, zipfile, shutil, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEBROOT = os.path.join(ROOT, "win-water-webview2", "webroot")   # 复用 water 原生 webroot（V3.29）
APPLE_DIR = os.path.join(ROOT, "water-ios", "apple-package")
STAGE = tempfile.mkdtemp(prefix="water_ios_stage_")
NEW_VER = "3.29.20260822"          # manifest / 元数据版本（点分隔）
FILE_VER = "3.29_20260822"         # 文件名版本段（下划线）
README_VER = "V3.29_20260822"      # DEPLOY_README 内部显示版本（带 V）
OUT_ZIP = os.path.join(APPLE_DIR, "水利工程一张图_iOS_%s_可托管.zip" % FILE_VER)

# webroot 中只打包「网页本体」，排除 Windows 启动器/说明
EXCLUDE_NAMES = {"launch.bat", "http_server.ps1", "安装说明.txt"}

def latest_ios_zip():
    # 固定以「上一稳定版」基线抽取 PWA 壳，避免自引用污染（不读本次刚生成的 zip）
    baseline = os.path.join(ROOT, "..", "APK归档", "四端安装包_20260821", "水利工程一张图_iOS_3.28_20260821_可托管.zip")
    if os.path.exists(baseline):
        return baseline
    zips = [f for f in os.listdir(APPLE_DIR) if f.startswith("水利工程一张图_iOS_") and f.endswith(".zip")]
    zips.sort(key=lambda f: os.path.getmtime(os.path.join(APPLE_DIR, f)), reverse=True)
    return os.path.join(APPLE_DIR, zips[0]) if zips else None

def extract_pwa_shell():
    src = latest_ios_zip()
    if not src:
        raise SystemExit("未找到上一版 iOS zip（首次构建需先放一个基准 zip 到 apple-package/）")
    print("[pwa] 从基线抽取 PWA 壳:", os.path.basename(src))
    with zipfile.ZipFile(src) as z:
        z.extractall(STAGE)
    # 清掉基线里的旧 web 文件，稍后由 webroot 覆盖，避免版本残留
    for fn in ("app.js", "data.js", "index.html", "jszip.min.js"):
        p = os.path.join(STAGE, fn)
        if os.path.exists(p):
            os.remove(p)
    for d in ("leaflet", "images"):
        dp = os.path.join(STAGE, d)
        if os.path.isdir(dp):
            shutil.rmtree(dp)

def sync_webroot():
    print("[web] 同步 water webroot 网页资源 ->", STAGE)
    for name in os.listdir(WEBROOT):
        if name in EXCLUDE_NAMES:
            continue
        s = os.path.join(WEBROOT, name)
        d = os.path.join(STAGE, name)
        if os.path.isdir(s):
            if os.path.isdir(d):
                shutil.rmtree(d)
            shutil.copytree(s, d)
        else:
            shutil.copyfile(s, d)

def bump_meta():
    mp = os.path.join(STAGE, "manifest.webmanifest")
    if os.path.exists(mp):
        data = json.load(open(mp, encoding="utf-8"))
        data["version"] = NEW_VER
        json.dump(data, open(mp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print("[meta] manifest.webmanifest version ->", NEW_VER)
    rp = os.path.join(STAGE, "DEPLOY_README.txt")
    if os.path.exists(rp):
        t = open(rp, encoding="utf-8").read()
        t = re.sub(r"[Vv]3\.\d+_\d+", README_VER, t)
        open(rp, "w", encoding="utf-8").write(t)
        print("[meta] DEPLOY_README.txt 版本已更新")

def build_zip():
    with zipfile.ZipFile(OUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for base, _, files in os.walk(STAGE):
            for fn in files:
                full = os.path.join(base, fn)
                arc = os.path.relpath(full, STAGE).replace(os.sep, "/")
                zf.write(full, arc)
    print("[zip] ->", os.path.relpath(OUT_ZIP, ROOT), os.path.getsize(OUT_ZIP), "bytes")

if __name__ == "__main__":
    os.makedirs(APPLE_DIR, exist_ok=True)
    extract_pwa_shell()
    sync_webroot()
    bump_meta()
    build_zip()
    print("完成：iOS PWA 可托管包 V%s" % README_VER)
