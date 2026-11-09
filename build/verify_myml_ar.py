# -*- coding: utf-8 -*-
"""
UOS deb 铁律独立校验器（出包前必跑，不过不交付）。

校验项（全部来自铁律）：
  1) ar 头「名称」字段(偏移0:16) 必须用空格填充，绝不可出现 NUL(\\x00)；
  2) ar 头「模式」字段(偏移40:48, 8位八进制) 必须为 100644；
  3) 成员 tar 必须用 xz 压缩（control.tar.xz / data.tar.xz 以 xz 魔数开头）；
  4) debian-binary 必须为 2.0；control.tar.xz 含 control+md5sums。

用法：
  python verify_myml_ar.py <包.deb>
退出码 0=通过；非0=违反铁律（不交付）。
"""
import sys, io, tarfile

XZ_MAGIC = b"\xfd7zXZ\x00"

def fail(msg):
    print("  [铁律校验] ✗ 未通过: " + msg)
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("用法: python verify_myml_ar.py <package.deb>")
        sys.exit(2)
    path = sys.argv[1]
    try:
        f = open(path, "rb")
    except OSError as e:
        fail("无法打开包: %s" % e)
    with f:
        sig = f.read(8)
        if sig != b"!<arch>\n":
            fail("ar 魔数错误（不是合法 .deb）: %r" % sig)
        members = {}
        while True:
            hdr = f.read(60)
            if len(hdr) < 60:
                break
            name_field = hdr[0:16]
            mode_field = hdr[40:48]
            size_field = hdr[48:58]
            end_field = hdr[58:60]
            # 1) 名称字段不得含 NUL，且应以空格填充（不允许 NUL 填充）
            if b"\x00" in name_field:
                fail("ar 头名称字段含 NUL 填充（铁律禁止），name=%r" % name_field)
            name = name_field.decode("ascii", "replace").strip()
            # 2) 模式必须为 100644
            try:
                mode = int(mode_field.decode("ascii").strip() or "0", 8)
            except ValueError:
                fail("ar 头模式字段非法: %r" % mode_field)
            if mode != 0o100644:
                fail("ar 头模式=%o 但铁律要求 100644，member=%s" % (mode, name))
            # 4) 结束符必须是 `\\n
            if end_field != b"`\n":
                fail("ar 头结束符非法: %r (member=%s)" % (end_field, name))
            try:
                size = int(size_field.decode("ascii").strip() or "0")
            except ValueError:
                fail("ar 头尺寸字段非法: %r" % size_field)
            data = f.read(size)
            if size % 2 == 1:
                f.read(1)  # 奇数补齐字节
            members[name] = data
        if "debian-binary" not in members:
            fail("缺少 debian-binary 成员")
        if members["debian-binary"] != b"2.0\n":
            fail("debian-binary 内容错误: %r" % members["debian-binary"])
        for m in ("control.tar.xz", "data.tar.xz"):
            if m not in members:
                fail("缺少 %s 成员" % m)
            if not members[m].startswith(XZ_MAGIC):
                fail("%s 未使用 xz 压缩（铁律要求 tar 用 xz）" % m)
        # control.tar.xz 内容校验
        try:
            ctrl = tarfile.open(fileobj=io.BytesIO(members["control.tar.xz"]), mode="r:xz")
            cnames = ctrl.getnames()
        except Exception as e:
            fail("control.tar.xz 解析失败: %s" % e)
        if "control" not in cnames or "md5sums" not in cnames:
            fail("control.tar.xz 缺少 control 或 md5sums")
    print("  [铁律校验] ✓ 通过: ar名称空格填充无NUL / 模式100644 / tar用xz / debian-binary=2.0 / control含control+md5sums")
    print("  [铁律校验] 成员: %s" % list(members))
    sys.exit(0)

if __name__ == "__main__":
    main()
