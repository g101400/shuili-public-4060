# -*- coding: utf-8 -*-
"""
纯 Python 构建「水利工程一张图」Debian 包 (.deb)，零外部依赖
（不依赖 fpm / dpkg / WSL / Ruby）。

等价还原 electron-builder --linux deb 的 control 参数（取自其 fpm 调用）。
适用：Windows 本机无法装 fpm 时，仍可由任意装有 Python3 的机器生成合规 deb。

用法：
  python build_deb.py [uos_app_dir]
  uos_app_dir 默认: D:/Users/WorkBuddy/shuili/native-shell/uos-water-pyqt6
"""
import os, io, sys, tarfile, lzma, hashlib, re

DEFAULT_UOS = r"D:/Users/WorkBuddy/shuili/native-shell/uos-water-pyqt6"

# ---- 与 package.json / electron-builder fpm 调用一致的元数据 ----
APP_NAME    = "shuili-yitu"
PRODUCT     = "水利工程基础信息一张图"
VERSION     = "4.03"
ARCH        = "amd64"
INSTALL_DIR = "/opt/" + PRODUCT
MAINTAINER  = "yanbing <yanbing@techpromo.cn>"
URL         = "https://github.com/g101400/shuili-yitu"
DESCRIPTION = "水利工程基础信息一张图（天地图底图 · 地图标记 · 知识库 · 支持离线）"
DEPENDS     = "libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0"
RECOMMENDS  = "libappindicator3-1"
EXEC_BIN    = INSTALL_DIR + "/" + APP_NAME

POSTINST = """#!/bin/bash
set -e
if [ -x /usr/bin/update-desktop-database ]; then
  update-desktop-database /usr/share/applications || true
fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then
  gtk-update-icon-cache -f /usr/share/icons/hicolor || true
fi
exit 0
"""
POSTRM = POSTINST

DESKTOP = """[Desktop Entry]
Name=%s
Comment=浏览、筛选、增删改、多照片、ovkmz 导入导出
Exec=%s
Icon=%s
Terminal=false
Type=Application
Categories=Utility;Office;
""" % (PRODUCT, EXEC_BIN, APP_NAME)

CONTROL = """Package: %s
Version: %s
Section: utility
Priority: optional
Architecture: %s
Depends: %s
Recommends: %s
Maintainer: %s
Description: %s
 %s
Vendor: %s
"""


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_entries(uos_app):
    linux_unpacked = os.path.join(uos_app, "release", "linux-unpacked")
    icon = os.path.join(uos_app, "jingmi_app", "icon-512.png")
    entries = []  # (src, arcpath)
    for root, dirs, files in os.walk(linux_unpacked):
        # 剪枝 repack 残留临时目录与缓存目录（2026-08-23 曾只剪 _asar_ext_*；08-26 实测 _asar_old_*/
        # _asar_clean_*/_c/_extr/app.asar.bak_*/app.asar.repacked_* 也全被打进 deb → 2026-08-27 统一前缀剪枝）
        dirs[:] = [d for d in dirs if not d.startswith(("_asar_", "_c", "_extr", ".trash", "__pycache__", "node_modules"))]
        for fn in files:
            if fn.startswith(("_asar_", "app.asar.bak", "app.asar.repacked", "app.asar.orig",
                              "_smoke", "_verify", "prep_", "build_")) or fn.endswith((".log", ".bak")):
                continue
            src = os.path.join(root, fn)
            rel = os.path.relpath(src, linux_unpacked).replace(os.sep, "/")
            entries.append((src, INSTALL_DIR + "/" + rel))
    entries.append((icon, "/usr/share/icons/hicolor/512x512/apps/%s.png" % APP_NAME))
    # desktop 临时落盘
    desktop_tmp = os.path.join(uos_app, "release", "_shuili.desktop")
    with io.open(desktop_tmp, "w", encoding="utf-8") as f:
        f.write(DESKTOP)
    entries.append((desktop_tmp, "/usr/share/applications/%s.desktop" % APP_NAME))
    return entries, desktop_tmp


def is_elf(path):
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except Exception:
        return False


