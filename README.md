# 水利工程一张图（公开版）

一张图家族 APP —— 水利一张图对外公开发行版本。基于 PWA，支持 Windows / UOS / Android / iOS 四端，内置地图、台账、知识库、网盘导入导出等能力。

> ⚠️ 本仓库为**公开版**：天地图密钥已在提交中剥离（`js/app.js` 的 `TIANDITU_DEFAULT` 置空、`index.html` 不再内联 token）。克隆后地图底图不会自动加载，需自行配置密钥。

## 配置天地图密钥（二选一）

1. **本地密钥文件（推荐，不入库）**：在本目录新建 `secrets/config.local.js`：

   ```js
   window.__CONFIG__ = {
     TIANDITU_TOKEN: "你的浏览器端token",
     TIANDITU_SERVER_TOKEN: "你的服务端token"
   };
   ```

   `index.html` 会优先加载它覆盖占位值。

2. **应用内设置**：打开应用 → 设置 → 天地图密钥管理，手动填入并保存（写入浏览器 localStorage，等效）。

## 目录

- `index.html` / `js/` / `css/` / `lib/`：前端应用
- `data.js` / `data.json`：地图与台账数据
- `build/`：构建与同步脚本
- `secrets/`：密钥占位（`config.js` 已提交，`config.local.js` 本地持有，勿提交）

## 同步到 GitHub

本仓库通过 GitHub REST 内容 API 推送（本机不通 git 协议）。本地更新后运行：

```bash
python build/push.py
```

内部版（含真实密钥，私有）：`shuili-internal-4060`。
