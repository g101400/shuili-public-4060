#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纯 Python 构建「水利工程基础信息一张图」UOS / 国产平台 DEB（零外部依赖）
---------------------------------------------------------------------------
不依赖 dpkg / fpm / WSL / Ruby。把 native-shell/uos-water-pyqt6 的 main.py + webroot
打包为 /opt/shuili-map/，并写入启动器 /usr/bin/shuili-map、桌面项、DEBIAN 控制文件，
用 ar + xz 合成合规 .deb（ar 魔数 / debian-binary / control.tar.xz / data.tar.xz 结构
与 dpkg-deb --build 产物一致，可被 dpkg -i / apt 正常安装）。

ar+xz 合成逻辑复用自 build/build_deb.py（已实机验证可被 dpkg 安装、自校验通过）。

默认构建 amd64 / arm64 / loongarch64 / mips64el 四架构 .deb
（Architecture 仅控制元数据，载荷为一致的 python + webroot，跨四类国产平台均可装）。

用法：
  python3 build/build_uos_deb_purepy.py [uos_app_dir]
"""
import os, io, sys, tarfile, lzma, hashlib, shutil, tempfile

DEFAULT_UOS = r"D:/Users/WorkBuddy/shuili/native-shell/uos-water-pyqt6"
PKG = "shuili-map"
VERSION = "4.03.20261024"
PRODUCT = "水利工程基础信息一张图"
ARCHES = ["amd64", "arm64", "loongarch64", "mips64el"]
MAINTAINER = "小七 <xiaoyi@example.com>"
DESCRIPTION = "水利工程基础信息一张图（统信 UOS 原生壳）\n PyQt6 + QWebEngineView 承载网页，取代 :7205 python http.server，无后台服务残留。"

LAUNCHER = """#!/bin/bash
exec python3 /opt/%s/main.py "$@"
""" % PKG

DESKTOP = """[Desktop Entry]
Name=%s
Comment=水利工程设施一张图（原生壳）
Exec=%s
Terminal=false
Type=Application
Icon=webview
Categories=Utility;Science;
""" % (PRODUCT, PKG)

POSTINST = """#!/bin/bash
set -e
if [ -x /usr/bin/update-desktop-database ]; then
  update-desktop-database /usr/share/applications || true
