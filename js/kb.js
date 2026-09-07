/* kb.js —— 知识库引擎（md + json 混合，IndexedDB 承载）
 * 落点：三端同源，四平台透明（纯 JS，WebView / Safari / Electron 通用）。
 * 架构：每条知识 = { id, type, title, tags[], updated, md, meta }
 *   md   = Markdown 正文（对 LLM 最友好、token 极低）
 *   meta = JSON 元数据（标题/标签/时间/类型/来源），用于"先查索引再读正文"
 * 备份：v2.4.5 起主通道 = 单文件 md / txt / html 导入导出（主流知识库兼容）——
 *      导出 md：每条知识 = <!-- kb-entry --> 注释锚 + YAML front matter（title/tags/updated/id）+ 正文，
 *      Obsidian / Joplin / 语雀 / Notion 可直接导入；导入同样支持 md/txt/html（可多选，front matter 自动还原元数据）。
 *      旧 .zip 完整备份（md+json+索引）仍保留导入/导出兼容（导出对话框选 zip）。
 * 外文件入库（v2.4.5 智能转换）：pdf/docx/xlsx/html/csv/txt/md/json → 引擎内零依赖转换为 Markdown（带进度回调）→ 入库；
 *      旧式二进制 .doc / BIFF8 .xls 无法可靠解析 → 明确报错引导另存 docx/xlsx。
 * 智能框架（v2.4.6）：保存即"切片+向量化"（句子级切片，尽量保持语句完整，长段按句切且重叠衔接）；
 *      离线哈希向量（中英文混排，无外部依赖）+ 关键词命中 = 混合检索；支持反向查询（内容→条目）、模糊/语义查询；
 *      引入记忆管理（MEMORY）与 Hermes 自我学习机制，与已接入大模型有机融合（AI 提示词自动拼装 KB 片段 + 记忆）。
 */
