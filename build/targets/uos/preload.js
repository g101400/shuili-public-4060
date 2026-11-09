/* preload.js —— 水利工程一张图 桥接层
 * 以 window.AndroidBridge 名义注入（前端 app.js/io.js 全部走 window.AndroidBridge 且带守卫），
 * 桌面版实现文件保存/照片持久化/全图加载等；网盘/局域网/定位等未注入 → 前端自动走降级 toast。
 * 同步契约（persistImage/loadFullImage/savePhotoB64）用 sendSync 满足。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("AndroidBridge", {
  // 导出：分块写盘（io.js downloadBytes 首选路径）
  exportStart: (name, mime) => ipcRenderer.send("exp-start", { name, mime }),
  exportAppend: (b64) => ipcRenderer.send("exp-append", b64),
  exportCommit: () => ipcRenderer.send("exp-commit"),
  exportFile: (name, b64, mime) => ipcRenderer.send("exp-file", { name, b64, mime }),
  // 照片：全图 base64 落盘（桌面版批量导入/ovkmz 导入压缩链路）
  savePhotoB64: (b64, name) => ipcRenderer.sendSync("photo-save-b64", { b64, name }),
  // 全图加载（灯箱/导出）：支持绝对路径 / imgdata 相对 / photos 相对
  loadFullImage: (fullPath) => {
    try { return ipcRenderer.sendSync("photo-load", fullPath); } catch (e) { return null; }
  },
  // 临时文件迁入持久目录（桌面版基本无临时目录，兼容保留）
  persistImage: (fullPath) => { try { return ipcRenderer.sendSync("photo-persist", fullPath); } catch (e) { return ""; } },
  // 清理临时目录（no-op 语义，主进程已处理）
  cleanInbox: () => ipcRenderer.send("inbox-clean"),
  // 定位设置：桌面版降级
  openLocationSettings: () => { /* 桌面版无系统定位设置跳转，前端有降级提示 */ }
});
