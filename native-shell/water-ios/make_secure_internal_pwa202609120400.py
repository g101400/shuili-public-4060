#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
由「内部版 PWA zip」派生「内部加密版 PWA zip」（可放公开仓库）：
  1) 敏感数据 data.js / kb_building_seed.js / ai_seed.js 用 AES-256-GCM(PBKDF2-口令) 加密，
     产物 secure/dat.enc.js（window.__SEC_DATA），原始明文文件从包内删除；
  2) 注入 secure_gate.js：启动先弹口令框，口令正确才解密并注入数据、再按序加载 app.js；
  3) index.html 脚本段替换为 dat.enc.js + secure_gate.js；sw.js 缓存列表同步调整。
"""
import io, json, os, re, subprocess, sys, tempfile, zipfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SEC_CRYPT = os.path.join(HERE, "sec_crypt.js")
SEC_GATE = os.path.join(HERE, "secure_gate.js")
PASS = (os.environ.get("SEC_PASS")
           or (open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sec_pass"),
                    encoding="utf-8").read().strip()
               if os.path.isfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sec_pass")) else ""))
if not PASS:
    sys.exit("[FATAL] 未提供内部口令：请设置环境变量 SEC_PASS，或在脚本同目录创建 .sec_pass 文件。")

SECRETS = ["data.js", "kb_building_seed.js", "ai_seed.js"]
BOOT_SCRIPTS = ["leaflet/leaflet.js", "jszip.min.js", "data.js", "kb_building_seed.js",
                "ovobj_bridge.js", "ai_seed.js", "ai_module.js", "ctx_menu.js", "app.js"]

JOBS = [
    # (内部 zip, 输出 zip)
    (r"D:/Users/Claw/native-shell/water-ios/apple-package/水利工程一张图_iOS_3.68_20260910_可托管.zip",
     r"D:/Users/Claw/native-shell/water-ios/apple-package/水利工程一张图_iOS_3.68_20260910_内部加密_可托管.zip"),
    (r"D:/Users/Claw/native-shell/water-ios/apple-package/水利感知项目一张图_iOS_1.44_20260910_可托管.zip",
     r"D:/Users/Claw/native-shell/water-ios/apple-package/水利感知项目一张图_iOS_1.44_20260910_内部加密_可托管.zip"),
]


def build(src, dst):
    if not os.path.exists(src):
        print("[miss]", src)
        return
    tmp = tempfile.mkdtemp(prefix="pwa_sec_")
    with zipfile.ZipFile(src) as z:
        names = z.namelist()
        z.extractall(tmp)

    # 1) 加密敏感数据
    have = [os.path.join(tmp, f) for f in SECRETS if os.path.exists(os.path.join(tmp, f))]
    if not have:
        print("  [warn] 无敏感数据文件，跳过")
    os.makedirs(os.path.join(tmp, "secure"), exist_ok=True)
    outjs = os.path.join(tmp, "secure", "dat.enc.js")
    r = subprocess.run(["node", SEC_CRYPT, outjs, "__SEC_DATA", PASS] + have,
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("  [FAIL] node sec_crypt:", r.stderr[:400])
        return
    print("  " + r.stdout.strip())
    print("  [enc] %d 个数据文件已加密 -> secure/dat.enc.js (%.2f MB)" %
          (len(have), os.path.getsize(outjs) / 1048576.0))
    for p in have:
        os.remove(p)

    # 2) 注入门禁脚本
    shutil.copy2(SEC_GATE, os.path.join(tmp, "secure_gate.js"))

    # 3) 改写 index.html
    idx = os.path.join(tmp, "index.html")
    s = io.open(idx, encoding="utf-8").read()
    removed = 0
    for b in BOOT_SCRIPTS:
        pat = re.compile(r'[ \t]*<script\s+src="' + re.escape(b) + r'"[^>]*>\s*</script>\s*\n?')
        s, n = pat.subn("", s)
        removed += n
    if "</body>" in s:
        s = s.replace("</body>",
                      '<script src="secure/dat.enc.js"></script>\n'
                      '<script src="secure_gate.js"></script>\n</body>', 1)
    else:
        s += '\n<script src="secure/dat.enc.js"></script>\n<script src="secure_gate.js"></script>\n'
    io.open(idx, "w", encoding="utf-8", newline="").write(s)
    print("  [html] 移除原脚本 %d 个，注入 dat.enc.js + secure_gate.js" % removed)

    # 4) 调整 sw.js 缓存
    sw = os.path.join(tmp, "sw.js")
    if os.path.exists(sw):
        t = io.open(sw, encoding="utf-8").read()
        t = t.replace("'./data.js'", "'./secure/dat.enc.js', './secure_gate.js'")
        t = re.sub(r"(const CACHE\s*=\s*')([^']+)(')", r"\1\2-sec\3", t, count=1)
        io.open(sw, "w", encoding="utf-8", newline="").write(t)
        print("  [sw] 缓存列表已切换为加密载荷")

    # 5) 打包
    keep = [n for n in names if n not in SECRETS]
    if os.path.exists(dst):
        os.remove(dst)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for n in keep:
            z.write(os.path.join(tmp, n), n)
        z.write(os.path.join(tmp, "secure", "dat.enc.js"), "secure/dat.enc.js")
        z.write(os.path.join(tmp, "secure_gate.js"), "secure_gate.js")
    shutil.rmtree(tmp, ignore_errors=True)
    print("  ✅ %s  %.2f MB" % (os.path.basename(dst), os.path.getsize(dst) / 1048576.0))


for src, dst in JOBS:
    print("=====", os.path.basename(src))
    build(src, dst)
print("done")
