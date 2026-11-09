# 水利工程基础信息一张图 · 构建手册（水利一张图）

> 构建脚本继承自单体仓库 `gujian4060`，**所有绝对路径须重指为本工程根 `D:/Users/WorkBuddy/shuili`**。
> 本工程只构建自己的 `webroot/`，绝不引用兄弟工程。

## 原生壳映射

- win-water-webview2（窗口标题：水利工程基础信息一张图）
- uos-water-pyqt6（统信 UOS / 麒麟 的 PyQt6 壳）
- water-ios（iOS 可托管 PWA zip）

## 各端构建

### Android（APK）
- `build/targets/android/app/src/main/java/com/...` 包名须改为 `com.shuili.yitu`。
- 入口：`build/targets/android/build_apk.sh`（或 `build/build_all_v24.sh`）。

### Windows（exe / msi）
- 壳：`native-shell/win-<x>/Program.cs` + `build_msi.wxs`。
- 壳以 `AppContext.BaseDirectory/webroot` 承载网页，标题见上表。
- 出 exe：`dotnet publish -c Release`；出 msi：`candle.exe` + `light.exe`（WiX）基于 `build_msi.wxs`。

### 统信 UOS / 麒麟（deb，x86_64 / arm64 / mips64el）
- 壳：`native-shell/uos-<x>/main.py` + `build_deb.sh`；以 `WEBROOT=<壳目录>/webroot` 承载。
- 出包：`bash native-shell/uos-<x>/build_deb.sh`。

### iOS（PWA 可托管包）
- 脚本：`native-shell/water-ios/build_ios_zip.py`（仅 shuili 含 iOS 壳）。
- 产出 `.zip` 企业可分发包（非 App Store .ipa）。

## 构建脚本目录

`build/` 继承自单体仓库 `gujian4060` 的构建/发版脚本，常用：
- `build_all_v24.sh` / `build_all_guijian.sh` —— 一键构建入口（**内部绝对路径须重指为本工程根**）。
- `build_deb.py` / `build_deb_mips.py` —— deb 打包；`finalize_debs.sh` —— deb 收尾。
- `bump_v*.py` —— 版本号自增；`docs_v*.py` —— 文档生成。
- `publish_release.py` / `upload_release.sh` —— 发布/上传。
- `push.py` / `sync_*.py` / `sync_targets.py` —— 同步到各端；`targets/` —— Android Gradle 工程。
- `make_public_data.py` / `gen_feature_matrix.py` / `verify_myml_ar.py` —— 数据脱敏 / 特性矩阵 / 校验。

## 关键规则（防互相影响 / 防假绿）

1. 每个工程只构建自己的 `webroot/`，绝不引用兄弟工程目录。
2. 构建脚本路径用 `PROJECT_ROOT` 锚定，禁止 CWD 相对路径。
3. 出包前清同版本旧包，避免 `_bak_*` / `webroot_bak_*` 夹带污染（曾把安装包撑大 50 倍）。
4. 门禁断言计数必须 >0 且等于登记下限，零覆盖「全部通过」是假绿。
