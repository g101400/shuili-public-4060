# 水利工程基础信息一张图 · 工程说明（水利一张图）

- 包名：`com.shuili.yitu`　版本：`4.02`（code 102）　数据量：557 条工程记录（recordCount）
- 独立 Git 仓库：`shuili-yitu`（main 分支）
- 百度网盘子目录：`水利一张图`
- 工程根：`D:/Users/WorkBuddy/shuili/`

## 这是什么

水利工程管理单位的水利工程基础信息「一张图」：涵盖水渠道与闸/坝/泵站/涵洞等水工建筑物，支持地图展示、类型图形标记、采集与数据导入，目标是在手机端与电脑端都能查看。

## 目录（每个工程一致）

```
<proj>/
├── webroot/        应用源码（智能体编辑边界，功能/菜单 0 删除）
├── native-shell/   原生壳源码（Win / UOS [/iOS]，仅本项目）
├── build/          构建与发版脚本（继承自单体仓库，路径须重指本工程根）
├── docs/           README / BUILD / 交接卡 / CHANGELOG / AGENT_HANDOFF
├── version.json    版本信息
└── .gitignore      工程级忽略（offline_tiles/、*.bak、ai_seed.js 等）
```

## 快速开始（本地运行）

```bash
cd D:/Users/WorkBuddy/水利一张图
# 方式一：静态服务 + 浏览器
cd webroot && python -m http.server 8080
# 浏览器打开 http://localhost:8080/index.html
# 方式二：直接双击 webroot/index.html（部分功能需同源，建议用方式一）
```

> 接手智能体请优先阅读本目录 **`AGENT_HANDOFF.md`**（接手详细说明），其中包含隔离红线、回归门禁与发版流程。

## 原生壳映射

- win-water-webview2（窗口标题：水利工程基础信息一张图）
- uos-water-pyqt6（统信 UOS / 麒麟 的 PyQt6 壳）
- water-ios（iOS 可托管 PWA zip）

## 已知特性

- 类型图形图标：地图标记按工程类型显示专属图形（闸/泵/渠/桥智能匹配），图例同步图标化。
- AI 子菜单默认隐藏，可一键显示/隐藏（公开版策略：AI 可用 + 组织信息脱敏拟真）。
- 运行维护菜单含「备忘录」；设置菜单含软件升级 / 数据导出 / 导入。
- 支持从奥维互动地图（OvitalMap）采集的坐标对象经 ovobj_bridge.js 桥接导入，照片以「附件」呈现。

> 隔离规范与经验教训见顶层 `D:/Users/WorkBuddy/三项目总览与隔离规范.md` 与 `D:/Users/WorkBuddy/可交接包/三项目可交接包说明.md`。
