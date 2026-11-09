/* main.js —— 水利工程一张图（Windows x64 桌面版）主进程
 * 职责：窗口创建、文件保存/照片持久化/全图加载 IPC、下载接管、导出完成回调、权限与菜单
 * 安全：contextIsolation:true + nodeIntegration:false（本地 file:// 页面，无远程内容）
 */
const { app, BrowserWindow, ipcMain, dialog, session, Menu, shell } = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
// 统信/UOS(常 root 运行)：Electron 必须以 --no-sandbox 启动，否则 Chromium 静默失败（点击图标无反应）
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const APP_TITLE = "水利工程一张图";

// ---------- 目录 ----------
let win = null;
const photosDir = () => path.join(app.getPath("userData"), "photos");
const inboxDir = () => path.join(app.getPath("userData"), "inbox");
const appDir = () => path.join(__dirname, "jingmi_app");

// 照片路径解析：绝对路径 / imgdata 相对（预置全图）/ photos 相对（userData）
function resolvePhoto(fullPath) {
  if (!fullPath) return null;
  if (path.isAbsolute(fullPath)) {
    try { if (fs.existsSync(fullPath)) return fullPath; } catch (e) {}
    return null;
  }
  const cand = [
    path.join(appDir(), fullPath),            // imgdata/xxx.jpg（预置）
    path.join(photosDir(), fullPath),          // photos/xxx.jpg
  ];
  for (const c of cand) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

function toDataUrl(filePath, mime) {
  const b64 = fs.readFileSync(filePath).toString("base64");
  return "data:" + (mime || "image/jpeg") + ";base64," + b64;
}
function mimeOf(p) {
  const e = (path.extname(p) || "").toLowerCase();
  return e === ".png" ? "image/png" : e === ".gif" ? "image/gif" : e === ".webp" ? "image/webp" : "image/jpeg";
}

// ---------- 导出保存（分块累积 → 临时文件 → 完成后改名） ----------
let expState = null; // { part, final }
ipcMain.on("exp-start", async (e, { name, mime }) => {
  try {
    const dir = app.getPath("downloads");
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "导出文件",
      defaultPath: exportDefaultPath(name || "导出.ovkmz"),
      filters: [{ name: "所有文件", extensions: ["*"] }]
    });
    if (canceled || !filePath) { expState = null; return; }
    expState = { part: filePath + ".part", final: filePath };
    fs.writeFileSync(expState.part, Buffer.alloc(0));
  } catch (err) {
    expState = null;
    console.error("exp-start:", err);
  }
});
ipcMain.on("exp-append", (e, b64) => {
  if (!expState) return;
  try {
    const buf = Buffer.from(b64, "base64");
    fs.appendFileSync(expState.part, buf);
  } catch (err) { console.error("exp-append:", err); }
});
ipcMain.on("exp-commit", (e) => {
  if (!expState) { notifyExport(false, "未选择保存位置，导出已取消"); return; }
  try {
    fs.renameSync(expState.part, expState.final);
    notifyExport(true, "已导出：" + expState.final);
  } catch (err) {
    console.error("exp-commit:", err);
    notifyExport(false, "导出写入失败：" + err.message);
  } finally { expState = null; }
});
ipcMain.on("exp-file", async (e, { name, b64, mime }) => {
  try {
    const dir = app.getPath("downloads");
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "导出文件",
      defaultPath: exportDefaultPath(name || "导出"),
      filters: [{ name: "所有文件", extensions: ["*"] }]
    });
    if (canceled || !filePath) { notifyExport(false, "已取消导出"); return; }
    fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
    notifyExport(true, "已导出：" + filePath);
  } catch (err) { notifyExport(false, "导出失败：" + err.message); }
});

function notifyExport(ok, msg) {
  if (!win || win.isDestroyed()) return;
  // 前端在 busy 遮罩里等待 APP.onExportResult 决定成败提示（Android 同契约）
  win.webContents.executeJavaScript(`try { APP.onExportResult(${ok}, ${JSON.stringify(msg)}); } catch (e) {}`).catch(() => {});
}

