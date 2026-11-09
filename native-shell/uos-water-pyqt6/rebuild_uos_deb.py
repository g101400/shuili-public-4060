# -*- coding: utf-8 -*-
"""在 Windows 本机重建统信 UOS 的 shuili-map deb（忠实复刻 build_deb.sh，
因本机无 dpkg-deb，用纯 Python 实现 ar + tar.xz，强制 root 属主）。
用法：python rebuild_uos_deb.py [amd64|arm64|loongarch64|mips64el]
"""
import os, io, sys, tarfile, lzma

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = "shuili-map"
VERSION = "4.02.20261019"  # 在原 4.02.20261018 基础上叠加 mdb_reader 预注入修复
ARCH = sys.argv[1] if len(sys.argv) > 1 else "amd64"
OUT = os.path.join(HERE, f"{PKG}_{VERSION}_{ARCH}.deb")

WEBROOT = os.path.join(HERE, "webroot")
MAIN = os.path.join(HERE, "main.py")
BUILD = os.path.join(HERE, "_deb_build")
APP_DIR = f"/opt/{PKG}"

# 1) 目录骨架
os.system(f"rm -rf \"{BUILD}\"") if False else None
if os.path.isdir(BUILD):
    import shutil; shutil.rmtree(BUILD)
for d in (f"{BUILD}{APP_DIR}", f"{BUILD}/usr/bin", f"{BUILD}/usr/share/applications", f"{BUILD}/DEBIAN"):
    os.makedirs(d, exist_ok=True)

# 2) 拷贝 webroot + main.py
def copytree(src, dst):
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        tdir = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(tdir, exist_ok=True)
        for fn in files:
            with open(os.path.join(root, fn), "rb") as f, open(os.path.join(tdir, fn), "wb") as g:
                g.write(f.read())

copytree(WEBROOT, f"{BUILD}{APP_DIR}/webroot")
with open(MAIN, "rb") as f, open(f"{BUILD}{APP_DIR}/main.py", "wb") as g:
    g.write(f.read())

# 3) 启动器
with open(f"{BUILD}/usr/bin/{PKG}", "w", encoding="utf-8") as f:
    f.write(f"""#!/bin/bash
exec python3 {APP_DIR}/main.py "$@"
""")
os.chmod(f"{BUILD}/usr/bin/{PKG}", 0o755)

# 4) .desktop
with open(f"{BUILD}/usr/share/applications/{PKG}.desktop", "w", encoding="utf-8") as f:
    f.write(f"""[Desktop Entry]
Name=水利工程基础信息一张图
Comment=水利工程设施一张图（原生壳）
Exec={PKG}
Terminal=false
Type=Application
Icon=webview
Categories=Utility;Science;
""")

# 5) control
with open(f"{BUILD}/DEBIAN/control", "w", encoding="utf-8") as f:
    f.write(f"""Package: {PKG}
Version: {VERSION}
Section: utils
Priority: optional
Architecture: {ARCH}
Depends: python3, python3-pyqt6, python3-pyqt6.qtwebengine
Maintainer: 小七 <xiaoyi@example.com>
Description: 水利工程基础信息一张图（统信 UOS 原生壳）
 PyQt6 + QWebEngineView 承载网页，取代 :7205 python http.server，无后台服务残留。
""")

# 6) 打包 data.tar.xz（强制 root 属主）
def walk_files():
    out = []
    for root, dirs, files in os.walk(BUILD):
        rel = os.path.relpath(root, BUILD).replace(os.sep, "/")
        out.append(("dir", rel))
        for fn in files:
            out.append(("file", f"{rel}/{fn}" if rel != "." else fn))
    # 排序：父目录在前
    def key(e):
        p = e[1].lstrip("./")
        return (p.count("/"), p)
    return sorted(out, key=key)

tmp_tar = os.path.join(HERE, "_deb_data.tar")
with tarfile.open(tmp_tar, "w", format=tarfile.GNU_FORMAT) as tf:
    for typ, path in walk_files():
        arc = path.lstrip("./")
        src = os.path.join(BUILD, path)
        if typ == "dir":
            ti = tarfile.TarInfo(arc + "/"); ti.type = tarfile.DIRTYPE; ti.mode = 0o755
        else:
            ti = tf.gettarinfo(src, arc); ti.mode = 0o755 if path.endswith("usr/bin/" + PKG) else 0o644
        ti.uid = ti.gid = 0; ti.uname = "root"; ti.gname = "root"; ti.mtime = 0
        if typ == "dir":
            tf.addfile(ti)
        else:
            with open(src, "rb") as f:
                tf.addfile(ti, f)
tmp_xz = os.path.join(HERE, "_deb_data.tar.xz")
with open(tmp_tar, "rb") as fin, lzma.open(tmp_xz, "wb", preset=9, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64) as fout:
    fout.write(fin.read())
os.remove(tmp_tar)

# 7) control.tar.xz
def make_tar_xz_from_strs(name_contents, out_path):
    tmp = out_path + ".tmp"
    with tarfile.open(tmp, "w", format=tarfile.GNU_FORMAT) as tf:
        for nm, content in name_contents:
            b = content.encode("utf-8") if isinstance(content, str) else content
            ti = tarfile.TarInfo(nm); ti.size = len(b); ti.mode = 0o644; ti.uid = ti.gid = 0
            ti.uname = "root"; ti.gname = "root"; ti.mtime = 0
            tf.addfile(ti, io.BytesIO(b))
    with open(tmp, "rb") as fin, lzma.open(out_path, "wb", preset=9, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64) as fout:
        fout.write(fin.read())
    os.remove(tmp)

ctrl_xz = os.path.join(HERE, "_deb_control.tar.xz")
make_tar_xz_from_strs([("control", open(f"{BUILD}/DEBIAN/control").read())], ctrl_xz)

# 8) 合成 .deb (ar)
def ar_build(out_path, members):
    with open(out_path, "wb") as out:
        out.write(b"!<arch>\n")
        for data, name in members:
            nm = name[:16]
            hdr = "%-16s%-12d%-6d%-6d%-8o%-10d`\n" % (nm, 0, 0, 0, 0o100644, len(data))
            out.write(hdr.encode("ascii")); out.write(data)
            if len(data) % 2 == 1: out.write(b"\n")

db = open(OUT, "wb")
db.write(b"!<arch>\n")
for data, name in [
    (b"2.0\n", "debian-binary"),
    (open(ctrl_xz, "rb").read(), "control.tar.xz"),
    (open(tmp_xz, "rb").read(), "data.tar.xz"),
]:
    nm = name[:16]
    db.write(("%-16s%-12d%-6d%-6d%-8o%-10d`\n" % (nm, 0, 0, 0, 0o100644, len(data))).encode("ascii"))
    db.write(data)
    if len(data) % 2 == 1: db.write(b"\n")
db.close()
for p in (ctrl_xz, tmp_xz):
    os.remove(p)
if os.path.isdir(BUILD):
    import shutil; shutil.rmtree(BUILD)
print("OK ->", OUT, f"({os.path.getsize(OUT)/1024/1024:.1f} MB)")
