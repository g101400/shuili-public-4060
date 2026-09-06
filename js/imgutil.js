// js/imgutil.js —— 照片压缩 / 缩略图（方案2：缩略图 + 导入压缩 < 1MB）
// 暴露全局 ImgUtil.compressPhoto(input, opts) -> Promise<{thumb, full, w, h, hash}>
// input: Uint8Array(原始图片字节) 或 dataUrl 字符串
// 缩略图最长边 320px（~15-30KB，列表/筛选/标记专用）；原图压缩到 < maxFullBytes（默认 1MB，放大/下载用）
(function () {
  const MAX_FULL_BYTES = 1000 * 1024; // 压缩后全图 < 1MB
  const THUMB_SIDE = 320;

  function bytesFromInput(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string' && input.startsWith('data:')) {
      const b64 = input.split(',')[1] || '';
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    return null;
  }

  function loadImage(bytes) {
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  function drawScaled(img, maxSide) {
    const sw = img.width || img.naturalWidth, sh = img.height || img.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
    return cv;
  }

  function toDataUrl(cv, q) { return cv.toDataURL('image/jpeg', q); }
  function approxBytes(dataUrl) { return Math.floor(dataUrl.length * 0.75); }

  // 原图内容哈希（去重用）：优先 SHA-256；非安全上下文降级 FNV-1a（同一原图稳定一致）
  async function shaHex(bytes) {
    try {
      if (crypto && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {}
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  // 全图压缩：jpeg q 0.85 起，超体积先降质量、再降边长，直至 < maxFullBytes
  function compressFull(img, maxFull) {
    let full = '', q = 0.85, side = Math.min(1920, Math.max(img.width || img.naturalWidth, img.height || img.naturalHeight));
    for (let i = 0; i < 8; i++) {
      const fcv = drawScaled(img, side);
      full = toDataUrl(fcv, q);
      if (approxBytes(full) <= maxFull) break;
      if (q > 0.6) q -= 0.1;
      else if (side > 1024) side = Math.round(side * 0.8);
      else break;
    }
    return full;
  }

  async function compressPhoto(input, opts) {
    opts = opts || {};
    const maxFull = opts.maxFullBytes || MAX_FULL_BYTES;
    const bytes = bytesFromInput(input);
    if (!bytes) throw new Error('compressPhoto: 无法解析输入（需 Uint8Array 或 dataUrl）');
    const img = await loadImage(bytes);
    const sw = img.width || img.naturalWidth, sh = img.height || img.naturalHeight;
    const thumb = toDataUrl(drawScaled(img, THUMB_SIDE), 0.7);
    const full = compressFull(img, maxFull);
    const hash = await shaHex(bytes);
    return { thumb, full, w: sw, h: sh, hash };
  }

  window.ImgUtil = { compressPhoto, MAX_FULL_BYTES };
})();
