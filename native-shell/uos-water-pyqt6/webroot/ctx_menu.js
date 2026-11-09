/* =============================================================================
 * ctx_menu.js — 通用「右键上下文菜单 + 智能功能」（三端四平台共享，参数化）
 * 通过 window.CtxMenu.init(cfg) 适配场景：
 *   cfg = {
 *     map:            Leaflet map 实例,
 *     records:        function() 返回当前数据数组（用于列表定位查记录）,
 *     textFields:     ["intro","features",...] 智能补全可填的描述性字段（离线产品传 []）,
 *     getCoordinates: function() 获取坐标（宿主局部函数，经 cfg 传入）,
 *     nearbySearch:   function() 周边搜索（宿主局部函数，经 cfg 传入）
 *   }
 * 右键触发：
 *   地图空白 → 获取坐标 / 周边搜索 / 智能描述此地
 *   标注(marker) → 导航 / 打卡 / 修改 / 智能补全 / 删除
 *   列表卡片 → 在地图定位 / 导航 / 智能补全
 * 依赖：window.AIModule.ask（ai_module.js 提供）；app 既有 .sheet/.busy 样式。
 * ========================================================================== */
(function (global) {
  "use strict";

  var CFG = null;
  var menuEl = null;

  /* ---------- 自包含 UI 工具 ---------- */
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (t) { t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200); }
  }
  function busy(on) {
    var el = document.getElementById("busyOverlay");
    if (!el) {
      el = document.createElement("div"); el.id = "busyOverlay";
      el.innerHTML = '<div class="busy-box"><div class="busy-spin"></div><div class="busy-msg">请稍后…</div></div>';
      (document.getElementById("app") || document.body).appendChild(el);
    }
    el.classList.toggle("show", !!on);
  }
  function showText(title, txt) {
    var ov = document.getElementById("ctxTextOverlay");
    if (!ov) {
      ov = document.createElement("div"); ov.id = "ctxTextOverlay"; ov.className = "sheet";
      ov.innerHTML = '<div class="sheet-head"><span id="ctxTextTitle"></span><button class="sheet-close" onclick="this.parentNode.parentNode.style.display=\'none\'">✕</button></div>' +
        '<div class="sheet-body" id="ctxTextBody" style="white-space:pre-wrap;line-height:1.7;max-height:70vh;overflow:auto"></div>';
      (document.getElementById("app") || document.body).appendChild(ov);
    }
    document.getElementById("ctxTextTitle").textContent = title;
    document.getElementById("ctxTextBody").textContent = txt || "";
    ov.style.display = "block";
  }

  function ensureMenu() {
    if (menuEl) return;
    var st = document.createElement("style");
    st.textContent =
      ".ctx-menu{position:fixed;z-index:10000;background:#fff;border:1px solid #d8c9b8;border-radius:10px;" +
      "box-shadow:0 8px 28px rgba(60,40,30,.22);min-width:168px;padding:6px;display:none;font-size:14px}" +
      ".ctx-menu .ci{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:7px;cursor:pointer;color:#3a2f27}" +
      ".ctx-menu .ci:hover{background:#f3ece2}" + ".ctx-menu .ci.danger{color:#c0392b}" +
      ".ctx-menu .ci.danger:hover{background:#fbeaea}";
    document.head.appendChild(st);
    menuEl = document.createElement("div"); menuEl.id = "ctxMenu"; menuEl.className = "ctx-menu";
    (document.getElementById("app") || document.body).appendChild(menuEl);
    document.addEventListener("click", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }
  function hide() { if (menuEl) menuEl.style.display = "none"; }
  function show(x, y, items) {
    ensureMenu();
    menuEl.innerHTML = items.map(function (it, i) {
      return '<div class="ci' + (it.danger ? " danger" : "") + '" data-i="' + i + '">' + (it.ico ? "<span>" + it.ico + "</span>" : "") + "<span>" + it.t + "</span></div>";
    }).join("");
    menuEl.querySelectorAll(".ci").forEach(function (el) {
      el.onclick = function (e) { e.stopPropagation(); hide(); var it = items[+el.dataset.i]; if (it && it.f) it.f(); };
    });
    menuEl.style.display = "block";
    var r = menuEl.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = window.innerWidth - r.width - 4;
    if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 4;
    menuEl.style.left = Math.max(4, x) + "px"; menuEl.style.top = Math.max(4, y) + "px";
  }

  /* ---------- LLM 调用 ---------- */
  function askLLM(messages) {
    if (!global.AIModule || typeof global.AIModule.ask !== "function") return Promise.reject(new Error("智能AI 未初始化（请先到「智能AI设置」配置密钥）"));
    return global.AIModule.ask(messages);
  }

  // 智能补全：填充当前编辑表单的描述性文本字段
  function aiFill() {
    if (!CFG || !CFG.textFields || !CFG.textFields.length) { toast("当前应用无可智能补全的文本字段"); return; }
    var name = val("fName"), prov = val("fProv"), city = val("fCity"), type = val("fType");
    if (!name) { toast("请先填写名称"); return; }
    var fields = CFG.textFields;
    var known = ["名称:" + name, prov && ("省:" + prov), city && ("市:" + city), type && ("类型:" + type)].filter(Boolean).join("；");
    var prompt = "你是文物/地理资料助手。根据已知信息，补全下列字段的中文内容，仅输出一个 JSON 对象，不要任何解释或 Markdown。\n已知：" +
      known + "\n需补全字段：" + fields.join("、") +
      "\n字段说明：intro=文物介绍（40-80字），features=文物特点（30字内）。示例：{\"intro\":\"...\",\"features\":\"...\"}";
    busy(true);
    askLLM([{ role: "user", content: prompt }]).then(function (txt) {
      busy(false);
      var m = txt && txt.match(/\{[\s\S]*?\}/);
      if (!m) { toast("AI 返回无法解析"); return; }
      try {
        var obj = JSON.parse(m[0]), filled = 0;
        fields.forEach(function (k) {
          var v = obj[k]; if (v == null) return;
          var el = document.getElementById("f" + k.charAt(0).toUpperCase() + k.slice(1));
          if (el) { var cur = (el.value || "").trim(); el.value = (cur ? cur + " " : "") + String(v).trim(); filled++; }
        });
        toast(filled ? ("已智能补全 " + filled + " 个字段") : "AI 未返回可填充内容");
      } catch (e) { toast("AI 返回解析失败"); }
    }).catch(function (e) { busy(false); toast("智能补全失败：" + (e && e.message ? e.message : e)); });
  }

  // 智能描述此地（按坐标）
  function aiDescribeHere(lat, lng) {
    busy(true);
    askLLM([{ role: "user", content: "地图坐标（纬度" + lat.toFixed(4) + "，经度" + lng.toFixed(4) + "）。请简要介绍此地可能的历史、文化或地理背景（2-3 句中文，不要编造具体名称与年代）。" }])
      .then(function (txt) { busy(false); showText("智能描述此地", txt); })
      .catch(function (e) { busy(false); toast("智能描述失败：" + (e && e.message ? e.message : e)); });
  }

  /* ---------- 各场景菜单 ---------- */
  function showForMap(ll, x, y) {
    show(x, y, [
      { ico: "🎯", t: "获取坐标", f: function () { if (CFG.getCoordinates) CFG.getCoordinates(); else if (global.getCoordinates) global.getCoordinates(); } },
      { ico: "🔎", t: "周边搜索", f: function () { if (CFG.map) CFG.map.setView([ll.lat, ll.lng], CFG.map.getZoom()); if (CFG.nearbySearch) CFG.nearbySearch(); else if (global.nearbySearch) global.nearbySearch(); } },
      { ico: "✨", t: "智能描述此地", f: function () { aiDescribeHere(ll.lat, ll.lng); } }
    ]);
  }
  function showForMarker(b, x, y) {
    var items = [
      { ico: "🧭", t: "导航", f: function () { global.appNav && global.appNav(b.id); } },
      { ico: "📷", t: "打卡", f: function () { global.appCheckin && global.appCheckin(b.id); } },
      { ico: "✏️", t: "修改", f: function () { global.appEdit && global.appEdit(b.id); } },
      (CFG.textFields && CFG.textFields.length) ? { ico: "✨", t: "智能补全", f: function () { global.appEdit && global.appEdit(b.id); setTimeout(aiFill, 300); } } : null,
      { ico: "🗑️", t: "删除", danger: true, f: function () { global.appDel && global.appDel(b.id); } }
    ].filter(function (it) { return it; });
    show(x, y, items);
  }
  function showForList(b, x, y) {
    var items = [
      { ico: "📍", t: "在地图定位", f: function () { if (global.map && b.lat != null) global.map.setView([b.lat, b.lon], Math.max(global.map.getZoom(), 12)); } },
      { ico: "🧭", t: "导航", f: function () { global.appNav && global.appNav(b.id); } },
      (CFG.textFields && CFG.textFields.length) ? { ico: "✨", t: "智能补全", f: function () { global.appEdit && global.appEdit(b.id); setTimeout(aiFill, 300); } } : null
    ].filter(function (it) { return it; });
    show(x, y, items);
  }

  /* ---------- 初始化与 hooks ---------- */
  function init(cfg) {
    CFG = cfg || {};
    ensureMenu();
    if (CFG.map && typeof CFG.map.on === "function") {
      CFG.map.on("contextmenu", function (e) {
        var t = e.originalEvent && e.originalEvent.target;
        if (t && t.classList && t.classList.contains("leaflet-marker-icon")) return; // 标注自己处理
        if (!e.latlng) return;
        showForMap(e.latlng, e.originalEvent.clientX, e.originalEvent.clientY);
      });
    }
    var lv = document.getElementById("listView");
    if (lv) {
      lv.addEventListener("contextmenu", function (e) {
        var card = e.target.closest ? e.target.closest(".list-card") : null;
        if (!card || !card.dataset || !card.dataset.id) return;
        e.preventDefault();
        var b = (CFG.records && CFG.records().find(function (x) { return x.id === card.dataset.id; })) || null;
        if (b) showForList(b, e.clientX, e.clientY);
      });
    }
  }
  // render() 每创建一个 marker 后调用：m.on('contextmenu', ...)
  function onMarker(m, b) {
    if (!m || !b || typeof m.on !== "function") return;
    m.on("contextmenu", function (e) {
      if (e && e.originalEvent) e.originalEvent.preventDefault();
      showForMarker(b, e.originalEvent.clientX, e.originalEvent.clientY);
    });
  }

  global.CtxMenu = { init: init, onMarker: onMarker, aiFill: aiFill, aiDescribeHere: aiDescribeHere, show: show, hide: hide };
})(typeof window !== "undefined" ? window : this);