def build_data_tar_xz(uos_app, entries):
    tmp_tar = os.path.join(uos_app, "release", "_data.tar")
    md5lines = []
    with tarfile.open(tmp_tar, "w", format=tarfile.GNU_FORMAT) as tf:
        # 先按层级补加目录成员（dpkg 要求 data.tar 含目录条目，否则解压报
        # 「无法创建 xxx.dpkg-new: 没有那个文件或目录」）；父级在前、子级在后。
        # 注意：目录名须与文件条目一致（去前导 /，如 opt/水利工程一张图），否则 dpkg 仍对不上父目录
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
                ti.mode = 0o755 if is_elf(src) else 0o644
                with open(src, "rb") as f:
                    tf.addfile(ti, f)
            else:
                tf.addfile(ti)
            # md5sums 用归档内完整相对路径（去掉前导斜杠即可；曾去掉 /opt/xxx 前缀导致 dpkg 校验找不到文件报「deb 损坏」）
            arc_rel = arc.lstrip("/")
            md5lines.append("%s  %s" % (md5_of(src), arc_rel))
    md5sums = "\n".join(md5lines) + "\n"
    tmp_xz = os.path.join(uos_app, "release", "_data.tar.xz")
    with open(tmp_tar, "rb") as fin, lzma.open(tmp_xz, "wb", preset=1, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64) as fout:
        fout.write(fin.read())
    safe_rm(tmp_tar)
    return tmp_xz, md5sums


def build_control_tar_xz(uos_app, md5sums, ver):
    tmp = os.path.join(uos_app, "release", "_control.tar")
    with tarfile.open(tmp, "w", format=tarfile.GNU_FORMAT) as tf:
        def add_str(name, content, mode):
            b = content.encode("utf-8")
            ti = tarfile.TarInfo(name)
            ti.size = len(b)
            ti.mode = mode
            ti.mtime = 0
            ti.type = tarfile.REGTYPE
            tf.addfile(ti, io.BytesIO(b))

        control_text = CONTROL % (APP_NAME, ver, ARCH, DEPENDS, RECOMMENDS, MAINTAINER, DESCRIPTION, DESCRIPTION, MAINTAINER)
        add_str("control", control_text, 0o644)
        add_str("postinst", POSTINST, 0o755)
        add_str("postrm", POSTRM, 0o755)
        add_str("md5sums", md5sums, 0o644)
    tmp_xz = os.path.join(uos_app, "release", "_control.tar.xz")
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
    assert any(n.endswith("/" + APP_NAME) for n in dnames), "data.tar 缺主程序 " + APP_NAME
    assert any(n.endswith(".desktop") for n in dnames), "data.tar 缺 desktop"
    # 2026-08-30 加固：app-builder 半途而废可致 linux-unpacked 残缺（缺 icudtl/libEGL/…），
    # 仅查主程序存在会漏检（主程序先复制完）。补查 electron 运行必需文件，缺一即炸。
    for _crit in ("icudtl.dat", "libEGL.so", "libGLESv2.so", "libffmpeg.so",
                  "chrome-sandbox", "chrome_100_percent.pak"):
        assert any(n.endswith("/" + _crit) for n in dnames), "data.tar 缺 electron 核心文件 " + _crit
    print("  [自校验] ar成员=%s" % list(members))
    print("  [自校验] control成员=%s" % cnames)
    print("  [自校验] data主程序存在=%s, desktop存在=%s" % (
        any(n.endswith("/" + APP_NAME) for n in dnames),
        any(n.endswith(".desktop") for n in dnames)))
    print("  [自校验] 通过 ✓")


def safe_rm(p):
    """中间文件清理：safe-delete shim 对删除硬退出（BULK_CONFIRM）→ 改用改名残留（.done），绝不中断构建。"""
    try:
        if os.path.exists(p):
            os.rename(p, p + ".done")
    except Exception:
        pass


def load_meta(uos_app):
    """从 uos_app/package.json 读产品元数据（三套通用：水利/古建/视频）；缺省回退水利默认值。"""
    import json as _json
    meta = dict(PRODUCT=PRODUCT, APP_NAME=APP_NAME, DESCRIPTION=DESCRIPTION, URL=URL)
    pj = os.path.join(uos_app, "package.json")
    try:
        with open(pj, encoding="utf-8") as f:
            j = _json.load(f)
        jb = j.get("build", {}) or {}
        if jb.get("productName"):
            meta["PRODUCT"] = jb["productName"]
        elif j.get("productName"):
            meta["PRODUCT"] = j["productName"]
        if j.get("name"):
            meta["APP_NAME"] = j["name"]
        if j.get("description"):
            meta["DESCRIPTION"] = j["description"]
        if j.get("homepage"):
            meta["URL"] = j["homepage"]
    except Exception:
        pass
    return meta

