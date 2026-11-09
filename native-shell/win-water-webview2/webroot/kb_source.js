/* kb_source.js —— 多源素材采集入库 / 检索（可插拔模块）
 *
 * 来源：multi-source-to-kb 技能（把 qiaomu-anything-to-notebooklm 去 Google、去 NotebookLM 后的国内离线版）
 * 接入方式：智能内核 kb_core.js 的 getMenuGroups() 末尾会
 *           .concat(window.KBV && window.KBV.getMenuItems ? window.KBV.getMenuItems() : [])
 *           所以本模块只要挂上 window.KBV 即可自动进「智能化内核」菜单，**不改核心代码一行**。
 * 卸载方式：删除本文件 + 移除 index.html 里的 <script src> 一行，其余不受影响。
 *
 * 离线约定（与 kb_core.js 一致）：全部能力纯本地；断网/无模型时明确报错，不静默降级成假答案。
 * 能力边界（诚实写清）：
 *   - App 内是 file:// / WebView 环境，fetch 外链会被跨域拦掉，所以**不做网页自动抓取**；
 *     网页/微信链接的自动抓取在 PC 端技能 multi-source-to-kb 完成，App 侧靠「导入已落盘的 .md/.txt」承接。
 *   - 本模块负责：素材入库（本地存储）→ 本地检索 → 挑命中片段交给 AIModule(ai.js) 生成文稿/汇报。
 */
