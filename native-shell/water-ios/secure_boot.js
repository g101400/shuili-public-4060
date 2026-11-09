/* secure_boot.js —— 内部版访问口令门
 * 版本：v3.66/v1.42 增强版（记住口令选项 + 修改口令 + 忘记口令）
 * 说明：
 *   - 仅「内部版」启用；公开版（奇数/公开通道）自动放行。
 *   - JS 内不含明文口令，只存 salt/iv/密文；口令错误 → AES-GCM 校验失败 → 拒绝进入。
 *   - 首启弹口令门：口令由开发者掌握、另行告知（不写入源码，也不出现在任何界面文案中）；
 *     勾选「记住口令」后本机免输。
 *   - 设置菜单可「修改口令 / 忘记口令」；忘记口令提示联系开发者（开发者分机号）。
 *   - 数据加密版 PWA（secure_gate 已用口令解数据）中：口令由部署方固化，
 *     本门自动放行、不支持修改（改了口令将无法解密数据）。
 * 依赖 window.__SEC_BOOT（secure_boot_cred.js）。
 */
(function () {
  var CRED = window.__SEC_BOOT;
  var KEY_SAVED = "secBootSavedN5090";   // "1" = 已记住口令，下次免输
  var KEY_OLD   = "secBootOK5090";       // 旧版已记住标记（兼容）
  var KEY_CRED  = "secBootCredN5090";    // 用户修改后的口令凭证（形状同 __SEC_BOOT）
  var DEV_EXT   = (window.__DEV_EXT_5090 || "");  // 开发者分机号：仅由内部构建按需注入；源码不写死、公开构建为空
  var DATA_LOCK = !!(window.__SEC_DATA); // 数据已用口令加密（内部加密 PWA）

  function sget(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function sset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function sdel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function sessGet(k) { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } }

  function b64(b) {
    var s = atob(b), n = s.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function b64enc(buf) {
    var s = "", n = buf.length;
    for (var i = 0; i < n; i++) s += String.fromCharCode(buf[i]);
    var out = "";
    try { out = btoa(s); } catch (e) { out = ""; }
    return out;
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

  function deriveBits(pass, saltb, iter, ks) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"])
      .then(function (k) {
        return crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltb, iterations: iter || 120000, hash: "SHA-256" },
                                        k, ks || 256);
      })
      .then(function (bits) { return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); });
  }

  // 用口令解密某凭证：明文须含 SEC-OK-5090 标记才算对
  function checkCred(cred, pass) {
    if (!cred) return Promise.reject(new Error("nocred"));
    return deriveBits(pass, b64(cred.s), cred.iter, cred.ks).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(cred.i), tagLength: 128 }, key, b64(cred.c));
    }).then(function (pt) {
      var txt = new TextDecoder().decode(new Uint8Array(pt));
      if (txt.indexOf("SEC-OK-5090") < 0) throw new Error("bad");
      return true;
    });
  }

  // 优先用户修改后的凭证，其次默认凭证
  function unlock(pass) {
    var uc = null;
    try { uc = JSON.parse(sget(KEY_CRED) || "null"); } catch (e) { uc = null; }
    var def = CRED ? checkCred(CRED, pass) : Promise.reject(new Error("nocred"));
    if (!uc) return def;
    return checkCred(uc, pass).catch(function () { return def; });
  }

  // 新口令加密生成凭证（随机 salt/iv）
  function makeCred(pass) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveBits(pass, salt, 120000, 256).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, tagLength: 128 }, key,
                                   new TextEncoder().encode("SEC-OK-5090|internal|v1"));
    }).then(function (ct) {
      var cred = { alg: "AES-GCM-256", iter: 120000, ks: 256,
                   s: b64enc(salt), i: b64enc(iv), c: b64enc(new Uint8Array(ct)) };
      return cred;
    });
  }

  /* ---------- UI ---------- */
  var cssInjected = false;
  function ensureCss() {
    if (cssInjected) return;
    cssInjected = true;
    var st = document.createElement("style");
    st.textContent =
      "#secBoot{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(160deg,#0f2b46,#123a5e);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}" +
      "#secBootBox{width:min(90vw,400px);background:#fff;border-radius:16px;padding:26px 22px 18px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.35)}" +
      "#secBootBox h2{margin:0 0 6px;font-size:19px;color:#123a5e}" +
      "#secBootBox p{margin:0 0 14px;font-size:13px;color:#666;line-height:1.6}" +
      "#secBootIn{width:100%;box-sizing:border-box;padding:12px 14px;font-size:19px;letter-spacing:5px;text-align:center;border:1px solid #cfd8e3;border-radius:10px;outline:none;color:#123a5e}" +
      "#secBootIn:focus{border-color:#2b7fd4;box-shadow:0 0 0 3px rgba(43,127,212,.15)}" +
      "#secBootBtn{margin-top:12px;width:100%;padding:12px;font-size:16px;color:#fff;background:#1a6fc4;border:0;border-radius:10px;cursor:pointer}" +
      "#secBootBtn:disabled{opacity:.6}" +
      "#secBootTip{margin-top:10px;min-height:18px;font-size:13px;color:#c0392b}" +
      "#secBootHint{margin-top:10px;font-size:12px;color:#8aa0b8;line-height:1.5}" +
      "#secBootForget{display:inline-block;margin-top:4px;font-size:12px;color:#2b7fd4;cursor:pointer;text-decoration:underline}" +
      ".secRow{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;font-size:13px;color:#555}" +
      ".secRow input{width:16px;height:16px;accent-color:#1a6fc4}";
    document.head.appendChild(st);
  }
  function modal(html) {
    ensureCss();
    var w = document.createElement("div");
    w.id = "secBoot";
    w.innerHTML = '<div id="secBootBox">' + html + "</div>";
    document.documentElement.appendChild(w);
    function closeM() { w.parentNode && w.parentNode.removeChild(w); }
    w.addEventListener("click", function (e) {
      if (e.target === w) closeM();
    });
    return { box: w, close: closeM };
  }

  function tipEl(id, color) {
    var el = document.getElementById(id);
    if (el) { el.style.color = color || "#c0392b"; }
    return el;
  }

  function showForgot() {
    var m = modal(
      "<h2>忘记口令</h2>" +
      "<p style='text-align:left'>本应用为内部版，默认口令即<strong>开发者分机号</strong>。<br>" +
      "若曾通过「设置 → 修改口令」自定义口令后遗忘，请<strong>联系开发者（分机号）</strong>协助重置。</p>" +
      '<button id="secBootBtn" style="margin-top:6px">我知道了</button>'
    );
    document.getElementById("secBootBtn").onclick = m.close;
  }

  // 修改口令（仅内部版、且非数据加密版）
  function changePass() {
    if (!chanInternal()) { return; }
    if (DATA_LOCK) {
      var tm = modal("<h2>修改口令</h2><p>本加密版数据已用口令固化加密，口令由部署方管理（开发者分机号），不支持自行修改。</p>" +
        '<button id="secBootBtn">知道了</button>');
      document.getElementById("secBootBtn").onclick = tm.close;
      return;
    }
    var m = modal(
      "<h2>修改口令</h2>" +
      '<input id="secBootIn" type="password" autocomplete="off" placeholder="当前口令" style="margin-bottom:8px" />' +
      '<input id="secBootNew" type="password" autocomplete="off" placeholder="新口令（≥4 位）" style="margin-bottom:8px" />' +
      '<input id="secBootNew2" type="password" autocomplete="off" placeholder="再次输入新口令" />' +
      '<button id="secBootBtn">保存新口令</button>' +
      '<div id="secBootTip"></div>' +
      '<div id="secBootHint">修改后请牢记；如遗忘请联系开发者（开发者分机号）</div>'
    );
    var cur = document.getElementById("secBootIn"),
        nw = document.getElementById("secBootNew"),
        nw2 = document.getElementById("secBootNew2"),
        btn = document.getElementById("secBootBtn"),
        t = document.getElementById("secBootTip");
    function go() {
      var c = (cur.value || "").trim(), n = (nw.value || "").trim(), n2 = (nw2.value || "").trim();
      if (!c) { t.textContent = "请输入当前口令"; return; }
      if (n.length < 4) { t.textContent = "新口令至少 4 位"; return; }
      if (n !== n2) { t.textContent = "两次输入的新口令不一致"; return; }
      btn.disabled = true; t.style.color = "#666"; t.textContent = "验证并保存…";
      unlock(c).then(function () {
        return makeCred(n);
      }).then(function (cred) {
        sset(KEY_CRED, JSON.stringify(cred));
        sset(KEY_SAVED, "1");
        t.style.color = "#2e7d32"; t.textContent = "口令已修改（本机已记住，下次免输）";
        btn.disabled = false;
        setTimeout(function () { m.close(); }, 1400);
      }).catch(function () {
        btn.disabled = false; t.style.color = "#c0392b";
        t.textContent = "当前口令错误，无法修改";
        cur.value = ""; cur.focus();
      });
    }
    btn.onclick = go;
    var ent = function (e) { if (e.key === "Enter") go(); };
    cur.addEventListener("keydown", ent);
    nw.addEventListener("keydown", ent);
    nw2.addEventListener("keydown", ent);
    setTimeout(function () { try { cur.focus(); } catch (e) {} }, 120);
  }

  function ask() {
    ensureCss();
    var t = document.title || "内部版";
    var w = document.createElement("div");
    w.id = "secBoot";
    w.innerHTML =
      '<div id="secBootBox">' +
      "<h2>" + String(t).replace(/</g, "&lt;") + "</h2>" +
      "<p>内部版 · 请输入访问口令</p>" +
      '<input id="secBootIn" type="password" inputmode="numeric" autocomplete="off" placeholder="访问口令" />' +
      '<button id="secBootBtn">进 入</button>' +
      '<div class="secRow"><input id="secBootSave" type="checkbox" checked /><label for="secBootSave">保存口令，下次不用输入</label></div>' +
      '<div id="secBootTip"></div>' +
      '<div id="secBootHint">默认口令即开发者分机号 · 输错无法进入' +
      '<br><span id="secBootForget">忘记口令？点此查看</span></div>' +
      "</div>";
    document.documentElement.appendChild(w);
    var inp = document.getElementById("secBootIn"),
        btn = document.getElementById("secBootBtn"),
        tip = document.getElementById("secBootTip"),
        save = document.getElementById("secBootSave");
    document.getElementById("secBootForget").onclick = function (e) {
      e.preventDefault(); e.stopPropagation();
      w.parentNode && w.parentNode.removeChild(w);
      showForgot();
    };
    function go() {
      var v = (inp.value || "").trim();
      if (!v) { tip.textContent = "请输入口令"; return; }
      btn.disabled = true; tip.style.color = "#666"; tip.textContent = "验证中…";
      unlock(v).then(function () {
        if (save && save.checked) { sset(KEY_SAVED, "1"); } else { sdel(KEY_SAVED); }
        w.parentNode && w.parentNode.removeChild(w);
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
    if (window.__SEC_GATE_OFF) { return; }   // 门闸总开关（古建等产品关闸，仅借凭证做密钥校验）
    if (!CRED) { return; }
    if (!chanInternal()) { return; }
    // 数据加密版：secure_gate 已在本会话用口令解密数据 → 本门自动放行（避免双重口令）
    if (sessGet("secPass5090")) { return; }
    var ok = sget(KEY_SAVED) || sget(KEY_OLD);
    if (ok === "1") { return; }
    ask();
  }

  window.SecBoot = {
    isInternal: chanInternal,
    changePass: changePass,
    forgotPass: showForgot,
    devExt: DEV_EXT,
    // 只读校验入口：供 app.js「密钥二次验证」复用同一加密凭证（源码零明文）
    verify: function (pass) { return unlock(pass).then(function () { return true; }); }
  };

  // 等 app.js 设置好发布通道后再判定
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(start, 400); });
  } else {
    setTimeout(start, 400);
  }
})();
