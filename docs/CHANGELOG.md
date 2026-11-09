# 水利工程基础信息一张图 · 版本变更记录（水利一张图）

当前版本：**4.03**（code 103）　buildDate：**2026-10-24**

## 2026-10-24 · 自我完善周期（v4.03）

- 工程目录路径修正：交接文档 AGENT_HANDOFF 中工程目录由错误的 `D:/Users/WorkBuddy/水利一张图/` 更正为真实目录 `D:/Users/WorkBuddy/shuili/`。
- 构建脚本隔离收尾：修复 `build/push.py`、`build/build_deb.py`、`build/build_deb_mips.py`、`build/publish_release.py` 中遗留的 GitHub 仓库引用 `g101400/gujian4060`（及 `aowei_win10` 旧路径、古建产品元数据），统一收口为 `g101400/shuili-yitu` 与水利工程基础信息一张图产品标识，消除跨工程串扰。
- 配置环境清理：清理 `native-shell/` 三个壳内时间戳冗余备份文件（如 `build_ios_zip202608*.py`、`Program202608*.cs`、`build_deb202608*.sh`、`make_secure_internal_pwa_20260921_*.py`、`dist_20260921_023043/`），移出源树至工程外 `_bak_` 归档，源树仅保留当前生效脚本（0 删除原则仅针对功能菜单；构建脚本冗余备份可清理）。
- 门禁与帮助同步：版本号升至 **4.03**（code 103），版本变更与帮助同步更新。
- Android 构建脚本去古建串扰：修正 `build/targets/android/build_apk.sh` 与 `README.md` 中遗留的 `古建景点打卡`/`GujianApp`/`com/gujian` 等古建产品引用，统一为 `水利工程基础信息一张图`/`ShuiliYitu`/`com/shuili`。
- 四平台打包（v4.03 自我完善周期续）：
  - **UOS / 国产平台 DEB（已产出）**：新增 `build/build_uos_deb_purepy.py`（纯 Python 合成 `ar`+`xz`，不依赖 `dpkg`/`fpm`/`WSL`），实机构建 `shuili-map_4.03.20261024_{amd64,arm64,loongarch64,mips64el}.deb`（各 ≈7.8MB），自校验通过（`debian-binary`/`control.tar.xz`/`data.tar.xz` 结构合规，含 `/opt/shuili-map/{main.py,webroot}`、`/usr/bin/shuili-map` 启动器、桌面项）。
  - **Win EXE**：由 `dotnet publish -c Release -r win-x64`（.NET 8 + WebView2 单文件）实机构建，产物为 `水利工程基础信息一张图.exe`。
  - **Android APK ✅ 已实出（环境工具链后半段就绪）**：构建于 `android_build/ShuiLiApp`（`com.shuili`，gradle `assembleRelease` 签名，版本 4.03/103），内嵌当前 `webroot`（已剥离启动凭据 `secure_boot_cred.js`），产物 `releases/ShuiliYituV4.03_20261024.apk`（≈8.5MB），已上传百度网盘（`apps/bdpan/一张图发布/shuili/public/`）与 GitHub Release v4.03。**注**：`build/targets/android/` 仍是带古建串扰的陈旧副本，真实可用 APK 工程在 `android_build/ShuiLiApp`，后续应将其归一化入仓。
  - **Win MSI 🔴 仍缺 `WiX`（`candle`/`light`）未实出**；**iOS PWA zip 🔴 仍缺 `apple-package` 基线未实出**。两项为环境工具链缺口（非代码缺陷）。

## 2026-10-22 · 三项目独立化（重要）

- 从单体仓库 `gujian4060` 拆分为独立工程 `D:/Users/WorkBuddy/shuili/`，webroot 独立、互不引用。
- 独立 Git 仓库（分支 main）、独立根文档与构建脚本、独立 .gitignore。
- 功能与菜单 **0 删除**（webroot 与源逐字节一致，已对账）。

## 已知特性要点（继承）

- 类型图形图标：地图标记按工程类型显示专属图形（闸/泵/渠/桥智能匹配），图例同步图标化。
- AI 子菜单默认隐藏，可一键显示/隐藏（公开版策略：AI 可用 + 组织信息脱敏拟真）。
- 运行维护菜单含「备忘录」；设置菜单含软件升级 / 数据导出 / 导入。
- 支持从奥维互动地图（OvitalMap）采集的坐标对象经 ovobj_bridge.js 桥接导入，照片以「附件」呈现。

> 完整迭代见各版本发布说明；本文件仅记录独立化后要点。接手智能体见 `AGENT_HANDOFF.md`。
