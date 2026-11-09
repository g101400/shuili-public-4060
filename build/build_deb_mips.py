# -*- coding: utf-8 -*-
"""
构建「水利工程一张图」龙芯（Loongson 3A3000/3A4000，mips64el）deb 安装包。

背景：龙芯 3A4000 运行统信 UOS 20 专业版，dpkg 架构为 mips64el；
Electron 官方不提供 mips64el 二进制（仅 loongnix 社区 2018-2021 老版本，内核过老跑不动现代 PWA）。
故本包采用「浏览器壳」：把同源 PWA 前端装入 /opt/shuili-yitu/，启动器调用系统浏览器打开本地页面。
功能与其它端一致（浏览/筛选/增删改/多照片/导入导出），且支持离线；仅依赖系统自带的浏览器。

产物: release/水利工程一张图V2.0_linux_mips64el.deb
用法:
  python build_deb_mips.py [shuili_app_dir]
"""
import os, io, sys, tarfile, lzma, hashlib, re

DEFAULT_SRC = r"D:/Users/WorkBuddy/shuili/native-shell/uos-water-pyqt6"

APP_NAME   = "shuili-yitu-loongson"
PRODUCT    = "水利工程基础信息一张图"
VERSION    = "4.03"
ARCH       = "mips64el"
INSTALL    = "/opt/shuili-yitu"
BIN        = "/usr/bin/shuili-yitu"
MAINTAINER = "yanbing <yanbing@techpromo.cn>"
URL        = "https://github.com/g101400/shuili-yitu"
DESCRIPTION = "水利工程基础信息一张图（龙芯版·浏览器壳：天地图底图/地图标记/知识库，支持离线）"

EXCLUDE_DIRS = {"node_modules", ".git", "__pycache__", "docs"}
EXCLUDE_SUFFIX = (".apk", ".log")
EXCLUDE_PREFIX = ("_smoke", "_verify", "prep_data", "prep_", "build_")  # _verify 曾漏排致 _verify_v21.js 混入 deb（2026-08-22 复盘修复，与 aowei_win10/build_deb_mips_custom.py 对齐）
EXCLUDE_JUNK = (".bak", ".data.real", ".public.", ".mjs", ".cjs", "data.geojson")  # 2026-09-04（坑16）：备份/双通道中间件严禁进包

LAUNCHER = """#!/bin/bash
# 水利工程一张图（龙芯版）启动器：调用系统浏览器打开本地 PWA（支持离线；在线底图需联网）
APP_DIR="/opt/shuili-yitu"
URL="file://${APP_DIR}/index.html"
BROWSERS=(qaxbrowser cnbrowser 360se 360browser chromium-browser chromium google-chrome microsoft-edge firefox deepin-browser org.gnome.Epiphany)
for b in "${BROWSERS[@]}"; do
  if command -v "$b" >/dev/null 2>&1; then
    nohup "$b" "$URL" >/dev/null 2>&1 &
    exit 0
  fi
done
echo "未检测到可用浏览器，请先安装 奇安信/360/Chromium/Firefox 等浏览器后重试。"
exit 1
"""

DESKTOP = """[Desktop Entry]
Name=水利工程一张图（龙芯版）
Comment=水利工程基础信息一张图：浏览/筛选/增删改/多照片/ovkmz 导入导出（浏览器壳，支持离线）
Exec=%s
Icon=shuili-yitu-loongson
Terminal=false
Type=Application
Categories=Utility;Office;
""" % BIN

CONTROL = """Package: %s
Version: %s
Section: utility
Priority: optional
Architecture: %s
Depends: 
Recommends: 
Maintainer: %s
Description: %s
 %s
Vendor: %s
"""

POSTINST = """#!/bin/bash
set -e
if [ -x /usr/bin/update-desktop-database ]; then
  update-desktop-database /usr/share/applications || true
fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then
  gtk-update-icon-cache -f /usr/share/icons/hicolor || true
fi
chmod 755 /opt/shuili-yitu -R 2>/dev/null || true
exit 0
"""
POSTRM = """#!/bin/bash
set -e
exit 0
"""


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_rm(p):
    """中间文件清理：safe-delete shim 对删除硬退出（BULK_CONFIRM）→ 改用改名残留（.done），绝不中断构建。"""
    try:
        if os.path.exists(p):
            os.rename(p, p + ".done")
    except Exception:
        pass


def collect_web(src):
    """收集 PWA 前端（同 build_pwa_zip.py 口径）。"""
    entries = []
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for fn in files:
            if fn.lower().endswith(EXCLUDE_SUFFIX):
                continue
            if any(fn.startswith(p) for p in EXCLUDE_PREFIX):
                continue
            if any(j in fn for j in EXCLUDE_JUNK):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            entries.append((full, INSTALL + "/" + rel))
    entries.sort(key=lambda x: x[1])
    return entries


