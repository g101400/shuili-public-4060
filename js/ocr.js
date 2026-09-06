/* ocr.js —— 内置轻量化 OCR 引擎（tesseract.js v5 + 本地资产，离线可用）
 * 用途：知识库「导入外部文件」——扫描件 PDF 内嵌页图 / 图片文件的文字提取（兜底方法之一）。
 * 资产：lib/tess/{tesseract.min.js, worker.min.js, tesseract-core-*.wasm.js, chi_sim/eng.traineddata.gz}
 *       · chi_sim + eng 双语（tessdata_fast 精简模型，中英混排文档够用；手写体/极低清图效果有限）
 *       · corePath 按设备能力自动选 simd / 非 simd（龙芯等老架构走非 simd）
 * 纪律：懒加载——首次调用才加载引擎与模型，不拖慢应用启动；引擎缺失/加载失败 fail-loud，
 *       由 kb.js 转成友好提示（不静默出乱码）。
 */
(function (global) {
  const BASE = "lib/tess/";
  const LANGS = ["chi_sim", "eng"];
  let _worker = null;
  let _booting = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => res();
      s.onerror = () => rej(new Error("OCR 引擎脚本加载失败：" + src));
      document.head.appendChild(s);
    });
  }

  async function ensureWorker(onProg) {
    if (_worker) return _worker;
    if (!_booting) {
      _booting = (async () => {
        if (onProg) onProg(2, "加载 OCR 引擎…");
        if (!global.Tesseract) await loadScript(BASE + "tesseract.min.js");
        const T = global.Tesseract;
        const w = await T.createWorker(LANGS, 1, {
          workerPath: BASE + "worker.min.js",
          corePath: BASE,                    // 目录形式：自动挑 simd/非simd 的 .wasm.js
          langPath: BASE.replace(/\/$/, ""), // 模型 gz 本地取
          gzip: true,
          logger: (m) => {
            try {
              if (onProg && m && m.status === "recognizing text")
                onProg(10 + Math.round((m.progress || 0) * 88), "OCR 识别中…");
            } catch (e) { /* 进度回调失败不影响识别 */ }
          },
        });
        return w;
      })();
    }
    try {
      _worker = await _booting;
      return _worker;
    } catch (e) {
      _booting = null; // 失败允许重试
      throw e;
    }
  }

  // image: Blob | File | HTMLCanvasElement | ImageData（kb.js 负责 JPEG 直传 / 位图转 canvas）
  async function recognize(image, onProg) {
    const w = await ensureWorker(onProg);
    if (onProg) onProg(5, "OCR 初始化…");
    await w.setParameters({ preserve_interword_spaces: "1" });
    const { data } = await w.recognize(image);
    return String((data && data.text) || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function terminate() {
    if (_worker) { try { await _worker.terminate(); } catch (e) { /* 忽略 */ } _worker = null; _booting = null; }
  }

  global.OCR = {
    recognize,
    terminate,
    available: () => !!global.Tesseract,
    // kb.js 探测用：引擎脚本/资产是否随包就位（不做网络加载，只查文件可达性由首次加载时暴露）
    get busy() { return !!_worker; },
  };
})(window);