// ---------- 照片持久化 ----------
// 批量照片/ovkmz 导入的全图 base64 → 写盘 photos/，返回绝对路径（同步，契约要求）
ipcMain.on("photo-save-b64", (e, { b64, name }) => {
  try {
    fs.mkdirSync(photosDir(), { recursive: true });
    const safe = sanitize(name || "photo.jpg");
    const fn = Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex") + "_" + safe;
    const full = path.join(photosDir(), fn);
    fs.writeFileSync(full, Buffer.from(b64, "base64"));
    e.returnValue = full;
  } catch (err) { console.error("photo-save-b64:", err); e.returnValue = ""; }
});
// 全图加载（灯箱/导出/分享用）：返回 data: URL
ipcMain.on("photo-load", (e, fullPath) => {
  try {
    const p = resolvePhoto(fullPath);
    if (!p) { e.returnValue = null; return; }
    e.returnValue = toDataUrl(p, mimeOf(p));
  } catch (err) { console.error("photo-load:", err); e.returnValue = null; }
});
// 导入完成把临时文件迁入 photos/（桌面版基本无临时目录，兼容保留）
ipcMain.on("photo-persist", (e, fullPath) => {
  try {
    if (!fullPath || !path.isAbsolute(fullPath) || !fs.existsSync(fullPath)) { e.returnValue = ""; return; }
    if (fullPath.startsWith(photosDir())) { e.returnValue = fullPath; return; }
    fs.mkdirSync(photosDir(), { recursive: true });
    const fn = path.basename(fullPath);
    const dest = path.join(photosDir(), Date.now().toString(36) + "_" + fn);
    fs.copyFileSync(fullPath, dest);
    e.returnValue = dest;
  } catch (err) { console.error("photo-persist:", err); e.returnValue = ""; }
});
ipcMain.on("inbox-clean", () => {
  try { fs.rmSync(inboxDir(), { recursive: true, force: true }); } catch (e) {}
});

// ---------- 浏览器下载接管（a[download] 兜底路径） ----------
function setupDownload() {
  session.defaultSession.on("will-download", (event, item) => {
    const def = item.getFilename();
    event.preventDefault(); // 先拦下，走保存对话框
    dialog.showSaveDialog(win, {
      title: "保存文件",
      defaultPath: exportDefaultPath(def),
      filters: [{ name: "所有文件", extensions: ["*"] }]
    }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) { item.cancel(); return; }
      item.setSavePath(filePath);
      item.once("done", (ev, state) => {
        if (state === "completed") notifyExport(true, "已保存：" + filePath);
        else notifyExport(false, "保存未完成：" + state);
      });
    }).catch(() => item.cancel());
  });
}

// v2.4.6：导出文件名里的「文件夹/文件名」支持（升级数据导出可自定义文件夹）
// 例："一张图备份/水利一张图备份2026-09-05.bak" → 子目录 ["一张图备份"] + 文件名 "水利...bak"
function splitExportPath(name) {
  const raw = String(name || "").replace(/\\/g, "/");
  const parts = raw.split("/").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { dirs: [], base: "导出" };
  const base = parts.pop();
  const dirs = parts.map((d) => String(d).replace(/[:*?"<>|\n\r\t]+/g, "_").replace(/\.+$/, "").slice(0, 120)).filter(Boolean);
  return { dirs, base };
}
function exportDefaultPath(name) {
  const { dirs, base } = splitExportPath(name);
  const full = path.join(app.getPath("downloads"), ...dirs, sanitize(base));
  try { fs.mkdirSync(path.dirname(full), { recursive: true }); } catch (e) {}
  return full;
}

function sanitize(s) {
  return String(s || "").replace(/[\\/:*?"<>|\n\r\t]+/g, "_").replace(/\.+$/, "").slice(0, 200) || "导出";
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1080, minHeight: 700,
    title: APP_TITLE,
    icon: path.join(__dirname, "build", "icon.ico"),
    backgroundColor: "#0f1b2d",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.js")
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(appDir(), "index.html"));
  // 外链（若有）走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  // 桌面版不支持地理定位 → 拒绝并让前端走降级提示
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === "geolocation") { callback(false); } else { callback(true); }
  });
}

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    fs.mkdirSync(photosDir(), { recursive: true });
    setupDownload();
    createWindow();
    // 中文菜单（帮助/退出）
    const template = [
      { label: "文件", submenu: [{ label: "退出", accelerator: "Alt+F4", click: () => app.quit() }] },
      { label: "视图", submenu: [{ role: "reload", label: "刷新" }, { role: "toggleDevTools", label: "开发者工具" }, { type: "separator" }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" }, { type: "separator" }, { role: "togglefullscreen", label: "全屏" }] },
      { label: "帮助", submenu: [{ label: "关于", click: () => dialog.showMessageBox(win, { type: "info", title: "关于", message: APP_TITLE + " V1.0.0", detail: "天地图底图 · 奥维 ovkmz 互通 · Windows x64\n制作：炎冰（科技推广中心）" }) }] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on("window-all-closed", () => { app.quit(); });
}