(function (global) {
  const DB = "kb_app";
  const STORE = "entries";
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "id" }); };
      r.onsuccess = () => { _db = r.result; res(_db); };
      r.onerror = () => rej(r.error);
    });
  }
  function tx(mode) { return open().then((db) => db.transaction(STORE, mode).objectStore(STORE)); }
  function put(e) {
    e.updated = e.updated || Date.now();
    _hayCache.delete(e.id);
    // v2.4.6 智能框架：保存即切片+向量化（句子相对完整；离线哈希向量），供混合检索/反向查询/模糊查询
    if (e && e.md != null) {
      try {
        if (!e.chunks || !e.chunks.length) e.chunks = chunkText(e.md);
        if (!e.vec) e.vec = vecOf(e);
      } catch (_) { /* 切片失败不阻断保存 */ }
    }
    return tx("readwrite").then((os) => new Promise((res, rej) => { const r = os.put(e); r.onsuccess = () => res(e); r.onerror = () => rej(r.error); }));
  }
  function get(id) { return tx("readonly").then((os) => new Promise((res, rej) => { const r = os.get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); })); }
  function all() { return tx("readonly").then((os) => new Promise((res, rej) => { const r = os.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); })); }
  function del(id) { _hayCache.delete(id); return tx("readwrite").then((os) => new Promise((res, rej) => { const r = os.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); })); }
  function clear() { _hayCache.clear(); return tx("readwrite").then((os) => new Promise((res, rej) => { const r = os.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); })); }
  function uid() { return "kb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------- 索引（JSON，轻量，供"先查索引再读正文"）----------
  function buildIndex(entries) {
    entries = entries || [];
    return entries.map((e) => ({ id: e.id, type: e.type, title: e.title, tags: e.tags || [], updated: e.updated, size: (e.md || "").length }));
  }

  // ---------- 检索：少则全喂；多则先查索引再读命中正文（BM25/关键词）----------
  // v2.4.5 查询效率：检索串（标题+标签+正文小写）按 id 缓存（put/del/clear 失效），多词条查询不再每次重建大字符串
  const _hayCache = new Map();
  function hayOf(e) {
    let h = _hayCache.get(e.id);
    if (h == null) { h = ((e.title || "") + " " + (e.tags || []).join(" ") + " " + (e.md || "")).toLowerCase(); _hayCache.set(e.id, h); }
    return h;
  }
  async function retrieve(query, k) {
    const es = await all();
    if (!es.length) return "";
    if (es.length <= 50) return es.filter((e) => e.id !== "ops_log").map((e) => "# " + (e.title || e.id) + "\n" + (e.md || "")).join("\n\n---\n\n");
    const q = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const qv = embed(query);
    let scored = es.map((e) => {
      const hay = hayOf(e);
      let s = 0; for (const t of q) if (hay.indexOf(t) >= 0) s += 1;
      const vec = cosine(qv, vecArray(e));        // 向量相似度（模糊/语义）
      const comb = (s > 0 ? 1 : 0) + vec * 0.9;     // 混合检索：关键词命中 + 向量相似
      return { e, s: comb, kw: s, vec };
    }).filter((x) => x.s > 0.02).sort((a, b) => b.s - a.s);
    if (!scored.length) scored = es.slice(0, 20).map((e) => ({ e, s: 0 }));
    scored = scored.slice(0, k || 15);
    return scored.map((x) => "# " + (x.e.title || x.e.id) + "\n" + (x.e.md || "")).join("\n\n---\n\n");
  }

  // ---------- 骨架自动生成：从建筑物台账建核心知识库 ----------
  async function rebuildSkeleton(records) {
    await clear();
    const entries = [];
    for (const r of (records || [])) {
      const ph = (r.photos || []).length;
      const rows = Object.entries(r.params || {}).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
      const md = [
        `# ${r.name || "未命名"}`,
        "",
        `- 管理所：${r.office || "-"}`,
        `- 管理站/渠道段：${r.station || "-"}`,
        `- 类型：${r.btype || "-"}`,
        `- 坐标：${r.lat}, ${r.lon}`,
        `- 照片：${ph} 张（存储于本地 IndexedDB / 附件，离线可用）`,
        "",
        "## 工程参数",
        rows ? "| 字段 | 值 |\n|---|---|\n" + rows : "（无）",
      ].join("\n");
      entries.push({ id: "bld_" + (r.id || uid()), type: "building", title: r.name || "未命名", tags: [r.office, r.btype, "建筑"].filter(Boolean), md, meta: { source: "skeleton", rid: r.id } });
    }
    const idxMd = [
      "# 建筑物总索引", "",
      "| 名称 | 管理所 | 类型 | 坐标 | 照片 |", "|---|---|---|---|---|",
      ...records.map((r) => `| ${r.name || ""} | ${r.office || ""} | ${r.btype || ""} | ${r.lat},${r.lon} | ${(r.photos || []).length} |`),
    ].join("\n");
    entries.push({ id: "index", type: "index", title: "建筑物总索引", tags: ["索引"], md: idxMd, meta: { source: "skeleton" } });
    for (const e of entries) await put(e);
    return entries.length;
  }

  // ---------- 异步智能写入：操作日志（防抖，不阻塞 UI）----------
  let _opBuf = [];
  let _opTimer = null;
  function logOp(desc, params) {
    _opBuf.push({ desc, params, t: Date.now() });
    if (_opTimer) return;
    _opTimer = setTimeout(flushOps, 800);
  }
  async function flushOps() {
    _opTimer = null;
    if (!_opBuf.length) return;
    const items = _opBuf; _opBuf = [];
    const md = items.map((it) => `- ${new Date(it.t).toLocaleString()} ${it.desc}` + (it.params ? ` :: ${JSON.stringify(it.params)}` : "")).join("\n");
    const existing = await get("ops_log");
    const prev = existing ? existing.md : "# 操作日志\n";
    await put({ id: "ops_log", type: "ops", title: "操作日志", tags: ["操作", "日志"], md: prev + "\n" + md, meta: {} });
  }

  // ---------- Hermes 学习循环：对话/操作后异步总结 → 追加 MEMORY ----------
  async function hermes(text) {
    const existing = await get("MEMORY");
    const prev = existing ? existing.md : "# MEMORY（Hermes 自我学习）\n";
    await put({ id: "MEMORY", type: "memory", title: "MEMORY", tags: ["hermes", "记忆"], md: prev + "\n- " + text, meta: {} });
  }

  // ---------- 导入外部文件（csv/txt/md 直接；pdf/xls/doc 提示转格式）----------
  function parseExternal(name, text) {
    const lower = (name || "").toLowerCase();
    const title = (name || "外部文件").replace(/\.[^.]+$/, "");
    let md;
    if (lower.endsWith(".csv")) {
      const lines = text.split(/\r?\n/).filter(Boolean);
      const rows = lines.map((l) => l.split(",").map((c) => c.trim()));
      const tbl = rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
      md = `# ${title}\n\n` + tbl;
    } else {
      md = `# ${title}\n\n` + text;
    }
    return { id: uid(), type: "import", title, tags: ["导入", lower.endsWith(".csv") ? "csv" : "文档"], md, meta: { source: "external", file: name } };
  }

  // ==================================================================
  // ============ 主流知识库格式兼容 + 外部文件智能转 md（v2.4.5）============
  // ==================================================================

  // ---------- YAML front matter（Obsidian / Joplin / 语雀 / Notion 兼容口径）----------
  function frontMatter(e) {
    const esc = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").replace(/^["']|["']$/g, "");
    return ["---",
      "title: " + esc(e.title || e.id),
      "tags: [" + (e.tags || []).map(esc).join(", ") + "]",
      "type: " + esc(e.type || "doc"),
      "updated: " + (e.updated ? new Date(e.updated).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)),
      "id: " + esc(e.id),
      "---"].join("\n");
  }
  function parseFrontMatter(text) {
    const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { meta: null, md: text };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      meta[kv[1].toLowerCase()] = v;
    }
    return { meta, md: m[2] };
  }

  // ---------- 极简 md → html（导出 html 用；零依赖）----------
  function mdToHtml(md) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    const lines = String(md || "").split(/\r?\n/);
    const out = []; let inUl = false, inTable = false;
    const closeAll = () => { if (inUl) { out.push("</ul>"); inUl = false; } if (inTable) { out.push("</tbody></table>"); inTable = false; } };
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const hm = L.match(/^(#{1,6})\s+(.*)$/);
      const li = L.match(/^\s*[-*]\s+(.*)$/);
      const isTableRow = /^\s*\|.*\|\s*$/.test(L);
      const isTableSep = /^\s*\|[\s:|-]+\|\s*$/.test(L);
      if (hm) { closeAll(); out.push("<h" + hm[1].length + ">" + inline(hm[2]) + "</h" + hm[1].length + ">"); }
      else if (li) { if (!inUl) { closeAll(); out.push("<ul>"); inUl = true; } out.push("<li>" + inline(li[1]) + "</li>"); }
      else if (isTableSep) { /* 分隔行跳过 */ }
      else if (isTableRow) {
        const cells = L.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        if (!inTable) { closeAll(); out.push('<table border="1" cellpadding="4" cellspacing="0"><tbody>'); inTable = true; }
        out.push("<tr>" + cells.map((c) => "<td>" + c + "</td>").join("") + "</tr>");
      }
      else if (/^\s*(---+|\*\*\*+)\s*$/.test(L)) { closeAll(); out.push("<hr>"); }
      else if (!L.trim()) { closeAll(); }
      else { closeAll(); out.push("<p>" + inline(L) + "</p>"); }
    }
    closeAll();
    return out.join("\n");
  }

  // ---------- html → md（导入网页/公众号文章等；零依赖，正则口径与 xlsxMatrix 一致）----------
  function htmlToMd(html) {
    let s = String(html || "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
    const inlineOf = (t) => t
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, h, t) => "[" + t.trim() + "](" + h + ")")
      .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, "![$1]($2)")
      .replace(/<img\b[^>]*src=["']([^"']*)["'][^>]*>/gi, "![]($1)")
      .replace(/<[^>]+>/g, "");
    const ent = (t) => t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
    // 表格 → md 表
    s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => {
      const rows = [];
      const trs = inner.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi) || [];
      for (const tr of trs) {
        const cells = (tr.match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi) || []).map((c) => ent(inlineOf(c)).replace(/\|/g, "\\|").trim().replace(/\n+/g, " "));
        rows.push("| " + cells.join(" | ") + " |");
        if (rows.length === 1) rows.push("|" + cells.map(() => "---").join("|") + "|");
      }
      return "\n\n" + rows.join("\n") + "\n\n";
    });
    s = s.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, t) => "\n\n" + "#".repeat(+tag[1]) + " " + ent(inlineOf(t)).trim() + "\n\n");
    s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => "\n- " + ent(inlineOf(t)).trim());
    s = s.replace(/<\/(p|div|section|article|blockquote|tr|h\d)>/gi, "\n\n").replace(/<blockquote\b[^>]*>/gi, "\n\n> ");
    s = ent(inlineOf(s));
    // 压缩空行
    s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return s;
  }

  // ---------- docx → md（零依赖：unzip + 正则扫 word/document.xml，与 xlsxMatrix 同口径）----------
  function xmlText(s) { return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"); }
  function docxXmlToMd(xml) {
    const body = (xml.match(/<w:body[\s\S]*?<\/w:body>/) || [xml])[0];
    const out = [];
    // 逐顶层块：w:p（段落/标题/列表）与 w:tbl（表格）
    const blocks = body.match(/<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g) || [];
    for (const b of blocks) {
      if (b.startsWith("<w:tbl")) {
        const trs = b.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
        const rows = trs.map((tr) => (tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map((tc) => {
          const ts = tc.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
          return xmlText(ts.map((x) => x.replace(/<[^>]+>/g, "")).join("")).replace(/\|/g, "\\|").trim();
        }));
        if (rows.length) {
          out.push("| " + rows[0].join(" | ") + " |");
          out.push("|" + rows[0].map(() => "---").join("|") + "|");
          for (let i = 1; i < rows.length; i++) out.push("| " + rows[i].join(" | ") + " |");
        }
        continue;
      }
      const ts = b.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
      const text = xmlText(ts.map((x) => x.replace(/<[^>]+>/g, "")).join("")).trim();
      if (!text) continue;
      const hm = b.match(/w:pStyle\s+w:val="(?:(?:Heading|heading)([1-6])|([1-6]))"/);
      const hLv = hm ? (+hm[1] || +hm[2]) : 0;
      const isList = /<w:numPr\b/.test(b);
      out.push((hm ? "#".repeat(+hm[1]) + " " : isList ? "- " : "") + text);
    }
    return out.join("\n\n");
  }

  // ---------- pdf → md（零依赖尽力提取：FlateDecode 流解压 + 文本操作符扫描；扫描件/加密件明确报错不静默）----------
  const PDF_ESCAPE_MAP = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  function pdfDecodeLiteral(lit) {
    let out = "", i = 0;
    while (i < lit.length) {
      const c = lit[i];
      if (c === "\\") {
        const nx = lit[i + 1];
        if (nx && PDF_ESCAPE_MAP[nx] != null) { out += PDF_ESCAPE_MAP[nx]; i += 2; }
        else if (/[0-7]/.test(nx || "")) { const oct = lit.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0]; out += String.fromCharCode(parseInt(oct, 8)); i += 1 + oct.length; }
        else { out += nx || ""; i += 2; }
      } else { out += c; i += 1; }
    }
    return out;
  }
  async function pdfStreamText(raw) {
    if (typeof DecompressionStream === "undefined") throw new Error("当前环境不支持在线解压，无法解析 PDF；请改用电脑端或先转 Word/文本");
    for (const fmt of ["deflate", "deflate-raw"]) {
      try {
        const ds = new DecompressionStream(fmt);
        const w = ds.writable.getWriter(); w.write(raw); w.close();
        const rd = ds.readable.getReader(); const parts = []; let r;
        while (!(r = await rd.read()).done) parts.push(r.value);
        const len = parts.reduce((a, b) => a + b.length, 0);
        const merged = new Uint8Array(len); let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.length; }
        let s = ""; const CH = 0x8000;
        for (let i = 0; i < merged.length; i += CH) s += String.fromCharCode.apply(null, merged.subarray(i, Math.min(i + CH, merged.length)));
        return s;
      } catch (e) { /* 换下一种格式重试 */ }
    }
    return null;
  }
  function pdfContentToText(content) {
    // 扫描文本操作符：( ... ) Tj / [ (..) (..) ] TJ；遇到 Td/TD/T*/ET 视为换行
    let out = "", i = 0, n = content.length;
    const push = (t) => { out += t; };
    while (i < n) {
      const c = content[i];
      if (c === "(") {
        let depth = 1, j = i + 1, lit = "";
        while (j < n && depth > 0) {
          const cj = content[j];
          if (cj === "\\") { lit += cj + (content[j + 1] || ""); j += 2; continue; }
          if (cj === "(") depth++;
          else if (cj === ")") { depth--; if (!depth) break; }
          lit += cj; j++;
        }
        push(pdfDecodeLiteral(lit));
        i = j + 1;
      } else if (c === "<" && content[i + 1] !== "<") {
        const e = content.indexOf(">", i);
        if (e < 0) break;
        const hex = content.slice(i + 1, e).replace(/[^0-9A-Fa-f]/g, "");
        let s = "";
        for (let h = 0; h + 3 < hex.length; h += 4) { const code = parseInt(hex.slice(h, h + 4), 16); if (code >= 32 || code === 10) s += String.fromCharCode(code); }
        push(s); i = e + 1;
      } else if (/[A-Za-z'"*]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9'"*]/.test(content[j])) j++;
        const op = content.slice(i, j);
        if (op === "Td" || op === "TD" || op === "T*" || op === "ET" || op === "BT") push("\n");
        i = j;
      } else i++;
    }
    return out;
  }
  function looksLikeText(s) {
    if (!s || s.length < 20) return false;
    let good = 0;
    for (const ch of s) if (/[\u4e00-\u9fa5A-Za-z0-9\s，。、；：！？（）【】《》“”‘’…—\-.,;:!?'"()%\[\]{}<>@#$&*+=\/\\|~`_]/.test(ch)) good++;
    return good / s.length >= 0.7;
  }
  async function pdfToMd(bytes, onProg) {
    let head = ""; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) head += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    if (!/^%PDF-/.test(head.slice(0, 8))) throw new Error("不是有效的 PDF 文件");
    if (/\/Encrypt\b/.test(head)) throw new Error("该 PDF 已加密，无法提取文本；请解密或先转 Word 后再导入");
    const streams = []; let pos = 0;
    while (true) {
      const si = head.indexOf("stream", pos);
      if (si < 0) break;
      let ds = si + 6;
      if (head[ds] === "\r") ds++; if (head[ds] === "\n") ds++;
      const ei = head.indexOf("endstream", ds);
      if (ei < 0) break;
      streams.push({ start: ds, end: ei });
      pos = ei + 9;
    }
    if (!streams.length) throw new Error("PDF 中未找到内容流；请先转 Word/文本后再导入");
    const texts = [];
    for (let i = 0; i < streams.length; i++) {
      if (onProg) onProg(Math.round(5 + (i / streams.length) * 85), "解析 PDF 内容流 " + (i + 1) + "/" + streams.length + "…");
      const raw = bytes.subarray(streams[i].start, streams[i].end);
      let data = await pdfStreamText(raw);
      if (data == null) { // 未压缩流（部分生成器不压缩）：直接按 latin1 读
        try { data = String.fromCharCode.apply(null, raw.subarray(0, Math.min(raw.length, 4194304))); } catch (e) { continue; }
      }
      if (!/(Tj|TJ)\s/.test(data) && !/\)\s*T[jJ]/.test(data)) continue; // 非文本流（图片/字体）跳过
      const t = pdfContentToText(data);
      if (looksLikeText(t)) texts.push(t);
      if (texts.length >= 400) break; // 防超大文档卡顿
    }
    const md = texts.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!looksLikeText(md)) throw new Error("该 PDF 为扫描件/图片型或使用了特殊字体编码，无法直接提取文字；请先转 Word / 文本（或 OCR）后再导入");
    return md;
  }

  // ---------- 扫描件 PDF 兜底（v2.4.5+ 内置轻量 OCR）：内嵌页图提取 → OCR → md ----------
  // 支持：DCTDecode(JPEG) 直取；FlateDecode 位图(8bpc Gray/RGB/CMYK) 还原 canvas。CCITT/JBIG2 传真编码明确报错引导。
  async function pdfInflateBytes(raw) {
    if (typeof DecompressionStream === "undefined") throw new Error("当前环境不支持在线解压，无法解析 PDF 页图");
    for (const fmt of ["deflate", "deflate-raw"]) {
      try {
        const ds = new DecompressionStream(fmt);
        const w = ds.writable.getWriter(); w.write(raw); w.close();
        const rd = ds.readable.getReader(); const parts = []; let r;
        while (!(r = await rd.read()).done) parts.push(r.value);
        const len = parts.reduce((a, b) => a + b.length, 0);
        const merged = new Uint8Array(len); let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.length; }
        return merged;
      } catch (e) { /* 试下一种格式 */ }
    }
    return null;
  }
  function pdfExtractImages(bytes, onProg) {
    let head = ""; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) head += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    const imgs = []; let pos = 0;
    while (true) {
      const si = head.indexOf("stream", pos);
      if (si < 0) break;
      let ds = si + 6;
      if (head[ds] === "\r") ds++; if (head[ds] === "\n") ds++;
      const ei = head.indexOf("endstream", ds);
      if (ei < 0) break;
      const dictStart = Math.max(0, head.lastIndexOf("<<", si));
      const dict = head.slice(dictStart, si);
      if (/\/Subtype\s*\/Image\b/.test(dict)) {
        const num = (k) => { const m = dict.match(new RegExp("\\/" + k + "\\s+(\\d+)")); return m ? +m[1] : 0; };
        const fm = dict.match(/\/Filter\s*\[?\s*\/(\w+)/);
        const cs = (dict.match(/\/ColorSpace\s*\/(\w+)/) || [])[1] || "";
        let end = ei;
        while (end > ds && (bytes[end - 1] === 10 || bytes[end - 1] === 13)) end--; // 去掉 endstream 前 EOL
        imgs.push({ filter: fm ? fm[1] : "", w: num("Width"), h: num("Height"), bpc: num("BitsPerComponent") || 8, cs, data: bytes.subarray(ds, end) });
      }
      pos = ei + 9;
    }
    return imgs;
  }
  function bitmapToCanvas(raw, w, h, bpc, cs) {
    if (bpc !== 8 || !(w > 0) || !(h > 0)) return null;
    const comp = (cs === "DeviceGray" || cs === "G" || cs === "CalGray") ? 1 : (cs === "DeviceCMYK" || cs === "CMYK") ? 4 : 3;
    if (raw.length < w * h * comp) return null;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    const id = ctx.createImageData(w, h);
    for (let p = 0, q = 0; p < w * h; p++) {
      if (comp === 1) { const g = raw[p]; id.data[q++] = g; id.data[q++] = g; id.data[q++] = g; id.data[q++] = 255; }
      else if (comp === 3) { id.data[q++] = raw[p * 3]; id.data[q++] = raw[p * 3 + 1]; id.data[q++] = raw[p * 3 + 2]; id.data[q++] = 255; }
      else { const c = raw[p * 4], m2 = raw[p * 4 + 1], y = raw[p * 4 + 2], k = raw[p * 4 + 3]; // CMYK 粗转 RGB
        id.data[q++] = 255 - Math.min(255, c + k); id.data[q++] = 255 - Math.min(255, m2 + k); id.data[q++] = 255 - Math.min(255, y + k); id.data[q++] = 255; }
    }
    ctx.putImageData(id, 0, 0);
    return cv;
  }
  async function pdfOcrToMd(bytes, onProg) {
    if (!window.OCR || typeof OCR.recognize !== "function") throw new Error("OCR 引擎未加载（js/ocr.js），无法识别扫描件");
    const imgs = pdfExtractImages(bytes, onProg);
    const usable = imgs.filter((im) =>
      (im.filter === "DCTDecode" && im.data.length > 2 && im.data[0] === 0xFF && im.data[1] === 0xD8) ||
      (im.filter === "FlateDecode" && im.w > 0 && im.h > 0));
    if (!usable.length) throw new Error("扫描件 PDF 中未找到可识别的页图（仅支持 JPEG/位图编码；CCITT/JBIG2 传真编码请先把页面转存为图片再导入）");
    const parts = [];
    for (let i = 0; i < usable.length; i++) {
      const im = usable[i];
      if (onProg) onProg(Math.round(5 + (i / usable.length) * 88), "OCR 识别第 " + (i + 1) + "/" + usable.length + " 页…");
      let text = "";
      try {
        if (im.filter === "DCTDecode") {
          text = await OCR.recognize(new Blob([im.data], { type: "image/jpeg" }), onProg);
        } else {
          const raw = await pdfInflateBytes(im.data);
          const cv = raw ? bitmapToCanvas(raw, im.w, im.h, im.bpc, im.cs) : null;
          if (cv) text = await OCR.recognize(cv, onProg);
        }
      } catch (e) { text = ""; } // 单页失败不拖垮整档
      if (text && text.trim()) parts.push((usable.length > 1 ? "## 第 " + (i + 1) + " 页\n\n" : "") + text.trim());
      if (parts.length >= 120) break; // 防超大扫描件卡顿
    }
    const md = parts.join("\n\n");
    if (!looksLikeText(md)) throw new Error("OCR 未识别出有效文字（图片可能过模糊或为手写体）；建议拍清/转存更清晰的图片后重试");
    return md;
  }

  // ---------- 统一入口：外部文件智能转换 → md → 入库（带进度回调 onProgress(0-100, msg)）----------
  // 矩阵 → md 表格（首行作表头；单行/空表降级普通行）
  function matrixToMd(rows) {
    const cell = (c) => String(c == null ? "" : c).replace(/\|/g, "\\|").replace(/\n/g, " ");
    if (!rows || !rows.length) return "（空表格）";
    const line = (r) => "| " + r.map(cell).join(" | ") + " |";
    if (rows.length === 1) return rows.map(line).join("\n");
    return [line(rows[0]), "|" + rows[0].map(() => "---").join("|") + "|", ...rows.slice(1).map(line)].join("\n");
  }
  async function convertExternalAuto(file, onProg) {
    const name = (file && file.name) || "外部文件";
    const lower = name.toLowerCase();
    const ext = (lower.split(".").pop() || "");
    const title = name.replace(/\.[^.]+$/, "");
    const prog = (p, m) => { try { onProg && onProg(Math.max(0, Math.min(100, p)), m); } catch (e) {} };
    prog(2, "读取文件…");
    const needIO = () => { if (!window.IO || typeof IO.unzip !== "function") throw new Error("转换引擎未加载（IO），请重启应用重试"); return IO; };
    let md = null;
    if (ext === "pdf") {
      const buf = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : file;
      try {
        md = await pdfToMd(buf, prog);
      } catch (e) {
        if (!/扫描件|图片型/.test((e && e.message) || "")) throw e; // 加密/非PDF 等原样抛出
        prog(3, "检测为扫描件，启动内置 OCR 识别…");
        md = await pdfOcrToMd(buf, prog); // 兜底：提取内嵌页图 → OCR
      }
    } else if (["jpg", "jpeg", "png", "bmp", "webp"].indexOf(ext) >= 0) {
      // 图片文件直接 OCR（拍照/截图/扫描图入库的方法之一）
      if (!window.OCR || typeof OCR.recognize !== "function") throw new Error("OCR 引擎未加载（js/ocr.js），无法识别图片文字");
      const t = await OCR.recognize(file, onProg);
      if (!looksLikeText(t)) throw new Error("图片中未识别出有效文字（可能过模糊或为手写体）；建议使用更清晰的图片重试");
      md = t;
    } else if (ext === "docx") {
      prog(15, "解压 docx…");
      const buf = file instanceof Blob ? await file.arrayBuffer() : (file.buffer || file);
      const fmap = await needIO().unzip(buf);
      const docXml = fmap["word/document.xml"];
      if (!docXml) throw new Error("docx 中未找到 word/document.xml（文件可能损坏）");
      prog(55, "解析 Word 正文…");
      md = docxXmlToMd(new TextDecoder().decode(docXml));
    } else if (ext === "xlsx") {
      prog(15, "解压 xlsx…");
      const io = needIO();
      if (typeof io.xlsxMatrix !== "function") throw new Error("转换引擎未加载（xlsxMatrix），请重启应用重试");
      const buf = file instanceof Blob ? await file.arrayBuffer() : (file.buffer || file);
      const fmap = await io.unzip(buf);
      prog(55, "解析 Excel 工作表…");
      const rows = io.xlsxMatrix(fmap);
      md = matrixToMd(rows);
    } else if (ext === "xls") {
      throw new Error("旧式二进制 .xls 无法可靠解析；请用 Excel 另存为 .xlsx 后再导入");
    } else if (ext === "doc") {
      throw new Error("旧式二进制 .doc 无法可靠解析；请用 Word 另存为 .docx 后再导入");
    } else {
      // 文本类：txt / md / csv / html / json 等
      const text = file instanceof Blob ? await file.text() : String(file);
      if (ext === "html" || ext === "htm") { prog(55, "转换 HTML → Markdown…"); md = htmlToMd(text); }
      else if (ext === "csv") {
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        md = matrixToMd(lines.map((l) => l.split(",").map((c) => c.trim())));
      }
      else if (ext === "json") { try { md = "```json\n" + JSON.stringify(JSON.parse(text), null, 2) + "\n```"; } catch (e) { md = "```json\n" + text + "\n```"; } }
      else md = text;
    }
    prog(92, "写入知识库…");
    const entry = { id: uid(), type: "import", title, tags: ["导入", ext || "文档"], md: "# " + title + "\n\n" + md, meta: { source: "external-convert", file: name, fmt: ext } };
    await put(entry);
    prog(100, "完成");
    return entry;
  }

  // ==================================================================
  // ============ 智能框架（v2.4.6）：切片 + 向量化 + 混合检索 + 记忆 ============
  // ==================================================================
  // 设计：纯前端、离线、零依赖；不引入外部向量库，用「哈希词袋 + 子线性 TF + L2 归一」生成本地向量，
  // 余弦相似度即向量检索。配合关键词命中做混合检索；同一向量可"反向/模糊/语义"查询。
  const VEC_DIM = 1024;   // 维度越高哈希碰撞越少（反向/模糊查询噪声更低）

  // ---------- 句子级切片：尽量保持语句完整，遇长段按句切并带重叠衔接 ----------
  function splitSentences(text) {
    const out = []; const re = /[^。！？!?；;\n\r]+[。！？!?；;]?/g; let m;
    while ((m = re.exec(text))) { const s = m[0].trim(); if (s) out.push(s); }
    if (!out.length && text.trim()) out.push(text.trim());
    return out;
  }
  function overlapTail(acc, n) {
    if (acc.length <= n) return acc;
    const tail = acc.slice(-n);
    const sp = tail.search(/\S/);
    return sp > 0 ? tail.slice(sp) : tail;
  }
  function chunkText(md, opt) {
    opt = opt || {};
    const maxLen = opt.maxLen || 420;
    const overlap = opt.overlap || 60;
    const src = String(md || "").replace(/\r\n/g, "\n");
    if (!src.trim()) return [""];
    const lines = src.split("\n");
    const chunks = [];
    let curHeading = "", buf = [], bufLen = 0;
    const prefix = () => curHeading ? ("# " + curHeading + "\n\n") : "";
    const flushBuf = () => {
      if (!buf.length) return;
      const text = buf.join(" ").replace(/\s+/g, " ").trim();
      buf = []; bufLen = 0;
      if (!text) return;
      if (text.length <= maxLen) { chunks.push(prefix() + text); return; }
      const pieces = splitSentences(text);
      let acc = prefix();
      for (const pc of pieces) {
        if ((acc.length + pc.length) > maxLen) {
          if (acc.trim()) chunks.push(acc.trim());
          acc = prefix() + overlapTail(acc, overlap) + pc;   // 重叠衔接，避免断句生硬
        } else acc += pc;
      }
      if (acc.trim()) chunks.push(acc.trim());
    };
    for (const L of lines) {
      const hm = L.match(/^#{1,6}\s+(.*)$/);
      if (hm) { flushBuf(); curHeading = hm[1].trim(); continue; }
      if (/^\s*[-*]\s+/.test(L) || /^\s*\d+\.\s+/.test(L) || /^\s*\|.*\|\s*$/.test(L) || /^\s*\|[\s:|-]+\|\s*$/.test(L) || /^\s*(---+|\*\*\*+)\s*$/.test(L)) {
        flushBuf(); if (L.trim()) chunks.push(prefix() + L.trim()); continue;
      }
      if (!L.trim()) { flushBuf(); continue; }
      buf.push(L.trim()); bufLen += L.length;
    }
    flushBuf();
    return chunks.length ? chunks : [src.slice(0, maxLen)];
  }

  // ---------- 轻量离线向量：哈希词袋（中英文混排；中文按字+二元语法）----------
  function hashTok(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
  function tokenize(text) {
    const t = String(text || "").toLowerCase();
    const toks = [];
    const words = t.match(/[a-z0-9][a-z0-9_'-]*/g) || [];
    for (const w of words) toks.push(w);
    let run = "";
    const emit = (r) => { if (!r) return; if (r.length === 1) toks.push(r); else for (let j = 0; j < r.length; j++) { toks.push(r[j]); if (j + 1 < r.length) toks.push(r.slice(j, j + 2)); } };
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (/[一-龥]/.test(ch)) run += ch;
      else { emit(run); run = ""; }
    }
    emit(run);
    return toks;
  }
  function embed(text) {
    const v = new Float32Array(VEC_DIM);
    const toks = tokenize(text);
    const tf = {};
    for (const tk of toks) { if (tk.length < 1) continue; tf[tk] = (tf[tk] || 0) + 1; }
    for (const k in tf) { const h = hashTok(k) % VEC_DIM; v[h] += 1 + Math.log(tf[k]); }
    let norm = 0; for (let i = 0; i < VEC_DIM; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < VEC_DIM; i++) v[i] /= norm;
    return v;
  }
  function vecOf(e) { return Array.prototype.slice.call(embed((e.title || "") + " " + (e.tags || []).join(" ") + " " + (e.md || ""))); }
  function vecArray(e) { return (e && e.vec && e.vec.length === VEC_DIM) ? e.vec : vecOf(e); }
  function cosine(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }

  // ---------- 反向查询：给定一段内容，找出最相关的知识条目（内容→条目）----------
  async function queryByContent(md, k) {
    const es = await all();
    if (!es.length) return [];
    const qv = embed(md);
    return es.filter((e) => e.id !== "ops_log")
      .map((e) => ({ e, s: cosine(qv, vecArray(e)) }))
      .filter((x) => x.s > 0.10)
      .sort((a, b) => b.s - a.s)
      .slice(0, k || 5)
      .map((x) => x.e);
  }

  // ---------- 智能查询：切片级混合检索，返回带片段与来源的结果（供 AI 提示词拼装）----------
  async function smartQuery(q, k) {
    const es = await all();
    if (!es.length) return [];
    const qv = embed(q);
    const qt = (q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const e of es) {
      if (e.id === "ops_log") continue;
      const chunks = (e.chunks && e.chunks.length) ? e.chunks : chunkText(e.md || "");
      let best = 0, bestChunk = "";
      for (const c of chunks) {
        let kw = 0; const cl = c.toLowerCase();
        if (qt.length) { for (const t of qt) if (cl.indexOf(t) >= 0) { kw = 1; break; } }
        const cs = cosine(qv, embed(c));
        const sc = Math.max(kw, cs);
        if (sc > best) { best = sc; bestChunk = c; }
      }
      const ev = cosine(qv, vecArray(e));
      const score = Math.max(best, ev);
      if (score > 0.08) out.push({ id: e.id, title: e.title, type: e.type, tags: e.tags || [], score, chunk: (bestChunk || (e.md || "")).slice(0, 320) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k || 10);
  }

  // ---------- 记忆管理：MEMORY（Hermes 自我学习）读取 + 自动沉淀钩子 ----------
  async function memory() { const m = await get("MEMORY"); return m ? m.md : ""; }
  function remember(text) { return hermes(text); }   // 别名：写一条自我学习记忆
  // 自动记忆：重要写入/导入沉淀到 MEMORY（去重，避免重复刷屏）
  const _memSeen = {};
  function autoRemember(kind, text) {
    const key = kind + "|" + (text || "").slice(0, 60);
    if (_memSeen[key]) return;
    _memSeen[key] = 1;
    hermes("[" + kind + "] " + String(text || "").slice(0, 160)).catch(() => {});
  }

  // ---------- 主流知识库文件导入（md/txt/html，可多选；front matter 自动还原元数据）----------
  async function importDocuments(files, onProg) {
    let n = 0;
    const arr = Array.from(files || []);
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      const lower = (f.name || "").toLowerCase();
      if (onProg) onProg(Math.round((i / Math.max(1, arr.length)) * 100), "导入：" + f.name);
      if (lower.endsWith(".html") || lower.endsWith(".htm")) {
        const md = htmlToMd(await f.text());
        const t = (md.match(/^#\s+(.+)$/m) || [, f.name.replace(/\.[^.]+$/, "")])[1].trim();
        await put({ id: uid(), type: "import", title: t, tags: ["导入", "html"], md, meta: { source: "kbfile", file: f.name } });
      } else {
        const text = await f.text();
        const { meta, md } = lower.endsWith(".md") || lower.endsWith(".markdown") ? parseFrontMatter(text) : { meta: null, md: text };
        const heading = (md.match(/^#\s+(.+)$/m) || [, ""])[1].trim();
        const title = (meta && meta.title) || heading || f.name.replace(/\.[^.]+$/, "");
        const tags = (meta && Array.isArray(meta.tags)) ? meta.tags : ["导入", lower.endsWith(".md") ? "md" : "txt"];
        await put({ id: (meta && meta.id) || uid(), type: (meta && meta.type) || "import", title, tags, md, meta: { source: "kbfile", file: f.name } });
      }
      n++;
    }
    if (onProg) onProg(100, "完成");
    return n;
  }

  // ---------- 主流知识库格式导出（md / txt / html 单文件；zip 完整备份保留兼容）----------
  async function exportAs(format) {
    const es = await all();
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const body = es.filter((e) => e.id !== "ops_log"); // 操作日志不进导出正文（可再生成，纯噪声）
    if (format === "md") {
      const parts = body.map((e) => "<!-- kb-entry -->\n" + frontMatter(e) + "\n\n" + (e.md || ""));
      return { name: "knowledge_base_" + stamp + ".md", mime: "text/markdown;charset=utf-8", data: parts.join("\n\n---\n\n") };
    }
    if (format === "txt") {
      const parts = body.map((e) => "【" + (e.title || e.id) + "】" + (e.tags && e.tags.length ? "（标签：" + e.tags.join("、") + "）" : "") + "\n" + String(e.md || ""));
      return { name: "knowledge_base_" + stamp + ".txt", mime: "text/plain;charset=utf-8", data: parts.join("\n\n" + "=".repeat(40) + "\n\n") };
    }
    if (format === "html") {
      const secs = body.map((e) => "<section>\n<h2>" + (e.title || e.id) + "</h2>\n" +
        (e.tags && e.tags.length ? '<p class="tags">' + e.tags.map((t) => "#" + t).join(" ") + "</p>\n" : "") +
        mdToHtml(e.md || "") + "\n</section>").join("\n<hr>\n");
      const doc = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>知识库导出 " + stamp + "</title>\n<style>body{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:860px;margin:24px auto;padding:0 16px;line-height:1.7;color:#222}h2{border-bottom:2px solid #2563eb;padding-bottom:6px}table{border-collapse:collapse;width:100%}code{background:#f4f4f5;padding:1px 5px;border-radius:4px}.tags{color:#6b7280;font-size:.9em}hr{border:none;border-top:1px solid #e5e7eb;margin:28px 0}</style>\n</head>\n<body>\n<h1>知识库导出（" + es.length + " 条）</h1>\n" + secs + "\n</body>\n</html>";
      return { name: "knowledge_base_" + stamp + ".html", mime: "text/html;charset=utf-8", data: doc };
    }
    if (format === "zip") { const u8 = await exportZip(); return { name: "knowledge_base_" + stamp + "_full.zip", mime: "application/zip", data: u8 }; }
    throw new Error("未知导出格式：" + format);
  }

  // ================= 零依赖 ZIP（STORE 法，跨平台兼容）=================
  function str2u8(s) { return new TextEncoder().encode(s); }
  function u82str(u) { return new TextDecoder().decode(u); }
  const crcTable = (function () { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(buf) { let crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF]; return (crc ^ 0xFFFFFFFF) >>> 0; }

  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : str2u8(f.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, 0, true); dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
      local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
      chunks.push(local);
      const cd = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014b50, true); // signature
      cdv.setUint16(4, 20, true);          // version made by
      cdv.setUint16(6, 20, true);          // version needed
      cdv.setUint16(8, 0x0800, true);           // flag
      cdv.setUint16(10, 0, true);          // method (store)
      cdv.setUint16(12, 0, true);          // mod time
      cdv.setUint16(14, 0, true);          // mod date
      cdv.setUint32(16, crc, true);        // crc-32
      cdv.setUint32(20, data.length, true); // compressed size
      cdv.setUint32(24, data.length, true); // uncompressed size
      cdv.setUint16(28, nameBytes.length, true); // name length
      cdv.setUint16(30, 0, true);          // extra length
      cdv.setUint16(32, 0, true);          // comment length
      cdv.setUint16(34, 0, true);          // disk number
      cdv.setUint16(36, 0, true);          // internal attrs
      cdv.setUint32(38, 0, true);          // external attrs
      cdv.setUint32(42, offset, true);     // local header offset
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += local.length;
    }
    const centralSize = central.reduce((a, c) => a + c.length, 0);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true); edv.setUint16(8, files.length, true); edv.setUint16(10, files.length, true);
    edv.setUint32(12, centralSize, true); edv.setUint32(16, offset, true);
    const out = new Uint8Array(offset + centralSize + 22);
    let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
    for (const c of central) { out.set(c, p); p += c.length; }
    out.set(eocd, p);
    return out;
  }

  function parseZip(u8) {
    const dv = new DataView(u8.buffer || u8);
    const files = []; let o = 0;
    while (o + 4 <= u8.length) {
      if (dv.getUint32(o, true) !== 0x04034b50) break;
      const compSize = dv.getUint32(o + 22, true);
      const nameLen = dv.getUint16(o + 26, true);
      const extraLen = dv.getUint16(o + 28, true);
      const name = u82str(u8.subarray(o + 30, o + 30 + nameLen));
      const ds = o + 30 + nameLen + extraLen;
      files.push({ name, data: new Uint8Array(u8.subarray(ds, ds + compSize)) });
      o = ds + compSize;
    }
    return files;
  }

  // ---------- 导出知识库（zip）----------
  async function exportZip() {
    const es = await all();
    const files = [];
    files.push({ name: "kb_index.json", data: str2u8(JSON.stringify(buildIndex(es), null, 2)) });
    for (const e of es) {
      if (e.id === "MEMORY") continue;
      files.push({ name: "kb/" + e.id + ".md", data: str2u8(e.md || "") });
      files.push({ name: "kb/" + e.id + ".json", data: str2u8(JSON.stringify({ id: e.id, type: e.type, title: e.title, tags: e.tags || [], updated: e.updated, meta: e.meta || {} }, null, 2)) });
    }
    const mem = es.find((e) => e.id === "MEMORY");
    if (mem) files.push({ name: "MEMORY.md", data: str2u8(mem.md || "") });
    return makeZip(files);
  }

  // ---------- 导入知识库备份（zip）----------
  async function importZip(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const files = parseZip(u8);
    const byId = {};
    for (const f of files) {
      if (f.name === "kb_index.json" || f.name.endsWith("/")) continue;
      if (f.name === "MEMORY.md") { await put({ id: "MEMORY", type: "memory", title: "MEMORY", tags: ["hermes", "记忆"], md: u82str(f.data), meta: {} }); continue; }
      const m = f.name.match(/^kb\/(.+)\.(md|json)$/);
      if (!m) continue;
      const id = m[1];
      byId[id] = byId[id] || {};
      if (m[2] === "md") byId[id].md = u82str(f.data);
      else { try { byId[id].meta = JSON.parse(u82str(f.data)); } catch (e) {} }
    }
    let n = 0;
    for (const id of Object.keys(byId)) {
      const b = byId[id];
      if (!b.md) continue;
      const meta = b.meta || {};
      await put({ id, type: meta.type || "imported", title: meta.title || id, tags: meta.tags || ["导入"], md: b.md, meta: meta.meta || {} });
      n++;
    }
    return n;
  }

  // ---------- 查看/统计 ----------
  async function stats() {
    const es = await all();
    const byType = {};
    for (const e of es) byType[e.type] = (byType[e.type] || 0) + 1;
    return { total: es.length, byType };
  }


  // ================= v2.4.8 知识库智能化：模糊检索 / 提示词生成 / 记忆 / 存疑反向查询 =================
  // 编辑距离（英文词错字容错用，限短词）
  function levDist(a, b) {
    a = String(a || ""); b = String(b || "");
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }
  // 模糊相似度 0..1：整串命中=1；中文按二元语法覆盖率；英文词允许 1 字符编辑距离
  function fuzzySim(q, text) {
    q = String(q || "").toLowerCase();
    text = String(text || "").toLowerCase();
    if (!q || !text) return 0;
    if (text.indexOf(q) >= 0) return 1;
    var terms = q.match(/[a-z0-9]+|[\u4e00-\u9fa5]{2,}/g) || [];
    if (!terms.length) return 0;
    var hit = 0, i, j, k;
    for (i = 0; i < terms.length; i++) {
      var t = terms[i];
      if (text.indexOf(t) >= 0) { hit += 1; continue; }
      if (/^[a-z0-9]+$/.test(t)) {
        if (t.length >= 4 && t.length <= 12) {
          var words = text.match(/[a-z0-9]+/g) || [];
          for (j = 0; j < words.length; j++) {
            if (Math.abs(words[j].length - t.length) <= 1 && levDist(words[j], t) <= 1) { hit += 0.8; break; }
          }
        }
        continue;
      }
      // 中文：二元语法覆盖率 + 单字覆盖率取大（容忍缺字/错字/语序/简称）
      var grams = [], chars = 0, hitc = 0;
      for (k = 0; k + 2 <= t.length; k++) grams.push(t.substr(k, 2));
      for (k = 0; k < t.length; k++) { if (text.indexOf(t.charAt(k)) >= 0) hitc++; }
      chars = t.length ? hitc / t.length : 0;
      if (grams.length) {
        var g = 0;
        for (k = 0; k < grams.length; k++) if (text.indexOf(grams[k]) >= 0) g++;
        hit += Math.max((g / grams.length) * 0.9, chars * 0.7);
      } else {
        hit += chars * 0.7;
      }
    }
    var s = hit / terms.length;
    return s > 1 ? 1 : s;
  }

  // ---------- 模糊检索：向量(语义) + 关键词 + 模糊(错字/缺字) 三路混合 ----------
  async function fuzzyQuery(q, k, minScore) {
    const es = await all();
    if (!es.length) return [];
    const qv = embed(q);
    const ql = String(q || "").toLowerCase();
    const floor = (minScore == null) ? 0.08 : minScore;
    const out = [];
    for (const e of es) {
      if (e.id === "ops_log" || e.id === "MEMORY") continue;
      const chunks = (e.chunks && e.chunks.length) ? e.chunks : chunkText(e.md || "");
      let best = 0, bestChunk = "";
      for (const c of chunks) {
        const fs = fuzzySim(ql, c);
        const cs = cosine(qv, embed(c));
        const sc = Math.max(fs, cs);
        if (sc > best) { best = sc; bestChunk = c; }
      }
      const tv = cosine(qv, vecArray(e));
      const ts = fuzzySim(ql, (e.title || "") + " " + (e.tags || []).join(" "));
      const score = Math.max(best, ts, tv);
      if (score > floor) out.push({ id: e.id, title: e.title, type: e.type, tags: e.tags || [], score: score, chunk: (bestChunk || (e.md || "")).slice(0, 320) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k || 10);
  }

  // ---------- 反向查询：给定一段内容 → 最相关的知识条目（带相关度与命中片段）----------
  async function reverseQuery(md, k) {
    const es = await all();
    if (!es.length) return [];
    const qv = embed(md);
    const ql = String(md || "").toLowerCase().slice(0, 800);
    const out = [];
    for (const e of es) {
      if (e.id === "ops_log" || e.id === "MEMORY") continue;
      const chunks = (e.chunks && e.chunks.length) ? e.chunks : chunkText(e.md || "");
      let best = -1, bestChunk = "";
      for (const c of chunks) {
        const sc = Math.max(cosine(qv, embed(c)), fuzzySim(ql, c));
        if (sc > best) { best = sc; bestChunk = c; }
      }
      const score = Math.max(best, cosine(qv, vecArray(e)));
      if (score > 0.10) out.push({ id: e.id, title: e.title, type: e.type, tags: e.tags || [], score: score, chunk: (bestChunk || (e.md || "")).slice(0, 320) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k || 5);
  }

  // ---------- 提示词生成：问题 + 模糊检索片段 + 长期记忆 → 可直接投喂大模型的完整提示词 ----------
  async function promptGen(q, opt) {
    opt = opt || {};
    const maxChars = opt.maxChars || 4000;
    const role = opt.role || "你是严谨的知识助手，优先依据下列本地资料作答。";
    const parts = [];
    parts.push("# 角色\n" + role);
    let used = parts[0].length;
    if (opt.withMemory !== false) {
      try {
        const m = await memory();
        if (m) {
          const tail = m.slice(-Math.min(1200, Math.max(0, maxChars - used)));
          if (tail) { parts.push("# 长期记忆（Hermes 自我学习）\n" + tail); used += tail.length; }
        }
      } catch (e) { /* 记忆缺失不影响提示词生成 */ }
    }
    const refs = await fuzzyQuery(q, opt.k || 6);
    if (refs.length) {
      const blocks = [];
      for (let i = 0; i < refs.length; i++) {
        const r = refs[i];
        const seg = "[" + (i + 1) + "] 《" + (r.title || r.id) + "》" + (r.tags && r.tags.length ? "（" + r.tags.join("、") + "）" : "") + "\n" + (r.chunk || "");
        if (used + seg.length > maxChars) break;
        blocks.push(seg); used += seg.length;
      }
      if (blocks.length) parts.push("# 本地知识库参考（按相关度排序，引用请标注 [n]）\n" + blocks.join("\n\n"));
    }
    parts.push("# 用户问题\n" + String(q || ""));
    parts.push("# 输出要求\n1) 优先使用上述资料；资料未覆盖的部分请明确说明「资料不足」并标注存疑，不要编造。\n2) 引用处用 [n] 标注来源编号。\n3) 中文作答，简明、结构化。");
    return parts.join("\n\n---\n\n");
  }

  // ---------- 存疑：标注 + 列表（与反向查询联动，形成"存疑→查证"闭环）----------
  async function markDoubt(title, text, meta) {
    const e = {
      id: uid(), type: "doubt",
      title: String(title || "未命名存疑").slice(0, 60),
      tags: ["存疑", "待核实"],
      md: String(text || ""),
      meta: Object.assign({ source: "manual", time: new Date().toISOString() }, meta || {})
    };
    await put(e);
    autoRemember("存疑", e.title + " :: " + String(text || "").slice(0, 80));
    return e;
  }
  async function listDoubts() {
    const es = await all();
    return es.filter((e) => e.type === "doubt").sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  // ---------- 记忆管理（Hermes）：读取 / 检索 / 清空 ----------
  async function memoryText() { const m = await get("MEMORY"); return m ? String(m.md || "") : ""; }
  async function memorySearch(q, k) {
    const m = await memoryText();
    if (!m) return [];
    const lines = m.split(/\r?\n/).filter((s) => s.trim());
    const scored = lines.map((s) => ({ line: s, score: Math.max(fuzzySim(q, s), 0) }))
      .filter((x) => x.score > 0.05)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, k || 20);
  }
  async function memoryClear() {
    for (const k in _memSeen) delete _memSeen[k];
    await put({ id: "MEMORY", type: "memory", title: "MEMORY", tags: ["hermes", "记忆"], md: "", meta: {} });
    return true;
  }

  const KB = { fuzzyQuery, promptGen, reverseQuery, markDoubt, listDoubts, fuzzySim,
    memoryText, memorySearch, memoryClear, init: open, put, get, all, del, clear, uid, buildIndex, retrieve, rebuildSkeleton, logOp, flushOps, hermes, parseExternal, exportZip, importZip, stats, exportAs, importDocuments, convertExternalAuto, frontMatter, parseFrontMatter, htmlToMd, mdToHtml, docxXmlToMd, pdfToMd, pdfOcrToMd, pdfExtractImages,
    chunkText, embed, vecOf, vecArray, cosine, queryByContent, smartQuery, memory, remember, autoRemember,
    _zip: { makeZip, parseZip, crc32 } };
  global.KB = KB;
})(window);
