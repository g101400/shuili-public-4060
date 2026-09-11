/* =====================================================================
 * journal.js — 一张图家族「图文笔记引擎」（v2.4.6）
 * 古建端 = 游记；水利/感知端 = 备忘录。同源一份代码，按 window.__APP_ID__ 分流。
 * 能力：所见即所得排版（字体/字号/表情/图片/表格/列表/撤销）、绑定对象、
 *       关键词筛选（名称/记录时间/摘要）、导出(Markdown/JSON)、内容镜像进知识库供 AI 查询。
 * 依赖（均由 app.js / upgrade.js 在之前加载并暴露为全局）：
 *   window.el / openModal / closeModal / toast / window.__getRecords / window.KB
 * 自注册菜单动作到 window.__EXT_ACTS__（与 upgrade.js 同机制）。
 *
 * v2.4.6 修复（用户报「水利/感知 写备忘录 → 运行错误:script error.」）：
 *   根因 = 老版本 Android WebView / iOS 低版本 Safari 缺少下列 API，一进编辑器即抛 TypeError，
 *   而入口无 try/catch → 只表现为无堆栈的 "script error"：
 *     ① NodeList.prototype.forEach（Chrome 51+ 才有）
 *     ② Array.from（Chrome 45+）        ③ String.prototype.padStart（Chrome 57+）
 *     ④ Array.prototype.find（Chrome 45+） ⑤ IDBObjectStore.getAll（Chrome 48+）
 *   另修：列表渲染 e.text 缺失（跨设备导入条目）时 .slice 崩溃。
 *   全部改为 ES5 等价实现 + 入口 guard（失败时 toast 真实原因并写入错误日志，不再只报 script error）。
 * ===================================================================== */
