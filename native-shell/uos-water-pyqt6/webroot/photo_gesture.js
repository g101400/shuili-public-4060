/* ===== photo_gesture.js — 图片预览交互增强（v3.68）=====
 * 电脑端：鼠标滚轮缩放、按住左键拖拽平移、双击放大/复位
 * 手机端：单指拖动平移、双指捏合缩放、双击放大、长按 600ms 弹出菜单（保存/分享/复位/关闭）
 * 适配：#lightbox #lbImg（三应用共用）；如页面存在 #photoAct 亦支持长按呼出操作条
 */
(function (global) {
  "use strict";

  var MIN = 1, MAX = 6;
  var st = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 };

  function $(id) { return document.getElementById(id); }
  function toast(m) { try { if (global.toast) global.toast(m); } catch (e) {} }

  function clampXY() {
    // 限制平移范围，避免拖出视窗外
    var img = $("lbImg"); if (!img) return;
    var w = img.clientWidth || img.offsetWidth || 0, h = img.clientHeight || img.offsetHeight || 0;
    var maxX = Math.max(0, (w * st.scale - w) / 2), maxY = Math.max(0, (h * st.scale - h) / 2);
    if (st.x > maxX) st.x = maxX; if (st.x < -maxX) st.x = -maxX;
    if (st.y > maxY) st.y = maxY; if (st.y < -maxY) st.y = -maxY;
  }
  function apply() {
    var img = $("lbImg"); if (!img) return;
    clampXY();
    img.style.transform = "translate(" + st.x + "px," + st.y + "px) scale(" + st.scale + ")";
    img.style.transformOrigin = "center center";
    img.style.cursor = st.dragging ? "grabbing" : (st.scale > 1 ? "grab" : "default");
    var ind = $("lbZoom"); if (ind) ind.textContent = Math.round(st.scale * 100) + "%";
    if (global.__lb) global.__lb.scale = st.scale;
  }
  function reset() { st.scale = 1; st.x = 0; st.y = 0; apply(); }
  function zoomAt(factor, cx, cy) {
    var img = $("lbImg"); if (!img) return;
    var old = st.scale, ns = Math.max(MIN, Math.min(MAX, old * factor));
    if (ns === old) return;
    var r = img.getBoundingClientRect();
    var px = (cx == null ? (r.left + r.width / 2) : cx) - (r.left + r.width / 2);
    var py = (cy == null ? (r.top + r.height / 2) : cy) - (r.top + r.height / 2);
    st.x = px - (px - st.x) * (ns / old);
    st.y = py - (py - st.y) * (ns / old);
    st.scale = ns;
    apply();
  }

  function showMenu(x, y) {
    var old = $("pgMenu"); if (old) old.remove();
    var lb = global.__lb || {};
    var m = document.createElement("div");
    m.id = "pgMenu";
    m.style.cssText = "position:fixed;z-index:2147483000;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.28);padding:6px;min-width:150px;font-size:14px";
    m.innerHTML =
      '<div data-a="save" style="padding:10px 14px;cursor:pointer">💾 保存图片</div>' +
      '<div data-a="share" style="padding:10px 14px;cursor:pointer">📤 分享</div>' +
      '<div data-a="reset" style="padding:10px 14px;cursor:pointer">↺ 复位 100%</div>' +
      '<div data-a="zin" style="padding:10px 14px;cursor:pointer">🔍 放大</div>' +
      '<div data-a="zout" style="padding:10px 14px;cursor:pointer">🔎 缩小</div>' +
      (lb.id && !lb.single ? '<div data-a="prev" style="padding:10px 14px;cursor:pointer">⬅ 上一张</div><div data-a="next" style="padding:10px 14px;cursor:pointer">➡ 下一张</div>' : '') +
      '<div data-a="close" style="padding:10px 14px;cursor:pointer;color:#c0392b">✕ 关闭</div>';
    document.body.appendChild(m);
    var mw = 170, mh = m.offsetHeight || 320;
    m.style.left = Math.max(6, Math.min((global.innerWidth || 360) - mw - 6, x)) + "px";
    m.style.top = Math.max(6, Math.min((global.innerHeight || 640) - mh - 6, y)) + "px";
    m.addEventListener("click", function (e) {
      var a = e.target.getAttribute && e.target.getAttribute("data-a");
      if (!a) return;
      m.remove();
      try {
        if (a === "save") { if (global.photoActSave) { global.__photoAct = { id: lb.id, i: lb.i || 0 }; global.photoActSave(); } else toast("当前图片不支持直接保存"); }
        else if (a === "share") { if (global.lbShare) global.lbShare(); else toast("分享不可用"); }
        else if (a === "reset") reset();
        else if (a === "zin") zoomAt(1.5);
        else if (a === "zout") zoomAt(1 / 1.5);
        else if (a === "prev") { if (global.lbStep) global.lbStep(-1); }
        else if (a === "next") { if (global.lbStep) global.lbStep(1); }
        else if (a === "close") { var box = $("lightbox"); if (box) box.classList.remove("show"); }
      } catch (err) { toast("操作失败：" + err.message); }
    });
    setTimeout(function () {
      document.addEventListener("click", function h() { if (m.parentNode) m.remove(); document.removeEventListener("click", h); });
    }, 30);
  }

  function attach() {
    var img = $("lbImg");
    if (!img || img.__pgBound) return;
    img.__pgBound = 1;

    /* ---------- 电脑端：滚轮 + 拖拽 ---------- */
    img.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    }, { passive: false });

    img.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      st.dragging = true; st.sx = e.clientX; st.sy = e.clientY; st.ox = st.x; st.oy = st.y;
      e.preventDefault();
      apply();
    });
    global.addEventListener("mousemove", function (e) {
      if (!st.dragging) return;
      st.x = st.ox + (e.clientX - st.sx); st.y = st.oy + (e.clientY - st.sy);
      apply();
    });
    global.addEventListener("mouseup", function () { if (st.dragging) { st.dragging = false; apply(); } });
    img.addEventListener("dblclick", function (e) {
      if (st.scale > 1) reset(); else zoomAt(2.2, e.clientX, e.clientY);
    });

    /* ---------- 手机端：指针事件统一处理（单指拖 / 双指捏合 / 长按） ---------- */
    var pts = {}, pinch = null, longTimer = null, moved = false, lastTap = 0;

    img.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      moved = false;
      var ids = Object.keys(pts);
      if (ids.length === 2) {
        var a = pts[ids[0]], b = pts[ids[1]];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: st.scale };
      } else if (ids.length === 1) {
        st.sx = e.clientX; st.sy = e.clientY; st.ox = st.x; st.oy = st.y;
        longTimer = setTimeout(function () {
          if (!moved) { showMenu(e.clientX, e.clientY); longTimer = null; }
        }, 600);
      }
      try { img.setPointerCapture(e.pointerId); } catch (err) {}
    });

    img.addEventListener("pointermove", function (e) {
      if (e.pointerType === "mouse") return;
      if (!pts[e.pointerId]) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pts);
      if (ids.length >= 2 && pinch) {
        e.preventDefault();
        var a = pts[ids[0]], b = pts[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.d > 0) {
          var ns = Math.max(MIN, Math.min(MAX, pinch.s * (d / pinch.d)));
          st.scale = ns; moved = true; apply();
        }
      } else if (ids.length === 1) {
        var dx = e.clientX - st.sx, dy = e.clientY - st.sy;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) { moved = true; if (longTimer) { clearTimeout(longTimer); longTimer = null; } }
        if (st.scale > 1) {
          e.preventDefault();
          st.x = st.ox + dx; st.y = st.oy + dy; apply();
        }
      }
    }, { passive: false });

    function up(e) {
      if (e.pointerType === "mouse") return;
      delete pts[e.pointerId];
      if (longTimer) { clearTimeout(longTimer); longTimer = null; }
      if (Object.keys(pts).length < 2) pinch = null;
      // 双击放大/复位
      if (!moved && e.type === "pointerup") {
        var now = Date.now();
        if (now - lastTap < 300) {
          if (st.scale > 1) reset(); else zoomAt(2.2, e.clientX, e.clientY);
        }
        lastTap = now;
      }
    }
    img.addEventListener("pointerup", up);
    img.addEventListener("pointercancel", up);
    img.addEventListener("contextmenu", function (e) { e.preventDefault(); showMenu(e.clientX || 60, e.clientY || 80); });
  }

  // 灯箱显示时重置并绑定
  function watch() {
    var box = $("lightbox");
    if (!box) { setTimeout(watch, 800); return; }
    attach();
    var mo = new MutationObserver(function () {
      if (box.classList.contains("show")) { reset(); attach(); }
      else { reset(); }
    });
    mo.observe(box, { attributes: true, attributeFilter: ["class"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();

  global.PhotoGesture = { reset: reset, zoomAt: zoomAt, showMenu: showMenu };
})(window);
