/* secure_gate.js —— 内部版 PWA 启动口令门禁（AES-GCM 数据解密 + 顺序加载）
 * 用法：随加密版 PWA 一起部署；index.html 中只保留本脚本，其余业务脚本由本脚本按序注入。
 * 特点：
 *   - JS 内不含明文口令，仅存 salt/iv/密文；口令错误时 GCM 校验失败 → 拒绝启动。
 *   - 解密后的数据脚本以 <script> 文本方式在全局作用域执行，等价于原 data.js / kb_building_seed.js / ai_seed.js。
 *   - 口令在本次会话内记住（sessionStorage），刷新页面无需重输；关闭页面即失效。
 */
(function () {
  var D = window.__SEC_DATA;
  var PRE = ["leaflet/leaflet.js", "jszip.min.js"];
  var POST = ["ovobj_bridge.js", "ai_module.js", "ctx_menu.js", "app.js"];
  var TITLE = (document.title || "内部版");

  function b64(b) {
    var s = atob(b), n = s.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function css() {
    var st = document.createElement("style");
    st.textContent =
      "#secGate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(160deg,#0f2b46,#123a5e);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}" +
      "#secBox{width:min(92vw,420px);background:#fff;border-radius:16px;padding:26px 22px 20px;box-shadow:0 18px 50px rgba(0,0,0,.35);text-align:center}" +
      "#secBox h2{margin:0 0 6px;font-size:19px;color:#123a5e}#secBox p{margin:0 0 16px;font-size:13px;color:#666;line-height:1.6}" +
      "#secIn{width:100%;box-sizing:border-box;padding:13px 14px;font-size:20px;letter-spacing:6px;text-align:center;" +
      "border:1px solid #cfd8e3;border-radius:10px;outline:none;color:#123a5e}" +
      "#secIn:focus{border-color:#2b7fd4;box-shadow:0 0 0 3px rgba(43,127,212,.15)}" +
      "#secBtn{margin-top:14px;width:100%;padding:12px;font-size:16px;color:#fff;background:#1a6fc4;border:0;border-radius:10px;cursor:pointer}" +
      "#secBtn:active{background:#12558f}" +
      "#secTip{margin-top:12px;min-height:18px;font-size:13px;color:#c0392b}" +
      "#secHint{margin-top:10px;font-size:12px;color:#9aa7b5}";
    document.head.appendChild(st);
  }
  function ui(onOk) {
    css();
    var wrap = document.createElement("div");
    wrap.id = "secGate";
    wrap.innerHTML =
      '<div id="secBox">' +
      '<h2>' + TITLE.replace(/</g, "&lt;") + '</h2>' +
      '<p>本应用为内部版，数据已加密。<br>请输入启动口令后进入。</p>' +
      '<input id="secIn" type="password" inputmode="numeric" autocomplete="off" placeholder="启动口令" />' +
      '<button id="secBtn">解 锁 进 入</button>' +
      '<div id="secTip"></div>' +
      '<div id="secHint">默认口令即开发者分机号 · 输错不会泄露任何数据</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var inp = document.getElementById("secIn"), btn = document.getElementById("secBtn"), tip = document.getElementById("secTip");
    function go() {
      var v = (inp.value || "").trim();
      if (!v) { tip.textContent = "请输入口令"; return; }
      btn.disabled = true; tip.style.color = "#666"; tip.textContent = "正在解密…";
      unlock(v).then(function (files) {
        try { sessionStorage.setItem("secPass5090", v); } catch (e) {}
        wrap.parentNode && wrap.parentNode.removeChild(wrap);
        onOk(files);
      }).catch(function (e) {
        btn.disabled = false; tip.style.color = "#c0392b";
        tip.textContent = "口令错误或数据已损坏，无法进入";
        inp.value = ""; inp.focus();
      });
    }
    btn.onclick = go;
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 120);
  }
  function derive(pass, saltb) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"])
      .then(function (k) {
        return crypto.subtle.deriveBits(
          { name: "PBKDF2", salt: saltb, iterations: (D && D.iter) || 120000, hash: "SHA-256" }, k,
          ((D && D.ks) || 256));
      })
      .then(function (bits) { return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]); });
  }
  function unlock(pass) {
    if (!D) return Promise.reject(new Error("no data"));
    return derive(pass, b64(D.s)).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(D.i), tagLength: 128 }, key, b64(D.c));
    }).then(function (pt) {
      var txt = new TextDecoder().decode(new Uint8Array(pt));
      return JSON.parse(txt).f;
    });
  }
  function runText(txt) {
    var s = document.createElement("script");
    s.textContent = txt;
    document.head.appendChild(s);
  }
  function loadSeq(list, done) {
    var i = 0;
    (function next() {
      if (i >= list.length) return done();
      var src = list[i++];
      var s = document.createElement("script");
      s.src = src;
      s.onload = next;
      s.onerror = function () { console.error("load fail", src); next(); };
      document.head.appendChild(s);
    })();
  }
  function boot(files) {
    for (var i = 0; i < files.length; i++) runText(files[i][1]);
    loadSeq(PRE, function () { loadSeq(POST, function () { /* app.js 已启动 */ }); });
  }
  function start() {
    if (!D) { document.body.innerHTML = '<div style="padding:40px;font:16px sans-serif">数据包缺失，请联系管理员。</div>'; return; }
    var cached = null;
    try { cached = sessionStorage.getItem("secPass5090"); } catch (e) {}
    if (cached) {
      unlock(cached).then(function (f) { boot(f); }).catch(function () { ui(boot); });
    } else {
      ui(boot);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
