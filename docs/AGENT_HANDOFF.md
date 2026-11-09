# 水利工程基础信息一张图 · 智能体接手说明（AGENT_HANDOFF）

> 本文件是「详细说明」：**其他智能体依据本压缩包进行下一步开发」的首要阅读对象。
> 本工程是 `gujian4060` 单体仓库拆分出的三个独立工程之一（另两个：shuili 水利 / gujian 古建 / perc 感知），请只负责本工程。

---

## 0. 接手范围（必读）

- 你接手的是 **水利工程基础信息一张图** 的独立工程，目录 `D:/Users/WorkBuddy/shuili/`。
- 你是**唯一负责本项目**的智能体：**不要触碰** `D:/Users/WorkBuddy/shuili/`、`D:/Users/WorkBuddy/gujian/`、`D:/Users/WorkBuddy/perc/` 中**非本项目**的目录与 Git 仓库。
- 包名 `com.shuili.yitu`，版本 `4.02`（code 102），数据量 557 条工程记录（recordCount）。

## 1. 应用是什么

水利工程管理单位的水利工程基础信息「一张图」：涵盖水渠道与闸/坝/泵站/涵洞等水工建筑物，支持地图展示、类型图形标记、采集与数据导入，目标是在手机端与电脑端都能查看。

**已知特性：**
- 类型图形图标：地图标记按工程类型显示专属图形（闸/泵/渠/桥智能匹配），图例同步图标化。
- AI 子菜单默认隐藏，可一键显示/隐藏（公开版策略：AI 可用 + 组织信息脱敏拟真）。
- 运行维护菜单含「备忘录」；设置菜单含软件升级 / 数据导出 / 导入。
- 支持从奥维互动地图（OvitalMap）采集的坐标对象经 ovobj_bridge.js 桥接导入，照片以「附件」呈现。

## 2. 技术栈与运行方式

- 纯前端 **Web 单页应用**（HTML/JS + Leaflet 地图），由原生壳承载：
  - Windows → WebView2（`win-<x>/Program.cs`）
  - 统信 UOS / 麒麟 → PyQt6（`uos-<x>/main.py`）
  - iOS → 可托管 PWA zip（`water-ios/`，仅 shuili）
- **本地运行**（开发与调试）：
  ```bash
  cd D:/Users/WorkBuddy/shuili/webroot
  python -m http.server 8080
  # 浏览器打开 http://localhost:8080/index.html
  ```
- 数据来源：data.js 内嵌 557 条工程记录；mdb_reader.js 读取 Access(.mdb) 外部采集数据；ovobj_bridge.js 桥接奥维对象；可经「设置 → 数据导入/导出」增量更新。

## 3. 源码文件地图（webroot/）

- `index.html` —— 入口页，加载 `app.js` 与各模块。
- `app.js` —— **主逻辑（最大文件，切勿整段替换）**：地图渲染、菜单系统、交互、数据绑定。改动须走增量 diff。
- `data.js` / `data.demo.js` —— 内嵌工程/景点/监测数据；**真实 `data.js` 不入库**，仅 `data.demo.js` 模板入库。
- `ai_module.js` —— AI 助手子模块（默认隐藏，可一键切换显示）。
- `kb_core.js` / `kb_rag.js` / `kb_source.js` / `kb_vector.js` / `kb_building_seed.js` —— 本地知识库（核心 / 检索 / 来源 / 向量 / 建筑种子）。
- `ai_seed.demo.js` / `ai_seed.js` —— AI 知识种子；**真实 `ai_seed.js` 不入库**，仅 demo 模板入库。
- `mdb_reader.js` —— 读取 Access `.mdb`（奥维/外部采集数据导入）。
- `ovobj_bridge.js` —— 奥维互动地图（OvitalMap）对象桥接导入。
- `secure_boot.js` / `secure_boot_cred.js` —— 安全启动与凭据。
- `ctx_menu.js` —— 右键 / 上下文菜单。
- `photo_gesture.js` —— 照片手势交互。
- `jszip.min.js` —— 前端 zip 库（数据导出）。
- `leaflet/` —— Leaflet 地图库。
- `ocr/` —— OCR 相关资源。
- `version.json` —— 版本信息（见工程根 `version.json` 同源）。

> 注：真实 `data.js` / `ai_seed.js` / `offline_tiles/` **不入库**（密钥/体积），仅 `*.demo.js` 模板与清单入库；运行需真实数据时可从 `*.demo.js` 复制为同名文件再填值。

## 4. 原生壳与构建脚本

**native-shell/ 文件地图：**
- `win-<x>/Program.cs` —— WebView2 主程序，以 `AppContext.BaseDirectory/webroot` 承载网页；窗口标题见上表。
- `win-<x>/build_msi.wxs` —— WiX 安装包（msi）定义。
- `uos-<x>/main.py` —— PyQt6 主程序，以 `WEBROOT=<壳目录>/webroot` 承载网页。
- `uos-<x>/build_deb.sh` —— deb 打包脚本（x86_64 / arm64 / mips64el）。
- `water-ios/build_ios_zip.py` 等 —— iOS 可托管 PWA 包构建脚本（仅 shuili 含 iOS 壳）。