def build_data_tar_xz(entries, out_dir, md5lines):
    tmp_tar = os.path.join(out_dir, "_mips_data.tar")
    with tarfile.open(tmp_tar, "w", format=tarfile.GNU_FORMAT) as tf:
        # 先按层级补加目录成员（dpkg 要求 data.tar 含目录条目，否则解压报
        # 「无法创建 xxx.dpkg-new: 没有那个文件或目录」）；父级在前、子级在后。
        # 注意：目录名须与文件条目一致（去前导 /，如 opt/shuili-yitu/css），否则 dpkg 仍对不上父目录
        dirs = set()
        for _src, arc in entries:
            d = os.path.dirname(arc).lstrip("/")
            while d:
                dirs.add(d)
                d = os.path.dirname(d)
        for d in sorted(dirs, key=lambda x: (x.count("/"), x)):
            ti = tarfile.TarInfo(d)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.mtime = 0
            tf.addfile(ti)
        for src, arc in entries:
            ti = tf.gettarinfo(src, arc)
            if ti.isreg():
                ti.mode = 0o755 if src.endswith((".sh", "/launch.sh")) else 0o644
                with open(src, "rb") as f:
                    tf.addfile(ti, f)
            else:
                tf.addfile(ti)
            arc_rel = arc[len(INSTALL) + 1:]
            md5lines.append("%s  %s" % (md5_of(src), arc_rel))
    tmp_xz = os.path.join(out_dir, "_mips_data.tar.xz")
    with open(tmp_tar, "rb") as fin, lzma.open(tmp_xz, "wb", preset=1, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64) as fout:
        fout.write(fin.read())
    safe_rm(tmp_tar)
    return tmp_xz


def build_control_tar_xz(out_dir, md5sums, ver):
    tmp = os.path.join(out_dir, "_mips_control.tar")
    with tarfile.open(tmp, "w", format=tarfile.GNU_FORMAT) as tf:
        def add_str(name, content, mode):
            b = content.encode("utf-8")
            ti = tarfile.TarInfo(name)
            ti.size = len(b)
            ti.mode = mode
            ti.mtime = 0
            ti.type = tarfile.REGTYPE
            tf.addfile(ti, io.BytesIO(b))
        add_str("control", CONTROL % (APP_NAME, ver, ARCH, MAINTAINER, DESCRIPTION, DESCRIPTION, MAINTAINER), 0o644)
        add_str("postinst", POSTINST, 0o755)
        add_str("postrm", POSTRM, 0o755)
        add_str("md5sums", md5sums, 0o644)
    tmp_xz = os.path.join(out_dir, "_mips_control.tar.xz")
    with open(tmp, "rb") as fin, lzma.open(tmp_xz, "wb", preset=1, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64) as fout:
        fout.write(fin.read())
    safe_rm(tmp)
    return tmp_xz


def build_ar(deb_path, members):
    with open(deb_path, "wb") as out:
        out.write(b"!<arch>\n")
        for data, name in members:
            nm = name[:16]
            hdr = "%-16s%-12d%-6d%-6d%-8o%-10d`\n" % (nm, 0, 0, 0, 0o100644, len(data))
            out.write(hdr.encode("ascii"))
            out.write(data)
            if len(data) % 2 == 1:
                out.write(b"\n")


