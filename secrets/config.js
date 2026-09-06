// 提交的占位配置模板（已入库）。真实密钥见同目录 config.local.js（本地，.gitignore 排除）。
// 加载顺序：index.html 先加载 config.local.js（若存在则覆盖下方值），再加载本文件只做兜底填充。
// 克隆仓库且无 config.local.js 时，下方为空占位——应用内地图底图不会加载，直到你填入真实 token。
window.__CONFIG__ = window.__CONFIG__ || {
  TIANDITU_TOKEN: "",
  TIANDITU_SERVER_TOKEN: ""
};
