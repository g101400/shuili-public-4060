/* ===== kb_rag.js — 知识库智能检索框架（LangChain 等价流水线，纯 JS 离线实现）=====
 * 流水线：Document Loader → Recursive Text Splitter → Hashing/TF-IDF Embeddings
 *        → Local Vector Store → Hybrid Retriever(BM25 + 向量余弦 + 模糊包含)
 *        → LLM Chain(智能生成提示词 + 记忆管理 + hermes 自学习)
 * 说明：WebView 内无法直接运行 Python 版 langchain，本文件按 langchain 的分层思想
 * 用原生 JS 复刻同等能力，全部离线可运行；大模型部分复用 App 已接入的 AIModule.ask。
 */
(function (global) {
  "use strict";

  var DIM = 256;              // 向量维度（兼顾精度与 localStorage 体积）
  var CHUNK = 520, OVERLAP = 80;
  var MAX_CHUNKS = 3000;      // 索引上限，超出则退化为关键词检索
  var state = { domain: "app", hooks: null, chunks: [], df: {}, n: 0, avgLen: 10, vecs: null, loaded: false, weights: { vector: 0.45, bm25: 0.35, fuzzy: 0.20 }, docCache: {} };

  /* ---------------- 工具 ---------------- */
  function lsKey() { return "kb_vec_" + state.domain; }
  function memKey() { return "kb_mem_" + state.domain; }
  function hash32(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h >>> 0; }

  // 中文/CJK 与英文数字混合分词：英文单词 + 中文单字 + 中文二元组
  function tokenize(text) {
    var s = String(text || "").toLowerCase(), out = [], i;
    var re = /[a-z0-9]+|[\u4e00-\u9fa5]/g, m, seq = [];
    while ((m = re.exec(s))) seq.push(m[0]);
    for (i = 0; i < seq.length; i++) {
      if (/^[a-z0-9]+$/.test(seq[i])) { out.push(seq[i]); continue; }
      out.push(seq[i]);
      if (i + 1 < seq.length && /[\u4e00-\u9fa5]/.test(seq[i + 1])) out.push(seq[i] + seq[i + 1]);
    }
    return out;
  }
  function bigrams(text) {
    var s = String(text || "").replace(/\s+/g, "").toLowerCase(), out = [];
    for (var i = 0; i < s.length - 1; i++) out.push(s.substr(i, 2));
    if (!out.length && s.length) out.push(s);
    return out;
  }

  /* ---------------- 1. 递归文本切片（RecursiveCharacterTextSplitter 等价） ---------------- */
  // 一级：按句末标点/换行切句（保留标点，不用 lookbehind，兼容旧 WebView）
  function splitSentences(s) {
    var out = [], cur = "";
    for (var i = 0; i < s.length; i++) {
      cur += s.charAt(i);
      if (/[。！？；!?;\n]/.test(s.charAt(i))) { if (cur.trim()) out.push(cur); cur = ""; }
    }
    if (cur.trim()) out.push(cur);
    return out.length ? out : [s];
  }
  // 二级：句内按逗号/顿号/冒号再切（仅用于超长句，保证仍以标点结尾）
  function splitClauses(s) {
    var out = [], cur = "";
    for (var i = 0; i < s.length; i++) {
      cur += s.charAt(i);
      if (/[，,、：:]/.test(s.charAt(i))) { if (cur.trim()) out.push(cur); cur = ""; }
    }
    if (cur.trim()) out.push(cur);
    return out.length ? out : [s];
  }
  // 展平为「句」列表：段落 → 句末标点 → 逗号级 → （极端）硬切
  function flattenSentences(text, size) {
    var blocks = String(text || "").split(/\n(?=\s*#{1,6}\s|\s*【)|\n\s*\n/);
    var res = [];
    blocks.forEach(function (b) {
      splitSentences(b).forEach(function (s) {
        if (s.length <= size) { res.push(s); return; }
        var subs = splitClauses(s), acc = "";
        subs.forEach(function (c) {
          if ((acc + c).length > size && acc) { res.push(acc); acc = c; }
          else acc += c;
        });
        if (acc.trim()) res.push(acc);
      });
    });
    var out2 = [];
    res.forEach(function (s) {
      if (s.length > size * 1.6) { var i = 0; while (i < s.length) { out2.push(s.substr(i, size)); i += size; } }
      else out2.push(s);
    });
    return out2;
  }
  // 递归切片（语句完整优先）：以「整句」为最小粒度打包，重叠也按整句回溯，绝不在句中断开
  function chunkText(text, opt) {
    opt = opt || {};
    var size = opt.size || CHUNK, overlap = opt.overlap || OVERLAP;
    var body = String(text || "").trim();
    if (!body) return [];
    var sents = flattenSentences(body, size);
    if (!sents.length) return [];
    var out = [], cur = "", curSents = [];
    function pushCur() { if (cur.trim()) out.push(cur.trim()); }
    sents.forEach(function (s) {
      if (cur && (cur + s).length > size) {
        // 重叠预留：给下一片开头留不超过 (size - s.length) 的整句尾部，保证不超长
        var budget = size - s.length - 1, keep = [], n = 0;
        if (budget > 0) {
          for (var i = curSents.length - 1; i >= 0; i--) {
            var p = curSents[i];
            if (n + p.length > budget) break;
            keep.unshift(p); n += p.length;
            if (n >= Math.min(overlap, budget)) break;
          }
        }
        pushCur();
        cur = keep.join(""); curSents = keep.slice();
      }
      cur += s; curSents.push(s);
    });
    pushCur();
    return out.filter(function (x) { return x && x.replace(/\s/g, "").length > 4; });
  }

  /* ---------------- 2. 向量化（Hashing + IDF 加权，离线确定性） ---------------- */
  function embed(text) {
    var toks = tokenize(text), bi = bigrams(text);
    var vec = new Float64Array(DIM);
    var tf = {};
    toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    bi.forEach(function (t) { tf[t] = (tf[t] || 0) + 0.5; });
    Object.keys(tf).forEach(function (t) {
      var idf = 1;
      if (state.df[t] && state.n) idf = Math.log(1 + state.n / (state.df[t] + 1));
      var w = (1 + Math.log(tf[t])) * idf;
      vec[hash32(t) % DIM] += w;
    });
    var norm = 0;
    for (var i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (var j = 0; j < DIM; j++) vec[j] /= norm;
    return vec;
  }
  function cos(a, b) { var s = 0; for (var i = 0; i < DIM; i++) s += a[i] * b[i]; return s; }

  /* ---------------- 3. 本地向量库 ---------------- */
  // D-4：增量构建——按文档切片签名(sig)缓存向量，未变更文档跳过重新向量化（顺带缓解启动慢）
  function buildIndex(docs, onProgress) {
    var cache = state.docCache || {};
    var all = [];
    (docs || []).forEach(function (d) {
      var sig = hash32((d.title || "") + "::" + (d.body || "") + "::" + JSON.stringify(d.chunks || null));
      var reuse = (cache[d.id] && cache[d.id].sig === sig) ? cache[d.id].parts : null;
      var parts;
      if (reuse && reuse.length) {
        parts = reuse;
      } else {
        var raw = (d.chunks && d.chunks.length) ? d.chunks.slice()
          : chunkText((d.title ? d.title + "\n" : "") + (d.body || ""));
        if (!raw.length) raw = [String(d.body || d.title || "").slice(0, CHUNK)];
        parts = raw.map(function (t, i) {
          return { id: d.id + "#" + i, docId: d.id, title: d.title || "", source: d.source || "", type: d.type || "", toks: tokenize(t), text: t, vec: embed(t) };
        });
        cache[d.id] = { sig: sig, parts: parts };
      }
      parts.forEach(function (c) { all.push(c); });
    });
    if (all.length > MAX_CHUNKS) all = all.slice(0, MAX_CHUNKS);
    state.df = {}; state.n = 0;
    all.forEach(function (c) {
      var seen = {};
      c.toks.forEach(function (t) { if (!seen[t]) { state.df[t] = (state.df[t] || 0) + 1; seen[t] = 1; } });
      state.n++;
    });
    state.avgLen = all.reduce(function (a, c) { return a + c.toks.length; }, 0) / Math.max(all.length, 1) || 10;
    state.chunks = all;
    state.docCache = cache;
    state.loaded = true;
    saveStore();
    return all.length;
  }
  function saveStore() {
    try {
      var slim = state.chunks.map(function (c) { return { i: c.id, d: c.docId, t: c.title, s: c.source, y: c.type, x: c.text, k: c.toks, v: Array.prototype.map.call(c.vec, function (n) { return Math.round(n * 1000) / 1000; }) }; });
      localStorage.setItem(lsKey(), JSON.stringify({ v: 1, dim: DIM, n: state.n, df: state.df, avgLen: state.avgLen, ts: Date.now(), chunks: slim }));
      return true;
    } catch (e) { return false; }
  }
  function loadStore() {
    try {
      var raw = localStorage.getItem(lsKey());
      if (!raw) return false;
      var o = JSON.parse(raw);
      if (!o || !o.chunks) return false;
      state.df = o.df || {}; state.n = o.n || o.chunks.length; state.avgLen = o.avgLen || 10;
      state.chunks = o.chunks.map(function (c) {
        var f = new Float64Array(DIM);
        for (var i = 0; i < DIM; i++) f[i] = (c.v && c.v[i]) || 0;
        return { id: c.i, docId: c.d, title: c.t, source: c.s, type: c.y, text: c.x, toks: c.k || tokenize(c.x), vec: f };
      });
      state.loaded = true;
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 4. 混合检索：BM25 + 向量余弦 + 模糊包含 ---------------- */
  function bm25(qToks, c) {
    var k1 = 1.5, b = 0.75, score = 0, tf = {};
    c.toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    qToks.forEach(function (q) {
      var f = tf[q] || 0; if (!f) return;
      var df = state.df[q] || 1;
      var idf = Math.log(1 + (state.n - df + 0.5) / (df + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (c.toks.length / (state.avgLen || 10))));
    });
    return score;
  }
  function fuzzyScore(q, text) {
    var s = String(q || "").replace(/\s+/g, "");
    if (s.length < 2) return 0;
    var hit = 0, n = 0;
    for (var i = 0; i + 2 <= s.length; i += 1) {
      var g = s.substr(i, 2); n++;
      if (text.indexOf(g) >= 0) hit++;
    }
    return n ? hit / n : 0;
  }
  // D-3：引用溯源——把查询词在原文中的命中位置高亮（<mark>）
  function highlight(text, q) {
    var t = String(text || "");
    var toks = tokenize(q).filter(function (x) { return x.length >= 2 || /^[a-z0-9]+$/.test(x); });
    toks.forEach(function (tk) {
      try {
        var re = new RegExp("(" + tk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "g");
        t = t.replace(re, "<mark>$1</mark>");
      } catch (e) {}
    });
    return t;
  }
  function hybridSearch(query, opt) {
    opt = opt || {};
    var topK = opt.topK || 5;
    if (!state.chunks.length) loadStore();
    if (!state.chunks.length) return [];
    var W = state.weights || { vector: 0.45, bm25: 0.35, fuzzy: 0.20 };
    var qToks = tokenize(query), qv = embed(query);
    var raw = state.chunks.map(function (c) {
      var v = c.vec ? cos(qv, c.vec) : 0;
      var k = bm25(qToks, c);
      var f = fuzzyScore(query, c.text);
      return { c: c, v: v, k: k, f: f };
    });
    var mv = Math.max.apply(null, raw.map(function (r) { return r.v; })) || 1;
    var mk = Math.max.apply(null, raw.map(function (r) { return r.k; })) || 1;
    raw.forEach(function (r) {
      // D-3：混合权重可学习（默认 0.45/0.35/0.20，可由 setWeights/learnWeights 调整）
      r.score = (W.vector || 0.45) * (r.v / mv) + (W.bm25 || 0.35) * (r.k / mk) + (W.fuzzy || 0.20) * r.f;
    });
    raw.sort(function (a, b) { return b.score - a.score; });
    state._lastRaw = raw; // D-3：保留原始信号供 learnWeights 使用
    return raw.filter(function (r) { return r.score > 0.02; }).slice(0, topK).map(function (r) {
      // D-3：置信度（归一化得分）+ 引用高亮 + 信号明细
      return {
        docId: r.c.docId, title: r.c.title, source: r.c.source, type: r.c.type,
        text: r.c.text, score: r.score, confidence: Math.max(0, Math.min(1, r.score)),
        highlight: highlight(r.c.text, query), detail: { vector: r.v, bm25: r.k, fuzzy: r.f }
      };
    });
  }
  // 内容 → 条目（反向查询）：给定一段内容，找出它最可能出自哪些知识库条目
  function reverseQuery(text, topK) {
    var hits = hybridSearch(String(text || "").slice(0, 800), { topK: topK || 5 });
    var byDoc = {};
    hits.forEach(function (h) {
      if (!byDoc[h.docId]) byDoc[h.docId] = { docId: h.docId, title: h.title, source: h.source, score: 0, snippets: [] };
      byDoc[h.docId].score += h.score;
      byDoc[h.docId].snippets.push(h.text.slice(0, 120));
    });
    return Object.keys(byDoc).map(function (k) { return byDoc[k]; }).sort(function (a, b) { return b.score - a.score; });
  }

  /* ---------------- 5. 记忆管理（短期对话 + 长期要点） ---------------- */
  function memLoad() { try { return JSON.parse(localStorage.getItem(memKey()) || "[]"); } catch (e) { return []; } }
  function memSave(a) { try { localStorage.setItem(memKey(), JSON.stringify(a.slice(-30))); } catch (e) {} }
  function remember(role, text) {
    var m = memLoad();
    m.push({ r: role, t: String(text || "").slice(0, 1200), ts: Date.now() });
    memSave(m);
    return m.length;
  }
  function recall(query, n) {
    var m = memLoad();
    if (!query) return m.slice(-(n || 6));
    var qt = tokenize(query), scored = m.map(function (x) {
      var s = 0; qt.forEach(function (t) { if (x.t.indexOf(t) >= 0) s++; });
      return { x: x, s: s + (Date.now() - x.ts < 600000 ? 0.5 : 0) };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.filter(function (r) { return r.s > 0; }).slice(0, n || 4).map(function (r) { return r.x; });
  }
  function memClear() { try { localStorage.removeItem(memKey()); } catch (e) {} }

  /* ---------------- 6. 智能提示词生成 ---------------- */
  function buildPrompt(question, hits, memory) {
    var ctx = hits.map(function (h, i) {
      return "[" + (i + 1) + "] 来源：" + (h.title || h.source || h.docId) + "\n" + String(h.text).slice(0, 900);
    }).join("\n\n");
    var mem = (memory || []).map(function (m) { return (m.r === "user" ? "用户：" : "助手：") + String(m.t).slice(0, 300); }).join("\n");
    var sys = "你是本应用内置的智能助手（RAG）。只依据下面【资料】回答，禁止臆造；" +
      "引用时在句末标注来源编号如 [1]；若资料不足以回答，明确说明「资料中未涉及」并给出建议。" +
      "回答要求：中文、简洁、分条；涉及数字/参数时原样引用。";
    var msgs = [{ role: "system", content: sys }];
    if (mem) msgs.push({ role: "system", content: "【近期对话记忆】\n" + mem });
    msgs.push({ role: "system", content: "【资料】\n" + (ctx || "（无）") });
    msgs.push({ role: "user", content: String(question) });
    return msgs;
  }
  // 基于知识库内容智能生成候选提示词（点击即用）
  function suggestPrompts(docs, n) {
    var titles = (docs || []).slice(0, 60).map(function (d) { return d.title || ""; }).filter(Boolean);
    var counts = {};
    titles.forEach(function (t) { tokenize(t).forEach(function (k) { if (k.length > 1) counts[k] = (counts[k] || 0) + 1; }); });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 5);
    var t0 = titles[0] || "本知识库";
    var seeds = [
      "总结一下「" + t0 + "」的要点",
      top.length ? "关于" + top.slice(0, 2).join("、") + "，资料里怎么说的？" : "资料里有哪些重点？",
      "列出资料中出现的主要参数与数值",
      "对比 " + (titles[0] || "A") + " 与 " + (titles[1] || "B") + " 的差异",
      "根据资料生成一份巡检/操作注意事项清单"
    ];
    return seeds.slice(0, n || 5);
  }
  // 大模型查询改写（可选；失败静默退回原查询）
  function expandQuery(question, chat) {
    if (!chat) return Promise.resolve(question);
    return chat([
      { role: "system", content: "你是检索助手。把用户问题改写为 3-6 个检索关键词（含同义词），只输出关键词，用空格分隔。" },
      { role: "user", content: String(question) }
    ]).then(function (t) { return String(question) + " " + String(t || "").replace(/[\n，,、]/g, " ").slice(0, 120); })
      .catch(function () { return question; });
  }

  /* ---------------- 7. 智能问答主链路 ---------------- */
  function askSmart(question, opt) {
    opt = opt || {};
    var chat = (opt.chat || (state.hooks && state.hooks.chat));
    var onProgress = opt.onProgress || function () {};
    var llm = opt.llm !== false;                 // 是否调用大模型（离线可关）
    var expand = opt.expand && !!chat;
    onProgress(0.1, "检索准备…");
    var p = expand ? expandQuery(question, chat) : Promise.resolve(question);
    return p.then(function (q2) {
      onProgress(0.35, "混合检索（向量+关键词+模糊）…");
      var hits = hybridSearch(q2, { topK: opt.topK || 5 });
      if (!hits.length && q2 !== question) hits = hybridSearch(question, { topK: opt.topK || 5 });
      onProgress(0.55, "命中 " + hits.length + " 段，组织提示词…");
      var memory = recall(question, 4);
      var msgs = buildPrompt(question, hits, memory);
      if (!llm || !chat) {
        // 离线兜底：抽取式答案（直接给最相关片段，不臆造）
        onProgress(1, "离线抽取式回答");
        var ans = hits.length
          ? "（离线模式，以下为资料原文片段）\n\n" + hits.map(function (h, i) { return "[" + (i + 1) + "] " + (h.title || h.source || "") + "\n" + h.text.slice(0, 400); }).join("\n\n")
          : "知识库中没有找到相关内容。可先导入文档或重建向量索引。";
        remember("user", question); remember("assistant", ans.slice(0, 600));
        return Promise.resolve({ answer: ans, hits: hits, source: "offline", msgs: msgs });
      }
      onProgress(0.75, "调用大模型生成答案…");
      return chat(msgs).then(function (txt) {
        onProgress(1, "完成");
        remember("user", question); remember("assistant", String(txt || "").slice(0, 1200));
        // hermes 自学习：把问答沉淀进知识库
        try { if (state.hooks && state.hooks.hermesLearn) state.hooks.hermesLearn(question, txt, hits); } catch (e) {}
        return { answer: String(txt || ""), hits: hits, source: "llm", msgs: msgs };
      }).catch(function (e) {
        var ans = "大模型不可用（" + (e && e.message || e) + "）。以下是资料原文片段：\n\n" +
          hits.map(function (h, i) { return "[" + (i + 1) + "] " + (h.title || h.source || "") + "\n" + h.text.slice(0, 400); }).join("\n\n");
        return { answer: ans, hits: hits, source: "fallback", error: e && e.message };
      });
    });
  }

  /* ---------------- 生命周期 ---------------- */
  function init(opt) {
    opt = opt || {};
    state.domain = opt.domain || state.domain;
    state.hooks = { chat: opt.chat, hermesLearn: opt.hermesLearn, kbList: opt.kbList };
    return loadStore();
  }
  function addDoc(doc) {
    // 增量：删除该文档旧切片后重建该文档的切片（保持索引一致）
    if (!state.chunks.length) loadStore();
    var id = doc && doc.id;
    if (!id) return 0;
    state.chunks = state.chunks.filter(function (c) { return c.docId !== id; });
    var parts = (doc.chunks && doc.chunks.length) ? doc.chunks.slice()
      : chunkText((doc.title ? doc.title + "\n" : "") + (doc.body || ""));
    if (!parts.length) parts = [String(doc.body || doc.title || "")];
    var dfAdd = {};
    parts.forEach(function (t, i) {
      var c = { id: id + "#" + i, docId: id, title: doc.title || "", source: doc.source || "", type: doc.type || "", toks: tokenize(t), text: t, vec: null };
      var seen = {}; c.toks.forEach(function (x) { if (!seen[x]) { dfAdd[x] = 1; seen[x] = 1; } });
      c.vec = embed(t);
      state.chunks.push(c);
    });
    Object.keys(dfAdd).forEach(function (k) { state.df[k] = (state.df[k] || 0) + 1; });
    state.n = state.chunks.length;
    // D-4：同步刷新增量缓存，使 buildIndex 可复用该文档向量
    state.docCache = state.docCache || {};
    state.docCache[id] = { sig: hash32((doc.title || "") + "::" + (doc.body || "") + "::" + JSON.stringify(doc.chunks || null)), parts: state.chunks.filter(function (c) { return c.docId === id; }) };
    saveStore();
    return parts.length;
  }
  function removeDoc(id) {
    if (!state.chunks.length) loadStore();
    state.chunks = state.chunks.filter(function (c) { return c.docId !== id; });
    state.n = state.chunks.length;
    saveStore();
  }
  function stats() {
    return { chunks: state.chunks.length, docs: Object.keys(state.chunks.reduce(function (a, c) { a[c.docId] = 1; return a; }, {})).length, dim: DIM, loaded: state.loaded, updatedAt: (function () { try { var o = JSON.parse(localStorage.getItem(lsKey()) || "{}"); return o.ts || 0; } catch (e) { return 0; } })() };
  }
  function clearIndex() { state.chunks = []; state.df = {}; state.n = 0; try { localStorage.removeItem(lsKey()); } catch (e) {} }

  /* ---------------- D-3：混合权重可学习 ---------------- */
  function getWeights() { return { vector: state.weights.vector, bm25: state.weights.bm25, fuzzy: state.weights.fuzzy }; }
  function setWeights(w) {
    if (!w) return getWeights();
    var v = Number(w.vector), k = Number(w.bm25), f = Number(w.fuzzy);
    if ([v, k, f].some(function (x) { return isNaN(x) || x < 0; })) return getWeights();
    var sum = v + k + f; if (sum <= 0) return getWeights();
    state.weights = { vector: v / sum, bm25: k / sum, fuzzy: f / sum };
    return getWeights();
  }
  // D-3：基于反馈学习权重——让更能区分相关文档的信号获得更高权重（学习率 0.3，向区分度归一方向缓移）
  function learnWeights(query, relevantDocIds) {
    if (!query || !relevantDocIds || !relevantDocIds.length || !state._lastRaw || !state._lastRaw.length) return getWeights();
    var rel = {}, i; for (i = 0; i < relevantDocIds.length; i++) rel[relevantDocIds[i]] = 1;
    var relSig = { v: 0, k: 0, f: 0 }, othSig = { v: 0, k: 0, f: 0 }, rn = 0, on = 0;
    state._lastRaw.forEach(function (r) {
      if (rel[r.c.docId]) { relSig.v += r.v; relSig.k += r.k; relSig.f += r.f; rn++; }
      else { othSig.v += r.v; othSig.k += r.k; othSig.f += r.f; on++; }
    });
    function avg(o, n) { return n ? { v: o.v / n, k: o.k / n, f: o.f / n } : { v: 0, k: 0, f: 0 }; }
    var ra = avg(relSig, rn), oa = avg(othSig, on);
    var sep = { vector: Math.max(0, ra.v - oa.v), bm25: Math.max(0, ra.k - oa.k), fuzzy: Math.max(0, ra.f - oa.f) };
    var tot = sep.vector + sep.bm25 + sep.fuzzy;
    if (tot <= 0) return getWeights();
    var lr = 0.3, W = state.weights;
    var nv = W.vector + lr * (sep.vector / tot - W.vector);
    var nk = W.bm25 + lr * (sep.bm25 / tot - W.bm25);
    var nf = W.fuzzy + lr * (sep.fuzzy / tot - W.fuzzy);
    return setWeights({ vector: nv, bm25: nk, fuzzy: nf });
  }
  global.KBRag = {
    init: init, buildIndex: buildIndex, addDoc: addDoc, removeDoc: removeDoc, clearIndex: clearIndex,
    search: hybridSearch, hybridSearch: hybridSearch, reverseQuery: reverseQuery, askSmart: askSmart,
    remember: remember, recall: recall, memClear: memClear, memLoad: memLoad,
    buildPrompt: buildPrompt, suggestPrompts: suggestPrompts, expandQuery: expandQuery,
    setWeights: setWeights, getWeights: getWeights, learnWeights: learnWeights, highlight: highlight,
    chunkText: chunkText, tokenize: tokenize, embed: embed, stats: stats
  };
})(typeof window !== "undefined" ? window : this);