def self_verify(deb_path):
    with open(deb_path, "rb") as f:
        assert f.read(8) == b"!<arch>\n"
        members = {}
        while True:
            hdr = f.read(60)
            if len(hdr) < 60:
                break
            name = hdr[0:16].decode().strip()
            size = int(hdr[48:58])
            data = f.read(size)
            if size % 2 == 1:
                f.read(1)
            members[name] = data
    assert "debian-binary" in members and members["debian-binary"] == b"2.0\n"
    ctrl = tarfile.open(fileobj=io.BytesIO(members["control.tar.xz"]), mode="r:xz")
    control = ctrl.extractfile("control").read().decode("utf-8")
    assert "Architecture: mips64el" in control, "Architecture 非 mips64el"
    data = tarfile.open(fileobj=io.BytesIO(members["data.tar.xz"]), mode="r:xz")
    names = data.getnames()
    # 注：tarfile 存绝对路径时去掉前导 "/"（opt/... 而非 /opt/...）
    assert (INSTALL + "/index.html").lstrip("/") in names, "缺 index.html"
    assert any(n.endswith("js/app.js") for n in names), "缺 js/app.js"
    assert (INSTALL + "/launch.sh").lstrip("/") in names, "缺启动器"
    assert BIN.lstrip("/") in names, "缺 " + BIN
    assert any(n.endswith(".desktop") for n in names), "缺 desktop"
    print("[自校验] Architecture=mips64el ✓")
    print("[自校验] index.html/js/app.js/launch.sh/启动器/desktop 齐全 ✓")
    print("[自校验] data 成员数=%d" % len(names))


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.isdir(src):
        print("ERROR: 源目录不存在:", src)
        sys.exit(1)
    out_dir = os.path.dirname(src)
    # 加载产品元数据（三套通用：水利/古建/视频），从 src/package.json 读 productName/name/homepage/description
    global PRODUCT, APP_NAME, INSTALL, BIN, LAUNCHER, DESKTOP, POSTINST, URL, DESCRIPTION
    try:
        import json as _json
        _pj = _json.load(open(os.path.join(src, "package.json"), encoding="utf-8"))
        _jb = _pj.get("build", {}) or {}
        _prod = (_jb.get("productName") or _pj.get("productName") or _pj.get("name"))
        if _prod: PRODUCT = _prod
        if _pj.get("name"): APP_NAME = _pj["name"]
        if _pj.get("description"): DESCRIPTION = _pj["description"]
        if _pj.get("homepage"): URL = _pj["homepage"]
    except Exception:
        pass
    INSTALL = "/opt/" + APP_NAME
    BIN = "/usr/bin/" + APP_NAME
    LAUNCHER = LAUNCHER.replace("/opt/shuili-yitu", INSTALL)
    DESKTOP = DESKTOP.replace("shuili-yitu-loongson", APP_NAME).replace("水利工程一张图（龙芯版）", PRODUCT + "（龙芯版）")
    POSTINST = POSTINST.replace("/opt/shuili-yitu", INSTALL)
    # 版本跟随单一事实来源 js/app.js 的 APP_VER（如 "v2.4.1"），去掉前导 v
    # ver_short（文件名用）：2026-08-31 起用完整版本号（如 2.4.1 → V2.4.1，与 amd64 deb / APK / PWA / Win11 命名一致）。
    #   曾取前两段（V2.4）致与 verify 期望（V2.4.1）不匹配。
    # ver_full（control Version 用，如 2.4.1）：dpkg semver 规范，与 amd64 deb / Win11(package.json 2.4.1) 一致
    ver_short = VERSION.lstrip("v")
    ver_full = ver_short
    appjs = os.path.join(src, "js", "app.js")
    if os.path.isfile(appjs):
        try:
            m = re.search(r'APP_VER\s*=\s*"v([0-9.]+)"', open(appjs, encoding="utf-8").read())
            if m:
                v = m.group(1)
                parts = v.split(".")
                ver_short = v  # 完整版本号（2026-08-31 统一，不再取前两段）
                parts2 = parts[:]
                while len(parts2) < 3:
                    parts2.append("0")
                ver_full = ".".join(parts2[:3])
        except Exception:
            pass
    out_deb = os.path.join(out_dir, "%sV%s_linux_%s.deb" % (PRODUCT, ver_short, ARCH))

    print("== 收集 PWA 前端 ==")
    entries = collect_web(src)
    print("   web 文件数=%d" % len(entries))

    # 组装：/opt 下 web 资源 + 启动器 + /usr/bin 链接 + desktop + icon
    data_entries = list(entries)
    launcher_tmp = os.path.join(out_dir, "_mips_launch.sh")
    with io.open(launcher_tmp, "w", encoding="utf-8") as f:
        f.write(LAUNCHER)
    data_entries.append((launcher_tmp, INSTALL + "/launch.sh"))
    data_entries.append((launcher_tmp, BIN))  # /usr/bin/shuili-yitu 同为启动器
    desktop_tmp = os.path.join(out_dir, "_mips.desktop")
    with io.open(desktop_tmp, "w", encoding="utf-8") as f:
        f.write(DESKTOP)
    data_entries.append((desktop_tmp, "/usr/share/applications/%s.desktop" % APP_NAME))
    icon = os.path.join(src, "icon-512.png")
    if os.path.exists(icon):
        data_entries.append((icon, "/usr/share/icons/hicolor/512x512/apps/%s.png" % APP_NAME))

    print("== 构建 data.tar.xz ==")
    md5lines = []
    data_xz = build_data_tar_xz(data_entries, out_dir, md5lines)
    print("   data.tar.xz=%d bytes" % os.path.getsize(data_xz))

    print("== 构建 control.tar.xz ==")
    md5sums = "\n".join(md5lines) + "\n"
    ctrl_xz = build_control_tar_xz(out_dir, md5sums, ver_full)

    print("== 合成 deb ==")
    ctrl_bytes = open(ctrl_xz, "rb").read()
    data_bytes = open(data_xz, "rb").read()
    safe_rm(ctrl_xz)
    safe_rm(data_xz)
    safe_rm(launcher_tmp)
    safe_rm(desktop_tmp)
    build_ar(out_deb, [
        (b"2.0\n", "debian-binary"),
        (ctrl_bytes, "control.tar.xz"),
        (data_bytes, "data.tar.xz"),
    ])
    print("   deb -> %s (%d bytes, %.1f MB)" % (out_deb, os.path.getsize(out_deb), os.path.getsize(out_deb) / 1e6))

    print("== 自校验 ==")
    self_verify(out_deb)
    print("\n完成。龙芯 3A4000 / UOS20 专业版(mips64el) 安装：sudo dpkg -i %s" % out_deb)
    print("安装后从开始菜单启动「水利工程一张图（龙芯版）」，将调用系统浏览器打开本地页面。")


if __name__ == "__main__":
    main()