(function (global) {
  "use strict";

  var APP_ID = global.__APP_ID__ || "gujian";
  // 依赖缺失不再静默兜底（v2.4.6）：旧版 `global.openModal || function(){}` 会在依赖未就绪时
  // 假装成功（弹窗不出现），随后 el("jrBody") 为 null 抛 TypeError → 只表现为无堆栈的 "script error"。
  // 改为 fail-loud：明确告知「主程序未就绪」，用户一眼能看懂，且错误日志有据可查。
  function need(name, fn) {
    if (typeof fn !== "function") throw new Error("主程序依赖未就绪：window." + name + " 未导出（请重启应用；若持续出现请复制错误日志反馈）");
    return fn;
  }
  var el = function (id) { return (global.el || function (x) { return document.getElementById(x); })(id); };
  var openModal = function () { return need("openModal", global.openModal).apply(null, arguments); };
  var closeModal = function () { return need("closeModal", global.closeModal).apply(null, arguments); };
  var toast = function () { return need("toast", global.toast).apply(null, arguments); };
  var KB = global.KB || null;

  // 三端差异化配置（由平台标识决定）
  var CFG = ({
    gujian: { kind: "journal", label: "游记", objLabel: "古建", acts: { write: "writeJournal", export: "exportJournal" } },
    shuili: { kind: "memo", label: "备忘录", objLabel: "建筑物", acts: { write: "writeMemo", export: "exportMemo" } },
    shipin: { kind: "memo", label: "备忘录", objLabel: "感知设备", acts: { write: "writeMemo", export: "exportMemo" } }
  })[APP_ID] || { kind: "memo", label: "备忘录", objLabel: "对象", acts: { write: "writeMemo", export: "exportMemo" } };

  // ---------- 小工具（全部 ES5 安全，不依赖 NodeList.forEach / padStart / Array.from / find）----------
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function stripHtml(html) { var d = document.createElement("div"); d.innerHTML = html || ""; return (d.textContent || "").replace(/\s+/g, " ").trim(); }
  function uid() { return CFG.kind + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function nowISO() { return new Date().toISOString(); }
  function dateOnly(iso) { return (iso || "").slice(0, 10); }
  function pad2(n) { n = Number(n) || 0; return (n < 10 ? "0" : "") + n; }              // ③ 替代 String.padStart
  function each(list, fn) { if (!list) return; if (list.forEach) { list.forEach(fn); return; } for (var i = 0; i < list.length; i++) fn(list[i], i); } // ① 替代 NodeList.forEach
  function findIn(arr, pred) { for (var i = 0; i < (arr || []).length; i++) { if (pred(arr[i], i)) return arr[i]; } return null; }                        // ④ 替代 Array.find
  function times(n, fn) { var out = []; for (var i = 0; i < n; i++) out.push(fn(i)); return out; }                                                        // ② 替代 Array.from({length:n})
  function fmtTime(iso) {
    try { var d = new Date(iso); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
    catch (e) { return iso || ""; }
  }
  // 统一错误出口：真实原因 toast + 写入错误日志（v2.4.4 环形缓冲），不再只报 script error
  function fail(where, e) {
    var msg = (e && (e.message || e)) ? (e.message || String(e)) : String(e);
    try { if (global.__ERR_LOG_PUSH__) global.__ERR_LOG_PUSH__("[journal:" + where + "] " + msg + (e && e.stack ? "\n" + String(e.stack).split("\n").slice(0, 3).join("\n") : "")); } catch (_) {}
    try { if (global.console) console.error("[journal:" + where + "]", e); } catch (_) {}
    try { toast(CFG.label + "操作失败：" + msg + "（可在「信息与帮助→错误日志」复制反馈）"); } catch (_) {
      try { alert(CFG.label + "操作失败：" + msg); } catch (_2) {}    // 依赖彻底缺失时至少让用户看见
    }
  }
  function guard(where, fn) { return function () { try { return fn.apply(null, arguments); } catch (e) { fail(where, e); } }; }

  // ---------- IndexedDB（独立库，不污染 delta）----------
  var DB = "yz_" + APP_ID + "_journal_v1";
  var STORE = "journal";
  var _dbp = null;
  function open() {
    if (_dbp) return _dbp;
    _dbp = new Promise(function (res, rej) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
    return _dbp;
  }
  function tx(mode) { return open().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); }); }
  function jget(id) { return tx("readonly").then(function (os) { return new Promise(function (res, rej) { var r = os.get(id); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { rej(r.error); }; }); }); }
  // ⑤ 不用 os.getAll（Chrome 48+ 才有），游标遍历兼容老 WebView
  function jall() {
    return tx("readonly").then(function (os) {
      return new Promise(function (res, rej) {
        if (os.getAll) { var g = os.getAll(); g.onsuccess = function () { res(g.result || []); }; g.onerror = function () { rej(g.error); }; return; }
        var out = [];
        var c = os.openCursor();
        c.onsuccess = function () { var cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
        c.onerror = function () { rej(c.error); };
      });
    });
  }
  function jput(e) { return tx("readwrite").then(function (os) { return new Promise(function (res, rej) { var r = os.put(e); r.onsuccess = function () { res(e); }; r.onerror = function () { rej(r.error); }; }); }); }
  function jdel(id) { return tx("readwrite").then(function (os) { return new Promise(function (res, rej) { var r = os.delete(id); r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); }; }); }); }

  // ---------- 知识库镜像（让智能AI可查询；按 id 幂等，导入不重复）----------
  function mirrorKB(e) {
    if (!KB || !KB.put) return Promise.resolve();
    try {
      var md = (e.title ? "# " + e.title + "\n\n" : "") + stripHtml(e.html);
      return KB.put({
        id: "journal:" + e.id, type: CFG.kind,
        title: (e.title || e.objName || CFG.label) + (e.objName ? " · " + e.objName : ""),
        tags: [CFG.label, e.objName || "", e.objOrg || ""].filter(Boolean),
        md: md, meta: { objId: e.objId, objName: e.objName, time: e.time, kind: CFG.kind }
      }).catch(function () {});     // 知识库未就绪不影响笔记保存
    } catch (_) { return Promise.resolve(); }
  }
  function unmirrorKB(id) { if (KB && KB.del) { try { return KB.del("journal:" + id).catch(function () {}); } catch (_) {} } return Promise.resolve(); }

  // 对外统一 API（upgrade.js 的 collect/apply 会用到 .all / .bulkPut）
  global.Journal = {
    all: jall,
    get: jget,
    put: function (e) { return jput(e).then(function () { return mirrorKB(e); }).then(function () { return e; }); },
    del: function (id) { return jdel(id).then(function () { return unmirrorKB(id); }); },
    bulkPut: function (arr, replace) {
      return tx("readwrite").then(function (os) {
        return new Promise(function (res, rej) {
          try {
            if (replace) os.clear();
            var list = arr || [];
            for (var i = 0; i < list.length; i++) { os.put(list[i]); mirrorKB(list[i]); }
            res(list.length);
          } catch (e) { rej(e); }
        });
      });
    }
  };

  // ====================================================================
  // 样式（仅注入一次）
  // ====================================================================
  function injectStyle() {
    if (document.getElementById("jr-style")) return;
    var s = document.createElement("style");
    s.id = "jr-style";
    s.textContent = [
      ".jr-wrap{display:flex;flex-direction:column;gap:10px;max-height:72vh;overflow:auto}",
      ".jr-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".jr-meta label{display:flex;flex-direction:column;font-size:12px;color:#9fb3c8;gap:3px}",
      ".jr-meta label.wide{grid-column:1/3}",
      ".jr-meta input,.jr-meta select{background:#0f1b2d;border:1px solid #244;color:#e7eef6;border-radius:7px;padding:7px 8px;font-size:14px}",
      ".jr-toolbar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;background:#0d1726;border:1px solid #234;border-radius:8px;padding:6px}",
      ".jr-toolbar button,.jr-toolbar select{background:#16263b;color:#dce8f4;border:1px solid #2c4055;border-radius:6px;padding:5px 8px;font-size:13px;cursor:pointer;line-height:1.2}",
      ".jr-toolbar button:hover{background:#1d3450}",
      ".jr-toolbar .b{font-weight:700}", ".jr-toolbar .i{font-style:italic}", ".jr-toolbar .u{text-decoration:underline}",
      ".jr-body{background:#fff;color:#16202c;border:1px solid #2c4055;border-radius:8px;padding:12px;min-height:200px;max-height:42vh;overflow:auto;font-size:15px;line-height:1.6}",
      ".jr-body:focus{outline:2px solid #2f81f7}",
      ".jr-body table.jr-tbl{border-collapse:collapse;margin:6px 0}",
      ".jr-body table.jr-tbl td,.jr-body table.jr-tbl th{border:1px solid #999;padding:4px 8px}",
      ".jr-body img{max-width:100%;border-radius:6px;margin:4px 0}",
      ".jr-emoji-pop{position:absolute;z-index:60;background:#16263b;border:1px solid #2c4055;border-radius:8px;padding:6px;display:grid;grid-template-columns:repeat(6,1fr);gap:3px;max-width:240px}",
      ".jr-emoji-pop span{cursor:pointer;font-size:18px;text-align:center;padding:2px;border-radius:5px}",
      ".jr-emoji-pop span:hover{background:#1d3450}",
      ".jr-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center}",
      ".jr-foot .cnt{margin-right:auto;color:#8aa0b6;font-size:12px}",
      ".jr-list{display:flex;flex-direction:column;gap:8px;max-height:70vh;overflow:auto}",
      ".jr-item{display:flex;gap:10px;align-items:flex-start;background:#0d1726;border:1px solid #234;border-radius:9px;padding:10px}",
      ".jr-item input[type=checkbox]{margin-top:4px;width:16px;height:16px}",
      ".jr-item .info{flex:1;min-width:0}",
      ".jr-item .t{font-weight:600;color:#e7eef6;font-size:14px}",
      ".jr-item .m{color:#8aa0b6;font-size:12px;margin-top:2px}",
      ".jr-item .s{color:#6f8298;font-size:12px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}",
      ".jr-item .ops{display:flex;flex-direction:column;gap:4px}",
      ".jr-item .ops button{background:#16263b;color:#cfe;border:1px solid #2c4055;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}",
      ".jr-empty{color:#7d93a8;text-align:center;padding:24px 0}",
      ".jr-export textarea{width:100%;height:46vh;background:#0a1320;color:#d7e6f2;border:1px solid #234;border-radius:8px;padding:10px;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace;resize:vertical}",
      ".jr-kw{width:100%;background:#0f1b2d;border:1px solid #244;color:#e7eef6;border-radius:7px;padding:8px;font-size:14px;margin-bottom:8px}"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ====================================================================
  // 编辑器（所见即所得）
  // ====================================================================
  var EMOJIS = ["😀","😁","😂","🤣","😊","😍","😘","😎","🤔","😴","😭","😡","👍","👎","👏","🙏","💪","🎉","❤️","🔥","⭐","✅","❌","⚠️","📌","📍","📷","🌟","💡","📝","🚀","🌈"];
  var FONTS = ["", "Microsoft YaHei", "SimSun", "KaiTi", "SimHei", "Arial", "Georgia", "Courier New"];
  var SIZES = [["", "字号"], ["x-small", "小"], ["small", "较小"], ["medium", "中"], ["large", "大"], ["x-large", "较大"], ["xx-large", "特大"]];

  function bindOptions() {
    var recs = (global.__getRecords ? global.__getRecords() : []) || [];
    return recs.map(function (r) {
      return { id: r.id, name: r.name || "(无名)", org: r.org || r.station || r.city || r.province || "" };
    });
  }

  // ====================================================================
  // 列表 / 筛选 / 导出
  // ====================================================================
  var openList = guard("openList", function () {
    injectStyle();
    jall().then(function (list) {
      list = (list || []).slice().sort(function (a, b) { return String(b.updated || "").localeCompare(String(a.updated || "")); });
      var body = '<div class="jr-list-wrap">' +
        '<input class="jr-kw" id="jrKw" placeholder="关键词筛选（' + CFG.objLabel + '名称 / 标题摘要 / 记录时间）">' +
        '<div class="jr-list" id="jrList"></div>' +
        "</div>";
      var foot = '<button class="btn ghost" id="jrClose">关闭</button>' +
        '<button class="btn ghost" id="jrSelAll">全选</button>' +
        '<button class="btn" id="jrExpMd">导出 Markdown</button>' +
        '<button class="btn" id="jrExpJson">导出 JSON</button>' +
        '<button class="btn" id="jrExpDoc">导出 Word</button>' +
        '<button class="btn" id="jrExpPdf">导出 PDF</button>';
      openModal("我的" + CFG.label + "（" + list.length + "）", body, foot);

      function render() {
        var kwEl = el("jrKw");
        var kw = ((kwEl && kwEl.value) || "").trim().toLowerCase();
        var items = list.filter(function (e) {
          if (!kw) return true;
          return ((e.objName || "") + " " + (e.title || "") + " " + (e.text || stripHtml(e.html)) + " " + (e.time || "")).toLowerCase().indexOf(kw) >= 0;
        });
        var box = el("jrList");
        if (!box) return;
        if (!items.length) { box.innerHTML = '<div class="jr-empty">暂无' + CFG.label + '，或没有匹配关键词的内容</div>'; return; }
        box.innerHTML = items.map(function (e) {
          // ⑥ e.text 可能缺失（跨设备导入/旧条目），统一兜底
          var sum = e.text != null ? e.text : stripHtml(e.html);
          return '<div class="jr-item">' +
            '<input type="checkbox" class="jr-chk" data-id="' + esc(e.id) + '" checked>' +
            '<div class="info"><div class="t">' + esc(e.title || (sum ? sum.slice(0, 24) : "(无标题)")) + "</div>" +
            '<div class="m">' + (e.objName ? "绑定" + CFG.objLabel + "：" + esc(e.objName) + " · " : "") + "记录时间 " + esc(dateOnly(e.time)) + " · 更新 " + esc(fmtTime(e.updated)) + "</div>" +
            '<div class="s">' + esc(String(sum || "").slice(0, 80)) + "</div></div>" +
            '<div class="ops"><button data-edit="' + esc(e.id) + '">编辑</button><button data-del="' + esc(e.id) + '">删除</button></div>' +
            "</div>";
        }).join("");
        each(box.querySelectorAll("[data-edit]"), function (b) { b.addEventListener("click", function () { closeModal(); openWriter(b.getAttribute("data-edit")); }); });
        each(box.querySelectorAll("[data-del]"), function (b) { b.addEventListener("click", function () { delOne(b.getAttribute("data-del")); }); });
      }
      function selected() {
        var box = el("jrList"); if (!box) return [];
        return list.filter(function (e) {
          var cb = box.querySelector('.jr-chk[data-id="' + cssEsc(e.id) + '"]');
          return cb && cb.checked;
        });
      }
      function delOne(id) {
        if (!global.confirm || confirm("确定删除这条" + CFG.label + "？")) {
          global.Journal.del(id).then(function () { list = list.filter(function (x) { return x.id !== id; }); render(); toast("已删除"); }).catch(function (e) { fail("del", e); });
        }
      }
      var kwEl0 = el("jrKw"); if (kwEl0) kwEl0.addEventListener("input", render);
      bind("jrClose", "click", function () { closeModal(); });
      bind("jrSelAll", "click", function () { each(el("jrList").querySelectorAll(".jr-chk"), function (c) { c.checked = true; }); });
      bind("jrExpMd", "click", function () { doExport(selected(), "md"); });
      bind("jrExpJson", "click", function () { doExport(selected(), "json"); });
      bind("jrExpDoc", "click", function () { doExport(selected(), "doc"); });
      bind("jrExpPdf", "click", function () { doExport(selected(), "pdf"); });
      render();
    }).catch(function (e) { fail("load", e); });
  });

  // 元素可能不存在（弹窗被替换/老 WebView 渲染慢）→ 静默跳过而非抛错
  function bind(id, ev, fn) { var n = el(id); if (n) n.addEventListener(ev, guard(id, fn)); }

  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  var doExport = guard("doExport", function (items, fmt) {
    if (!items.length) { toast("请先勾选要导出的内容"); return; }
    var ts = new Date().toISOString().slice(0, 10);
    if (fmt === "json") {
      var data = { magic: "YZT-JOURNAL", kind: CFG.kind, app: APP_ID, exportedAt: nowISO(), items: items };
      showExport(JSON.stringify(data, null, 2), "json", "我的" + CFG.label + "_" + ts + ".json");
      return;
    }
    if (fmt === "doc") {
      var dn = "我的" + CFG.label + "_" + ts + ".doc";
      downloadText(dn, jrDocHtml("我的" + CFG.label, jrArticleHtml(items)), "application/msword");
      toast("已导出 Word：" + dn);
      return;
    }
    if (fmt === "pdf") {
      jrPreviewDoc("我的" + CFG.label, jrArticleHtml(items), true);
      toast("已打开打印预览：在打印对话框里选「另存为 PDF」即可导出 PDF");
      return;
    }
    var md = "# 我的" + CFG.label + "（" + items.length + " 条 · 导出 " + ts + "）\n\n";
    items.forEach(function (e, i) {
      var sum = e.text != null ? e.text : (e.html ? htmlToMdFallback(e.html) : "");
      md += "## " + (i + 1) + ". " + (e.title || "(无标题)") + "\n";
      if (e.objName) md += "- 绑定" + CFG.objLabel + "：" + e.objName + (e.objOrg ? "（" + e.objOrg + "）" : "") + "\n";
      md += "- 记录时间：" + dateOnly(e.time) + "\n";
      md += "\n" + sum + "\n\n---\n\n";
    });
    showExport(md, "md", "我的" + CFG.label + "_" + ts + ".md");
  });

  // v2.4.9-D：备忘录 / 运维记录 / 游记 → Word(.doc) / PDF（打印后另存为 PDF）
  function jrArticleHtml(items) {
    var h = "";
    each(items, function (e, i) {
      h += "<h2>" + (i + 1) + ". " + esc(e.title || "(无标题)") + "</h2>";
      h += '<p class="meta">' + (e.objName ? "绑定" + CFG.objLabel + "：" + esc(e.objName) : "") +
        (e.time ? "　记录时间：" + esc(dateOnly(e.time)) : "") + "</p>";
      h += (e.html && String(e.html).replace(/\s/g, "")) ? e.html : ("<p>" + esc(e.text || "") + "</p>");
      h += '<hr style="border:none;border-top:1px dashed #bbb;margin:14px 0">';
    });
    return h;
  }
  function jrDocHtml(title, body) {
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
      + '<head><meta charset="utf-8"><title>' + esc(title) + "</title>"
      + "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->"
      + '<style>@page{size:A4;margin:2cm}body{font-family:"Microsoft YaHei",SimSun,serif;font-size:14px;line-height:1.8;color:#111}'
      + 'h1{font-size:20px;text-align:center}h2{font-size:16px;margin:16px 0 6px}.meta{color:#666;font-size:12px;margin:0 0 8px}'
      + 'img{max-width:100%}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:5px 8px;font-size:13px}</style></head>'
      + "<body><h1>" + esc(title) + "</h1>" + body + "</body></html>";
  }
  function downloadText(name, text, mime) {
    try {
      var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
      var url = URL.createObjectURL(blob); var a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (_) {} }, 1500);
    } catch (e) { toast("本环境不支持直接下载，请用「复制全部」"); }
  }
  function jrPreviewDoc(title, body, autoPrint) {
    var w = window.open("", "_blank");
    if (!w) { toast("浏览器拦截了新窗口，请允许弹窗后重试"); return; }
    var btn = '<div style="position:fixed;right:16px;bottom:16px;z-index:9">'
      + '<button onclick="window.print()" style="padding:10px 16px;font-size:14px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer">打印 / 另存为 PDF</button></div>';
    w.document.write(jrDocHtml(title, body) + btn);
    w.document.close();
    if (autoPrint) { try { w.focus(); setTimeout(function () { try { w.print(); } catch (_) {} }, 350); } catch (_) {} }
  }

  function htmlToMdFallback(html) { var d = document.createElement("div"); d.innerHTML = html || ""; return (d.innerText || d.textContent || "").replace(/\n{3,}/g, "\n\n").trim(); }

  var showExport = guard("showExport", function (text, ext, fname) {
    var body = '<div class="jr-export"><textarea id="jrExpArea" readonly>' + esc(text) + "</textarea></div>";
    var foot = '<button class="btn ghost" id="jrCopy">复制全部</button>' +
      '<button class="btn" id="jrDownload">下载 .' + ext + "</button>" +
      '<button class="btn ghost" id="jrBack">返回</button>';
    openModal("导出" + CFG.label + "（" + ext.toUpperCase() + "）", body, foot);
    bind("jrCopy", "click", function () {
      var ta = el("jrExpArea"); if (!ta) return;
      ta.select();
      try { document.execCommand("copy"); toast("已复制"); }
      catch (e) { if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(function () { toast("已复制"); }); else toast("复制失败，请长按全选手动复制"); }
    });
    bind("jrDownload", "click", function () {
      try {
        var blob = new Blob([text], { type: "text/" + (ext === "json" ? "plain" : "markdown") + ";charset=utf-8" });
        var url = URL.createObjectURL(blob); var a = document.createElement("a"); a.href = url; a.download = fname; document.body.appendChild(a); a.click();
        setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (_) {} }, 1000);
        toast("已导出：" + fname);
      } catch (e) { toast("本环境不支持直接下载，请用「复制全部」"); }
    });
    bind("jrBack", "click", function () { openList(); });
  });

  // ---------- 图片缩放（避免原图撑爆 IndexedDB）----------
  function fileToScaledDataURL(file, max) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var sc = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
            var c = document.createElement("canvas");
            c.width = Math.max(1, (img.width * sc) | 0); c.height = Math.max(1, (img.height * sc) | 0);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            try { res(c.toDataURL("image/jpeg", 0.82)); } catch (e) { rej(e); }
          } catch (e) { rej(e); }
        };
        img.onerror = rej; img.src = fr.result;
      };
      fr.onerror = rej; fr.readAsDataURL(file);
    });
  }

  // ====================================================================
  // 菜单自注册（入口 guard：任何异常 → toast 真实原因 + 写错误日志，不再裸 script error）
  // ====================================================================
  global.__EXT_ACTS__ = global.__EXT_ACTS__ || {};
  global.__EXT_ACTS__[CFG.acts.write] = guard("write", function (editId) {
    if (editId) { jget(editId).then(function (e) { openWriter(e || null); }).catch(function (err) { fail("write.load", err); }); }
    else openWriter(null);
  });
  global.__EXT_ACTS__[CFG.acts.export] = function () { openList(); };

  var openWriter = guard("openWriter", function (editing) {
    injectStyle();
    var opts = bindOptions();
    var optHtml = '<option value="">（不绑定）</option>' + opts.map(function (o) { return '<option value="' + esc(o.id) + '"' + (editing && editing.objId === o.id ? " selected" : "") + ">" + esc(o.name) + (o.org ? " · " + esc(o.org) : "") + "</option>"; }).join("");
    var fontOpts = FONTS.map(function (f, i) { return '<option value="' + esc(f) + '">' + (i === 0 ? "字体" : f) + "</option>"; }).join("");
    var sizeOpts = SIZES.map(function (s) { return '<option value="' + esc(s[0]) + '">' + s[1] + "</option>"; }).join("");
    var body =
      '<div class="jr-wrap">' +
        '<div class="jr-meta">' +
          '<label>绑定' + CFG.objLabel + '<select id="jrBind">' + optHtml + "</select></label>" +
          '<label>记录时间<input type="date" id="jrTime" value="' + (editing ? dateOnly(editing.time) : dateOnly(nowISO())) + '"></label>' +
          '<label class="wide">标题 / 摘要（用于关键词检索）<input id="jrTitle" placeholder="一句话摘要" value="' + esc(editing ? (editing.title || "") : "") + '"></label>' +
        "</div>" +
        '<div class="jr-toolbar">' +
          '<select id="jrFont">' + fontOpts + "</select>" +
          '<select id="jrSize">' + sizeOpts + "</select>" +
          '<button type="button" class="b" data-cmd="bold">B</button>' +
          '<button type="button" class="i" data-cmd="italic">I</button>' +
          '<button type="button" class="u" data-cmd="underline">U</button>' +
          '<button type="button" data-cmd="foreColor" data-val="#e11d48">🔴</button>' +
          '<button type="button" data-cmd="foreColor" data-val="#2563eb">🔵</button>' +
          '<button type="button" id="jrEmoji">😊</button>' +
          '<button type="button" id="jrImg">🖼图片</button>' +
          '<button type="button" id="jrTable">▦表格</button>' +
          '<button type="button" data-cmd="insertUnorderedList">•列表</button>' +
          '<button type="button" data-cmd="undo">↶</button>' +
          '<button type="button" data-cmd="redo">↷</button>' +
          '<button type="button" data-cmd="removeFormat">清除</button>' +
        "</div>" +
        '<div id="jrBody" class="jr-body" contenteditable="true" spellcheck="false">' + (editing ? editing.html : "") + "</div>" +
        '<input type="file" id="jrFile" accept="image/*" style="display:none">' +
      "</div>";
    var foot = '<span class="cnt" id="jrCnt"></span><button class="btn ghost" id="jrCancel">取消</button><button class="btn" id="jrSave">' + (editing ? "保存修改" : "保存" + CFG.label) + "</button>";
    openModal((editing ? "编辑" : "写") + CFG.label, body, foot);
    wireEditor(opts, editing);
  });

  var wireEditor = guard("wireEditor", function (opts, editing) {
    var bd = el("jrBody");
    if (!bd) throw new Error("编辑器容器未渲染（#jrBody 缺失）");
    function upd() { var c = el("jrCnt"); if (c) c.textContent = "字数 " + ((bd.textContent || "").length); }
    upd();
    var bar = bd.parentNode ? bd.parentNode.querySelectorAll(".jr-toolbar [data-cmd]") : [];
    each(bar, function (b) {
      b.addEventListener("click", guard("cmd", function () {
        try { bd.focus(); } catch (_) {}
        try { document.execCommand(b.getAttribute("data-cmd"), false, b.getAttribute("data-val") || null); } catch (e) {}
        upd();
      }));
    });
    bind("jrFont", "change", function () { if (this.value) { try { bd.focus(); } catch (_) {} try { document.execCommand("styleWithCSS", false, true); document.execCommand("fontName", false, this.value); } catch (e) {} } });
    bind("jrSize", "change", function () { if (this.value) { try { bd.focus(); } catch (_) {} try { document.execCommand("fontSize", false, this.value); } catch (e) {} } });
    bind("jrEmoji", "click", function (ev) {
      var pop = document.createElement("div"); pop.className = "jr-emoji-pop";
      each(EMOJIS, function (em) {
        var sp = document.createElement("span"); sp.textContent = em;
        sp.addEventListener("click", guard("emoji", function () {
          try { bd.focus(); } catch (_) {}
          try { document.execCommand("insertText", false, em); } catch (e) { try { document.execCommand("insertHTML", false, em); } catch (e2) {} }
          upd(); pop.remove();
        }));
        pop.appendChild(sp);
      });
      pop.style.left = ((ev && ev.clientX ? ev.clientX : 60) - 120) + "px";
      pop.style.top = ((ev && ev.clientY ? ev.clientY : 60) + 20) + "px";
      document.body.appendChild(pop);
      setTimeout(function () { document.addEventListener("click", function h() { try { pop.remove(); } catch (_) {} document.removeEventListener("click", h); }); }, 0);
    });
    bind("jrImg", "click", function () { var f = el("jrFile"); if (f) f.click(); else toast("本环境不支持插入图片"); });
    bind("jrFile", "change", function () {
      var f = this.files && this.files[0]; if (!f) return;
      var self = this;
      fileToScaledDataURL(f, 1280).then(function (url) {
        try { bd.focus(); } catch (_) {}
        try { document.execCommand("insertImage", false, url); } catch (e) { try { document.execCommand("insertHTML", false, '<img src="' + url + '">'); } catch (e2) {} }
        upd();
      }).catch(function () { toast("图片读取失败，请换一张或缩小后重试"); });
      self.value = "";
    });
    bind("jrTable", "click", function () {
      try { bd.focus(); } catch (_) {}
      var row = "<tr>" + times(3, function () { return '<td style="min-width:56px;height:26px;padding:5px">&nbsp;</td>'; }).join("") + "</tr>";
      var t = '<table class="jr-tbl"><tbody>' + times(3, function () { return row; }).join("") + "</tbody></table><p><br></p>";
      try { document.execCommand("insertHTML", false, t); } catch (e) {}
    });
    bind("jrCancel", "click", function () { closeModal(); });
    bind("jrSave", "click", function () {
      var html = bd.innerHTML || "";
      var text = stripHtml(html);
      var tEl = el("jrTitle");
      var title = ((tEl && tEl.value) || "").trim();
      if (!text && !title) { toast("请先写点内容"); return; }
      var bEl = el("jrBind"), tmEl = el("jrTime");
      var bindId = bEl ? bEl.value : "";
      var bindName = "", bindOrg = "";
      if (bindId) { var o = findIn(opts, function (x) { return x.id === bindId; }); if (o) { bindName = o.name; bindOrg = o.org; } }
      var now = nowISO();
      var entry = {
        id: editing ? editing.id : uid(), kind: CFG.kind, objId: bindId || "", objName: bindName, objOrg: bindOrg,
        title: title, html: html, text: text, imgs: (html.match(/<img/g) || []).length,
        time: ((tmEl && tmEl.value) || dateOnly(now)) + "T00:00:00.000Z",
        created: editing ? editing.created : now, updated: now
      };
      global.Journal.put(entry).then(function () {
        closeModal();
        toast(CFG.label + "已保存" + (bindName ? "（绑定：" + bindName + "）" : ""));
      }).catch(function (e) { fail("save", e); });
    });
  });

  if (global.console) console.log("[journal] loaded for " + APP_ID + " as " + CFG.label + " (v2.4.6 hardened)");
})(window);
