# -*- coding: utf-8 -*-
"""v2.4.7 文档同步：软件变更文档 3.25 节 + 用户使用文档第 13 节。"""
import io, os

ROOT = r"D:/Users/WorkBuddy/shuili"

CHANGE_SEC = u"""
### 3.25 v2.4.7（2026-09-05）升级按钮 + 自动升级下载 + 古建单通道 + 发版自动上传网盘

| # | 变更项 | 说明 | 涉及文件 |
|---|---|---|---|
| ① | 「检查新版本」一键按钮 | 设置菜单新增「🔍 检查新版本」：打开升级对话框并立即检测（清单多源逐个容错），发现新版弹出下载入口 | `index.html`、`js/upgrade.js`（`checkNow` 自注册 `swCheckUpdate`） |
| ② | 发现新版自动下载安装包 | 「自动下载」默认开启（可关）：直链 `download` → `fetch` 分块下载（Reader 流式 + 百分比进度）→ `IO.downloadBytes` 本地保存（安卓走 SAF 分块写规避 Binder 1MB 上限）→ 提示安装位置；百度网盘分享页链接 → 自动打开网盘页并备好提取码（分享页需登录，程序无法代取，明确告知不静默）；`filename` 字段可自定义保存名 | `js/upgrade.js`（`startDownload`/`dlFileName`/`autoDlOn`） |
| ③ | 古建改单通道 | 数据本身公开、两端全功能 → 取消内部分版：构建只在公开轮出包（`releases/`），内部轮 `BUILD_APPS=shuili,shipin` 跳过古建；`build_all_v24.sh` 五段（skeleton/Win/UOS/APK/PWA）全部支持 `BUILD_APPS` 过滤；`releases/internal/` 历史古建产物自动清理。水利/感知双通道不变 | `scripts/build_channels.sh`、`build_all_v24.sh`（`want_app`） |
| ④ | 发版自动上传百度网盘 | 构建收尾自动执行 `scripts/upload_release.sh`：安装包 + `latest.json` 上传到网盘 `/apps/bdpan/一张图发布/<应用>/<通道>/`（古建单套→public；水利/感知→public+internal），发起 30 天分享链接写回 `latest.json` 的 `download/extract`；bdpan 未安装/未登录优雅跳过不阻塞构建；`AUTO_UPLOAD=0` 可关 | `scripts/upload_release.sh`、`scripts/build_channels.sh` |
| ⑤ | 版本单一源 | `build_channels.sh` 版本号从 `APP_VER` 动态读取（曾硬编码 V2.4.4 → 升版后 APK 暂存/清理匹配错位） | `scripts/build_channels.sh` |

验证：`verify_backup_v246.mjs` 扩至 **47/47 × 3 端**（新增：自动下载默认开/可关、checkNow 一键检测、网盘链接自动打开、直链分块下载→本地保存字节一致、对话框含自动下载开关）；bash -n 三脚本全过；上传脚本未登录优雅跳过实测。
"""

USER_SEC = u"""
## 13. v2.4.7 新增（2026-09-05）——升级按钮 + 自动升级 + 古建单通道

- **「检查新版本」按钮**：设置菜单新增，点一下立即检测是否有新版本。
- **自动升级**：检测到新版本后**自动开始下载安装包**（有进度提示；安卓下载在通知栏/下载目录，Win 在下载目录，下载完打开即可安装）。如果发布地址是百度网盘分享页，会自动帮您打开网盘页面并复制好提取码。不想要自动下载？软件升级对话框里可以关掉。
- **古建改为单通道**：古建数据本身公开，不再区分公开/内部版，只发布一套全功能包；水利和感知仍分公开/内部两条升级通道，互不干扰。
- **发版自动上传网盘**：每次出新安装包，构建完成后自动上传到百度网盘「一张图发布」目录并生成版本清单（含 30 天分享链接）。
"""

for app, cn in [("shuili","水利"),("gujian","古建"),("shipin","感知")]:
    p = os.path.join(ROOT, app + "_app", "docs", "软件变更文档.md")
    s = io.open(p, encoding="utf-8").read()
    if "3.25 v2.4.7" not in s:
        io.open(p, "w", encoding="utf-8", newline="").write(s.rstrip() + "\n" + CHANGE_SEC)
        print("[OK] 变更", app)
    p2 = os.path.join(ROOT, app + "_app", "docs", "用户使用文档.md")
    s2 = io.open(p2, encoding="utf-8").read()
    if "## 13. v2.4.7" not in s2:
        io.open(p2, "w", encoding="utf-8", newline="").write(s2.rstrip() + "\n" + USER_SEC)
        print("[OK] 使用", app)
print("DONE")