def main():
    global PRODUCT, APP_NAME, DESCRIPTION, URL, INSTALL_DIR, EXEC_BIN, DESKTOP
    uos_app = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_UOS
    if not os.path.isdir(uos_app):
        print("ERROR: uos_app 不存在: %s" % uos_app)
        sys.exit(1)
    meta = load_meta(uos_app)
    PRODUCT = meta["PRODUCT"]; APP_NAME = meta["APP_NAME"]
    DESCRIPTION = meta["DESCRIPTION"]; URL = meta["URL"]
    INSTALL_DIR = "/opt/" + PRODUCT
    EXEC_BIN = INSTALL_DIR + "/" + APP_NAME
    DESKTOP = """[Desktop Entry]
Name=%s
Comment=浏览、筛选、增删改、多照片、ovkmz 导入导出
Exec=%s
Icon=%s
Terminal=false
Type=Application
Categories=Utility;Office;
""" % (PRODUCT, EXEC_BIN, APP_NAME)
    # 版本跟随单一事实来源 jingmi_app/js/app.js 的 APP_VER（去掉前导 v）
    # ver_short（文件名用）：2026-08-31 起用完整版本号（如 2.4.1 → V2.4.1，与 APK/PWA/Win11 命名一致）。
    #   曾取前两段（2.4.1 → V2.4）致「deb 文件名 V2.4 vs APK/PWA V2.4.1」漂移、verify 按完整版本匹配 FAIL。
    # ver_full（control Version 用，如 2.4.1）：dpkg semver 规范，与 mips64el deb / Win11(package.json 2.4.1) 一致
    ver_short = VERSION.lstrip("v")
    ver_full = ver_short
    appjs = os.path.join(uos_app, "jingmi_app", "js", "app.js")
    if os.path.isfile(appjs):
        try:
            mm = re.search(r'APP_VER\s*=\s*"v([0-9.]+)"', open(appjs, encoding="utf-8").read())
            if mm:
                v = mm.group(1)
                parts = v.split(".")
                ver_short = v  # 完整版本号（2026-08-31 统一，不再取前两段）
                parts2 = parts[:]
                while len(parts2) < 3:
                    parts2.append("0")
                ver_full = ".".join(parts2[:3])
        except Exception:
            pass
    out_deb = os.path.join(uos_app, "release", "%sV%s_linux_%s.deb" % (PRODUCT, ver_short, ARCH))

    print("== 收集文件清单 ==")
    entries, desktop_tmp = collect_entries(uos_app)
    print("   文件数=%d" % len(entries))

    print("== 构建 data.tar.xz ==")
    data_xz, md5sums = build_data_tar_xz(uos_app, entries)
    safe_rm(desktop_tmp)
    print("   data.tar.xz size=%d" % os.path.getsize(data_xz))

    print("== 构建 control.tar.xz ==")
    ctrl_xz = build_control_tar_xz(uos_app, md5sums, ver_full)
    print("   control.tar.xz OK (文件名ver=%s, control Version=%s)" % (ver_short, ver_full))

    print("== 合成 .deb ==")
    ctrl_bytes = open(ctrl_xz, "rb").read()
    data_bytes = open(data_xz, "rb").read()
    safe_rm(ctrl_xz)
    safe_rm(data_xz)
    build_ar(out_deb, [
        (b"2.0\n", "debian-binary"),
        (ctrl_bytes, "control.tar.xz"),
        (data_bytes, "data.tar.xz"),
    ])
    print("   deb -> %s" % out_deb)
    print("   size=%d bytes (%.1f MB)" % (os.path.getsize(out_deb), os.path.getsize(out_deb) / 1e6))

    print("== 本机结构自校验 ==")
    self_verify(out_deb)
    print("\n完成。请到统信 UOS (x86_64) 真机执行: sudo dpkg -i %s" % out_deb)


if __name__ == "__main__":
    main()
