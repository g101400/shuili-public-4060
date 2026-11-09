/* secure_boot.js —— 内部版启动口令门（3305）
 * 说明：
 *   - 只有「内部版」（奇数/偶数双通道中判为 internal 的版本）才启用；公开版自动放行。
 *   - JS 内不含明文口令，只存 salt/iv/密文；口令错误 → AES-GCM 校验失败 → 拒绝进入。
 *   - 通过后在 localStorage 记标记（secBootOK5090），之后本机直接启动。
 *   - 依赖 window.__SEC_BOOT（由 secure_boot_cred.js 提供）。
 */
(function () {
  var CRED = window.__SEC_BOOT;
  var KEY = "secBootOK5090";
  var TTL = 0; // 0 = 长期记住；如需每次启动都验证，改为 1

  function b64(b) {
    var s = atob(b), n = s.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function chanInternal() {
    try {
      var ch = window.SHUILI_RELEASE_CHANNEL || window.GANZHI_RELEASE_CHANNEL ||
               window.PERC_RELEASE_CHANNEL || window.RELEASE_CHANNEL || "";
      if (ch) return ch === "internal";
      for (var k in window) {
        if (/_RELEASE_CHANNEL$/i.test(k) && typeof window[k] === "string") {
          if (window[k] === "internal") return true;
        }
      }
    } catch (e) {}
    return false;
  }
  function unlock(pass) {
    if (!CRED) return Promise.reject(new Error("nocred"));
    var salt = b64(CRED.s), iv = b64(CRED.i), ct = b64(CRED.c);
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"])
      .then(function (k) {
        return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: CRED.iter || 120000, hash: "SHA-256" },
                                        k, CRED.ks || 256);
      })
      .then(function (bits) { return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]); })
      .then(function (key) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv, tagLength: 128 }, key, ct); })
      .then(function (pt) {
        var txt = new TextDecoder().decode(new Uint8Array(pt));
        if (txt.indexOf("SEC-OK-5090") < 0) throw new Error("bad");
        return true;
      });
  }
  var st = document.createElement("style");
  st.textContent =
    "#secBoot{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
    "background:linear-gradient(160deg,#0f2b46,#123a5e);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}" +
    "#secBootBox{width:min(90vw,400px);background:#fff;border-radius:16px;padding:26px 22px 20px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.35)}" +
    "#secBootBox h2{margin:0 0 6px;font-size:19px;color:#123a5e}" +
    "#secBootBox p{margin:0 0 16px;font-size:13px;color:#666;line-height:1.6}" +
    "#secBootIn{width:100%;box-sizing:border-box;padding:13px 14px;font-size:20px;letter-spacing:6px;text-align:center;border:1px solid #cfd8e3;border-radius:10px;outline:none;color:#123a5e}" +
    "#secBootIn:focus{border-color:#2b7fd4;box-shadow:0 0 0 3px rgba(43,127,212,.15)}" +
    "#secBootBtn{margin-top:14px;width:100%;padding:12px;font-size:16px;color:#fff;background:#1a6fc4;border:0;border-radius:10px}" +
    "#secBootTip{margin-top:12px;min-height:18px;font-size:13px;color:#c0392b}" +
    "#secBootHint{margin-top:10px;font-size:12px;color:#9aa7b5}";
  document.head.appendChild(st);

  var box = document.createElement("div");
  box.id = "secBoot";
  box.innerHTML = '<div id="secBootBox"><h2>正在启动…</h2><p>请稍候</p></div>';
  document.documentElement.appendChild(box);

  function close() { box.parentNode && box.parentNode.removeChild(box); }
  function ask() {
    var t = document.title || "内部版";
    box.innerHTML =
      '<div id="secBootBox">' +
      '<h2>' + String(t).replace(/</g, "&lt;") + '</h2>' +
      '<p>内部版 · 请输入启动口令</p>' +
      '<input id="secBootIn" type="password" inputmode="numeric" autocomplete="off" placeholder="启动口令" />' +
      '<button id="secBootBtn">进 入</button>' +
      '<div id="secBootTip"></div>' +
      '<div id="secBootHint">口令由管理员下发</div>' +
      '</div>';
    var inp = document.getElementById("secBootIn"),
        btn = document.getElementById("secBootBtn"),
        tip = document.getElementById("secBootTip");
    function go() {
      var v = (inp.value || "").trim();
      if (!v) { tip.textContent = "请输入口令"; return; }
      btn.disabled = true; tip.style.color = "#666"; tip.textContent = "验证中…";
      unlock(v).then(function () {
        try { localStorage.setItem(KEY, "1"); } catch (e) {}
        close();
      }).catch(function () {
        btn.disabled = false; tip.style.color = "#c0392b";
        tip.textContent = "口令错误，无法进入";
        inp.value = ""; inp.focus();
      });
    }
    btn.onclick = go;
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 200);
  }
  function start() {
    if (!CRED) { close(); return; }
    if (!chanInternal()) { close(); return; }
    var ok = "";
    try { ok = localStorage.getItem(KEY) || ""; } catch (e) {}
    if (ok === "1" && !TTL) { close(); return; }
    ask();
  }
  setTimeout(start, 500);
})();
