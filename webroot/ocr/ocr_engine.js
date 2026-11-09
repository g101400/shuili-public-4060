/* ===== ocr_engine.js — 内置轻量离线 OCR 引擎（Tesseract.js 5 本地化封装）=====
 * 资产全部本地化于 assets/ocr/：pdf.min.js / pdf.worker.min.js（PDF 渲染）、
 * tesseract.min.js / worker.min.js（OCR 运行时）、tesseract-core-{simd-,}lstm.wasm.js（推理核）、
 * chi_sim + eng traineddata（简体中文+英文，4.0.0_best_int）。
 * 特性：懒加载（首用时才注入）、SIMD 优先自动降级非 SIMD、进度回调、file:// 环境兼容
 * （依赖 MainActivity setAllowUniversalAccessFromFileURLs(true)）。
 */
window.OCREngine = (function () {
  "use strict";
  var state = { boot: null, worker: null, core: "simd" };
  var LANGS = "chi_sim+eng";
  var curProg = null; // 当前 recognize 的进度回调（0-1）

  function abs(p) {
    try { return new URL(p, (window.location && window.location.href) || "file:///android_asset/index.html").href; }
    catch (e) { return p; }
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error("本地组件加载失败：" + src)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function coreLogger(m) {
    if (curProg && m && typeof m.progress === "number") {
      if (m.status === "recognizing text") curProg(m.progress);
      else if (m.status === "loading language traineddata" || m.status === "loading language traineddata (from cache)") curProg(m.progress * 0.1);
    }
  }
  // 创建 worker（先 SIMD 核，失败降级非 SIMD 核；单例复用）
  function ensureWorker() {
    if (state.worker) return Promise.resolve(state.worker);
    if (!window.Tesseract) return Promise.reject(new Error("OCR 组件未就绪"));
    var T = window.Tesseract;
    var attempt = function (coreFile) {
      return T.createWorker(LANGS, 1, {
        workerPath: abs("ocr/worker.min.js"),
        corePath: abs("ocr/" + coreFile),
        langPath: abs("ocr/"),
        gzip: true,
        cacheMethod: "none",
        workerBlobURL: true,
        logger: coreLogger
      }).then(function (w) { state.core = coreFile.indexOf("simd") >= 0 ? "simd" : "plain"; return w; });
    };
    return attempt("tesseract-core-simd-lstm.wasm.js").catch(function (e1) {
      return attempt("tesseract-core-lstm.wasm.js").catch(function (e2) {
        throw new Error("OCR 引擎初始化失败（" + (e1 && e1.message || e1) + " / " + (e2 && e2.message || e2) + "）");
      });
    }).then(function (w) { state.worker = w; return w; });
  }
  function boot() {
    if (!state.boot) state.boot = ensureWorker().catch(function (e) { state.boot = null; throw e; });
    return state.boot;
  }
  // 识别一个 canvas / 图片元素 → 文本；onProg(fraction 0-1)
  function recognize(imageLike, onProg) {
    curProg = onProg || null;
    return boot().then(function (w) {
      return w.recognize(imageLike);
    }).then(function (r) {
      curProg = null;
      return cleanText(r && r.data && r.data.text || "");
    }).catch(function (e) { curProg = null; throw e; });
  }
  function cleanText(t) {
    return String(t || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  // 释放 worker（整册转换完成后调用，回收内存）
  function dispose() {
    if (state.worker) { try { state.worker.terminate(); } catch (e) {} state.worker = null; }
    state.boot = null; curProg = null;
  }
  // 预热（可选）：提前加载组件
  function warmup() { return boot().then(function () {}); }
  return {
    recognize: recognize,
    dispose: dispose,
    warmup: warmup,
    coreKind: function () { return state.core; },
    ready: function () { return !!state.worker; }
  };
})();
