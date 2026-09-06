/* app.js —— 水利工程一张图（增强版：筛选/增删改/多照片/导入导出/定位/导航/测距/周边） */
(function () {
  // ===== v2.4.6 老版本 WebView 兼容垫片（必须在任何业务代码之前执行）=====
  // 缺一个 API 整份 app.js 就初始化中断（表现为「点菜单 → 运行错误:script error.」），
  // 而 app.js 内有数十处 querySelectorAll(...).forEach，逐个改写不现实 → 在此统一补齐。
  (function () {
    try {
      if (typeof NodeList !== "undefined" && NodeList.prototype && !NodeList.prototype.forEach) {
        NodeList.prototype.forEach = Array.prototype.forEach;
      }
      if (typeof HTMLCollection !== "undefined" && HTMLCollection.prototype && !HTMLCollection.prototype.forEach) {
        HTMLCollection.prototype.forEach = Array.prototype.forEach;
      }
      if (!String.prototype.padStart) {
        String.prototype.padStart = function (n, c) {
          c = c == null ? " " : String(c); var s = String(this);
          while (s.length < n) s = c + s; return s;
        };
      }
      if (!String.prototype.padEnd) {
        String.prototype.padEnd = function (n, c) {
          c = c == null ? " " : String(c); var s = String(this);
          while (s.length < n) s = s + c; return s;
        };
      }
      if (!Array.prototype.find) {
        Array.prototype.find = function (pred, thisArg) {
          for (var i = 0; i < this.length; i++) { if (pred.call(thisArg, this[i], i, this)) return this[i]; }
          return undefined;
        };
      }
      if (!Array.prototype.findIndex) {
        Array.prototype.findIndex = function (pred, thisArg) {
          for (var i = 0; i < this.length; i++) { if (pred.call(thisArg, this[i], i, this)) return i; }
          return -1;
        };
      }
      if (typeof Array.from !== "function") {
        Array.from = function (o, mapFn) {
          var a = [], i;
          if (o && typeof o.length === "number") { for (i = 0; i < o.length; i++) a.push(o[i]); }
          else if (o && typeof o.next === "function") { var r = o.next(); while (!r.done) { a.push(r.value); r = o.next(); } }
          return mapFn ? a.map(mapFn) : a;
        };
      }
      if (!Object.assign) {
        Object.assign = function (t) {
          for (var i = 1; i < arguments.length; i++) {
            var s = arguments[i]; if (!s) continue;
            for (var k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; }
          }
          return t;
        };
      }
      if (!String.prototype.includes) {
        String.prototype.includes = function (x, p) { return String(this).indexOf(x, p || 0) >= 0; };
      }
      if (!Array.prototype.includes) {
        Array.prototype.includes = function (x) { return this.indexOf(x) >= 0; };
      }
    } catch (e) { /* 垫片失败不影响主流程 */ }
  })();
  // v2.4.4：全局错误捕获（功能⑯ 错误日志）——window.onerror / unhandledrejection 入环形缓冲 localStorage，供「信息与帮助→错误日志」查看复制
  (function () {
    try {
      var KEY = (window.__APP_ID__ || "app") + "_errlog_v1";
      function push(msg) {
        try {
          var arr = JSON.parse(localStorage.getItem(KEY) || "[]");
          if (!Array.isArray(arr)) arr = [];
          arr.push({ t: new Date().toISOString(), m: String(msg).slice(0, 600) });
          if (arr.length > 300) arr = arr.slice(-300);
          try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch (e) {}
        } catch (_) {}
      }
      window.__ERR_LOG_PUSH__ = push;
      window.addEventListener("error", function (e) {
        var loc = e && e.filename ? (" @ " + String(e.filename).split("/").pop() + ":" + (e.lineno || 0)) : "";
        push((e && e.message ? e.message : "error") + loc);
      });
      window.addEventListener("unhandledrejection", function (e) {
        var r = e && e.reason;
        push("Promise: " + (r && (r.stack || r.message) ? (r.stack || r.message) : String(r)));
      });
    } catch (_) {}
  })();
  // 天地图 Token：v2.4.3 优先读 localStorage(appsettings_key_v1) → index.html __CONFIG__ → 内置默认
  // 注：保持 let（非 const），允许设置面板运行时修改
  const TIANDITU_DEFAULT = "";            // 浏览器端：前端在线底图加载
  const TIANDITU_SERVER_DEFAULT = "";    // 服务器端：瓦片下载脚本
  let TIANDITU = TIANDITU_DEFAULT, TIANDITU_SERVER = TIANDITU_SERVER_DEFAULT;
  try {
    const _tiandituSaved = JSON.parse(localStorage.getItem("appsettings_key_v1") || "null");
    if (_tiandituSaved && _tiandituSaved.TIANDITU_TOKEN) TIANDITU = _tiandituSaved.TIANDITU_TOKEN;
    if (_tiandituSaved && _tiandituSaved.TIANDITU_SERVER_TOKEN) TIANDITU_SERVER = _tiandituSaved.TIANDITU_SERVER_TOKEN;
    if (!localStorage.getItem("appsettings_key_v1") && window.__CONFIG__ && window.__CONFIG__.TIANDITU_TOKEN) {
      TIANDITU = window.__CONFIG__.TIANDITU_TOKEN;
      if (window.__CONFIG__.TIANDITU_SERVER_TOKEN) TIANDITU_SERVER = window.__CONFIG__.TIANDITU_SERVER_TOKEN;
    }
  } catch (e) {}
  // Leaflet 默认图标走本地文件
  L.Icon.Default.imagePath = "lib/images/";
  L.Icon.Default.mergeOptions({
    iconUrl: "lib/images/marker-icon.png",
    iconRetinaUrl: "lib/images/marker-icon-2x.png",
    shadowUrl: "lib/images/marker-shadow.png"
  });
  // 建筑物标记：倒立蓝色水滴状（尖端朝上、圆鼓朝下覆盖点位）、中心小白点（内联 SVG，缩放清晰，APK/Web 通用）
  const MARKER = L.divIcon({
    className: "drop-marker",
    html: `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg"><path d="M14 2 C 20 12 26 18 26 26 A 12 12 0 1 1 2 26 C 2 18 8 12 14 2 Z" fill="#3da9fc" stroke="#1b6fb8" stroke-width="1.5"/><circle cx="14" cy="26" r="5" fill="#ffffff"/></svg>`,
    iconSize: [28, 40], iconAnchor: [14, 38], popupAnchor: [0, -30]
  });
  // 筛选命中标记：倒立水滴（尖端朝下、圆鼓朝上），绿色，区别于普通蓝色正水滴
  const FILTER_MARKER = L.divIcon({
    className: "drop-marker-filter",
    html: `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg"><path d="M14 38 C 20 28 26 22 26 14 A 12 12 0 1 1 2 14 C 2 22 8 28 14 38 Z" fill="#2ecc8f" stroke="#1d8f63" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="#ffffff"/></svg>`,
    iconSize: [28, 40], iconAnchor: [14, 38], popupAnchor: [0, -30]
  });
  // 2026-08-20 新增：建筑物标记自定义颜色/形状（默认蓝色水滴保持原样；形状 水滴/方/圆/三角）
  const MARKER_COLORS = ["#3da9fc", "#ff6b6b", "#ffb020", "#54e3b4", "#b06bff", "#ff8fc0", "#3dd1ff", "#ffd93d"];
  const MARKER_SHAPES = ["drop", "square", "circle", "triangle"];
  const SHAPE_GLYPH = { drop: "💧", square: "⬜", circle: "🔵", triangle: "🔺" };
  function markerSvg(shape, color) {
    if (shape === "square") return `<rect x="4" y="6" width="20" height="20" rx="5" fill="${color}" stroke="#ffffff" stroke-width="1.5"/><circle cx="14" cy="16" r="4" fill="#ffffff"/>`;
    if (shape === "circle") return `<circle cx="14" cy="16" r="12" fill="${color}" stroke="#ffffff" stroke-width="1.5"/><circle cx="14" cy="16" r="4" fill="#ffffff"/>`;
    if (shape === "triangle") return `<path d="M14 3 L26 30 L2 30 Z" fill="${color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="14" cy="22" r="4" fill="#ffffff"/>`;
    return `<path d="M14 2 C 20 12 26 18 26 26 A 12 12 0 1 1 2 26 C 2 18 8 12 14 2 Z" fill="${color}" stroke="#1b6fb8" stroke-width="1.5"/><circle cx="14" cy="26" r="5" fill="#ffffff"/>`;
  }
  function markerIcon(r, filtered) {
    if (filtered) return FILTER_MARKER; // 筛选命中态优先显示绿色倒水滴（既有设计）
    const color = r.mcolor || "#3da9fc", shape = r.mshape || "drop";
    if (color === "#3da9fc" && shape === "drop") return MARKER; // 默认样式走缓存，零开销
    return L.divIcon({
      className: "drop-marker",
      html: `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">${markerSvg(shape, color)}</svg>`,
      iconSize: [28, 40], iconAnchor: [14, 38], popupAnchor: [0, -30]
    });
  }
  // 左下角图例：列出设置了自定义颜色/形状的建筑物（名称 + 色样），无则隐藏
  function updateLegend() {
    const box = el("legend"); if (!box) return;
    const items = [];
    for (const r of records) {
      const c = r.mcolor || "", s = r.mshape || "";
      if (!c && !s) continue;
      if (c === "#3da9fc" && (!s || s === "drop")) continue; // 默认样式不入图例
      items.push({ name: r.name, color: c || "#3da9fc", shape: s || "drop" });
    }
    if (!items.length) { box.style.display = "none"; return; }
    box.innerHTML = `<div class="lg-title">图例 · 自定义标记</div>` +
      items.slice(0, 20).map((it) => `<div class="lg-item"><span class="lg-sample">${SHAPE_GLYPH[it.shape] || SHAPE_GLYPH.drop}</span><span style="width:12px;height:12px;border-radius:50%;background:${it.color};display:inline-block;flex:0 0 auto"></span><span class="lg-name">${esc(it.name)}</span></div>`).join("") +
      (items.length > 20 ? `<div class="lg-item">…共 ${items.length} 个</div>` : "");
    box.style.display = "";
  }

  // 全局版本号（单一事实来源：关于 / 版本变更 / 帮助 均引用此处，避免硬编码漂移）
  const APP_VER = "v2.4.7";

  // ---------- 状态 ----------
  let BASE = [], DELTA = { added: [], updated: {}, deleted: [] }, records = [];
  let map, layerGroup, overlayGroup;
  let filterCircle = null; // 筛选命中绿色虚线圆圈（v2.4.4 与古建端统一）
  const filterActive = () => !!(filter.office.length || filter.mgmt.length || filter.station.length || filter.btype.length || (filter.q && filter.q.trim()) || (filter.photo && filter.photo.mode !== "all"));
  let vecLayer = null, cvaLayer = null, imgLayer = null, ciaLayer = null, basemapOn = false, layerType = "vec";
  let lastCenter = null, myLoc = null, myLocMarker = null;
  let measureMode = false, measurePts = [], measureLine = null;
  let nearbyCenter = null, nearbyRadius = null, nearbyCircle = null, nearbyBtypes = [];
  const DEFAULT_CENTER = [40.30876, 116.61107]; // 怀柔水库所 质心
  const DEFAULT_ZOOM = 12;
  const filter = { bureau: [], mgmt: [], office: [], station: [], btype: [], q: "", photo: { mode: "all", min: 0 } };
  let pickMode = false, pendingLatLng = null, editId = null, formPhotos = [], formColor = "#3da9fc", formShape = "drop";
  let coordResult = null, pickForCoord = false, pendingCoordCb = null;   // 获取经纬度：地图点选回填 / 添加建筑物第1步回调
  // 批量导入缓冲（原生逐文件回调）
  let pendingBatch = { photos: [], sheets: [] };
  const BATCH_STATE = { active: false, kind: null };
  function b64ToDataUrl(name, b64) {
    const l = (name || "").toLowerCase();
    let mime = "image/jpeg";
    if (l.endsWith(".png")) mime = "image/png";
    else if (l.endsWith(".gif")) mime = "image/gif";
    else if (l.endsWith(".webp")) mime = "image/webp";
    else if (l.endsWith(".bmp")) mime = "image/bmp";
    return "data:" + mime + ";base64," + b64;
  }

  // ---------- 超大文件 / 网络辅助 ----------
  // 网络信息：是否 WiFi、是否在线、连接类型
  function netInfo() {
    const c = (navigator.connection || navigator.mozConnection || navigator.webkitConnection || {});
    const type = c.type || c.effectiveType || "";
    return {
      online: navigator.onLine !== false,
      type: type,
      wifi: type === "wifi",
      meteredHint: (type && type !== "wifi" && type !== "") // 非 wifi 视为可能走流量
    };
  }
  // 大流量确认：非 WiFi 时警告（items 1/2：可能 >3GB）
  function confirmLargeTransfer(title) {
    const n = netInfo();
    return new Promise((resolve) => {
      if (n.wifi || !n.online) return resolve(true); // WiFi 或离线（离线说明本地操作，无需流量）
      const html = `<div class="hint" style="color:#e67e22">⚠️ 当前<b>未连接 WiFi</b>（连接类型：${esc(n.type || "未知")}），传输超大文件（可能 >3GB）将消耗大量移动流量，可能产生资费。</div>
        <div class="hint">建议：连接 WiFi 后再操作；或确认流量充足后继续。</div>`;
      openModal(title || "大流量提醒", html, `<button class="btn ghost" id="ltCancel">取消</button><button class="btn primary" id="ltGo">仍要继续</button>`);
      el("ltCancel").onclick = () => { closeModal(); resolve(false); };
      el("ltGo").onclick = () => { closeModal(); resolve(true); };
    });
  }
  // 压缩包体积预检（item 1 根因：1.7G 直接 OOM/死机）：移动端 WebView 内存有限，整包加载必崩
  // 返回 true 表示已拦截（弹窗引导分卷），调用方应 return；false 表示可继续
  function zipSizeRefuse(f) {
    const HARD = 1200 * 1048576; // 1.2GB：超过此值手机 WebView 几乎必然崩溃
    if (f.size > HARD) {
      BATCH_STATE.active = false;
      const mb = Math.round(f.size / 1048576), gb = (f.size / 1073741824).toFixed(2);
      openModal("压缩包过大，无法导入",
        `<div class="hint" style="color:#e74c3c">⚠️ 压缩包约 <b>${gb} GB（${mb} MB）</b>，已超过移动端安全上限（建议 ≤500MB）。<br>手机 WebView 内存有限，整包加载会直接崩溃 / 死机。</div>
         <div class="hint">解决方法：<b>在电脑上按管理所拆成多个 ≤500MB 的 zip</b> 后逐个导入；或用「手机文件夹」分批选照片。</div>`,
        `<button class="btn primary" id="zOk">我知道了</button>`);
      el("zOk").onclick = closeModal;
      return true;
    }
    return false;
  }
  // 内容哈希（用于内容去重，item 6）：dataUrl(base64) → sha256 十六进制
  async function shaHexOfB64(b64) {
    try { return await IO.sha256Hex(IO.b64ToBytes(b64)); } catch (e) { return "err:" + (b64 || "").length; }
  }

  // 导入续传检查点（item 1/2：中断后可继续，不丢进度）
  const IMPORT_CP = { active: false, kind: null, received: 0, startedAt: 0 };
  function importCpStart(kind) {
    IMPORT_CP.active = true; IMPORT_CP.kind = kind; IMPORT_CP.received = 0; IMPORT_CP.startedAt = Date.now();
  }
  function importCpTouch() { IMPORT_CP.received++; }
  function importCpEnd() { IMPORT_CP.active = false; IMPORT_CP.kind = null; IMPORT_CP.received = 0; }
  // 若上次导入被中断（active 仍为 true 且未超过 24h），提示用户
  function importCpResumePrompt(kind) {
    return new Promise((resolve) => {
      if (!IMPORT_CP.active) return resolve(false);
      const mins = Math.round((Date.now() - IMPORT_CP.startedAt) / 60000);
      if (mins > 1440) { importCpEnd(); return resolve(false); }
      const html = `<div class="hint">检测到上一次「${IMPORT_CP.kind === "photos" ? "照片" : "建筑物"}」导入可能未正常完成（已接收 ${IMPORT_CP.received} 个文件，约 ${mins} 分钟前）。</div>
        <div class="hint">建议「继续」重新选择来源并按需追加；若已无需，请选择「放弃」。</div>`;
      openModal("导入续传", html, `<button class="btn ghost" id="cpDrop">放弃上次</button><button class="btn primary" id="cpGo">继续</button>`);
      el("cpDrop").onclick = () => { importCpEnd(); closeModal(); resolve(false); };
      el("cpGo").onclick = () => { closeModal(); resolve(true); };
    });
  }

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const el = (id) => document.getElementById(id);
  function toast(msg) {
    const t = el("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
  }
  function openModal(title, bodyHtml, footHtml) {
    el("modalTitle").textContent = title;
    el("modalBody").innerHTML = bodyHtml;
    el("modalFoot").innerHTML = footHtml || "";
    el("modal").classList.add("open");
    el("modalMask").classList.add("show");
  }
  function closeModal() {
    el("modal").classList.remove("open");
    el("modalMask").classList.remove("show");
  }
  // 全屏"执行中，请稍后"遮罩：导入/导出/压缩/大批量操作时调用，避免误以为卡死
  let _busyEl;
  function busy(msg) {
    if (!_busyEl) {
      _busyEl = document.createElement("div");
      _busyEl.id = "busy";
      _busyEl.innerHTML = `<div class="busy-box"><div class="spinner"></div><div class="busy-msg"></div></div>`;
      document.body.appendChild(_busyEl);
    }
    _busyEl.querySelector(".busy-msg").textContent = msg || "执行中，请稍后…";
    _busyEl.classList.add("show");
  }
  function hideBusy() { if (_busyEl) _busyEl.classList.remove("show"); }
  // 文件选择器：保留对临时 <input> 的引用，避免 Android WebView 在用户选完文件前将其 GC
  // （局部变量 input 在 inp.click() 后超出作用域被回收 → onchange 永不触发 → 点击 csv/zip 等"无反应"）
  let _pendingFileInput = null;
  function pickFiles(opts) {
    try { if (_pendingFileInput && _pendingFileInput.parentNode) _pendingFileInput.parentNode.removeChild(_pendingFileInput); } catch (e) {}
    const inp = document.createElement("input");
    inp.type = "file";
    if (opts.accept) inp.accept = opts.accept;
    if (opts.multiple) inp.multiple = true;
    if (opts.webkitdirectory) inp.webkitdirectory = true;
    inp.style.position = "fixed"; inp.style.left = "-9999px"; inp.style.top = "0";
    const onPick = opts.onPick;
    // 非静默失败看门狗：选择器若确实没弹出（无失焦且无回调），2.5s 后 toast 引导，绝不"点了没反应"
    let chooserOpened = false;
    const onBlur = () => { chooserOpened = true; };
    const watchdog = setTimeout(() => {
      window.removeEventListener("blur", onBlur);
      if (!chooserOpened) toast("未弹出文件选择器？请检查系统「文件/存储」权限，或改用「批量导入」来源");
    }, 2500);
    window.addEventListener("blur", onBlur);
    inp.onchange = () => {
      clearTimeout(watchdog); window.removeEventListener("blur", onBlur);
      const files = inp.files ? Array.from(inp.files) : [];
      try { if (inp.parentNode) inp.parentNode.removeChild(inp); } catch (e) {}
      _pendingFileInput = null;
      if (onPick) onPick(files);
    };
    // 先挂到 DOM 再点击：部分 WebView 要求 input 在文档中才会弹出系统选择器，且挂 DOM 可防止被 GC
    document.body.appendChild(inp);
    _pendingFileInput = inp;
    inp.click();
  }
  // 原生返回键 / Esc：逐级关闭 弹窗 > 抽屉 > 测距 > 列表
  function back() {
    if (el("modal").classList.contains("open")) { closeModal(); return true; }
    if (el("drawer").classList.contains("open")) { closeDrawer(); return true; }
    if (measureMode) { exitMeasure(); return true; }
    if (el("listbar").classList.contains("open")) { el("listbar").classList.remove("open"); return true; }
    if (el("drawer").classList.contains("open")) { closeDrawer(); return true; }
    return false;
  }
  // 三击地图任意处：关闭任何卡住的弹窗/列表，并打开主菜单（解决"找不到主菜单"）
  function tripleTapMenu() {
    closeModal();
    if (el("listbar").classList.contains("open")) el("listbar").classList.remove("open");
    el("drawer").classList.add("open"); el("mask").classList.add("show");
    toast("已打开主菜单");
  }

  // ---------- 数据 ----------
  async function load() {
    let json;
    if (window.__DATA__ && window.__DATA__.features) {
      json = window.__DATA__;            // 离线/APK 场景：内嵌数据，免 fetch
    } else {
      const res = await fetch("data.json");
      json = await res.json();
    }
    BASE = json.features || [];
    DELTA = await Store.get();
    applyDims();
    merge();
    render();
  }
  function merge() {
    const del = new Set(DELTA.deleted || []);
    records = [];
    for (const r of BASE) {
      if (del.has(r.id)) continue;
      const up = DELTA.updated[r.id];
      records.push(up ? Object.assign({}, r, up) : r);
    }
    for (const a of (DELTA.added || [])) records.push(a);
    applyDims();
  }
  // ---------- 组织层级配置（局/管理处/所/站/段 · 持久化 + 双向联动 · v2.4 五级化）----------
  const BASE_OFFICES = ["地下水源所", "温泉所", "龙山所", "史山所", "埝头所", "水库所", "北台上所", "西田各庄所", "潮河所"];
  const BASE_OFFICES_SET = new Set(BASE_OFFICES);
  // v2.4.1：管理所可以是数组（多个预选）；段默认可为空；段和所独立，段名不必跟随所名
  const DEFAULT_ORG = { bureau: "水利工程管理中心", mgmt: "京密引水管理处", office: ["水库所"], station: "", section: "" };
  const ORG_LEVELS = [
    { key: "bureau", label: "局", field: "bureau" },
    { key: "mgmt", label: "管理处", field: "mgmt" },
    { key: "office", label: "所", field: "office" },
    { key: "station", label: "站", field: "station" },
    { key: "section", label: "段", field: "section" }
  ];
  const ORGCFG_KEY = "shuili_orgcfg_v2", ORGCFG_LEGACY_KEY = "shuili_offcfg_v1";
  let ORGCFG = loadCFG();
  function loadCFG() {
    // v2.4：读新键；旧版 shuili_offcfg_v1（因 CFG_KEY 笔误从未回读成功）做一次迁移兜底
    let o = {};
    try { o = JSON.parse(localStorage.getItem(ORGCFG_KEY) || "null") || {}; } catch (e) { o = {}; }
    if (!o || (!o.officeExtra && !o.stations && !o.defaults)) {
      try { o = JSON.parse(localStorage.getItem(ORGCFG_LEGACY_KEY) || "null") || o; } catch (e) {}
    }
    return {
      bureaus: Array.isArray(o.bureaus) ? o.bureaus : [],
      mgmts: Array.isArray(o.mgmts) ? o.mgmts : [],
      officeExtra: Array.isArray(o.officeExtra) ? o.officeExtra : [],
      stations: Array.isArray(o.stations) ? o.stations : [],
      sections: Array.isArray(o.sections) ? o.sections : [],
      btypeExtra: Array.isArray(o.btypeExtra) ? o.btypeExtra : [],
      defaults: Object.assign({}, DEFAULT_ORG, (o.defaults && typeof o.defaults === "object") ? o.defaults : {})
    };
  }
  function saveCFG() { try { localStorage.setItem(ORGCFG_KEY, JSON.stringify(ORGCFG)); } catch (e) {} }
  // v2.4.1：管理所 office 默认支持多个（数组）
  function orgDefault(key) {
    const v = (ORGCFG.defaults && ORGCFG.defaults[key]) ?? DEFAULT_ORG[key];
    if (key === "office") {
      // 统一为数组输出
      if (Array.isArray(v)) return v.filter(Boolean);
      if (v) return [v];
      return [];
    }
    return v || "";
  }
  // station -> office 映射（双向一致：改名/删除管理所时联动其下管理站）
  function stationOffice(name) { const m = (ORGCFG.stations || []).find((s) => s.name === name); return m ? m.office : ""; }
  // 记录取某层级值：无值时回填默认（局/管理处/所），站/段默认可空返回原值；office 默认取所有预选所中第一个匹配
  function orgVal(r, key) {
    if (!r) return key === "office" ? (orgDefault("office")[0] || "") : orgDefault(key);
    const v = r[key];
    if (v != null && v !== "") return v;
    if (key === "bureau" || key === "mgmt") return orgDefault(key);
    if (key === "office") {
      const arr = orgDefault("office");
      return arr.length ? arr[0] : "";
    }
    return "";  // station / section 默认空
  }
  function applyDims() {
    // 各层级选项 = 数据实际出现 ∪ 默认值（多值时全部展开）∪ 基础名单 ∪ 用户自定义
    const cfgB = (ORGCFG.bureaus || []).filter(Boolean);
    DIMS.bureaus = uniq([...records.map((r) => orgVal(r, "bureau")).filter(Boolean), orgDefault("bureau"), ...cfgB]);
    const cfgM = (ORGCFG.mgmts || []).filter(Boolean);
    DIMS.mgmts = uniq([...records.map((r) => orgVal(r, "mgmt")).filter(Boolean), orgDefault("mgmt"), ...cfgM]);
    const officeDefaults = orgDefault("office");  // v2.4.1 数组
    const cfgOff = (ORGCFG.officeExtra || []).map((o) => normOffice(o)).filter(Boolean);
    DIMS.offices = uniq([...records.map((r) => normOffice(orgVal(r, "office"))).filter(Boolean), ...officeDefaults, ...BASE_OFFICES, ...cfgOff]);
    const cfgSt = (ORGCFG.stations || []).map((s) => s.name).filter(Boolean);
    DIMS.stations = uniq([...records.map((r) => r.station).filter(Boolean), ...cfgSt]);
    const cfgSec = (ORGCFG.sections || []).filter(Boolean);
    DIMS.sections = uniq([...records.map((r) => r.section).filter(Boolean), ...cfgSec]);
    const cfgBt = (ORGCFG.btypeExtra || []).filter(Boolean);
    DIMS.btypes = uniq([...records.map((r) => r.btype).filter(Boolean), ...cfgBt]);
  }
  const DIMS = { bureaus: [], mgmts: [], offices: [], stations: [], sections: [], btypes: [] };
  function uniq(a) { return [...new Set(a)].sort(); }

  function passFilter(r) {
    if (filter.office.length && !filter.office.includes(normOffice(orgVal(r, "office")))) return false;
    if (filter.mgmt.length && !filter.mgmt.includes(orgVal(r, "mgmt"))) return false;
    if (filter.btype.length && !filter.btype.includes(r.btype)) return false;
    if (filter.station.length && !filter.station.includes(r.station)) return false;
    if (filter.photo && filter.photo.mode !== "all") {
      const cnt = (r.photos || []).length;
      if (filter.photo.mode === "has" && cnt <= 0) return false;
      if (filter.photo.mode === "none" && cnt > 0) return false;
      if (filter.photo.mode === "min" && cnt < (filter.photo.min || 0)) return false;
    }
    if (filter.q && !`${r.name} ${r.office} ${normOffice(r.office)} ${r.station} ${r.btype}`.toLowerCase().includes(filter.q.toLowerCase())) return false;
    if (nearbyCenter && nearbyRadius != null) {
      if (haversine(nearbyCenter, { lat: r.lat, lon: r.lon }) > nearbyRadius) return false;
      if (nearbyBtypes.length && !nearbyBtypes.includes(r.btype)) return false;
    }
    return true;
  }

  // ---------- UI 状态持久化 ----------
  function loadUI() {
    const s = Store.ui.get();
    if (s) {
      filter.office = Array.isArray(s.office) ? s.office : [];
      filter.mgmt = Array.isArray(s.mgmt) ? s.mgmt : [];
      filter.station = Array.isArray(s.station) ? s.station : [];
      filter.btype = Array.isArray(s.btype) ? s.btype : [];
      basemapOn = s.basemap === true;
      layerType = (s.layer === "img") ? "img" : "vec";
      lastCenter = s.center || null;
    } else {
      // 首次打开：默认「京密引水管理处 + 水库所」(v2.4.3 管理处默认可多选，默认局管理处生效)，仅载该子集→开图更快不卡顿
      filter.mgmt = [orgDefault("mgmt")];
      filter.office = (Array.isArray(orgDefault("office")) ? orgDefault("office") : [orgDefault("office")]).filter(Boolean);
      basemapOn = false;
      layerType = "vec";
      lastCenter = null;
    }
  }
  function saveUI() {
    const s = Store.ui.get() || {};
    // 合并保留既有 UI 偏好（收藏窗口 favs、旧版单点 fav 等），避免覆盖式写入导致丢失
    Store.ui.set(Object.assign({}, s, { office: filter.office, mgmt: filter.mgmt, station: filter.station, btype: filter.btype, basemap: basemapOn, layer: layerType, center: lastCenter }));
  }

  // ---------- 地图 ----------
  function initMap() {
    // attributionControl 去掉默认「Leaflet」外链（https://leafletjs.com）：离线/弱网点该链接会 ERR_CONNECTION_TIMED_OUT；本地资源已离线化
    map = L.map("map", { zoomControl: true, attributionControl: L.control.attribution({ prefix: false }) }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    const baseOpts = { maxZoom: 18, subdomains: "0123456789" };
    const tk = (lyr) => `https://t0.tianditu.gov.cn/${lyr}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${lyr}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${TIANDITU}`;
    vecLayer = L.tileLayer(tk("vec"), baseOpts);
    cvaLayer = L.tileLayer(tk("cva"), baseOpts);
    imgLayer = L.tileLayer(tk("img"), baseOpts);
    ciaLayer = L.tileLayer(tk("cia"), baseOpts);
    layerGroup = L.featureGroup().addTo(map); // 2026-08-20 修复：L.layerGroup 无 getBounds()，fitToShown 运行时报错；featureGroup 继承 layerGroup 且自带 getBounds
    overlayGroup = L.layerGroup().addTo(map); // 测距 / 周边 等叠加层，render() 不清空
    map.on("popupopen", onPopupOpen);
    map.on("click", (e) => {
      if (measureMode) { addMeasurePt(e.latlng); return; }
      if (pickMode) {
        pendingLatLng = e.latlng;
        if (pickForCoord) {
          // 获取经纬度 / 添加建筑物第1步：地图点选 → 回调
          pickForCoord = false; togglePick(false);
          const c = { lat: e.latlng.lat, lon: e.latlng.lng };
          if (typeof pendingCoordCb === "function") { const cb = pendingCoordCb; pendingCoordCb = null; cb(c); }
          else { coordResult = c; getCoord(); }
          return;
        }
        $("#fLat").value = e.latlng.lat.toFixed(6);
        $("#fLon").value = e.latlng.lng.toFixed(6);
        toast("已选择坐标：" + e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5));
        togglePick(false);
      }
    });
    map.on("contextmenu", (e) => {
      if (measureMode || pickMode) return;
      if (e && e.originalEvent) e.originalEvent.preventDefault();
      openCtxMenu(e.originalEvent.clientX, e.originalEvent.clientY, mapCtxItems(e.latlng));
    });
    map.on("moveend", () => {
      lastCenter = { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() };
      saveUI();
    });
  }
  function addBasemap() {
    [vecLayer, cvaLayer, imgLayer, ciaLayer].forEach((L0) => { if (map.hasLayer(L0)) map.removeLayer(L0); });
    if (basemapOn) {
      if (layerType === "img") { imgLayer.addTo(map); ciaLayer.addTo(map); }
      else { vecLayer.addTo(map); cvaLayer.addTo(map); }
    }
    updateBaseBtn(); updateLayerBtn();
  }
  // v2.4.3 密钥替换后重建 4 个底图层 URL（token 改了 → 立即生效，无需刷页面）
  function refreshBasemap() {
    [vecLayer, cvaLayer, imgLayer, ciaLayer].forEach((L0) => { if (L0 && map.hasLayer(L0)) map.removeLayer(L0); });
    vecLayer = L.tileLayer(tk("vec"), baseOpts);
    cvaLayer = L.tileLayer(tk("cva"), baseOpts);
    imgLayer = L.tileLayer(tk("img"), baseOpts);
    ciaLayer = L.tileLayer(tk("cia"), baseOpts);
    if (basemapOn) {
      if (layerType === "img") { imgLayer.addTo(map); ciaLayer.addTo(map); }
      else { vecLayer.addTo(map); cvaLayer.addTo(map); }
    }
  }
  function setBasemap(on) { basemapOn = on; saveUI(); addBasemap(); toast(on ? "已开启底图" : "已关闭底图"); }
  function setLayer(t) {
    layerType = (t === "img") ? "img" : "vec";
    saveUI();
    if (basemapOn) addBasemap();
    toast(layerType === "img" ? "影像地图" : "矢量地图");
  }
  function updateBaseBtn() {
    const b = el("btnBase"); if (!b) return;
    b.classList.toggle("active", basemapOn);
    b.textContent = basemapOn ? "🗺" : "🚫";
    b.title = basemapOn ? "关闭底图" : "开启底图";
  }
  function updateLayerBtn() {
    const b = el("btnLayer"); if (!b) return;
    b.textContent = layerType === "img" ? "影像" : "矢量";
    b.title = "底图图源（点击打开底图选择）";
    b.classList.toggle("active", basemapOn);
  }
  // 底图选择：矢量 / 影像 / 仅点位，清晰高亮当前选中
  function openBasemap() {
    const opts = [
      { k: "vec", t: "矢量地图", s: "道路 / 注记清晰，适合日常巡查", on: basemapOn && layerType === "vec" },
      { k: "img", t: "影像地图", s: "卫星影像，适合看地形地物", on: basemapOn && layerType === "img" },
      { k: "off", t: "仅点位（省流量）", s: "不加载底图，仅显示采集点", on: !basemapOn }
    ];
    const html = opts.map((o) =>
      `<div class="bm-opt ${o.on ? "on" : ""}" data-k="${o.k}">
        <span class="bm-dot"></span>
        <div class="bm-tx"><div class="bm-t">${o.t}</div><div class="bm-s">${o.s}</div></div>
        <span class="bm-check">✓</span>
      </div>`).join("");
    openModal("底图选择", html, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
    el("modalBody").querySelectorAll(".bm-opt").forEach((node) => {
      node.onclick = () => {
        const k = node.dataset.k;
        if (k === "off") basemapOn = false;
        else { basemapOn = true; layerType = k; }
        saveUI(); addBasemap(); updateBaseBtn(); updateLayerBtn();
        openBasemap(); // 刷新选中态
      };
    });
  }
  function fitToShown() {
    const b = layerGroup.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.12));
    else map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  }

  function render() {
    layerGroup.clearLayers();
    if (filterCircle) { overlayGroup.removeLayer(filterCircle); filterCircle = null; }
    let n = 0;
    for (const r of records) {
      if (!passFilter(r)) continue;
      const lat = +r.lat, lon = +r.lon;
      // 非法坐标（NaN/Infinity，常见于导入的线/面/无坐标要素）直接跳过，避免 Leaflet 抛错
      if (!isFinite(lat) || !isFinite(lon)) continue;
      n++;
      const m = L.marker([lat, lon], { icon: markerIcon(r, filterActive()) }).bindPopup(popupHtml(r));
      m._rid = r.id;
      m.on("click", () => { if (measureMode) addMeasurePt({ lat: lat, lon: lon }); });
      m.on("contextmenu", (e) => { if (e && e.originalEvent) { L.DomEvent.stop(e); e.originalEvent.preventDefault(); } openCtxMenu(e.originalEvent.clientX, e.originalEvent.clientY, ctxItemsFor(r)); });
      layerGroup.addLayer(m);
    }
    // 周边搜索范围圈
    if (nearbyCenter && nearbyRadius != null) {
      if (nearbyCircle) overlayGroup.removeLayer(nearbyCircle);
      nearbyCircle = L.circle([nearbyCenter.lat, nearbyCenter.lon], { radius: nearbyRadius, color: "#3da9fc", weight: 1.5, fillColor: "#3da9fc", fillOpacity: 0.08 }).addTo(overlayGroup);
    }
    el("listCnt") && (el("listCnt").textContent = `${n} / ${records.length}`);
    updateFilterBar();
    updateLegend();
    renderList();
  }
  // 筛选状态条：实时显示命中建筑物数，无筛选时隐藏
  function updateFilterBar() {
    const bar = el("filterBar"); if (!bar) return;
    const rs = records.filter(passFilter);
    if (filterActive()) {
      el("fbCnt").textContent = rs.length;
      bar.classList.add("show");
    } else {
      bar.classList.remove("show");
    }
  }
  // v2.4.4 绿色虚线圆圈「刚刚好」圈住全部命中建筑物，并把视野调到刚好完整显示该圆圈（与古建端同源一致）
  // 算法：Ritter 最小包围圆（等距投影到米制平面）→ 比旧的「外接矩形质心 + 最远距离」半径更贴合，
  // 收尾再做一次全点包含性校正，保证一个都不漏在圈外（沉默漏点是不可接受的）。
  const FILTER_CIRCLE_COLOR = "#22c55e";   // 绿色虚线（与古建端统一）
  function minEnclosingCircle(pts) {
    const lat0 = pts[0][0] * Math.PI / 180;
    const MPD_LAT = 110540, MPD_LON = 111320 * Math.cos(lat0);
    const P = pts.map(([la, lo]) => [lo * MPD_LON, la * MPD_LAT]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let q = P[0];
    for (const p of P) if (dist(P[0], p) > dist(P[0], q)) q = p;
    let r = P[0];
    for (const p of P) if (dist(q, p) > dist(q, r)) r = p;
    let cx = (q[0] + r[0]) / 2, cy = (q[1] + r[1]) / 2, rad = dist(q, r) / 2;
    for (const p of P) {
      const d = Math.hypot(p[0] - cx, p[1] - cy);
      if (d > rad) {
        const nr = (rad + d) / 2, k = (d - nr) / d;
        cx += (p[0] - cx) * k; cy += (p[1] - cy) * k; rad = nr;
      }
    }
    for (const p of P) rad = Math.max(rad, Math.hypot(p[0] - cx, p[1] - cy));
    return { lat: cy / MPD_LAT, lon: cx / MPD_LON, radius: rad };
  }
  function drawFilterCircle(rs) {
    if (filterCircle) { overlayGroup.removeLayer(filterCircle); filterCircle = null; }
    const pts = rs.map((r) => [+r.lat, +r.lon]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
    if (pts.length < 1) return;
    const style = { color: FILTER_CIRCLE_COLOR, weight: 2, dashArray: "8 6", fillColor: FILTER_CIRCLE_COLOR, fillOpacity: 0.07 };
    if (pts.length === 1) {
      const [lat, lon] = pts[0];
      filterCircle = L.circle([lat, lon], Object.assign({ radius: 220 }, style)).addTo(overlayGroup);
      map.flyTo([lat, lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
      return;
    }
    const mec = minEnclosingCircle(pts);
    const radius = Math.max(mec.radius * 1.04 + 30, 120);
    filterCircle = L.circle([mec.lat, mec.lon], Object.assign({ radius }, style)).addTo(overlayGroup);
    map.flyToBounds(filterCircle.getBounds(), { padding: [24, 24], duration: 0.6, maxZoom: 18 });
  }
  // 清除筛选：清空条件、搜索框与圆圈，恢复正常蓝色正水滴
  function clearFilter() {
    filter.office = []; filter.btype = []; filter.q = ""; filter.photo = { mode: "all", min: 0 };
    const s = el("search"); if (s) s.value = "";
    if (filterCircle) { overlayGroup.removeLayer(filterCircle); filterCircle = null; }
    render(); saveUI();
    toast("已清除筛选");
  }

  // 防御性全局别名：兼容旧构建/外部 HTML 的 onclick 引用，避免 ReferenceError
window.LIDNotifyld = function () {};
function showAllParams(id) {
  const r = (typeof records !== "undefined" ? records : []).find((x) => x && x.id === id);
  if (!r) return toast("未找到该建筑物");
  const rows = Object.keys(r.params || {}).map((k) => `<tr><td class="k">${esc(k)}</td><td>${esc(r.params[k])}</td></tr>`).join("");
  const sub = esc([r.office || r.city, r.station, r.btype || r.atype].filter(Boolean).join(" / "));
  const html = `<div class="hint">${sub}</div><div class="pop-params" style="max-height:60vh;overflow:auto">${rows ? `<table>${rows}</table>` : '<div class="hint">无参数</div>'}</div>`;
  openModal("完整参数 · " + esc(r.name), html, `<button class="btn primary" onclick="APP.close()">关闭</button>`);
}

function popupHtml(r) {
    const tag = [r.office, r.station, r.btype].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const rows = Object.keys(r.params || {}).map((k) => `<tr><td class="k">${esc(k)}</td><td>${esc(r.params[k])}</td></tr>`).join("");
    // 弹窗照片封顶 18 张（超出显示 +N），避免单点照片过多拖慢地图弹窗（item 2）
    const allPh = (r.photos || []);
    const shownPh = allPh.slice(0, 18);
    const extraPh = allPh.length - shownPh.length;
    const ph = shownPh.map((p, i) => `<img src="${p.thumb || p.dataUrl || ""}" data-rid="${r.id}" data-pi="${i}" onclick="APP.viewPhotos('${r.id}')">`).join("") + (extraPh > 0 ? `<div class="th-more">+${extraPh} 张</div>` : "");
    const navBtn = `<button class="btn ok" onclick="APP.navigate('${r.id}')">导航</button>`;
    const detailBtn = `<button class="btn ghost" onclick="APP.showAllParams('${r.id}')">完整参数</button>`;
    const nearBtn = `<button class="btn ghost" onclick="APP.nearCenter('${r.id}')">以此为周边中心</button>`;
    return `<div class="pop"><h3>${esc(r.name)}</h3>${tag}
      <div class="pop-params">${rows ? `<table>${rows}</table>` : '<div class="hint">无参数</div>'}</div>
      ${ph ? `<div class="thumbs">${ph}</div>` : ""}
      <div class="pop-actions">
        ${navBtn}
        ${detailBtn}
        <button class="btn ok" onclick="APP.edit('${r.id}')">编辑</button>
        <button class="btn ghost" onclick="APP.shareBuilding('${r.id}')">分享</button>
        <button class="btn danger" onclick="APP.del('${r.id}')">删除</button>
      </div>
      <div class="pop-actions" style="margin-top:6px">${nearBtn}</div></div>`;
  }

  function esc(s) { return IO.escapeXml(s); }

  function onPopupOpen(e) {
    const id = e.popup._source._rid;
    // 占位（按钮用 APP.edit/del 全局）
  }

  // 列表项 → 快速定位到地图
  function locateInMap(r) {
    const lat = +r.lat, lon = +r.lon;
    if (isFinite(lat) && isFinite(lon)) {
      // 飞行动画跳转，目标更明显；若已放大则不强行缩小
      map.flyTo([lat, lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
      layerGroup.eachLayer((m) => { if (m._rid === r.id) m.openPopup(); });
    } else {
      // 沉默失败→明确提示，不再"点了没反应"
      toast("该建筑物缺少有效坐标，无法定位");
    }
    el("listbar").classList.remove("open");
  }

  function renderList() {
    const box = el("listScroll"); if (!box) return;
    box.innerHTML = "";
    const rs = records.filter(passFilter);
    for (const r of rs) {
      const div = document.createElement("div");
      div.className = "li";
      div.dataset.id = r.id;
      // 名称后徽标：基础数据→"快速定位"（可点进地图），用户新增→"新增"
      div.innerHTML = `<div><div class="nm">${esc(r.name)}</div><div class="mt">${esc([r.office, r.station, r.btype].filter(Boolean).join(" / "))}</div></div><span class="badge locbtn">${r.base ? "快速定位 →" : "新增"}</span>`;
      div.onclick = () => locateInMap(r);
      div.addEventListener("contextmenu", (e) => { e.preventDefault(); openCtxMenu(e.clientX, e.clientY, ctxItemsFor(r)); });
      box.appendChild(div);
    }
  }

  // ---------- 筛选关键词历史（可展开/收起/复用）----------
  const KW_HIST_KEY = "shuili_kw_hist_v1", KW_HIST_MAX = 12;
  function loadKwHist() {
    try { const a = JSON.parse(localStorage.getItem(KW_HIST_KEY) || "[]"); return Array.isArray(a) ? a.filter(Boolean) : []; } catch (e) { return []; }
  }
  function pushKwHist(kw) {
    kw = (kw || "").trim(); if (!kw) return;
    let a = loadKwHist().filter((x) => x !== kw);
    a.unshift(kw); a = a.slice(0, KW_HIST_MAX);
    try { localStorage.setItem(KW_HIST_KEY, JSON.stringify(a)); } catch (e) {}
  }

  // ---------- 筛选（多选 管理所 / 建筑物类型；选管理所自动定位）----------
  function openFilter() {
    const kwHist = loadKwHist();
    const group = (title, arr, sel) =>
      `<div class="fgroup"><div class="ftitle">${title}（<b class="cnt">${sel.length}</b> 已选）</div><div class="chips">` +
      (arr.length ? arr.map((v) => `<span class="chip ${sel.includes(v) ? "on" : ""}" data-grp="${title}" data-v="${esc(v)}">${esc(v)}</span>`).join("") : `<span class="hint">无</span>`) +
      `</div></div>`;
    const html =
      `<div class="hint">可多选：建筑物类型（如 节制闸 / 跌水）、管理处与管理所（如 温泉所）。选择管理所会自动定位到其范围中心；不选则显示全部。</div>` +
      (kwHist.length ? `<div class="fgroup"><div class="ftitle collapsible" id="kwHistTog" style="cursor:pointer">🔎 关键词历史（<b class="cnt">${kwHist.length}</b>）<span class="tg">＋</span></div><div class="chips" id="kwHistBox" style="display:none">` + kwHist.map((k) => `<span class="chip kw" data-kw="${esc(k)}">${esc(k)}</span>`).join("") + `</div></div>` : "") +
      (filter.q && filter.q.trim() ? `<div class="fqhint">🔎 当前查询关键词：<b>${esc(filter.q.trim())}</b><span class="fqsub">（筛选在此基础上叠加，下方命中数已计入）</span></div>` : "") +
      group("建筑物类型", DIMS.btypes, filter.btype) +
      group("管理处", DIMS.mgmts, filter.mgmt) +
      group("管理所", DIMS.offices, filter.office) +
      group("管理站", DIMS.stations, filter.station) +
      `<div class="fgroup"><div class="ftitle">照片</div><div class="chips" id="phFiltChips">` +
        `<span class="chip ${filter.photo.mode === "all" ? "on" : ""}" data-pm="all">全部</span>` +
        `<span class="chip ${filter.photo.mode === "has" ? "on" : ""}" data-pm="has">有照片</span>` +
        `<span class="chip ${filter.photo.mode === "none" ? "on" : ""}" data-pm="none">无照片</span>` +
        `<span class="chip ${filter.photo.mode === "min" ? "on" : ""}" data-pm="min">至少 N 张</span>` +
      `</div><div class="field" style="margin-top:8px"><label>至少张数（选「至少 N 张」时生效）</label><input type="number" id="phFiltMin" min="1" value="${filter.photo.min || 1}" style="width:110px"></div></div>` +
      `<div class="fgroup"><div class="ftitle">管理维护</div><div class="chips">` +
        `<button class="chip" id="mOrgMgr" style="cursor:pointer">🏛️ 机构层级管理</button>` +
        `<button class="chip" id="mBtypeMgr" style="cursor:pointer">🏷️ 建筑物类型管理</button>` +
        `<button class="chip" id="mOffice" style="cursor:pointer">⚙️ 管理所维护</button>` +
        `<button class="chip" id="mStation" style="cursor:pointer">⚙️ 管理站维护</button>` +
      `</div></div>` +
      `<div class="fhit" id="fHit" style="margin-top:12px;padding:9px 12px;border:1px dashed var(--accent);border-radius:10px;color:var(--txt);font-size:13px">当前命中 <b id="fHitB" style="color:var(--accent);font-size:15px">0</b> 个建筑物 · <b id="fHitP" style="color:var(--accent);font-size:15px">0</b> 张照片</div>`;
    openModal("筛选", html, `<button class="btn ghost" id="fExit">退出</button><button class="btn ghost" id="fReset">重置</button><button class="btn primary" id="fApply">应用</button>`);
    const body = el("modalBody");
    const liveCount = () => {
      const bo = [...body.querySelectorAll('.chip[data-grp="管理所"].on')].map((c) => c.dataset.v);
      const mg = [...body.querySelectorAll('.chip[data-grp="管理处"].on')].map((c) => c.dataset.v);
      const st = [...body.querySelectorAll('.chip[data-grp="管理站"].on')].map((c) => c.dataset.v);
      const bt = [...body.querySelectorAll('.chip[data-grp="建筑物类型"].on')].map((c) => c.dataset.v);
      const q = (el("search") ? el("search").value : "").trim().toLowerCase();
      let b = 0, p = 0; // b=命中建筑物数，p=命中照片张数
      for (const r of records) {
        if (bo.length && !bo.includes(normOffice(orgVal(r, "office")))) continue;
        if (mg.length && !mg.includes(orgVal(r, "mgmt"))) continue;
        if (st.length && !st.includes(r.station)) continue;
        if (bt.length && !bt.includes(r.btype)) continue;
        if (q && !`${r.name} ${r.office} ${normOffice(r.office)} ${r.station} ${r.btype}`.toLowerCase().includes(q)) continue;
        if (filter.photo && filter.photo.mode !== "all") {
          const cnt = (r.photos || []).length;
          if (filter.photo.mode === "has" && cnt <= 0) continue;
          if (filter.photo.mode === "none" && cnt > 0) continue;
          if (filter.photo.mode === "min" && cnt < (filter.photo.min || 0)) continue;
        }
        b++; p += (r.photos || []).length;
      }
      return { b, p };
    };
    const refreshHit = () => { const h = el("fHit"); if (!h) return; const c = liveCount(); h.querySelector("#fHitB").textContent = c.b; h.querySelector("#fHitP").textContent = c.p; };
    // 多选组（管理所 / 建筑物类型）：仅绑定含 data-grp 的 chip，照片 chip 无 data-grp 被排除
    body.querySelectorAll('.chip[data-grp]').forEach((c) => c.onclick = () => {
      c.classList.toggle("on");
      const grp = c.dataset.grp;
      const sel = [...body.querySelectorAll(`.chip[data-grp="${grp}"].on`)].map((x) => x.dataset.v);
      const cntEl = c.closest(".fgroup").querySelector(".cnt");
      if (cntEl) cntEl.textContent = sel.length;   // 守卫：照片组无 .cnt，不抛错
      refreshHit();
    });
    // 关键词历史：展开/收起 + 点击复用
    const kwTog = el("kwHistTog"), kwBox = el("kwHistBox");
    if (kwTog) kwTog.onclick = () => {
      if (!kwBox) return;
      const open = kwBox.style.display !== "none";
      kwBox.style.display = open ? "none" : "";
      kwTog.querySelector(".tg").textContent = open ? "＋" : "－";
    };
    body.querySelectorAll(".chip.kw").forEach((c) => c.onclick = () => {
      const kw = c.dataset.kw;
      const s = el("search"); if (s) s.value = kw;
      filter.q = kw; saveUI(); refreshHit();
      toast("已套用关键词：" + kw);
    });
    // 照片维度筛选：单选（互斥）
    const phChips = body.querySelectorAll("#phFiltChips .chip");
    phChips.forEach((c) => c.onclick = () => {
      phChips.forEach((x) => x.classList.remove("on"));
      c.classList.add("on");
      filter.photo.mode = c.dataset.pm;
      if (c.dataset.pm !== "min") filter.photo.min = 0;
      refreshHit();
    });
    const phMin = el("phFiltMin");
    if (phMin) phMin.oninput = () => { if (filter.photo.mode === "min") { filter.photo.min = Math.max(1, parseInt(phMin.value) || 1); refreshHit(); } };
    refreshHit();
    const mOffice = el("mOffice"); if (mOffice) mOffice.onclick = () => openOfficeManager();
    const mStation = el("mStation"); if (mStation) mStation.onclick = () => openStationManager();
    const mOrgMgr = el("mOrgMgr"); if (mOrgMgr) mOrgMgr.onclick = () => openOrgManager();
    const mBtypeMgr = el("mBtypeMgr"); if (mBtypeMgr) mBtypeMgr.onclick = () => openBtypeManager();
    el("fExit").onclick = closeModal;
    el("fApply").onclick = () => {
      filter.btype = [...body.querySelectorAll('.chip[data-grp="建筑物类型"].on')].map((c) => c.dataset.v);
      filter.mgmt = [...body.querySelectorAll('.chip[data-grp="管理处"].on')].map((c) => c.dataset.v);
      filter.office = [...body.querySelectorAll('.chip[data-grp="管理所"].on')].map((c) => c.dataset.v);
      filter.station = [...body.querySelectorAll('.chip[data-grp="管理站"].on')].map((c) => c.dataset.v);
      const pm = body.querySelector("#phFiltChips .chip.on");
      filter.photo.mode = pm ? pm.dataset.pm : "all";
      const mn = el("phFiltMin");
      filter.photo.min = (filter.photo.mode === "min" && mn) ? Math.max(1, parseInt(mn.value) || 1) : 0;
      closeModal(); render(); saveUI();
      // 结果行为：0→提示无符合；1→跳到该点；多→绿色虚线圆圈圈出全部并刚好显示
      const rs = records.filter(passFilter);
      if (!rs.length) toast("没有符合条件的选项");
      else if (rs.length === 1) {
        const r = rs[0], lat = +r.lat, lon = +r.lon;
        if (isFinite(lat) && isFinite(lon)) { map.flyTo([lat, lon], Math.max(map.getZoom(), 16), { duration: 0.6 }); layerGroup.eachLayer((m) => { if (m._rid === r.id) m.openPopup(); }); }
        toast("已定位唯一匹配：" + r.name);
      } else {
        drawFilterCircle(rs);
        toast(`已筛选出 ${rs.length} 个建筑物，已用绿色虚线圆圈圈出并居中显示`);
      }
    };
    el("fReset").onclick = () => { filter.office = []; filter.mgmt = []; filter.station = []; filter.btype = []; filter.photo = { mode: "all", min: 0 }; openFilter(); };
  }

  // ---------- 管理所 / 管理站 维护（手动增改 + 双向联动）----------
  function openOfficeManager() {
    const drawList = () => {
      const rows = DIMS.offices.map((o) => {
        const isBase = BASE_OFFICES_SET.has(o);
        const cnt = records.filter((r) => normOffice(orgVal(r, "office")) === o).length;
        const isExtra = (ORGCFG.officeExtra || []).map((x) => normOffice(x)).includes(o);
        const tag = isBase ? "基础(锁定)" : isExtra ? "自定义" : "数据派生";
        const acts = isBase
          ? `<span class="cfg-lock">🔒 基础名单</span>`
          : `<button class="btn tiny" data-act="ren" data-v="${esc(o)}">重命名</button>` + (isExtra ? `<button class="btn tiny danger" data-act="del" data-v="${esc(o)}">删除</button>` : "");
        return `<div class="cfg-row"><span class="cfg-name">${esc(o)}</span><span class="cfg-sub">${cnt} 个建筑物 · ${tag}</span>` +
          `<span class="cfg-acts">${acts}</span></div>`;
      }).join("");
      const html = `<div class="hint">管理所共 <b>${DIMS.offices.length}</b> 个；基础名单不可删，自定义可重命名/删除。重命名会联动其下管理站与建筑物。</div>` +
        `<div class="cfg-list">${rows}</div>` +
        `<div class="cfg-add"><input id="ofAdd" placeholder="新增管理所名称"><button class="btn primary" id="ofAddBtn">➕ 添加</button></div>`;
      openModal("管理所维护", html, `<button class="btn ghost" id="ofClose">关闭</button>`);
      const body = el("modalBody");
      body.querySelectorAll('button[data-act="ren"]').forEach((b) => b.onclick = () => renameOffice(b.dataset.v));
      body.querySelectorAll('button[data-act="del"]').forEach((b) => b.onclick = () => delOffice(b.dataset.v));
      el("ofAddBtn").onclick = () => {
        const v = normOffice(el("ofAdd").value);
        if (!v) return toast("名称不能为空");
        if (DIMS.offices.includes(v)) return toast("已存在同名管理所");
        ORGCFG.officeExtra = [...(ORGCFG.officeExtra || []), v]; saveCFG(); applyDims(); drawList(); toast("已添加：" + v);
      };
      el("ofClose").onclick = () => { closeModal(); openFilter(); };
    };
    const renameOffice = (old) => {
      const nv = normOffice(prompt("重命名管理所「" + old + "」为新名称：", old));
      if (!nv || nv === old) return;
      if (DIMS.offices.includes(nv)) return toast("已存在同名管理所");
      const aff = records.filter((r) => normOffice(orgVal(r, "office")) === old);
      const cascade = aff.length ? confirm(`将把 ${aff.length} 个建筑物的管理所「${old}」改为「${nv}」，是否一并更新？\n（取消则仅修改下拉名称，建筑物保留旧名）`) : false;
      (async () => {
        if (cascade) {
          await Store.patch((d) => { aff.forEach((r) => { d.updated[r.id] = Object.assign({}, r, { office: nv }); }); });
          DELTA = await Store.get();
        }
        ORGCFG.officeExtra = [...(ORGCFG.officeExtra || []).filter((x) => normOffice(x) !== old), nv];
        (ORGCFG.stations || []).forEach((s) => { if (normOffice(s.office) === old) s.office = nv; });
        saveCFG();
        merge(); applyDims(); render(); drawList();
        toast("已重命名：" + old + " → " + nv);
      })();
    };
    const delOffice = (o) => {
      const aff = records.filter((r) => normOffice(r.office) === o);
      if (!confirm(`确认删除管理所「${o}」？${aff.length ? "\n（含 " + aff.length + " 个建筑物的管理所将变为空）" : ""}`)) return;
      ORGCFG.officeExtra = (ORGCFG.officeExtra || []).filter((x) => normOffice(x) !== o);
      (ORGCFG.stations || []).forEach((s) => { if (normOffice(s.office) === o) s.office = ""; });
      saveCFG(); applyDims(); drawList(); toast("已删除：" + o);
    };
    drawList();
  }
  function openStationManager() {
    const drawList = () => {
      const rows = DIMS.stations.map((s) => {
        const off = stationOffice(s);
        const cnt = records.filter((r) => (r.station || "") === s).length;
        const isExtra = (ORGCFG.stations || []).some((x) => x.name === s);
        const offSel = DIMS.offices.map((o) => `<option value="${esc(o)}" ${o === off ? "selected" : ""}>${esc(o)}</option>`).join("");
        return `<div class="cfg-row"><span class="cfg-name">${esc(s)}</span><span class="cfg-sub">${cnt} 个建筑物</span>` +
          `<span class="cfg-off"><select class="st-off" data-st="${esc(s)}">${offSel}</select></span>` +
          `<span class="cfg-acts"><button class="btn tiny" data-act="ren" data-v="${esc(s)}">重命名</button>${isExtra ? `<button class="btn tiny danger" data-act="del" data-v="${esc(s)}">删除</button>` : ""}</span></div>`;
      }).join("");
      const html = `<div class="hint">管理站 / 渠道段共 <b>${DIMS.stations.length}</b> 个；右侧下拉可调整所属管理所（双向一致）。自定义可重命名/删除。</div>` +
        `<div class="cfg-list">${rows}</div>` +
        `<div class="cfg-add"><select id="stOff">${DIMS.offices.map((o) => `<option>${esc(o)}</option>`).join("")}</select><input id="stAdd" placeholder="新增管理站名称"><button class="btn primary" id="stAddBtn">➕ 添加</button></div>`;
      openModal("管理站维护", html, `<button class="btn ghost" id="stClose">关闭</button>`);
      const body = el("modalBody");
      body.querySelectorAll('button[data-act="ren"]').forEach((b) => b.onclick = () => renameStation(b.dataset.v));
      body.querySelectorAll('button[data-act="del"]').forEach((b) => b.onclick = () => delStation(b.dataset.v));
      body.querySelectorAll("select.st-off").forEach((sl) => sl.onchange = () => {
        const nm = sl.dataset.st, off = sl.value;
        const rec = (ORGCFG.stations || []).find((x) => x.name === nm);
        if (rec) { rec.office = off; saveCFG(); toast("已更新「" + nm + "」所属管理所：" + off); }
      });
      el("stAddBtn").onclick = () => {
        const nm = (el("stAdd").value || "").trim();
        if (!nm) return toast("名称不能为空");
        if (DIMS.stations.includes(nm)) return toast("已存在同名管理站");
        const off = el("stOff").value;
        ORGCFG.stations = [...(ORGCFG.stations || []), { office: off, name: nm }]; saveCFG(); applyDims(); drawList(); toast("已添加：" + nm + "（" + off + "）");
      };
      el("stClose").onclick = () => { closeModal(); openFilter(); };
    };
    const renameStation = (old) => {
      const nv = (prompt("重命名管理站「" + old + "」为新名称：", old) || "").trim();
      if (!nv || nv === old) return;
      if (DIMS.stations.includes(nv)) return toast("已存在同名管理站");
      const aff = records.filter((r) => (r.station || "") === old);
      const cascade = aff.length ? confirm(`将把 ${aff.length} 个建筑物的管理站「${old}」改为「${nv}」，是否一并更新？`) : false;
      (async () => {
        if (cascade) {
          await Store.patch((d) => { aff.forEach((r) => { d.updated[r.id] = Object.assign({}, r, { station: nv }); }); });
          DELTA = await Store.get();
        }
        const rec = (ORGCFG.stations || []).find((x) => x.name === old);
        if (rec) rec.name = nv;
        saveCFG();
        merge(); applyDims(); render(); drawList();
        toast("已重命名：" + old + " → " + nv);
      })();
    };
    const delStation = (s) => {
      if (!confirm(`确认删除管理站「${s}」？`)) return;
      ORGCFG.stations = (ORGCFG.stations || []).filter((x) => x.name !== s);
      saveCFG(); applyDims(); drawList(); toast("已删除：" + s);
    };
    drawList();
  }

  // ---------- 组织层级管理（局/管理处/所/站/段 · v2.4）----------
  function openOrgManager(focusLevel) {
    const LV = {
      bureau:  { label: "局",     field: "bureau",  dims: () => DIMS.bureaus,  extra: () => ORGCFG.bureaus,  setExtra: (a) => { ORGCFG.bureaus = a; } },
      mgmt:    { label: "管理处", field: "mgmt",    dims: () => DIMS.mgmts,    extra: () => ORGCFG.mgmts,    setExtra: (a) => { ORGCFG.mgmts = a; } },
      office:  { label: "所",     field: "office",  dims: () => DIMS.offices,  extra: () => ORGCFG.officeExtra, setExtra: (a) => { ORGCFG.officeExtra = a; } },
      station: { label: "站",     field: "station", dims: () => DIMS.stations, extra: null },
      section: { label: "段",     field: "section", dims: () => DIMS.sections, extra: () => ORGCFG.sections, setExtra: (a) => { ORGCFG.sections = a; } }
    };
    const cntOf = (lv, v) => {
      if (lv === "station") return records.filter((r) => (r.station || "") === v).length;
      if (lv === "office") return records.filter((r) => normOffice(orgVal(r, "office")) === v).length;
      return records.filter((r) => orgVal(r, lv) === v).length;
    };
    const isDefaultOf = (lv, v) => orgDefault(lv) === v;
    const rows = (lv) => {
      const L = LV[lv];
      return (L.dims() || []).map((v) => {
        const cnt = cntOf(lv, v);
        const isDef = isDefaultOf(lv, v);
        const isBase = (lv === "office") && BASE_OFFICES_SET.has(v);
        const isExtra = L.extra ? (L.extra() || []).includes(v) : ((ORGCFG.stations || []).some((x) => x.name === v));
        const tag = isDef ? '<span class="cfg-lock">⭐ 默认</span>' : isBase ? '<span class="cfg-lock">🔒 基础名单</span>' : isExtra ? "自定义" : "数据派生";
        let acts = `<button class="btn tiny" data-ren="${lv}" data-v="${esc(v)}">重命名</button>`;
        if (!isDef && !isBase && isExtra) acts += ` <button class="btn tiny danger" data-del="${lv}" data-v="${esc(v)}">删除</button>`;
        let parent = "";
        if (lv === "station") {
          const off = stationOffice(v);
          parent = `<span class="cfg-off"><select class="st-off" data-st="${esc(v)}">${DIMS.offices.map((o) => `<option value="${esc(o)}" ${o === off ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></span>`;
        }
        if (lv === "section") {
          const st = (ORGCFG.secParent || {})[v] || "";
          parent = `<span class="cfg-off"><select class="sec-par" data-sec="${esc(v)}"><option value="">（不隶属站）</option>${DIMS.stations.map((o) => `<option value="${esc(o)}" ${o === st ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></span>`;
        }
        return `<div class="cfg-row"><span class="cfg-name">${esc(v)}</span><span class="cfg-sub">${cnt} 个建筑物 · ${tag}</span>${parent}<span class="cfg-acts">${acts}</span></div>`;
      }).join("") || '<span class="hint">暂无</span>';
    };
    const addRow = (lv, extraHtml) =>
      `<div class="cfg-add"><input id="add_${lv}" placeholder="新增${LV[lv].label}名称">${extraHtml || ""}<button class="btn primary" data-add="${lv}">➕ 添加</button></div>`;
    const sec = (lv, hint, extraHtml) =>
      `<div class="fgroup" id="sec_${lv}"><div class="ftitle">${LV[lv].label}（<b class="cnt">${(LV[lv].dims() || []).length}</b>）</div>` +
      (hint ? `<div class="hint">${hint}</div>` : "") + `<div class="cfg-list">${rows(lv)}</div>` + addRow(lv, extraHtml) + `</div>`;
    // v2.4.1：默认值编辑 — office 改为多选 chip（支持多个默认所），其他层级单值
    const defRow = (lv) => {
      const L = LV[lv];
      if (lv === "office") {
        const arr = orgDefault("office");
        const chips = (DIMS.offices || []).map((o) => {
          const on = arr.includes(o);
          return `<span class="chip ${on ? "on" : ""}" data-def-office="${esc(o)}">${esc(o)}</span>`;
        }).join("");
        return `<div class="cfg-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <span class="cfg-name" style="min-width:64px">默认${L.label}（多选）</span>
          <div class="chips" id="def_${lv}_chips" style="width:100%">${chips || '<span class="hint">无选项</span>'}</div>
          <div class="hint" style="font-size:12px">勾选多个所作为「新增建筑物 / 空值回填」的默认预填；保存后立即生效。</div>
        </div>`;
      }
      return `<div class="cfg-row"><span class="cfg-name" style="min-width:64px">默认${L.label}</span>` +
        `<input class="cfg-definp" id="def_${lv}" value="${esc(orgDefault(lv))}" placeholder="${lv === "section" ? "可留空（段默认空）" : "默认" + L.label + "名称"}" style="flex:1"></div>`;
    };
    const html = `<div class="hint">组织层级：局 → 管理处 → 所 → 站 → 段。此处增删改会<b>同步更新</b>筛选、导入导出、添加建筑物等全部用到该层级的位置；重命名可级联更新建筑物。</div>` +
      sec("bureau", "顶级单位，默认：" + esc(orgDefault("bureau"))) +
      sec("mgmt", "局的下级管理处，默认：" + esc(orgDefault("mgmt"))) +
      sec("office", "基础 9 所名单不可删；自定义可重命名/删除。") +
      sec("station", "站隶属于所（右侧下拉可调整）。") +
      sec("section", "段隶属于站（可留空）。") +
      `<div class="fgroup"><div class="ftitle">默认值（新增建筑物预填 / 空值回填显示）</div>` +
      `<div class="cfg-list">` + ORG_LEVELS.map((l) => defRow(l.key)).join("") + `</div></div>` +
      `<div class="hint" id="orgSyncTip">修改即时生效并已自动保存；点「保存并全量同步」将刷新全部界面与统计。</div>`;
    openModal("机构层级管理", html, `<button class="btn ghost" id="omClose">关闭</button><button class="btn primary" id="omSync">💾 保存并全量同步</button>`);
    const body = el("modalBody");
    const redraw = () => { saveCFG(); applyDims(); openOrgManager(focusLevel); };
    body.querySelectorAll('button[data-ren]').forEach((b) => b.onclick = () => {
      const lv = b.dataset.ren, old = b.dataset.v;
      const nv = (prompt("重命名「" + LV[lv].label + "」：" + old + " →", old) || "").trim();
      if (!nv || nv === old) return;
      renameOrg(lv, old, nv, () => redraw());
    });
    body.querySelectorAll('button[data-del]').forEach((b) => b.onclick = () => {
      const lv = b.dataset.del, v = b.dataset.v;
      const aff = LV[lv].dims() ? cntOf(lv, v) : 0;
      if (!confirm(`确认删除${LV[lv].label}「${v}」？${aff ? "\n（" + aff + " 个建筑物仍保留该名称，仅从下拉选项移除）" : ""}`)) return;
      deleteOrg(lv, v, () => redraw());
    });
    body.querySelectorAll('button[data-add]').forEach((b) => b.onclick = () => {
      const lv = b.dataset.add;
      const v = (el("add_" + lv).value || "").trim();
      if (!v) return toast("名称不能为空");
      if ((LV[lv].dims() || []).includes(v)) return toast("已存在同名" + LV[lv].label);
      addOrg(lv, v, null);
      toast("已添加" + LV[lv].label + "：" + v); redraw();
    });
    body.querySelectorAll("select.st-off").forEach((sl) => sl.onchange = () => {
      const nm = sl.dataset.st, off = sl.value;
      const rec = (ORGCFG.stations || []).find((x) => x.name === nm);
      if (rec) { rec.office = off; saveCFG(); toast("已更新「" + nm + "」所属管理所：" + off); }
    });
    body.querySelectorAll("select.sec-par").forEach((sl) => sl.onchange = () => {
      ORGCFG.secParent = ORGCFG.secParent || {};
      ORGCFG.secParent[sl.dataset.sec] = sl.value; saveCFG(); toast("已更新段隶属站");
    });
    body.querySelectorAll("input.cfg-definp").forEach((inp) => inp.onchange = () => {
      const lv = inp.id.replace("def_", "");
      ORGCFG.defaults[lv] = inp.value.trim(); saveCFG(); applyDims();
      toast("默认" + LV[lv].label + "已更新：\uff1a" + (ORGCFG.defaults[lv] || "\uff08\u7a7a\uff09"));
    });
    // v2.4.1：默认值 office 多选 chips（每个 chip 切换即改默认集合）
    const defOfficeChips = el("def_office_chips");
    if (defOfficeChips) defOfficeChips.querySelectorAll(".chip").forEach((c) => c.onclick = () => {
      c.classList.toggle("on");
      ORGCFG.defaults.office = [...defOfficeChips.querySelectorAll(".chip.on")].map((x) => x.dataset.defOffice);
      saveCFG(); applyDims();
      toast("\u5df2\u9009\u62e9\u9ed8\u8ba4\u7ba1\u7406\u6240\uff1a" + (ORGCFG.defaults.office.length ? ORGCFG.defaults.office.join("\u3001") : "\uff08\u5168\u7a7a\uff09"));
    });
    el("omClose").onclick = () => { closeModal(); openFilter(); };
    el("omSync").onclick = () => {
      saveCFG(); merge(); applyDims(); render();
      toast(`已全量同步：局${DIMS.bureaus.length} · 管理处${DIMS.mgmts.length} · 所${DIMS.offices.length} · 站${DIMS.stations.length} · 段${DIMS.sections.length} · 类型${DIMS.btypes.length}`);
    };
  }
  function renameOrg(lv, old, nv, done) {
    const dup = (lv === "station") ? DIMS.stations.includes(nv)
      : (lv === "office") ? DIMS.offices.includes(nv)
      : (lv === "bureau") ? DIMS.bureaus.includes(nv)
      : (lv === "mgmt") ? DIMS.mgmts.includes(nv)
      : DIMS.sections.includes(nv);
    if (dup) { toast("已存在同名"); return; }
    const aff = (lv === "office") ? records.filter((r) => normOffice(orgVal(r, "office")) === old)
      : records.filter((r) => orgVal(r, lv) === old);
    const cascade = aff.length ? confirm(`将把 ${aff.length} 个建筑物的${lv === "office" ? "管理所" : "该层级"}「${old}」改为「${nv}」，是否一并更新？\n（取消则仅修改下拉名称，建筑物保留旧名）`) : false;
    (async () => {
      if (cascade) {
        await Store.patch((d) => { aff.forEach((r) => { const o = Object.assign({}, r); o[lv] = nv; d.updated[r.id] = o; }); });
        DELTA = await Store.get();
      }
      if (lv === "office") {
        ORGCFG.officeExtra = [...(ORGCFG.officeExtra || []).filter((x) => normOffice(x) !== old), nv];
        (ORGCFG.stations || []).forEach((s) => { if (normOffice(s.office) === old) s.office = nv; });
      } else if (lv === "station") {
        const rec = (ORGCFG.stations || []).find((x) => x.name === old);
        if (rec) rec.name = nv;
      } else if (lv === "bureau" || lv === "mgmt" || lv === "section") {
        const arr = (lv === "bureau") ? ORGCFG.bureaus : (lv === "mgmt") ? ORGCFG.mgmts : ORGCFG.sections;
        ORGCFG[lv === "bureau" ? "bureaus" : lv === "mgmt" ? "mgmts" : "sections"] = [...(arr || []).filter((x) => x !== old), nv];
      }
      if (orgDefault(lv) === old) ORGCFG.defaults[lv] = nv;
      saveCFG(); merge(); applyDims(); render();
      toast("已重命名：" + old + " → " + nv);
      if (done) done();
    })();
  }
  function deleteOrg(lv, v, done) {
    if (lv === "office") {
      ORGCFG.officeExtra = (ORGCFG.officeExtra || []).filter((x) => normOffice(x) !== v);
      (ORGCFG.stations || []).forEach((s) => { if (normOffice(s.office) === v) s.office = ""; });
    } else if (lv === "station") {
      ORGCFG.stations = (ORGCFG.stations || []).filter((x) => x.name !== v);
    } else if (lv === "bureau") ORGCFG.bureaus = (ORGCFG.bureaus || []).filter((x) => x !== v);
    else if (lv === "mgmt") ORGCFG.mgmts = (ORGCFG.mgmts || []).filter((x) => x !== v);
    else if (lv === "section") ORGCFG.sections = (ORGCFG.sections || []).filter((x) => x !== v);
    saveCFG(); applyDims();
    toast("已删除：" + v);
    if (done) done();
  }
  function addOrg(lv, v, _parent) {
    if (lv === "office") ORGCFG.officeExtra = [...(ORGCFG.officeExtra || []), v];
    else if (lv === "station") ORGCFG.stations = [...(ORGCFG.stations || []), { office: orgDefault("office"), name: v }];
    else if (lv === "bureau") ORGCFG.bureaus = [...(ORGCFG.bureaus || []), v];
    else if (lv === "mgmt") ORGCFG.mgmts = [...(ORGCFG.mgmts || []), v];
    else if (lv === "section") ORGCFG.sections = [...(ORGCFG.sections || []), v];
    saveCFG(); applyDims();
  }
  // ---------- 建筑物类型管理（增删改 · 全程序同步 · v2.4）----------
  function openBtypeManager() {
    const rows = DIMS.btypes.map((t) => {
      const cnt = records.filter((r) => r.btype === t).length;
      const isExtra = (ORGCFG.btypeExtra || []).includes(t);
      const tag = isExtra ? "自定义" : "数据派生";
      const acts = `<button class="btn tiny" data-act="ren" data-v="${esc(t)}">重命名</button>` + (isExtra ? ` <button class="btn tiny danger" data-act="del" data-v="${esc(t)}">删除</button>` : "");
      return `<div class="cfg-row"><span class="cfg-name">${esc(t)}</span><span class="cfg-sub">${cnt} 个建筑物 · ${tag}</span><span class="cfg-acts">${acts}</span></div>`;
    }).join("");
    const html = `<div class="hint">建筑物类型共 <b>${DIMS.btypes.length}</b> 个；数据派生类型可重命名（级联更新建筑物），自定义类型可重命名/删除。修改后自动同步筛选、表单、导出等全部位置。</div>` +
      `<div class="cfg-list">${rows}</div>` +
      `<div class="cfg-add"><input id="btAdd" placeholder="新增建筑物类型名称"><button class="btn primary" id="btAddBtn">➕ 添加</button></div>`;
    openModal("建筑物类型管理", html, `<button class="btn ghost" id="btClose">关闭</button><button class="btn primary" id="btSync">💾 保存并全量同步</button>`);
    const body = el("modalBody");
    const redraw = () => { saveCFG(); applyDims(); openBtypeManager(); };
    body.querySelectorAll('button[data-act="ren"]').forEach((b) => b.onclick = () => {
      const old = b.dataset.v;
      const nv = (prompt("重命名建筑物类型「" + old + "」为：", old) || "").trim();
      if (!nv || nv === old) return;
      if (DIMS.btypes.includes(nv)) return toast("已存在同名类型");
      const aff = records.filter((r) => r.btype === old);
      const cascade = aff.length ? confirm(`将把 ${aff.length} 个建筑物的类型「${old}」改为「${nv}」，是否一并更新？`) : false;
      (async () => {
        if (cascade) {
          await Store.patch((d) => { aff.forEach((r) => { const o = Object.assign({}, r); o.btype = nv; o.type = (o.station && nv) ? o.station + "--" + nv : nv; d.updated[r.id] = o; }); });
          DELTA = await Store.get();
        }
        ORGCFG.btypeExtra = [...(ORGCFG.btypeExtra || []).filter((x) => x !== old), nv];
        saveCFG(); merge(); applyDims(); render(); redraw();
        toast("已重命名：" + old + " → " + nv);
      })();
    });
    body.querySelectorAll('button[data-act="del"]').forEach((b) => b.onclick = () => {
      const t = b.dataset.v;
      const aff = records.filter((r) => r.btype === t).length;
      if (!confirm(`确认删除类型「${t}」？${aff ? "\n（" + aff + " 个建筑物仍保留该类型名，仅从下拉选项移除）" : ""}`)) return;
      ORGCFG.btypeExtra = (ORGCFG.btypeExtra || []).filter((x) => x !== t);
      saveCFG(); applyDims(); redraw(); toast("已删除：" + t);
    });
    el("btAddBtn").onclick = () => {
      const v = (el("btAdd").value || "").trim();
      if (!v) return toast("名称不能为空");
      if (DIMS.btypes.includes(v)) return toast("已存在同名类型");
      ORGCFG.btypeExtra = [...(ORGCFG.btypeExtra || []), v];
      saveCFG(); applyDims(); redraw(); toast("已添加：" + v);
    };
    el("btClose").onclick = () => { closeModal(); openFilter(); };
    el("btSync").onclick = () => { saveCFG(); merge(); applyDims(); render(); toast("已全量同步：类型 " + DIMS.btypes.length + " 项，筛选/表单/导出均已更新"); };
  }

  // ---------- 添加 / 编辑 表单 ----------
  function formHtml(r, preset) {
    r = r || {};
    formPhotos = (r.photos || []).map((p) => ({ caption: p.caption || "", dataUrl: p.dataUrl || "" }));
    const lon0 = (r.lon != null) ? r.lon : (preset && isFinite(preset.lon) ? preset.lon : "");
    const lat0 = (r.lat != null) ? r.lat : (preset && isFinite(preset.lat) ? preset.lat : "");
    formColor = r.mcolor || "#3da9fc"; formShape = r.mshape || "drop";
    const offices = DIMS.offices, btypes = DIMS.btypes;
    const sel = (id, arr, val) => `<select id="${id}">${[""].concat(arr).map((v) => `<option ${v === val ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
    return `<div class="row2">
        <div class="field"><label>名称 *</label><input id="fName" value="${esc(r.name || "")}"></div>
        <div class="field"><label>建筑物类型</label>${sel("fBtype", btypes, r.btype)}</div>
      </div>
      <div class="row2">
        <div class="field"><label>局</label>${sel("fBureau", DIMS.bureaus, r.bureau || orgDefault("bureau"))}</div>
        <div class="field"><label>管理处</label>${sel("fMgmt", DIMS.mgmts, r.mgmt || orgDefault("mgmt"))}</div>
      </div>
      <div class="row2">
        <div class="field"><label>管理所</label>${sel("fOffice", offices, normOffice(orgVal(r, "office") || ""))}</div>
        <div class="field"><label>管理站</label>${sel("fStation", DIMS.stations, r.station)}</div>
      </div>
      <div class="row2">
        <div class="field"><label>段（站的下级，可留空）</label>${sel("fSection", DIMS.sections, r.section)}</div>
        <div class="field"><label>&nbsp;</label><div class="hint" style="margin-top:24px">局/管理处/段用于导出命名与文件夹层次组合。</div></div>
      </div>
      <div class="row2">
        <div class="field"><label>经度</label><input id="fLon" value="${lon0}" inputmode="decimal"></div>
        <div class="field"><label>纬度</label><input id="fLat" value="${lat0}" inputmode="decimal"></div>
      </div>
      <button class="btn ghost" id="fPick" style="margin-bottom:6px">📍 重新在地图上点选坐标</button>
      <div class="hint" style="margin-bottom:12px">坐标已预填（可手改或重新点选）。</div>
      <div class="row2">
        <div class="field"><label>标记颜色</label><div class="mc-pal" id="fColor">${MARKER_COLORS.map((c) => `<span class="mc-swat ${formColor === c ? "on" : ""}" data-c="${c}" style="background:${c}"></span>`).join("")}</div></div>
        <div class="field"><label>标记形状</label><div class="mc-shapes" id="fShape">${MARKER_SHAPES.map((s) => `<span class="mc-shp ${formShape === s ? "on" : ""}" data-s="${s}">${SHAPE_GLYPH[s]}</span>`).join("")}</div></div>
      </div>
      <div class="hint" style="margin-top:-4px;margin-bottom:12px">颜色/形状用于在地图上区分不同建筑物（默认蓝色水滴）。</div>
      <div class="field"><label>工程参数（每行 字段: 值）</label><textarea id="fParams">${esc((r.params ? Object.entries(r.params).map(([k, v]) => `${k} : ${v}`).join("\n") : ""))}</textarea></div>
      <div class="field"><label>照片（可多张：正面 / 背面 / 侧面…）</label>
        <div class="photo-grid" id="fPhotos"></div>
        <div class="photo-add" id="fAddPhoto">＋ 添加照片</div>
        <input type="file" id="fFile" accept="image/*" multiple style="display:none">
      </div>`;
  }
  function renderPhotos() {
    const box = el("fPhotos"); if (!box) return;
    box.innerHTML = formPhotos.map((p, i) =>
      `<div class="photo-item"><img src="${p.thumb || p.dataUrl}"><div class="pc"><input value="${esc(p.caption)}" data-i="${i}" class="pcap" style="width:100%;border:0;background:transparent;color:#fff;font-size:11px" placeholder="说明"></div><button class="del" data-i="${i}">×</button></div>`
    ).join("");
    box.querySelectorAll(".del").forEach((b) => b.onclick = () => { formPhotos.splice(+b.dataset.i, 1); renderPhotos(); });
    box.querySelectorAll(".pcap").forEach((b) => b.onchange = () => { formPhotos[+b.dataset.i].caption = b.value; saveAddDraft(); });
  }

  // 添加草稿暂存（防护：Android WebView 选文件/切后台重建导致 JS 状态丢失 → 信息丢失）
  const ADD_DRAFT_KEY = "shuili_add_draft_v1";
  function saveAddDraft() {
    try {
      const f = {
        editId,
        photos: formPhotos.map((p) => ({ caption: p.caption || "", dataUrl: p.dataUrl || "", thumb: p.thumb || "", full: p.full || "", hash: p.hash || "", fullPath: p.fullPath || "" })),
        fields: el("fName") ? {
          name: el("fName").value, office: el("fOffice") ? el("fOffice").value : "", station: el("fStation") ? el("fStation").value : "",
          bureau: el("fBureau") ? el("fBureau").value : "", mgmt: el("fMgmt") ? el("fMgmt").value : "", section: el("fSection") ? el("fSection").value : "",
          btype: el("fBtype") ? el("fBtype").value : "", lon: el("fLon") ? el("fLon").value : "", lat: el("fLat") ? el("fLat").value : "",
          params: el("fParams") ? el("fParams").value : "", color: formColor, shape: formShape
        } : null,
        ts: Date.now()
      };
      sessionStorage.setItem(ADD_DRAFT_KEY, JSON.stringify(f));
    } catch (e) {}
  }
  function loadAddDraft() { try { const s = sessionStorage.getItem(ADD_DRAFT_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function clearAddDraft() { try { sessionStorage.removeItem(ADD_DRAFT_KEY); } catch (e) {} }
  function restoreAddDraft() {
    const d = loadAddDraft();
    if (!d || d.editId !== editId) return;        // 仅恢复"新建"草稿（editId 均为 null）
    if (d.photos && d.photos.length) formPhotos = d.photos;
    if (d.fields) {
      const f = d.fields;
      if (el("fName")) el("fName").value = f.name || "";
      if (el("fOffice")) el("fOffice").value = f.office || "";
      if (el("fStation")) el("fStation").value = f.station || "";
      if (el("fBureau")) el("fBureau").value = f.bureau || orgDefault("bureau");
      if (el("fMgmt")) el("fMgmt").value = f.mgmt || orgDefault("mgmt");
      if (el("fSection")) el("fSection").value = f.section || "";
      if (el("fBtype")) el("fBtype").value = f.btype || "";
      if (el("fLon")) el("fLon").value = f.lon || "";
      if (el("fLat")) el("fLat").value = f.lat || "";
      if (el("fParams")) el("fParams").value = f.params || "";
      formColor = f.color || "#3da9fc"; formShape = f.shape || "drop";
    }
    renderPhotos();
  }
  function openAdd() {
    editId = null;
    const d = loadAddDraft();
    if (d && d.fields) { formPhotos = d.photos || []; openAddForm(null); }   // 有草稿直达第2步并恢复字段
    else { formPhotos = []; clearAddDraft(); startAddStep1(null); }
  }
  // 添加建筑物 · 第 1 步：先引导获取坐标（我的位置 / 地图点选 / 搜索 / 手填）
  function startAddStep1(preset) {
    const cur = (preset && isFinite(preset.lat) && isFinite(preset.lon)) ? { lat: preset.lat, lon: preset.lon } : { lat: null, lon: null };
    const html = `
      <div class="hint" style="margin-bottom:10px">第 1 步 / 共 2 步：请先获取该建筑物的坐标，再填写信息。</div>
      <div class="field"><label>坐标（WGS84 十进制）</label>
        <div class="coord-display">
          <div class="cd-row"><span class="cd-k">纬度 Lat</span><span class="cd-v" id="acLat">${cur.lat != null ? cur.lat.toFixed(6) : "—"}</span></div>
          <div class="cd-row"><span class="cd-k">经度 Lng</span><span class="cd-v" id="acLon">${cur.lon != null ? cur.lon.toFixed(6) : "—"}</span></div>
        </div>
      </div>
      <div class="coord-actions">
        <button class="btn ghost" id="acMe">📍 我的位置</button>
        <button class="btn ghost" id="acPick">🗺 地图点选</button>
      </div>
      <div class="field" style="margin-top:12px"><label>手填经纬度</label>
        <div class="row2">
          <input id="acLatIn" inputmode="decimal" placeholder="纬度 Lat">
          <input id="acLonIn" inputmode="decimal" placeholder="经度 Lng">
        </div>
      </div>
      <div class="field" style="margin-top:6px"><label>搜索已有建筑物获取坐标</label>
        <input id="acSearch" placeholder="输入名称…" autocomplete="off">
        <div class="cd-results" id="acResults"></div>
      </div>
      <div class="hint">我的位置需授权定位；地图点选请关闭本弹窗后在地图上点击；也可直接手填或搜索。</div>`;
    openModal("添加建筑物 · 第 1 步：获取坐标", html, `<button class="btn ghost" id="acCancel">取消</button><button class="btn ghost" id="acSkip">稍后填坐标</button><button class="btn primary" id="acNext" ${cur.lat == null ? "disabled" : ""}>下一步：填写建筑信息</button>`);
    const setDisp = () => {
      el("acLat").textContent = cur.lat != null ? cur.lat.toFixed(6) : "—";
      el("acLon").textContent = cur.lon != null ? cur.lon.toFixed(6) : "—";
      el("acNext").disabled = !(cur.lat != null && cur.lon != null);
    };
    el("acMe").onclick = () => {
      if (!navigator.geolocation) return toast("当前环境不支持定位");
      toast("正在定位…");
      navigator.geolocation.getCurrentPosition((p) => { cur.lat = p.coords.latitude; cur.lon = p.coords.longitude; setDisp(); map.setView([cur.lat, cur.lon], 15); toast("已获取我的位置坐标"); }, (err) => { if (window.AndroidBridge && window.AndroidBridge.openLocationSettings) window.AndroidBridge.openLocationSettings(); else toast("定位失败，请检查定位权限"); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    };
    el("acPick").onclick = () => { closeModal(); pickForCoord = true; pendingCoordCb = (c) => startAddStep1(c); togglePick(true); toast("请在地图上点选位置（再次点此取消）"); };
    el("acLatIn").oninput = el("acLonIn").oninput = () => {
      const la = parseFloat(el("acLatIn").value), lo = parseFloat(el("acLonIn").value);
      if (isFinite(la) && isFinite(lo)) { cur.lat = la; cur.lon = lo; setDisp(); }
    };
    el("acSearch").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase(); const box = el("acResults");
      if (!q) { box.innerHTML = ""; return; }
      const rs = records.filter((r) => `${r.name}${r.office}${r.station}`.toLowerCase().includes(q)).slice(0, 30);
      box.innerHTML = rs.map((r) => `<div class="cd-item" data-id="${r.id}"><span>${esc(r.name)}</span><span class="cd-xy">${(+r.lat).toFixed(5)} , ${(+r.lon).toFixed(5)}</span></div>`).join("");
      box.querySelectorAll(".cd-item").forEach((it) => it.onclick = () => { const rr = records.find((x) => x.id === it.dataset.id); if (!rr) return; cur.lat = +rr.lat; cur.lon = +rr.lon; setDisp(); map.flyTo([cur.lat, cur.lon], Math.max(map.getZoom(), 15), { duration: 0.6 }); toast("已定位：" + rr.name); });
    });
    el("acCancel").onclick = () => { clearAddDraft(); closeModal(); };
    el("acSkip").onclick = () => openAddForm(null);
    el("acNext").onclick = () => openAddForm(cur);
  }
  function openAddForm(preset) {
    openModal("添加建筑物 · 第 2 步：填写信息", formHtml(null, preset), `<button class="btn ghost" id="fCancel">取消</button><button class="btn primary" id="fSave">保存</button>`);
    bindForm();
  }
  function openEdit(id) {
    editId = id;
    const r = records.find((x) => x.id === id); if (!r) return;
    openModal("编辑：" + r.name, formHtml(r), `<button class="btn ghost" id="fCancel">取消</button><button class="btn primary" id="fSave">保存</button>`);
    bindForm();
  }
  function bindForm() {
    restoreAddDraft();
    renderPhotos();
    ["fName", "fOffice", "fStation", "fBtype", "fBureau", "fMgmt", "fSection", "fLon", "fLat", "fParams"].forEach((id) => { const e = el(id); if (e) e.onchange = e.oninput = saveAddDraft; });
    const pal = el("fColor");
    if (pal) pal.querySelectorAll(".mc-swat").forEach((s) => s.onclick = () => {
      pal.querySelectorAll(".mc-swat").forEach((x) => x.classList.remove("on")); s.classList.add("on"); formColor = s.dataset.c;
    });
    const shp = el("fShape");
    if (shp) shp.querySelectorAll(".mc-shp").forEach((s) => s.onclick = () => {
      shp.querySelectorAll(".mc-shp").forEach((x) => x.classList.remove("on")); s.classList.add("on"); formShape = s.dataset.s;
    });
    el("fAddPhoto").onclick = () => { saveAddDraft(); el("fFile").click(); };
    el("fFile").onchange = (e) => {
      [...e.target.files].forEach((file, idx) => {
        const reader = new FileReader();
        reader.onload = () => {
          const cap = ["正面", "背面", "侧面", "全景", "细部"][formPhotos.length] || ("照片" + (formPhotos.length + 1));
          (async () => {
            let ph = { caption: cap, dataUrl: reader.result };
            try { const cp = await ImgUtil.compressPhoto(new Uint8Array(reader.result)); ph = { caption: cap, thumb: cp.thumb, full: cp.full, dataUrl: cp.full }; } catch (e) {}
            formPhotos.push(ph); renderPhotos(); saveAddDraft();
          })();
        };
        reader.readAsArrayBuffer(file);
      });
      e.target.value = "";
    };
    el("fPick").onclick = () => { togglePick(true); toast("请在地图上点击以确定坐标"); };
    el("fCancel").onclick = () => { clearAddDraft(); closeModal(); };
    el("fSave").onclick = saveForm;
  }
  function togglePick(on) {
    pickMode = on;
    el("pickmode").classList.toggle("show", on);
  }
  function parseParams(txt) {
    const p = {};
    txt.split("\n").forEach((ln) => { if (ln.includes(":")) { const a = ln.split(":"); p[a[0].trim()] = a.slice(1).join(":").trim(); } });
    return p;
  }
  async function saveForm() {
    const name = el("fName").value.trim();
    const lon = parseFloat(el("fLon").value), lat = parseFloat(el("fLat").value);
    if (!name) return toast("请填写名称");
    if (isNaN(lon) || isNaN(lat)) return toast("请填写有效经纬度（可点选）");
    const rec = {
      id: editId || IO.genId(), name, lon, lat, ts: Date.now(),
      office: el("fOffice").value, station: el("fStation").value, btype: el("fBtype").value,
      bureau: el("fBureau") ? el("fBureau").value : orgDefault("bureau"),
      mgmt: el("fMgmt") ? el("fMgmt").value : orgDefault("mgmt"),
      section: el("fSection") ? el("fSection").value : "",
      type: (el("fStation").value && el("fBtype").value) ? el("fStation").value + "--" + el("fBtype").value : el("fBtype").value,
      mcolor: formColor, mshape: formShape,
      params: parseParams(el("fParams").value), photos: formPhotos.map((p) => ({ caption: p.caption || "", dataUrl: p.thumb || p.dataUrl || "", thumb: p.thumb || p.dataUrl || "", full: p.full || "", hash: p.hash || "", fullPath: p.fullPath || "" })),
      base: editId ? (records.find((x) => x.id === editId) || {}).base : false, custom: true,
      description: Object.entries(parseParams(el("fParams").value)).map(([k, v]) => `${k} : ${v}`).join("\n")
    };
    await Store.patch((d) => {
      if (editId) {
        // 若是新增记录（在 added 中），更新它；否则记入 updated
        const i = (d.added || []).findIndex((a) => a.id === editId);
        if (i >= 0) d.added[i] = rec; else d.updated[editId] = rec;
      } else {
        d.added.push(rec);
      }
    });
    DELTA = await Store.get(); merge(); render();
    closeModal(); clearAddDraft(); toast(editId ? "已更新" : "已添加");
    kbLog(editId ? "更新建筑物" : "新增建筑物", { name });
  }

  async function del(id) {
    if (!confirm("确认删除该建筑物？")) return;
    await Store.patch((d) => {
      const i = (d.added || []).findIndex((a) => a.id === id);
      if (i >= 0) d.added.splice(i, 1);
      else { d.deleted = d.deleted || []; d.deleted.push(id); delete d.updated[id]; }
    });
    DELTA = await Store.get(); merge(); render();
    toast("已删除");
    kbLog("删除建筑物", { id });
  }

  // ---------- 批量导入（原生文件夹/zip 逐文件回调 APP.receivePhoto / receiveSheet）----------
  // bug②修复：新增 mid 形参 —— 导出包 manifest.json 提供的 filename -> 建筑物 id，用于确定性绑定
  function receivePhoto(name, b64, folder, mid, extra) { pendingBatch.photos.push(Object.assign({ name, b64, folder: folder || "", mid: mid || "" }, extra || {})); importCpTouch(); }
  // bug③修复：新增 bytes 形参 —— xlsx 等二进制表格必须走字节流。
  // 此前 xlsx 只传空文本给 parseCsvToRecords，解析结果恒为 0 条且不抛错（静默失败）。
  function receiveSheet(name, text, ext, bytes) { pendingBatch.sheets.push({ name, text, ext, bytes: bytes || null }); importCpTouch(); }
  function receiveError(msg) { BATCH_STATE.active = false; importCpEnd(); toast("导入出错：" + msg); }
  function receiveCancel() { if (BATCH_STATE.active) { BATCH_STATE.active = false; importCpEnd(); hideBusy(); pendingBatch.photos = []; pendingBatch.sheets = []; BATCH_ZIP_NAME = ""; toast("已取消导入"); } }
  function receiveDone(kind) {
    importCpEnd(); hideBusy();
    if (kind === "photos") finishBatchPhotos();
    else if (kind === "sheets") finishBatchSheets();
  }
  // 原生异步解压回调（item 1 根因修复：解压/缩略图全在原生线程，JS 仅收齐元数据再匹配）
  let zipProgOpen = false;
  window.onUnzipImages = function (ph, cnt, total) {
    if (!BATCH_STATE.active) return;
    if (!zipProgOpen) { openZipProgress(); }
    const prog = el("zipProg"), bar = el("zipBar");
    if (prog) prog.textContent = `已解压并生成缩略图 ${cnt} / ${total} 张…`;
    if (bar) bar.style.width = Math.min(100, Math.round((cnt / Math.max(1, total)) * 100)) + "%";
    // 仅保留轻量元数据：缩略图（小 base64）+ 全图磁盘路径 + 内容哈希；全图按需单张加载
    pendingBatch.photos.push({ name: ph.name, folder: ph.folder || "", b64: ph.thumb, thumb: ph.thumb, full: ph.full || "", fullPath: ph.fullPath || "", hash: ph.hash || "" });
    importCpTouch();
  };
  window.onUnzipImagesEnd = function (total) {
    if (!BATCH_STATE.active) return;
    closeZipProgress();
    if (pendingBatch.photos.length) finishBatchPhotos();
    else { BATCH_STATE.active = false; importCpEnd(); toast("压缩包中未找到照片"); }
  };
  function openZipProgress() {
    openModal("正在导入照片", `<div class="hint" id="zipProg">正在解压压缩包并生成缩略图…</div><div class="bar"><div class="bar-fill" id="zipBar" style="width:0%"></div></div>`, `<button class="btn ghost" id="zipCancel">取消</button>`);
    el("zipCancel").onclick = () => { BATCH_STATE.active = false; closeModal(); toast("已取消导入"); };
    zipProgOpen = true;
  }
  function closeZipProgress() { if (zipProgOpen) { closeModal(); zipProgOpen = false; } }
  // ---------- 智能模糊匹配工具（② 错字/多字/漏字/部分词；⑥ 文件夹上下文）----------
  function norm(s) { return (s || "").trim().toLowerCase().replace(/[\s_\-()（）．.]/g, ""); }
  // 管理所名称统一（需求）：去「管理」两字 + 潮河/水库特例；导入/导出/查询/筛选 全链路一致
  function normOffice(name) {
    if (!name) return "";
    const s = String(name).trim();
    if (/潮河/.test(s)) return "潮河所";            // 潮河管理所 / 潮河总干渠管理所 → 潮河所
    if (/水库/.test(s)) return "水库所";            // 怀柔水库所 / 水库管理所 → 水库所（与 9 所标准名单一致）
    return s.replace(/管理所/g, "所");              // 温泉管理所→温泉所、埝头管理所→埝头所、史山管理所→史山所
  }
  // 照片名匹配键：去扩展名 + 忽略末尾数字（峰山口1.jpg → 峰山口）
  function photoKey(name) { return norm((name || "").replace(/\.[^.]+$/, "").replace(/\d+$/, "")); }
  function levenshtein(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(Array(n).fill(0)));
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    }
    return d[m][n];
  }
  // ---------- v2.4 zip 三级匹配：压缩包文件名 → zip 内文件夹 → 照片文件名 ----------
  let BATCH_ZIP_NAME = ""; // 当前导入 zip 的文件名（不含扩展名）；Android 原生经 window.onZipName 下发，Web 在选择器回调内设置
  window.onZipName = function (name) { BATCH_ZIP_NAME = String(name || "").replace(/\.(zip|7z)$/i, ""); };
  // 压缩包名/文本 → 机构匹配（所→站→段→管理处→局，最具体优先）；命中返回限定范围。如 史山.zip → 优先匹配 史山所
  function matchOrgScope(text, allowTiers) {
    if (!text) return null;
    // 兼容「含路径/扩展名」的压缩包文件名：先取 basename、再去扩展名（如 /x/史山.zip 或 史山.zip → 史山）
    const base = String(text).split(/[\\/]/).pop() || String(text);
    const t = norm(base.replace(/\.(zip|7z|rar|tar|gz|tgz)$/i, ""));
    if (!t) return null;
    // v2.4.3 层次递进匹配（用户原话核心）：
    //   zip 名命中某级后，zip 内文件夹应从「命中级的下一级」开始向下匹配
    //   如 zip=史山.zip → 命中 所(史山所) → 文件夹只从 站/段 继续收窄
    //      zip=京密引水管理处.zip → 命中 处(mgmt) → 文件夹从 所/站/段 继续收窄
    const TIER_ORDER = ["bureau", "mgmt", "office", "station", "section"];
    // allowTiers：允许参与匹配的层级数组；null/undefined = 全部层级（zip 名首次匹配用）
    const hit = (val) => {
      const v = norm(val); if (!v || v.length < 2) return { ok: false, score: 0 };
      if (v === t) return { ok: true, score: 100 + v.length };
      if (t.includes(v) || v.includes(t)) return { ok: true, score: 80 + Math.min(v.length, t.length) };
      if (levenshtein(t, v) <= 1 && Math.max(t.length, v.length) >= 2) return { ok: true, score: 60 + Math.min(v.length, t.length) };
      return { ok: false, score: 0 };
    };
    const allowed = (s) => !allowTiers || allowTiers.indexOf(s) >= 0;
    const cands = [];
    if (allowed("office")) for (const off of DIMS.offices) { const h = hit(off); if (h.ok) cands.push({ scope: "office", label: "管理所：" + off, val: off, ...h }); }
    if (allowed("station")) for (const st of DIMS.stations) { const h = hit(st); if (h.ok) cands.push({ scope: "station", label: "管理站：" + st, val: st, ...h }); }
    if (allowed("section")) for (const sc of DIMS.sections) { const h = hit(sc); if (h.ok) cands.push({ scope: "section", label: "渠道段：" + sc, val: sc, ...h }); }
    if (allowed("mgmt")) for (const mg of DIMS.mgmts) { const h = hit(mg); if (h.ok) cands.push({ scope: "mgmt", label: "管理处：" + mg, val: mg, ...h }); }
    if (allowed("bureau")) for (const bu of DIMS.bureaus) { const h = hit(bu); if (h.ok) cands.push({ scope: "bureau", label: "局：" + bu, val: bu, ...h }); }
    if (!cands.length) return null;
    const tier = (s) => TIER_ORDER.indexOf(s);
    // 注意：TIER_ORDER 下标 bureau=0…section=4，越靠后越具体 → 排序用 tier 降序（具体级优先），与 v2.4.1 语义一致
    // 同分且同名（本数据 office 与 station 常同名，如 史山所）：zip 以「管理所」命名，应锚定 office 层级（标签/下钻才正确）
    const SCOPE_PREF = { office: 3, station: 2, section: 1, mgmt: 2, bureau: 1 };
    cands.sort((a, b) => (b.score - a.score) || ((SCOPE_PREF[b.scope] || 0) - (SCOPE_PREF[a.scope] || 0)) || (tier(b.scope) - tier(a.scope)) || (b.val.length - a.val.length));
    const top = cands[0];
    let recs;
    if (top.scope === "office") recs = records.filter((r) => normOffice(orgVal(r, "office")) === top.val);
    else if (top.scope === "station") recs = records.filter((r) => r.station === top.val);
    else if (top.scope === "section") recs = records.filter((r) => r.section === top.val);
    else if (top.scope === "mgmt") recs = records.filter((r) => orgVal(r, "mgmt") === top.val);
    else recs = records.filter((r) => orgVal(r, "bureau") === top.val);
    return { label: top.label, recs, tier: top.scope,
      // 供调用方做「下一级继续收窄」：返回命中级之后的所有层级
      nextTiers: TIER_ORDER.slice(tier(top.scope) + 1) };
  }
  // zip 名 → 文件夹递进：命中 zip 级后文件夹只从下级匹配
  function matchOrgScopeFrom(text, zipScope) {
    if (!zipScope || !zipScope.nextTiers) return matchOrgScope(text);
    const lower = matchOrgScope(text, zipScope.nextTiers);
    if (lower) return lower;
    // 下级无命中 → 退回在 zip 范围内按同层级再找一次（如 史山/史山所 这种重复写法）
    return matchOrgScope(text, [zipScope.tier]);
  }
  // 文件夹/分类上下文：路径各段（含子文件夹）模糊命中 管理所 或 建筑物类型 → 限定候选范围（item ⑥；v2.4 支持在 zip 名命中范围内继续收窄）
  function folderScope(folder, baseRecs, zipScope) {
    const base = baseRecs || records;
    if (!folder) return null;
    const segs = String(folder).split(/[\\/]/).map((s) => norm(s)).filter(Boolean);
    if (!segs.length) return null;
    // v2.4.3 第一优先：层次递进（zip 命中级的下一级开始向下匹配 所/站/段）
    for (const f of segs) {
      const m = matchOrgScopeFrom(f, zipScope);
      if (m && m.recs && m.recs.length) {
        const ids = new Set(base.map((r) => r.id));
        const recs = m.recs.filter((r) => ids.has(r.id));
        if (recs.length) return { label: m.label, recs, tier: m.tier };
      }
    }
    // 第二优先：建筑物类型（文件夹名是类型名时）
    for (const f of segs) {
      const bt = DIMS.btypes.find((t) => { const tn = norm(t); return tn && (tn === f || f.includes(tn) || tn.includes(f) || levenshtein(f, tn) <= 1); });
      if (bt) return { label: "类型：" + bt, recs: base.filter((r) => r.btype === bt) };
    }
    return null;
  }
  // 智能候选：评分式模糊匹配，返回按评分降序 [{x,score}]；阈值 45
  function smartCandidates(name, scope) {
    const base = (scope && scope.recs) || records;
    const key = photoKey(name); if (!key) return [];
    const half = key.slice(0, Math.ceil(key.length / 2));
    const out = [];
    for (const x of base) {
      const xn = norm(x.name); if (!xn) continue;
      let score = 0;
      if (xn === key) score = 100;
      else if (key.includes(xn) || xn.includes(key)) score = 85;                        // 包含关系
      else if (half.length >= 2 && xn.includes(half)) score = 72;                        // 部分关键词对应（峰山口 命中 峰山口大大）
      else if (key.length >= 2 && xn.includes(key.slice(0, 2))) score = 50;             // 前2字命中（漏字/多字/错字）
      else { const r = 1 - levenshtein(key, xn) / Math.max(key.length, xn.length, 1); if (r >= 0.6) score = Math.round(40 + r * 40); }
      if (score >= 45) out.push({ x, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  // #4 增强：zip 名/机构范围已收窄到某所（zipScope）后，用「文件夹名（最深层具体段）」作为建筑物名在范围内模糊匹配。
  // 例：史山.zip 内 分水闸/三号线分水闸/照片/三号线分水闸/IMG_6857.jpg → 在史山所范围内匹配「三号线分水闸」→ 三号线
  // 跳过 照片/分水闸 等通用词段，只取能指向具体建筑物的段；无具体段则不返回（回落到全局兜底）。
  // 文件夹名别名表（采集异写/笔误 → 标准建筑物名）：zip 文件夹段先经此表归一，再跑建筑物匹配。可扩展。
  // 例：史山.zip 中「三号线分水闸」(line) 实为「三扬分水闸」(raise)，归一后精确命中，满足用户预期。
  const FOLDER_ALIAS = {
    "三号线分水闸": "三扬分水闸",
  };
  function buildingCandidatesFromFolder(folder, scopeRecs) {
    const base = scopeRecs || records;
    if (!folder || !base || !base.length) return [];
    const segs = String(folder).split(/[\\/]/).map((s) => (s || "").trim()).filter(Boolean);
    const SKIP = /^(照片|相片|分水闸|分水渠|photo|photos|img|image|images|picture|pictures)$/i;
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = FOLDER_ALIAS[segs[i]] || segs[i];
      if (SKIP.test(seg) || seg.length < 2) continue;
      const c = smartCandidates(seg, { recs: base });
      if (c.length) return c;
    }
    return [];
  }
  // 照片内容哈希：原生已算（ph.hash），否则回退到 JS 计算（Web/旧数据）
  async function photoHash(ph) {
    if (ph.hash) return ph.hash;
    if (ph.b64) return await shaHexOfB64(ph.b64);
    return "";
  }
  async function finishBatchPhotos() {
    BATCH_STATE.active = false;
    busy("正在匹配照片，请稍后…"); // 加载/处理阶段先显「请稍后」，避免误以为卡死（item 2）
    const photos = pendingBatch.photos; pendingBatch.photos = [];
    // v2.4 三级匹配第一级：zip 文件名 → 机构范围（史山.zip → 史山所）；后续文件夹/照片匹配都在该范围内收窄
    const zipScope = BATCH_ZIP_NAME ? matchOrgScope(BATCH_ZIP_NAME) : null;
    BATCH_ZIP_NAME = ""; // 一次性消费，防跨批次污染
    if (zipScope) toast(`压缩包名命中「${zipScope.label}」，优先在该范围内匹配`);
    const hashCache = {};
    const existingHashes = async (id) => {
      if (hashCache[id]) return hashCache[id];
      const r = records.find((x) => x.id === id);
      const set = new Set();
      for (const ph of (r ? r.photos || [] : [])) {
        const h = ph.hash || (ph.dataUrl && ph.dataUrl.startsWith("data:") && ph.dataUrl.includes(";base64,") ? await shaHexOfB64(ph.dataUrl.split(",")[1]) : null);
        if (h) set.add(h);
      }
      hashCache[id] = set; return set;
    };
    const auto = {}, ambiguous = [], dupes = [];
    // v2.4.3 顺序兜底：zip 名/文件夹已收窄到某范围（如 史山所），但照片名无语义信号（IMG-6857.jpg）时，
    // 若「该文件夹内照片数 == 范围内建筑物数」，按出现顺序一一映射（标记 byOrder，导入确认页可人工改）
    // 例：史山.zip 内 IMG-6857.jpg 等 → 依次对应 史山所 的 49 个建筑物
    const orderMap = {};
    {
      const groups = {};
      for (const ph of photos) { const k = ph.folder || ""; (groups[k] = groups[k] || []).push(ph); }
      for (const k of Object.keys(groups)) {
        const sc = folderScope(k, zipScope && zipScope.recs, zipScope);
        if (!sc) continue;
        const rs = sc.recs;
        if (!rs.length || rs.length !== groups[k].length) continue;   // 仅数量精确相等才启用，避免错配
        groups[k].forEach((ph, idx) => { orderMap[ph.fullPath || (k ? k + "/" : "") + ph.name] = { rec: rs[idx], scopeLabel: sc.label }; });
      }
    }
    // 分块匹配（每批 30 张 + 让出主线程），避免大批量导入时 UI 卡死（item 2）
    const CHUNK = 30;
    for (let i = 0; i < photos.length; i += CHUNK) {
      const slice = photos.slice(i, i + CHUNK);
      for (const ph of slice) {
        const scope = folderScope(ph.folder, zipScope && zipScope.recs, zipScope);
        let cands = smartCandidates(ph.name, scope);
        // #4 增强：照片名无语义信号（IMG_xxxx）时，用「文件夹名（最深层具体段）」作为建筑物名在机构范围内模糊匹配
        if (!cands.length) {
          const fc = buildingCandidatesFromFolder(ph.folder, scope ? scope.recs : (zipScope ? zipScope.recs : null));
          if (fc.length) cands = fc;
        }
        // 全局兜底：当前范围（如文件夹上下文）无候选时，跨全部建筑物再算一次，避免“名字不完全匹配”直接丢失
        if (!cands.length && !scope) cands = smartCandidates(ph.name, null).slice(0, 8);
        const h = await photoHash(ph);
        const search = cands.length ? cands.map((c) => c.x) : (scope ? scope.recs : records);
        let dupeId = null;
        for (const c of search) { if ((await existingHashes(c.id)).has(h)) { dupeId = c.id; break; } }
        if (dupeId) { dupes.push({ ph, id: dupeId, h }); continue; }
        // 确定性匹配（bug②修复）：导出包自带 manifest（filename -> 建筑物 id），直接自动绑定，跳过模糊匹配与人工选择
        if (ph.mid) {
          const rec = records.find((x) => x.id === ph.mid);
          if (rec) { (auto[rec.id] = auto[rec.id] || []).push(ph); continue; }
        }
        // 关键修复：无论是否有名称匹配，都进入人工选择流程（不静默丢弃）；无候选时给“全部建筑物”作为候选
        if (!cands.length) {
          // v2.4.3 顺序兜底命中：直接按序绑定，但保留在 ambiguous 供人工确认（不静默写入）
          const om = orderMap[ph.fullPath || (ph.folder ? ph.folder + "/" : "") + ph.name];
          if (om) {
            ambiguous.push({ ph, cs: [{ id: om.rec.id, name: om.rec.name, score: 50, byOrder: true }], scopeLabel: om.scopeLabel + "（按序推断，请核对）", byOrder: true });
            continue;
          }
          ambiguous.push({ ph, cs: (scope ? scope.recs : records).map((c) => ({ id: c.id, name: c.name })), scopeLabel: scope ? scope.label : "全部建筑物", byContent: true });
          continue;
        }
        if (cands.length === 1 || cands[0].score >= 85) (auto[cands[0].x.id] = auto[cands[0].x.id] || []).push(ph); // 强匹配直接保存
        else ambiguous.push({ ph, cs: cands.map((c) => ({ id: c.x.id, name: c.x.name, score: c.score })) });
      }
      if (i + CHUNK < photos.length) await new Promise((r) => setTimeout(r, 0));
    }
    // 内容去重提示（含图片对比）
    if (dupes.length) {
      await new Promise((resolve) => {
        const html = `<div class="hint">以下 ${dupes.length} 张照片<b>内容与已有照片完全相同</b>（不是文件名相同），已展示新图与已有图供对比，请选择处理方式：</div>` +
          dupes.map((d) => {
            const r = records.find((x) => x.id === d.id) || {};
            const phs = (r.photos || []).filter((p) => p.dataUrl && p.dataUrl.startsWith("data:")).slice(0, 3);
            const newThumb = d.ph.thumb || (d.ph.b64 ? b64ToDataUrl(d.ph.name, d.ph.b64) : "");
            return `<div class="dp-row"><div class="dp-col"><img src="${newThumb}"><div class="dp-lbl">新导入：${esc(d.ph.name)}</div></div>` +
              `<div class="dp-col"><img src="${phs[0] || ""}"><div class="dp-lbl">已有：${esc(r.name || "")}</div></div></div>`;
          }).join("");
        openModal("照片内容重复", html, `<button class="btn ghost" id="dpSkip">跳过（不导入）</button><button class="btn primary" id="dpOver">覆盖已有</button>`);
        el("dpSkip").onclick = () => { closeModal(); resolve(); };
        el("dpOver").onclick = async () => {
          closeModal();
          const cache = {};
          for (const du of dupes) {
            if (cache[du.id]) continue;
            const r = records.find((x) => x.id === du.id); const arr = [];
            if (r) for (let i = 0; i < (r.photos || []).length; i++) {
              const p = r.photos[i];
              if (p.dataUrl && p.dataUrl.startsWith("data:") && p.dataUrl.includes(";base64,"))
                arr.push({ idx: i, hash: await shaHexOfB64(p.dataUrl.split(",")[1]) });
            }
            cache[du.id] = arr;
          }
          await Store.patch((d) => {
            d.added = d.added || []; d.updated = d.updated || {};
            for (const du of dupes) {
              const arr = cache[du.id] || []; const hit = arr.find((a) => a.hash === du.h); if (!hit) continue;
              const baseRec = records.find((x) => x.id === du.id) || {};
              const exist = d.added.find((a) => a.id === du.id); const upd = d.updated[du.id];
              const cur = (exist || upd || baseRec).photos || [];
              if (cur[hit.idx]) cur[hit.idx].caption = du.ph.name;
            }
          });
          DELTA = await Store.get(); merge(); render();
          resolve();
        };
      });
    }
    // 直接匹配先保存
    await applyPhotoMatch(auto);
    hideBusy(); // 收起「请稍后」遮罩，再弹出人工选择/完成提示
    const autoTotal = Object.values(auto).reduce((a, b) => a + b.length, 0);
    const cleanInboxNow = () => { if (window.AndroidBridge && window.AndroidBridge.cleanInbox) window.AndroidBridge.cleanInbox(); };
    if (ambiguous.length) {
      openPhotoChoice(ambiguous, async (userMap, skipped) => {
        await applyPhotoMatch(userMap);
        const userTotal = Object.values(userMap).reduce((a, b) => a + b.length, 0);
        finalizePhotoImport(Object.keys(auto).length, autoTotal + userTotal, ambiguous.length, skipped, dupes.length);
        cleanInboxNow(); // 导入完成：清理 inbox/uz_* 临时目录（item 2 根因防护之三）
      });
    } else {
      finalizePhotoImport(Object.keys(auto).length, autoTotal, 0, [], dupes.length);
      cleanInboxNow();
    }
  }
  // 将 {建筑物id:[photo...]} 合并进 Store 增量；caption 统一改为「建筑物名+照片+序号」，确保建筑物稳定读到
  async function applyPhotoMatch(map) {
    if (!Object.keys(map).length) return;
    await Store.patch((d) => {
      d.added = d.added || []; d.updated = d.updated || {};
      for (const id in map) {
        const phs = map[id];
        const rec = records.find((x) => x.id === id) || {};
        const recName = rec.name || "建筑物";
        const exist = d.added.find((a) => a.id === id);
        const upd = d.updated[id];
        const cur = (exist || upd || rec).photos || [];
        let seq = cur.length; // 顺序号从现有张数之后续编
        const newPhotos = phs.map((ph) => {
          seq += 1;
          // 全图从 inbox 临时目录持久化到 app 私有 photos 目录（cleanInbox 不会误删）；dataUrl 仅存缩略图，全图按需单张加载
          let fullPath = "";
          if (ph.fullPath && window.AndroidBridge && window.AndroidBridge.persistImage) {
            const p = window.AndroidBridge.persistImage(ph.fullPath);
            if (p) fullPath = p;
          }
          const dataUrl = ph.thumb || (ph.b64 ? b64ToDataUrl(ph.name, ph.b64) : "");
          // 关键修复（最佳匹配保存）：Web 导入通道经 receivePhoto 传入的是 full 原图 b64，必须据此补 full，
          // 否则仅存缩略图、放大/导出时缺原图，表现为"照片没保存/看不清"
          const full = ph.full || (ph.b64 ? "data:image/jpeg;base64," + ph.b64 : "") || fullPath || "";
          return { caption: `${recName}照片${seq}`, dataUrl, fullPath, full, hash: ph.hash || "" };
        });
        const merged = cur.concat(newPhotos);
        if (exist) { const i = d.added.findIndex((a) => a.id === id); d.added[i] = Object.assign({}, d.added[i], { photos: merged }); }
        else d.updated[id] = Object.assign({}, rec, upd || {}, { photos: merged });
      }
    });
    DELTA = await Store.get(); merge(); render();
  }
  // 多建筑物/无匹配时让用户<b>单选</b>所属建筑物（每张照片只能属于一个建筑物；默认勾选最可能对，可改或跳过）
  function openPhotoChoice(list, onConfirm) {
    const groups = list.map((it, idx) => {
      const scopeNote = it.scopeLabel
        ? `<div class="pc-scope">📁 上下文：${esc(it.scopeLabel)}${it.byContent ? "（未匹配到名称，请按照片内容选择对应建筑物；不确定可点「跳过」）" : ""}</div>`
        : "";
      const thumb = it.ph.thumb || (it.ph.b64 ? b64ToDataUrl(it.ph.name, it.ph.b64) : "");
      const def = it.cs[0] ? it.cs[0].id : ""; // 默认最可能
      const opts = it.cs.map((c) => {
        const rec = records.find((x) => x.id === c.id) || {};
        const t = (rec.photos || []).find((p) => p.dataUrl && p.dataUrl.startsWith("data:")) || {};
        const checked = c.id === def ? "checked" : "";
        return `<label class="ex-item"><input type="radio" name="pc-${idx}" class="pc-rb" data-pi="${idx}" value="${c.id}" ${checked}><img class="pc-th" src="${t.thumb || t.dataUrl || ""}"><span>${esc(c.name)}${c.score != null ? ` <em class="sc">匹配度 ${c.score}</em>` : ""}</span></label>`;
      }).join("");
      const skipChk = def ? "" : "checked"; // 无任何候选时默认跳过
      return `<div class="phchoice">
        <div class="pc-title">📷 ${esc(it.ph.name)} <small>请选择所属建筑物（单选）</small></div>
        <div class="pc-thumb"><img src="${thumb}" alt="导入照片"></div>
        ${scopeNote}
        <div class="pc-cands">${opts}
          <label class="ex-item skip"><input type="radio" name="pc-${idx}" class="pc-rb" data-pi="${idx}" value="__skip__" ${skipChk}><span>⏭ 跳过这张（不导入）</span></label>
        </div>
      </div>`;
    }).join("");
    openModal("选择照片所属建筑物", `<div class="hint">每张照片只能属于一个建筑物；系统已默认勾选最可能项，请逐张确认或修改。点「确认导入」即按所选绑定；未选「跳过」的照片将被导入到所选建筑物。</div><div class="filelist" style="max-height:46vh;overflow:auto">${groups}</div>`,
      `<button class="btn ghost" id="pcAllDef">全部按默认</button><button class="btn ghost" id="pcCancel">取消</button><button class="btn primary" id="pcOk">确认导入</button><button class="btn ghost" id="pcExit">退出</button>`);
    const collect = () => {
      const map = {}; const skipped = [];
      list.forEach((it, idx) => {
        const sel = document.querySelector(`input[name="pc-${idx}"]:checked`);
        if (!sel || sel.value === "__skip__") { skipped.push(it.ph.name); return; }
        (map[sel.value] = map[sel.value] || []).push(it.ph);
      });
      return { map, skipped };
    };
    const done = (map, skipped) => { closeModal(); onConfirm(map, skipped); };
    el("pcAllDef").onclick = () => { const { map, skipped } = collect(); done(map, skipped); };
    el("pcCancel").onclick = () => done({}, list.map((it) => it.ph.name));
    el("pcExit").onclick = () => done({}, list.map((it) => it.ph.name));
    el("pcOk").onclick = () => { const { map, skipped } = collect(); done(map, skipped); };
  }
  function finalizePhotoImport(autoCnt, total, ambiguousCnt, skipped, dupCnt) {
    let msg = `照片导入完成：自动匹配 ${autoCnt} 个建筑物`;
    if (ambiguousCnt) msg += `（另有 ${ambiguousCnt} 张已逐张确认所属）`;
    msg += `，共新增 ${total} 张`;
    if (dupCnt) msg += `；内容重复跳过/覆盖 ${dupCnt} 张`;
    if (skipped && skipped.length) msg += `；已跳过 ${skipped.length} 张（未选建筑物）`;
    toast(msg);
    if (skipped && skipped.length) {
      openModal("部分照片已跳过", `<div class="hint">以下 ${skipped.length} 张照片未选择所属建筑物，已跳过未导入：</div><div class="filelist">${skipped.slice(0, 80).map((n) => `<div class="fi">${esc(n)}</div>`).join("")}</div>`, `<button class="btn ghost" onclick="APP.close()">知道了</button>`);
    }
  }
  async function finishBatchSheets() {
    BATCH_STATE.active = false;
    const sheets = pendingBatch.sheets; pendingBatch.sheets = [];
    if (!sheets.length) { toast("未读取到可导入的表格文件"); return; }
    const recs = []; const errors = [];
    for (const s of sheets) {
      try {
        const ext = (s.ext || "").toLowerCase();
        let rs = [];
        if (ext === "csv" || ext === "tsv" || ext === "txt") rs = IO.parseCsvToRecords(s.text);
        else if (ext === "kml") rs = IO.parseKmlToRecords(s.text);
        else if (ext === "gpx") rs = IO.parseGpxToRecords(s.text);
        else if (ext === "json") rs = IO.parseJsonToRecords(s.text);
        // bug③修复：xlsx 走二进制解析器（原先误用 CSV 解析器 + 空文本 -> 静默 0 条）
        else if (ext === "xlsx") {
          if (!s.bytes || !s.bytes.length) throw new Error("xlsx 需以二进制读取，但当前导入通道未提供字节流");
          rs = await IO.parseXlsxToRecords(s.bytes);
        }
        else if (ext === "xls") rs = IO.parseXlsToRecords(s.text || "");
        else throw new Error("不支持的表格扩展名：" + (ext || "(空)"));
        recs.push(...rs);
      } catch (e) { errors.push(s.name + "：" + e.message); }
    }
    if (!recs.length) { toast("未解析到任何建筑物" + (errors.length ? "；错误：" + errors.join("；") : "")); return; }
    // 管理所名称统一（去「管理」+ 潮河特例）
    recs = recs.map((r) => Object.assign({}, r, { office: normOffice(r.office) }));
    // 同名建筑物冲突提示（第三）：导入建筑物信息时，名称完全相同的要提示 覆盖/跳过/取消；同一文件导入两次（id 相同）也会落入 exist 分支触发覆盖提示
    const nameSet = new Set(records.map((x) => x.name).filter(Boolean));
    const collisions = recs.filter((r) => r.name && nameSet.has(r.name));
    let nameAct = "keep";
    if (collisions.length) {
      const list = collisions.slice(0, 12).map((r) => `<li>${esc(r.name)}</li>`).join("");
      nameAct = await new Promise((resolve) => {
        openModal("存在同名建筑物",
          `<div class="hint">本次导入的以下 <b>${collisions.length}</b> 个建筑物与现有记录<b>名称完全相同</b>：</div><ul class="filelist" style="max-height:28vh;overflow:auto">${list}</ul>${collisions.length > 12 ? `<div class="hint">…等共 ${collisions.length} 个</div>` : ""}<div class="hint" style="margin-top:6px">「覆盖同名」用导入的数据替换同名旧记录；「跳过同名」只导入名称不冲突的；「取消」中止本次导入。</div>`,
          `<button class="btn ghost" id="nmCancel">取消</button><button class="btn ghost" id="nmSkip">跳过同名</button><button class="btn primary" id="nmOver">覆盖同名</button>`);
        el("nmCancel").onclick = () => { closeModal(); resolve("cancel"); };
        el("nmSkip").onclick = () => { closeModal(); resolve("skip"); };
        el("nmOver").onclick = () => { closeModal(); resolve("over"); };
      });
      if (nameAct === "cancel") { DELTA = await Store.get(); merge(); render(); return toast("已取消导入（存在同名建筑物）"); }
      // 覆盖同名：把导入记录 id 对齐到现有同名记录 id，后续按 id 覆盖
      if (nameAct === "over") {
        const nameToId = {}; records.forEach((x) => { if (x.name) nameToId[x.name] = x.id; });
        recs.forEach((r) => { if (nameToId[r.name]) r.id = nameToId[r.name]; });
      }
    }
    await Store.patch((d) => {
      d.added = d.added || []; d.updated = d.updated || {};
      for (const r of recs) {
        if (nameAct === "skip" && nameSet.has(r.name)) continue; // 跳过同名
        const exist = BASE.find((b) => b.id === r.id) || d.added.find((a) => a.id === r.id);
        if (exist) { d.updated[r.id] = r; d.added = d.added.filter((a) => a.id !== r.id); }
        else d.added.push(r);
      }
    });
    DELTA = await Store.get(); merge(); render();
    toast(`表格导入完成：${recs.length} 个建筑物` + (errors.length ? `；${errors.length} 个文件解析失败` : ""));
  }
  async function startBatchImport(kind, mode) {
    await importCpResumePrompt(kind); // 若上次导入被中断，提示用户（item 1/2 续传）
    // 大文件流量提醒（items 1/2：文件夹/zip 可能含大量照片 >3GB）
    if (mode === "folder" || mode === "zip") {
      const go = await confirmLargeTransfer("批量导入（可能含大量文件）");
      if (!go) { importCpEnd(); return; }
    }
    pendingBatch[kind === "photos" ? "photos" : "sheets"] = [];
    BATCH_ZIP_NAME = ""; // v2.4：每批开始重置压缩包名（zip 通道随后会重新设置）
    BATCH_STATE.active = true; BATCH_STATE.kind = kind;
    importCpStart(kind);
    closeModal();
    if (mode === "folder" && window.AndroidBridge && window.AndroidBridge.pickImportFolder) window.AndroidBridge.pickImportFolder(kind);
    else if (mode === "zip" && window.AndroidBridge && window.AndroidBridge.pickImportZip) window.AndroidBridge.pickImportZip(kind);
    else if (mode === "zip") { if (kind === "photos") webkitZipPhotos(); else webkitZipSheets(); }
    else if (kind === "photos") { if (mode === "files") webkitMultiPhotos(); else webkitDirPhotos(); }
    else { if (mode === "files") webkitMultiSheets(); else webkitDirSheets(); }
    toast(mode === "folder" ? "请在系统选择器中选取文件夹" : (mode === "zip" ? "请在系统选择器中选取 zip 压缩包" : "请在系统选择器中选取文件"));
  }
  function webkitDirPhotos() {
    pickFiles({ webkitdirectory: true, multiple: true, onPick: (files) => {
      const fs = files.filter((f) => /\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name));
      if (!fs.length) { BATCH_STATE.active = false; return toast("未选择照片文件"); }
      let n = 0;
      fs.forEach((file) => {
        const r = new FileReader();
        const rel = file.webkitRelativePath || file.name;
        const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        r.onload = () => { (async () => {
          let extra = {};
          try { const cp = await ImgUtil.compressPhoto(new Uint8Array(r.result)); extra = { thumb: cp.thumb, full: cp.full, hash: cp.hash }; } catch (e) {}
          receivePhoto(file.name, extra.full || (r.result.split(",")[1]) || "", folder, undefined, extra);
          if (++n === fs.length) receiveDone("photos");
        })(); };
        r.readAsArrayBuffer(file);
      });
    }});
  }
  function webkitMultiPhotos() {
    pickFiles({ multiple: true, accept: "image/*", onPick: (files) => {
      if (!files.length) { BATCH_STATE.active = false; return; }
      let n = 0;
      files.forEach((file) => {
        const r = new FileReader();
        r.onload = () => { (async () => {
          let extra = {};
          try { const cp = await ImgUtil.compressPhoto(new Uint8Array(r.result)); extra = { thumb: cp.thumb, full: cp.full, hash: cp.hash }; } catch (e) {}
          receivePhoto(file.name, extra.full || (r.result.split(",")[1]) || "", undefined, undefined, extra);
          if (++n === files.length) receiveDone("photos");
        })(); };
        r.readAsArrayBuffer(file);
      });
    }});
  }
  async function webkitZipPhotos() {
    // .7z 无标准 MIME 映射，Android 选择器可能隐藏；*/* 兜底保证可选，zip/7z 由解压端识别
    pickFiles({ accept: ".zip,.7z,application/zip,application/x-7z-compressed,application/x-zip-compressed,*/*", onPick: async (files) => {
      try {
        const f = files[0]; if (!f) return;
        BATCH_ZIP_NAME = String(f.name || "").replace(/\.(zip|7z)$/i, ""); // v2.4 三级匹配：记录压缩包名（→ 机构范围）
        // 7z 浏览器原生无法解压：明确报错降级，不静默
        if (/\.7z$/i.test(f.name)) { BATCH_STATE.active = false; return toast("7z 暂不支持浏览器原生解压，请改用 zip 压缩包（照片匹配逻辑不变）"); }
        // ① 体积预检：超 1.2GB 直接拦截并引导分卷（item 1 根因防护）
        if (zipSizeRefuse(f)) return;
        // ② 较大包二次确认（300MB~1.2GB），告知将流式处理
        if (f.size > 300 * 1048576) {
          const go = await new Promise((res) => {
            openModal("大压缩包导入确认",
              `<div class="hint" style="color:#e67e22">⚠️ 压缩包约 <b>${Math.round(f.size / 1048576)} MB</b>，较大。将流式处理并显示进度，但低端设备仍可能较慢；建议 ≤500MB 分卷更稳。</div>`,
              `<button class="btn ghost" id="zCancel">取消</button><button class="btn primary" id="zGo">仍要继续（流式）</button>`);
            el("zCancel").onclick = () => { closeModal(); res(false); };
            el("zGo").onclick = () => { closeModal(); res(true); };
          });
          if (!go) { BATCH_STATE.active = false; return; }
        }
        // ③ 进度弹窗 + 流式解压：逐张读取、立即转码入队、释放字节、让出主线程，避免卡死/死机
        openModal("正在导入照片",
          `<div class="hint" id="zipProg">正在读取压缩包…</div><div class="bar"><div class="bar-fill" id="zipBar" style="width:0%"></div></div>`,
          `<button class="btn ghost" id="zipCancel">取消</button>`);
        const prog = el("zipProg"), bar = el("zipBar");
        let cancelled = false;
        el("zipCancel").onclick = () => { cancelled = true; closeModal(); BATCH_STATE.active = false; toast("已取消导入"); };
        const buf = await f.arrayBuffer();
        if (cancelled) return;
        // bug②修复：先扫一遍 manifest.json（若存在）—— 导出包自带 filename -> 建筑物 id 映射，导入时确定性自动匹配
        const mMap = {};
        await IO.unzipStream(buf, async (name, bytes) => {
          if (/^manifest\.json$/i.test(name)) {
            try { const obj = JSON.parse(new TextDecoder().decode(bytes)); (obj.items || []).forEach((it) => { if (it && it.file) mMap[it.file] = it; }); } catch (e) {}
          }
        });
        const total = IO.unzipCount(buf);
        let done = 0;
        await IO.unzipStream(buf, async (name, bytes) => {
          if (cancelled) return;
          if (!/\.(jpe?g|png|gif|bmp|webp)$/i.test(name)) return;
          const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
          const m = mMap[name];
          try {
            const cp = await ImgUtil.compressPhoto(bytes);
            receivePhoto(name, cp.full, folder, m ? m.id : undefined, { thumb: cp.thumb, full: cp.full, hash: cp.hash });
          } catch (e) {
            receivePhoto(name, IO.bytesToB64(bytes), folder, m ? m.id : undefined); // 压缩失败兜底：原图
          } // bytes 为当前条目视图，立即转码后本函数返回即被释放
          done++;
          if ((done & 15) === 0 || done === total) {
            prog.textContent = `已处理 ${done} / ${total} 张照片…`;
            bar.style.width = Math.min(100, Math.round(done / Math.max(1, total) * 100)) + "%";
            await new Promise((r) => setTimeout(r, 0)); // 让出主线程，保持 UI 响应（防 ANR 杀进程）
          }
        });
        if (cancelled) return;
        closeModal();
        if (pendingBatch.photos.length) receiveDone("photos");
        else { BATCH_STATE.active = false; importCpEnd(); toast("压缩包中未找到照片"); }
      } catch (e) { BATCH_STATE.active = false; importCpEnd(); closeModal(); toast("压缩包读取失败：" + e.message); }
    }});
  }
  // bug③修复：统一表格读取器 —— xlsx 用 readAsArrayBuffer 走字节流，其余按文本；
  // 读取失败也要推进计数并提示，避免 n 永远到不了 files.length 导致导入状态卡死（静默挂死）。
  function readSheetFile(f, done) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const r = new FileReader();
    r.onerror = () => { toast("读取失败：" + f.name); done(); };
    if (ext === "xlsx") {
      r.onload = () => { receiveSheet(f.name, "", ext, new Uint8Array(r.result)); done(); };
      r.readAsArrayBuffer(f);
    } else {
      r.onload = () => { receiveSheet(f.name, r.result, ext); done(); };
      r.readAsText(f);
    }
  }
  function webkitDirSheets() {
    pickFiles({ webkitdirectory: true, multiple: true, onPick: (files) => {
      const fs = files.filter((f) => /\.(csv|tsv|txt|kml|gpx|json|xls|xlsx)$/i.test(f.name));
      if (!fs.length) { BATCH_STATE.active = false; return toast("未选择表格文件"); }
      let n = 0;
      const bump = () => { if (++n === fs.length) receiveDone("sheets"); };
      fs.forEach((file) => readSheetFile(file, bump));
    }});
  }
  function webkitMultiSheets() {
    pickFiles({ multiple: true, onPick: (files) => {
      const fs = files.filter((f) => /\.(csv|tsv|txt|kml|gpx|json|xls|xlsx)$/i.test(f.name));
      if (!fs.length) { BATCH_STATE.active = false; return; }
      let n = 0;
      const bump = () => { if (++n === fs.length) receiveDone("sheets"); };
      fs.forEach((file) => readSheetFile(file, bump));
    }});
  }
  async function webkitZipSheets() {
    pickFiles({ accept: ".zip,.7z,application/zip,application/x-7z-compressed,application/x-zip-compressed,*/*", onPick: async (files) => {
      try {
        const f = files[0]; if (!f) return;
        if (/\.7z$/i.test(f.name)) { BATCH_STATE.active = false; return toast("7z 暂不支持浏览器原生解压，请改用 zip 压缩包"); }
        if (zipSizeRefuse(f)) return; // 超大压缩包预检（与照片一致）
        const buf = await f.arrayBuffer();
        const files = await IO.unzip(new Uint8Array(buf));
        let cnt = 0;
        for (const name of Object.keys(files)) {
          if (!/\.(csv|tsv|txt|kml|gpx|json|xls|xlsx)$/i.test(name)) continue;
          const ext = (name.split(".").pop() || "").toLowerCase();
          // bug③修复：xlsx 传字节流（原先固定传空串 -> 解析 0 条且无任何报错）
          if (ext === "xlsx") receiveSheet(name, "", ext, files[name]);
          else receiveSheet(name, new TextDecoder().decode(files[name]), ext);
          cnt++;
        }
        if (cnt) receiveDone("sheets"); else { BATCH_STATE.active = false; toast("压缩包中未找到表格"); }
      } catch (e) { BATCH_STATE.active = false; toast("压缩包读取失败：" + e.message); }
    }});
  }
  function batchImportMenu(kind) {
    const isPhoto = kind === "photos";
    const html = `<div class="hint">${isPhoto ? "从手机文件夹或压缩包(zip)批量导入照片，导入后自动按「照片文件名→建筑物名称」智能匹配并保存。" : "从手机文件夹或压缩包批量导入建筑物信息（支持 csv/tsv/txt/kml/gpx/json/xls/xlsx），导入后按经纬度定位，无经纬度则按名称定位。"}</div>
      <div class="field" style="margin-top:12px"><label>选择来源（本地）</label>
        <div class="src-grid">
          <div class="src-card" id="biFolder"><div class="sc-ico">📁</div><div class="sc-lbl">手机文件夹</div><div class="sc-sub">照片/表格</div></div>
          <div class="src-card" id="biZip"><div class="sc-ico">🗜️</div><div class="sc-lbl">压缩包</div><div class="sc-sub">zip（推荐）</div></div>
          <div class="src-card" id="biFiles"><div class="sc-ico">📄</div><div class="sc-lbl">多个文件</div><div class="sc-sub">浏览器</div></div>
        </div>
      </div>
      <div class="field" style="margin-top:6px"><label>选择来源（网盘）</label>
        <div class="src-grid two">
          <div class="src-card net" id="biBaidu"><div class="sc-ico">☁️</div><div class="sc-lbl">百度网盘</div></div>
          <div class="src-card net" id="biQuark"><div class="sc-ico">☁️</div><div class="sc-lbl">夸克网盘</div></div>
        </div>
      </div>
      <div class="hint">网盘导入需在 Android APP 内已配置网盘凭证；网页版未集成时，请先通过网盘 App 把文件导出到本地，再选「手机文件夹」导入。压缩包仅支持 zip（7z 浏览器无法原生解压，会自动提示改用 zip）。</div>`;
    openModal(isPhoto ? "批量导入照片" : "批量导入建筑物", html, `<button class="btn ghost" onclick="APP.close()">取消</button>`);
    el("biFolder").onclick = () => startBatchImport(kind, "folder");
    el("biZip").onclick = () => startBatchImport(kind, "zip");
    el("biFiles").onclick = () => startBatchImport(kind, "files");
    el("biBaidu").onclick = () => importFromNetdisk("baidu", kind);
    el("biQuark").onclick = () => importFromNetdisk("quark", kind);
  }
  // 网盘导入（与"网盘导入导出"共用桥接；网页版无桥接时明确降级，不静默失败）
  function importFromNetdisk(prov, kind) {
    if (window.AndroidBridge && window.AndroidBridge.netdiskImport) {
      window.AndroidBridge.netdiskImport(prov, kind || "photos");
      closeModal();
      toast(`已请求从${prov === "baidu" ? "百度" : "夸克"}网盘导入，请在网盘选择器中选择文件`);
    } else {
      toast("当前网页版未集成网盘授权：① 在 Android APP 内使用本功能；或 ② 用网盘 App 把文件导出到本地后选「本地文件夹」导入");
    }
  }
  function exportPhotosMenu() {
    const hasFilter = filter.office.length || filter.btype.length || filter.q;
    const recsAll = records, recsFiltered = records.filter(passFilter);
    const html = `<div class="field"><label>导出范围</label>
        <select id="phScope"><option value="all">全部建筑物（${recsAll.length}）</option>${hasFilter ? `<option value="filtered" selected>当前筛选（${recsFiltered.length}）</option>` : ""}</select></div>
      ${DIMS.offices.length ? `<div class="field"><label>按管理所（默认全选 · 含全部管理所）</label><div class="ofc-list" id="phOffices" style="max-height:150px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px 14px">${DIMS.offices.map((o) => `<label class="ofc"><input type="checkbox" class="ofc-cb" value="${esc(o)}" checked>${esc(o)}</label>`).join("")}</div></div>` : ""}
      <div class="field"><label>压缩格式</label>
        <select id="phFmt"><option value="zip">zip（推荐，通用）</option><option value="7z">7z（当前环境降级为 zip）</option></select></div>
      <div class="field"><label>导出目标</label>
        <select id="phTarget">
          <option value="download">本地下载（zip 文件）</option>
          <option value="folder">本地文件夹（Android 真机）</option>
          <option value="baidu">百度网盘</option>
          <option value="quark">夸克网盘</option>
          <option value="share">分享给微信 / 飞书 / QQ</option>
        </select></div>
      <div class="field"><label>压缩包文件名组合段（点选自动生成；默认 所，生成后仍可手改）</label>
        <div class="chips" id="phSegs">
          <span class="chip" data-seg="bureau">局</span>
          <span class="chip" data-seg="mgmt">管理处</span>
          <span class="chip on" data-seg="office">所</span>
          <span class="chip" data-seg="station">站</span>
          <span class="chip" data-seg="section">段</span>
          <span class="chip" data-seg="name">建筑物名</span>
        </div></div>
      <div class="field"><label>压缩包内文件夹层次（按选中层级逐级建目录；默认 所）</label>
        <div class="chips" id="phFold">
          <span class="chip" data-seg="bureau">局</span>
          <span class="chip" data-seg="mgmt">管理处</span>
          <span class="chip on" data-seg="office">所</span>
          <span class="chip" data-seg="station">站</span>
          <span class="chip" data-seg="section">段</span>
        </div></div>
      <div class="field"><label>压缩包文件名（不含扩展名，系统自动加 .zip；留空则按组合段/管理所命名）</label><input id="phFname" class="inp" value="建筑物照片"></div>
      <div class="hint">照片按「管理所 / 建筑物_序号.扩展名」分文件夹命名；压缩包内含 manifest.json，可<b>确定性重新导入</b>（自动绑定到原建筑物，无需逐张人工选择）。压缩包以管理所命名（多管理所时取首个 + 等 N 所）。</div>`;
    openModal("导出照片", html, `<button class="btn ghost" id="phCancel">取消</button><button class="btn primary" id="phGo">导出</button>`);
    el("phCancel").onclick = closeModal;
    // 组合段（v2.4）：文件名 + 文件夹层次
    const segValOf = (r, seg) => seg === "bureau" ? orgVal(r, "bureau") : seg === "mgmt" ? orgVal(r, "mgmt")
      : seg === "office" ? (normOffice(orgVal(r, "office")) || "未分类所") : seg === "station" ? (r.station || "")
      : seg === "section" ? (r.section || "") : (r.name || "");
    const bindSegChips = (boxId, inputId, suffix) => {
      const box = el(boxId); if (!box) return;
      box.querySelectorAll(".chip").forEach((c) => c.onclick = () => {
        c.classList.toggle("on");
        const segs = [...box.querySelectorAll(".chip.on")].map((x) => x.dataset.seg);
        if (!segs.length || !inputId) return;
        const src0 = (el("phScope") && el("phScope").value === "filtered") ? recsFiltered : recsAll;
        const safeSeg = (v) => (v || "").replace(/[\\/:*?"<>|\n\r]+/g, "_").trim();
        const parts = segs.map((sg) => sg === "name" ? (src0.length === 1 ? safeSeg(src0[0].name) : src0.length + "个建筑物") : safeSeg(segValOf(src0[0], sg))).filter(Boolean);
        if (parts.length) el(inputId).value = parts.join("_") + suffix;
      });
    };
    bindSegChips("phSegs", "phFname", "");
    bindSegChips("phFold", null, null);
    el("phGo").onclick = () => {
      const sourceRecs = el("phScope").value === "filtered" ? recsFiltered : recsAll;
      const officesAll = el("phOffices") ? [...document.querySelectorAll("#phOffices .ofc-cb")].map((c) => c.value) : [];
      const officesChecked = el("phOffices") ? [...document.querySelectorAll("#phOffices .ofc-cb:checked")].map((c) => c.value) : null;
      // v2.4.2 智能同步：若用户未手动收紧（仍为全选），按当前所选建筑物子集自动收窄到涉及的管理所
      let offices = officesChecked;
      if (offices && offices.length === officesAll.length && officesAll.length > 1) {
        const used = [...new Set(sourceRecs.map((r) => normOffice(orgVal(r, "office"))).filter(Boolean))];
        if (used.length && used.length < officesAll.length) { offices = used; toast("已按所选建筑物自动匹配到 " + used.length + " 个管理所"); }
      }
      const fv = (el("phFname").value || "").trim();
      const fsegs = el("phSegs") ? [...el("phSegs").querySelectorAll(".chip.on")].map((c) => c.dataset.seg) : null;
      const dsegs = el("phFold") ? [...el("phFold").querySelectorAll(".chip.on")].map((c) => c.dataset.seg) : null;
      doExportPhotos(sourceRecs, { format: el("phFmt").value, target: el("phTarget").value, offices, fname: fv, fnameSegs: fsegs, folderSegs: dsegs });
    };
  }
  async function doExportPhotos(recs, opts) {
    opts = opts || {};
    if (opts.offices && opts.offices.length) recs = recs.filter((r) => opts.offices.includes(normOffice(r.office)));
    busy("正在准备导出照片，请稍后…"); // item 3：导出前先显「请稍后」
    const files = [];
    const manifestItems = []; // bug②修复：记录 filename -> 建筑物 id 映射，供确定性重新导入
    const safe = (s) => (s || "建筑物").replace(/[\\/:*?"<>|\n\r]+/g, "_").slice(0, 40);
    const officeSafe = (s) => (normOffice(s) || "未分类所").replace(/[\\/:*?"<>|\n\r]+/g, "_").slice(0, 30);
    // v2.4 组合段：文件夹层次（folderSegs，默认所）+ 文件名段（fnameSegs，仅当输入框为空时兜底）
    const segValOf = (r, seg) => seg === "bureau" ? orgVal(r, "bureau") : seg === "mgmt" ? orgVal(r, "mgmt")
      : seg === "office" ? officeSafe(r.office) : seg === "station" ? (r.station || "")
      : seg === "section" ? (r.section || "") : (r.name || "");
    const segSafe = (v) => (v || "").replace(/[\\/:*?"<>|\n\r]+/g, "_").trim();
    const folderPrefix = (r) => {
      let segs = (opts.folderSegs && opts.folderSegs.length) ? opts.folderSegs : ["office"];
      let parts = segs.map((sg) => segSafe(segValOf(r, sg))).filter(Boolean);
      if (!parts.length) parts = [officeSafe(r.office)]; // 兜底：勾选段全为空值时回落到管理所，避免平铺冲突
      return parts.join("/") + "/";
    };
    for (const r of recs) {
      const phs = r.photos || [];
      for (let i = 0; i < phs.length; i++) {
        const ph = phs[i];
        let b64 = "", ext = "jpg";
        // 优先原生按需加载全图（新导入：dataUrl 仅缩略图）；否则回退 dataUrl（旧数据/Web）
        if (ph.fullPath && window.AndroidBridge && window.AndroidBridge.loadFullImage) {
          const full = window.AndroidBridge.loadFullImage(ph.fullPath);
          if (full && full.startsWith("data:")) {
            const comma = full.indexOf(",");
            b64 = full.substring(comma + 1);
            const mime = full.substring(5, full.indexOf(";")).replace("/", ".");
            ext = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("webp") ? "webp" : "jpg";
          }
        }
        if (!b64) {
          if (!ph.dataUrl || !ph.dataUrl.startsWith("data:")) continue;
          const comma = ph.dataUrl.indexOf(",");
          b64 = ph.dataUrl.substring(comma + 1);
          const mime = ph.dataUrl.substring(5, ph.dataUrl.indexOf(";")).replace("/", ".");
          ext = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("webp") ? "webp" : "jpg";
        }
        // 导出前压缩（item 3）：全图 >1MB 则重压到 <1MB，避免导出包体积爆炸且便于他端导入
        if (b64.length * 0.75 > 1000 * 1024 && window.ImgUtil && window.ImgUtil.compressPhoto) {
          try { const cp = await ImgUtil.compressPhoto(IO.b64ToBytes(b64)); b64 = cp.full.split(",")[1]; ext = "jpg"; } catch (e) {}
        }
        // 按所选文件夹层次分目录（v2.4：默认 管理所/，可选 局/管理处/所/站/段 组合）：层次/建筑物_序号.ext
        const phName = folderPrefix(r) + `${safe(r.name)}_${i + 1}.${ext}`;
        files.push({ name: phName, b64 });
        manifestItems.push({ file: phName, id: r.id, name: r.name, office: normOffice(r.office), index: i + 1 });
      }
    }
    if (!files.length) {
      hideBusy(); closeModal();
      // 问题①根因防护：UOS/Web/PWA/Win 上"没有可导出照片"通常是导入未成功（照片数据从未落库），
      // 而非导出代码缺路径——给出可操作指引，而不是只报一句"没有照片"。
      const plat = (window.AndroidBridge && window.AndroidBridge.exportFilesToTree) ? "安卓" : "当前平台（统信 UOS / Web / PWA / Win11）";
      return openModal("没有可导出照片",
        `<div class="hint">所选范围内没有照片数据。</div>
         <div class="hint">常见原因：在本平台<b>尚未成功导入照片</b>（照片数据未落库）。</div>
         <div class="hint">🟢 解决路径：<br>
         · 统信 UOS（内存仅 8G）：请用菜单「传输与共享 → 从安卓复制照片」做<b>目录流式导入</b>（免整包入内存，避免崩溃）；<br>
         · 其他平台：菜单「批量导入照片 → 手机文件夹 / zip」导入后再导出；<br>
         · 安卓导出给他端：菜单「传输与共享 → 从安卓平台导出照片」生成按管理所命名的 zip，再由他端复制导入。</div>`,
        `<button class="btn primary" onclick="APP.close()">知道了</button>`);
    }
    // 大文件流量提醒
    const go = await confirmLargeTransfer(`导出 ${files.length} 张照片（可能很大）`);
    if (!go) { hideBusy(); closeModal(); return; }
    closeModal();
    busy("正在生成照片压缩包，请稍后…");
    // 压缩包名称：优先用户自定义文件名 → 组合段（fnameSegs）→ 管理所命名（多管理所时 首个 + 等 N 所）
    const offices = [...new Set(recs.map((r) => normOffice(r.office)).filter(Boolean))];
    const segsBase = (opts.fnameSegs && opts.fnameSegs.length && recs.length)
      ? opts.fnameSegs.map((sg) => sg === "name" ? (recs.length === 1 ? segSafe(recs[0].name) : recs.length + "个建筑物") : segSafe(segValOf(recs[0], sg))).filter(Boolean).join("_") : "";
    const baseName = (opts.fname && opts.fname.trim()) ? opts.fname.trim().replace(/\.[^.]+$/, "")
      : (segsBase || (offices.length === 1 ? officeSafe(offices[0]) + "照片"
        : (offices.length > 1 ? officeSafe(offices[0]) + `等${offices.length}所照片` : "建筑物照片")));
    const arr = files.map((f) => ({ name: f.name, data: IO.b64ToBytes(f.b64) }));
    // bug②修复：附带 manifest.json（filename -> 建筑物 id）—— 导出的压缩包可被本 APP 确定性重新导入，无需逐张人工匹配
    if (manifestItems.length) {
      const manifest = { format: "shuili-photo-zip", version: 1, count: manifestItems.length, items: manifestItems };
      arr.push({ name: "manifest.json", data: IO.utf8(JSON.stringify(manifest)) });
    }
    if (opts.format === "7z") toast("当前环境 7z 引擎不可用，已改用 zip 导出（命名按管理所）");
    const zipBytes = new Uint8Array(IO.zipStore(arr));
    // 0 字节防护：压缩包本身为空（极端情况，含 zipStore([]) 恰好 22 字节的边界）绝不假装成功
    if (!arr.length || zipBytes.length <= 22) {
      hideBusy();
      return toast("导出失败：压缩包为空（0 字节），可能照片数据未就绪，请重试或检查照片");
    }
    const fname = baseName + ".zip";
    if (opts.target === "share") {
      hideBusy();
      await shareFile(fname, zipBytes, "application/zip");
    } else if (opts.target === "baidu" || opts.target === "quark") {
      hideBusy();
      exportToNetdisk(opts.target, fname, zipBytes);
    } else if (opts.target === "folder") {
      if (window.AndroidBridge && window.AndroidBridge.exportFilesToTree) {
        hideBusy();
        // 问题③之三：若所选文件夹里已有同名照片文件，原生 exportFilesToTree 会静默覆盖；先提示确认
        const dup = (window.AndroidBridge.exportListExists && window.AndroidBridge.exportListExists(JSON.stringify(files))) || false;
        if (dup) {
          const ok = await new Promise((res) => {
            openModal("目标文件夹已有同名照片",
              `<div class="hint">所选文件夹中已存在同名照片文件，导出将<b>覆盖</b>这些文件。是否继续？</div>
               <div class="hint">文件名形如 <code>管理所/建筑物_序号.jpg</code>（或按所选层次组合），按所选层次分组。</div>`,
              `<button class="btn ghost" id="foSkip">取消</button><button class="btn danger" id="foOver">覆盖导出</button>`);
            el("foSkip").onclick = () => { closeModal(); res(false); };
            el("foOver").onclick = () => { closeModal(); res(true); };
          });
          if (!ok) return toast("已取消导出（未覆盖同名文件）");
        }
        window.AndroidBridge.exportFilesToTree(JSON.stringify(files));
        toast(`已向系统请求导出 ${files.length} 张照片到所选文件夹（按所选层次分组）`);
      } else {
        hideBusy();
        IO.downloadBytes(fname, zipBytes, "application/zip");
        toast("当前环境不支持选择文件夹，已改为下载 zip（按管理所命名）");
      }
    } else {
      // 本地下载 zip：经原生分块写入 + onExportResult 回调决定成败提示（不再提前报成功）
      IO.downloadBytes(fname, zipBytes, "application/zip");
      // 注意：busy 遮罩在 onExportResult 回调里关闭，避免 SAF 弹窗期间误关
    }
  }
  // 传输与共享：从安卓复制照片（item 5）—— 统信 8G 内存导入整包易崩，故走目录复制/链接 + 流式导入，避免整包入内存
  function copyFromAndroid() {
    const br = window.AndroidBridge;
    if (br && typeof br.copyAndroidPhotos === "function") {
      br.copyAndroidPhotos(); closeModal();
      return toast("已请求从安卓复制照片（目录复制，免整包入内存），请在系统选择器中选取安卓照片目录");
    }
    // 网页版 / 统信浏览器壳：安卓照片已拷到本机某目录（U 盘/网络/共享），选该文件夹即目录流式导入
    const html = `<div class="hint">此功能用于把<b>安卓导出的照片</b>复制到当前平台直接可用。</div>
      <div class="hint">统信 UOS 内存仅 8G、导入整包易崩，这里走<b>目录流式导入</b>（逐张读取、不整包入内存），与「批量导入照片→手机文件夹」机制一致。</div>
      <div class="hint">请将安卓「导出照片」生成的文件夹（按 管理所/建筑物_序号.jpg 命名）拷到本机，然后点击下方按钮选择该文件夹。</div>`;
    openModal("从安卓复制照片", html, `<button class="btn ghost" id="caPick">选择安卓照片文件夹</button><button class="btn ghost" onclick="APP.close()">关闭</button>`);
    el("caPick").onclick = () => { closeModal(); startBatchImport("photos", "folder"); };
  }
  // 传输与共享：从安卓平台导出照片（item 5）—— 把安卓照片导出来供其他平台用
  function exportToAndroid() {
    const br = window.AndroidBridge;
    if (br && typeof br.exportPhotosToAndroid === "function") {
      br.exportPhotosToAndroid(); closeModal();
      return toast("已请求把照片导出到安卓目录，供其他平台复制使用");
    }
    // 其他平台：复用标准照片导出（下载 zip / 网盘 / 分享），zip 内含 manifest.json 可确定性重新导入
    exportPhotosMenu();
  }
  // 信息与帮助：照片（item 6）—— 展示四平台照片目录/层次/命名，便于调试照片是否拷到指定位置
  function photoInfo() {
    const html = `<div class="hint"><b>照片存储与目录</b></div>
      <div class="filelist">
        <div class="fi">🤖 <b>安卓 APK</b>：全图由原生 persistImage 落盘到应用私有 photos 目录；缩略图随记录入 IndexedDB。导出按 <code>管理所/建筑物_序号.jpg</code> 分文件夹。</div>
        <div class="fi">🍎 <b>苹果 PWA</b> / 🐧 <b>统信 UOS</b> / 🪟 <b>Win11</b>：照片以 dataUrl 存于记录内（IndexedDB 增量 delta），当前环境无原生全图落盘；导出同样按 <code>管理所/建筑物_序号.jpg</code>。</div>
        <div class="fi">📁 <b>目录层次</b>：<code>管理所 / 建筑物名_序号.扩展名</code>（jpg/png/gif/webp/bmp），序号从 1 递增。</div>
        <div class="fi">📦 <b>导出包</b>：内含 <code>manifest.json</code>（文件名→建筑物 id），可被本 APP 确定性重新导入，无需逐张人工匹配。</div>
        <div class="fi">🔄 <b>从安卓复制照片</b>：把安卓导出的照片文件夹（或 zip）目录流式导入，避免整包入内存，适配统信 8G 内存。</div>
        <div class="fi">🔍 <b>调试</b>：在地图上点击建筑物 → 弹窗/详情即可查看其照片，核对是否已在对应管理所下。</div>
      </div>`;
    openModal("照片 · 四平台目录与命名", html, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
  }
  // 原生导出完成回调：写盘成功才提示成功，失败明确报错（杜绝"假成功 + 0 字节"）
  function onExportResult(ok, msg) {
    hideBusy();
    if (ok) toast("导出成功：" + (msg || "文件已保存"));
    else toast(msg || "导出未完成");
  }
  // 分享给第三方（微信/飞书/QQ）：用系统分享面板；不支持时降级为下载
  async function shareFile(filename, bytes, mime) {
    const file = new File([bytes], filename, { type: mime || "application/octet-stream" });
    const canShare = navigator.share && (navigator.canShare ? navigator.canShare({ files: [file] }) : true);
    if (canShare) {
      try {
        await navigator.share({ files: [file], title: "水利工程照片", text: "水利工程一张图 · 照片导出" });
        toast("已唤起系统分享，请选择微信 / 飞书 / QQ 等");
        return;
      } catch (e) { if (e && e.name === "AbortError") return; /* 用户取消，不报错 */ }
    }
    IO.downloadBytes(filename, bytes, mime);
    toast("当前环境不支持系统分享，已改为本地下载");
  }

  // 分享单条建筑物（含照片 + 关键信息）给微信 / QQ / 飞书等：打包 zip 走系统分享面板
  async function shareBuilding(rid) {
    const r = records.find((x) => x.id === rid); if (!r) return;
    const phs = (r.photos || []).filter((p) => p.dataUrl && p.dataUrl.startsWith("data:") && p.dataUrl.includes(";base64,"));
    if (!phs.length) return toast("该建筑物没有可分享的照片");
    busy("正在准备分享文件，请稍后…");
    try {
      const safe = (s) => (s || "building").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").slice(0, 40);
      const files = [];
      const lines = [
        "建筑物名称：" + (r.name || ""),
        "管理所：" + (r.office || ""),
        "管理站：" + (r.station || ""),
        "类型：" + (r.btype || r.type || ""),
        "坐标：" + (r.lon != null && r.lat != null ? (r.lon + "," + r.lat) : "—"),
        "",
        "参数：",
        ...Object.keys(r.params || {}).map((k) => "  " + k + " : " + (r.params[k] || "")),
        "",
        "照片张数：" + phs.length,
      ];
      files.push({ name: safe(r.name) + "_信息.txt", data: new TextEncoder().encode(lines.join("\n")) });
      phs.forEach((p, i) => files.push({ name: `photo_${i + 1}.jpg`, data: IO.b64ToBytes(p.dataUrl.split(",")[1]) }));
      const zip = IO.zipStore(files);
      hideBusy();
      if (!zip || zip.length <= 22) return toast("分享失败：打包内容为空");
      await shareFile(safe(r.name) + "_分享.zip", zip, "application/zip");
    } catch (e) { hideBusy(); toast("分享失败：" + (e && e.message ? e.message : e)); }
  }
  function exportToNetdisk(prov, filename, bytes) {
    try {
      if (window.AndroidBridge && window.AndroidBridge.netdiskExport) {
        window.AndroidBridge.netdiskExport(prov, filename, Array.from(bytes));
        toast(`已请求导出到${prov === "baidu" ? "百度" : "夸克"}网盘，请在网盘选择器确认`);
        return;
      }
    } catch (e) { /* 桥接异常→降级 */ }
    IO.downloadBytes(filename, bytes, "application/zip");
    toast(`当前网页版未集成网盘授权，已先下载 ${filename}；可再用网盘 App 上传，或在 Android APP 内操作`);
  }

  // ---------- 网盘导入导出（item 4，凭证门控）----------
  function netdiskMenu() {
    const html = `<div class="hint">百度网盘 / 夸克网盘 导入导出需先在本机配置对应网盘凭证（AppKey/Token），当前为<b>未配置</b>状态。</div>
      <div class="hint">配置后此处可直接浏览网盘目录、拉取 kmz/照片 或上传。详见「帮助 → 网盘与互传」。</div>
      <div class="field" style="margin-top:10px">
        <button class="btn primary block" id="ndBaiduIn">📥 百度网盘导入</button>
        <button class="btn ghost block" id="ndBaiduOut" style="margin-top:8px">📤 百度网盘导出</button>
        <button class="btn ghost block" id="ndQuarkIn" style="margin-top:8px">📥 夸克网盘导入</button>
        <button class="btn ghost block" id="ndQuarkOut" style="margin-top:8px">📤 夸克网盘导出</button>
      </div>`;
    openModal("网盘导入导出", html, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
    const call = (prov, dir) => {
      if (window.AndroidBridge && window.AndroidBridge.netdiskImport) {
        if (dir === "in") window.AndroidBridge.netdiskImport(prov, pendingBatch.kind || "photos");
        else window.AndroidBridge.netdiskExport(prov, "ovkmz");
      } else {
        toast("当前环境未集成网盘（需 Android APK 且配置凭证）");
      }
    };
    el("ndBaiduIn").onclick = () => call("baidu", "in");
    el("ndBaiduOut").onclick = () => call("baidu", "out");
    el("ndQuarkIn").onclick = () => call("quark", "in");
    el("ndQuarkOut").onclick = () => call("quark", "out");
  }

  // ---------- 手机互传（item 5，P2P / 局域网，需两台设备真机测试）----------
  async function lanGetIp() {
    try { const r = await fetch("https://api.ipify.org?format=json").catch(() => null); return r ? (await r.json()).ip : "未知（不影响局域网互传）"; } catch (e) { return "未知（不影响局域网互传）"; }
  }
  async function lanMenu() {
    const ip = await lanGetIp();
    const html = `<div class="hint">两台手机都打开本 APP：一台做<b>服务端</b>（选择 kmz/照片并开启局域网共享），另一台做<b>客户端</b>（输入服务端地址下载）。需处于同一 WiFi/热点。</div>
      <div class="field"><label>本机外网地址（参考）</label><div class="coord-display"><span class="cd-v" id="lanIp">${ip}</span></div></div>
      <div class="field">
        <button class="btn primary block" id="lanStart">🛰 开启服务端（选择文件共享）</button>
        <button class="btn ghost block" id="lanStop" style="margin-top:8px">⏹ 停止服务端</button>
        <button class="btn ghost block" id="lanClient" style="margin-top:8px">📡 客户端：从服务端下载</button>
      </div>`;
    openModal("手机互传", html, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
    el("lanStart").onclick = () => { if (window.AndroidBridge && window.AndroidBridge.pickLanShare) window.AndroidBridge.pickLanShare(); else toast("当前环境不支持（需 Android APK）"); closeModal(); };
    el("lanStop").onclick = () => { if (window.AndroidBridge && window.AndroidBridge.stopLanServer) window.AndroidBridge.stopLanServer(); else toast("当前环境不支持"); closeModal(); };
    el("lanClient").onclick = () => { closeModal(); lanClientMenu(); };
  }
  function lanClientMenu() {
    const html = `<div class="field"><label>服务端地址（如 192.168.x.x）</label><input id="lanAddr" class="inp" placeholder="192.168.1.10"></div>
      <div class="field"><label>端口</label><input id="lanPort" class="inp" value="7205"></div>
      <div class="field"><label>下载内容</label><select id="lanKind"><option value="kmz">kmz/ovkmz（建筑物+照片）</option><option value="photos">照片压缩包(zip)</option></select></div>`;
    openModal("客户端下载", html, `<button class="btn ghost" id="lcCancel">取消</button><button class="btn primary" id="lcGo">下载并导入</button>`);
    el("lcCancel").onclick = closeModal;
    el("lcGo").onclick = async () => {
      const addr = el("lanAddr").value.trim(); const port = el("lanPort").value.trim() || "7205"; const kind = el("lanKind").value;
      if (!addr) return toast("请输入服务端地址");
      closeModal(); toast("正在从 " + addr + " 下载…");
      try {
        const res = await fetch(`http://${addr}:${port}/`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = await res.arrayBuffer();
        if (kind === "kmz") {
          const recs = await IO.importKmzBuffer(buf);
          await Store.patch((d) => { for (const r of recs) { const exist = BASE.find((b) => b.id === r.id) || (d.added || []).find((a) => a.id === r.id); if (exist) d.updated[r.id] = r; else d.added.push(r); } });
          DELTA = await Store.get(); merge(); render(); toast(`互传导入成功：${recs.length} 个建筑物`);
        } else {
          const files = await IO.unzip(new Uint8Array(buf));
          let cnt = 0; for (const n of Object.keys(files)) { if (/\.(jpe?g|png|gif|bmp|webp)$/i.test(n)) { receivePhoto(n, IO.bytesToB64(files[n])); cnt++; } }
          if (cnt) receiveDone("photos"); else toast("未找到照片");
        }
      } catch (e) { toast("下载失败：" + e.message + "（请确认服务端已开启且同一网络）"); }
    };
  }

  // ---------- 导入 / 导出 ----------
  async function doImport(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    if (!["kml", "csv", "kmz", "ovkmz", "xls", "xlsx", "ovobj", "obj"].includes(ext)) return toast("不支持的格式：" + ext);
    // 大文件流量提醒（items 1/2：kmz/ovkmz 可能含大量照片 >3GB）
    if (ext === "kmz" || ext === "ovkmz") {
      const go = await confirmLargeTransfer("导入 kmz/ovkmz（可能含大量照片）");
      if (!go) return;
    }
    try {
      busy("正在解析导入文件，请稍后…");
      let recs, bufBytes = null;
      if (ext === "kml") { recs = IO.parseKmlToRecords(await file.text()); }
      else if (ext === "csv") { recs = IO.parseCsvToRecords(await file.text()); }
      else if (ext === "xlsx") { const ab = await file.arrayBuffer(); bufBytes = new Uint8Array(ab); recs = await IO.parseXlsxToRecords(bufBytes); }
      else if (ext === "xls") { const txt = await file.text(); bufBytes = IO.utf8(txt); recs = IO.parseXlsToRecords(txt); }
      else if (ext === "ovobj" || ext === "obj") {
        // ① 奥维原生二进制（OviO 魔数 4f 76 69 4f）→ 点对象逆向解析（2026-08-27 实测 G 盘真实文件）
        // ② PK=zip 容器（奥维 .ovobj 常为此类）→ kmz 解包兜底；③ 1f=gzip 旧版→提示；④ 否则文本坐标
        const ab = await file.arrayBuffer();
        const head = new Uint8Array(ab).subarray(0, 4);
        if (head[0] === 0x4f && head[1] === 0x76 && head[2] === 0x69 && head[3] === 0x4f) {
          bufBytes = new Uint8Array(ab);
          recs = IO.parseOvobjBinary(bufBytes);
        } else if (head[0] === 0x50 && head[1] === 0x4b) { // ZIP 容器（奥维 .ovobj 常为此类）
          bufBytes = new Uint8Array(ab);
          recs = await IO.importKmzBuffer(bufBytes.buffer);
        } else if (head[0] === 0x1f) { // gzip 容器（旧版奥维）：浏览器无原生解压，提示电脑端
          throw new Error("该 .ovobj 为 gzip 压缩格式，请改用电脑端/PWA 导入，或先在奥维导出为 ovkmz");
        } else {
          const txt = await file.text();
          bufBytes = IO.utf8(txt);
          recs = IO.parseOvobjToRecords(txt);
        }
      }
      else {
        const ab = await file.arrayBuffer();
        bufBytes = new Uint8Array(ab);
        recs = await IO.importKmzBuffer(bufBytes.buffer);
      }
      if (!recs.length) { hideBusy(); throw new Error("未解析到任何建筑物"); }
      // 管理所名称统一（去「管理」+ 潮河特例）：导入即规范，后续导出/筛选/查询自动一致
      recs = recs.map((r) => Object.assign({}, r, { office: normOffice(r.office) }));
      // 内容去重（item 6）：整文件哈希，若与此前导入的相同则提示覆盖/跳过
      if (bufBytes) {
        const h = await IO.sha256Hex(bufBytes);
        const ui = Store.ui.get() || {};
        const srcs = ui.importedSources || [];
        if (srcs.some((s) => s.h === h)) {
          hideBusy(); // 去重弹窗需交互，先收起遮罩
          const ok = await new Promise((resolve) => {
            openModal("文件内容重复", `<div class="hint">该文件（${esc(file.name)}）内容与之前导入的完全相同（按内容校验，非文件名）。是否仍要覆盖导入？</div>`,
              `<button class="btn ghost" id="imSkip">跳过</button><button class="btn primary" id="imOver">覆盖导入</button>`);
            el("imSkip").onclick = () => { closeModal(); resolve(false); };
            el("imOver").onclick = () => { closeModal(); resolve(true); };
          });
          if (!ok) return toast("已跳过重复导入"); // busy 已收起
        }
        const newsrcs = srcs.filter((s) => s.h !== h).concat([{ h, name: file.name, at: Date.now() }]).slice(-50);
        Store.ui.set(Object.assign({}, ui, { importedSources: newsrcs }));
      }
      // 名称级冲突检测（2026-08-20）：导入的建筑物与现有记录「名称完全相同」时，提示 覆盖同名/跳过同名/取消
      const cur2 = await Store.get();
      const nameSet = new Set();
      BASE.forEach((b) => nameSet.add(b.name));
      (cur2.added || []).forEach((a) => nameSet.add(a.name));
      const collisions = recs.filter((r) => r.name && nameSet.has(r.name));
      let nameAct = "keep";
      if (collisions.length) {
        hideBusy(); // 弹窗需交互，先收起遮罩
        const list = collisions.slice(0, 12).map((r) => `<li>${esc(r.name)}</li>`).join("");
        nameAct = await new Promise((resolve) => {
          openModal("存在同名建筑物",
            `<div class="hint">本次导入的以下 <b>${collisions.length}</b> 个建筑物与现有记录<b>名称完全相同</b>：</div><ul class="filelist" style="max-height:28vh;overflow:auto">${list}</ul>${collisions.length > 12 ? `<div class="hint">…等共 ${collisions.length} 个</div>` : ""}<div class="hint" style="margin-top:6px">「覆盖同名」用导入的数据替换同名旧记录；「跳过同名」只导入名称不冲突的；「取消」中止本次导入。</div>`,
            `<button class="btn ghost" id="nmCancel">取消</button><button class="btn ghost" id="nmSkip">跳过同名</button><button class="btn primary" id="nmOver">覆盖同名</button>`);
          el("nmCancel").onclick = () => { closeModal(); resolve("cancel"); };
          el("nmSkip").onclick = () => { closeModal(); resolve("skip"); };
          el("nmOver").onclick = () => { closeModal(); resolve("over"); };
        });
        if (nameAct === "cancel") return toast("已取消导入（存在同名建筑物）");
      }
      await Store.patch((d) => {
        if (nameAct === "skip") {
          for (const r of recs) {
            if (nameSet.has(r.name)) continue;
            const exist = BASE.find((b) => b.id === r.id) || (d.added || []).find((a) => a.id === r.id);
            if (exist) { d.updated[r.id] = r; } else { d.added.push(r); }
          }
        } else if (nameAct === "over") {
          // 覆盖同名：BASE 同名记录用导入内容按原 id 覆盖；added 中同名且非本批的移除；其余按 id 合并
          const nameToBase = {};
          BASE.forEach((b) => { nameToBase[b.name] = b.id; });
          const batchIds = new Set(recs.map((r) => r.id));
          const inNames = new Set(recs.map((r) => r.name));
          d.added = (d.added || []).filter((a) => !(inNames.has(a.name) && !batchIds.has(a.id)));
          Object.keys(d.updated || {}).forEach((k) => {
            if (inNames.has((d.updated[k] || {}).name) && !batchIds.has(k)) delete d.updated[k];
          });
          for (const r of recs) {
            const bid = nameToBase[r.name];
            if (bid && bid !== r.id) { d.updated[bid] = Object.assign({}, r, { id: bid }); continue; }
            const exist = BASE.find((b) => b.id === r.id) || (d.added || []).find((a) => a.id === r.id);
            if (exist) { d.updated[r.id] = r; } else { d.added.push(r); }
          }
        } else {
          for (const r of recs) {
            const exist = BASE.find((b) => b.id === r.id) || (d.added || []).find((a) => a.id === r.id);
            if (exist) { d.updated[r.id] = r; } else { d.added.push(r); }
          }
        }
      });
      DELTA = await Store.get(); merge(); render();
      hideBusy();
      toast(`导入成功：${recs.length} 个建筑物`);
      kbLog("导入建筑物", { file: file.name, count: recs.length });
    } catch (e) { hideBusy(); toast("导入失败：" + e.message); }
  }
  function exportMenu() {
    const hasFilter = filter.office.length || filter.btype.length || filter.q;
    const scope = hasFilter ? records.filter(passFilter) : records;
    const scopeLabel = hasFilter ? `筛选结果（${scope.length} 个）` : `全部建筑物（${scope.length} 个）`;
    const scopeOffices = new Set(scope.map((r) => normOffice(r.office)).filter(Boolean)); // 自动匹配：已选建筑物所属管理所
    const html = `<div class="hint" style="border:1px dashed var(--accent);border-radius:10px;padding:9px 12px;color:var(--txt);line-height:1.7">当前导出范围：<b style="color:var(--accent);font-size:14px">${scopeLabel}</b>${hasFilter ? "（已按当前筛选条件预选，可在下方增删）" : "（未筛选则导出全部；可先「筛选」再导出以只导筛选集）"}</div>
      <div class="field" style="margin-top:12px"><label>导出范围（勾选指定建筑物）</label>
        <div class="ex-selbar"><button class="btn ghost sm" id="exAll">全选</button><button class="btn ghost sm" id="exNone">全不选</button><span class="hint" id="exCnt">已选 ${scope.length}/${scope.length}</span></div>
        <div class="ex-list" id="exList">${scope.map((r) => `<label class="ex-item"><input type="checkbox" class="ex-cb" value="${r.id}" checked><span>${esc(r.name)}</span></label>`).join("")}</div>
      </div>
      <div class="field" style="margin-top:10px"><label>按管理所筛选（默认匹配已选建筑物所属管理所；选项含全部管理所）</label>
        <div class="ofc-list" id="exOffices" style="max-height:150px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px 14px">${DIMS.offices.map((o) => `<label class="ofc"><input type="checkbox" class="exo-cb" value="${esc(o)}" ${scopeOffices.has(o) ? "checked" : ""}>${esc(o)}</label>`).join("")}</div></div>
      <div class="field"><label>格式</label>
        <select id="exFmt">
          <option value="ovkmz">ovkmz（奥维可导入，含照片）</option>
          <option value="kmz">kmz（含照片）</option>
          <option value="kml">kml（不含照片，通用）</option>
          <option value="csv">csv（属性表）</option>
          <option value="chaohe">潮河格式（CSV 兼容）</option>
          <option value="xlsx">xlsx（Excel，通用）</option>
          <option value="xls">xls（Excel 2003 兼容）</option>
          <option value="ovobj">ovobj（奥维文本坐标，纯文本）</option>
          <option value="ovobjbin">ovobj（奥维二进制 OviO，兼容奥维）</option>
        </select></div>
      <div class="field" id="exColsField" style="display:none"><label>导出列（可取消勾选不需要的列）</label>
        <div class="ex-selbar"><button class="btn ghost sm" id="colAll">全选</button><button class="btn ghost sm" id="colNone">全不选</button></div>
        <div class="ex-list" id="exCols"></div></div>
      <div class="field"><label>文件名组合段（点选自动生成文件名；默认 所+建筑物名，生成后仍可手改）</label>
        <div class="chips" id="exSegs">
          <span class="chip" data-seg="bureau">局</span>
          <span class="chip" data-seg="mgmt">管理处</span>
          <span class="chip on" data-seg="office">所</span>
          <span class="chip" data-seg="station">站</span>
          <span class="chip" data-seg="section">段</span>
          <span class="chip on" data-seg="name">建筑物名</span>
        </div></div>
      <div class="field"><label>文件名（不含扩展名，系统按所选格式自动加后缀）</label><input id="exFname" class="inp" value="建筑物信息"></div>
      <div class="field"><label>导出位置</label>
        <select id="exWhere"><option value="saf">本地下载（可改文件名）</option><option value="folder">指定手机文件夹（Android，可改文件名）</option></select></div>
      <div class="hint">ovkmz/kmz 为 zip 包（doc.kml + 照片）；潮河格式为 CSV（列：名称,管理所,管理站,类型,经度,纬度,说明）；xlsx/xls 为统一属性表（名称/管理所/管理站/建筑物类型/经纬度/自定义参数/说明），<b>导出的文件可原样再导入</b>。选「指定手机文件夹」将弹出系统文件夹选择器。</div>`;
    openModal("导出", html, `<button class="btn ghost" id="exCancel">取消</button><button class="btn primary" id="exGo">导出</button>`);
    const list = el("exList");
    const updateCnt = () => { el("exCnt").textContent = `已选 ${list.querySelectorAll(".ex-cb:checked").length}/${scope.length}`; };
    el("exAll").onclick = () => { list.querySelectorAll(".ex-cb").forEach((c) => c.checked = true); updateCnt(); };
    el("exNone").onclick = () => { list.querySelectorAll(".ex-cb").forEach((c) => c.checked = false); updateCnt(); };
    // 按管理所筛选：勾选的管理所 → 仅其下建筑物可选（空选则全部取消，导出时提示）
    function filterByOffice() {
      const off = new Set([...document.querySelectorAll("#exOffices .exo-cb:checked")].map((c) => c.value));
      list.querySelectorAll(".ex-cb").forEach((c) => {
        const r = records.find((x) => x.id === c.value);
        c.checked = off.size ? (r && off.has(normOffice(r.office))) : false;
      });
      updateCnt();
    }
    document.querySelectorAll("#exOffices .exo-cb").forEach((c) => (c.onchange = filterByOffice));
    el("exCancel").onclick = closeModal;
    // 导出可选列（#39）：csv/chaohe 时显示列多选，默认全选；v2.4.3 新增「管理处」列（三级元数据，原本只导管理所）
    // 第三项 true = 默认勾选；false = 默认不勾选（如管理处）
    const EX_COLS = {
      csv: [["folder", "文件夹", true], ["name", "名称", true], ["mgmt", "管理处", false], ["office", "管理所", true], ["station", "管理站", true], ["btype", "建筑物类型", true], ["lon", "经度", true], ["lat", "纬度", true], ["comment", "Comment", true]],
      chaohe: [["name", "名称", true], ["mgmt", "管理处", false], ["office", "管理所", true], ["station", "管理站", true], ["btype", "建筑物类型", true], ["lon", "经度", true], ["lat", "纬度", true], ["comment", "说明", true]],
      xlsx: [["name", "名称", true], ["mgmt", "管理处", false], ["office", "管理所", true], ["station", "管理站", true], ["btype", "建筑物类型", true], ["lon", "经度", true], ["lat", "纬度", true], ["desc", "说明", true]],
      xls: [["name", "名称", true], ["mgmt", "管理处", false], ["office", "管理所", true], ["station", "管理站", true], ["btype", "建筑物类型", true], ["lon", "经度", true], ["lat", "纬度", true], ["desc", "说明", true]],
      ovobj: [["name", "名称", true], ["mgmt", "管理处", false], ["office", "管理所", true], ["station", "管理站", true], ["btype", "建筑物类型", true], ["lon", "经度", true], ["lat", "纬度", true], ["desc", "说明", true]],
    };
    const exColsField = el("exColsField"), exColsBox = el("exCols");
    function renderExCols() {
      const f = el("exFmt").value;
      if (f !== "csv" && f !== "chaohe" && f !== "xlsx" && f !== "xls" && f !== "ovobj") { exColsField.style.display = "none"; return; }
      const def = EX_COLS[f] || [];
      exColsBox.innerHTML = def.map((p) => '<label class="ex-item"><input type="checkbox" class="col-cb" value="' + p[0] + '"' + (p[2] === false ? '' : ' checked') + '><span>' + p[1] + '</span></label>').join("");
      exColsField.style.display = "";
    }
    el("exFmt").addEventListener("change", renderExCols);
    el("colAll").onclick = () => { exColsBox.querySelectorAll(".col-cb").forEach((c) => c.checked = true); };
    el("colNone").onclick = () => { exColsBox.querySelectorAll(".col-cb").forEach((c) => c.checked = false); };
    renderExCols();
    // 文件名组合段（v2.4）：局/管理处/所/站/段/建筑物名 任意组合，英文 _ 分隔；多选建筑物时名段显示「N个建筑物」
    const segValOf = (r, seg) => seg === "bureau" ? orgVal(r, "bureau") : seg === "mgmt" ? orgVal(r, "mgmt")
      : seg === "office" ? (normOffice(orgVal(r, "office")) || "") : seg === "station" ? (r.station || "")
      : seg === "section" ? (r.section || "") : (r.name || "");
    const genFnameFromSegs = () => {
      const segs = [...el("exSegs").querySelectorAll(".chip.on")].map((c) => c.dataset.seg);
      if (!segs.length) return;
      const ids = [...list.querySelectorAll(".ex-cb:checked")].map((c) => c.value);
      const src0 = records.filter((r) => ids.includes(r.id));
      const src = src0.length ? src0 : scope;
      const safeSeg = (v) => (v || "").replace(/[\\/:*?"<>|\n\r]+/g, "_").trim();
      const parts = segs.map((sg) => sg === "name" ? (src.length === 1 ? safeSeg(src[0].name) : src.length + "个建筑物") : safeSeg(segValOf(src[0], sg))).filter(Boolean);
      if (parts.length) el("exFname").value = parts.join("_");
    };
    el("exSegs").querySelectorAll(".chip").forEach((c) => c.onclick = () => { c.classList.toggle("on"); genFnameFromSegs(); });

    el("exGo").onclick = async () => {
      const fmt = el("exFmt").value, where = el("exWhere").value;
      const ids = [...list.querySelectorAll(".ex-cb:checked")].map((c) => c.value);
      const sel = records.filter((r) => ids.includes(r.id));
      if (!sel.length) return toast("请至少选择一项");
      const hasCols = (fmt === "csv" || fmt === "chaohe" || fmt === "xlsx" || fmt === "xls");
      const cols = hasCols ? [...exColsBox.querySelectorAll(".col-cb:checked")].map((c) => c.value) : null;
      if (hasCols && (!cols || !cols.length)) return toast("请至少选择一列");
      // 大文件流量提醒（含照片格式可能很大）
      if (fmt === "ovkmz" || fmt === "kmz") {
        const go = await confirmLargeTransfer("导出 " + fmt.toUpperCase() + "（含照片，可能很大）");
        if (!go) return;
      }
      // 导出前先显示「执行中」遮罩：含照片的 kmz/ovkmz 在 JS 端打包 base64 可能较慢，避免"点了没反应"
      busy("正在生成导出文件，请稍后…");
      await new Promise((r) => setTimeout(r, 30)); // 让遮罩先绘制
      try {
        // 统一构建内容 + 自定义文件名 + 选位置（#116）
        let content, ext, mime, isBytes;
        if (fmt === "ovkmz") { content = IO.recordsToKmzBytes(sel); ext = ".ovkmz"; mime = "application/vnd.google-earth.kmz"; isBytes = true; }
        else if (fmt === "kmz") { content = IO.recordsToKmzBytes(sel); ext = ".kmz"; mime = "application/vnd.google-earth.kmz"; isBytes = true; }
        else if (fmt === "kml") { content = IO.buildKML(sel); ext = ".kml"; mime = "application/vnd.google-earth.kml+xml"; isBytes = false; }
        else if (fmt === "csv") { content = IO.buildCsv(sel, cols); ext = ".csv"; mime = "text/csv;charset=utf-8"; isBytes = false; }
        else if (fmt === "chaohe") { content = IO.buildChaohe(sel, cols); ext = ".csv"; mime = "text/csv;charset=utf-8"; isBytes = false; }
        else if (fmt === "xlsx") { content = IO.buildAttrXlsx(sel, cols); ext = ".xlsx"; mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; isBytes = true; }
        else if (fmt === "xls") { content = IO.buildAttrXls(sel, cols); ext = ".xls"; mime = "application/vnd.ms-excel"; isBytes = true; }
        else if (fmt === "ovobj") { content = IO.recordsToOvobj(sel, cols); ext = ".ovobj"; mime = "text/plain;charset=utf-8"; isBytes = false; }
        else if (fmt === "ovobjbin") { content = IO.recordsToOvobjBinary(sel); ext = ".ovobj"; mime = "application/octet-stream"; isBytes = true; }
        else { content = IO.buildCsv(sel, cols); ext = ".csv"; mime = "text/csv;charset=utf-8"; isBytes = false; }
        let base = (el("exFname").value || "建筑物信息").trim().replace(/\.[^.]+$/, ""); // 去掉用户误填的扩展名
        if (!base) base = "建筑物信息";
        const fname = base + ext;
        const b64 = isBytes ? IO.bytesToB64(content) : IO.bytesToB64(IO.utf8(content));
        if (where === "folder" && window.AndroidBridge && window.AndroidBridge.exportFilesToTree) {
          window.AndroidBridge.exportFilesToTree(JSON.stringify([{ name: fname, b64 }]));
          hideBusy(); closeModal(); toast("已向系统请求导出到所选文件夹：" + fname);
          return;
        }
        if (isBytes) IO.downloadBytes(fname, content, mime); else IO.downloadText(fname, content, mime);
        hideBusy();
        closeModal(); toast("已开始导出 " + fmt.toUpperCase() + "：" + fname);
      } catch (e) { hideBusy(); closeModal(); toast("导出失败：" + (e && e.message ? e.message : e)); }
    };
  }

  // ---------- 其它：统计/定位/同步/重置/帮助/关于 ----------
  function stats() {
    const byOffice = {}, byBtype = {};
    records.forEach((r) => { byOffice[r.office] = (byOffice[r.office] || 0) + 1; byBtype[r.btype] = (byBtype[r.btype] || 0) + 1; });
    const grid = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="stat"><div class="n">${v}</div><div class="t">${esc(k) || "未分类"}</div></div>`).join("");
    const custom = (DELTA.added || []).length + Object.keys(DELTA.updated || {}).length;
    const html = `<div class="stat-grid">
        <div class="stat"><div class="n">${records.length}</div><div class="t">建筑物总数</div></div>
        <div class="stat"><div class="n">${custom}</div><div class="t">我的改动</div></div>
      </div>
      <h4 style="margin:14px 0 6px">按管理所</h4><div class="stat-grid">${grid(byOffice)}</div>
      <h4 style="margin:14px 0 6px">按建筑物类型</h4><div class="stat-grid">${grid(byBtype)}</div>`;
    openModal("统计概览", html, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
  }
  function locate() {
    if (!navigator.geolocation) return toast("当前环境不支持定位");
    toast("正在定位…");
    navigator.geolocation.getCurrentPosition((p) => {
      myLoc = { lat: p.coords.latitude, lon: p.coords.longitude };
      if (myLocMarker) map.removeLayer(myLocMarker);
      myLocMarker = L.circleMarker([myLoc.lat, myLoc.lon], { radius: 9, color: "#2ecc8f", fillColor: "#2ecc8f", fillOpacity: .65, weight: 3 }).addTo(map).bindPopup("我的位置").openPopup();
      map.setView([myLoc.lat, myLoc.lon], 15);
      toast("已定位到我的位置");
    }, (err) => {
      const denied = (err && err.code === 1); // PERMISSION_DENIED
      if (window.AndroidBridge && window.AndroidBridge.openLocationSettings) {
        // APK(WebView)：直接跳转系统定位设置页
        window.AndroidBridge.openLocationSettings();
      } else if (denied) {
        toast("定位被拒绝，请在浏览器站点设置中允许定位");
      } else {
        toast("无法获取位置：请确认已开启定位服务后重试");
      }
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  }
  // ---------- 导航 / 周边 / 测距 ----------
  function navigate(id) {
    const r = records.find((x) => x.id === id); if (!r) return;
    const name = r.name || "目标";
    let url;
    if (myLoc) {
      url = `https://uri.amap.com/navigation?from=${myLoc.lon},${myLoc.lat},我的位置&to=${r.lon},${r.lat},${encodeURIComponent(name)}&mode=car&policy=1&src=shuili&coordinate=wgs84&callnative=1`;
    } else {
      url = `https://uri.amap.com/marker?position=${r.lon},${r.lat}&name=${encodeURIComponent(name)}&src=shuili&coordinate=wgs84&callnative=1`;
    }
    if (window.AndroidBridge && window.AndroidBridge.openNav) window.AndroidBridge.openNav(url);
    else window.open(url, "_blank");
    toast(myLoc ? "已用我的位置发起导航" : "已打开目标位置");
  }
  function nearCenter(id) {
    const r = records.find((x) => x.id === id); if (!r) return;
    nearbyCenter = { lat: r.lat, lon: r.lon };
    openNearby();
  }
  function openNearby() {
    const centerOpts = `<option value="map">当前地图中心</option>` +
      (myLoc ? `<option value="me">我的位置</option>` : ``) +
      `<option value="pick">在地图上点选</option>` +
      records.slice(0, 200).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    const html = `<div class="field"><label>中心</label><select id="nbCenter">${centerOpts}</select></div>
      <div class="field"><label>半径（米）</label>
        <select id="nbRadius"><option value="200">200</option><option value="500" selected>500</option><option value="1000">1000</option><option value="3000">3000</option><option value="5000">5000</option><option value="10000">10000</option></select></div>
      <div class="field"><label>周边建筑物类型（点选切换，多选；全空 = 全部）</label><div class="chips" id="nbBtypes">${DIMS.btypes.map((b) => `<span class="chip" data-bt="${esc(b)}">${esc(b)}</span>`).join("") || '<span class="hint">无类型</span>'}</div><div class="hint" style="margin-top:4px">已选 <b id="nbBtCnt">0</b> 个类型</div></div>
      <div class="hint">将显示与「中心」距离不超过半径、且符合所选类型的全部建筑物，并在地图上画范围圈。</div>`;
    openModal("周边搜索", html, `<button class="btn ghost" id="nbExit">退出</button><button class="btn ghost" id="nbClear">清除周边</button><button class="btn primary" id="nbGo">搜索</button>`);
    el("nbExit").onclick = closeModal;
    const nbBtBox = el("nbBtypes");
    const refreshNbCnt = () => { const c = nbBtBox ? nbBtBox.querySelectorAll(".chip.on").length : 0; const elc = el("nbBtCnt"); if (elc) elc.textContent = c; };
    if (nbBtBox) nbBtBox.querySelectorAll(".chip").forEach((c) => c.onclick = () => { c.classList.toggle("on"); refreshNbCnt(); });
    el("nbGo").onclick = () => {
      const cval = el("nbCenter").value, rad = parseInt(el("nbRadius").value, 10);
      nearbyBtypes = nbBtBox ? [...nbBtBox.querySelectorAll(".chip.on")].map((c) => c.dataset.bt) : [];
      if (cval === "map") nearbyCenter = { lat: map.getCenter().lat, lon: map.getCenter().lng };
      else if (cval === "me") { if (!myLoc) return toast("尚未定位，请先「定位我的位置」"); nearbyCenter = myLoc; }
      else if (cval === "pick") { closeModal(); pickNearbyCenter(rad); return; }
      else { const rr = records.find((x) => x.id === cval); if (!rr) return; nearbyCenter = { lat: rr.lat, lon: rr.lon }; }
      nearbyRadius = rad; closeModal(); render(); fitToShown();
      toast(`周边 ${rad}m 内共 ${records.filter(passFilter).length} 个建筑物` + (nearbyBtypes.length ? `（类型：${nearbyBtypes.join("/")}）` : ""));
    };
    el("nbClear").onclick = () => {
      nearbyCenter = null; nearbyRadius = null; nearbyBtypes = [];
      if (nearbyCircle) { overlayGroup.removeLayer(nearbyCircle); nearbyCircle = null; }
      closeModal(); render(); toast("已清除周边筛选");
    };
  }
  function pickNearbyCenter(rad) {
    toast("请在地图上点选周边中心");
    map.once("click", (e) => { nearbyCenter = { lat: e.latlng.lat, lon: e.latlng.lng }; nearbyRadius = rad; render(); fitToShown(); toast(`周边 ${rad}m 内共 ${records.filter(passFilter).length} 个建筑物`); });
  }
  function haversine(a, b) {
    const R = 6371000, toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m"; }
  function enterMeasure() {
    measureMode = true; measurePts = [];
    if (measureLine) overlayGroup.removeLayer(measureLine);
    measureLine = L.polyline([], { color: "#ffb454", weight: 3, dashArray: "6 6" }).addTo(overlayGroup);
    el("measurebar").classList.add("show");
    el("measureInfo").textContent = "点击地图或建筑物添加测量点";
    el("map").style.cursor = "crosshair";
    toast("测距：依次点击两点或建筑物");
  }
  function exitMeasure() {
    measureMode = false;
    if (measureLine) { overlayGroup.removeLayer(measureLine); measureLine = null; }
    overlayGroup.eachLayer((l) => { if (l._mpt) overlayGroup.removeLayer(l); });
    measurePts = [];
    el("measurebar").classList.remove("show");
    el("map").style.cursor = "";
  }
  function addMeasurePt(ll) {
    const latlng = L.latLng(ll.lat, ll.lon);
    measurePts.push(latlng);
    const idx = measurePts.length;
    const mk = L.circleMarker(latlng, { radius: 5, color: "#ffb454", fillColor: "#fff", fillOpacity: 1, weight: 2 });
    mk._mpt = true; mk.bindTooltip("点" + idx, { direction: "top" });
    overlayGroup.addLayer(mk);
    measureLine.addLatLng(latlng);
    let total = 0;
    for (let i = 1; i < measurePts.length; i++) total += haversine({ lat: measurePts[i - 1].lat, lon: measurePts[i - 1].lng }, { lat: measurePts[i].lat, lon: measurePts[i].lng });
    const seg = measurePts.length >= 2 ? haversine({ lat: measurePts[measurePts.length - 2].lat, lon: measurePts[measurePts.length - 2].lng }, { lat: measurePts[measurePts.length - 1].lat, lon: measurePts[measurePts.length - 1].lng }) : 0;
    el("measureInfo").textContent = `共 ${measurePts.length} 点，总长 ${fmtDist(total)}` + (measurePts.length >= 2 ? `（末段 ${fmtDist(seg)}）` : "");
  }

  async function syncExport() {
    const txt = await Store.exportJSON();
    IO.downloadText("水利一张图-我的改动.json", txt, "application/json");
    toast("已导出我的改动");
  }
  function syncImport() {
    pickFiles({ accept: ".json", onPick: async (files) => {
      const f = files[0]; if (!f) return;
      try { await Store.importJSON(await f.text()); DELTA = await Store.get(); merge(); render(); toast("已导入改动"); }
      catch (e) { toast("导入失败：" + e.message); }
    }});
  }
  async function reset() {
    if (!confirm("重置将清除全部「我的改动」，恢复到基础数据。确认？")) return;
    await Store.clear(); DELTA = await Store.get(); merge(); render(); toast("已重置为基础数据");
    kbLog("重置为基础数据", {});
  }
  function help() {
    const html = `<div class="hint" style="line-height:1.9">
      <b>浏览</b>：拖动地图、缩放查看建筑物；点击标记看详情与照片。<br>
      <b>搜索</b>：顶部输入框按名称实时筛选。<br>
      <b>筛选</b>：菜单→筛选，可多选建筑物类型（如 节制闸 / 跌水）与管理所（如 温泉所）；选管理所会自动定位到其范围中心。<br>
      <b>添加</b>：菜单→添加，点「在地图上点选坐标」或手填经纬度，可上传多张照片（正面/背面/侧面…）。<br>
      <b>编辑/删除</b>：点开标记 → 编辑 / 删除。<br>
      <b>导入</b>：支持 ovkmz / kmz / kml / csv / ovobj / obj（奥维导出格式；ovobj 自动识别：奥维原生二进制 OviO 点对象、文本坐标、zip/gzip 容器，均可导入）。<br>
      <b>导出</b>：ovkmz/kmz 含照片，可被奥维「导入」识别；csv 为属性表；ovobj 有两种：纯文本坐标（可被本 App 原样再导入）与奥维二进制 OviO（与奥维原生 ovobj 布局兼容，奥维可导入）。<br>
      <b>我的改动</b>：所有增删改存在本机（IndexedDB），离线可用；菜单→导出/导入我的改动 可备份或迁移。<br>
      <b>底图</b>：右上角 🚫/🗺 按钮开关天地图底图；默认关闭（仅显示点位，省流量），开启需联网。顶栏「矢量/影像」按钮可在<b>矢量地图</b>与<b>影像地图</b>间切换。<br>
      <b>定位</b>：菜单→定位我的位置；若未授权，App(安卓)会自动跳转系统定位设置，浏览器请手动开启站点定位权限。<br>
      <b>获取经纬度</b>：菜单→获取经纬度，可获取「我的位置」坐标、在地图上点选坐标、或搜索建筑物列出其坐标；支持一键复制（格式「纬度, 经度」）。<br>
      <b>导航</b>：点开建筑物 → 导航，优先用「我的位置」为起点，跳转高德等第三方导航软件（坐标为 WGS84 自动转换）。<br>
      <b>测距</b>：菜单→测距，依次点击地图或建筑物，自动绘制折线并显示累计距离；退出可点浮条"退出"、再点一次菜单"测距"、或按返回键/Esc。<br>
      <b>周边</b>：菜单→周边搜索，选中心（我的位置 / 地图中心 / 某建筑物 / 地图点选）+ 半径，列出并高亮范围內建筑物。<br>
      <b>列表快速定位</b>：顶部 ☰ 打开建筑物列表，每项右侧「快速定位 →」点一下即飞到该建筑物地图位置并关闭列表。<br>
      <b>找不到主菜单？</b>：在地图任意处<b>快速连点三下</b>，即可关闭卡住的弹窗/列表并重新打开主菜单（顶部 ≡ 也始终可用）。<br>
      <b>关闭弹窗</b>：点右上角 ×（圆形按钮）、点弹窗外灰色遮罩、或按返回键/Esc，三种方式皆可；列表与抽屉也有各自的关闭 ×。<br>
      <b>离线</b>：App 与数据可离线使用；底图需联网（大范围离线瓦片体积过大）。<br>
      <b>安卓</b>：Chrome 打开 → 右上角 ≡ → 添加到主屏幕，即成为 App。<br>
      <b>关于</b>：菜单→关于，含「建议使用环境」与「制作环境（本机运行环境）」；更完整说明见应用文档《用户使用文档》。
      <hr style="border:none;border-top:1px dashed var(--line);margin:10px 0">
      <b>📚 知识库（智能框架）</b>：菜单→知识库查询 可对话式检索本机知识库（不依赖联网）；<b>导入知识库文件</b>支持 md / txt / html 多选（主流知识库 Obsidian/语雀/Notion 兼容，元数据自动还原）；<b>导入外部文件存入知识库</b>把 pdf / docx / xlsx / html / csv / 图片 在<b>应用内零依赖</b>智能转为 Markdown 入库，扫描件 PDF 与图片自动<b>内置 OCR</b>识别文字，全程进度条；保存即<b>切片+向量化</b>（句子级切片，尽量保持语句完整），支持<b>混合检索（关键词+向量）、反向/模糊/语义查询</b>；导出支持 md / txt / html / zip。<br>
      <b>🧠 记忆管理</b>：知识库内置 Hermes 自我学习机制，AI 查询/更新/纠错会自动沉淀记忆，下次交互更贴合你的业务；与已接入大模型有机融合（提示词自动拼装知识库精准片段 + 自学习记忆）。<br>
      <b>⬆️ 升级与备份</b>：菜单→设置→软件升级，公开版/内部版均经<b>百度网盘自动升级</b>（填入 latest.json 直读地址即可，下载填网盘分享链接）；升级前先「升级数据导出」（可自定义文件夹/文件名，默认「水利一张图备份+日期.bak」），该包可回灌「升级数据导入」（会覆盖本机全部数据，已明确提示风险）。<br>
      <b>📝 备忘录 / 游记</b>：水利/感知「写备忘录」、古建「写游记」——所见即所得（字体/字号/表情/图片/表格），默认绑定对象，关键词筛选，导出 MD+JSON，内容镜像知识库供 AI 查询。<br>
      <b>🤖 智能 AI</b>：智能查询/智能问询/AI 更新/纠错/对话，均基于已接入的大模型（设置→大模型 AI 设置 配置密钥与地址）；联网开启时本地无果可联网兜底，答案标注来源。<br>
      <b>🐞 错误日志</b>：菜单→信息与帮助→错误日志，全局捕获运行错误（环形缓冲），可查看/复制/清空，便于反馈排查。
    </div>`;
    openModal("帮助", html, `<button class="btn ghost" onclick="APP.close()">知道了</button>`);
  }
  function getEnvInfo() {
    const ua = navigator.userAgent || "";
    let os = "未知", osVer = "";
    if (/Windows NT 10/.test(ua)) { os = "Windows"; osVer = "10 / 11"; }
    else if (/Windows NT 6\.3/.test(ua)) { os = "Windows"; osVer = "8.1"; }
    else if (/Windows NT 6\.1/.test(ua)) { os = "Windows"; osVer = "7"; }
    else if (/Windows/.test(ua)) { os = "Windows"; }
    else if (/Android (\d+(?:\.\d+)?)/.test(ua)) { os = "Android"; osVer = RegExp.$1; }
    else if (/iPhone|iPad/.test(ua)) { os = "iOS"; }
    else if (/Mac OS X/.test(ua)) { os = "macOS"; }
    else if (/Linux/.test(ua)) { os = "Linux"; }
    let device = "";
    const dm = ua.match(/;\s*([^;()]+?)\s+Build\//);
    if (dm) device = dm[1].trim();
    if (!device) {
      if (/iPhone/.test(ua)) device = "iPhone";
      else if (/iPad/.test(ua)) device = "iPad";
      else if (/Android/.test(ua)) device = "Android 设备";
      else if (/Windows/.test(ua)) device = "PC";
      else device = "未知设备";
    }
    let engine = "浏览器";
    if (/Edg\//.test(ua)) engine = "Edge";
    else if (/Chrome\//.test(ua)) engine = "Chrome";
    else if (/Firefox\//.test(ua)) engine = "Firefox";
    else if (/Safari\//.test(ua)) engine = "Safari";
    if (window.AndroidBridge) engine += "（App WebView）";
    const cpu = navigator.hardwareConcurrency ? navigator.hardwareConcurrency + " 核" : "未知";
    const mem = navigator.deviceMemory ? navigator.deviceMemory + " GB" : "未知";
    let gpu = "未知";
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (gl) {
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "未知";
      }
    } catch (e) {}
    const sw = window.screen ? window.screen.width : 0, sh = window.screen ? window.screen.height : 0;
    const dpr = window.devicePixelRatio || 1;
    const screen = (sw && sh) ? `${sw}×${sh} @${dpr}x` : "未知";
    return { os, osVer, device, engine, cpu, mem, gpu, screen };
  }
  // 版本变更：单一来源 APP_VER + 内置变更摘要（与文档同步维护）
  const CHANGELOG = [
    ["v2.4.7", "2026-09-05", ["升级按钮与自动升级：设置菜单新增「检查新版本」一键检测（百度网盘）；发现新版自动下载安装包（直链走 fetch 分块下载+进度、下载完成提示安装位置；百度网盘分享页自动打开并备好提取码），可在升级对话框关闭自动下载", "古建改单通道：数据本身公开、两端全功能，取消内部分版——构建只出一套包（releases/），升级走 public 通道；水利/感知保持公开/内部双通道隔离不变", "发版自动上传百度网盘：构建收尾自动把安装包 + latest.json 上传到网盘「一张图发布/<应用>/<通道>/」目录（bdpan CLI；未登录时优雅跳过），并发起 30 天分享链接写回 latest.json"]],
    ["v2.4.6", "2026-09-05", ["知识库智能框架：保存即「切片+向量化」——句子级切片（尽量保持语句完整，长段按句切且重叠衔接），离线哈希向量（中英文混排，零外部依赖）+ 关键词命中 = 混合检索；支持反向查询（内容→条目）、模糊/语义查询、智能生成提示词", "引入记忆管理（MEMORY）与 Hermes 自我学习机制，并与已接入大模型有机融合（AI 提示词自动拼装 KB 精准片段 + 自学习记忆），统一上下文检索入口", "升级体系升级：水利/感知内部版与公开版均可经百度网盘自动升级（latest.json 直读清单 + download 填网盘分享链接）；升级数据导出支持自定义文件夹/文件名（默认「水利一张图备份+日期.bak」/「感知设备一张图+日期.bak」），导出文件可回灌导入并提示覆盖全部数据风险", "修复「写备忘录/写游记」菜单 script error：journal.js 全面 ES5 兼容 + 全局 helper（openModal/el/toast/KB）缺失时 fail-loud 而非静默空操作；app.js 顶注注入 NodeList.forEach 等老 WebView 兼容垫片，杜绝白屏与裸 script error", "内置轻量 OCR（tesseract.js 本地资产 chi_sim/eng，离线）：扫描件 PDF 与 jpg/png/bmp/webp 图片自动识别文字入库，懒加载不拖启动", "新增「信息与帮助→四端功能对照单/版本变更/功能介绍」全部同步到最新（含 v2.4.4~v2.4.6 新增能力）"]],
    ["v2.4.5", "2026-09-05", ["知识库格式改造（主流知识库兼容）：「导出知识库」由 zip 改为单文件 md / txt / html——md 为 YAML front matter 格式（title/tags/type/updated/id），Obsidian / Joplin / 语雀 / Notion 等主流知识库可直接导入；zip 完整备份在导出对话框保留兼容", "「导入知识库文件」支持 md / txt / html 多选导入，front matter 元数据自动还原（标题/标签/类型）；旧 .zip 备份仍可导入", "新增「导入外部文件存入知识库」智能转换：pdf / docx / xlsx / html / csv / json 等非 md 格式，应用内零依赖智能转为 Markdown 后入库——pdf 提取文本流（扫描件/加密件明确报错引导，不静默）、docx 保留标题/列表/表格、xlsx/csv 转标准 md 表格；转换全程进度条指示，支持多文件批量", "知识库查询效率优化：检索索引（标题+标签+正文小写串）按条目缓存、写入/删除自动失效；导出正文剔除可再生成的操作日志，降低 token 与文件体积"]],
    ["v2.4.4", "2026-09-04", ["三端新增升级体系：设置菜单「软件升级/升级数据导出/升级数据导入」——升级前提醒备份、导出包旧版可导入（跨版本数据兼容含照片）、公开/内部通道隔离不交叉、无新版明确提示", "图文笔记引擎 journal.js：古建「写游记」、水利/感知「写备忘录/导出备忘录」——所见即所得（字体/字号/表情/图片/表格），默认绑定对象，关键词筛选（名称/时间/摘要），导出 MD+JSON，内容镜像知识库供智能AI查询", "修复地图气泡「分享」按钮 script error（APP.shareBuilding 未导出，即用户报「点详细→运行错误」根因）；古建筛选多命中改绿色虚线最小包围圆", "新增「信息与帮助→错误日志」：全局错误捕获（onerror/unhandledrejection 环形缓冲300条）可查看/复制/清空，便于反馈排查",     "公开版策略落地：双通道构建——公开版（脱敏拟真数据「清源灌区」+ 公开通道）/ 内部版（完整数据 + 内部通道），升级通道隔离互不交叉；公开版智能AI装后即用（大模型接口内置）", 
    "筛选多命中圈选三端统一：绿色虚线最小包围圆（Ritter 算法，刚好圈住+视野刚好完整显示），单命中直接定位", 
"长按菜单收藏补振动反馈（navigator.vibrate）"]],
    ["v2.4.1", "2026-08-30", ["筛选菜单：关键词历史区块上移到管理所上方（与查询词上下衔接更顺）", "\u5feb\u6377\u5e38\u7528 vs \u539f\u5b50\u83dc\u5355\u89c6\u89c9\u533a\u5206\uff1a\u2b50\u524d\u7f00 + \u91d1\u8fb9\u5de6 border + \u6d45\u91d1\u5fae\u67d3\u8272\u80cc\u666f\uff08\u7528\u6237\u4e00\u773c\u80fd\u5206\u8fa8\u300c\u5feb\u6377\u5e38\u7528\u300d\uff0c\u4e0d\u518d\u8bef\u4ee5\u4e3a\u662f\u6253\u5f00\u5b50\u83dc\u5355\uff09", "\u5468\u8fb9\u641c\u7d22\u5efa\u7b51\u7269\u7c7b\u578b\u4feebug\uff1a\u9009\u9879\u70b9\u51fb\u5207\u6362\u5b9e\u65f6\u663e\u793a\u300c\u5df2\u9009 N \u4e2a\u7c7b\u578b\u300d\u8ba1\u6570\u3001\u7a7a\u65f6\u5168\u9009\u751f\u6548\uff0c\u53bb\u9664\u4e0d\u54cd\u5e94\u611f", "\u673a\u6784\u9ed8\u8ba4\u7ba1\u7406\u6240\u652f\u6301\u591a\u4e2a\uff1a\u8bbe\u7f6e \u2192 \u673a\u6784\u5c42\u7ea7\u9ed8\u8ba4\u503c\uff0c\u539f\u300c\u9ed8\u8ba4\u6240\u300d\u6539\u4e3a\u591a\u9009 chips\uff08\u4e00\u952e\u591a\u9009\u591a\u4e2a\u9ed8\u8ba4\u6240\uff09\uff0c\u65b0\u589e\u5efa\u7b51\u7269\u9884\u586b\u7b2c 1 \u4e2a\uff1b\u5176\u4f59\u5c42\u7ea7\u5355\u503c", "\u7ba1\u7406\u6bb5\u9ed8\u8ba4\u7a7a + \u6bb5/\u6240\u4e24\u4e2a\u72ec\u7acb\u9009\u9879\uff1a\u6bb5\u5b57\u6bb5\u52a0\u300c\u53ef\u7559\u7a7a\u300d\u63d0\u793a\uff0c\u4e0b\u62c9\u4e0e\u6240\u5b57\u6bb5\u4e92\u4e0d\u7ed1\u5b9a\uff0c\u6bb5\u540d\u4e0d\u5fc5\u968f\u5de6\u6240\u540d", "zip \u540d\u79f0\u5f39\u6027\u5c42\u6b21\u5339\u914d\uff1amatchOrgScope \u4e0d\u518d\u56fa\u5b9a\u6309 office\u2192station\u2192section\u2192mgmt\u2192bureau \u987a\u5e8f\uff0c\u6539\u6309\u6700\u957f\u6700\u5177\u4f53\u7c7b\u522b\u4f18\u5148 + \u957f\u5ea6\u52a0\u6743\uff08\u5982 \u53f2\u5c71.zip \u2192 \u81ea\u52a8\u9501\u5b9a\u53f2\u5c71\u6240\uff1b\u4eac\u5bc6\u5f15\u6c34\u7ba1\u7406\u5904.zip \u2192 \u4f18\u5148\u5339\u914d\u7ba1\u7406\u5904\u4e0b\u5c5e\u5355\u4f4d\uff09", "AI \u667a\u80fd\u67e5\u8be2\u8f93\u5165\u6846\u793a\u4f8b+\u5360\u4f4d\u7b26\u66f4\u53cb\u597d\uff1apickRecord \u589e\u52a0\u300c\u8bd5\u8bd5\u641c\u300d5 \u679a\u6761\u76ee\u7684\u5feb\u6377 chip\uff08\u8d34\u8fd1\u9886\u57df\uff1a\u6c34\u5229/\u611f\u77e5/\u53e4\u5efa \u5404\u6709\u9886\u57df\u793a\u4f8b\uff09\uff0c\u4e0d\u518d\u7528\u5360\u4f4d\u7b26\u6697\u85cf\u771f\u5b9e\u6761\u76ee\u540d\uff08\u907f\u514d\u5728\u67e5\u8be2\u9762\u677f\u51fa\u73b0\u4e0e\u573a\u666f\u4e0d\u7b26\u7684\u67e5\u8be2\u4f8b\uff09", "\u611f\u77e5/\u53e4\u5efa\u540c\u6b65\u65b0\u589e\uff1a\u76f8\u540c ANR/perf \u4fee\u590d + \u5360\u4f4d\u7b26\u53cb\u597d\u5316 + pickRecord \u79cd\u5b50\u82af\u7247", "\u4e09\u7aef\u56db\u5e73\u53f0\u540c\u6b65\u66f4\u65b0\uff08Win/UOS/Android/PWA\uff09\uff0c\u65b0\u914d\u7f6e\u952e shuili_orgcfg_v2 \u5df2\u5305\u542b officeDefaults \u6570\u7ec4\u8fc1\u79fb"]],
    ["v2.4.0", "2026-08-28", ["\u7ec4\u7ec7\u4e94\u7ea7\u5316：建筑物组织层级扩为 局/管理处/所/站/段（默认：水利工程管理中心 / 京密引水管理处 / 水库所），添加建筑物表单、筛选、导入导出全链路同步；新配置键 shuili_orgcfg_v2 自动迁移旧数据", "设置新增三项管理：①机构层级与默认名称管理（增删改 局/管理处/所/站/段 + 默认值编辑，重命名级联同步到所有建筑物与「💾 保存并全量同步」按钮）②建筑物类型管理（数据派生类型改名级联/自定义类型可删/新增）③快捷常用设置", "导出文件名与文件夹层次可选项：导出照片支持文件名组合段（局/管理处/所/站/段/建筑物名，默认 所+名，`_` 连接）与文件夹层次组合段（默认 管理所/），安卓端多级目录导出原生支持；压缩包名按组合段命名", "zip 三级匹配导入：压缩包文件名 → zip 内文件夹 → 照片文件名；zip 名命中机构（所→站→段→管理处→局，如 史山.zip → 优先在史山所范围内匹配）后整包收窄匹配范围；安卓原生桥接 zip 文件名", "新增「快捷常用」主菜单：置于查询/筛选之下首位，右键/长按任意菜单项快速添加，或到设置勾选；原子菜单全部保留", "菜单调序：查询 筛选 快捷常用 地图与位置 数据管理 传输与共享 运行维护 智能AI 设置 信息帮助；「大模型 AI 设置」并入智能AI组、「关于/帮助」并入信息与帮助组（功能全保留）", "修复文件夹上下文管理所匹配 bug：DIMS.offices 为规范化名（温泉所），旧代码用 r.office 原文比对（温泉管理所）导致范围限定失效，改为规范化比对"]],
    ["v2.3.0", "2026-08-29", ["本地优先·AI 与知识库高度融合：智能查询答案自动标注来源——本地知识库命中标「📖 本地知识库已参考」，联网兜底标「🌐 联网」，离线纯本地标「📖 本地」；发行版预内置知识库骨架，首次启动离线即时导入，无网环境开箱即用", "新增「知识库查询」菜单：对话式检索本地知识库（不依赖联网 AI），命中片段按相关度排序展示", "AI 智能更新可人工把关：生成的简介与参数表在应用前可逐项编辑修正，改动高亮对比，确认后才写入", "管理所/管理站在线维护：筛选弹窗新增 ⚙️ 维护入口，支持增改删机构与站、改名全链路联动；「管理站」录入由手输改为下拉选择", "周边搜索按类型筛选：周边 N 米内可勾选建筑物类型，只看关心的类型", "导出文件名自定义：建筑物信息与照片导出均可自定义文件名（留空按机构命名）", "关键词历史：筛选弹窗收纳最近搜索关键词，点击即用、可清空", "修复筛选弹窗「照片」分组点击异常"]],
    ["v2.2.1", "2026-08-23", ["新增「退出当前页面」常驻按钮（约束5）：顶栏✕按钮调用 APP.back() 逐级关闭弹窗>抽屉>测距>列表，无物理返回键的 Win/统信/苹果端也能随时退出当前页面；并增强 back() 主页兜底（已在主页则点✕关闭抽屉/提示三击空白唤主菜单），与既有三击空白弹主菜单并存", "四端同步（2026-08-23）：将含 P5（运行维护/旅游打卡/智能分析）+ 退出按钮的最新前端同步至 Win11(exe·msi)、统信UOS龙芯(mips64el deb)、苹果PWA(静态源)；统信端纠正架构——龙芯3A4000为 mips64el，弃用此前误打的 amd64 deb，改用浏览器壳方案打 mips64el deb（Electron 无 mips 二进制），功能与其余端一致且离线可用", "四端功能对照表产出（约束3）：逐能力列出安卓/Win/统信/苹果差异，不强行一致"]],
    ["v2.2", "2026-08-21", ["照片导出「没有可导出照片」根因修复：UOS/Web/PWA/Win 上报此错的根因是导入未成功（照片数据从未落库），不再是代码路径缺漏；0 照片时弹出可操作指引，指向「从安卓复制照片」目录流式导入 / 批量导入照片 / 从安卓平台导出照片，杜绝只报一句「没有照片」", "导出照片覆盖提示（问题③之三）：本地文件夹导出（安卓 exportFilesToTree）在目标文件夹已有同名照片文件时，先弹「目标文件夹已有同名照片 → 覆盖导出 / 取消」，不再静默覆盖", "删除 6 张孤立内置样张（images/pic_20260609_*.jpg）：这些图未嵌入任何记录、在安卓端显示×且其他平台无法显示，已清理避免误导", "四平台能力复核：逐模块核对安卓/苹果PWA/统信UOS/Win11 功能一致性，确认收藏窗口、从安卓复制照片、照片目录说明、四端功能对照单等在四端均可用；安卓能做的功能其余平台均可做（目录流式导入兜底 UOS 8G 内存）", "清理临时编译产物：images/ 下不再残留无关文件，APK 打包同步排除"]],
    ["v2.01", "2026-08-21", ["服务端口统一：局域网互传服务端口由 8888 改为 7205（app.js 输入框默认值与 JS 兜底同步，原生 Android `startLanServerNow` 同步 7205，测试脚本端口同步），解决多端/历史端口不一致", "添加建筑物改为「坐标优先」两步式：第 1 步先引导获取坐标（我的位置 / 地图点选 / 搜索已有建筑物 / 手填经纬度），坐标到位后才进入第 2 步填写建筑信息（表单预填经纬度、保留表单内重选坐标），从源头杜绝经纬度漏填导致的标记落不了图", "模块逐一审查与完善：冒烟回归脚本修正过期 CSS 颜色断言（--bg 实际 #1a456f），使测试诚实可复跑；四端功能对照单新增 v2.01 条目"]],
    ["v2.0", "2026-08-21", ["新增地图控件：放大/缩小/收藏当前位置/返回收藏位置（右侧悬浮按钮组，收藏持久化）", "修复 zip 照片导入卡死：改用中央目录定位解析 zip（正确处理目录条目/data descriptor/多层目录/UTF-8 文件名），解压加超时保护，老浏览器无 DecompressionStream 时明确报错降级（不再「一直处理一个文件」不动）", "支持 zip 内多层目录：解压用完整相对路径，文件夹上下文逐层匹配管理所/类型", "管理所名称统一：导入/导出/查询/筛选全链路去「管理」两字（温泉管理所→温泉所、埝头管理所→埝头所）；潮河管理所/潮河总干渠管理所→潮河所；查询筛选时「管理」可忽略（史山所=史山管理所）；站为所的下一级单位保持独立字段", "标记颜色/形状自定义 + 左下角图例（既有能力复核）；四端功能对照单（既有）"]],
    ["v1.99", "2026-08-13", ["运行稳定性修复（2026-08-20 下午）：修复地图初始化运行时错误「layerGroup.getBounds is not a function」——`L.layerGroup` 没有 `getBounds` 方法，改用 `L.featureGroup`（继承 layerGroup 且自带 getBounds），`fitToShown` 恢复正常缩放到数据范围；该错误只在浏览器/真机运行时暴露，静态核验发现不了，已加防回归检查", "界面与导入优化（2026-08-20）：①修复「四端功能对照单」点击空白——渲染函数定义在独立脚本、作用域内取不到 openModal 报错，已移入 app.js 与帮助/关于同作用域；②修复信息弹窗浅字白底看不清——Leaflet 弹窗改为应用深色主题、参数键亮蓝加粗，举一反三统一弹窗/标签/图例配色；③新增建筑物标记自定义颜色/形状（水滴/方/圆/三角 8 色）+ 左下角图例示例；④移除重复底图入口（顶栏🚫按钮与菜单「底图开关」，保留「图源切换」）；⑤导入时同名建筑物提示「覆盖同名/跳过同名/取消」（文件级去重原有保留）；⑥统信端不再生成绿色版 tar.gz（仅 deb）", "桌面版回灌增强（2026-08-19）：奥维导入时 Folder 名含「段--类型」自动补全 btype/type（如 西田各庄段--进水闸 → station=西田各庄段、btype=进水闸、type=西田各庄段--进水闸），三端（Android/桌面）解析结果一致", "真机三次修复（2026-08-18 下午）：导入 ovkmz 报「IO.sha256Hex is not a function」根治——io.js 定义了 sha256Hex 但导出表漏列（v1.8.0 后重构丢失），doImport 内容去重步骤一调即崩；已补导出 + 加 sha256: {hex} 兼容别名，并交叉核对 app.js 全部 31 个 IO.* 调用与导出表仅此一处缺口；真实文件 harness 扩至 16/16（含去重哈希断言）", "真机二次修复（2026-08-18 下午）：导入「点了没反应」根治——原生 onShowFileChooser 弃用 params.createIntent()（Chromium 按 accept 解析生成的 ACTION_GET_CONTENT + EXTRA_MIME_TYPES 会把 .ovkmz/.7z 等无 MIME 映射扩展名混入非法列表 → 部分机型系统选择器空白/打不开），改统一 ACTION_OPEN_DOCUMENT + */*：系统 DocumentsUI 必然可打开、全部文件可见可选，格式由前端扩展名校验（ovkmz/kmz/zip/7z/csv/xls/xlsx/kml 全覆盖）；JS pickFiles 增加 2.5s 非静默失败看门狗（选择器确未弹出时 toast 引导，杜绝「点了没反应」静默失败）", "真机复核修复（2026-08-18）：①导入 ovkmz 选不了文件——Android 系统选择器按 MIME 过滤，.ovkmz 无 MIME 映射被隐藏；文件选择 accept 改为「扩展名+MIME+*/*」兜底，全部文件可选、格式由导入端校验；②照片 zip 导入同样修复 .zip/.7z 无法选择问题（.7z 无标准 MIME 映射）；③奥维 ovkmz 真实结构兼容——实测 D 盘《水利工程基础信息.ovkmz》（557 个建筑物 + ovatta/ 照片）：OvAttaItem 照片路径在元素文本内容（非 Url/FileName 属性）现可解析、description「键 : 值|」参数现可导入、Folder 层级映射为管理所/管理站；导出改为奥维原生 OvAttr/OvAttaList/OvAttaItem 文本路径结构 + OvCoordType=CGCS2000，导出文件既被本 APP 识别也可导入奥维，往返一致", "核心 Bug 修复：击穿导入「点击 csv 等无反应」——根因是 WebView 下局部 input 无引用被 GC，onchange 永不触发；改为统一 pickFiles 持有引用并挂 DOM，8 个导入入口（单文件/文件夹/多选/zip×2/网盘备份）全部修复，Node 实跑验证导入链路畅通", "奥维格式互通加固：kmz/ovkmz 导入现兼容奥维真实导出结构——解析 OvAttaItem/Attachment 的 Url、description 中 img src，照片按「全路径 > files/ 前缀 > basename 兜底」三重解析取回，不再依赖本 APP 专属命名；本 APP 导出（含附件照片）仍可被奥维识别导入，往返一致", "筛选后导出默认导出筛选集（既有），并在导出弹窗顶部新增「当前导出范围」醒目提示条，明确是筛选结果还是全部建筑物", "全局「执行中，请稍后」遮罩补全到导出打包路径（含照片 kmz/ovkmz 打包较慢时显式提示）；导入/批量导入/照片导出/网盘等路径均已覆盖", "查询/筛选置顶与结果可视化保持：筛选实时命中计数（建筑物数+照片数）、蓝色虚线圆圈圈选并居中、单点跳转/无结果提示；智能匹配默认勾选最可能对并支持便捷确认；三击空白弹主菜单、每页退出按钮、灯箱放大等既有能力复核无回归"]],
    ["v1.9.9", "2026-08-17", ["修复建筑物导入/导出（bug①）：新增 xls / xlsx 格式支持，与 csv / kmz / kml 并列；导出统一属性表（名称/管理所/管理站/建筑物类型/经纬度/自定义参数/说明），导入端 superset 解析器兼容旧奥维/潮河字段与 BIFF8 旧版 Excel（旧格式明确拒绝并提示），导出文件可原样再导入（往返一致，Node 实证 92 项全 PASS）", "修复照片导入/导出 zip（bug②）：导出压缩包内嵌 manifest.json（文件名→建筑物 id 映射），重新导入时确定性自动绑定、零人工确认；无 manifest 的旧包仍走智能模糊匹配兜底，无回归", "修复批量导入 xlsx 静默失败（bug③）：文件夹/多选/zip 三条批量通道此前都把 xlsx 当纯文本喂给 CSV 解析器（zip 通道更是固定传空串），结果「解析 0 条、界面无任何报错」；改为 xlsx 走字节流解析、xls 走 BIFF 检测解析、未知扩展名显式抛错、读取失败也提示并推进计数（不再卡住导入状态）", "修复导出列勾选失效 + 文件名错位（bug③）：IO.exportCsv/exportChaoheFile 签名为 (records, root, cols)，调用侧误按 (records, cols) 传参，导致导出文件名变成「name,管理所,…」列名串、用户勾选的导出列被完全忽略；现按正确位置传参", "修复导入文件选择器挡掉 Excel（bug④）：单文件导入入口 accept 补 .xls/.xlsx，此前用户在系统选择器里根本看不到这两类文件", "查询/筛选置顶、实时命中计数、蓝色虚线圆圈圈选、单/多/无结果跳转、退出按钮/三击空白进主菜单、智能匹配确认、长操作「执行中，请稍后」遮罩等既有能力逐模块复核，确认无回归"]],
    ["v1.9.7", "2026-08-17", ["彻底修复导出>30张照片 0 字节：原生 exportCommit 改为 ByteArrayOutputStream 分片增量 Base64 解码（消除整包巨型 String 一次性 decode 的 OOM/静默空写），JS 侧补 `zipBytes.length<=22` 空包拦截；三套 APP 真编译验证", "修复导入照片丢失：importKmzBuffer 照片查表前缀不匹配（`files[fn]` vs `files['files/'+fn]`），改 fallback 取回，Node 实证取回 0→1 张", "导入过程新增「正在解析导入文件，请稍后…」全屏遮罩（busy）", "新增建筑物详情「分享」按钮：该建筑物照片+信息打包 zip 走系统分享面板，可选微信/QQ/飞书等", "灯箱照片支持「放大」：双击/双指捏合 + 拖拽平移，按钮一键还原", "筛选默认导出筛选结果、KMZ/奥维互通、菜单调浅、查询/筛选置顶、蓝圈跳转、退出/三击主菜单、智能匹配等既有能力保持；shipin/gujian 同步"]],
    ["v1.9.6", "2026-08-16", ["紧急修复「导出照片压缩包 0 字节」：根因①zip 中文文件名未置 UTF-8 标志位（local+central 双置位），部分解压工具按 CP437 解析→文件名乱码、照片「看不见」；②整包 base64 经 JSInterface 单次传给原生，超 Binder 1MB 事务上限→写入 0 字节。改为分块导出（exportStart/Append/Commit，每片≤512KB）+ zip UTF-8 标志 + 原生写盘后回调 APP.onExportResult 才提示成功（杜绝「假成功」）。已 Node 实证 UTF-8 文件名正确、压缩包非空", "新增「执行中，请稍后」全屏遮罩（busy）：导出照片时显式提示，避免等候误以为卡死", "菜单/抽屉/弹窗面板色（--panel）再调浅一档（#1d4a7a→#2a6098），缓解「菜单背景偏深」；筛选弹窗新增「当前查询关键词」提示区", "筛选实时计数、蓝色虚线圆圈圈选、单/多/无结果跳转、查询/筛选置顶、退出按钮/三击主菜单、智能匹配确认等既有能力保持不变"]],
    ["v1.9.5", "2026-08-16", ["照片压缩包崩溃根因彻底修复：崩溃不是「照片太大」，而是①主线程同步解压数 GB 压缩包阻塞 UI ②全分辨率图 base64 撑爆 WebView OOM ③临时目录从不清理。改为原生线程池异步解压 + 流式写盘 + 原生缩略图（RGB_565 ≤720px JPEG q72）+ 内容哈希，JS 仅收齐轻量元数据再匹配；全图仅在灯箱/保存/导出时按需单张加载", "新增原生持久化（persistImage）与按需加载（loadFullImage）桥接：导入完成自动把全图从临时目录迁入 app 私有 photos 目录，清理缓存不会误删已绑定照片", "新增「清理导入缓存」菜单：在导入完成 / App 启动 / 菜单手动三处调用，删除 inbox/uz_* 临时目录，杜绝残留累积", "导入匹配分块（每批 30 张 + 让出主线程）+ 弹窗照片封顶 18 张，超大批量不再卡死", "筛选实时计数、查询/筛选置顶、退出按钮/三击主菜单、智能匹配确认等既有能力保持不变"]],
    ["v1.9.4", "2026-08-16", ["照片压缩包导入防崩：新增体积预检（>1.2GB 直接拒绝并引导分卷；>300MB 二次确认），改为流式解压（逐张释放内存）+ 进度提示 + 让出主线程，彻底解决 1.7G 压缩包导致 APP 崩溃/死机", "修复 Leaflet 版权署名外链（https://leafletjs.com）在离线/弱网下点击超时的报错：去掉地图外部署名链接，仅保留本地资源", "筛选实时计数升级：提示区同时显示命中「建筑物数 + 照片张数」，随条件变化实时刷新", "既有功能与菜单（查询/筛选置顶、单选改名、版本变更、删除照片/建筑物等）保持不变，仅智能优化"]],
    ["v1.9.3", "2026-08-16", ["照片导入绑定修复：杜绝“手动匹配照片未绑上”的静默丢失——无名称匹配的照片也进入人工选择", "人工选择改为单选（每张照片只属一个建筑物），默认勾选最可能对，可改或跳过", "确认后照片 caption 统一改为「建筑物名+照片+序号」，建筑物稳定读到", "新增「版本变更」菜单；「关于」版本号改用全局单一来源，避免漂移", "新增「删除照片 / 删除建筑物」按管理所/时间条件批量删除（删除前提示不可恢复）", "筛选新增「照片」维度：有照片 / 无照片 / 至少 N 张"]],
    ["v1.9.2", "2026-08-15", ["批量导入弹窗来源图标方块化醒目", "修复 zip 压缩包导入兜底错接（mode=zip 真正调用 webkitZipPhotos）"]],
    ["v1.9.1", "2026-08-15", ["菜单图标方块化醒目 + 筛选图标与查询区分(🎛️)", "筛选实时命中计数 + 蓝色虚线圆圈圈出全部命中并居中", "批量导入支持 zip/7z + 百度/夸克网盘", "导出照片 zip/7z 按管理所命名 + 本地/网盘/分享微信·飞书·QQ"]],
    ["v1.9.0", "2026-08-14", ["菜单折叠分组 + 智能模糊匹配（错字/多字/漏字/部分词）+ 文件夹上下文", "查询/筛选置顶；筛选 0→提示、1→飞到、多→圈出居中", "照片大图浏览/删除/顺序调整"]],
    ["v1.8.0", "2026-08-12", ["照片匹配优化（文件名↔建筑物名智能对应）"]]
  ];
  function changelog() {
    const html = CHANGELOG.map(([v, d, items]) => `<div class="cl-block">
      <div class="cl-ver">${esc(v)} <span class="cl-date">${esc(d)}</span></div>
      <ul class="cl-list">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>`).join("");
    openModal("版本变更（" + APP_VER + "）", `<div class="filelist" style="max-height:60vh;overflow:auto">${html}</div>`, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
  }
  // 四端功能对照单（数据在 platform_matrix.js：PLAT_FEATURES / PLAT_DIFF，由 gen_feature_matrix.py 生成）
  // 注意：必须定义在 IIFE 内才能访问局部 openModal/esc；早期版本全局定义导致点击时 ReferenceError（空白）
  function platMatrix() {
    const SYM = { full: "✅", partial: "⚠️", none: "❌" };
    const COLS = [["android", "安卓 APK"], ["ios", "苹果 PWA"], ["uos", "统信 UOS"], ["win", "Win11"]];
    const FEATURES = (typeof PLAT_FEATURES !== "undefined") ? PLAT_FEATURES : [];
    const DIFF = (typeof PLAT_DIFF !== "undefined") ? PLAT_DIFF : [];
    if (!FEATURES.length) return toast("四端功能对照单数据未加载（platform_matrix.js 缺失）");
    let html = '<div class="hint">✅ 完整　⚠️ 受限(接入方式不同)　❌ 无</div>';
    html += '<div style="max-height:56vh;overflow:auto;margin-top:6px">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
    html += '<thead><tr style="position:sticky;top:0;background:var(--panel2,#2a6098);color:#fff">'
      + '<th style="padding:6px 4px;text-align:left">功能</th>'
      + COLS.map((c) => '<th style="padding:6px 4px">' + c[1] + '</th>').join("") + '</tr></thead><tbody>';
    let curGroup = "";
    for (const r of FEATURES) {
      if (r.g !== curGroup) { curGroup = r.g; html += '<tr><td colspan="5" style="padding:6px 4px;background:var(--accent,#1d4a7a);color:#fff;font-weight:700">' + esc(curGroup) + '</td></tr>'; }
      html += '<tr style="border-bottom:1px solid var(--line)">';
      html += '<td style="padding:5px 4px;vertical-align:top"><div>' + esc(r.f) + '</div>'
        + (r.note ? '<div style="color:var(--muted);font-size:11px;margin-top:2px">' + esc(r.note) + '</div>' : '') + '</td>';
      for (const c of COLS) html += '<td style="padding:5px 4px;text-align:center">' + (SYM[r[c[0]]] || "—") + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="env-title" style="margin-top:12px">各版本四端功能差异</div>';
    html += '<div class="filelist" style="max-height:30vh;overflow:auto">';
    for (const e of DIFF) {
      html += '<div class="cl-block"><div class="cl-ver">' + esc(e.v) + ' <span class="cl-date">' + esc(e.d) + '</span></div>'
        + '<ul class="cl-list">' + e.items.map((t) => '<li>' + esc(t) + '</li>').join("") + '</ul></div>';
    }
    html += '</div>';
    openModal("四端功能对照单（" + APP_VER + "）", html, '<button class="btn ghost" onclick="APP.close()">关闭</button>');
  }
  // 条件选择弹窗（管理所 / 时间 + 列表勾选 + 全选/取消/确认），供删除照片、删除建筑物复用
  function conditionPicker(cfg) {
    const html = `<div class="hint">${cfg.hint}</div>
      <div class="field"><label>按管理所（可多选，不选 = 全部）</label><div class="chips" id="cpOff">${DIMS.offices.map((o) => `<span class="chip" data-off="${esc(o)}">${esc(o)}</span>`).join("") || '<span class="hint">无管理所</span>'}</div></div>
      <div class="field"><label>按时间（导入/修改日期，留空 = 不限）</label><div style="display:flex;gap:8px"><input type="date" id="cpFrom" style="flex:1"><span style="align-self:center">至</span><input type="date" id="cpTo" style="flex:1"></div></div>
      <div class="field"><label>待处理项（勾选后删除）</label><div class="filelist" id="cpList" style="max-height:42vh;overflow:auto"></div></div>
      <div class="hint" id="cpCount" style="margin-top:4px">已选 0 项</div>`;
    openModal(cfg.title, html, `<button class="btn ghost" id="cpAll">全选</button><button class="btn ghost" id="cpClear">取消选择</button><button class="btn ghost" id="cpExit">退出</button><button class="btn ${cfg.danger ? "danger" : "primary"}" id="cpOk">${cfg.confirmLabel || "确认"}</button>`);
    const body = el("modalBody");
    const matchSet = new Set(), selSet = new Set();
    const cntText = () => "已选 " + [...selSet].filter((id) => matchSet.has(id)).length + " 项";
    const refresh = () => {
      const offs = [...body.querySelectorAll("#cpOff .chip.on")].map((c) => c.dataset.off);
      const from = el("cpFrom").value, to = el("cpTo").value;
      const fromT = from ? new Date(from + "T00:00:00").getTime() : null;
      const toT = to ? new Date(to + "T23:59:59").getTime() : null;
      matchSet.clear();
      const list = body.querySelector("#cpList"); list.innerHTML = "";
      const rows = cfg.items.filter((it) => {
        if (offs.length && !offs.includes(it.office)) return false;
        if (fromT != null || toT != null) {
          const t = it.ts ? new Date(it.ts).getTime() : NaN;
          if (isNaN(t)) return false; // 开启了时间条件但记录无时间，则排除
          if (fromT != null && t < fromT) return false;
          if (toT != null && t > toT) return false;
        }
        return true;
      });
      if (!rows.length) { list.innerHTML = `<div class="hint">当前条件下没有可处理项。</div>`; el("cpCount").textContent = cntText(); return; }
      rows.forEach((it) => {
        matchSet.add(it.id);
        const checked = selSet.has(it.id) ? "checked" : "";
        const div = document.createElement("label");
        div.className = "ex-item";
        div.innerHTML = `<input type="checkbox" class="cp-cb" data-id="${esc(it.id)}" ${checked}><span>${esc(it.label)}${it.sub ? ` <em class="sc">${esc(it.sub)}</em>` : ""}</span>`;
        list.appendChild(div);
      });
      body.querySelectorAll(".cp-cb").forEach((cb) => cb.onchange = () => {
        if (cb.checked) selSet.add(cb.dataset.id); else selSet.delete(cb.dataset.id);
        el("cpCount").textContent = cntText();
      });
      el("cpCount").textContent = cntText();
    };
    body.querySelectorAll("#cpOff .chip").forEach((c) => c.onclick = () => { c.classList.toggle("on"); refresh(); });
    el("cpFrom").onchange = refresh; el("cpTo").onchange = refresh;
    el("cpAll").onclick = () => { body.querySelectorAll(".cp-cb").forEach((cb) => { cb.checked = true; selSet.add(cb.dataset.id); }); el("cpCount").textContent = cntText(); };
    el("cpClear").onclick = () => { body.querySelectorAll(".cp-cb").forEach((cb) => { cb.checked = false; }); selSet.clear(); el("cpCount").textContent = "已选 0 项"; };
    el("cpExit").onclick = closeModal;
    el("cpOk").onclick = () => {
      const ids = [...selSet].filter((id) => matchSet.has(id));
      if (!ids.length) { toast("请先勾选要处理的项目"); return; }
      closeModal(); cfg.onConfirm(ids);
    };
    refresh();
  }
  // 删除照片：按管理所/时间筛选，勾选后从对应建筑物移除
  function delPhotos() {
    const items = [];
    records.forEach((r) => (r.photos || []).forEach((p, i) => {
      items.push({ id: r.id + "::" + i, label: (r.name || "建筑物") + " · " + (p.caption || ("照片" + (i + 1))), sub: r.office || "", office: r.office || "", ts: r.ts });
    }));
    if (!items.length) { toast("当前没有照片可删除"); return; }
    conditionPicker({
      title: "删除照片",
      hint: "按管理所 / 时间筛选后，勾选要删除的照片（可全选/取消），确认即从对应建筑物移除。",
      items, confirmLabel: "删除选中照片", danger: true,
      onConfirm: async (ids) => {
        const idxMap = {};
        ids.forEach((id) => { const [rid, pi] = id.split("::"); (idxMap[rid] = idxMap[rid] || new Set()).add(parseInt(pi, 10)); });
        await Store.patch((d) => {
          d.added = d.added || []; d.updated = d.updated || {};
          for (const rid in idxMap) {
            const exist = d.added.find((a) => a.id === rid);
            const upd = d.updated[rid];
            const base = records.find((x) => x.id === rid) || {};
            const cur = (exist || upd || base).photos || [];
            const kept = cur.filter((_, i) => !idxMap[rid].has(i));
            if (exist) { const i = d.added.findIndex((a) => a.id === rid); d.added[i] = Object.assign({}, d.added[i], { photos: kept }); }
            else d.updated[rid] = Object.assign({}, base, upd || {}, { photos: kept });
          }
        });
        DELTA = await Store.get(); merge(); render();
        toast("已删除 " + ids.length + " 张照片");
      }
    });
  }
  // 删除建筑物：按管理所/时间筛选，勾选后永久删除（删除前提示不可恢复）
  function delBuildings() {
    const items = records.map((r) => ({ id: r.id, label: r.name || "(无名)", sub: r.office || "", office: r.office || "", ts: r.ts }));
    if (!items.length) { toast("当前没有建筑物可删除"); return; }
    conditionPicker({
      title: "删除建筑物",
      hint: "按管理所 / 时间筛选后，勾选要删除的建筑物（可全选/取消），确认后将从本机永久删除。",
      items, confirmLabel: "删除选中建筑物", danger: true,
      onConfirm: (ids) => {
        const n = ids.length;
        openModal("确认删除", `<div class="hint" style="color:var(--danger)">⚠️ 即将删除 <b>${n}</b> 个建筑物，删除后数据<b>不可恢复</b>。确定继续吗？</div>`,
          `<button class="btn ghost" id="dbCancel">再想想</button><button class="btn danger" id="dbOk">确认删除（不可恢复）</button>`);
        el("dbCancel").onclick = closeModal;
        el("dbOk").onclick = async () => {
          closeModal();
          await Store.patch((d) => {
            d.added = d.added || []; d.updated = d.updated || {};
            for (const id of ids) {
              const i = d.added.findIndex((a) => a.id === id);
              if (i >= 0) d.added.splice(i, 1);
              else { d.deleted = d.deleted || []; if (!d.deleted.includes(id)) d.deleted.push(id); delete d.updated[id]; }
            }
          });
          DELTA = await Store.get(); merge(); render();
          toast("已删除 " + n + " 个建筑物");
        };
      }
    });
  }
  function about() {
    const env = getEnvInfo();
    const row = (k, v) => `<div class="env-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`;
    // 建议使用环境：用户运行本应用所推荐的环境（静态指导）
    const rec = [
      ["操作系统", "安卓 8.0+ / iOS 14+ / Windows 10·11 / macOS"],
      ["浏览器", "Chrome / Edge / Safari 最新版（桌面与手机均可）"],
      ["网络", "底图与在线功能需联网；离线可浏览已载入数据"],
      ["权限", "建议授予「定位」与「文件/存储」权限（导出/导入、定位所需）"],
      ["屏幕", "建议 ≥ 5 英寸；竖屏/横屏自适应"]
    ];
    const html = `<div style="text-align:center;padding:6px 4px 10px">
      <div style="font-size:46px">📐</div>
      <h3 style="margin:8px 0">水利工程一张图</h3>
      <p class="hint">奥维采集数据 → 天地图一张图<br>支持浏览 / 筛选 / 增删改 / 多照片 / ovkmz 导入导出</p>
      <p style="margin-top:14px;color:var(--accent);font-weight:700">制作：科技推广中心</p>
      <p class="hint" style="margin-top:4px">版本 ${APP_VER}</p>
    </div>
    <div class="env-box">
      <div class="env-title">建议使用环境</div>
      ${rec.map(([k, v]) => row(k, v)).join("")}
    </div>
    <div class="env-box">
      <div class="env-title">制作环境（本机运行环境）</div>
      ${row("操作系统", env.os + (env.osVer ? " " + env.osVer : ""))}
      ${row("设备型号", env.device)}
      ${row("运行环境", env.engine)}
      ${row("CPU", env.cpu)}
      ${row("内存", env.mem)}
      ${row("GPU", env.gpu)}
      ${row("屏幕", env.screen)}
    </div>`;
    openModal("关于", html, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
  }

  // ---------- 获取经纬度（我的位置 / 地图点选 / 搜索）----------
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
    } else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }
  function getCoord() {
    const html = `
      <div class="field"><label>经纬度（WGS84 十进制）</label>
        <div class="coord-display">
          <div class="cd-row"><span class="cd-k">纬度 Lat</span><span class="cd-v" id="cdLat">—</span></div>
          <div class="cd-row"><span class="cd-k">经度 Lng</span><span class="cd-v" id="cdLon">—</span></div>
        </div>
      </div>
      <div class="coord-actions">
        <button class="btn ghost" id="cdMe">📍 我的位置</button>
        <button class="btn ghost" id="cdPick">🗺 地图点选</button>
        <button class="btn ghost" id="cdCopy">📋 复制</button>
      </div>
      <div class="field" style="margin-top:14px"><label>搜索建筑物获取其坐标</label>
        <input id="cdSearch" placeholder="输入名称…" autocomplete="off">
        <div class="cd-results" id="cdResults"></div>
      </div>
      <div class="hint">我的位置需授权定位；地图点选请关闭本弹窗后在地图上点击；复制格式为「纬度, 经度」。</div>`;
    openModal("获取经纬度", html, `<button class="btn ghost" onclick="APP.close()">关闭</button>`);
    const cur = coordResult ? { lat: coordResult.lat, lon: coordResult.lon } : { lat: null, lon: null };
    coordResult = null;
    const setDisp = () => {
      el("cdLat").textContent = cur.lat != null ? cur.lat.toFixed(6) : "—";
      el("cdLon").textContent = cur.lon != null ? cur.lon.toFixed(6) : "—";
    };
    setDisp();
    el("cdMe").onclick = () => {
      if (!navigator.geolocation) return toast("当前环境不支持定位");
      toast("正在定位…");
      navigator.geolocation.getCurrentPosition((p) => {
        cur.lat = p.coords.latitude; cur.lon = p.coords.longitude; setDisp();
        if (myLocMarker) map.removeLayer(myLocMarker);
        myLocMarker = L.circleMarker([cur.lat, cur.lon], { radius: 9, color: "#2ecc8f", fillColor: "#2ecc8f", fillOpacity: .65, weight: 3 }).addTo(map).bindPopup("我的位置").openPopup();
        map.setView([cur.lat, cur.lon], 15);
        toast("已获取我的位置坐标");
      }, (err) => {
        if (window.AndroidBridge && window.AndroidBridge.openLocationSettings) window.AndroidBridge.openLocationSettings();
        else toast("定位失败，请检查定位权限");
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    };
    el("cdPick").onclick = () => {
      closeModal(); pickForCoord = true; togglePick(true);
      toast("请在地图上点选位置（再次点此取消）");
    };
    el("cdCopy").onclick = () => {
      if (cur.lat == null) return toast("请先获取坐标");
      const t = `${cur.lat.toFixed(6)}, ${cur.lon.toFixed(6)}`;
      copyText(t); toast("已复制：" + t);
    };
    el("cdSearch").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      const box = el("cdResults");
      if (!q) { box.innerHTML = ""; return; }
      const rs = records.filter((r) => `${r.name}${r.office}${r.station}`.toLowerCase().includes(q)).slice(0, 30);
      box.innerHTML = rs.map((r) =>
        `<div class="cd-item" data-id="${r.id}"><span>${esc(r.name)}</span><span class="cd-xy">${(+r.lat).toFixed(5)} , ${(+r.lon).toFixed(5)}</span></div>`).join("");
      box.querySelectorAll(".cd-item").forEach((it) => it.onclick = () => {
        const rr = records.find((x) => x.id === it.dataset.id); if (!rr) return;
        cur.lat = +rr.lat; cur.lon = +rr.lon; setDisp();
        map.flyTo([cur.lat, cur.lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
        toast("已定位：" + rr.name);
      });
    });
  }

  // ---------- 照片大图（长按保存 + 多图切换，item ⑧）----------
  let lbRid = null, lbPi = 0;
  // 按需加载照片：有全图磁盘路径则原生单张加载全图，否则回退到 dataUrl（旧数据/Web）
  function loadPhotoFull(ph) {
    return new Promise((resolve) => {
      if (ph && ph.fullPath && window.AndroidBridge && window.AndroidBridge.loadFullImage) {
        try { const full = window.AndroidBridge.loadFullImage(ph.fullPath); if (full && full.startsWith("data:")) return resolve(full); } catch (e) {}
      }
      resolve(ph ? (ph.full || ph.dataUrl || "") : "");
    });
  }
  // 历史重建：扫现有 records，对缺 thumb/full 的照片用原图补生成（方案2 历史数据补丁，不覆盖原图）
  async function rebuildPhotoThumbs() {
    const todo = [];
    for (const r of records) for (const p of (r.photos || [])) if (p.dataUrl && (!p.thumb || !p.full)) todo.push({ r, p });
    if (!todo.length) { toast("无需重建（照片均已含缩略图）"); return; }
    openModal("重建照片缩略图", `<div class="hint">将对 ${todo.length} 张历史照片生成缩略图并压缩原图（<1MB），不覆盖原始数据。</div><div class="hint" id="rbProg">0 / ${todo.length}</div><div class="bar"><div class="bar-fill" id="rbBar" style="width:0%"></div></div>`, `<button class="btn ghost" id="rbCancel">取消</button>`);
    const prog = el("rbProg"), bar = el("rbBar"); let cancelled = false;
    el("rbCancel").onclick = () => { cancelled = true; closeModal(); toast("已取消重建"); };
    const updates = {};
    for (let i = 0; i < todo.length; i++) {
      if (cancelled) break;
      const { r, p } = todo[i];
      try { const cp = await ImgUtil.compressPhoto(p.dataUrl); p.thumb = cp.thumb; p.full = cp.full; if (!p.hash) p.hash = cp.hash; } catch (e) {}
      updates[r.id] = r; // 写回整个 rec（含更新后的 photos）
      if ((i & 15) === 0 || i === todo.length - 1) {
        prog.textContent = `${i + 1} / ${todo.length}`;
        bar.style.width = Math.round((i + 1) / todo.length * 100) + "%";
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程，避免卡死
      }
    }
    if (!cancelled && Object.keys(updates).length) {
      await Store.patch((d) => { d.updated = d.updated || {}; for (const id in updates) d.updated[id] = updates[id]; });
      DELTA = await Store.get(); merge(); render();
    }
    if (!cancelled) closeModal();
    toast(`已重建 ${Object.keys(updates).length} 个建筑物的缩略图`);
  }
  async function openPhoto(rid, pi) {
    const r = records.find((x) => x.id === rid); if (!r || !r.photos[pi]) return;
    lbRid = rid; lbPi = pi;
    const ph = r.photos[pi];
    el("lbImg").src = await loadPhotoFull(ph);
    el("lbImg").style.transform = ""; // 复位上一张的放大状态
    el("lbCap").textContent = ph.caption || "";
    el("lightbox").classList.add("show");
    // 控制条（保存 / 切换）默认隐藏，长按图片后弹出
    el("lbBar").style.display = "none";
    el("lbPrev").style.display = "none";
    el("lbNext").style.display = "none";
    el("lbIdx").style.display = "none";
  }
  async function switchPhoto(d) {
    const r = records.find((x) => x.id === lbRid); if (!r) return;
    const n = (r.photos || []).length; if (n < 2) return;
    lbPi = (lbPi + d + n) % n;
    const ph = r.photos[lbPi];
    el("lbImg").src = await loadPhotoFull(ph);
    el("lbImg").style.transform = ""; // 复位放大状态
    el("lbCap").textContent = ph.caption || "";
    el("lbIdx").textContent = (lbPi + 1) + " / " + n;
  }
  async function saveCurrentPhoto() {
    const r = records.find((x) => x.id === lbRid); if (!r) return;
    const ph = r.photos[lbPi]; if (!ph) return;
    const src = await loadPhotoFull(ph);
    if (!src) return;
    const ext = (src.split(";")[0].split("/")[1] || "png").replace("+xml", "");
    const a = document.createElement("a");
    a.href = src;
    a.download = (ph.caption || r.name || "photo") + "." + ext;
    document.body.appendChild(a); a.click(); a.remove();
    toast("已保存图片到下载目录");
  }
  function bindLightbox() {
    const img = el("lbImg");
    let lpTimer = null;
    // ---------- 放大：双击/双指 + 拖拽平移 ----------
    let scale = 1, tx = 0, ty = 0;
    const applyT = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; img.style.transition = scale === 1 ? "transform .2s" : "none"; el("lbZoom").textContent = scale > 1 ? "还原" : "放大"; };
    const resetT = () => { scale = 1; tx = 0; ty = 0; applyT(); };
    const clampT = () => { const max = (scale - 1) * 220; tx = Math.max(-max, Math.min(max, tx)); ty = Math.max(-max, Math.min(max, ty)); };
    const toggleZoom = (cx, cy) => {
      if (scale > 1) { resetT(); return; }
      scale = 2.2; tx = 0; ty = 0; applyT();
    };
    let lastTouch = 0, startX = 0, startY = 0, pinned = false, pinch0 = 0, scale0 = 1;
    img.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        pinned = true; pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); scale0 = scale;
      } else if (e.touches.length === 1) {
        lastTouch = Date.now(); startX = e.touches[0].clientX - tx; startY = e.touches[0].clientY - ty;
      }
    }, { passive: true });
    img.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && pinned) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        scale = Math.max(1, Math.min(5, scale0 * (d / (pinch0 || d)))); clampT(); applyT();
      } else if (e.touches.length === 1 && scale > 1) {
        tx = e.touches[0].clientX - startX; ty = e.touches[0].clientY - startY; clampT(); applyT();
      }
    }, { passive: true });
    img.addEventListener("touchend", (e) => {
      if (e.changedTouches.length === 1) {
        const dt = Date.now() - lastTouch;
        if (dt < 300 && !pinned) { const t = e.changedTouches[0]; toggleZoom(t.clientX, t.clientY); }
      }
      if (e.touches.length < 2) pinned = false;
    });
    img.addEventListener("dblclick", (e) => { e.preventDefault(); toggleZoom(e.clientX, e.clientY); });
    el("lbZoom").onclick = () => toggleZoom();
    // 长按弹出控制条（保存/分享/切换）
    const startLP = () => { clearTimeout(lpTimer); lpTimer = setTimeout(() => {
      el("lbBar").style.display = "flex";
      const r = records.find((x) => x.id === lbRid);
      if (r && (r.photos || []).length > 1) {
        el("lbPrev").style.display = "flex"; el("lbNext").style.display = "flex"; el("lbIdx").style.display = "block";
        el("lbIdx").textContent = (lbPi + 1) + " / " + r.photos.length;
      }
    }, 500); };
    const cancelLP = () => { clearTimeout(lpTimer); };
    img.addEventListener("mousedown", startLP);
    img.addEventListener("mouseup", cancelLP);
    img.addEventListener("mouseleave", cancelLP);
    el("lbPrev").onclick = () => switchPhoto(-1);
    el("lbNext").onclick = () => switchPhoto(1);
    el("lbSave").onclick = saveCurrentPhoto;
    el("lbShare").onclick = () => { const r = lbRid; if (r) shareBuilding(r); };
    el("lbClose").onclick = () => { el("lightbox").classList.remove("show"); el("lbImg").src = ""; resetT(); };
  }

  // ---------- 事件绑定 ----------
  function bindUI() {
    // 版本变更菜单副标题随全局版本号同步（避免硬编码漂移）
    if (el("changelogSub")) el("changelogSub").textContent = "v1.8.0 → " + APP_VER;
    el("btnMenu").onclick = () => { el("drawer").classList.add("open"); el("mask").classList.add("show"); };
    el("btnExit").onclick = () => {
      const closed = APP.back();
      if (!closed) { toast("已是最外层页面 · 三击地图空白处可唤起主菜单"); }
    };

    el("fabMenu").onclick = () => { el("drawer").classList.add("open"); el("mask").classList.add("show"); };
    el("drawerClose").onclick = closeDrawer; el("mask").onclick = closeDrawer;
    el("listClose").onclick = () => el("listbar").classList.remove("open");
    el("btnList").onclick = () => el("listbar").classList.toggle("open");
    el("btnLayer").onclick = () => openBasemap();
    // 地图控件：放大/缩小/收藏位置/返回收藏
    el("mcZoomIn").onclick = () => map.zoomIn();
    el("mcZoomOut").onclick = () => map.zoomOut();
    el("mcFav").onclick = saveFavWindow;
    el("mcFavGo").onclick = goFavWindow;
    el("btnFilter").onclick = openFilter; // 顶栏筛选按钮（与查询并列置顶）
    el("modalClose").onclick = closeModal;
    el("modalMask").onclick = closeModal;
    el("fbClear").onclick = clearFilter; // 筛选状态条：一键清除
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") back(); });
    el("lbClose").onclick = () => { el("lightbox").classList.remove("show"); el("lbImg").src = ""; el("lbImg").style.transform = ""; };
    el("lightbox").onclick = (e) => { if (e.target.id === "lightbox") { el("lightbox").classList.remove("show"); el("lbImg").src = ""; el("lbImg").style.transform = ""; } };
    $("#search").addEventListener("input", (e) => { filter.q = e.target.value; if (filter.q.trim()) pushKwHist(filter.q); render(); });
    el("measureClear").onclick = () => {
      measurePts = [];
      if (measureLine) measureLine.setLatLngs([]);
      overlayGroup.eachLayer((l) => { if (l._mpt) overlayGroup.removeLayer(l); });
      el("measureInfo").textContent = "点击地图或建筑物添加测量点";
    };
    el("measureExit").onclick = exitMeasure;
    // 折叠分组：点分组标题或"＋"展开/收起二级菜单（默认隐藏）
    document.querySelectorAll(".mgroup.collapsible").forEach((g) => {
      g.onclick = () => {
        const sub = g.nextElementSibling;
        if (sub && sub.classList.contains("msub")) {
          const open = sub.classList.toggle("open");
          g.classList.toggle("open", open);
          g.querySelector(".tg").textContent = open ? "－" : "＋";
        }
      };
    });
    document.querySelectorAll(".menu-btn").forEach(bindMenuBtn); // v2.4：绑定提取为独立函数（快捷常用动态按钮复用）
    renderQuickFavs(); // v2.4：渲染快捷常用
    // 三击地图任意处 → 强制恢复主菜单（测距/选点模式不触发，避免误操）
    let _taps = 0, _tapT = 0;
    $("#map").addEventListener("click", () => {
      if (measureMode || pickMode) return;
      const now = Date.now();
      if (now - _tapT > 600) _taps = 0;
      _taps++; _tapT = now;
      if (_taps >= 3) { _taps = 0; tripleTapMenu(); }
    });
    bindLightbox();
  }
  // ---------- 菜单按钮统一绑定（v2.4 提取：静态菜单 + 快捷常用动态按钮共用）----------
  function bindMenuBtn(b) {
    b.onclick = () => {
      const act = b.dataset.act; closeDrawer();
      // 大模型 AI 领域配置（水利：内部建筑物台账，大模型上无公开数据）
      AI.domain = {
        appName: "水利工程一张图",
        internal: true,
        recName: (r) => r.name || "(未命名)",
        recMeta: (r) => [r.office, r.station, r.btype].filter(Boolean).join(" / "),
        recSearch: (r) => [r.name, r.type, r.office, r.station, r.btype].filter(Boolean).join(" "),
        // #7 智能问询：注入机构层级与统计，让大模型能回答"某管理处有几个管理所"等 org 级问题（即使无独立条目也可由分组得出）
        orgContext: (q) => {
          const byMgmt = {};
          records.forEach((r) => {
            const mg = orgVal(r, "mgmt") || "(未分配管理处)";
            const o = normOffice(orgVal(r, "office")) || "(未分配管理所)";
            const b = byMgmt[mg] || (byMgmt[mg] = { offices: {}, stations: new Set(), bt: {}, count: 0 });
            b.offices[o] = (b.offices[o] || 0) + 1;
            if (r.station) b.stations.add(r.station);
            if (r.btype) b.bt[r.btype] = (b.bt[r.btype] || 0) + 1;
            b.count++;
          });
          const lines = Object.keys(byMgmt).sort().map((mg) => {
            const b = byMgmt[mg];
            const offs = Object.keys(b.offices).sort();
            return `· ${mg}：共 ${b.count} 座建筑物，下属 ${offs.length} 个管理所（${offs.join("、")}），管理站 ${b.stations.size} 个。`;
          });
          return `【本地台账机构层级与统计】\n总建筑物数：${records.length}。\n` + (lines.join("\n") || "（暂无数据）");
        },
        // #8 从 AI 结果文本中提取可下钻的关键词（管理所/管理站/建筑物名），供 followup 按钮使用
        suggestFrom: (txt) => {
          const text = txt || "";
          const set = new Set();
          records.forEach((r) => { [r.office, r.station, r.name, r.btype].forEach((v) => { if (v && text.indexOf(String(v)) >= 0) set.add(String(v)); }); });
          return [...set].slice(0, 10);
        },
        // #8 双击 followup 关键词 → 填入查询框并立即检索
        runSearch: (kw) => {
          const s = el("search"); if (s) s.value = kw || "";
          if (typeof filter !== "undefined") filter.q = (kw || "").trim();
          if (typeof render === "function") render();
          closeModal();
          toast("已在查询框填入：" + (kw || ""));
        },
        queryPrompt: (r) => `这是水利工程内部台账中的建筑物「${r.name}」，管理所：${r.office || ""}，管理段：${r.station || ""}，类型：${r.btype || ""}。已知参数：${JSON.stringify(r.params || {})}${r.description ? "；描述：" + r.description : ""}。请基于这些信息做结构化梳理与合理性校验（如参数单位、数值范围、命名规范），指出可能错漏，不要编造公开网络数据。`,
        updatePrompt: (r) => `水利工程内部台账建筑物：${JSON.stringify({ name: r.name, office: r.office, station: r.station, btype: r.btype, params: r.params || {}, description: r.description || "" })}。请仅依据已有字段对缺失项做合理补全建议、对错漏项做校验。返回 JSON：{"params":{"键":"值"},"description":"一句话描述","changes":["变更说明"]}。只返回 JSON。`
      };
      const acts = { search: focusSearch, filter: openFilter, add: openAdd, import: triggerImport, export: exportMenu,
        batchPhotos: () => batchImportMenu("photos"), batchSheets: () => batchImportMenu("sheets"), exportPhotos: exportPhotosMenu,
        netdisk: netdiskMenu, lan: lanMenu,
        copyFromAndroid, exportToAndroid,
        stats, locate, coord: getCoord, nearby: openNearby, measure: () => { measureMode ? exitMeasure() : enterMeasure(); }, layer: openBasemap,
        sync: openSync, reset, help, about, changelog, platmatrix: platMatrix, delPhotos, delBuildings, photoInfo,
        rebuild: rebuildPhotoThumbs,
        cleanInbox: cleanImportCache,
        opsDefaultLoc: openOpsDefaultLoc, opsPlan: openOpsPlan, opsInspect: openOpsInspect, opsRoute: openOpsRoute,
        aiSettings: () => AI.openSettings(), aiQuery: () => AI.openQuery(), aiUpdate: () => AI.openUpdate(), aiCorrect: () => AI.openCorrect(), aiChat: () => AI.openChat(), aiFreeQuery: () => AI.openFreeQuery(),
        kbImportFile, kbExport, kbImportBackup, kbQuery: openKBQuery, kbImportUrl, aiHistory: () => AI.openHistory(),
        // v2.4 新增管理入口
        orgManager: () => openOrgManager(), btypeManager: () => openBtypeManager(), quickFavSettings: openQuickFavSettings,
        tiandituKey: openTiandituKeySettings, errlog: openErrLog };
      function cleanImportCache() {
        if (window.AndroidBridge && window.AndroidBridge.cleanInbox) { window.AndroidBridge.cleanInbox(); toast("已清理导入临时缓存"); }
        else toast("当前环境（网页版）无导入缓存可清理");
      }
      // v2.4.3：扩展模块（升级/游记/备忘录）通过 window.__EXT_ACTS__ 自注册，避免每加一个功能都改 acts
      const __ext = (window.__EXT_ACTS__ || {});
      const __fn = acts[act] || __ext[act];
      if (typeof __fn === "function") __fn();
      else toast("该功能未装载（" + act + "），请检查安装包是否完整");   // fail-loud：不再静默无反应
    };
    // 方式1：右键/长按菜单项 → 加入/移出快捷常用（移动端 WebView 长按同样触发 contextmenu）
    b.oncontextmenu = (e) => { e.preventDefault(); toggleQuickFav(b.dataset.act); };
  }
  // ---------- 快捷常用（v2.4）：用户自选高频功能，置于查询/筛选之下首位；原子菜单保留 ----------
  const QF_KEY = "shuili_quickfavs_v1";
  const QF_EXCLUDE = ["search", "filter"]; // 已置顶，不重复
  function loadQuickFavs() { try { const a = JSON.parse(localStorage.getItem(QF_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string" && !QF_EXCLUDE.includes(x)) : []; } catch (e) { return []; } }
  function saveQuickFavs(a) { try { localStorage.setItem(QF_KEY, JSON.stringify(a)); } catch (e) {} }
  // ---------- 错误日志查看器（功能⑯：信息与帮助 → 错误日志）----------
  function openErrLog() {
    var KEY = (window.__APP_ID__ || "app") + "_errlog_v1";
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem(KEY) || "[]"); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
    arr = arr.slice().reverse(); // 最新在前
    var body;
    if (!arr.length) {
      body = '<div class="hint">暂无错误记录。运行中的脚本错误会在此自动收集，便于反馈排查。</div>';
    } else {
      body = '<div style="max-height:62vh;overflow:auto;font-size:12px">' + arr.map(function (e) {
        return '<div style="border-bottom:1px solid rgba(255,255,255,.08);padding:8px 2px">' +
          '<div style="color:#8fb7e8;font-size:11px">' + esc(e.t || "") + '</div>' +
          '<div style="color:#e8eef6;white-space:pre-wrap;word-break:break-all;margin-top:3px">' + esc(e.m || "") + '</div></div>';
      }).join("") + '</div>';
    }
    openModal("错误日志（最近 " + arr.length + " 条）", body,
      '<button class="btn ghost" id="elCopy">复制全部</button><button class="btn ghost" id="elClear">清空</button><button class="btn primary" id="elClose">关闭</button>');
    var c = el("elCopy"); if (c) c.onclick = function () {
      var txt = arr.map(function (e) { return (e.t || "") + "\n" + (e.m || ""); }).join("\n\n");
      copyText(txt); toast("已复制 " + arr.length + " 条错误日志");
    };
    var cl = el("elClear"); if (cl) cl.onclick = function () { localStorage.removeItem(KEY); closeModal(); toast("已清空错误日志"); };
    var x = el("elClose"); if (x) x.onclick = closeModal;
  }

  function toggleQuickFav(act) {
    if (act && navigator.vibrate) { try { navigator.vibrate(30); } catch (_) {} } // ⑨ 长按反馈：振动（不支持的环境静默忽略）
    if (!act || QF_EXCLUDE.includes(act)) return;
    const cur = loadQuickFavs();
    const i = cur.indexOf(act);
    if (i >= 0) { cur.splice(i, 1); toast("已从快捷常用移出"); }
    else { cur.push(act); toast("已加入快捷常用"); }
    saveQuickFavs(cur); renderQuickFavs();
  }
  // btnMenuTitle：取菜单按钮主标题（不含 .sub 副标题）
  function btnMenuTitle(b) {
    const sp = b ? b.querySelector("span:nth-child(2)") : null;
    if (!sp) return "";
    const n = sp.childNodes[0];
    return ((n && n.nodeType === 3 ? n.textContent : sp.textContent) || "").trim();
  }
  function renderQuickFavs() {
    const box = el("quickFavGroup"); if (!box) return;
    const favs = loadQuickFavs();
    if (!favs.length) { box.innerHTML = `<div class="hint" style="padding:6px 10px">尚未设置常用功能：右键/长按任意菜单项，或到「设置 → 快捷常用设置」勾选</div>`; return; }
    box.innerHTML = favs.map((act) => {
      const src = document.querySelector(`.drawer .menu-btn[data-act="${act}"]`);
      const ico = src && src.querySelector(".ico") ? src.querySelector(".ico").textContent : "⭐";
      const title = btnMenuTitle(src) || act;
      return `<button class="menu-btn qf-btn" data-act="${act}"><span class="ico">${ico}</span><span>${esc(title)}<span class="sub">快捷常用 · 长按移出</span></span></button>`;
    }).join("");
    box.querySelectorAll(".menu-btn").forEach(bindMenuBtn);
  }
  // 方式2：设置里勾选子菜单为快捷常用
  function openQuickFavSettings() {
    const all = [...document.querySelectorAll(".drawer .menu-btn:not(.qf-btn)")].filter((b) => !QF_EXCLUDE.includes(b.dataset.act));
    const favs = loadQuickFavs();
    const html = `<div class="hint">勾选常用功能，保存后显示在「快捷常用」菜单（置于查询/筛选之下首位）。也可在抽屉中<b>右键/长按</b>任意菜单项快速添加/移出。原子菜单全部保留。</div>
      <div style="max-height:46vh;overflow:auto">` +
      all.map((b) => {
        const act = b.dataset.act;
        const ico = b.querySelector(".ico") ? b.querySelector(".ico").textContent : "";
        const on = favs.includes(act);
        return `<label style="display:flex;align-items:center;gap:8px;padding:7px 4px;cursor:pointer;border-bottom:1px solid rgba(127,127,127,.15)"><input type="checkbox" class="qfcb" value="${act}" ${on ? "checked" : ""}/><span>${ico} ${esc(btnMenuTitle(b) || act)}</span></label>`;
      }).join("") + `</div>`;
    openModal("快捷常用设置", html, `<button class="btn ghost" id="qfCancel">取消</button><button class="btn primary" id="qfSave">保存</button>`);
    el("qfCancel").onclick = closeModal;
    el("qfSave").onclick = () => {
      const sel = [...document.querySelectorAll(".qfcb:checked")].map((c) => c.value);
      saveQuickFavs(sel); closeModal(); renderQuickFavs(); toast(`已保存快捷常用（${sel.length} 项）`);
    };
  }
  // 查询置顶：聚焦顶栏搜索框并提示
  function focusSearch() {
    const s = el("search"); if (!s) return;
    s.focus(); s.scrollIntoView({ block: "center" });
    toast("请输入名称 / 管理所关键字进行查询");
  }
  function closeDrawer() { el("drawer").classList.remove("open"); el("mask").classList.remove("show"); }

  // ---------- 右键上下文菜单（显示界面智能挂载 AI / 常规功能）----------
  function _ctxClose() { closeCtxMenu(); }
  function _ctxEsc(e) { if (e.key === "Escape") closeCtxMenu(); }
  function closeCtxMenu() {
    const m = el("ctxMenu"); if (m) m.remove();
    document.removeEventListener("click", _ctxClose, true);
    document.removeEventListener("keydown", _ctxEsc);
  }
  function openCtxMenu(x, y, items) {
    closeCtxMenu();
    const m = document.createElement("div");
    m.id = "ctxMenu"; m.className = "ctx-menu";
    m.innerHTML = items.map((it, i) =>
      it.sep ? '<div class="ctx-sep"></div>'
      : `<div class="ctx-item" data-i="${i}">${it.icon ? '<span class="ctx-ico">' + it.icon + "</span>" : ""}${esc(it.label)}</div>`
    ).join("");
    document.body.appendChild(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    if (x + w > window.innerWidth) x = Math.max(4, window.innerWidth - w - 4);
    if (y + h > window.innerHeight) y = Math.max(4, window.innerHeight - h - 4);
    m.style.left = x + "px"; m.style.top = y + "px";
    m.querySelectorAll(".ctx-item").forEach((node) => (node.onclick = () => {
      const it = items[+node.dataset.i]; closeCtxMenu(); if (it && it.fn) it.fn();
    }));
    setTimeout(() => document.addEventListener("click", _ctxClose, false), 0);
    document.addEventListener("keydown", _ctxEsc);
  }
  // 记录类右键项：AI 智能四件套 + 定位 / 编辑 / 导出 / 删除
  function ctxItemsFor(r) {
    return [
      { label: "智能查询", icon: "🔍", fn: () => AI.query(r) },
      { label: "智能更新", icon: "🤖", fn: () => AI.update(r) },
      { label: "智能纠错", icon: "✏️", fn: () => AI.correct(r) },
      { label: "AI 对话", icon: "💬", fn: () => AI.openChat() },
      { sep: true },
      { label: "定位到地图", icon: "📍", fn: () => locateInMap(r) },
      { label: "编辑", icon: "📝", fn: () => openEdit(r.id) },
      { label: "导出此条", icon: "📤", fn: () => exportOne(r) },
      { label: "删除", icon: "🗑️", fn: () => deleteRecord(r.id) },
    ];
  }
  // 地图空白处右键：智能添加 / 收藏窗口 / 主菜单
  function mapCtxItems(latlng) {
    return [
      { label: "🤖 AI 智能建卡", fn: () => aiAddAt(latlng) },
      { label: "📍 在此添加建筑物", fn: () => openAddForm({ lat: latlng.lat, lon: latlng.lng }) },
      { sep: true },
      { label: "⭐ 收藏当前窗口", fn: () => saveFavWindow() },
      { label: "🏠 回到主菜单", fn: () => tripleTapMenu() },
    ];
  }
  async function deleteRecord(id) {
    const r = records.find((x) => x.id === id); if (!r) return;
    if (!confirm("确认删除「" + (r.name || "未命名") + "」？此操作不可恢复。")) return;
    await Store.patch((d) => {
      d.added = d.added || []; d.updated = d.updated || {};
      const i = d.added.findIndex((a) => a.id === id);
      if (i >= 0) d.added.splice(i, 1);
      else { d.deleted = d.deleted || []; if (!d.deleted.includes(id)) d.deleted.push(id); delete d.updated[id]; }
    });
    DELTA = await Store.get(); merge(); render();
    toast("已删除：" + (r.name || "未命名"));
  }
  function exportOne(r) {
    try {
      const name = (r.name || "record").replace(/[\\/:*?"<>|]/g, "_");
      IO.downloadText(name + ".csv", IO.buildCsv([r]));
      toast("已导出：" + (r.name || "记录"));
    } catch (e) { toast("导出失败：" + e.message); }
  }
  function safeJson(s) {
    if (!s) return null;
    s = String(s).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "");
    const a = s.indexOf("{"); const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  async function aiAddAt(latlng) {
    openModal("AI 智能建卡",
      `<div class="hint">描述这个建筑物（如"温泉所管理段的一座节制闸，3 孔，闸宽 6 米"），AI 将自动提取名称/管理所/类型/参数并预填表单。</div>
       <div class="field" style="margin-top:10px"><textarea id="aiAddDesc" class="inp" rows="4" placeholder="在此输入描述…"></textarea></div>`,
      `<button class="btn ghost" id="aiAddCancel">取消</button><button class="btn primary" id="aiAddGo">AI 提取并建卡</button>`);
    el("aiAddCancel").onclick = closeModal;
    el("aiAddGo").onclick = async () => {
      const desc = el("aiAddDesc").value.trim(); if (!desc) return toast("请先输入描述");
      busy("AI 提取中…");
      try {
        const sys = (AI.domain && AI.domain.internal)
          ? '你是水利工程内部台账录入助手。依据用户描述提取结构化字段。返回严格 JSON：{"name":"名称","office":"管理所","station":"管理站/段","btype":"建筑物类型","params":{"键":"值"},"description":"一句话"}。只返回 JSON。'
          : '你是古建/地点信息录入助手。依据描述提取结构化字段。返回严格 JSON：{"name":"名称","office":"管理所/地区","station":"管理站/段","btype":"类型","params":{"键":"值"},"description":"一句话"}。只返回 JSON。';
        const raw = await AI.strategyCall(desc, { system: sys, json: true });
        const o = safeJson(raw);
        if (!o || !o.name) throw new Error("AI 未返回可解析的 JSON");
        closeModal();
        editId = null;
        openAddForm({ lat: latlng.lat, lon: latlng.lng });
        const setV = (id, v) => { const e = el(id); if (e && v != null && v !== "") e.value = v; };
        setV("fName", o.name); setV("fOffice", o.office); setV("fBtype", o.btype); setV("fStation", o.station);
        if (o.params) setV("fParams", Object.keys(o.params).map((k) => k + " : " + o.params[k]).join("\n"));
        toast("已用 AI 提取结果预填，请核对后保存");
      } catch (e) { toast("AI 建卡失败：" + e.message); }
    };
  }
  // 收藏当前地图「窗口」（视图四角范围 + 缩放）/ 返回收藏窗口（item 7）
  // Store.ui.favs = [{id,name,bounds:[[swLat,swLng],[neLat,neLng]],center:[lat,lng],zoom}]
  function getFavs() { const s = Store.ui.get() || {}; return Array.isArray(s.favs) ? s.favs : []; }
  function setFavs(favs) { const s = Store.ui.get() || {}; Store.ui.set(Object.assign({}, s, { favs })); }
  function flyToFav(f) {
    if (f && f.bounds && f.bounds.length === 2 && f.bounds[0] && f.bounds[1]) {
      try { map.flyToBounds([[f.bounds[0][0], f.bounds[0][1]], [f.bounds[1][0], f.bounds[1][1]]], { duration: 0.6, maxZoom: f.zoom }); return; } catch (e) {}
    }
    if (f && f.center) map.flyTo([f.center[0], f.center[1]], f.zoom || 15, { duration: 0.6 });
  }
  function saveFavWindow() {
    const b = map.getBounds();
    const bounds = [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
    const center = [map.getCenter().lat, map.getCenter().lng];
    const zoom = map.getZoom();
    const favs = getFavs();
    const def = "窗口" + (favs.length + 1);
    openModal("收藏当前窗口",
      `<div class="hint">将收藏当前地图视图范围（四角坐标 + 缩放），可随时返回，便于快速回到关注区域（如「温泉所某建筑物窗口」）。</div>
       <div class="field"><label>窗口名称</label><input id="favName" class="inp" value="${esc(def)}" placeholder="如：温泉所建筑物窗口"></div>`,
      `<button class="btn ghost" id="favCancel">取消</button><button class="btn primary" id="favOk">收藏</button>`);
    el("favCancel").onclick = closeModal;
    el("favOk").onclick = () => {
      const name = (el("favName").value || def).trim() || def;
      const entry = { id: "w" + Date.now().toString(36), name, bounds, center, zoom };
      setFavs(favs.concat([entry]));
      closeModal();
      toast("已收藏窗口：" + name + "（点 📍 返回）");
    };
  }
  function goFavWindow() {
    const favs = getFavs();
    if (!favs.length) {
      const s = Store.ui.get() || {};
      if (s.fav && s.fav.lat != null) { return flyToFav({ center: [s.fav.lat, s.fav.lng], zoom: s.fav.zoom }); } // 兼容旧版单点收藏
      return toast("尚未收藏窗口，请先点 ⭐ 收藏当前窗口");
    }
    if (favs.length === 1) { flyToFav(favs[0]); return toast("已返回收藏窗口：" + favs[0].name); }
    const html = favs.map((f, i) => `<div class="fav-item" data-i="${i}"><span class="fi-ico">🪟</span><span class="fi-name">${esc(f.name)}</span><span class="fi-meta">缩放 ${f.zoom}</span></div>`).join("");
    openModal("返回收藏窗口", `<div class="hint">选择一个窗口返回（按记录范围 + 缩放居中）：</div><div class="filelist">${html}</div>`, `<button class="btn ghost" id="favClose">关闭</button>`);
    el("favClose").onclick = closeModal;
    document.querySelectorAll(".fav-item").forEach((it) => {
      it.onclick = () => { const i = +it.dataset.i; closeModal(); flyToFav(favs[i]); toast("已返回收藏窗口：" + favs[i].name); };
    });
  }
  function openSync() {
    const html = `<div class="hint">把当前「我的改动」备份为文件，或导入他人/他机的改动。</div>`;
    openModal("我的改动备份", html, `<button class="btn ghost" id="syExp">导出备份</button><button class="btn primary" id="syImp">导入备份</button><button class="btn ghost" onclick="APP.close()">关闭</button>`);
    el("syExp").onclick = syncExport; el("syImp").onclick = syncImport;
  }
  function triggerImport() {
    // 修复：WebView 下局部 input 被 GC → onchange 不触发 → 点击 csv 等"无反应"
    // Android 系统选择器按 MIME 过滤：.ovkmz/.7z 等无 MIME 映射会被隐藏导致「选不了」，故加 */* 兜底，格式由 doImport 校验
    pickFiles({ accept: ".ovkmz,.kmz,.kml,.csv,.xls,.xlsx,.ovobj,.obj,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,*/*", onPick: (files) => files[0] && doImport(files[0]) });
  }

  // ================= 运行维护 / 旅游打卡 / 智能分析（P5 · 2026-08-23） =================
  // 数据层：Store.ops（localStorage），与建筑物 delta 分离
  const OPS_TYPES = ["日常检查", "例行维护", "故障处理", "应急响应", "其他"];
  const INSPECT_TYPES = ["日常巡视", "例行维护", "故障处置", "应急响应", "其他"];
  function getOps() {
    const s = (window.Store && Store.ops) ? Store.ops.get() : {};
    s.defaultLoc = s.defaultLoc || null;
    s.plans = s.plans || [];
    s.inspects = s.inspects || [];
    s.routes = s.routes || [];
    return s;
  }
  function setOps(s) { if (window.Store && Store.ops) Store.ops.set(s); }

  // 估算路上时长（小时）：直线距离 / 假设车速（默认 30km/h，UI 可调）
  function estDriveHours(lat1, lon1, lat2, lon2, speedKmh) {
    const R = 6371, toR = Math.PI / 180;
    const d = R * 2 * Math.asin(Math.sqrt(
      Math.pow(Math.sin((lat2 - lat1) * toR / 2), 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.pow(Math.sin((lon2 - lon1) * toR / 2), 2)));
    return d / (speedKmh || 30);
  }
  function fmtHours(h) {
    const m = Math.round(h * 60);
    if (m < 60) return m + " 分钟";
    const hh = Math.floor(m / 60), mm = m % 60;
    return hh + " 小时" + (mm ? " " + mm + " 分" : "");
  }

  // ① 设置默认出发位置
  function openOpsDefaultLoc() {
    const s = getOps();
    const dl = s.defaultLoc;
    const opts = records.map((r) => `<option value="${r.id}">${esc(r.name)}（${esc(r.office || "")}）</option>`).join("");
    const html = `
      <div class="hint">设置默认出发位置：巡视 / 路线从该点开始计算时长。</div>
      <div class="field"><label>从已有建筑物选择</label><select id="dlSel" class="inp"><option value="">— 自定义 —</option>${opts}</select></div>
      <div class="field"><label>名称（自定义时填）</label><input id="dlName" class="inp" value="${dl && dl.custom ? esc(dl.name || "") : ""}" placeholder="如：管理所大院"></div>
      <div class="field"><label>纬度</label><input id="dlLat" class="inp" inputmode="decimal" value="${dl ? dl.lat : ""}" placeholder="如 40.37"></div>
      <div class="field"><label>经度</label><input id="dlLng" class="inp" inputmode="decimal" value="${dl ? dl.lon : ""}" placeholder="如 116.63"></div>
      <div class="field"><label>当前已设</label><div class="hint" id="dlCur">${dl ? esc(dl.name + " (" + dl.lat + ", " + dl.lon + ")") : "（未设置）"}</div></div>`;
    openModal("设置默认出发位置", html, `<button class="btn ghost" id="dlClear">清除</button><button class="btn ghost" id="dlCancel">取消</button><button class="btn primary" id="dlOk">保存</button>`);
    el("dlSel").onchange = () => {
      const r = records.find((x) => x.id === el("dlSel").value);
      if (r) { el("dlLat").value = r.lat; el("dlLng").value = r.lon; el("dlName").value = r.name; }
    };
    el("dlCancel").onclick = closeModal;
    el("dlClear").onclick = () => { const s = getOps(); s.defaultLoc = null; setOps(s); closeModal(); toast("已清除默认出发位置"); };
    el("dlOk").onclick = () => {
      const id = el("dlSel").value;
      const r = id ? records.find((x) => x.id === id) : null;
      const lat = parseFloat(el("dlLat").value), lon = parseFloat(el("dlLng").value);
      if (!isFinite(lat) || !isFinite(lon)) return toast("请先选择建筑物或填写有效经纬度");
      const s = getOps();
      s.defaultLoc = r ? { id: r.id, name: r.name, lat: +r.lat, lon: +r.lon, custom: false }
                      : { name: el("dlName").value.trim() || "自定义点", lat, lon, custom: true };
      setOps(s); closeModal();
      toast("已保存默认出发位置：" + s.defaultLoc.name);
    };
  }

  // ② 运行维护计划
  function openOpsPlan() {
    const s = getOps();
    const rows = s.plans.map((p, i) => `<div class="ops-row"><span class="ops-tag">${esc(p.type)}</span>
      <span class="ops-main"><b>${esc(p.time || "未填时间")}</b> · 范围：${esc(p.scope || "—")} · 计划处理：${esc(p.planHandle || "—")}</span>
      <button class="ops-del" data-i="${i}">删</button></div>`).join("") || `<div class="hint">暂无计划，下方添加。</div>`;
    const typeOpts = OPS_TYPES.map((t) => `<option>${t}</option>`).join("");
    const html = `<div class="hint">运行维护计划：日常检查 / 例行维护 / 故障处理 / 应急响应 / 其他。</div>
      <div class="ops-list">${rows}</div>
      <div class="ops-form">
        <div class="field"><label>类型</label><select id="plType" class="inp">${typeOpts}</select></div>
        <div class="field"><label>时间</label><input id="plTime" class="inp" type="datetime-local" class="inp"></div>
        <div class="field"><label>范围</label><input id="plScope" class="inp" placeholder="如：温泉所全段"></div>
        <div class="field"><label>计划处理时间</label><input id="plHandle" class="inp" type="datetime-local"></div>
        <div class="field"><label>备注</label><input id="plNote" class="inp" placeholder="可选"></div>
        <button class="btn primary" id="plAdd">添加计划</button>
      </div>`;
    openModal("运行维护计划", html, `<button class="btn ghost" id="plClose">关闭</button>`);
    el("plClose").onclick = closeModal;
    el("plAdd").onclick = () => {
      const s = getOps();
      s.plans.push({ id: "p" + Date.now().toString(36), type: el("plType").value, time: el("plTime").value, scope: el("plScope").value.trim(), planHandle: el("plHandle").value, note: el("plNote").value.trim() });
      setOps(s); openOpsPlan(); // 刷新
    };
    document.querySelectorAll(".ops-del").forEach((b) => b.onclick = () => {
      const s = getOps(); s.plans.splice(+b.dataset.i, 1); setOps(s); openOpsPlan();
    });
  }

  // ③ 巡视检查（含巡视类型 / 显示坐标只读 / 是否计划内）
  function openOpsInspect() {
    const s = getOps();
    const rows = s.inspects.map((it, i) => `<div class="ops-row"><span class="ops-tag">${esc(it.type)}</span>
      <span class="ops-main"><b>${esc(it.bname || "未选建筑物")}</b> · ${it.planned ? "计划内" : "计划外"} · 坐标：${it.coord ? it.coord.lat.toFixed(5) + "," + it.coord.lon.toFixed(5) : "—"}</span>
      <button class="ops-del" data-i="${i}">删</button></div>`).join("") || `<div class="hint">暂无巡视记录，下方新增（自动获取当前位置坐标，只读）。</div>`;
    const typeOpts = INSPECT_TYPES.map((t) => `<option>${t}</option>`).join("");
    const bOpts = records.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
    const html = `<div class="hint">巡视检查：选择巡视类型、关联建筑物（自动获取当前坐标只读）、标记是否计划内。</div>
      <div class="ops-list">${rows}</div>
      <div class="ops-form">
        <div class="field"><label>巡视类型</label><select id="insType" class="inp">${typeOpts}</select></div>
        <div class="field"><label>关联建筑物</label><select id="insBid" class="inp"><option value="">— 选建筑物 —</option>${bOpts}</select></div>
        <div class="field"><label>坐标（自动获取，只读）</label><input id="insCoord" class="inp" readonly placeholder="点「获取当前坐标」"></div>
        <div class="field"><label><input type="checkbox" id="insPlanned"> 是否计划内维护</label></div>
        <button class="btn primary" id="insGet">获取当前坐标</button>
        <button class="btn primary" id="insAdd" style="margin-left:8px">记录巡视</button>
      </div>`;
    openModal("巡视检查", html, `<button class="btn ghost" id="insClose">关闭</button>`);
    el("insClose").onclick = closeModal;
    el("insGet").onclick = () => {
      if (window.AndroidBridge && window.AndroidBridge.getLoc) {
        window.AndroidBridge.getLoc((lat, lon) => { el("insCoord").value = lat + "," + lon; });
      } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => { el("insCoord").value = pos.coords.latitude + "," + pos.coords.longitude; }, () => toast("定位失败，请重试"));
      } else toast("当前环境不支持定位");
    };
    el("insAdd").onclick = () => {
      const bid = el("insBid").value;
      const b = bid ? records.find((x) => x.id === bid) : null;
      const coord = (el("insCoord").value || "").split(",").map(Number);
      if (!b) return toast("请先关联建筑物");
      if (!(coord.length === 2 && isFinite(coord[0]) && isFinite(coord[1]))) return toast("请先获取当前坐标");
      const s = getOps();
      s.inspects.push({ id: "i" + Date.now().toString(36), type: el("insType").value, bid, bname: b.name, coord: { lat: coord[0], lon: coord[1] }, planned: el("insPlanned").checked, at: new Date().toISOString() });
      setOps(s); openOpsInspect();
    };
    document.querySelectorAll(".ops-del").forEach((b) => b.onclick = () => {
      const s = getOps(); s.inspects.splice(+b.dataset.i, 1); setOps(s); openOpsInspect();
    });
  }

  // ④ 我的巡视路线（含时长估算）
  function openOpsRoute() {
    const s = getOps();
    const dl = s.defaultLoc;
    const rows = s.routes.map((rt, i) => {
      const pts = rt.points.map((pid) => records.find((r) => r.id === pid)).filter(Boolean);
      let drive = 0, stay = 0;
      const speed = rt.speed || 30, stayMin = rt.stayMin || 10;
      let prev = dl ? { lat: +dl.lat, lon: +dl.lon } : (pts[0] ? { lat: +pts[0].lat, lon: +pts[0].lon } : null);
      for (const p of pts) {
        if (prev) drive += estDriveHours(prev.lat, prev.lon, +p.lat, +p.lon, speed);
        stay += stayMin / 60; prev = { lat: +p.lat, lon: +p.lon };
      }
      const total = drive + stay;
      return `<div class="ops-row"><span class="ops-tag">${esc(rt.name || "路线")}</span>
        <span class="ops-main">${pts.length} 点 · 路上 ${fmtHours(drive)} · 停留 ${fmtHours(stay)} · <b>总 ${fmtHours(total)}</b> · 车速${speed} 停留${stayMin}分/点</span>
        <button class="ops-del" data-i="${i}">删</button></div>`;
    }).join("") || `<div class="hint">暂无路线。添加路线并选择途经建筑物，自动估算巡视时长（从默认出发位置起算）。</div>`;
    const bOpts = records.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
    const html = `<div class="hint">我的巡视路线：选择途经建筑物，从默认出发位置起算总时长（路上 + 停留）。</div>
      <div class="ops-list">${rows}</div>
      <div class="ops-form">
        <div class="field"><label>路线名称</label><input id="rtName" class="inp" placeholder="如：温泉所周巡"></div>
        <div class="field"><label>途经建筑物（按顺序，Ctrl/⌘ 多选）</label><select id="rtPts" class="inp" multiple size="6">${bOpts}</select></div>
        <div class="field"><label>假设车速(km/h)</label><input id="rtSpeed" class="inp" inputmode="numeric" value="30"></div>
        <div class="field"><label>每点停留(分钟)</label><input id="rtStay" class="inp" inputmode="numeric" value="10"></div>
        <button class="btn primary" id="rtAdd">添加路线</button>
      </div>`;
    openModal("我的巡视路线", html, `<button class="btn ghost" id="rtClose">关闭</button>`);
    el("rtClose").onclick = closeModal;
    el("rtAdd").onclick = () => {
      const pts = [...el("rtPts").selectedOptions].map((o) => o.value);
      if (!pts.length) return toast("请至少选择 1 个途经建筑物");
      const s = getOps();
      s.routes.push({ id: "r" + Date.now().toString(36), name: el("rtName").value.trim() || "路线" + (s.routes.length + 1), points: pts, speed: +el("rtSpeed").value || 30, stayMin: +el("rtStay").value || 10 });
      setOps(s); openOpsRoute();
    };
    document.querySelectorAll(".ops-del").forEach((b) => b.onclick = () => {
      const s = getOps(); s.routes.splice(+b.dataset.i, 1); setOps(s); openOpsRoute();
    });
  }

  // 照片轮播：多照片时点击进入自动循环
  let _lbTimer = null;
  function startLbCycle(photos, idx) {
    stopLbCycle();
    if (photos.length <= 1) return;
    _lbTimer = setInterval(() => {
      idx = (idx + 1) % photos.length;
      openPhotoAt(photos, idx);
    }, 2500);
  }
  function stopLbCycle() { if (_lbTimer) { clearInterval(_lbTimer); _lbTimer = null; } }
  // 新入口：接收某建筑物的多照片数组，支持自动轮播
  async function openPhotoCycle(rid) {
    const r = records.find((x) => x.id === rid); if (!r || !r.photos || !r.photos.length) return;
    const photos = r.photos;
    window.__CUR_PHOTOS__ = photos;
    lbRid = rid; lbPi = 0;
    await openPhotoAt(photos, 0);
    // 控制条：多照片时显示切换 + 自动轮播按钮
    const multi = photos.length > 1;
    el("lbBar").style.display = multi ? "" : "none";
    el("lbPrev").style.display = multi ? "" : "none";
    el("lbNext").style.display = multi ? "" : "none";
    el("lbIdx").style.display = multi ? "" : "none";
    ensureLbCycleBtn();
  }
  async function openPhotoAt(photos, idx) {
    const ph = photos[idx];
    el("lbImg").src = await loadPhotoFull(ph);
    el("lbImg").style.transform = "";
    el("lbCap").textContent = (ph.caption || "") + (photos.length > 1 ? `（${idx + 1}/${photos.length}）` : "");
    el("lbIdx").textContent = photos.length > 1 ? `${idx + 1}/${photos.length}` : "";
    el("lightbox").classList.add("show");
  }
  function ensureLbCycleBtn() {
    if (el("lbCycle")) return;
    const bar = el("lbBar"); if (!bar) return;
    const btn = document.createElement("button");
    btn.id = "lbCycle"; btn.className = "lb-btn"; btn.textContent = "自动";
    btn.onclick = () => {
      const photos = window.__CUR_PHOTOS__ || [];
      if (_lbTimer) { stopLbCycle(); btn.textContent = "自动"; btn.classList.remove("on"); }
      else if (photos.length > 1) {
        const cur = (parseInt((el("lbIdx").textContent || "1").split("/")[0]) || 1) - 1;
        startLbCycle(photos, cur); btn.textContent = "停止"; btn.classList.add("on");
      }
    };
    bar.appendChild(btn);
  }

  // ================= 知识库（KB）集成 · 需求③ =================
  // 让 AI 融入应用：KB 承载建筑物骨架 + 操作日志 + Hermes 自我学习记忆。
  // 所有钩子对 KB 缺失/异常均优雅降级，不影响主流程。
  function kbReady() { return !!(window.KB && KB.all); }
  function kbLog(desc, params) { if (kbReady()) { try { KB.logOp(desc, params); } catch (e) {} } }

  async function loadPrebuiltSkeleton() {
    // 构建期预生成的骨架（kb_skeleton.json，随发行版嵌入）→ 首启离线即时导入
    try {
      const res = await fetch("kb_skeleton.json");
      if (!res.ok) return null;
      const j = await res.json();
      const arr = Array.isArray(j) ? j : (j.entries || []);
      return arr.length ? arr : null;
    } catch (e) { return null; }
  }

  async function initKB() {
    if (!kbReady()) return;
    try {
      const es = await KB.all();
      if (es.length) return;                       // 已有骨架/数据，不覆盖
      // ①优先：预构建骨架（离线、即时、确定性）
      const pre = await loadPrebuiltSkeleton();
      if (pre) {
        for (const e of pre) await KB.put(e);
        kbLog("初始化知识库骨架(预构建)", { buildings: pre.length });
        return;
      }
      // ②兜底：运行期从台账重建
      const recs = (records || []).filter((r) => r && r.lat != null && r.lon != null);
      if (recs.length) {
        const n = await KB.rebuildSkeleton(recs);
        kbLog("初始化知识库骨架(运行期)", { buildings: n });
      }
    } catch (e) { console.warn("KB init skip:", e); }
  }

  // KB 导入进度弹窗（.bar/.bar-fill 复用批量导入照片的进度条样式）
  function kbProgress(title) {
    openModal(title,
      `<div class="hint" id="kbPMsg">准备中…</div><div class="bar"><div class="bar-fill" id="kbPBar" style="width:0%"></div></div>`);
    return {
      set(p, msg) {
        const m = el("kbPMsg"), b = el("kbPBar");
        if (m && msg != null) m.textContent = msg;
        if (b) b.style.width = Math.max(0, Math.min(100, Math.round(p))) + "%";
      },
      close() { closeModal(); },
    };
  }

  // 子菜单①：导入外部文件 → 智能转 md（进度条）→ 入库（v2.4.5：pdf/docx/xlsx/html 等全支持）
  function kbImportFile() {
    if (!kbReady()) return toast("知识库未加载");
    pickFiles({ multiple: true, accept: ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.markdown,.html,.htm,.json,.jpg,.jpeg,.png,.bmp,.webp,application/pdf,image/*,text/*,*/*", onPick: async (files) => {
      if (!files.length) return;
      const p = kbProgress("外部文件智能转换入库");
      let ok = 0, fail = 0, msg = "";
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        p.set((i / files.length) * 100, `（${i + 1}/${files.length}）正在转换：${f.name}`);
        try {
          const entry = await KB.convertExternalAuto(f, (pp, m2) =>
            p.set(((i + pp / 100) / files.length) * 100, `（${i + 1}/${files.length}）${f.name}：${m2 || ""}`));
          ok++;
          kbLog("外部文件智能转换入库", { file: f.name, title: entry.title });
        } catch (e) { fail++; msg += `【${f.name}】${e.message} `; }
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程，进度条不卡死
      }
      p.close();
      toast(`已入库 ${ok} 个文件` + (fail ? `，失败 ${fail} 个：${msg}` : ""));
    }});
  }

  // 子菜单②：导出知识库（v2.4.5：md / txt / html 主流知识库兼容格式；zip 完整备份保留兼容）
  async function kbExport() {
    if (!kbReady()) return toast("知识库未加载");
    const n = (await KB.all()).length;
    const opt = (v, label, i) => `<label style="display:flex;gap:8px;align-items:center;padding:6px 0"><input type="radio" name="kbFmt" value="${v}" ${i === 0 ? "checked" : ""}> ${label}</label>`;
    const html = `<div class="hint">共 <b>${n}</b> 条知识。md 为 YAML front matter 格式，Obsidian / Joplin / 语雀 / Notion 等主流知识库可直接导入：</div>` +
      opt("md", "Markdown（.md · 推荐，主流知识库兼容）") +
      opt("txt", "纯文本（.txt）") +
      opt("html", "网页（.html · 双击可直接打开）") +
      opt("zip", "完整备份（.zip · 旧格式，含 json 索引）");
    openModal("导出知识库", html, `<button class="btn ghost" id="kbExClose">关闭</button><button class="btn primary" id="kbExGo">导出</button>`);
    el("kbExClose").onclick = closeModal;
    el("kbExGo").onclick = async () => {
      const fmt = (document.querySelector('input[name="kbFmt"]:checked') || {}).value || "md";
      closeModal();
      busy("正在导出知识库…");
      try {
        const out = await KB.exportAs(fmt);
        const blob = new Blob([out.data], { type: out.mime });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = out.name;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
        kbLog("导出知识库", { fmt, size: out.data.length || out.data.byteLength, entries: n });
        toast("知识库已导出：" + out.name);
      } catch (e) { toast("导出失败：" + e.message); }
      finally { busy(false); }
    };
  }

  // 子菜单③：导入知识库文件（v2.4.5：md / txt / html 可多选，front matter 自动还原；旧 .zip 备份仍兼容）
  async function kbImportBackup() {
    if (!kbReady()) return toast("知识库未加载");
    pickFiles({ multiple: true, accept: ".md,.markdown,.txt,.html,.htm,.zip,text/markdown,text/plain,text/html,application/zip,*/*", onPick: async (files) => {
      if (!files.length) return;
      const p = kbProgress("导入知识库文件");
      let ok = 0, fail = 0, msg = "";
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          p.set((i / files.length) * 100, `（${i + 1}/${files.length}）正在导入：${f.name}`);
          try {
            if (/\.zip$/i.test(f.name)) {
              ok += await KB.importZip(await f.arrayBuffer());
            } else {
              ok += await KB.importDocuments([f], (pp, m2) =>
                p.set(((i + pp / 100) / files.length) * 100, `（${i + 1}/${files.length}）${m2 || f.name}`));
            }
          } catch (e) { fail++; msg += `【${f.name}】${e.message} `; }
        }
        kbLog("导入知识库文件", { files: files.length, ok, fail });
        p.close();
        toast(`已导入 ${ok} 条知识` + (fail ? `，失败 ${fail} 个：${msg}` : ""));
      } catch (e) { p.close(); toast("导入失败：" + e.message); }
    }});
  }

  // 子菜单④：知识库查询（本地优先 + 联网兜底 + 来源标注 + 确认按钮）
  async function openKBQuery() {
  window.openKB = openKBQuery; // 兼容旧 onclick="openKB()" 引用
    if (!kbReady()) return toast("知识库未加载");
    const online = localStorage.getItem("ai_online_v1") === "1";
    const html =
      `<div class="hint">本地优先：先在本机知识库检索；本地无结果且已开启「联网」（AI设置）时可点「联网查询」获取在线结果。结果标注来源 [本地]/[在线]。</div>` +
      `<div class="field"><label>查询内容</label><input id="kbqInput" placeholder="如：温泉所 节制闸 工程参数"></div>` +
      `<div id="kbqOut" class="ai-out"></div>`;
    openModal("知识库查询", html, `<button class="btn ghost" id="kbqClose">关闭</button><button class="btn ghost" id="kbqOnline">联网查询</button><button class="btn primary" id="kbqConfirm">确认查询</button>`);
    el("kbqClose").onclick = closeModal;
    const out = el("kbqOut");
    const md = (txt) => (AI && AI.mdLite ? AI.mdLite(txt) : '<pre style="white-space:pre-wrap">' + esc(txt) + '</pre>');
    const renderLocal = async (q) => {
      out.innerHTML = '<div class="hint">正在检索本地知识库…</div>';
      const txt = await KB.retrieve(q, 20);
      if (!txt || !txt.trim()) {
        out.innerHTML = '<div class="hint">本地知识库无匹配结果。' + (online ? '可点「联网查询」在线检索。' : '（联网未开启）') + '</div>';
        return false;
      }
      out.innerHTML = '<div class="src-badge">[本地]</div>' + md(txt);
      return true;
    };
    const renderOnline = async (q) => {
      if (!online) return toast("联网未开启（请到「AI设置」开启）");
      if (!window.AI || !AI.kbOnlineQuery) return toast("AI 未初始化，无法联网查询");
      out.innerHTML = '<div class="hint">正在联网查询（大模型）…</div>';
      try {
        const txt = await AI.kbOnlineQuery(q);
        out.innerHTML = '<div class="src-badge online">[在线]</div>' + md(txt);
      } catch (e) { out.innerHTML = '<div class="err">联网查询失败：' + esc(e.message) + '</div>'; }
    };
    el("kbqOnline").onclick = () => { const q = (el("kbqInput") ? el("kbqInput").value : "").trim(); if (!q) return toast("请输入查询内容"); renderOnline(q); };
    el("kbqConfirm").onclick = async () => {
      const q = (el("kbqInput") ? el("kbqInput").value : "").trim();
      if (!q) return toast("请输入查询内容");
      const found = await renderLocal(q);
      if (!found) await renderOnline(q);   // 本地无 → 联网兜底（若开启）
    };
  }

  // 子菜单⑤：从网页读取内容入库（普通网页 / 公众号文章 / 微博；CORS 受限时手动粘贴）
  function kbImportUrl() {
    if (!kbReady()) return toast("知识库未加载");
    const html =
      `<div class="hint">支持普通网页 / 公众号文章 / 微博地址。浏览器受跨域(CORS)限制，部分站点无法直接抓取，失败时可手动粘贴正文后再入库。</div>` +
      `<div class="field"><label>网页地址 URL</label><input id="kbUrl" placeholder="https://..."></div>` +
      `<div class="field"><label>正文（抓取失败可在此粘贴）</label><textarea id="kbUrlText" rows="6" placeholder="粘贴网页正文…"></textarea></div>`;
    openModal("从网页读取入库", html, `<button class="btn ghost" id="kbUrlCancel">取消</button><button class="btn primary" id="kbUrlSave">入库</button>`);
    el("kbUrlCancel").onclick = closeModal;
    el("kbUrlSave").onclick = async () => {
      const url = (el("kbUrl") ? el("kbUrl").value : "").trim();
      const pasted = (el("kbUrlText") ? el("kbUrlText").value : "").trim();
      let title = url || "网页", text = pasted;
      if (url && !text) {
        busy("正在抓取网页：" + url);
        try {
          const r = await fetch(url, { mode: "cors" });
          const htmlText = await r.text();
          const doc = new DOMParser().parseFromString(htmlText, "text/html");
          title = (doc.querySelector("title") || {}).textContent || url;
          const meta = doc.querySelector('meta[name="description"]');
          const bodyText = doc.body ? doc.body.innerText : htmlText;
          text = (meta && meta.content ? meta.content + "\n\n" : "") + bodyText.replace(/\s+/g, " ").slice(0, 20000);
        } catch (e) { busy(false); return toast("抓取失败（跨域限制）：请手动粘贴正文后再入库"); }
        finally { busy(false); }
      }
      if (!text) return toast("无正文内容可入库");
      const entry = KB.parseExternal(title + ".md", text);
      await KB.put(entry);
      kbLog("网页入库", { url, title });
      toast("已入库：" + entry.title);
      closeModal();
    };
  }

  // 供 ai.js 注入 KB 上下文（让模型可读知识库）+ Hermes 学习钩子（v2.4.6：切片级智能检索，段落更精准）
  window.__kbContext = async (q) => {
    if (!kbReady()) return "";
    try {
      const r = await KB.smartQuery(q, 8);   // 切片级混合检索 → 精准片段，避免整篇塞入
      window.__kbLocalHit = !!r.length;
      return r.map((x) => "# " + (x.title || "") + (x.tags && x.tags.length ? "（" + x.tags.join("、") + "）" : "") + "\n" + (x.chunk || "")).join("\n\n---\n\n");
    } catch (e) { return ""; }
  };
  window.__kbMemoryContext = async () => { if (!kbReady() || !KB.memory) return ""; try { const m = await KB.memory(); return m ? "# 自我学习记忆（Hermes）\n" + m.slice(-2000) : ""; } catch (e) { return ""; } };
  window.__hermesNote = (kind, text) => { if (kbReady() && KB.hermes) { KB.hermes("[" + kind + "] " + String(text || "").slice(0, 200)).catch(() => {}); } };

  // ---------- 启动 ----------
  window.APP = { edit: openEdit, shareBuilding,   /* v2.4.3 修复：气泡「分享」按钮 onclick=\"APP.shareBuilding()\" 长期未导出 → 点击即 script error */ del, openPhoto, viewPhotos: openPhotoCycle, navigate, nearCenter, close: closeModal, back,
    receivePhoto, receiveSheet, receiveDone, receiveError, receiveCancel, onExportResult };
  // v2.4.3：暴露 ai.js 依赖的全局 helper（三端保持一致）。
  // 否则 AI 智能查询/更新/纠错/对话/历史等菜单调用 openModal/el/toast 会抛 ReferenceError → 表现为 script error
  window.el = el;
  window.__getRecords = function () { return records; };  // v2.4.3：journal.js 绑定建筑物/设备列表用
  window.__APP_VER__ = APP_VER;   // v2.4.3：upgrade.js 版本兼容检查的唯一版本来源
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.toast = toast;
  window.esc = esc;
  window.busy = busy;
  // v2.4.2 启动完整性检查（智能同步优化）：检测关键函数是否定义（构建残缺/资源缺失时降级）
  (function initIntegrityCheck() {
    const required = [
      ["openOrgManager", typeof openOrgManager === "function", "机构层级管理"],
      ["openBtypeManager", typeof openBtypeManager === "function", "建筑物类型管理"],
      ["openQuickFavSettings", typeof openQuickFavSettings === "function", "快捷常用设置"],
      ["openFilter", typeof openFilter === "function", "筛选菜单"],
      ["openNearby", typeof openNearby === "function", "周边搜索"],
      ["matchOrgScope", typeof matchOrgScope === "function", "ZIP 三级匹配"],
      ["doExportPhotos", typeof doExportPhotos === "function", "导出照片"],
      ["KF", !!window.KB && typeof window.KB.retrieve === "function", "知识库引擎"],
      ["AI", !!window.AI && typeof window.AI.openQuery === "function", "AI 引擎"]
    ];
    const missing = required.filter((x) => !x[1]).map((x) => x[0]);
    window.__integrity = { missing, ok: !missing.length, ts: Date.now() };
    if (missing.length) console.warn("[integrity] missing:", missing.map((n) => required.find((r) => r[0] === n)[2]).join("、"));
  })();
  initMap();
  bindUI();
  loadUI();
  load().then(() => {
    addBasemap();
    updateLayerBtn();
    render();
    initKB();
    if (lastCenter) map.setView([lastCenter.lat, lastCenter.lng], lastCenter.zoom);
    else fitToShown();
  }).catch((e) => toast("加载失败：" + e.message));
  if ("serviceWorker" in navigator && location.protocol.startsWith("http"))
    navigator.serviceWorker.register("sw.js").catch(() => {});
  // ---------- v2.4.3 天地图密钥管理 ----------
  function openTiandituKeySettings() {
    const cur = (() => { try { return JSON.parse(localStorage.getItem("appsettings_key_v1") || "{}"); } catch (e) { return {}; } })();
    const html = `<div class="hint">天地图密钥可能过期。本页可重置浏览器端与服务端 token；保存后<b>立即生效</b>（无需刷新页面）。默认 token 用于开箱即用，重设后写到 localStorage appsettings_key_v1，原 __CONFIG__ 配置不再被读取。</div>
      <div class="field"><label>浏览器端 TIANDITU_TOKEN（前端在线底图加载）</label><input id="tdtClient" class="inp" value="" placeholder="留空则保持当前密钥 · 32位 16 进制字符串"></div>
      <div class="field"><label>服务端 TIANDITU_SERVER_TOKEN（瓦片下载脚本）</label><input id="tdtServer" class="inp" value="" placeholder="留空则保持当前密钥 · 32位 16 进制字符串"></div>
      <div class="field"><label>当前生效的 token（已隐藏，防窃取）</label><input class="inp" readonly value="客户端：••••••••••••••••    服务端：••••••••••••••••"></div>
      <div class="field"><label>复制当前密钥（需验证访问密码 <b>3305</b>）</label><input id="tdtPwd" type="password" class="inp" placeholder="输入访问密码" autocomplete="off"></div>
      <div class="hint">密钥不再明文展示；点「复制当前密钥」并在上方输入正确密码后才可复制。恢复默认：点「恢复默认」回到内置 token；点「清空保存」清空 localStorage（恢复用 __CONFIG__ 注入）。</div>`;
    openModal("天地图密钥管理", html, `<button class="btn ghost" id="tdtReset">恢复默认</button><button class="btn ghost" id="tdtClear">清空保存</button><button class="btn ghost" id="tdtCopy">复制当前密钥</button><button class="btn ghost" id="tdtCancel">取消</button><button class="btn primary" id="tdtSave">💾 保存并立即生效</button>`);
    el("tdtCancel").onclick = closeModal;
    el("tdtReset").onclick = () => {
      el("tdtClient").value = TIANDITU_DEFAULT; el("tdtServer").value = TIANDITU_SERVER_DEFAULT;
      toast("已恢复为内置默认 token");
    };
    el("tdtClear").onclick = () => {
      try { localStorage.removeItem("appsettings_key_v1"); } catch (e) {}
      TIANDITU = (window.__CONFIG__ && window.__CONFIG__.TIANDITU_TOKEN) || TIANDITU_DEFAULT;
      TIANDITU_SERVER = (window.__CONFIG__ && window.__CONFIG__.TIANDITU_SERVER_TOKEN) || TIANDITU_SERVER_DEFAULT;
      try { refreshBasemap(); } catch (e) {}
      toast("已清空 localStorage，使用 __CONFIG__ 或内置 token；底图刷新中…");
      closeModal();
    };
    el("tdtSave").onclick = () => {
      const c = (el("tdtClient").value || "").trim();
      const s = (el("tdtServer").value || "").trim();
      if (c && !/^[0-9a-fA-F]{16,}$/.test(c)) return toast("客户端 token 格式不对（应为 16 进制字符串）");
      if (s && !/^[0-9a-fA-F]{16,}$/.test(s)) return toast("服务端 token 格式不对（应为 16 进制字符串）");
      const cfg = { TIANDITU_TOKEN: c || cur.TIANDITU_TOKEN || TIANDITU_DEFAULT, TIANDITU_SERVER_TOKEN: s || cur.TIANDITU_SERVER_TOKEN || TIANDITU_SERVER_DEFAULT };
      try { localStorage.setItem("appsettings_key_v1", JSON.stringify(cfg)); } catch (e) {}
      TIANDITU = cfg.TIANDITU_TOKEN; TIANDITU_SERVER = cfg.TIANDITU_SERVER_TOKEN;
      try { refreshBasemap(); } catch (e) {}
      toast("已保存并生效。底图无需刷新。" + (basemapOn ? "" : "（开启底图后生效）"));
      closeModal();
    };
    el("tdtCopy").onclick = () => {
      const pwd = (el("tdtPwd") || {}).value || "";
      if (pwd !== "3305") { toast("访问密码错误，无法复制密钥"); return; }
      const txt = "TIANDITU_TOKEN=" + (TIANDITU || "") + "\nTIANDITU_SERVER_TOKEN=" + (TIANDITU_SERVER || "");
      try { if (navigator.clipboard) navigator.clipboard.writeText(txt); } catch (e) {}
      toast("已复制当前密钥到剪贴板");
    };
  }
})();
