/* io.js —— 导入/导出（纯前端，无外部库）
 * 导出：ovkmz/kmz（=zip: doc.kml + 照片文件）、kml、csv
 * 导入：kml（文本）、kmz/ovkmz（自带 zip 解析，支持 store 与 deflate-raw）
 * 照片以 dataUrl 存于记录，导出时写进 zip，导入时还原。
 */
(function (global) {
  // ---------- 工具 ----------
  function escapeXml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function bytesToB64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function utf8(str) { return new TextEncoder().encode(str); }
  function strFromUtf8(u) { return new TextDecoder().decode(u); }
  // 管理所名称统一（与 app.js normOffice 保持一致）：去「管理」两字 + 潮河特例；
  // 导出(kmz/ovkmz/kml/csv/潮河)统一套用，避免「温泉管理所」等原始名落盘，与导入/查询/筛选一致。
  function normOffice(name) {
    if (!name) return "";
    const s = String(name).trim();
    if (/潮河/.test(s)) return "潮河所";            // 潮河管理所 / 潮河总干渠管理所 → 潮河所
    return s.replace(/管理所/g, "所");              // 温泉管理所→温泉所、埝头管理所→埝头所
  }

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // SHA-256（内容去重/完整性校验用；SubtleCrypto 异步）
  async function sha256Hex(bytes) {
    if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // 降级：用 CRC32 串近似（仅用于去重，非安全用途）
    return "crc:" + crc32(bytes).toString(16);
  }

  // ---------- ZIP（store + deflate-raw 读取；store 写入）----------
  // 解压单条 deflate-raw；带超时保护（老浏览器 DecompressionStream 可能卡住不结束）
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined")
      throw new Error("当前环境不支持在线解压(zip)，请改用安卓端/电脑端导入，或用 KML 文本导入");
    let settled = false;
    const readAll = (async () => {
      const ds = new DecompressionStream("deflate-raw");
      const writer = ds.writable.getWriter();
      writer.write(bytes); writer.close();
      const reader = ds.readable.getReader();
      const out = [];
      let r;
      while (!(r = await reader.read()).done) out.push(r.value);
      let len = out.reduce((a, b) => a + b.length, 0);
      const merged = new Uint8Array(len);
      let off = 0;
      for (const p of out) { merged.set(p, off); off += p.length; }
      settled = true;
      return merged;
    })();
    const timeout = new Promise((_, rej) => setTimeout(() => { if (!settled) rej(new Error("解压超时（当前浏览器解压异常），请改用电脑端或减小压缩包")); }, 30000));
    return Promise.race([readAll, timeout]);
  }

  function normZipBuf(buf) {
    if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
    if (buf.byteOffset !== 0 || buf.byteLength !== buf.buffer.byteLength) buf = buf.slice();
    return buf;
  }

  // 解析中央目录（End Of Central Directory）→ [{name, method, compSize, uncompSize, dataStart}]
  // 比本地头遍历更稳：正确处理目录条目、data descriptor、UTF-8 文件名、多层目录（需求：zip 内可能多层目录）
  function readCentralDirectory(buf) {
    const dv = new DataView(buf.buffer, 0, buf.byteLength);
    let eocd = -1;
    const min = Math.max(0, buf.byteLength - 22 - 65535);
    for (let i = buf.byteLength - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 zip（缺少目录表）");
    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const uncompSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = strFromUtf8(buf.subarray(p + 46, p + 46 + nameLen));
      const lnl = dv.getUint16(localOffset + 26, true);
      const lel = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lnl + lel;
      entries.push({ name, method, compSize, uncompSize, dataStart });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function unzip(buf) {
    return new Promise(async (resolve, reject) => {
      try {
        buf = normZipBuf(buf);
        const entries = readCentralDirectory(buf);
        const files = {};
        for (const e of entries) {
          if (e.name.endsWith("/")) continue;
          const raw = buf.subarray(e.dataStart, e.dataStart + e.compSize);
          if (e.method === 0) files[e.name] = raw;
          else if (e.method === 8) files[e.name] = await inflateRaw(raw);
          else throw new Error("不支持的压缩方式:" + e.method);
        }
        resolve(files);
      } catch (e) { reject(e); }
    });
  }

  // 流式解压：逐条目回调 onEntry(name, bytes)，只持有当前条目（防大包 OOM/死机）
  async function unzipStream(buf, onEntry) {
    if (buf.byteLength < 4) throw new Error("文件为空");
    buf = normZipBuf(buf);
    const entries = readCentralDirectory(buf);
    for (const e of entries) {
      if (e.name.endsWith("/")) continue;
      const raw = buf.subarray(e.dataStart, e.dataStart + e.compSize);
      let data;
      try {
        if (e.method === 0) data = raw;
        else if (e.method === 8) data = await inflateRaw(raw);
        else throw new Error("不支持的压缩方式:" + e.method);
        await onEntry(e.name, data);
      } finally {
        data = null; // 释放本条目字节，便于 GC
      }
    }
  }
  // 仅统计照片条目数（供进度条；不 inflate，开销极小）
  function unzipCount(buf) {
    try {
      if (buf.byteLength < 4) return 0;
      buf = normZipBuf(buf);
      return readCentralDirectory(buf).filter((e) => !e.name.endsWith("/") && /\.(jpe?g|png|gif|bmp|webp)$/i.test(e.name)).length;
    } catch (e) { return 0; }
  }

  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // 0x0800 = UTF-8 文件名（中文不乱码、不被解压工具忽略）
      lv.setUint16(8, 0, true); // store
      lv.setUint16(10, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      // central
      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); // 0x0800 = UTF-8 文件名（central 目录也须置位，Python/zipfile 读此）
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      parts.push(local, data);
      central.push(cen);
      offset += local.length + data.length;
    }
    const cenBuf = concat(central);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cenBuf.length, true);
    ev.setUint32(16, offset, true);
    return concat([...parts, cenBuf, end]);
  }
  function concat(arrs) {
    let len = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }

  // ---------- KML 构建 ----------
  function paramText(p) {
    const ks = Object.keys(p || {});
    if (!ks.length) return "";
    return ks.map((k) => `${k} : ${p[k]}`).join(" | ");
  }
  function recordToPlacemark(r) {
    const params = r.params || {};
    const sd = [];
    const push = (k, v) => { if (v != null && v !== "") sd.push(`<SimpleData name="${escapeXml(k)}">${escapeXml(v)}</SimpleData>`); };
    push("office", normOffice(r.office)); push("station", r.station); push("btype", r.btype);
    push("type", r.type); push("name", r.name);
    for (const k of Object.keys(params)) push(k, params[k]);
    // 照片：写入 zip 的 files/ 下；description 用 <img> 引用（自兼容）；OvAttr/OvAttaItem 文本路径（奥维真实导出结构）
    const imgs = (r.photos || []).map((ph, i) => {
      const fn = `${r.id}_${i}.jpg`;
      return `<img src="files/${fn}" alt="${escapeXml(ph.caption || "")}"/>`;
    }).join("<br/>");
    const ovAttr = (r.photos || []).length
      ? `<OvAttr><OvIcon>1</OvIcon><OvIconNum>0</OvIconNum><OvAttaList>` +
        (r.photos || []).map((ph, i) => `<OvAttaItem>files/${escapeXml(r.id)}_${i}.jpg</OvAttaItem>`).join("") +
        `</OvAttaList></OvAttr>`
      : "";
    const desc = escapeXml(paramText(params) || r.description || "");
    return `  <Placemark>
    <name>${escapeXml(r.name)}</name>
    <description><![CDATA[${desc}${imgs ? "<br/>" + imgs : ""}]]></description>
    ${ovAttr}
    <OvCoordType>CGCS2000</OvCoordType>
    <Point><coordinates>${r.lon},${r.lat},0</coordinates></Point>
    <ExtendedData>
      <SchemaData schemaUrl="#shuili">
        ${sd.join("\n        ")}
      </SchemaData>
    </ExtendedData>
  </Placemark>`;
  }

  function buildKML(records, root) {
    const places = records.map(recordToPlacemark).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2008">
  <Document>
    <Schema id="shuili" name="shuili">
      <SimpleField name="office" type="string"/>
      <SimpleField name="station" type="string"/>
      <SimpleField name="btype" type="string"/>
      <SimpleField name="type" type="string"/>
    </Schema>
    <name>${escapeXml(root || "水利工程基础信息")}</name>
${places}
  </Document>
</kml>`;
  }

  // 记录 -> KMZ 字节（含照片文件）
  function recordsToKmzBytes(records) {
    const files = [];
    const kml = utf8(buildKML(records));
    files.push({ name: "doc.kml", data: kml });
    for (const r of records) {
      (r.photos || []).forEach((ph, i) => {
        if (ph.dataUrl && ph.dataUrl.startsWith("data:") && ph.dataUrl.includes(";base64,")) {
          const b64 = ph.dataUrl.split(",")[1];
          files.push({ name: `files/${r.id}_${i}.jpg`, data: b64ToBytes(b64) });
        }
      });
    }
    return zipStore(files);
  }

  // ---------- 解析 KML -> 记录 ----------
  function parseKmlToRecords(kmlText) {
    const xml = new DOMParser().parseFromString(kmlText, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("KML 解析失败");
    const pms = xml.getElementsByTagName("Placemark");
    const out = [];
    for (const pm of pms) {
      const name = (pm.getElementsByTagName("name")[0] || {}).textContent || "";
      const coordEl = pm.getElementsByTagName("coordinates")[0];
      const coord = coordEl ? coordEl.textContent.trim() : "";
      const parts = coord.split(",");
      const lon = parseFloat(parts[0]), lat = parseFloat(parts[1]);
      // ExtendedData -> params
      const params = {};
      const sd = pm.getElementsByTagName("SimpleData");
      for (const s of sd) {
        const k = s.getAttribute("name"); const v = s.textContent;
        if (["office", "station", "btype", "type", "name"].includes(k)) continue;
        if (v) params[k] = v;
      }
      // 照片引用：兼容本APP格式（files/xxx.jpg）、奥维 OvAttaItem（属性或文本路径）、Attachment、通用 <img src>/<a href>
      const descEl = pm.getElementsByTagName("description")[0];
      const desc = descEl ? descEl.textContent : "";
      // 奥维真实文件：参数写在 description 的「键 : 值|」行（无 SimpleData 时兜底解析）
      if (!Object.keys(params).length) {
        for (const line of desc.split(/[\n|]/)) {
          const t = line.trim();
          if (!t || t.includes("<")) continue;
          const m = t.match(/^([^：:]{1,40})[：:]\s*(.*)$/);
          if (m) { const k = m[1].trim(); const v = m[2].trim(); if (k && v) params[k] = v; }
        }
      }
      // 奥维文件夹层级：最近 Folder=管理段（可含「段--类型」），再上层 Folder=管理所（以 所/站 结尾）
      const folderNames = [];
      let pn = pm.parentNode;
      while (pn) { if (pn.nodeName === "Folder") { const n = (pn.getElementsByTagName("name")[0] || {}).textContent || ""; if (n) folderNames.push(n); } pn = pn.parentNode; }
      let office = getSimple(pm, "office"), station = getSimple(pm, "station");
      if (!office) office = folderNames.find((n) => /(所|站)$/.test(n)) || "";
      if (!station && folderNames.length) {
        const near = folderNames[0], root = folderNames[folderNames.length - 1];
        if (near && near !== office && near !== root) station = near.split("--")[0];
      }
      // 桌面版回灌增强（win11 首发发现）：Folder 名含「段--类型」时补全 btype（原仅取 station 前半段，类型被丢弃）
      let btype = getSimple(pm, "btype");
      if (!btype && folderNames.length) {
        const near = folderNames[0];
        if (near && near.includes("--") && near.split("--")[0] === station) {
          btype = near.split("--").slice(1).join("--").trim();
        }
      }
      let type = getSimple(pm, "type");
      if (!type && btype && station) type = station + "--" + btype;
      const photoRefs = [];
      // 奥维标准附件元素 OvAttaItem（Url/FileName 属性，或文本内容即路径）
      const ovAtta = pm.getElementsByTagName("OvAttaItem");
      for (const o of ovAtta) {
        const url = o.getAttribute("Url") || o.getAttribute("FileName") || (o.textContent || "").trim();
        if (url) photoRefs.push(url);
      }
      // 旧奥维 / 其他格式 <Attachment>
      const ovAtt2 = pm.getElementsByTagName("Attachment");
      for (const o of ovAtt2) {
        const url = o.getAttribute("Url") || o.getAttribute("FileName") || (o.textContent || "").trim();
        if (url) photoRefs.push(url);
      }
      // description 中的 <img src>/<a href>（含本APP 与奥维导出）
      const imgs = [...desc.matchAll(/(?:src|href)="([^"<\s]+\.(?:jpe?g|png|gif|bmp|webp))/gi)].map((m) => m[1]);
      const id = `${name}_${lon.toFixed(5)}_${lat.toFixed(5)}`;
      out.push({
        id, name, lon, lat,
        office, station, btype, type,
        params, description: desc, photos: [], photoFiles: photoRefs.concat(imgs), base: false, custom: true
      });
    }
    return out;
  }
  function getSimple(pm, k) {
    const sd = pm.getElementsByTagName("SimpleData");
    for (const s of sd) if (s.getAttribute("name") === k) return s.textContent;
    return "";
  }

  // ---------- 导入 ----------
  async function importKmzBuffer(buf) {
    const files = await unzip(new Uint8Array(buf).buffer);
    const kmlName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".kml")) || "doc.kml";
    const kmlText = strFromUtf8(files[kmlName] || new Uint8Array(0));
    const recs = parseKmlToRecords(kmlText);
    // 收集 zip 内所有图片（按全路径与 basename 双索引），兼容奥维不规则命名
    const byFull = {}, byName = {};
    for (const name of Object.keys(files)) {
      if (/\.(jpe?g|png|gif|bmp|webp)$/i.test(name)) {
        byFull[name] = files[name];
        const bn = name.split("/").pop();
        (byName[bn] = byName[bn] || []).push(files[name]);
      }
    }
    const resolveImg = (ref) => {
      if (!ref) return null;
      if (byFull[ref]) return byFull[ref];
      if (byFull["files/" + ref]) return byFull["files/" + ref];
      const bn = ref.split("/").pop();
      if (byName[bn] && byName[bn].length) return byName[bn][0];
      return null;
    };
    // 还原照片：奥维/本APP 引用路径都能解析（全路径 > files/前缀 > basename 兜底）
    for (const r of recs) {
      const seen = new Set();
      r.photos = [];
      for (const ref of (r.photoFiles || [])) {
        const data = resolveImg(ref);
        if (data && !seen.has(data)) {
          seen.add(data);
          try {
            const cp = await ImgUtil.compressPhoto(data);
            r.photos.push({ caption: ref.split("/").pop(), thumb: cp.thumb, full: cp.full, dataUrl: cp.full, hash: cp.hash });
          } catch (e) {
            r.photos.push({ caption: ref.split("/").pop(), dataUrl: "data:image/jpeg;base64," + bytesToB64(data) });
          }
        }
      }
    }
    return recs;
  }

  function parseCsvToRecords(text) { return parseAttrCsv(text); }

  // ---------- GPX / JSON -> 记录 ----------
  function parseGpxToRecords(text) {
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("GPX 解析失败");
    const pts = [].concat(
      [...xml.getElementsByTagName("wpt")],
      [...xml.getElementsByTagName("rtept")],
      [...xml.getElementsByTagName("trkpt")]
    );
    const out = [];
    for (const w of pts) {
      const lon = parseFloat(w.getAttribute("lon")), lat = parseFloat(w.getAttribute("lat"));
      if (isNaN(lon) || isNaN(lat)) continue;
      const name = (w.getElementsByTagName("name")[0] || {}).textContent || "";
      const desc = (w.getElementsByTagName("desc")[0] || {}).textContent || "";
      const cmt = (w.getElementsByTagName("cmt")[0] || {}).textContent || "";
      out.push({
        id: `${name}_${lon.toFixed(5)}_${lat.toFixed(5)}`, name, lon, lat,
        office: "", station: "", btype: "", type: "", params: {}, description: desc || cmt, photos: [], base: false, custom: true
      });
    }
    return out;
  }
  function parseJsonToRecords(text) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("JSON 需为对象数组");
    const out = [];
    for (const o of arr) {
      const lon = parseFloat(o.lon != null ? o.lon : o.经度);
      const lat = parseFloat(o.lat != null ? o.lat : o.纬度);
      if (isNaN(lon) || isNaN(lat)) continue;
      const name = o.name || o.名称 || "";
      const params = o.params || {};
      out.push({
        id: o.id || `${name}_${lon.toFixed(5)}_${lat.toFixed(5)}`, name, lon, lat,
        office: o.office || o.管理所 || "", station: o.station || o.管理站 || "",
        btype: o.btype || o.类型 || "", type: o.type || "",
        params, description: o.description || "", photos: [], base: false, custom: true
      });
    }
    return out;
  }

  // ---------- 潮河格式（CSV 兼容）----------
  function buildChaohe(records, cols) {
    const C = [
      { k: "name", t: "名称", g: (r) => r.name },
      { k: "mgmt", t: "管理处", g: (r) => r.mgmt || "" },
      { k: "office", t: "管理所", g: (r) => normOffice(r.office) },
      { k: "station", t: "管理站", g: (r) => r.station },
      { k: "btype", t: "建筑物类型", g: (r) => r.btype },
      { k: "lon", t: "经度", g: (r) => r.lon },
      { k: "lat", t: "纬度", g: (r) => r.lat },
      { k: "comment", t: "说明", g: (r) => Object.keys(r.params || {}).map((x) => x + ":" + r.params[x]).join(";") },
    ];
    const use = cols && cols.length ? C.filter((c) => cols.includes(c.k)) : C;
    const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const lines = [use.map((c) => c.t).join(",")];
    for (const r of records) lines.push(use.map((c) => (c.k === "lon" || c.k === "lat") ? c.g(r) : esc(c.g(r))).join(","));
    return "\uFEFF" + lines.join("\n");
  }
  // CSV 导出：与「水利工程基础信息一张图_建筑物_*.csv」样本格式对齐（独立列，非 folder 编码），
  // 保证 APP 导出的 CSV 可再导入、且与用户样本文件一致兼容（问题二）。
  function buildCsv(records, cols) {
    const C = [
      { k: "name", t: "名称", g: (r) => r.name || "" },
      { k: "mgmt", t: "管理处", g: (r) => r.mgmt || "" },
      { k: "office", t: "管理所", g: (r) => r.office || "" },
      { k: "mstation", t: "管理站", g: (r) => r.mstation || "" },
      { k: "seg", t: "段", g: (r) => r.station || "" },
      { k: "btype", t: "建筑物类型", g: (r) => r.btype || "" },
      { k: "lat", t: "纬度", g: (r) => r.lat },
      { k: "lon", t: "经度", g: (r) => r.lon },
      { k: "params", t: "参数说明", g: (r) => Object.keys(r.params || {}).map((x) => x + " : " + (r.params[x] == null ? "" : r.params[x])).join(" ; ") },
      { k: "inspect", t: "巡视次数", g: (r) => (r.inspect != null ? r.inspect : 0) },
    ];
    const use = cols && cols.length ? C.filter((c) => cols.includes(c.k)) : C;
    const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const lines = [use.map((c) => c.t).join(",")];
    for (const r of records) lines.push(use.map((c) => (c.k === "lon" || c.k === "lat") ? c.g(r) : esc(c.g(r))).join(","));
    return "\uFEFF" + lines.join("\n");
  }

  // ---------- 下载 ----------
  function downloadBytes(filename, bytes, mime) {
    // APK：经原生 SAF 选择器保存（用户可自定义目录，默认文档/下载）；浏览器/PWA 走标准下载
    // 关键修复：整包 base64 可能远超 Binder 1MB 事务上限 → 单次 JSInterface 调用会 TransactionTooLarge → 写入 0 字节。
    // 改为分块（exportStart/Append/Commit）累积，彻底避开 Binder 限制；写完由原生回调 APP.onExportResult 决定成败提示。
    const br = window.AndroidBridge;
    if (br && typeof br.exportStart === "function" && typeof br.exportAppend === "function" && typeof br.exportCommit === "function") {
      try {
        const b64 = bytesToB64(bytes);
        br.exportStart(filename, mime || "application/octet-stream");
        const CHUNK = 512 * 1024; // 每片 ≤512KB，远低于 Binder 上限
        for (let i = 0; i < b64.length; i += CHUNK) br.exportAppend(b64.slice(i, i + CHUNK));
        br.exportCommit();
        return;
      } catch (e) { /* 回退标准下载 */ }
    }
    if (br && typeof br.exportFile === "function") {
      try {
        const b64 = bytesToB64(bytes);
        br.exportFile(filename, b64, mime || "application/octet-stream");
        return;
      } catch (e) { /* 回退标准下载 */ }
    }
    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function downloadText(filename, text, mime) {
    downloadBytes(filename, utf8(text), mime || "text/plain;charset=utf-8");
  }

  function genId() { return "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7); }

  // ---------- 统一属性表（建筑物导入导出 xls/csv/xlsx 共用，保证往返一致）----------
  const NL = String.fromCharCode(10);
  const ATTR_COLS = [
    { k: "name", t: "名称", g: function (r) { return r.name || ""; } },
    { k: "mgmt", t: "管理处", g: function (r) { return r.mgmt || ""; } },
    { k: "office", t: "管理所", g: function (r) { return r.office || ""; } },
    { k: "station", t: "管理站", g: function (r) { return r.station || ""; } },
    { k: "btype", t: "建筑物类型", g: function (r) { return r.btype || ""; } },
    { k: "lon", t: "经度", num: true, g: function (r) { return r.lon; } },
    { k: "lat", t: "纬度", num: true, g: function (r) { return r.lat; } },
    { k: "desc", t: "说明", g: function (r) { return (Object.keys(r.params || {}).map(function (x) { return x + " : " + r.params[x]; }).join(NL)) || r.description || ""; } }
  ];
  function attrUseCols(cols) { var C = ATTR_COLS; return (cols && cols.length) ? C.filter(function (c) { return cols.indexOf(c.k) >= 0; }) : C; }
  function attrHeader(cols) { return attrUseCols(cols).map(function (c) { return c.t; }); }
  function attrRow(r, cols) { return attrUseCols(cols).map(function (c) { return c.g(r); }); }

  function buildAttrCsv(records, cols) {
    var esc = function (s) { return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"'; };
    var use = attrUseCols(cols);
    var lines = [use.map(function (c) { return c.t; }).join(",")];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      lines.push(use.map(function (c) { return c.num ? c.g(r) : esc(c.g(r)); }).join(","));
    }
    return "﻿" + lines.join(NL);
  }

  function colLetter(n) { var s = ""; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function colIndex(ref) { var n = 0; for (var i = 0; i < ref.length; i++) { var ch = ref.charCodeAt(i); if (ch >= 65 && ch <= 90) n = n * 26 + (ch - 64); } return n - 1; }
  function xmlEsc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
  function xmlUnesc(s) { return String(s == null ? "" : s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
  function isNum(v) { return typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(Number(v))); }

  function xlsxBytesFromMatrix(rows) {
    var sheetRows = rows.map(function (row, ri) {
      var cells = row.map(function (c, ci) {
        var ref = colLetter(ci) + (ri + 1);
        if (isNum(c)) return '<c r="' + ref + '"><v>' + Number(c) + '</v></c>';
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c == null ? "" : c) + '</t></is></c>';
      }).join("");
      return '<row r="' + (ri + 1) + '">' + cells + '</row>';
    }).join("");
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + NL +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows + '</sheetData></worksheet>';
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + NL +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + NL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + NL +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="水利工程" sheetId="1" r:id="rId1"/></sheets></workbook>';
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + NL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    return zipStore([
      { name: "[Content_Types].xml", data: utf8(contentTypes) },
      { name: "_rels/.rels", data: utf8(rels) },
      { name: "xl/workbook.xml", data: utf8(workbook) },
      { name: "xl/_rels/workbook.xml.rels", data: utf8(wbRels) },
      { name: "xl/worksheets/sheet1.xml", data: utf8(sheet) }
    ]);
  }
  function buildAttrXlsx(records, cols) {
    var rows = [attrHeader(cols)];
    for (var i = 0; i < records.length; i++) rows.push(attrRow(records[i], cols));
    return xlsxBytesFromMatrix(rows);
  }

  function xlsBytesFromMatrix(rows) {
    var body = rows.map(function (row) {
      return '<Row>' + row.map(function (c) { return '<Cell><Data ss:Type="' + (isNum(c) ? "Number" : "String") + '">' + xmlEsc(c == null ? "" : c) + '</Data></Cell>'; }).join("") + '</Row>';
    }).join("");
    var xml = '<?xml version="1.0"?>' + NL + '<?mso-application progid="Excel.Sheet"?>' + NL +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="水利工程"><Table>' + body + '</Table></Worksheet></Workbook>';
    return utf8(xml);
  }
  function buildAttrXls(records, cols) {
    var rows = [attrHeader(cols)];
    for (var i = 0; i < records.length; i++) rows.push(attrRow(records[i], cols));
    return xlsBytesFromMatrix(rows);
  }

  // CSV -> 矩阵
  function csvToMatrix(text) {
    var rows = [], i = 0, field = "", row = [], inq = false;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    while (i < text.length) {
      var c = text[i];
      if (inq) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; } else field += c; }
      else { if (c === '"') inq = true; else if (c === ",") { row.push(field); field = ""; } else if (c === NL) { row.push(field); rows.push(row); row = []; field = ""; } else field += c; }
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // 矩阵 -> 记录（按中文表头定位，兼容 新统一/潮河/奥维旧格式/任意超集）
  // 问题二修复：识别「参数说明」列（非仅 说明/Comment）、「段」列→station、「巡视次数」列→inspect；
  // 参数键值对保留空值键（如「备注:」），保证样本 CSV 往返不丢字段。
  function matrixToRecords(matrix) {
    if (!matrix.length) return [];
    var header = matrix[0].map(function (h) { return (h || "").trim(); });
    var idx = function (names) { for (var i = 0; i < names.length; i++) { var k = header.indexOf(names[i]); if (k >= 0) return k; } return -1; };
    var gi = function (row, names) { var i = idx(names); return i >= 0 ? (row[i] || "").trim() : ""; };
    var out = [];
    for (var r = 1; r < matrix.length; r++) {
      var row = matrix[r];
      var name = gi(row, ["名称"]);
      var lon = parseFloat(gi(row, ["经度"]));
      var lat = parseFloat(gi(row, ["纬度"]));
      if (!name || isNaN(lon) || isNaN(lat)) continue;
      var office = gi(row, ["管理所", "机构", "城市"]);
      var mstation = gi(row, ["管理站", "库渠", "区县"]);
      var seg = gi(row, ["段", "渠道段"]);
      var station = seg || mstation;
      var btype = gi(row, ["建筑物类型", "摄像机类型", "古建类型", "类型"]);
      var folder = gi(row, ["文件夹"]);
      if (!office && folder) {
        var fp = folder.split("/").filter(Boolean);
        office = fp[1] || office;
        var fseg = fp[2] || "";
        if (fseg.indexOf("--") >= 0) { var a = fseg.split("--"); if (!station) station = a[0]; if (!btype) btype = a[1]; }
        else if (!btype) btype = fseg;
      }
      var descText = gi(row, ["说明", "Comment", "参数说明"]);
      var inspectRaw = gi(row, ["巡视次数", "Inspect"]);
      var inspect = inspectRaw === "" ? 0 : (parseInt(inspectRaw, 10) || 0);
      var params = {};
      if (descText) descText.split(/[;\n]/).forEach(function (ln) { if (ln.indexOf(":") >= 0) { var a = ln.split(":"); var k = a[0].trim(); var v = a.slice(1).join(":").trim(); params[k] = v; } });
      out.push({
        id: name + "_" + lon.toFixed(5) + "_" + lat.toFixed(5), name: name, lon: lon, lat: lat,
        office: office, mstation: mstation, station: station, btype: btype,
        type: (station && btype) ? station + "--" + btype : btype,
        inspect: inspect, params: params, description: descText, photos: [], base: false, custom: true
      });
    }
    return out;
  }
  function parseAttrCsv(text) { return matrixToRecords(csvToMatrix(text)); }

  // ---------- ovobj / obj 文本坐标（奥维坐标 · 纯文本往返）----------
  // 文本格式：首行可为中文表头（名称/管理所/管理站/建筑物类型/经度/纬度/说明），兼容增删列与超集；
  // 无表头时严格按 `名称,经度,纬度[,管理所,建筑物类型,说明]` 顺序逐行解析。
  // 「奥维原生二进制 .ovobj」（zip/gzip 容器）在 app.js 走 kmz 解包兜底，本函数只负责文本坐标。
  function recordsToOvobj(records, cols) {
    var C = [
      { k: "name", t: "名称", g: function (r) { return r.name || ""; } },
      { k: "mgmt", t: "管理处", g: function (r) { return r.mgmt || ""; } },
      { k: "office", t: "管理所", g: function (r) { return normOffice(r.office) || ""; } },
      { k: "station", t: "管理站", g: function (r) { return r.station || ""; } },
      { k: "btype", t: "建筑物类型", g: function (r) { return r.btype || ""; } },
      { k: "lon", t: "经度", num: true, g: function (r) { return r.lon; } },
      { k: "lat", t: "纬度", num: true, g: function (r) { return r.lat; } },
      { k: "desc", t: "说明", g: function (r) { return (Object.keys(r.params || {}).map(function (x) { return x + " : " + r.params[x]; }).join(NL)) || r.description || ""; } }
    ];
    var use = (cols && cols.length) ? C.filter(function (c) { return cols.indexOf(c.k) >= 0; }) : C;
    var esc = function (s) { return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"'; };
    var lines = ["# 水利工程一张图 ovobj 文本坐标文件（名称/管理所/管理站/建筑物类型/经度/纬度/说明）",
      use.map(function (c) { return c.t; }).join(",")];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      lines.push(use.map(function (c) { return c.num ? c.g(r) : esc(c.g(r)); }).join(","));
    }
    return "﻿" + lines.join(NL);
  }

  function parseOvobjToRecords(text) {
    if (!text) return [];
    var raw = String(text).split(/\r?\n/);
    var data = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i].trim();
      if (!s || s.charAt(0) === "#") continue; // 跳过空行与注释
      data.push(s);
    }
    if (!data.length) return [];
    // 含中文表头 → 复用矩阵解析（稳健、支持超集/缺列）；走 csvToMatrix 以正确处理引号转义
    if (/经度|纬度|名称/.test(data[0])) {
      return matrixToRecords(csvToMatrix(data.join(NL)));
    }
    // 无表头：严格 `名称,经度,纬度[,管理所,建筑物类型,说明]`
    var out = [];
    for (var j = 0; j < data.length; j++) {
      var toks = data[j].split(/[,，\t]/).map(function (t) { return t.trim(); }).filter(function (t) { return t !== ""; });
      if (toks.length < 3) continue;
      var lon = parseFloat(toks[1]), lat = parseFloat(toks[2]);
      if (isNaN(lon) || isNaN(lat)) continue;
      var name = toks[0], office = toks[3] || "", btype = toks[4] || "", desc = toks.slice(5).join(";");
      out.push({
        id: name + "_" + lon.toFixed(5) + "_" + lat.toFixed(5), name: name, lon: lon, lat: lat,
        office: office, station: "", btype: btype, type: btype,
        params: desc ? { 说明: desc } : {}, description: desc, photos: [], base: false, custom: true
      });
    }
    return out;
  }

  // ---------- ovobj 奥维原生二进制（OviO 容器 · 点对象逆向解析/构造）----------
  // 奥维 .ovobj 私有二进制布局（社区逆向 + 2026-08-27 实测 G 盘真实文件「处、所、站」等）：
  //   [0-3]   "OviO" 魔数
  //   [4-11]  8 字节 0
  //   [12-15] u32 LE = 0x69（实测固定 105）
  //   [16-23] 8 字节 0
  //   [24-27] u32 LE = 文件总大小
  //   [28+]   数据区：点对象 = double(lat) + double(lon) + u32(图标ID) + Pascal串(名称)…
  // 线/面坐标为奥维私有压缩编码（无法可靠还原），仅提取点对象；名称以 Pascal 串（1 字节长度前缀+UTF-8）扫描。
  function _u32le(v) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
  function _f64le(v) { var b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; }

  function parseOvobjBinary(bytes) {
    // bytes: Uint8Array；魔数不符返回 null（让调用方走文本解析），否则返回点对象 records
    if (!bytes || bytes.length < 16) return null;
    if (bytes[0] !== 0x4f || bytes[1] !== 0x76 || bytes[2] !== 0x69 || bytes[3] !== 0x4f) return null;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var n = bytes.length;
    // 1) 扫描成对 (lat, lon) double（中国经纬度范围过滤误报）
    var hits = [];
    for (var i = 0; i + 16 <= n; ) {
      var lat = dv.getFloat64(i, true), lon = dv.getFloat64(i + 8, true);
      if (lat > 3.86 && lat < 54 && lon > 73 && lon < 136) { hits.push({ lat: lat, lon: lon, off: i }); i += 16; }
      else i += 1;
    }
    // 2) 扫描 Pascal 串名称（1 字节长度前缀 + UTF-8）
    var names = [];
    for (var j = 0; j < n; ) {
      var lb = bytes[j];
      if (lb >= 1 && lb <= 64 && j + 1 + lb <= n) {
        var s = strFromUtf8(bytes.subarray(j + 1, j + 1 + lb));
        if (s && /^[\x20-\x7e\u3400-\u9fff\uf900-\ufaff\uff00-\uffef，。、；：（）()0-9a-zA-Z·\-_ ]+$/.test(s)) { names.push(s); j += 1 + lb; continue; }
      }
      j += 1;
    }
    // 3) 组装 records（坐标对与名称按出现顺序配对；图标 = lat 起点 +20 处 u32）
    var out = [];
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k];
      var nm = names[k] || ("奥维点" + (k + 1));
      var icon = null, pos = h.off + 20;
      if (pos + 4 <= n) { var ic = dv.getUint32(pos, true); if (ic < 0x10000) icon = ic; }
      out.push({
        id: nm + "_" + h.lon.toFixed(5) + "_" + h.lat.toFixed(5), name: nm, lon: h.lon, lat: h.lat,
        office: "", station: "", btype: "", type: "", params: icon != null ? { 图标: icon } : {},
        description: "", photos: [], base: false, custom: true
      });
    }
    return out;
  }

  function recordsToOvobjBinary(records) {
    // 构造奥维 OviO 二进制（点对象布局与 parseOvobjBinary 对齐，APP 往返自洽；奥维可尽力读取）
    var body = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var lat = parseFloat(r.lat), lon = parseFloat(r.lon);
      if (isNaN(lat) || isNaN(lon)) continue;
      var icon = 4;
      if (r.params && r.params["图标"] != null) { var pv = parseInt(r.params["图标"], 10); if (!isNaN(pv) && pv >= 0 && pv < 0x10000) icon = pv; }
      var nm = String(r.name || ("点" + (i + 1))).slice(0, 64);
      // 布局与奥维一致：lat(8) + lon(8) + 4 字节间隔 + 图标 u32（lat 起点 +20）+ Pascal 串
      body.push(_f64le(lat), _f64le(lon), _u32le(0), _u32le(icon));
      var nb = utf8(nm);
      body.push(new Uint8Array([nb.length]), nb);
    }
    var bodyBytes = new Uint8Array(body.reduce(function (a, b) { return a + b.length; }, 0));
    var o = 0;
    for (var b2 = 0; b2 < body.length; b2++) { bodyBytes.set(body[b2], o); o += body[b2].length; }
    var total = 28 + bodyBytes.length;
    var out = new Uint8Array(total);
    out.set(utf8("OviO"), 0);                       // 0-3 魔数
    out.set(_u32le(0x69), 12);                       // 12-15 版本/标志
    out.set(_u32le(total), 24);                      // 24-27 文件总大小
    out.set(bodyBytes, 28);                          // 28+ 数据区
    return out;
  }

  // xlsx -> 矩阵（手写 XML 扫描，浏览器/Node 通用，无需 DOMParser）
  function xlsxMatrix(fmap) {
    var sheetName = null;
    for (var k in fmap) { if (/worksheets\/sheet[0-9]+\.xml$/.test(k)) { sheetName = k; break; } }
    if (!sheetName) for (var k2 in fmap) { if (k2.indexOf("sheet") >= 0 && k2.endsWith(".xml")) { sheetName = k2; break; } }
    if (!sheetName) throw new Error("xlsx 中未找到工作表");
    var sheet = strFromUtf8(fmap[sheetName]);
    var shared = [];
    for (var sk in fmap) {
      if (sk.endsWith("sharedStrings.xml")) {
        var ss = strFromUtf8(fmap[sk]);
        var sim = ss.match(/<si>([\s\S]*?)<\/si>/g) || [];
        for (var vvar = 0; vvar < sim.length; vvar++) {
          var ts = sim[vvar].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
          var t = ts.map(function (x) { return xmlUnesc((x.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [,""])[1]); }).join("");
          shared.push(t);
        }
      }
    }
    var rows = [];
    var rowEls = sheet.match(/<row\b[\s\S]*?<\/row>/g) || [];
    for (var ri = 0; ri < rowEls.length; ri++) {
      var cells = rowEls[ri].match(/<c\b[\s\S]*?<\/c>/g) || [];
      var cellMap = {}, maxCol = -1;
      for (var ci = 0; ci < cells.length; ci++) {
        var cEl = cells[ci];
        var rAttr = (cEl.match(/r="([A-Z]+[0-9]+)"/) || [,"A1"])[1];
        var col = colIndex(rAttr);
        var val = "";
        if (/t="s"/.test(cEl)) { var v1 = (cEl.match(/<v>([\s\S]*?)<\/v>/) || [,"0"])[1]; val = shared[parseInt(v1, 10)] != null ? shared[parseInt(v1, 10)] : ""; }
        else if (/<v>/.test(cEl)) { val = (cEl.match(/<v>([\s\S]*?)<\/v>/) || [,""])[1]; }
        else { var t1 = (cEl.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [,""])[1]; val = xmlUnesc(t1 || ""); }
        cellMap[col] = val; if (col > maxCol) maxCol = col;
      }
      var arr = []; for (var c2 = 0; c2 <= maxCol; c2++) arr.push(cellMap[c2] != null ? cellMap[c2] : "");
      rows.push(arr);
    }
    return rows;
  }
  async function parseXlsxToRecords(bytes) {
    var buf = (bytes instanceof Uint8Array) ? bytes.buffer : bytes;
    var fmap = await unzip(buf);
    return matrixToRecords(xlsxMatrix(fmap));
  }

  // xls（SpreadsheetML 2003）-> 矩阵；真正的 BIFF8 二进制 .xls 不支持，明确报错（不静默失败）
  function parseXlsToRecords(input) {
    var text;
    if (input instanceof Uint8Array) {
      if (input[0] === 0xD0 && input[1] === 0xCF && input[2] === 0x11 && input[3] === 0xE0)
        throw new Error("不支持 Excel 二进制 .xls（BIFF8）。请另存为 .xlsx 或 .csv 后再导入");
      text = strFromUtf8(input);
    } else text = String(input || "");
    var rows = [];
    var rowEls = text.match(/<Row\b[\s\S]*?<\/Row>/g) || [];
    for (var i = 0; i < rowEls.length; i++) {
      var cells = rowEls[i].match(/<Cell\b[\s\S]*?<\/Cell>/g) || [];
      var arr = cells.map(function (cEl) { var m = cEl.match(/<Data[^>]*>([\s\S]*?)<\/Data>/); return m ? xmlUnesc(m[1]) : ""; });
      rows.push(arr);
    }
    return matrixToRecords(rows);
  }

  global.IO = {
    escapeXml, crc32, zipStore, unzip, unzipStream, unzipCount, buildKML, buildCsv, buildChaohe, recordsToKmzBytes,
    parseKmlToRecords, parseGpxToRecords, parseJsonToRecords, importKmzBuffer, parseCsvToRecords,
    downloadBytes, downloadText, genId, bytesToB64, b64ToBytes, utf8,
    sha256Hex, // 内容去重哈希（v1.8.0 定义；曾漏导出导致导入 ovkmz 报「IO.sha256Hex is not a function」）
    sha256: { hex: sha256Hex }, // 兼容别名（对象式调用 io.sha256.hex() 也可用）
    csvOf: buildCsv, chaoheOf: buildChaohe,
    // 导出入口
    exportOvkmz(records, root) { downloadBytes((root || "水利工程基础信息") + ".ovkmz", recordsToKmzBytes(records), "application/vnd.google-earth.kmz"); },
    exportKmz(records, root) { downloadBytes((root || "水利工程基础信息") + ".kmz", recordsToKmzBytes(records), "application/vnd.google-earth.kmz"); },
    exportKml(records, root) { downloadText((root || "水利工程基础信息") + ".kml", buildKML(records, root), "application/vnd.google-earth.kml+xml"); },
    exportCsv(records, root, cols) { downloadText((root || "水利工程基础信息") + ".csv", buildCsv(records, cols), "text/csv;charset=utf-8"); },
    exportChaoheFile(records, root, cols) { downloadText((root || "水利工程基础信息") + "_潮河.csv", buildChaohe(records, cols), "text/csv;charset=utf-8"); },
    parseAttrCsv, parseXlsxToRecords, parseXlsToRecords, xlsxMatrix, // xlsxMatrix 导出供 kb.js 外部文件智能转换（v2.4.5）
    buildAttrCsv, buildAttrXlsx, buildAttrXls,
    attrCsvOf: buildAttrCsv, attrXlsxOf: buildAttrXlsx, attrXlsOf: buildAttrXls,
    exportAttrCsv(records, root, cols) { downloadText((root || "水利工程信息") + ".csv", buildAttrCsv(records, cols), "text/csv;charset=utf-8"); },
    exportXlsx(records, root, cols) { downloadBytes((root || "水利工程信息") + ".xlsx", buildAttrXlsx(records, cols), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); },
    exportXls(records, root, cols) { downloadBytes((root || "水利工程信息") + ".xls", buildAttrXls(records, cols), "application/vnd.ms-excel"); },
    // ovobj/obj 文本坐标（奥维坐标 · 纯文本往返）+ 奥维原生二进制（OviO 容器 · 点对象）
    parseOvobjToRecords, recordsToOvobj, parseOvobjBinary, recordsToOvobjBinary,
    exportOvobj(records, root, cols) { downloadText((root || "水利工程信息") + ".ovobj", recordsToOvobj(records, cols), "text/plain;charset=utf-8"); },
    exportOvobjBin(records, root) { downloadBytes((root || "水利工程信息") + ".ovobj", recordsToOvobjBinary(records), "application/octet-stream"); },
  };
})(window);
