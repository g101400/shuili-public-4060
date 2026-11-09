  /* ============ 奥维 ovobj / obj 坐标文件 导入导出 ============
     v3.30.2 新增：菜单「传输与共享」支持导入/导出奥维坐标文件。
     - ovobj：奥维私有二进制对象格式（魔数 "OviO"）。本解析器从二进制中
       提取每个对象的 (名称 + 经纬度)，转为建筑标记。
     - obj：奥维 txt/csv 坐标文本（每行 `名称,经度,纬度[,海拔]` 或空格分隔），
       纯文本，100% 可靠。 */

  // 仅「真·安卓原生 WebView」走原生桥：安卓是唯一因分区存储（content://）导致
  // 页面 <input type=file>+FileReader 无法读取文件内容的平台；其余（Windows/鸿蒙/
  // UOS/Web/iOS PWA）一律改走页面自带 <input type=file>+FileReader（legacyImport*），
  // 因为桌面壳注入的 window.Android 往往只实现"选"、不回传内容，会卡在"请选择"。
  function isAndroidNative() {
    try {
      var ua = (typeof navigator !== "undefined" && navigator.userAgent) ? navigator.userAgent : "";
      // 鸿蒙 ArkWeb 明确排除（即便 UA 兼容串含 Android，也走页面 input 稳路径）
      if (/HarmonyOS|OpenHarmony|OHOS/i.test(ua)) return false;
      // 桌面壳显式声明宿主类型（win/uos 等）一律走页面 input
      if (typeof window.__host === "string" && window.__host && window.__host !== "android") return false;
      // 显式原生安卓桥标记（如有）
      if (window.__androidBridge === true) return true;
      // 安卓 WebView userAgent 必含 Android
      if (/Android/i.test(ua)) return true;
    } catch (e) {}
    return false;
  }

  // ---- ovobj 二进制解析：ArrayBuffer -> [{name,lat,lon}] ----

  // ============ 老 WebKit/WebView 兼容：TextDecoder/TextEncoder polyfill ============
  // UOS WebKitGTK / 旧安卓 WebView 可能没有 TextDecoder/TextEncoder（ES2018+ API），
  // 缺失时手写 UTF-8 编解码，保证 ovobj 名称解析不依赖新 API。
  function fromCp(cp) {
    if (cp < 0x10000) return String.fromCharCode(cp);
    cp -= 0x10000;
    return String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
  }
  function utf8Decode(u8) {
    var out = [], i = 0, n = u8.length;
    while (i < n) {
      var b = u8[i++];
      if (b < 0x80) out.push(String.fromCharCode(b));
      else if (b < 0xE0 && i < n) out.push(String.fromCharCode(((b & 0x1F) << 6) | (u8[i++] & 0x3F)));
      else if (b < 0xF0 && i + 1 < n) out.push(String.fromCharCode(((b & 0x0F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F)));
      else if (i + 2 < n) {
        var cp = ((b & 0x07) << 18) | ((u8[i++] & 0x3F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F);
        out.push(fromCp(cp));
      }
    }
    return out.join("");
  }
  function utf8Encode(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      else {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return new Uint8Array(out);
  }
  if (typeof window.TextDecoder === "undefined") {
    window.TextDecoder = function () { this.decode = function (u8) { return utf8Decode(u8); }; };
  }
  if (typeof window.TextEncoder === "undefined") {
    window.TextEncoder = function () { this.encode = function (s) { return utf8Encode(s); }; };
  }
  // 老 WebView 兼容：Array.prototype.find/findIndex（ovobj_bridge 在 app.js 之前加载，需自带兜底）
  if (typeof Array.prototype.find !== "function") {
    Array.prototype.find = function (pred) {
      for (var i = 0; i < this.length; i++) { if (pred(this[i], i, this)) return this[i]; }
      return undefined;
    };
  }
  if (typeof Array.prototype.findIndex !== "function") {
    Array.prototype.findIndex = function (pred) {
      for (var i = 0; i < this.length; i++) { if (pred(this[i], i, this)) return i; }
      return -1;
    };
  }

  // app.js 为 IIFE，其内部符号对「全局」的 ovobj_bridge 不可见。统一经 window.__shuili 访问
  // （由 app.js 暴露：getBuildings / pickExportScope / APPNAME / getTodayStr / save / render /
  //  buildLegend / toast / $）。函数声明被提升，调用时才读 window.__shuili，故加载顺序无关。
  function __S() { return window.__shuili; }

  // 作用域桥（关键修复）：本文件是独立「全局」<script>，无法直接访问 app.js(IIFE) 内的局部符号。
  // 此处把它们映射成本文件可见的局部变量，调用时才经 window 读取（延迟求值，加载顺序无关）。
  // 缺任何一项都会在导出时抛 ReferenceError 被 window.onerror 捕获成"运行错误：script error"，
  // 或在导入时 $ 未定义被 try/catch 吞掉而"无任何提示"。
  var busy = function (m) { try { if (window.busy) window.busy(m); } catch (e) {} };
  var idle = function () { try { if (window.idle) window.idle(); } catch (e) {} };
  var busyDetail = function (m) { try { if (window.busyDetail) window.busyDetail(m); } catch (e) {} };
  var ask = function (t, m, b, cb) { try { if (window.__shuili && window.__shuili.ask) window.__shuili.ask(t, m, b, cb); } catch (e) {} };
  var toast = function (m) { try { if (window.__shuili && window.__shuili.toast) window.__shuili.toast(m); } catch (e) {} };
  var $ = function (id) { return window.__shuili ? window.__shuili.$(id) : null; };
  // 导出范围选择：水利/感知有 pickExportScope 对话框；古建无该对话框则退回「导出全部」
  function pickScope(what, cb) {
    try { if (window.__shuili && typeof window.__shuili.pickExportScope === "function") { window.__shuili.pickExportScope(what, cb); return; } } catch (e) {}
    cb(__S().getBuildings());
  }

  function parseOvobj(buf) {
    var dv = new DataView(buf);
    var bytes = new Uint8Array(buf);
    var n = bytes.length;
    if (n < 16 || !(bytes[0] === 0x4f && bytes[1] === 0x76 && bytes[2] === 0x69 && bytes[3] === 0x4f)) {
      throw new Error("不是有效的 ovobj 文件（缺少 OviO 魔数）");
    }
    // 1) 找所有合理经纬度 double 对（中国区范围，放宽以提高召回）
    var coords = [];
    for (var off = 0; off + 15 < n; off += 1) {
      var lat = dv.getFloat64(off, true);
      var lon = dv.getFloat64(off + 8, true);
      if (lat > 3 && lat < 54 && lon > 73 && lon < 136) coords.push([off, lat, lon]);
    }
    // 去重：同一对象坐标可能被不同起点重复命中（前有 00 填充），间隔 < 32 字节的跳过
    var uniq = []; var last = -100;
    coords.forEach(function (c) { if (c[0] - last >= 32) { uniq.push(c); last = c[0]; } });

    function utf8LenOk(s) {
      for (var i = 0; i < s.length; i++) {
        var cp = s.charCodeAt(i);
        if (!((cp >= 0x4e00 && cp <= 0x9fff) || cp === 0x3001 || cp === 0xff0c ||
              (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) ||
              (cp >= 0x30 && cp <= 0x39) || cp === 0x3001 || cp === 0xff08 || cp === 0xff09 ||
              cp === 0x002d || cp === 0x002f)) return false;
      }
      return true;
    }
    // 2) 对每个坐标：名称可能在其【之后】（坐标后 00 填充 + 1字节长度 + UTF8名称）
    //    也兼容【之前】（名称 UTF8 + 00 + 长度字段），两种布局都尝试。
    var out = [];
    uniq.forEach(function (c) {
      var co = c[0], lat = c[1], lon = c[2], name = null;
      // A) 名称在坐标后
      var i = co + 16; // 跳过 lat(8)+lon(8)
      while (i < Math.min(co + 64, n)) {
        // 跳过 00 填充（4字节对齐）
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 0) { i += 4; continue; }
        var L = bytes[i];
        if (L >= 2 && L <= 60) {
          var bs = bytes.subarray(i + 1, i + 1 + L);
          try {
            var s = new TextDecoder("utf-8").decode(bs);
            if (s.length >= 2 && utf8LenOk(s)) { name = s; break; }
          } catch (e) {}
        }
        i += 1;
      }
      // B) 名称在坐标前：向前找最近的「单字节长度 + 合法UTF8」
      if (!name) {
        var j = co - 1;
        while (j > Math.max(0, co - 400)) {
          var L2 = bytes[j];
          if (L2 >= 2 && L2 <= 60) {
            var bs2 = bytes.subarray(j + 1, j + 1 + L2);
            try {
              var s2 = new TextDecoder("utf-8").decode(bs2);
              if (s2.length >= 2 && utf8LenOk(s2)) { name = s2; break; }
            } catch (e) {}
          }
          j -= 1;
        }
      }
      out.push({ name: name || ("坐标点_" + (out.length + 1)), lat: lat, lon: lon });
    });
    return out;
  }

  // ---- ovobj 二进制生成（实验性·自洽格式）：[{name,lat,lon}] -> ArrayBuffer ----
  // 每个对象 = LAT(8) + LON(8) + 00填充(4) + nameLen(1) + name(N) + 00填充(4)
  // 仅含一组经纬度 double，parseOvobj 扫描可精确还原（导入无重复点）。
  // 重要：奥维原生二进制为专有格式（首对象前约有 589 字节私有头、count 字段语义不同），
  // 逆向完整复刻成本高且真机兼容性无法保证；本导出为「本应用可读」的自洽 ovobj 格式，
  // 可被本应用重新导入。跨工具/奥维原生共享请改用「导出 obj 坐标（文本）」（100% 可靠）。
  function buildOvobj(list) {
    var head = new Uint8Array(0x18); // OviO(4)+保留(8)+对象数@0x0C(4)+总大小@0x14(4)
    head.set([0x4f, 0x76, 0x69, 0x4f], 0);
    var objs = [];
    list.forEach(function (p) {
      var nb = new TextEncoder().encode(p.name || "点");
      // 对象最小 36 字节：保证相邻对象坐标间隔 ≥32，避开 parseOvobj 的去重阈值（否则短名对象会被误合并丢点）
      var o = new Uint8Array(Math.max(21 + nb.length, 36));
      var dv = new DataView(o.buffer);
      dv.setFloat64(0, p.lat, true);
      dv.setFloat64(8, p.lon, true);
      o[20] = nb.length;
      o.set(nb, 21);
      objs.push(o);
    });
    var total = head.length + objs.reduce(function (a, x) { return a + x.length; }, 0);
    var out = new Uint8Array(total);
    out.set(head, 0);
    var pos = head.length;
    objs.forEach(function (x) { out.set(x, pos); pos += x.length; });
    var dv = new DataView(out.buffer);
    dv.setInt32(0x0c, list.length, true);
    dv.setInt32(0x14, total, true);
    return out.buffer;
  }

  // ---- obj/txt 坐标文本解析：text -> [{name,lat,lon,alt}] ----
  function parseObjText(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/^[#；;]/.test(l); });
    var out = [];
    lines.forEach(function (line, idx) {
      // 支持分隔符：逗号 / 制表 / 空格（多空格）
      var parts = line.split(/[,，\t]+|\s{1,}/).filter(function (x) { return x.length; });
      if (parts.length < 3) return; // 至少 名称,经度,纬度
      var name = parts[0];
      var lon = parseFloat(parts[1]), lat = parseFloat(parts[2]);
      if (!isFinite(lat) || !isFinite(lon)) return;
      // 兼容「名称 纬度 经度」或「名称 经度 纬度」：奥维txt默认 经度,纬度（GCJ/WM）
      // 若第一个数是纬度范围(3~54)则交换（容错）
      if (lat > 73 || lat < 3) { var t = lat; lat = lon; lon = t; }
      var alt = parts.length >= 4 ? parseFloat(parts[3]) : null;
      out.push({ name: name, lat: lat, lon: lon, alt: alt });
    });
    return out;
  }
  // ---- obj/txt 坐标文本生成：[{name,lat,lon,alt}] -> text ----
  function buildObjText(list) {
    var lines = ["名称,经度,纬度,海拔"];
    list.forEach(function (p) {
      var alt = (p.alt != null && isFinite(p.alt)) ? p.alt : 0;
      lines.push([p.name || "", fmt6(p.lon), fmt6(p.lat), alt].join(","));
    });
    return lines.join("\r\n");
  }
  function fmt6(v) { return (Math.round(v * 1e6) / 1e6).toString(); }

  // ---- 通用：把解析出的坐标点转成建筑并合并 ----
  // 关键修复（v3.31.1 hotfix）：busy 遮罩必须用 try/finally 确保 idle() 一定执行，
  // 否则一旦 save/render/buildLegend 抛错，遮罩永久挂起（"文件读取中"）且异常冒泡成 "Script error"。
  function mergeCoordPoints(points, srcLabel) {
    function clearBusy() { try { if (typeof idle === "function") idle(); } catch (e) {} }
    if (!points || !points.length) {
      clearBusy();
      ask("导入结束", "未从「" + srcLabel + "」中解析出任何坐标点。", [{ t: "知道了", cls: "btn-confirm2", v: 1 }]);
      return;
    }
    busy("正在写入数据，请稍后…"); busyDetail("请勿退出");
    setTimeout(function () {
      try {
        var added = 0, upd = 0, noGeo = 0;
        points.forEach(function (p) {
          if (p.lat == null || p.lon == null || !isFinite(p.lat) || !isFinite(p.lon)) { noGeo++; return; }
          var ex = __S().getBuildings().find(function (x) {
            return x.name === p.name && x.lat != null && Math.abs(x.lat - p.lat) < 1e-4 && Math.abs(x.lon - p.lon) < 1e-4;
          });
          if (ex) { ex.lat = p.lat; ex.lon = p.lon; upd++; }
          else {
            __S().getBuildings().push({
              id: "imp" + Date.now() + "_" + added, name: p.name, office: "", station: "",
              chan: "", btype: "奥维坐标", path: "", attrs: [], photos: [], geom: "Point",
              lat: p.lat, lon: p.lon
            });
            added++;
          }
        });
        __S().save(); __S().render(); __S().buildLegend();
        ask("导入完成", "来源：" + srcLabel + "\n\n新增坐标点：" + added + " 个\n更新坐标点：" + upd + " 个" +
          (noGeo ? "\n\n注意：" + noGeo + " 个点无有效坐标" : ""), [{ t: "知道了", cls: "btn-confirm2", v: 1 }]);
        __S().toast("导入完成：新增 " + added + "，更新 " + upd);
      } catch (e) {
        try { __S().toast("写入数据出错：" + (e && (e.message || e))); } catch (e2) {}
        try { if (typeof console !== "undefined" && console.error) console.error(e); } catch (e3) {}
      } finally {
        clearBusy();
      }
    }, 40);
  }

  // ---- 导入 ovobj（安卓：readFileBase64 / pickFolder；非安卓：file input） ----
  // 关键修复（v3.31 #280 / 用户问题①）：点击菜单先弹「方式选择」对话框，明确告知 ovobj 是什么、
  // 应选中哪类文件；并新增「选择文件夹批量导入」，仿照 ovkmz 的文件夹+文件选择体验。
  function importOvobj() {
    try {
      if (isAndroidNative() && window.Android && typeof window.Android.pickFolder === "function" && typeof window.Android.readFileBase64 === "function") {
        ask("导入 ovobj（奥维坐标）",
          "ovobj 是奥维互动地图导出的「对象」坐标文件（含名称 + 经纬度）。<br>请选择导入方式：",
          [
            { t: "① 选择单个文件", cls: "btn-confirm2", v: "file" },
            { t: "② 选择文件夹（批量导入其中全部 .ovobj）", cls: "btn-confirm2", v: "folder" },
            { t: "取消", cls: "btn-cancel", v: 0 }
          ],
          function (v) {
            if (v === "file") importOvobjFile();
            else if (v === "folder") { window.__ovobjFolderImport = true; window.Android.pickFolder(".ovobj"); }
          });
        return;
      }
      if (isAndroidNative() && window.Android && typeof window.Android.pickFiles === "function" && typeof window.Android.readFileBase64 === "function") {
        importOvobjFile(); return;
      }
      legacyImportOvobj();
    } catch (e) {
      try { toast("导入 ovobj 出错：" + (e && (e.stack || e.message || e))); } catch (e2) {}
    }
  }
  // 单个文件：经原生选择器选 .ovobj，回传后由 onPickFiles 路由到 importOvobjFromPath
  function importOvobjFile() {
    try {
      window.__ovobjImport = true;
      __S().$("toast").textContent = "请选择 .ovobj 文件（奥维对象坐标）…"; __S().$("toast").classList.add("show");
      window.Android.pickFiles("*/*");
    } catch (e) {
      try { __S().toast("导入 ovobj 出错：" + (e && (e.stack || e.message || e))); } catch (e2) {}
    }
  }
  // 文件夹批量：原生 pickFolder 返回该文件夹（递归）内全部 .ovobj，逐个解析后合并
  function importOvobjFolder(list) {
    var files = (list || []).filter(function (f) { return /\.ovobj$/i.test(f.name); });
    if (!files.length) { toast("该文件夹内未找到 .ovobj 文件"); return; }
    busy("正在批量导入 " + files.length + " 个 ovobj 文件…"); busyDetail("请勿退出");
    setTimeout(function () {
      var all = [], err = 0;
      files.forEach(function (f) {
        try {
          var b64 = window.Android.readFileBase64(f.path);
          var bytes = b64ToBytes(b64);
          var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          var pts = parseOvobj(buf);
          cacheOvobjTemplate(bytes);
          all = all.concat(pts);
        } catch (e) { err++; }
      });
      try {
        mergeCoordPoints(all, files.length + " 个 ovobj" + (err ? "（" + err + " 个解析失败）" : ""));
      } catch (e) {
        try { if (typeof idle === "function") idle(); } catch (e2) {}
        try { toast("导入失败：" + (e && (e.message || e))); } catch (e3) {}
      }
    }, 40);
  }
  function legacyImportOvobj() {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".ovobj";
    inp.onchange = function () {
      var f = this.files[0]; if (!f) return;
      busy("正在导入 " + f.name + "，请稍后…");
      var r = new FileReader();
      r.onload = function () {
        try {
          var pts = parseOvobj(r.result);
          cacheOvobjTemplate(new Uint8Array(r.result)); // 缓存模板供导出
          mergeCoordPoints(pts, f.name);
        } catch (e) { idle(); toast("导入失败：" + e.message); }
      };
      r.onerror = function () { idle(); toast("读取文件失败"); };
      r.readAsArrayBuffer(f);
    };
    inp.click();
  }
  // 从已解析的 ArrayBuffer 缓存模板（定位 LAT/LON/名称偏移）
  function cacheOvobjTemplate(bytes) {
    try {
      var dv = new DataView(bytes.buffer || bytes);
      var n = bytes.length;
      // 找第一个合理坐标对作为模板锚
      for (var off = 0; off + 15 < n; off++) {
        var lat = dv.getFloat64(off, true), lon = dv.getFloat64(off + 8, true);
        if (lat > 3 && lat < 54 && lon > 73 && lon < 136) {
          // 名称在后
          var i = off + 16, nameLenOff = -1, nameOff = -1;
          while (i < Math.min(off + 64, n)) {
            if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 0) { i += 4; continue; }
            var L = bytes[i];
            if (L >= 2 && L <= 60) { nameLenOff = i; nameOff = i + 1; break; }
            i += 1;
          }
          __OVOBJ_TEMPLATE = {
            buf: bytes.slice(off, off + 300 > n ? n : off + 300), // 取坐标起的300字节作模板（含名称后结构）
            _latOff: 0, _lonOff: 8, _nameLenOff: nameLenOff - off, _nameOff: nameOff - off,
            _nameLen: (nameLenOff >= 0 ? bytes[nameLenOff] : 0) // 模板名称长度（新名超长时截断用）
          };
          return;
        }
      }
    } catch (e) {}
  }
  // 安卓端 base64 解码辅助
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // 安卓端：经 onPickFiles 路由后调用
  function importOvobjFromPath(path) {
    try {
      var b64 = window.Android.readFileBase64(path);
      var bytes = b64ToBytes(b64);
      var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      var pts = parseOvobj(buf);
      cacheOvobjTemplate(bytes);
      mergeCoordPoints(pts, path.split("/").pop());
    } catch (e) { idle(); toast("导入失败：" + e.message); }
  }
  // 安卓端：readFileBase64 的 ArrayBuffer 构造
  function parseOvobjFromBase64(b64) {
    var bytes = b64ToBytes(b64);
    var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return parseOvobj(buf);
  }

  // ---- 导出 ovobj（本应用自洽格式·实验性） ----
  // #353：fileName 可选（不含扩展名），由 app.js 对话框收集
  function exportOvobj(fileName) {
    if (!__S().getBuildings().length) { __S().toast("没有可导出的数据"); return; }
    pickScope("ovobj", function (list) {
      var pts = list.map(function (b) { return { name: b.name, lat: b.lat, lon: b.lon }; });
      try {
        var buf = buildOvobj(pts);
        var blob = new Blob([buf], { type: "application/octet-stream" });
        var base = fileName || (__S().APPNAME + "_" + __S().getTodayStr());
        var fname = base.replace(/[\\/:*?"<>|]/g, "_") + ".ovobj";
        saveBlobOrDownload(blob, fname);
        __S().toast("已导出 ovobj（本应用可读·实验性）：" + fname);
      } catch (e) { __S().toast("导出失败：" + e.message); }
    });
  }

  // ---- 导入 obj 坐标文本 ----
  function importObj() {
    try {
      if (isAndroidNative() && window.Android && typeof window.Android.pickFolder === "function" && typeof window.Android.readFileBase64 === "function") {
        ask("导入 obj 坐标（文本）",
          "obj 是坐标文本文件（每行：名称,经度,纬度[,海拔]，支持 .obj / .txt / .csv）。<br>请选择导入方式：",
          [
            { t: "① 选择单个文件", cls: "btn-confirm2", v: "file" },
            { t: "② 选择文件夹（批量导入其中全部坐标文件）", cls: "btn-confirm2", v: "folder" },
            { t: "取消", cls: "btn-cancel", v: 0 }
          ],
          function (v) {
            if (v === "file") importObjFile();
            else if (v === "folder") { window.__objFolderImport = true; window.Android.pickFolder(".obj,.txt,.csv"); }
          });
        return;
      }
      if (isAndroidNative() && window.Android && typeof window.Android.pickFiles === "function" && typeof window.Android.readFileBase64 === "function") {
        importObjFile(); return;
      }
      legacyImportObj();
    } catch (e) {
      try { toast("导入 obj 出错：" + (e && (e.stack || e.message || e))); } catch (e2) {}
    }
  }
  function importObjFile() {
    try {
      window.__objImport = true;
      $("toast").textContent = "请选择 obj / txt / csv 坐标文件…"; $("toast").classList.add("show");
      window.Android.pickFiles("*/*");
    } catch (e) {
      try { toast("导入 obj 出错：" + (e && (e.stack || e.message || e))); } catch (e2) {}
    }
  }
  function importObjFolder(list) {
    var files = (list || []).filter(function (f) { return /\.(obj|txt|csv)$/i.test(f.name); });
    if (!files.length) { toast("该文件夹内未找到 obj / txt / csv 坐标文件"); return; }
    busy("正在批量导入 " + files.length + " 个坐标文件…"); busyDetail("请勿退出");
    setTimeout(function () {
      var all = [], err = 0;
      files.forEach(function (f) {
        try {
          var b64 = window.Android.readFileBase64(f.path);
          var bytes = b64ToBytes(b64);
          var text = "";
          try { text = new TextDecoder("utf-8").decode(bytes); } catch (e) { text = atob(b64); }
          all = all.concat(parseObjText(text));
        } catch (e) { err++; }
      });
      try {
        mergeCoordPoints(all, files.length + " 个坐标文件" + (err ? "（" + err + " 个解析失败）" : ""));
      } catch (e) {
        try { if (typeof idle === "function") idle(); } catch (e2) {}
        try { toast("导入失败：" + (e && (e.message || e))); } catch (e3) {}
      }
    }, 40);
  }
  function legacyImportObj() {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".obj,.txt,.csv";
    inp.onchange = function () {
      var f = this.files[0]; if (!f) return;
      busy("正在导入 " + f.name + "，请稍后…");
      var r = new FileReader();
      r.onload = function () {
        try { mergeCoordPoints(parseObjText(String(r.result || "")), f.name); }
        catch (e) { idle(); toast("导入失败：" + e.message); }
      };
      r.onerror = function () { idle(); toast("读取文件失败"); };
      r.readAsText(f);
    };
    inp.click();
  }
  function importObjFromPath(path) {
    try {
      var b64 = window.Android.readFileBase64(path);
      var bin = atob(b64);
      var text = "";
      // 尝试 UTF-8 解码
      try {
        var bytes = b64ToBytes(b64);
        text = new TextDecoder("utf-8").decode(bytes);
      } catch (e) { text = bin; }
      mergeCoordPoints(parseObjText(text), path.split("/").pop());
    } catch (e) { idle(); toast("导入失败：" + e.message); }
  }

  // ---- 导出 obj 坐标文本 ----
  function exportObj() {
    if (!__S().getBuildings().length) { toast("没有可导出的数据"); return; }
    pickScope("obj", function (list) {
      busy("正在生成坐标文本…");
      setTimeout(function () {
        var pts = list.map(function (b) { return { name: b.name, lat: b.lat, lon: b.lon, alt: (b.alt != null ? b.alt : 0) }; });
        var text = buildObjText(pts);
        idle();
        var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        var fname = __S().APPNAME + "_" + __S().getTodayStr() + ".obj";
        saveBlobOrDownload(blob, fname);
        toast("已导出 obj 坐标：" + fname);
      }, 20);
    });
  }
  // 安卓：saveBlob(base64, name)；非安卓：blob 下载
  function saveBlobOrDownload(blob, fname) {
    if (window.Android && typeof window.Android.saveBlob === "function") {
      var r = new FileReader();
      r.onload = function () { window.Android.saveBlob(r.result, fname); };
      r.readAsDataURL(blob);
    } else {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  }

