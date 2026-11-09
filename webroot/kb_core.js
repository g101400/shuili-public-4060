/* ===== kb_core.js — 知识库智能化内核（模糊检索 / 提示词生成 / AI记忆·Hermes / 存疑反向查询 / 强制联网）=====
 * 依赖：kb_rag.js（window.KBRag）、ai_module.js（window.AIModule）
 * 注入：index.html 在 ai_module.js 之后、app.js 之前引入；菜单由 buildMenu 调 KBCore.getMenuGroups() 注入。
 * 设计：全部能力离线可用；「强制联网」开启后所有智能调用强制走在线大模型，本地仅作上下文，
 *       断网时明确报错而不再静默降级为本地抽取式答案。
 */
(function (global) {
  "use strict";

  var K_FORCE = "kb_force_online";
  var K_TPL = "kb_prompt_tpl";

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(m) { try { if (global.toast) global.toast(m); } catch (e) {} }
  function ls(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function rag() { return global.KBRag || null; }
  function ai() { return global.AIModule || null; }
  function openGen(title, html) {
    var gt = $("genTitle"), gb = $("genBody");
    if (!gt || !gb) { toast("UI 未就绪"); return; }
    gt.textContent = title; gb.innerHTML = html;
    if (global.openSheet) global.openSheet("sheetGen");
  }
  function bind(attr, fn) {
    var gb = $("genBody"); if (!gb) return;
    var list = gb.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < list.length; i++) {
      (function (el) { el.onclick = function () { fn(el.getAttribute(attr), el); }; })(list[i]);
    }
  }
  function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); toast("已复制"); return; }
    } catch (e) {}
    try {
      var ta = document.createElement("textarea"); ta.value = t;
      document.body.appendChild(ta); ta.select(); document.execCommand("copy");
      document.body.removeChild(ta); toast("已复制");
    } catch (e2) { toast("复制失败，请长按选择文本"); }
  }
  function snippet(t, n) { t = String(t || "").replace(/\s+/g, " "); return t.length > (n || 120) ? t.slice(0, n || 120) + "…" : t; }

  /* ---------------- 强制联网 ---------------- */
  function forceOnline() { return ls(K_FORCE, false) === true; }
  function setForceOnline(on) {
    save(K_FORCE, !!on);
    try { if (ai() && typeof ai().setOnline === "function") ai().setOnline(!!on); } catch (e) {}
    return !!on;
  }
  // 在线自检：默认用 AIModule 的轻量 ask 做一次握手；失败即判定为不可达
  function pingOnline() {
    var A = ai();
    if (!A || typeof A.ask !== "function") return Promise.reject(new Error("未配置智能AI（设置 → 智能AI设置）"));
    var timer = setTimeout(function () {}, 0); clearTimeout(timer);
    return A.ask([{ role: "user", content: "回复两个字：可用" }]).then(function (r) {
      var txt = (r && (r.content || r.text || r.answer)) || (typeof r === "string" ? r : "");
      return { ok: true, text: String(txt).slice(0, 50) };
    });
  }
  // 统一智能调用：强制联网时先自检再走在线；否则走 KBRag.askSmart（本地优先）
  function smartAsk(question, opt) {
    opt = opt || {};
    if (forceOnline() || opt.force) {
      return pingOnline().then(function () {
        var R = rag();
        if (R && typeof R.askSmart === "function") return R.askSmart(question, { forceOnline: true, topK: opt.topK || 6 });
        var A = ai();
        if (!A) throw new Error("智能模块未加载");
        return A.ask([{ role: "user", content: question }]);
      }).catch(function (e) {
        throw new Error("强制联网已开启，但在线调用失败：" + ((e && e.message) || "网络不可用") + "。请检查网络或到「智能AI设置」检查模型与密钥。");
      });
    }
    var R = rag();
    if (R && typeof R.askSmart === "function") return R.askSmart(question, { topK: opt.topK || 6 });
    var A = ai();
    if (!A) return Promise.reject(new Error("智能模块未加载"));
    return A.ask([{ role: "user", content: question }]).then(function (r) {
      return { answer: (r && (r.content || r.text || r.answer)) || String(r || ""), hits: [] };
    });
  }

  /* ---------------- 1. 智能模糊检索 ---------------- */
  // 相似度：字符二元组重合率（对中英文、错字、简写都稳健） + 子串包含加成
  function sim(a, b) {
    a = String(a || "").toLowerCase().replace(/\s+/g, "");
    b = String(b || "").toLowerCase().replace(/\s+/g, "");
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (b.indexOf(a) >= 0) return 0.9;
    if (a.indexOf(b) >= 0) return 0.85;
    var A = {}, n = 0, hit = 0, i;
    for (i = 0; i < a.length - 1; i++) { A[a.substr(i, 2)] = 1; n++; }
    for (i = 0; i < b.length - 1; i++) { if (A[b.substr(i, 2)]) hit++; }
    var base = n ? hit / n : 0;
    // 单字覆盖加成（中文短词更友好）
    var sa = a.split(""), c = 0;
    for (i = 0; i < sa.length; i++) if (b.indexOf(sa[i]) >= 0) c++;
    var charCov = sa.length ? c / sa.length : 0;
    return Math.min(0.89, base * 0.6 + charCov * 0.4);
  }
  function fuzzySearch(q, opt) {
    opt = opt || {};
    var topK = opt.topK || 12;
    var out = [];
    var A = ai();
    var list = (A && typeof A.kbList === "function") ? A.kbList() : [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var title = String(it.title || "");
      var s = Math.max(sim(q, title), sim(q, String(it.source || "")) * 0.9);
      var tags = it.tags || [];
      for (var t = 0; t < tags.length; t++) s = Math.max(s, sim(q, String(tags[t])) * 0.8);
      if (s >= (opt.min || 0.28)) out.push({ id: it.id, title: title, type: it.type || "", source: it.source || "", score: s, item: it });
    }
    out.sort(function (x, y) { return y.score - x.score; });
    out = out.slice(0, topK);
    // RAG 片段补充
    var R = rag();
    if (R && typeof R.search === "function" && R.stats && R.stats().chunks > 0) {
      try {
        var hits = R.search(q, { topK: Math.min(6, topK) }) || [];
        for (var h = 0; h < hits.length; h++) {
          var hh = hits[h] || {};
          out.push({ id: (hh.docId || hh.id || "chunk" + h), title: hh.title || "知识片段",
                     type: "chunk", source: hh.source || "", score: 0.3 + (hh.score || 0) * 0.5,
                     text: snippet(hh.text || hh.body || "", 160), item: hh });
        }
      } catch (e) {}
    }
    return out;
  }
  function openFuzzy() {
    var on = forceOnline();
    openGen("智能模糊检索",
      '<div style="font-size:13px;color:#555;margin-bottom:8px">支持错字、简写、别名的模糊匹配（标题 / 标签 / 来源 + 知识库片段）。' +
      (on ? ' <b style="color:#1a6fc4">强制联网：开</b>' : ' <span style="color:#888">强制联网：关（本地优先）</span>') + '</div>' +
      '<input id="kbFzQ" placeholder="输入关键词，如：闸门 启闭机 / 管理所" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cfd8e3;border-radius:8px" />' +
      '<div class="up-btns" style="margin-top:10px">' +
      '<button class="btn-save" id="kbFzGo">🔎 检索</button>' +
      '<button class="btn-save" id="kbFzAi">✨ 智能作答</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button></div>' +
      '<div id="kbFzOut" style="margin-top:10px;font-size:13px"></div>');
    var go = $("kbFzGo"), out = $("kbFzOut");
    function render(rs) {
      if (!rs.length) { out.innerHTML = '<div class="up-warn">没有匹配结果，换个说法试试。</div>'; return; }
      out.innerHTML = rs.map(function (r, i) {
        return '<div style="padding:8px 0;border-bottom:1px solid #eef2f7">' +
          '<div><b>' + esc(r.title) + '</b>　<small style="color:#1a6fc4">' + Math.round(r.score * 100) + '%</small>' +
          '<small style="color:#999"> · ' + esc(r.type || "条目") + (r.source ? " · " + esc(r.source) : "") + '</small></div>' +
          (r.text ? '<div style="color:#666;margin-top:4px">' + esc(r.text) + '</div>' : "") +
          '<div style="margin-top:4px"><a href="javascript:void(0)" data-kbfz="' + i + '" style="color:#1a6fc4">复制标题</a>' +
          '　<a href="javascript:void(0)" data-kbask="' + i + '" style="color:#1a6fc4">就此提问</a></div></div>';
      }).join("");
      bind("data-kbfz", function (v) { copyText(rs[parseInt(v, 10)].title); });
      bind("data-kbask", function (v) { askAbout(rs[parseInt(v, 10)].title); });
    }
    if (go) go.onclick = function () {
      var q = ($("kbFzQ") || {}).value || "";
      if (!q.trim()) { out.innerHTML = '<div class="up-warn">请输入关键词</div>'; return; }
      out.innerHTML = "检索中…";
      render(fuzzySearch(q.trim()));
    };
    var b2 = $("kbFzAi");
    if (b2) b2.onclick = function () {
      var q = ($("kbFzQ") || {}).value || "";
      if (!q.trim()) { out.innerHTML = '<div class="up-warn">请输入关键词</div>'; return; }
      out.innerHTML = (forceOnline() ? "已强制联网，正在调用在线模型…" : "正在生成答案…");
      smartAsk(q.trim()).then(function (r) {
        var ans = (r && (r.answer || r.text || r.content)) || String(r || "");
        out.innerHTML = '<div style="white-space:pre-wrap;line-height:1.7">' + esc(ans) + '</div>' +
          '<div style="margin-top:8px"><a href="javascript:void(0)" id="kbFzCopy" style="color:#1a6fc4">复制答案</a></div>';
        var c = $("kbFzCopy"); if (c) c.onclick = function () { copyText(ans); };
      }).catch(function (e) {
        out.innerHTML = '<div class="up-warn">' + esc((e && e.message) || "调用失败") + '</div>';
      });
    };
  }
  function askAbout(title) {
    openGen("智能作答", '<div style="padding:10px 0">正在就「' + esc(title) + '」生成答案…</div>');
    smartAsk(title).then(function (r) {
      var ans = (r && (r.answer || r.text || r.content)) || String(r || "");
      openGen("智能作答 · " + title.slice(0, 12),
        '<div style="white-space:pre-wrap;line-height:1.7;font-size:14px">' + esc(ans) + '</div>' +
        '<div class="up-btns" style="margin-top:10px"><button class="btn-save" id="kbAnsCopy">复制</button>' +
        '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button></div>');
      var c = $("kbAnsCopy"); if (c) c.onclick = function () { copyText(ans); };
    }).catch(function (e) {
      openGen("智能作答失败", '<div class="up-warn">' + esc((e && e.message) || "调用失败") + '</div>');
    });
  }

  /* ---------------- 2. 提示词生成器 ---------------- */
  var TPL = {
    inspect: { n: "巡检报告", p: "你是水利工程巡检专家。请依据下列要素生成一份规范巡检报告：{主题}。要求：①先列检查项清单；②逐项给出判断标准与常见缺陷；③结尾给出整改建议与优先级。语言正式、可直接归档。" },
    repair: { n: "维修方案", p: "你是水工建筑物维修工程师。针对「{主题}」编制维修方案：①故障现象与原因分析；②所需材料与工器具；③施工步骤与质量控制点；④安全注意事项；⑤验收标准。" },
    check: { n: "参数核对", p: "请核对「{主题}」的设计参数与现场记录是否一致：①列出应核对的关键参数表（参数名/设计值/实测值/偏差）；②给出超差处置建议；③注明需要复核的资料来源。" },
    report: { n: "汇报材料", p: "请围绕「{主题}」写一段面向上级的汇报材料：①现状概述（200字内）；②主要问题与风险；③已采取措施；④下一步计划与所需支持。语气简练、数据留空位。" },
    risk: { n: "隐患排查", p: "请以隐患排查视角分析「{主题}」：①可能的隐患点清单；②每项的触发条件与后果严重度；③现有防控措施有效性评价；④补充防控建议。" },
    train: { n: "培训要点", p: "请为基层管理人员编写「{主题}」培训要点：①必须掌握的三条核心知识；②常见误操作与纠正方法；③现场快速判断口诀。" }
  };
  function subjects() {
    var A = ai(), out = [];
    if (A && typeof A.kbList === "function") {
      A.kbList().slice(0, 200).forEach(function (r) {
        if (r && r.title) out.push(String(r.title));
      });
    }
    return out.slice(0, 60);
  }
  function buildPrompt(subject, tplKey) {
    var t = TPL[tplKey] || TPL.inspect;
    return String(t.p).replace(/\{主题\}/g, subject || "");
  }
  function openPrompt() {
    var subs = subjects();
    var opt = subs.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join("");
    var tplOpt = Object.keys(TPL).map(function (k) {
      return '<option value="' + k + '"' + (k === ls(K_TPL, "inspect") ? " selected" : "") + '>' + TPL[k].n + '</option>';
    }).join("");
    openGen("提示词生成器",
      '<div style="font-size:13px;color:#555;margin-bottom:8px">选择主题与模板，一键生成可直接投喂大模型的提示词。</div>' +
      '<div style="margin-bottom:8px"><select id="kbPtSub" style="width:100%;padding:9px;border:1px solid #cfd8e3;border-radius:8px">' +
      (opt || '<option value="">（知识库暂无条目，可手动输入）</option>') + '</select></div>' +
      '<input id="kbPtSub2" placeholder="或手动输入主题" style="width:100%;box-sizing:border-box;padding:9px;border:1px solid #cfd8e3;border-radius:8px;margin-bottom:8px" />' +
      '<select id="kbPtTpl" style="width:100%;padding:9px;border:1px solid #cfd8e3;border-radius:8px">' + tplOpt + '</select>' +
      '<div class="up-btns" style="margin-top:10px"><button class="btn-save" id="kbPtGo">✍️ 生成</button>' +
      '<button class="btn-save" id="kbPtSend">🚀 生成并提问</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button></div>' +
      '<div id="kbPtOut" style="margin-top:10px;font-size:13px"></div>');
    var go = $("kbPtGo");
    if (go) go.onclick = function () {
      var sub = (($("kbPtSub2") || {}).value || "").trim() || (($("kbPtSub") || {}).value || "").trim();
      var tk = ($("kbPtTpl") || {}).value || "inspect";
      save(K_TPL, tk);
      if (!sub) { $("kbPtOut").innerHTML = '<div class="up-warn">请填写主题</div>'; return; }
      var p = buildPrompt(sub, tk);
      var o = $("kbPtOut");
      o.innerHTML = '<div style="white-space:pre-wrap;background:#f6f8fb;padding:10px;border-radius:8px;line-height:1.7">' + esc(p) + '</div>' +
        '<div class="up-btns" style="margin-top:8px"><button class="btn-save" id="kbPtCopy">复制提示词</button></div>';
      var c = $("kbPtCopy"); if (c) c.onclick = function () { copyText(p); };
      global.__kbLastPrompt = p;
    };
    var sd = $("kbPtSend");
    if (sd) sd.onclick = function () {
      var sub = (($("kbPtSub2") || {}).value || "").trim() || (($("kbPtSub") || {}).value || "").trim();
      var tk = ($("kbPtTpl") || {}).value || "inspect";
      save(K_TPL, tk);
      if (!sub) { $("kbPtOut").innerHTML = '<div class="up-warn">请填写主题</div>'; return; }
      var p = buildPrompt(sub, tk);
      $("kbPtOut").innerHTML = (forceOnline() ? "强制联网中，正在调用在线模型…" : "正在生成…");
      smartAsk(p).then(function (r) {
        var ans = (r && (r.answer || r.text || r.content)) || String(r || "");
        $("kbPtOut").innerHTML = '<div style="white-space:pre-wrap;line-height:1.7">' + esc(ans) + '</div>' +
          '<div class="up-btns" style="margin-top:8px"><button class="btn-save" id="kbPtCopy2">复制结果</button></div>';
        var c = $("kbPtCopy2"); if (c) c.onclick = function () { copyText(ans); };
      }).catch(function (e) {
        $("kbPtOut").innerHTML = '<div class="up-warn">' + esc((e && e.message) || "调用失败") + '</div>';
      });
    };
  }

  /* ---------------- 3. AI 记忆 · Hermes ---------------- */
  function hermesItems() {
    var A = ai();
    if (!A || typeof A.kbList !== "function") return [];
    return A.kbList().filter(function (r) { return r && (r.type === "hermes" || r.type === "operation"); });
  }
  function openMemory() {
    var R = rag(), A = ai();
    var mem = (R && typeof R.memLoad === "function") ? R.memLoad() : [];
    var hs = hermesItems();
    openGen("AI 记忆 · Hermes",
      '<div style="font-size:13px;color:#555;margin-bottom:8px">对话记忆由检索内核维护，Hermes 把可复用的经验沉淀成知识条目，供后续问答自动引用。</div>' +
      '<div style="background:#f6f8fb;padding:10px;border-radius:8px;font-size:13px">' +
      '对话记忆：<b>' + mem.length + '</b> 条　|　Hermes 沉淀：<b>' + hs.length + '</b> 条' +
      (R && R.stats ? '　|　索引切片：<b>' + R.stats().chunks + '</b>' : '') + '</div>' +
      '<div style="margin-top:10px;max-height:220px;overflow:auto;font-size:13px">' +
      (mem.length ? mem.slice(-8).reverse().map(function (m) {
        return '<div style="padding:6px 0;border-bottom:1px solid #eef2f7"><small style="color:#999">' + esc(m.role || "") + '</small> ' + esc(snippet(m.text || m.content || "", 90)) + '</div>';
      }).join("") : '<div style="color:#999">暂无对话记忆</div>') + '</div>' +
      '<div style="margin-top:8px;font-size:13px"><b>Hermes 沉淀（最近 6 条）</b>' +
      (hs.length ? hs.slice(0, 6).map(function (h) {
        return '<div style="padding:6px 0;border-bottom:1px solid #eef2f7">' + esc(h.title || "") + ' <small style="color:#999">' + esc(h.ts || "") + '</small></div>';
      }).join("") : '<div style="color:#999">暂无沉淀</div>') + '</div>' +
      '<div class="up-btns" style="margin-top:12px">' +
      '<button class="btn-save" id="kbMemLearn">🧠 把当前知识沉淀为 Hermes 条目</button>' +
      '<button class="btn-save" id="kbMemAdd">➕ 手动记录一条经验</button>' +
      '<button class="btn-cancel" id="kbMemClear">清空对话记忆</button></div>' +
      '<div id="kbMemOut" style="margin-top:8px;font-size:13px"></div>');
    var o = $("kbMemOut");
    var b1 = $("kbMemLearn");
    if (b1) b1.onclick = function () {
      if (!A || typeof A.hermesLearn !== "function") { o.innerHTML = '<div class="up-warn">智能模块未就绪</div>'; return; }
      o.innerHTML = "沉淀中…";
      try {
        var n = A.hermesLearn();
        o.innerHTML = '<span class="up-ok">已沉淀 ' + (n || 0) + ' 条</span>';
        toast("Hermes 沉淀完成");
      } catch (e) { o.innerHTML = '<div class="up-warn">' + esc(e.message || String(e)) + '</div>'; }
    };
    var b2 = $("kbMemAdd");
    if (b2) b2.onclick = function () {
      o.innerHTML = '<input id="kbMemTitle" placeholder="经验标题" style="width:100%;box-sizing:border-box;padding:9px;border:1px solid #cfd8e3;border-radius:8px;margin-bottom:6px" />' +
        '<textarea id="kbMemBody" rows="4" placeholder="经验内容（处置过程/结论/注意事项）" style="width:100%;box-sizing:border-box;padding:9px;border:1px solid #cfd8e3;border-radius:8px"></textarea>' +
        '<div class="up-btns" style="margin-top:8px"><button class="btn-save" id="kbMemSave">保存</button></div>';
      var s = $("kbMemSave");
      if (s) s.onclick = function () {
        var t = (($("kbMemTitle") || {}).value || "").trim();
        var b = (($("kbMemBody") || {}).value || "").trim();
        if (!t || !b) { toast("标题与内容都要填"); return; }
        try {
          if (R && typeof R.remember === "function") R.remember("user", t + "：" + b);
          if (A && typeof A.kbAdd === "function") {
            A.kbAdd({ title: t, body: b, type: "hermes", source: "手动记录" });
          } else if (R && typeof R.addDoc === "function") {
            R.addDoc({ id: "hermes_" + Date.now(), title: t, body: b, type: "hermes", source: "手动记录" });
          }
          o.innerHTML = '<span class="up-ok">已记录并可被后续问答引用</span>';
          toast("已记录");
        } catch (e) { o.innerHTML = '<div class="up-warn">' + esc(e.message || String(e)) + '</div>'; }
      };
    };
    var b3 = $("kbMemClear");
    if (b3) b3.onclick = function () {
      if (!global.confirm || global.confirm("确定清空对话记忆？（Hermes 沉淀条目不会被删除）")) {
        try { if (R && R.memClear) R.memClear(); } catch (e) {}
        o.innerHTML = '<span class="up-ok">对话记忆已清空</span>';
        toast("已清空");
      }
    };
  }

  /* ---------------- 4. 存疑反向查询 ---------------- */
  // 从一段文字提取"数值+单位"与关键短语，比对本地 KB 中同名条目的表述，列出可能冲突
  function extractFacts(text) {
    var out = [];
    var re = /([一-龥A-Za-z]{2,10})\s*(?:为|是|:|：|=)?\s*(\d+(?:\.\d+)?)\s*(米|m|M|厘米|cm|毫米|mm|公里|km|平方米|㎡|立方米|m3|m³|吨|t|千瓦|kW|kw|台|座|个|处|年|月|日|度|%|％)?/g;
    var m;
    while ((m = re.exec(String(text || "")))) out.push({ k: m[1], v: m[2], u: m[3] || "" });
    return out.slice(0, 40);
  }
  function doubtReverse(text, opt) {
    opt = opt || {};
    var res = { sources: [], conflicts: [] };
    var R = rag(), A = ai();
    if (R && typeof R.reverseQuery === "function") {
      try { res.sources = R.reverseQuery(text, opt.topK || 6) || []; } catch (e) { res.sources = []; }
    }
    if (!res.sources.length && A && typeof A.kbSearch === "function") {
      try { res.sources = A.kbSearch(String(text).slice(0, 30)) || []; } catch (e) {}
    }
    var facts = extractFacts(text);
    var pool = [];
    (res.sources || []).forEach(function (s) {
      pool.push({ title: s.title || "", text: s.text || s.body || "" });
    });
    if (A && typeof A.kbList === "function") {
      A.kbList().slice(0, 300).forEach(function (it) {
        var t = String(it.title || "");
        if (!t) return;
        for (var i = 0; i < facts.length; i++) {
          if (t.indexOf(facts[i].k) >= 0) { pool.push({ title: t, text: "", id: it.id, item: it }); break; }
        }
      });
    }
    facts.forEach(function (f) {
      var vals = {};
      pool.forEach(function (p) {
        var re2 = new RegExp(f.k + "[^0-9]{0,6}(\\d+(?:\\.\\d+)?)");
        var m = re2.exec(p.text || "");
        if (m) vals[m[1]] = vals[m[1]] || [];
        if (m) vals[m[1]].push(p.title);
      });
      var keys = Object.keys(vals);
      if (keys.length > 1) {
        res.conflicts.push({ key: f.k, current: f.v, others: keys.map(function (k) { return { v: k, from: vals[k].slice(0, 3) }; }) });
      }
    });
    return res;
  }
  function openDoubt() {
    openGen("存疑反向查询",
      '<div style="font-size:13px;color:#555;margin-bottom:8px">粘贴一段描述，反查它出自哪些知识条目；并自动比对数值表述，列出需要现场核实的差异。</div>' +
      '<textarea id="kbDbTxt" rows="5" placeholder="粘贴待核实的描述文字…" style="width:100%;box-sizing:border-box;padding:9px;border:1px solid #cfd8e3;border-radius:8px"></textarea>' +
      '<div class="up-btns" style="margin-top:10px"><button class="btn-save" id="kbDbGo">⚠️ 反查</button>' +
      '<button class="btn-save" id="kbDbAi">🌐 联网核实</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button></div>' +
      '<div id="kbDbOut" style="margin-top:10px;font-size:13px"></div>');
    var go = $("kbDbGo"), out = $("kbDbOut");
    if (go) go.onclick = function () {
      var t = (($("kbDbTxt") || {}).value || "").trim();
      if (!t) { out.innerHTML = '<div class="up-warn">请粘贴内容</div>'; return; }
      out.innerHTML = "反查中…";
      var r = doubtReverse(t);
      var src = (r.sources || []).map(function (s) {
        return '<div style="padding:6px 0;border-bottom:1px solid #eef2f7"><b>' + esc(s.title || "片段") + '</b>' +
          (s.conf != null ? ' <small style="color:#b8860b">· 置信度' + Math.round(s.conf * 100) + '%</small>' : "") +
          (s.text ? '<div style="color:#666">' + esc(snippet(s.text, 120)) + '</div>' : "") + '</div>';
      }).join("") || '<div style="color:#999">未找到明确来源（可能为用户新增或未入库内容）</div>';
      var cf = (r.conflicts || []).map(function (c) {
        return '<div style="padding:6px 0;border-bottom:1px solid #f3e2e2;color:#b8860b">' +
          '⚠️ <b>' + esc(c.key) + '</b>：当前记作 <b>' + esc(c.current) + '</b>，库中存在 ' +
          c.others.map(function (o) { return esc(o.v) + "（" + esc((o.from || []).join("、")) + "）"; }).join("、") +
          ' —— 建议现场核实</div>';
      }).join("") || '<div style="color:#2b7fd4">未发现数值冲突</div>';
      out.innerHTML = '<div><b>可能来源</b></div>' + src + '<div style="margin-top:8px"><b>存疑点</b></div>' + cf;
    };
    var b = $("kbDbAi");
    if (b) b.onclick = function () {
      var t = (($("kbDbTxt") || {}).value || "").trim();
      if (!t) { out.innerHTML = '<div class="up-warn">请粘贴内容</div>'; return; }
      out.innerHTML = (forceOnline() ? "强制联网核实中…" : "正在核实…");
      var r = doubtReverse(t);
      var ctx = (r.sources || []).slice(0, 3).map(function (s) { return "【参考】" + (s.title || "") + "：" + snippet(s.text || "", 120); }).join("\n");
      var q = "请核实下面这段描述的真实性，指出可能有误或需现场确认之处，并给出依据：\n" + t + (ctx ? "\n\n本地知识库参考：\n" + ctx : "");
      smartAsk(q).then(function (rr) {
        var ans = (rr && (rr.answer || rr.text || rr.content)) || String(rr || "");
        out.innerHTML = '<div style="white-space:pre-wrap;line-height:1.7">' + esc(ans) + '</div>' +
          '<div class="up-btns" style="margin-top:8px"><button class="btn-save" id="kbDbCopy">复制结论</button></div>';
        var c = $("kbDbCopy"); if (c) c.onclick = function () { copyText(ans); };
      }).catch(function (e) {
        out.innerHTML = '<div class="up-warn">' + esc((e && e.message) || "调用失败") + '</div>';
      });
    };
  }

  /* ---------------- 强制联网开关 ---------------- */
  function openForce() {
    var on = forceOnline();
    openGen("强制联网",
      '<div style="font-size:13px;color:#555;margin-bottom:10px">开启后，本内核的所有智能调用（智能作答 / 提示词提问 / 联网核实）<b>一律走在线大模型</b>，' +
      '本地知识库仅作为上下文引用；联网失败会明确报错，不再静默退回本地。关闭则恢复「本地优先」。</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px"><input type="checkbox" id="kbFoChk" ' + (on ? "checked" : "") + ' /> 强制联网</label>' +
      '<div class="up-btns" style="margin-top:12px"><button class="btn-save" id="kbFoTest">🔌 测试在线连通性</button>' +
      '<button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button></div>' +
      '<div id="kbFoOut" style="margin-top:10px;font-size:13px"></div>');
    var chk = $("kbFoChk"), out = $("kbFoOut");
    if (chk) chk.onchange = function () {
      var v = setForceOnline(this.checked);
      toast(v ? "已开启强制联网" : "已恢复本地优先");
      out.innerHTML = v ? '<span class="up-ok">强制联网：开</span>' : '<span style="color:#888">强制联网：关（本地优先）</span>';
    };
    var t = $("kbFoTest");
    if (t) t.onclick = function () {
      out.innerHTML = "测试中…";
      pingOnline().then(function (r) {
        out.innerHTML = '<span class="up-ok">✅ 在线可用</span>' + (r && r.text ? '<div style="color:#666;margin-top:4px">模型回复：' + esc(r.text) + '</div>' : "");
      }).catch(function (e) {
        out.innerHTML = '<div class="up-warn">❌ ' + esc((e && e.message) || "无法连接") + '</div>';
      });
    };
  }

  /* ---------------- 菜单注入 ---------------- */
  function getMenuGroups() {
    return [{
      g: "智能化内核", ico: "🧠", items: [
        { k: "kbFuzzy", ico: "🔎", t: "智能模糊检索", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) {} openFuzzy(); } },
        { k: "kbPrompt", ico: "✍️", t: "提示词生成器", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) {} openPrompt(); } },
        { k: "kbHermes", ico: "🧠", t: "AI 记忆 · Hermes", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) {} openMemory(); } },
        { k: "kbDoubt", ico: "⚠️", t: "存疑反向查询", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) {} openDoubt(); } },
        { k: "kbForce", ico: "🌐", t: "强制联网（开 / 关）", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) {} openForce(); } }
      ].concat((global.KBV && typeof global.KBV.getMenuItems === "function") ? global.KBV.getMenuItems() : [])
    }];
  }

  /* ---------------- D-5：多源冲突裁决 ---------------- */
  // 来源置信度（人工修订最高，Hermes 自学习次之，网页/OCR 较低）
  var SOURCE_CONF = {
    "人工": 1.0, "人工修订": 1.0, "manual": 1.0, "复核": 0.95,
    "hermes": 0.85, "Hermes自动学习": 0.85, "operation": 0.8,
    "网页": 0.7, "web": 0.7, "external": 0.7, "外部": 0.7,
    "OCR": 0.55, "ocr": 0.55
  };
  function sourceConfidence(src) {
    var s = String(src || "").trim();
    if (SOURCE_CONF[s] != null) return SOURCE_CONF[s];
    var low = s.toLowerCase();
    for (var k in SOURCE_CONF) { if (k.toLowerCase() === low) return SOURCE_CONF[k]; }
    return 0.6; // 未知来源默认中等偏低
  }
  // 冲突裁决：返回胜出记录 + 是否冲突 + 说明（人工修订 > Hermes > 网页 > OCR；同置信度取新入，同人工保留并提示）
  function resolveConflict(existing, incoming) {
    var e = existing || {}, n = incoming || {};
    var ce = sourceConfidence(e.source), cn = sourceConfidence(n.source);
    var out = { winner: n, conflict: false, note: "", kept: "incoming" };
    if (!e || !e.id) return out;
    if (ce === cn) {
      if (ce >= 0.95) { out.winner = e; out.kept = "existing"; out.conflict = true; out.note = "均为高置信人工修订，保留既有条目，新值作存疑提示"; }
      return out;
    }
    if (cn > ce) { out.conflict = ce >= 0.55; out.note = "新来源置信度更高（" + cn.toFixed(2) + " > " + ce.toFixed(2) + "），采用新值"; }
    else { out.winner = e; out.kept = "existing"; out.conflict = cn >= 0.55; out.note = "既有来源置信度更高（" + ce.toFixed(2) + " > " + cn.toFixed(2) + "），保留既有，新值作冲突提示"; }
    return out;
  }

  /* ---------------- D-6：query→推荐→报告→KB 闭环 ---------------- */
  // 把一次问答/推荐结果组装为可归档报告（Markdown）
  function buildReport(question, answer, meta) {
    meta = meta || {};
    var lines = [];
    lines.push("# " + (meta.title || "智能查询报告"));
    lines.push("");
    lines.push("> 生成时间：" + new Date().toLocaleString("zh-CN") + (meta.source ? "　|　来源：" + meta.source : ""));
    lines.push("");
    lines.push("## 查询");
    lines.push("");
    lines.push((question || "") + "");
    lines.push("");
    lines.push("## 结论 / 答案");
    lines.push("");
    lines.push((answer || "") + "");
    lines.push("");
    lines.push("## 引用与建议");
    lines.push("");
    (meta.refs && meta.refs.length ? meta.refs : ["（详见知识库原文与存疑反向查询）"]).forEach(function (r) { lines.push("- " + r); });
    lines.push("");
    return lines.join("\n");
  }
  // 闭环写回：把问答结果沉淀进知识库（operation 类型，可被后续检索引用）
  function writeBackKB(question, answer, meta) {
    var A = ai();
    if (!A || typeof A.kbAdd !== "function") return null;
    meta = meta || {};
    var id = "loop_" + Date.now();
    try {
      A.kbAdd({ id: id, title: (meta.title || ("问答：" + String(question || "").slice(0, 20))), body: buildReport(question, answer, meta), type: "operation", source: meta.source || "智能闭环" });
    } catch (e) { return null; }
    return id;
  }

  global.KBCore = {
    getMenuGroups: getMenuGroups,
    fuzzySearch: fuzzySearch,
    buildPrompt: buildPrompt,
    promptTemplates: TPL,
    doubtReverse: doubtReverse,
    sourceConfidence: sourceConfidence, resolveConflict: resolveConflict, SOURCE_CONF: SOURCE_CONF,
    buildReport: buildReport, writeBackKB: writeBackKB,
    smartAsk: smartAsk,
    pingOnline: pingOnline,
    forceOnline: forceOnline,
    setForceOnline: setForceOnline,
    openFuzzy: openFuzzy, openPrompt: openPrompt, openMemory: openMemory, openDoubt: openDoubt, openForce: openForce
  };
})(typeof window !== "undefined" ? window : this);