**build/ 脚本：**
`build/` 继承自单体仓库 `gujian4060` 的构建/发版脚本，常用：
- `build_all_v24.sh` / `build_all_guijian.sh` —— 一键构建入口（**内部绝对路径须重指为本工程根**）。
- `build_deb.py` / `build_deb_mips.py` —— deb 打包；`finalize_debs.sh` —— deb 收尾。
- `bump_v*.py` —— 版本号自增；`docs_v*.py` —— 文档生成。
- `publish_release.py` / `upload_release.sh` —— 发布/上传。
- `push.py` / `sync_*.py` / `sync_targets.py` —— 同步到各端；`targets/` —— Android Gradle 工程。
- `make_public_data.py` / `gen_feature_matrix.py` / `verify_myml_ar.py` —— 数据脱敏 / 特性矩阵 / 校验。

四端构建命令详见 `BUILD.md`。

## 5. 隔离红线（违反会互相影响，不可碰）

1. 目录隔离：三工程根目录互不相同，**不互相 import/require/共享子目录**；新代码只进本项目 `webroot/`。
2. Git 隔离：各自独立仓库 `main` 分支、独立 remote `shuili-yitu`；**禁止**把三工程合进同一仓。
3. 文档/构建脚本隔离：各自根 README/BUILD 与 `build/` 副本，构建脚本绝对路径须重指本工程根。
4. 密钥隔离：`ai_seed.js` 仅保留 `*.demo.js` 模板，真实密钥**不入库**；`.secrets/`、`.github_token` 永不入库。
5. 历史残留隔离：webroot 内**禁止任何 `.bak_*`**；备份落工程外 `<proj>/_bak_<日期>/`。
6. 发版隔离：GitHub 三仓独立推送；百度网盘三个子目录各自归置，互不复用。

## 6. 改动后回归门禁（每次必做）

- - 菜单逐项实跑，确认功能与菜单 **0 删除、0 报错**。
- `webroot` 与基线逐文件对账（缺失 = 0、大小不一致 = 0）—— 见「功能与菜单 0 删除」门禁。
- 构建脚本路径已重指本工程根；出包前清同版本旧包，杜绝 `webroot_bak_*` 夹带污染。
- 密钥零泄露：`ai_seed.js` / `offline_tiles/` 不入库（见 `.gitignore`）。

## 7. 版本与发版

- 版本号见工程根 `version.json`（buildDate 2026-10-22，含「三项目独立化」条目）。
- **GitHub**：独立仓 `shuili-yitu`，`git push -u origin main`（remote 已配 token）。
- **百度网盘**：云端 `/apps/bypy/shuili-yitu/`（四端发版包 APK / exe+msi / deb / iOS zip）。
- 一键发布（本机 `D:/Users/WorkBuddy/_publish_all.py`）：
  ```bash
  python D:/Users/WorkBuddy/_publish_all.py github   # 仅 GitHub
  python D:/Users/WorkBuddy/_publish_all.py baidu    # 仅百度
  python D:/Users/WorkBuddy/_publish_all.py          # 双端同时
  ```
  > 注：百度 token 约 30 天过期，过期后重跑 `python D:/Users/WorkBuddy/_bypy_token.py <新授权码>` 刷新。

## 8. 已知坑清单（近 20 天经验内化）

- **webroot 内禁止 `.bak_*` / `webroot_bak_*`**：曾把安装包从 7.1MB 撑到 346.8MB；备份一律落工程外 `<proj>/_bak_<日期>/`。
- **禁用 `git add -A` 整目录**：曾误把 `assets_bak_*/ai_seed.js` 旧密钥入库，须 `git reset` + 补 `.gitignore`。
- **门禁不得落 `_bak_*`**：须落稳定位置且有真实可执行入口（形态㉘）。
- **门禁断言计数必须 >0 且等于登记下限**：零覆盖的「全部通过」是假绿（形态㊶）；须可构造反例做反向验证（注入假漂移须 exit≠0）。
- **探针必须锚定 PROJECT_ROOT**：CWD 相对路径换目录跑不报错、只给假绿灯（教训52）。
- **日志成功 ≠ 产物实存**：发布后须机器对账产物真实存在（形态㊴）。
- **修复件须进生产实跑**：躺 `_bak_*` 不算修好（形态㊶）。

## 9. 本压缩包内容清单

```
水利一张图_handoff.zip
├── webroot/          应用源码（精选，无 .bak_*/时间戳备份/密钥）
├── native-shell/     原生壳源码（仅本项目，剔除 publish_*/dist_* 构建产物）
├── build/            构建与发版脚本（剔除 __pycache__/*.pyc）
├── docs/             README.md / BUILD.md / 交接卡.md / CHANGELOG.md / AGENT_HANDOFF.md
├── version.json      版本信息
└── .gitignore        工程级忽略规则
```

> 更完整的隔离规范与跨工程经验见 `D:/Users/WorkBuddy/三项目总览与隔离规范.md`。
