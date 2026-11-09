#!/usr/bin/env bash
# 在统信 UOS 上执行：把 PyQt6 原生壳打包为 DEB（含 webroot 网页资源）。
# 用法：sudo bash build_deb.sh
set -e
PKG="shuili-map"
VERSION="4.03.20261024"
ARCH="${ARCH:-$(dpkg --print-architecture)}"   # 可用 ARCH=mips64el sudo bash build_deb.sh 显式指定目标架构
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/_deb_build"
APP_DIR="/opt/$PKG"

echo "==> 目标架构: $ARCH"
# 1. 目录骨架（父目录条目先于子，避免 dpkg「无法创建目录」）
rm -rf "$BUILD"; mkdir -p "$BUILD/opt/$PKG" "$BUILD/usr/bin" "$BUILD/usr/share/applications" "$BUILD/DEBIAN"
# 2. 拷贝应用（webroot + main.py）
cp -r "$HERE/webroot" "$APP_DIR/"
cp "$HERE/main.py" "$APP_DIR/"
# 3. 启动器（python3 启动 QWebEngineView）
cat > "$BUILD/usr/bin/$PKG" <<EOF
#!/bin/bash
exec python3 $APP_DIR/main.py "\$@"
EOF
chmod 755 "$BUILD/usr/bin/$PKG"
# 4. .desktop
cat > "$BUILD/usr/share/applications/$PKG.desktop" <<EOF
[Desktop Entry]
Name=水利工程基础信息一张图
Comment=水利工程设施一张图（原生壳）
Exec=$PKG
Terminal=false
Type=Application
Icon=webview
Categories=Utility;Science;
EOF
# 5. DEB control（Architecture 用实际架构，四类国产平台均可装）
cat > "$BUILD/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Depends: python3, python3-pyqt6, python3-pyqt6.qtwebengine
Maintainer: 小七 <xiaoyi@example.com>
Description: 水利工程基础信息一张图（统信 UOS 原生壳）
 PyQt6 + QWebEngineView 承载网页，取代 :7205 python http.server，无后台服务残留。
EOF
# 6. 打包
rm -f "$HERE/${PKG}_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$BUILD" "$HERE/${PKG}_${VERSION}_${ARCH}.deb"
echo "==> 产出: $HERE/${PKG}_${VERSION}_${ARCH}.deb"