(function (global) {
  "use strict";

  var KEY_ITEMS = "kb_source_items";   // 素材原文 [{id,title,text,cat,ts}]
  var KEY_IDX = "kb_source_idx";       // 倒排 {tok:{docId:tf}}（每次入库重建）
  var KEY_DF = "kb_source_df";         // 文档频率 {tok:n}
  var N = 2;                           // 中文 n-gram

  function ls(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(m) { try { if (global.toast) global.toast(m); } catch (e) { } }
  function $(id) { return document.getElementById(id); }

  /* ---------------- 纯本地检索（中文 n-gram + TF-IDF，与 PC 端 kb.py 同构） ---------------- */
  function tok(s) {
    s = String(s || "").toLowerCase();
    var out = [];
    var segs = String(s).split(/[^a-z0-9\u4e00-\u9fff]+/);
    for (var i = 0; i < segs.length; i++) {
      var t = segs[i];
      if (!t) continue;
      if (/^[\u4e00-\u9fff]+$/.test(t)) {
        if (t.length === 1) { out.push(t); continue; }
        for (var j = 0; j + N <= t.length; j++) out.push(t.substr(j, N));
      } else out.push(t);
    }
    return out;
  }

  function rebuildIndex() {
    var items = ls(KEY_ITEMS, []);
    var idx = {}, df = {}, id, k, arr;
    for (var i = 0; i < items.length; i++) {
      id = items[i].id;
      arr = {};
      var ts = tok(items[i].text);
      for (var m = 0; m < ts.length; m++) arr[ts[m]] = (arr[ts[m]] || 0) + 1;
      idx[id] = arr;
      for (k in arr) df[k] = (df[k] || 0) + 1;
    }
    save(KEY_IDX, idx); save(KEY_DF, df);
    return idx;
  }

  function search(q, topK) {
    var items = ls(KEY_ITEMS, []), idx = ls(KEY_IDX, {}), df = ls(KEY_DF, {});
    var qs = tok(q);
    if (!qs.length) return [];
    var total = items.length || 1, i, k;
    // 注意：idx 是「按文档 id 索引 token」（idx[docId] = {token: tf}），
    // 不能写成 idx[token] 去取——那样 rows 永远是 {}，全部查询必然 0 命中。
    var idf = {}, i2;
    for (i2 = 0; i2 < qs.length; i2++) { k = qs[i2]; idf[k] = Math.log((total + 1) / ((df[k] || 0) + 0.5)); }
    var score = {};
    for (var id in idx) {
      var rows = idx[id] || {}, s = 0;
      for (i2 = 0; i2 < qs.length; i2++) {
        k = qs[i2];
        if (rows[k]) s += (1 + Math.log(rows[k])) * idf[k];
      }
      if (s > 0) score[id] = s;
    }
    var hit = [];
    for (var key in score) {
      var it = null;
      for (i = 0; i < items.length; i++) if (items[i].id === key) { it = items[i]; break; }
      if (!it) continue;
      var cov = 0;
      for (i = 0; i < qs.length; i++) if (idx[qs[i]] && idx[qs[i]][key]) cov++;
      hit.push({ item: it, score: score[key] * (0.4 + 0.6 * (cov / qs.length)) });
    }
    hit.sort(function (a, b) { return b.score - a.score; });
    return hit.slice(0, topK || 5);
  }

  function addItem(title, text, cat) {
    var items = ls(KEY_ITEMS, []);
    text = String(text || "").replace(/\r/g, "");
    if (!text.trim()) return { ok: false, error: "内容为空" };
    // 同标题同内容去重（与 PC 端 myme 知识库一致的增量去重，避免重复烧上下文）
    for (var i = 0; i < items.length; i++) {
      if (items[i].text === text) return { ok: true, added: 0, total: items.length, dup: true };
    }
    var id = "s" + Date.now() + "_" + items.length;
    items.push({ id: id, title: (title || "未命名素材"), text: text, cat: cat || "", ts: Date.now() });
    save(KEY_ITEMS, items);
    rebuildIndex();
    return { ok: true, added: 1, total: items.length };
  }

  /* ---------------- UI（沿用项目既有 sheet 风格，缺则自兜底） ---------------- */
  function sheetHtml(id) {
    return '<div class="kbSrcMask" id="' + id + '_mask" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;display:none">'
      + '<div style="max-height:86vh;margin:6vh auto;width:min(92vw,660px);background:#fff;border-radius:12px;display:flex;flex-direction:column">'
      + '<div style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:600;display:flex;align-items:center">'
      + '<span id="' + id + '_t" style="flex:1"></span><span onclick="KBSourceUI.close(\'' + id + '\')" style="cursor:pointer;padding:2px 8px">✕</span></div>'
      + '<div id="' + id + '_b" style="padding:12px 14px;overflow:auto;font-size:13px"></div></div></div>';
  }
  function open(id, title, html) {
    if (!$("kbSrcSheets")) {
      var d = document.createElement("div"); d.id = "kbSrcSheets";
      document.body.appendChild(d);
      d.insertAdjacentHTML("beforeend", sheetHtml("kbSrcA") + sheetHtml("kbSrcB"));
    }
    var m = $("kbSrcA_mask"), b = $("kbSrcA_b"), t = $("kbSrcA_t");
    if (!m) { toast("UI 未就绪"); return; }
    t.textContent = title; b.innerHTML = html; m.style.display = "flex";
  }
  function close() { var m = $("kbSrcA_mask"); if (m) m.style.display = "none"; }

  function snippet(text, q) {
    var p = String(text).indexOf(q);
    if (p < 0) p = 0;
    var s = Math.max(0, p - 60), e = Math.min(text.length, p + q.length + 160);
    return (s > 0 ? "…" : "") + text.substr(s, e - s) + (e < text.length ? "…" : "");
  }

  /* ---------------- 菜单项 ---------------- */
  function openIngest() {
    var items = ls(KEY_ITEMS, []);
    open("kbSrcA", "多源素材入库（本地离线）",
      '<p style="color:#666;line-height:1.7">粘贴文本，或选择已落盘的 <b>.md / .txt / .csv / .log</b> 素材文件。'
      + '<br>网页 / 微信链接的自动抓取在 PC 端技能 <b>multi-source-to-kb</b> 完成（App 内 fetch 外链会被跨域拦掉，不做假承诺）；'
      + '这里可把 PC 端采集好的 .md 拖进来继续沉淀。</p>'
      + '<textarea id="kbSrcTA" rows="6" style="width:100%;box-sizing:border-box" placeholder="粘贴一段正文 / 巡检记录 / 工程备注…"></textarea>'
      + '<div style="display:flex;gap:6px;margin:8px 0">'
      + '<input id="kbSrcTitle" type="text" placeholder="素材标题（留空取前 20 字）" style="flex:1;min-width:0">'
      + '<input id="kbSrcCat" type="text" placeholder="分类（古建/感知/工程）" style="width:120px"></div>'
      + '<label style="display:inline-block;padding:6px 10px;background:#f2f5f9;border-radius:6px;cursor:pointer">📁 选择本地素材文件<input type="file" id="kbSrcFile" accept=".md,.txt,.csv,.log,.json" style="display:none"></label>'
      + '<div style="margin-top:10px"><button id="kbSrcIng" style="padding:8px 16px;background:#1677ff;color:#fff;border:0;border-radius:6px">入库</button>'
      + '<span id="kbSrcMsg" style="margin-left:10px;color:#666"></span></div>'
      + '<div style="margin-top:10px;color:#888">已入库素材：<b>' + items.length + '</b> 条</div>');

    $("kbSrcFile").onchange = function () {
      var f = this.files && this.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { $("kbSrcTA").value = String(fr.result || ""); $("kbSrcMsg").textContent = "已读取：" + f.name; };
      fr.readAsText(f, "utf-8");
    };
    $("kbSrcIng").onclick = function () {
      var txt = ($("kbSrcTA").value || "").trim();
      var title = ($("kbSrcTitle").value || txt.replace(/\s+/g, "").slice(0, 20) || "未命名素材");
      var cat = $("kbSrcCat").value || "";
      var r = addItem(title, txt, cat);
      $("kbSrcMsg").textContent = r.dup ? "内容重复，已跳过" : ("已入库，共 " + r.total + " 条");
      toast(r.dup ? "内容重复，已跳过" : "已入库");
    };
  }

  function openSearch() {
    open("kbSrcA", "素材库检索 · 本地命中",
      '<input id="kbSrcQ" type="text" placeholder="例：闸门开度 / 巴歇尔槽 / 古建斗拱 修缮" style="width:100%;box-sizing:border-box">'
      + '<div id="kbSrcR" style="margin-top:10px;line-height:1.8">输入关键词开始检索。</div>');
    function run() {
      var q = ($("kbSrcQ").value || "").trim();
      var out = $("kbSrcR");
      if (!q) { out.textContent = "输入关键词开始检索。"; return; }
      var hits = search(q, 6);
      if (!hits.length) { out.innerHTML = '<span style="color:#c00">❌ 无命中：素材库是空的或没有相关词。可先点「多源素材入库」。</span>'; return; }
      var h = "";
      for (var i = 0; i < hits.length; i++) {
        h += '<div style="border-bottom:1px solid #eee;padding:6px 0"><b>' + esc(hits[i].item.title) + '</b>'
          + '<span style="color:#999;margin-left:6px">score ' + hits[i].score.toFixed(2) + '</span><br>'
          + '<span style="color:#333">' + esc(snippet(hits[i].item.text, q)) + '</span></div>';
      }
      out.innerHTML = h + '<div style="margin-top:8px"><button id="kbSrcAsm" style="padding:6px 12px;background:#1677ff;color:#fff;border:0;border-radius:6px">把命中片段交给 AI 生成</button></div>';
      $("kbSrcAsm").onclick = function () {
        var ctx = [];
        for (var i = 0; i < hits.length && i < 4; i++) ctx.push("【" + hits[i].item.title + "】\n" + hits[i].item.text.slice(0, 600));
        var askAI = (global.AIModule && typeof global.AIModule.ask === "function") ? global.AIModule : null;
        if (!askAI) { toast("AI 模块未就绪"); return; }
        askAI.ask([{ role: "system", content: "你是水利工程/古建/感知领域的资深材料起草人。只依据给定的【素材】回答，不要编造；缺失处标【待补充】。" },
        { role: "user", content: "素材：\n" + ctx.join("\n\n") + "\n\n问题：" + q + "\n\n请给出结构化答案。" }])
          .then(function (txt) { close(); toast("已生成"); })
          .catch(function (e) { close(); toast("生成失败：" + e); });
      };
    }
    $("kbSrcQ").oninput = run; run();
  }

  function openManage() {
    var items = ls(KEY_ITEMS, []);
    var h = '<div style="line-height:1.9">素材总量：<b>' + items.length + '</b> 条，'
      + '约 <b>' + items.reduce(function (a, b) { return a + (b.text || "").length; }, 0) + '</b> 字'
      + '<br>全部存本机 localStorage，不上传任何服务器（离线可用）。</div>';
    if (items.length) {
      h += '<div style="max-height:220px;overflow:auto;border:1px solid #eee;margin-top:8px;padding:6px">';
      for (var i = 0; i < items.length; i++) {
        h += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px dotted #eee">'
          + '<span style="flex:1">' + esc(items[i].title) + '</span>'
          + '<span style="color:#999">' + items[i].cat + '</span>'
          + '<span data-exp="' + items[i].id + '" style="color:#1677ff;cursor:pointer">导出</span>'
          + '<span data-del="' + items[i].id + '" style="color:#c00;cursor:pointer">删除</span></div>';
      }
      h += '</div>';
    }
    h += '<div style="margin-top:10px;display:flex;gap:8px">'
      + '<button id="kbSrcExportAll" style="padding:6px 12px;background:#1677ff;color:#fff;border:0;border-radius:6px">全部导出 .md</button>'
      + '<button id="kbSrcReidx" style="padding:6px 12px;border:1px solid #ddd;border-radius:6px">重建索引</button>'
      + '<button id="kbSrcClear" style="padding:6px 12px;border:1px solid #ddd;border-radius:6px;color:#c00">清空素材库</button></div>';
    open("kbSrcA", "素材库管理", h);

    var box = $("kbSrcA_b");
    box.querySelectorAll("[data-del]").forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute("data-del");
        var items2 = ls(KEY_ITEMS, []);
        save(KEY_ITEMS, items2.filter(function (x) { return x.id !== id; }));
        rebuildIndex(); openManage(); toast("已删除");
      };
    });
    box.querySelectorAll("[data-exp]").forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute("data-exp");
        var items2 = ls(KEY_ITEMS, []);
        for (var i = 0; i < items2.length; i++) if (items2[i].id === id) download(items2[i].title + ".md", items2[i].text);
      };
    });
    $("kbSrcExportAll").onclick = function () {
      var items2 = ls(KEY_ITEMS, []);
      var all = items2.map(function (x) { return "# " + x.title + "\n> " + (x.cat || "") + "\n\n" + x.text; }).join("\n\n---\n\n");
      if (!all) { toast("没有素材可导出"); return; }
      download("素材库_" + new Date().toISOString().slice(0, 10) + ".md", all);
    };
    $("kbSrcReidx").onclick = function () { rebuildIndex(); toast("索引已重建"); };
    $("kbSrcClear").onclick = function () {
      if (!global.ask || !global.ask("清空素材库", "将删除本机全部已入库素材，确定？", [{ t: "取消", v: 0 }, { t: "确定清空", v: 1 }])) {
        save(KEY_ITEMS, []); save(KEY_IDX, {}); save(KEY_DF, {}); rebuildIndex(); close(); toast("已清空");
        return;
      }
      global.ask("清空素材库", "将删除本机全部已入库素材，确定？", [
        { t: "取消", v: 0 }, { t: "确定清空", cls: "btn-cancel", v: 1 }
      ]).then(function (v) { if (v == 1) { save(KEY_ITEMS, []); save(KEY_IDX, {}); save(KEY_DF, {}); rebuildIndex(); close(); toast("已清空"); } });
    };
  }
  function download(name, content) {
    try {
      var blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      toast("已导出");
    } catch (e) { toast("导出失败：" + e); }
  }

  /* ---------------- 注册（kb_core.js 的 getMenuGroups 会自动 concat） ---------------- */
  global.KBSourceUI = { open: open, close: close };
  global.KBV = global.KBV || {};
  global.KBV.getMenuItems = function () {
    return [
      { k: "kbSrcIn", ico: "📥", t: "多源素材入库", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) { } openIngest(); } },
      { k: "kbSrcAsk", ico: "🔍", t: "素材库检索 · 问答", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) { } openSearch(); } },
      { k: "kbSrcGen", ico: "📝", t: "基于素材生成文稿", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) { } openSearch(); } },
      { k: "kbSrcMgr", ico: "🗂", t: "素材库管理（导出 / 清空）", f: function () { try { global.closeSheet("sheetMenu"); } catch (e) { } openManage(); } }
    ];
  };
})(window);