fi
exit 0
"""
POSTRM = POSTINST

CONTROL_TMPL = """Package: %s
Version: %s
Section: utils
Priority: optional
Architecture: %s
Depends: python3, python3-pyqt6, python3-pyqt6.qtwebengine
Maintainer: %s
Description: %s
"""


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _arc_mode(arc):
    if arc.startswith("usr/bin/"):
        return 0o755
    if arc == "opt/%s/main.py" % PKG:
        return 0o644
    return 0o644


def build_data_tar_xz(stage):
    """打包 stage 下的 opt/ 与 usr/（排除 DEBIAN 与临时 _*.tar*）。返回 (xz_path, md5sums)。"""
    entries = []  # (src, arcpath 无前导/)
    for root, dirs, files in os.walk(stage):
        # 剪枝：DEBIAN 控制目录 + 合成过程临时文件
        dirs[:] = [d for d in dirs if d != "DEBIAN" and not d.startswith("_")]
        for fn in files:
            if fn.startswith("_") and (fn.endswith(".tar") or fn.endswith(".tar.xz")):
                continue
            src = os.path.join(root, fn)
            rel = os.path.relpath(src, stage).replace(os.sep, "/")
            entries.append((src, rel))
    tmp_tar = os.path.join(stage, "_data.tar")
    md5lines = []
    with tarfile.open(tmp_tar, "w", format=tarfile.GNU_FORMAT) as tf:
        # 先补目录条目（父在前、子在后），dpkg 解包要求 data.tar 含目录
        dirs = set()
        for _src, arc in entries:
            d = os.path.dirname(arc)
            while d:
                dirs.add(d)
                d = os.path.dirname(d)
        for d in sorted(dirs, key=lambda x: (x.count("/"), x)):
            ti = tarfile.TarInfo(d)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            tf.addfile(ti)
        for src, arc in entries:
            ti = tf.gettarinfo(src, arc)
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            if ti.isreg():
                ti.mode = _arc_mode(arc)
                with open(src, "rb") as f:
                    tf.addfile(ti, f)
            else:
                tf.addfile(ti)
            md5lines.append("%s  %s" % (md5_of(src), arc))
    md5sums = "\n".join(md5lines) + "\n"
    tmp_xz = os.path.join(stage, "_data.tar.xz")
    with open(tmp_tar, "rb") as fin, lzma.open(tmp_xz, "wb", preset=1,
                                               format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64) as fout:
        fout.write(fin.read())
    os.remove(tmp_tar)
    return tmp_xz, md5sums


def build_control_tar_xz(stage, md5sums, arch):
    tmp = os.path.join(stage, "_control.tar")
    with tarfile.open(tmp, "w", format=tarfile.GNU_FORMAT) as tf:
        def add_str(name, content, mode):
            b = content.encode("utf-8")
            ti = tarfile.TarInfo(name)
            ti.size = len(b)
            ti.mode = mode
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            ti.type = tarfile.REGTYPE
            tf.addfile(ti, io.BytesIO(b))

        control_text = CONTROL_TMPL % (PKG, VERSION, arch, MAINTAINER, DESCRIPTION)
        add_str("control", control_text, 0o644)
        add_str("postinst", POSTINST, 0o755)
        add_str("postrm", POSTRM, 0o755)
        add_str("md5sums", md5sums, 0o644)
    tmp_xz = os.path.join(stage, "_control.tar.xz")
    with open(tmp, "rb") as fin, lzma.open(tmp_xz, "wb", preset=1,
                                           format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64) as fout:
        fout.write(fin.read())
    os.remove(tmp)
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
        assert f.read(8) == b"!<arch>\n", "ar 魔数错误"
        members = {}
        while True:
            hdr = f.read(60)
            if len(hdr) < 60:
                break
            name = hdr[0:16].decode().strip()
            size = int(hdr[48:58].decode().strip())
            data = f.read(size)
            if size % 2 == 1:
                f.read(1)
            members[name] = data
    assert "debian-binary" in members and members["debian-binary"] == b"2.0\n", "debian-binary 缺失/错误"
    ctrl = tarfile.open(fileobj=io.BytesIO(members["control.tar.xz"]), mode="r:xz")
    cnames = ctrl.getnames()
    assert "control" in cnames and "md5sums" in cnames, "control.tar 缺 control/md5sums"
    data = tarfile.open(fileobj=io.BytesIO(members["data.tar.xz"]), mode="r:xz")
    dnames = data.getnames()
    assert any(n.endswith("/%s/main.py" % PKG) for n in dnames), "data.tar 缺 main.py"
    assert any(n == "opt/%s/webroot" % PKG for n in dnames), "data.tar 缺 webroot 目录"
    assert any(n.endswith(PKG) and n.startswith("usr/bin/") for n in dnames), "data.tar 缺启动器"
    assert any(n.endswith(".desktop") for n in dnames), "data.tar 缺 desktop"
    print("  [自校验] ar成员=%s" % list(members))
    print("  [自校验] control成员=%s" % cnames)
    print("  [自校验] data: main.py/webroot/launcher/desktop 均存在 ✓")
    return True


def build_one(uos_app, arch, out_dir):
    stage = tempfile.mkdtemp(prefix="deb_stage_")
    try:
        data_root = os.path.join(stage, "opt", PKG)
        os.makedirs(os.path.join(stage, "usr", "bin"), exist_ok=True)
        os.makedirs(os.path.join(stage, "usr", "share", "applications"), exist_ok=True)
        os.makedirs(os.path.join(stage, "DEBIAN"), exist_ok=True)
        # 1. webroot + main.py
        shutil.copytree(os.path.join(uos_app, "webroot"), os.path.join(data_root, "webroot"))
        shutil.copyfile(os.path.join(uos_app, "main.py"), os.path.join(data_root, "main.py"))
        # 2. 启动器
        with open(os.path.join(stage, "usr", "bin", PKG), "w", encoding="utf-8") as f:
            f.write(LAUNCHER)
        # 3. 桌面项
        with open(os.path.join(stage, "usr", "share", "applications", "%s.desktop" % PKG),
                  "w", encoding="utf-8") as f:
            f.write(DESKTOP)
        # 4. data + control
        data_xz, md5sums = build_data_tar_xz(stage)
        ctrl_xz = build_control_tar_xz(stage, md5sums, arch)
        out_deb = os.path.join(out_dir, "%s_%s_%s.deb" % (PKG, VERSION, arch))
        build_ar(out_deb, [
            (b"2.0\n", "debian-binary"),
            (open(ctrl_xz, "rb").read(), "control.tar.xz"),
            (open(data_xz, "rb").read(), "data.tar.xz"),
        ])
        print("==> %s (%.1f MB)" % (os.path.basename(out_deb), os.path.getsize(out_deb) / 1e6))
        self_verify(out_deb)
        # 清理临时
        for p in (data_xz, ctrl_xz):
            if os.path.exists(p):
                os.remove(p)
        return out_deb
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main():
    uos_app = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_UOS
    if not os.path.isdir(uos_app):
        print("ERROR: uos_app 不存在: %s" % uos_app)
        sys.exit(1)
    if not os.path.isdir(os.path.join(uos_app, "webroot")):
        print("ERROR: %s 下无 webroot（请先由 shuili/webroot 拷贝）" % uos_app)
        sys.exit(1)
    if not os.path.isfile(os.path.join(uos_app, "main.py")):
        print("ERROR: %s 下无 main.py" % uos_app)
        sys.exit(1)
    out_dir = os.path.join(uos_app, "release")
    os.makedirs(out_dir, exist_ok=True)
    print("== 纯 Python 构建 UOS/国产平台 DEB (v%s) ==" % VERSION)
    print("   源: %s" % uos_app)
    print("   架构: %s" % ", ".join(ARCHES))
    for arch in ARCHES:
        build_one(uos_app, arch, out_dir)
    print("\n完成。产物目录: %s" % out_dir)
    print("真机安装: sudo dpkg -i %s_%s_<arch>.deb" % (PKG, VERSION))


if __name__ == "__main__":
    main()
