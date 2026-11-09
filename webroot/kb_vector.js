/* ===== kb_vector.js — 本地向量智能化内核（离线可用，无外部依赖）=====
 * 覆盖：
 *   ① 参数反查条目名称（自然语言 → 一个或多个条目）
 *   ② 条目统计与分类汇总（按类型 / 管理单位 Count·Group By）
 *   ③ 预案·规程文档切片向量化 + 与条目智能关联（按名称命中建立元数据）
 *   ④ 查询结果生成「小作文」并可导出 doc / docx，支持预览与打印（打印可另存 PDF）
 *   ⑤ PDF → Word 小工具（PDF 文本流解析，尽量保留段落与顺序；扫描件走 OCR 兜底）
 *   ⑥ 条目类型「定义·含义·作用」向量化写入本地知识库
 * 数据：window.SHUILI_DATA / PERCEPTION_DATA / GUJIAN_DATA（亦兼容 BUILDINGS/HERITAGE）
 * 依赖：jszip.min.js（导出 docx）；可选 ai_module.js（生成文案润色）
 */
(function (global) {
  "use strict";

  var APP = global.KBV_APP || "shuili";
  var CFG = {
    shuili: { label: "建筑物", data: ["SHUILI_DATA", "BUILDINGS"], ls: "kbv_shuili" },
    perc:   { label: "感知设备", data: ["PERCEPTION_DATA", "BUILDINGS"], ls: "kbv_perc" },
    gujian: { label: "景点", data: ["GUJIAN_DATA", "HERITAGE"], ls: "kbv_gujian" }
  }[APP] || { label: "条目", data: ["SHUILI_DATA"], ls: "kbv_app" };

  var DIM = 256;                 // 向量维度（哈希降维，离线轻量）
  var K_IDX = CFG.ls + "_idx";   // 条目光向量索引
  var K_DOC = CFG.ls + "_docs";  // 文档切片库
  var K_TYPE = CFG.ls + "_types";// 类型知识库

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(m) { try { if (global.toast) global.toast(m); } catch (e) {} }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function openGen(title, html) {
    var gt = $("genTitle"), gb = $("genBody");
    if (!gt || !gb) { toast("界面未就绪"); return; }
    gt.textContent = title; gb.innerHTML = html;
    if (global.openSheet) global.openSheet("sheetGen");
  }
  function closeMenu() { try { global.closeSheet("sheetMenu"); } catch (e) {} }

  /* ---------------- 数据 ---------------- */
  function items() {
    for (var i = 0; i < CFG.data.length; i++) {
      var a = global[CFG.data[i]];
      if (a && a.length) return a;
    }
    try { if (global.BUILDINGS && global.BUILDINGS.length) return global.BUILDINGS; } catch (e) {}
    return [];
  }
  function itemName(b) { return String((b && (b.name || b.title)) || "").trim(); }
  function itemType(b) { return String((b && (b.btype || b.type || b.category)) || "").trim(); }
  function itemOffice(b) { return String((b && (b.office || b.org || b.management)) || "").trim(); }
  function attrsOf(b) { return (b && b.attrs) || []; }
  function attrText(b) {
    var a = attrsOf(b), out = [];
    for (var i = 0; i < a.length; i++) if (a[i] && a[i][0]) out.push(a[i][0] + "：" + (a[i][1] || ""));
    return out.join("；");
  }
  function fullText(b) {
    return [itemName(b), itemType(b), itemOffice(b), (b && b.station) || "", attrText(b),
            (b && (b.intro || b.remark)) || ""].join(" ");
  }

  /* ---------------- 向量化（哈希 TF-IDF，字符二元组 + 单字 + 英文数字词） ---------------- */
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }
  function tokens(s) {
    s = String(s == null ? "" : s).toLowerCase();
    var out = [], i;
    var latin = s.match(/[a-z0-9][a-z0-9.\-+]*/g) || [];
    for (i = 0; i < latin.length; i++) if (latin[i].length > 1 || /\d/.test(latin[i])) out.push(latin[i]);
    var runs = s.match(/[\u4e00-\u9fa5]+/g) || [];
    for (i = 0; i < runs.length; i++) {
      var r = runs[i], j;
      for (j = 0; j < r.length; j++) {
        out.push(r.charAt(j));
        if (j + 1 < r.length) out.push(r.substr(j, 2));
      }
    }
    return out;
  }
  function vecOf(text) {
    var v = new Array(DIM), i;
    for (i = 0; i < DIM; i++) v[i] = 0;
    var tk = tokens(text);
    for (i = 0; i < tk.length; i++) {
      var h = hash(tk[i]);
      var idx = h % DIM, sign = ((h >>> 8) & 1) ? 1 : -1;
      v[idx] += sign;
    }
    var norm = 0;
    for (i = 0; i < DIM; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (i = 0; i < DIM; i++) v[i] = v[i] / norm;
    return v;
  }
  function cos(a, b) {
    var s = 0;
    for (var i = 0; i < DIM; i++) s += (a[i] || 0) * (b[i] || 0);
    return s;
  }

  /* ---------------- 条目光索引 ---------------- */
  var _idx = null;
  function sigOf(list) {
    var s = 0, n = list.length;
    for (var i = 0; i < n; i++) s = (s * 31 + hash(itemName(list[i]) + "|" + itemType(list[i]))) >>> 0;
    return n + ":" + s;
  }
  function buildIndex(force) {
    var list = items();
    var sig = sigOf(list);
    if (!force && _idx && _idx.sig === sig) return _idx;
    var cached = (!force) ? lsGet(K_IDX, null) : null;
    if (cached && cached.sig === sig && cached.items && cached.items.length === list.length) {
      _idx = cached; return _idx;
    }
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var ft = fullText(b);
      arr.push({
        i: i, name: itemName(b), type: itemType(b), office: itemOffice(b),
        attrs: attrsOf(b).map(function (a) { return [a[0], a[1]]; }),
        text: ft, vec: vecOf(ft)
      });
    }
    _idx = { sig: sig, items: arr, ts: Date.now() };
    try { lsSet(K_IDX, _idx); } catch (e) {}
    return _idx;
  }
  function ensure() { return buildIndex(false); }

  function topk(qvec, pool, k, filter) {
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      if (filter && !filter(pool[i])) continue;
      var sc = cos(qvec, pool[i].vec);
      if (sc > 0.02) out.push({ ref: pool[i], score: sc });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, k || 8);
  }

  /* ① 参数/自然语言 → 条目名称（反查） */
  function _normOp(op) {
    if (/^(大于|超过|高于|>=|≥|>)$/.test(op)) return ">";
    if (/^(小于|低于|<=|≤|<)$/.test(op)) return "<";
    return "=";
  }
  function scoreItem(qv, qn, qnums, it) {
    var base = cos(qv, it.vec), best = null, bs = -1, extra = 0;
    var condMatched = 0, condSat = 0;
    for (var i = 0; i < it.attrs.length; i++) {
      var av = String(it.attrs[i][1] == null ? "" : it.attrs[i][1]);
      var s = cos(qv, vecOf(it.attrs[i][0] + "：" + av));
      if (it.attrs[i][0] && qn.indexOf(it.attrs[i][0]) >= 0) s += 0.20;
      if (av && av.length < 24 && qn.indexOf(av) >= 0) s += 0.45;
      for (var n = 0; n < qnums.length; n++) if (av.indexOf(qnums[n]) >= 0) s += 0.16;
      if (s > bs) { bs = s; best = it.attrs[i]; }
      // D-2：属性结构化条件（数值等值/范围）融合——查询含「dim op 数」时校验本项属性
      var dim = it.attrs[i][0];
      if (dim) {
        var m = qn.match(new RegExp(dim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(大于|超过|高于|小于|低于|等于|为|是|>=|<=|≥|≤|>|<|=)\\s*(\\d+(?:\\.\\d+)?)"));
        if (m) {
          condMatched++;
          var op = _normOp(m[1]), qv2 = parseFloat(m[2]), avn = parseFloat(av);
          var ok = false;
          if (op === ">") ok = (!isNaN(avn) && avn > qv2);
          else if (op === "<") ok = (!isNaN(avn) && avn < qv2);
          else ok = (String(av) === m[2] || (!isNaN(avn) && avn === qv2));
          if (ok) condSat++;
        }
      }
    }
    if (it.name && qn.indexOf(it.name) >= 0) extra += 0.55;
    if (it.type && qn.indexOf(it.type) >= 0) extra += 0.30;
    if (it.office && qn.indexOf(it.office) >= 0) extra += 0.15;
    var hit = (bs > 0 ? bs : 0);
    var total = base * 0.55 + hit * 0.45 + extra;
    // D-2：满足全部提及的属性条件时，把结构化分数融合进向量召回（不满足则零影响，向后兼容）
    if (condMatched > 0 && condSat > 0) {
      var attrScore = condSat / condMatched;
      total = Math.min(0.99, total + 0.6 * attrScore + (condSat === condMatched ? 0.1 : 0));
    }
    return { it: it, score: Math.min(0.99, total), best: best };
  }
  function reverseSearch(q, k) {
    var idx = ensure();
    if (!idx.items.length) return [];
    var qv = vecOf(q), qn = String(q || ""), qnums = qn.match(/\d+(\.\d+)?/g) || [];
    var scored = idx.items.map(function (it) { return scoreItem(qv, qn, qnums, it); });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, k || 10).filter(function (x) { return x.score > 0.05; }).map(function (x) {
      var it = x.it;
      return {
        name: it.name, type: it.type, office: it.office,
        score: Math.round(x.score * 100) / 100,
        bestParam: x.best ? (x.best[0] + "：" + (x.best[1] || "")) : "",
        attrs: it.attrs
      };
    });
  }

  /* ② 统计与分类汇总 */
  function stats() {
    var list = items(), byType = {}, byOffice = {}, byTypeOffice = {};
    for (var i = 0; i < list.length; i++) {
      var t = itemType(list[i]) || "未分类", o = itemOffice(list[i]) || "未设置";
      byType[t] = (byType[t] || 0) + 1;
      byOffice[o] = (byOffice[o] || 0) + 1;
      var key = t + "@@" + o;
      byTypeOffice[key] = (byTypeOffice[key] || 0) + 1;
    }
    function sortObj(obj) {
      return Object.keys(obj).map(function (k) { return { key: k, n: obj[k] }; })
        .sort(function (a, b) { return b.n - a.n; });
    }
    return { total: list.length, byType: sortObj(byType), byOffice: sortObj(byOffice), byTypeOffice: byTypeOffice };
  }
  // 自然语言统计：「多少个闸门」「进水闸 节制闸 各多少」
  function answerStats(q) {
    var st = stats(), q2 = String(q || "");
    var types = st.byType.map(function (x) { return x.key; });
    var hit = [];
    // 精确包含
    types.forEach(function (t) { if (t && q2.indexOf(t) >= 0) hit.push(t); });
    // 关键词（去掉“闸”等后缀后包含）
    if (!hit.length) {
      types.forEach(function (t) {
        if (!t) return;
        var core = t.replace(/(闸|桥|涵|洞|站|所|渠|槽|机|器|点|建筑|设施|设备)$/, "");
        if (core && q2.indexOf(core) >= 0) hit.push(t);
      });
    }
    // 泛化：含“闸门”→ 所有 xx闸
    if (!hit.length && /闸门/.test(q2)) {
      hit = types.filter(function (t) { return /闸$/.test(t); });
    }
    var lines = [];
    if (hit.length) {
      var sum = 0;
      hit.forEach(function (t) {
        var n = (st.byType.filter(function (x) { return x.key === t; })[0] || {}).n || 0;
        sum += n; lines.push(t + "：" + n + " 个");
      });
      if (hit.length > 1) lines.push("合计：" + sum + " 个");
      // 按下属单位拆分（前 3 个类型）
      hit.slice(0, 3).forEach(function (t) {
        var parts = [];
        st.byOffice.forEach(function (o) {
          var n = st.byTypeOffice[t + "@@" + o.key] || 0;
          if (n) parts.push(o.key + " " + n);
        });
        if (parts.length > 1) lines.push("　└ " + t + " 分布：" + parts.slice(0, 10).join("、"));
      });
    } else {
      lines.push("当前共收录 " + CFG.label + " " + st.total + " 个。");
      lines.push("按类型 TOP10：" + st.byType.slice(0, 10).map(function (x) { return x.key + " " + x.n; }).join("、"));
    }
    return { text: lines.join("\n"), stats: st, hitTypes: hit };
  }

  /* ③ 文档切片 + 向量化 + 与条目关联 */
  function chunkText(text, size, overlap) {
    text = String(text || "").replace(/\r/g, "");
    size = size || 420; overlap = overlap || 60;
    var paras = text.split(/\n{1,}/).filter(function (p) { return p && p.trim(); });
    var out = [], buf = "";
    function flush() {
      if (!buf.trim()) return;
      out.push(buf.trim());
      buf = buf.length > overlap ? buf.slice(-overlap) : "";
    }
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i].trim();
      if (!p) continue;
      if ((buf + p).length > size && buf) { flush(); }
      if (p.length > size * 1.6) {
        // 超长段落按句切（不用 lookbehind，兼容老 WebView）
        var sents = p.match(/[^。！？；\n]+[。！？；]?/g) || [p];
        for (var j = 0; j < sents.length; j++) {
          if ((buf + sents[j]).length > size && buf) flush();
          buf += sents[j];
        }
      } else buf += (buf ? "\n" : "") + p;
    }
    flush();
    return out.filter(function (c) { return c && c.length > 8; });
  }
  function linkNames(text) {
    var idx = ensure(), links = [], names = idx.items.map(function (x) { return x.name; });
    for (var i = 0; i < names.length; i++) {
      if (names[i] && names[i].length > 1 && text.indexOf(names[i]) >= 0) links.push(names[i]);
      if (links.length > 12) break;
    }
    return links;
  }
  function addDoc(name, text, kind) {
    var chunks = chunkText(text);
    var docs = lsGet(K_DOC, []);
    // 同名覆盖
    docs = docs.filter(function (d) { return d.name !== name; });
    var rec = {
      name: name, kind: kind || "文档", ts: Date.now(), size: String(text || "").length,
      chunks: chunks.map(function (c, i) {
        return { i: i, text: c, links: linkNames(c), vec: vecOf(c) };
      })
    };
    docs.push(rec);
    lsSet(K_DOC, docs);
    return rec;
  }
  function docList() { return lsGet(K_DOC, []); }
  function searchDocs(q, k, nameFilter) {
    var docs = docList(), qv = vecOf(q), out = [];
    docs.forEach(function (d) {
      d.chunks.forEach(function (c) {
        if (nameFilter && (c.links || []).indexOf(nameFilter) < 0 && d.name.indexOf(nameFilter) < 0) return;
        var sc = cos(qv, c.vec);
        if (sc > 0.02) out.push({ doc: d.name, i: c.i, text: c.text, links: c.links, score: sc });
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, k || 6);
  }
  function docsOfBuilding(name) {
    var out = [];
    docList().forEach(function (d) {
      d.chunks.forEach(function (c) {
        if ((c.links || []).indexOf(name) >= 0) out.push({ doc: d.name, text: c.text, i: c.i });
      });
    });
    return out;
  }

  /* ⑥ 类型定义知识库 */
  var TYPE_DICT = {
    shuili: [
      ["进水闸", "设在渠道首部，用于控制入渠流量、拦沙与检修断流的关键控制性建筑物。"],
      ["节制闸", "建于渠道沿线，用以分段控制水位与流量，保证上游供水并便于分段检修。"],
      ["泄洪闸", "用于宣泄洪水、控制库渠水位，保障工程安全的泄水建筑物。"],
      ["分水闸", "把干渠水量分配到支渠或用水单位的配水建筑物。"],
      ["排水闸", "排除渠内多余水量或区间涝水，兼有挡洪与排水双重功能。"],
      ["退水闸", "在事故或检修时快速泄空渠段水量，保证工程与下游安全。"],
      ["倒虹吸", "渠道与道路、河谷交叉时，以压力管道自下穿越的交叉建筑物。"],
      ["渡槽", "渠道跨越沟谷或道路的架空输水建筑物，形似桥梁而用于输水。"],
      ["跌水", "渠道落差集中处的消能建筑物，用跌差消除水流多余能量。"],
      ["陡坡", "以陡槽代替跌水的落差集中消能建筑物，适用于较大落差。"],
      ["交通桥", "跨越渠道供车辆行人通行的桥梁建筑物。"],
      ["涵洞", "渠道与道路、山洪沟交叉时的封闭式过水或通行建筑物。"],
      ["隧洞", "山岭或地下穿越的输水洞室建筑物。"],
      ["泵站", "以水泵机组提水的建筑物，含进出水池、厂房与机电设备。"],
      ["清污机", "清除拦污栅前漂浮物与污物的机械设备。"],
      ["量水堰", "用于精确量测渠道流量的标准量水建筑物。"],
      ["山洪桥", "排泄山洪、保护渠道安全的交叉排洪建筑物。"],
      ["变压器", "为泵站、闸门启闭等设施供电的变配电设备。"]
    ],
    perc: [
      ["视频监控", "通过摄像机采集现场图像并回传，用于远程巡视与安全防范的感知设备。"],
      ["雨量站", "采集降雨量的感知设备，为洪水预报与调度提供基础数据。"],
      ["水位站", "采集河道、渠道、库塘水位的感知设备。"],
      ["流量监测", "采集流速与流量数据的感知设备，用于水量调度与计量。"],
      ["大坝安全监测", "监测坝体位移、渗流、渗压等安全指标的感知设备。"],
      ["地下水源监测", "监测地下水水位、水质与开采量的感知设备。"],
      ["水质监测", "采集水体理化指标（浊度、溶解氧等）的感知设备。"],
      ["闸门监控", "采集闸门开度、启闭状态并支持远程控制的感知设备。"]
    ],
    gujian: [
      ["寺庙", "宗教祭祀与信仰活动的建筑群，体现古代礼制与木构技艺。"],
      ["塔", "多层高耸的纪念性或宗教性建筑，常用于藏经、观景与风水。"],
      ["宫殿", "帝王理政与居住的高等级建筑群，代表古代营造制度的最高水平。"],
      ["城墙", "城市防御体系主体，含墙体、城门、瓮城与马面等设施。"],
      ["桥梁", "跨越障碍的交通建筑，含石拱桥、廊桥、梁桥等类型。"],
      ["民居", "传统聚落中的居住建筑，反映地域材料、气候与宗族文化。"],
      ["石窟", "依山开凿的佛教石窟寺，集建筑、雕塑、壁画于一体。"],
      ["陵墓", "帝王或名人墓葬及其地面建筑，体现丧葬制度与营建技艺。"],
      ["园林", "人工山水与建筑结合的游赏空间，讲究借景与意境。"],
      ["楼阁", "多层木构景观或藏书建筑，常用于观景、藏典与防御。"]
    ]
  };
  function seedTypes() {
    var dict = TYPE_DICT[APP] || TYPE_DICT.shuili;
    var rec = { ts: Date.now(), items: dict.map(function (d) {
      return { name: d[0], def: d[1], vec: vecOf(d[0] + "：" + d[1]) };
    }) };
    lsSet(K_TYPE, rec);
    return rec;
  }
  function typeKb() {
    var t = lsGet(K_TYPE, null);
    if (!t || !t.items || !t.items.length) t = seedTypes();
    return t;
  }
  function searchTypes(q, k) {
    var t = typeKb(), qv = vecOf(q), out = [];
    t.items.forEach(function (it) {
      var sc = cos(qv, it.vec);
      var bonus = (q.indexOf(it.name) >= 0) ? 0.35 : 0;
      if (sc + bonus > 0.05) out.push({ name: it.name, def: it.def, score: sc + bonus });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, k || 5);
  }

  /* ④ 生成「小作文」报告（结构化文本 + HTML） */
  function composeReport(q) {
    var rev = reverseSearch(q, 5);
    var st = answerStats(q);
    var dchunks = searchDocs(q, 4);
    var tks = searchTypes(q, 3);
    var lines = [];
    var title = String(q || "查询结果").trim() + "（智能检索报告）";
    lines.push("# " + title);
    lines.push("");
    lines.push("## 一、检索概述");
    lines.push("本次以「" + q + "」为检索意图，对本地 " + CFG.label + " 参数库、类型知识库与已入库文档进行向量检索。");
    lines.push("共收录 " + CFG.label + " " + st.stats.total + " 个，其中语义最相关的前 " + rev.length + " 个如下。");
    lines.push("");
    lines.push("## 二、相关" + CFG.label);
    if (!rev.length) lines.push("未检索到相关条目，请更换关键词或先导入数据。");
    rev.forEach(function (r, i) {
      lines.push("### " + (i + 1) + ". " + r.name + (r.type ? "（" + r.type + "）" : "") + "　相关度 " + Math.round(r.score * 100) + "%");
      if (r.office) lines.push("- 管理单位：" + r.office);
      if (r.bestParam) lines.push("- 关键参数：" + r.bestParam);
      if (r.attrs && r.attrs.length) {
        lines.push("- 参数明细：" + r.attrs.slice(0, 12).map(function (a) { return a[0] + "：" + (a[1] || ""); }).join("；"));
      }
      var rel = docsOfBuilding(r.name);
      if (rel.length) {
        lines.push("- 关联预案/规程：" + rel.slice(0, 3).map(function (c) { return "《" + c.doc + "》— " + c.text.slice(0, 80) + "…"; }).join("　"));
      }
      lines.push("");
    });
    lines.push("## 三、数量统计");
    st.text.split("\n").forEach(function (l) { lines.push("- " + l); });
    lines.push("");
    if (tks.length) {
      lines.push("## 四、类型释义");
      tks.forEach(function (t) { lines.push("- **" + t.name + "**：" + t.def); });
      lines.push("");
    }
    if (dchunks.length) {
      lines.push("## 五、相关文档片段");
      dchunks.forEach(function (c, i) {
        lines.push("[" + (i + 1) + "] 《" + c.doc + "》　相关度 " + Math.round(c.score * 100) + "%");
        lines.push("　　" + c.text.slice(0, 200));
      });
      lines.push("");
    }
    lines.push("## 六、结论与建议");
    lines.push("以上结果由本地向量检索生成，用于辅助查询与核对；涉及调度、抢险的结论请以正式预案与现场实测为准。");
    lines.push("");
    lines.push("生成时间：" + new Date().toLocaleString("zh-CN"));
    var text = lines.join("\n");
    return { title: title, text: text, html: textToHtml(lines) };
  }
  function textToHtml(lines) {
    var out = [];
    lines.forEach(function (l) {
      if (/^# /.test(l)) out.push("<h2>" + esc(l.slice(2)) + "</h2>");
      else if (/^## /.test(l)) out.push("<h3>" + esc(l.slice(3)) + "</h3>");
      else if (/^### /.test(l)) out.push("<h4>" + esc(l.slice(4)) + "</h4>");
      else if (/^- /.test(l)) out.push("<p style='margin:4px 0'>" + inlineMd(l.slice(2)) + "</p>");
      else if (/^\[/.test(l)) out.push("<p style='margin:4px 0;color:#555'>" + esc(l) + "</p>");
      else if (!l.trim()) out.push("<div style='height:6px'></div>");
      else out.push("<p style='margin:4px 0'>" + inlineMd(l) + "</p>");
    });
    return out.join("");
  }
  function inlineMd(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  }

  /* ---------- 导出：doc（HTML 版 Word）/ docx（OOXML）/ 预览打印（可另存 PDF） ---------- */
  function download(blob, name) {
    try {
      if (global.Android && typeof global.Android.saveBlob === "function") {
        var fr = new FileReader();
        fr.onload = function () { global.Android.saveBlob(fr.result, name); };
        fr.readAsDataURL(blob);
        toast("已导出到 Download 目录：" + name);
        return;
      }
    } catch (e) {}
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(a.href); } catch (e) {} }, 2000);
    toast("已导出：" + name);
  }
  function exportDoc(name, html) {
    var body = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'>" +
      "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->" +
      "<style>body{font-family:'Microsoft YaHei','PingFang SC',serif;font-size:14px;line-height:1.7}h2{font-size:20px}h3{font-size:16px}h4{font-size:14px}</style></head><body>" +
      html + "</body></html>";
    download(new Blob(["\ufeff" + body], { type: "application/msword" }), name.replace(/\.(doc|docx)$/i, "") + ".doc");
  }
  function exportDocx(name, lines) {
    // 极简 OOXML：标题/正文分级，中文可用
    var paras = (lines || []).map(function (l) {
      var t = esc(String(l));
      var style = "";
      if (/^# /.test(l)) { t = esc(l.slice(2)); style = "<w:pStyle w:val=\"Heading1\"/>"; }
      else if (/^## /.test(l)) { t = esc(l.slice(3)); style = "<w:pStyle w:val=\"Heading2\"/>"; }
      else if (/^### /.test(l)) { t = esc(l.slice(4)); style = "<w:pStyle w:val=\"Heading3\"/>"; }
      else if (/^- /.test(l)) { t = esc(l.slice(2)); }
      if (!t) return "<w:p/>";
      return "<w:p>" + style + "<w:r><w:t xml:space=\"preserve\">" + t + "</w:t></w:r></w:p>";
    }).join("");
    var docXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
      "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>" + paras +
      "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/></w:sectPr></w:body></w:document>";
    var ct = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
      "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
      "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
      "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
      "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>";
    var rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
      "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
      "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    var styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
      "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">" +
      "<w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:pPr><w:outlineLvl w:val=\"0\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"36\"/></w:rPr></w:style>" +
      "<w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"heading 2\"/><w:pPr><w:outlineLvl w:val=\"1\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"30\"/></w:rPr></w:style>" +
      "<w:style w:type=\"paragraph\" w:styleId=\"Heading3\"><w:name w:val=\"heading 3\"/><w:pPr><w:outlineLvl w:val=\"2\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"26\"/></w:rPr></w:style></w:styles>";
    var fn = name.replace(/\.(doc|docx)$/i, "") + ".docx";
    try {
      if (!global.JSZip) throw new Error("JSZip 未加载");
      var zip = new global.JSZip();
      zip.file("[Content_Types].xml", ct);
      zip.file("_rels/.rels", rels);
      zip.file("word/document.xml", docXml);
      zip.file("word/styles.xml", styles);
      zip.generateAsync({ type: "blob" }).then(function (b) { download(b, fn); });
    } catch (e) {
      toast("docx 导出失败，已改用 .doc：" + e.message);
      exportDoc(name, textToHtml(lines || []));
    }
  }
  function previewPrint(title, html) {
    var w = window.open("", "_blank");
    if (!w) { toast("请允许弹窗后重试（预览需要新窗口）"); return; }
    w.document.write("<html><head><meta charset='utf-8'><title>" + esc(title) + "</title>" +
      "<style>body{font-family:'Microsoft YaHei','PingFang SC',serif;padding:24px;line-height:1.75;max-width:820px;margin:0 auto}h2{font-size:22px}h3{font-size:17px;border-left:4px solid #1a6fc4;padding-left:8px}h4{font-size:15px}@media print{.noprint{display:none}}</style></head><body>" +
      "<div class='noprint' style='margin-bottom:16px'><button onclick='window.print()' style='padding:8px 16px'>🖨 打印 / 另存为 PDF</button> " +
      "<button onclick='window.close()' style='padding:8px 16px'>关闭</button></div>" + html + "</body></html>");
    w.document.close();
  }

  /* ⑤ PDF → Word（纯前端：解析 PDF 内容流文本；扫描件走 OCR 兜底） */
  function inflateRaw(bytes) {
    // 优先 DecompressionStream（zlib）
    try {
      if (typeof DecompressionStream === "function") {
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
      }
    } catch (e) {}
    return Promise.reject(new Error("当前环境不支持 PDF 流解压"));
  }
  function extractPdfText(buf) {
    var u8 = new Uint8Array(buf);
    var latin = "";
    for (var i = 0; i < u8.length; i++) latin += String.fromCharCode(u8[i]);
    var streamRe = /stream\r?\n?/g, m, tasks = [];
    while ((m = streamRe.exec(latin))) {
      var start = m.index + m[0].length;
      var end = latin.indexOf("endstream", start);
      if (end < 0) break;
      var isFlate = /\/FlateDecode/.test(latin.slice(Math.max(0, m.index - 400), m.index));
      var raw = latin.slice(start, end);
      tasks.push({ raw: raw, flate: isFlate });
      streamRe.lastIndex = end;
    }
    var jobs = tasks.map(function (t) {
      if (!t.flate) {
        return Promise.resolve(t.raw);
      }
      var bytes = new Uint8Array(t.raw.length);
      for (var i = 0; i < t.raw.length; i++) bytes[i] = t.raw.charCodeAt(i) & 0xff;
      return inflateRaw(bytes).then(function (ab) {
        var a = new Uint8Array(ab), s = "";
        for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
        return s;
      }).catch(function () { return ""; });
    });
    return Promise.all(jobs).then(function (parts) {
      var text = "";
      parts.forEach(function (content) {
        if (!content || content.indexOf("BT") < 0) return;
        // 逐段解析文本算子，按 Td/TD/Tm 的 Y 坐标分组为行
        var lines = [];
        var re = /(?:\[(.*?)\]\s*TJ)|(?:\((?:\\.|[^\\()])*\)\s*Tj)|(?:TD?\s*([-\d.]+)\s*([-\d.]+))|(?:Tm\s*([-\d.]+\s+){4})|(T\*)|(ET)|(BT)/g;
        var mm, curY = null, curLine = "";
        function unesc(s) {
          return s.replace(/\\([nrtbf()\\])/g, function (_, c) {
            return { n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[c] || c;
          }).replace(/\\([0-7]{1,3})/g, function (_, o) { return String.fromCharCode(parseInt(o, 8)); });
        }
        while ((mm = re.exec(content))) {
          if (mm[5]) { if (curLine.trim()) lines.push(curLine); curLine = ""; }
          else if (mm[6]) { if (curLine.trim()) lines.push(curLine); curLine = ""; }
          else if (mm[1] != null) {
            var seg = mm[1], outp = "";
            var pr = /\((?:\\.|[^\\()])*\)|[-\d.]+/g, pm;
            while ((pm = pr.exec(seg))) {
              var tk = pm[0];
              if (tk.charAt(0) === "(") outp += unesc(tk.slice(1, -1));
            }
            curLine += outp;
          } else if (mm[0].indexOf("(") === 0) {
            curLine += unesc(mm[0].slice(1, mm[0].lastIndexOf(")")));
          }
        }
        if (curLine.trim()) lines.push(curLine);
        text += lines.filter(function (l) { return l.trim(); }).join("\n") + "\n";
      });
      return text;
    });
  }
  function pdfToDoc(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        if (onProgress) onProgress("正在解析 PDF …");
        extractPdfText(fr.result).then(function (text) {
          if (!text || text.replace(/\s/g, "").length < 20) {
            // 扫描件：尝试 OCR 兜底
            if (global.OCRModule && typeof global.OCRModule.recognize === "function") {
              if (onProgress) onProgress("未提取到文本层，尝试 OCR 识别 …");
              return global.OCRModule.recognize(file).then(function (t) { return t || ""; });
            }
            throw new Error("未提取到文本层（可能是扫描件）。请先用 OCR 文档入库，或换用带文本层的 PDF。");
          }
          return text;
        }).then(function (text) {
          if (onProgress) onProgress("正在生成 Word …");
          var lines = text.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
          var html = lines.map(function (l) { return "<p style='margin:2px 0'>" + esc(l) + "</p>"; }).join("");
          var base = String(file.name || "document").replace(/\.pdf$/i, "");
          exportDoc(base + "_转换", html);
          exportDocx(base + "_转换", lines);
          resolve({ lines: lines.length, chars: text.length });
        }).catch(reject);
      };
      fr.onerror = function () { reject(new Error("文件读取失败")); };
      fr.readAsArrayBuffer(file);
    });
  }

  /* ================= 结果点击定位（v3.77）================= */
  // 按名称在本项目全局数据中查找条目并跳转地图位置（兼容 水利/古建/感知 三种数据名）
  function locateEntity(name) {
    if (!name) return false;
    var list = items() || [];
    function norm(s) { return String(s || "").replace(/\s+/g, "").replace(/管理所/g, "所"); }
    var b = null;
    for (var i = 0; i < list.length; i++) {
      var n = itemName(list[i]);
      if (n && (n === name || norm(n) === norm(name))) { b = list[i]; break; }
    }
    if (!b) { toast("未找到「" + name + "」的地图位置"); return false; }
    var lat = b.lat != null ? b.lat : b.latitude, lon = b.lon != null ? b.lon : b.longitude;
    if (lat == null || lon == null) { toast("「" + name + "」暂无坐标，无法定位"); return false; }
    if (global.appFocusBuilding) return global.appFocusBuilding(b, name);
    if (global.appGoToMap) { global.appGoToMap(lat, lon, 16, "sheetGen"); return true; }
    if (global.map) { global.map.setView([lat, lon], 16); return true; }
    return false;
  }

  /* ================= UI ================= */
  function uiReverse() {
    openGen("① 参数反查" + CFG.label, '<div style="font-size:13px;color:#666;margin-bottom:8px">' +
      '用自然语言描述参数即可反查条目，例如：<b>宽度3米的闸门</b>、<b>两米宽的公路桥</b>、<b>设计流量70的进水闸</b>。</div>' +
      '<input class="f" id="kbvQ" placeholder="请输入参数描述 / 自然语言" style="width:100%;box-sizing:border-box">' +
      '<div class="form-actions"><button class="btn-save" id="kbvGo">检索</button>' +
      '<button class="btn-cancel" id="kbvRebuild">重建索引</button></div>' +
      '<div id="kbvOut" style="margin-top:10px"></div>');
    $("kbvGo").onclick = function () {
      var q = ($("kbvQ").value || "").trim();
      if (!q) { toast("请输入检索内容"); return; }
      var t0 = Date.now();
      var res = reverseSearch(q, 10);
      var h = '<p style="color:#666;font-size:12px">命中 ' + res.length + ' 条，用时 ' + (Date.now() - t0) + ' ms</p>';
      if (!res.length) h += '<p style="color:#c0392b">未命中，试试更简短的关键词。</p>';
      res.forEach(function (r, i) {
        h += '<div class="kbv-res" data-name="' + esc(r.name) + '" style="border:1px solid #eee;border-radius:8px;padding:8px;margin:6px 0;cursor:pointer">' +
          '<div style="font-weight:600">' + (i + 1) + '. ' + esc(r.name) +
          (r.type ? ' <span style="color:#8a939b;font-weight:400">（' + esc(r.type) + '）</span>' : '') +
          ' <span style="float:right;color:#1a6fc4">相关度 ' + Math.round(r.score * 100) + '%</span></div>' +
          (r.bestParam ? '<div style="font-size:12px;color:#555;margin-top:4px">关键参数：' + esc(r.bestParam) + '</div>' : '') +
          (r.attrs && r.attrs.length ? '<div style="font-size:12px;color:#777;margin-top:2px">' +
            esc(r.attrs.slice(0, 8).map(function (a) { return a[0] + "：" + (a[1] || ""); }).join("；")) + '</div>' : '') +
          '<div style="font-size:11px;color:#1a6fc4;margin-top:4px">📍 点击在地图定位</div>' +
          '</div>';
      });
      $("kbvOut").innerHTML = h;
      Array.prototype.slice.call($("kbvOut").querySelectorAll(".kbv-res")).forEach(function (el) {
        el.onclick = function () { locateEntity(el.getAttribute("data-name")); };
      });
    };
    $("kbvRebuild").onclick = function () { buildIndex(true); toast("索引已重建（" + ensure().items.length + " 条）"); };
  }

  function uiStats() {
    var st = stats();
    var h = '<p style="color:#666;font-size:13px">共收录 <b>' + st.total + '</b> 个' + CFG.label + '。也可以直接问：<b>有多少个闸门</b>、<b>进水闸和节制闸各多少</b>。</p>' +
      '<input class="f" id="kbvSQ" placeholder="自然语言统计，如：进水闸 节制闸 各多少个" style="width:100%;box-sizing:border-box">' +
      '<div class="form-actions"><button class="btn-save" id="kbvSGo">统计</button></div>' +
      '<div id="kbvSOut" style="margin-top:10px"></div>' +
      '<h4 style="margin:12px 0 6px">按类型</h4><div style="max-height:220px;overflow:auto;font-size:13px">' +
      st.byType.map(function (x) { return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #f2f2f2"><span>' + esc(x.key) + '</span><b>' + x.n + '</b></div>'; }).join("") +
      '</div><h4 style="margin:12px 0 6px">按管理单位</h4><div style="max-height:180px;overflow:auto;font-size:13px">' +
      st.byOffice.map(function (x) { return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #f2f2f2"><span>' + esc(x.key) + '</span><b>' + x.n + '</b></div>'; }).join("") +
      '</div>';
    openGen("② 统计汇总", h);
    $("kbvSGo").onclick = function () {
      var q = ($("kbvSQ").value || "").trim();
      var r = answerStats(q || "");
      $("kbvSOut").innerHTML = '<div style="background:#f7f9fb;border-radius:8px;padding:10px;white-space:pre-wrap;font-size:13px">' + esc(r.text) + "</div>";
    };
  }

  function uiDocs() {
    var docs = docList();
    var h = '<p style="font-size:13px;color:#666">导入防汛调度预案、闸门安装规程等文档（.txt/.md/.csv/.html 直接读取；.docx/.pdf 建议先用「外部文档入库」转文本）。' +
      '系统自动切片、向量化，并按' + CFG.label + '名称建立关联。</p>' +
      '<input type="file" id="kbvDoc" accept=".txt,.md,.csv,.json,.html,.htm" style="width:100%">' +
      '<div class="form-actions"><button class="btn-save" id="kbvDocAdd">导入并切片入库</button></div>' +
      '<div id="kbvDocOut" style="margin-top:8px"></div>' +
      '<h4 style="margin:12px 0 6px">已入库文档（' + docs.length + '）</h4>' +
      '<div style="max-height:200px;overflow:auto;font-size:13px">' +
      (docs.length ? docs.map(function (d, i) {
        return '<div style="padding:4px 0;border-bottom:1px solid #f2f2f2">' + esc(d.name) + ' · ' + d.chunks.length + ' 片 · ' +
          '<span style="color:#c0392b;cursor:pointer" data-del="' + i + '">删除</span></div>';
      }).join("") : '<div style="color:#999">暂无</div>') + '</div>' +
      '<input class="f" id="kbvDocQ" placeholder="检索预案内容，如：闸门启闭 调度 要求" style="width:100%;box-sizing:border-box;margin-top:8px">' +
      '<div class="form-actions"><button class="btn-save" id="kbvDocGo">检索文档</button></div>' +
      '<div id="kbvDocRes" style="margin-top:8px"></div>';
    openGen("③ 预案 / 规程文档入库与关联", h);
    $("kbvDocAdd").onclick = function () {
      var f = $("kbvDoc").files && $("kbvDoc").files[0];
      if (!f) { toast("请选择文件"); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var rec = addDoc(f.name, decodeBytesAuto(new Uint8Array(fr.result)), "预案/规程");
        $("kbvDocOut").innerHTML = '<span style="color:#2b8a5d">已入库：' + esc(rec.name) + '，切片 ' + rec.chunks.length + ' 片，关联 ' + CFG.label + ' ' +
          rec.chunks.reduce(function (a, c) { return a + (c.links ? c.links.length : 0); }, 0) + ' 次</span>';
        toast("入库完成");
      };
      fr.readAsArrayBuffer(f);
    };
    $("kbvDocGo").onclick = function () {
      var q = ($("kbvDocQ").value || "").trim();
      if (!q) { toast("请输入检索词"); return; }
      var res = searchDocs(q, 8);
      $("kbvDocRes").innerHTML = res.length ? res.map(function (c, i) {
        var _lnk = (c.links && c.links.length) ? c.links[0] : "";
        return '<div class="kbv-res" data-name="' + esc(_lnk) + '" style="border:1px solid #eee;border-radius:8px;padding:8px;margin:6px 0;font-size:13px' + (_lnk ? ';cursor:pointer' : '') + '">' +
          '<div style="color:#1a6fc4">[' + (i + 1) + '] 《' + esc(c.doc) + '》 相关度 ' + Math.round(c.score * 100) + '%' +
          (c.links && c.links.length ? ' · 关联：' + esc(c.links.slice(0, 3).join("、")) : '') + '</div>' +
          '<div style="color:#555;margin-top:4px">' + esc(c.text.slice(0, 220)) + '…</div>' +
          (_lnk ? '<div style="font-size:11px;color:#1a6fc4;margin-top:4px">📍 点击在地图定位：' + esc(_lnk) + '</div>' : '') +
          '</div>';
      }).join("") : '<div style="color:#999">未命中</div>';
      if (res.length) Array.prototype.slice.call($("kbvDocRes").querySelectorAll(".kbv-res[data-name]")).forEach(function (el) {
        var _n = el.getAttribute("data-name"); if (!_n) return;
        el.onclick = function () { locateEntity(_n); };
      });
    };
    var box = $("genBody");
    Array.prototype.slice.call(box.querySelectorAll("[data-del]")).forEach(function (el) {
      el.onclick = function () {
        var i = +el.getAttribute("data-del"), d = docList();
        d.splice(i, 1); lsSet(K_DOC, d); toast("已删除"); uiDocs();
      };
    });
  }

  function uiReport() {
    openGen("④ 生成报告（doc / docx · 预览打印）",
      '<p style="font-size:13px;color:#666">输入问题后自动生成结构化报告（概述 / 相关' + CFG.label + ' / 统计 / 类型释义 / 文档片段 / 结论），可导出 Word 或预览打印（打印时可另存 PDF）。</p>' +
      '<input class="f" id="kbvRQ" placeholder="如：进水闸的设计流量与闸门规格情况" style="width:100%;box-sizing:border-box">' +
      '<div class="form-actions"><button class="btn-save" id="kbvRGo">生成</button></div>' +
      '<div id="kbvROut" style="margin-top:10px"></div>');
    var last = null;
    $("kbvRGo").onclick = function () {
      var q = ($("kbvRQ").value || "").trim();
      if (!q) { toast("请输入问题"); return; }
      var rep = composeReport(q); last = rep;
      $("kbvROut").innerHTML = '<div style="max-height:46vh;overflow:auto;border:1px solid #eee;border-radius:8px;padding:10px">' + rep.html + '</div>' +
        '<div class="form-actions"><button class="btn-save" id="kbvRD">导出 Word(.doc)</button>' +
        '<button class="btn-save" id="kbvRX">导出 Word(.docx)</button>' +
        '<button class="btn-cancel" id="kbvRP">预览 / 打印</button>' +
        '<button class="btn-cancel" id="kbvRC">复制全文</button></div>';
      // v3.77：报告「相关X」条目点击定位（解析 h4 标题中的建筑物名称）
      try {
        var _rbox = $("kbvROut");
        Array.prototype.slice.call(_rbox.querySelectorAll("h4")).forEach(function (h4) {
          var _m = h4.textContent.match(/^\d+\.\s*(.+?)\s*[（(]/);
          var _nm = _m ? _m[1].trim() : null;
          if (!_nm) return;
          h4.style.cursor = "pointer"; h4.style.color = "#1a6fc4"; h4.title = "点击在地图定位：" + _nm;
          h4.onclick = function () { locateEntity(_nm); };
        });
      } catch (e) {}
      $("kbvRD").onclick = function () { exportDoc(q, rep.html); };
      $("kbvRX").onclick = function () { exportDocx(q, rep.text.split("\n")); };
      $("kbvRP").onclick = function () { previewPrint(rep.title, rep.html); };
      $("kbvRC").onclick = function () { copyText(rep.text); };
    };
  }

  function uiPdf2Doc() {
    openGen("⑤ PDF 转 Word 工具",
      '<p style="font-size:13px;color:#666">选择 PDF，自动抽取文本层并保留段落顺序，导出 <b>.doc</b> 与 <b>.docx</b>（扫描件若无文本层将提示改用 OCR 入库）。</p>' +
      '<input type="file" id="kbvPdf" accept=".pdf" style="width:100%">' +
      '<div class="form-actions"><button class="btn-save" id="kbvPdfGo">开始转换</button></div>' +
      '<div id="kbvPdfOut" style="margin-top:10px;font-size:13px"></div>');
    $("kbvPdfGo").onclick = function () {
      var f = $("kbvPdf").files && $("kbvPdf").files[0];
      if (!f) { toast("请选择 PDF 文件"); return; }
      var out = $("kbvPdfOut");
      out.innerHTML = '<span style="color:#888">处理中…</span>';
      pdfToDoc(f, function (m) { out.innerHTML = '<span style="color:#888">' + esc(m) + '</span>'; })
        .then(function (r) {
          out.innerHTML = '<span style="color:#2b8a5d">转换完成：' + r.lines + ' 段 / ' + r.chars + ' 字，已导出 .doc 与 .docx</span>';
        })
        .catch(function (e) {
          out.innerHTML = '<span style="color:#c0392b">失败：' + esc(e.message) + '</span>';
        });
    };
  }

  function uiTypes() {
    var t = typeKb();
    openGen("⑥ 类型知识库（定义 · 含义 · 作用）",
      '<p style="font-size:13px;color:#666">共 ' + t.items.length + ' 条类型释义，已向量化入库，可被自然语言检索命中。</p>' +
      '<div class="form-actions"><button class="btn-save" id="kbvTSeed">重建类型库</button></div>' +
      '<input class="f" id="kbvTQ" placeholder="检索类型释义，如：倒虹吸 作用" style="width:100%;box-sizing:border-box;margin-top:8px">' +
      '<div class="form-actions"><button class="btn-save" id="kbvTGo">检索</button></div>' +
      '<div id="kbvTOut" style="margin-top:8px;font-size:13px">' +
      t.items.map(function (it) { return '<div style="padding:6px 0;border-bottom:1px solid #f2f2f2"><b>' + esc(it.name) + '</b>：' + esc(it.def) + '</div>'; }).join("") +
      '</div>');
    $("kbvTSeed").onclick = function () { seedTypes(); toast("类型库已重建"); uiTypes(); };
    $("kbvTGo").onclick = function () {
      var q = ($("kbvTQ").value || "").trim();
      if (!q) { uiTypes(); return; }
      var r = searchTypes(q, 8);
      $("kbvTOut").innerHTML = r.length ? r.map(function (x) {
        return '<div style="padding:6px 0;border-bottom:1px solid #f2f2f2"><b>' + esc(x.name) + '</b> <span style="color:#1a6fc4">' + Math.round(x.score * 100) + '%</span><br>' + esc(x.def) + '</div>';
      }).join("") : '<div style="color:#999">未命中</div>';
    };
  }

  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); toast("已复制"); return; } } catch (e) {}
    try {
      var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); document.body.removeChild(ta); toast("已复制");
    } catch (e2) { toast("复制失败"); }
  }
  // 编码自适应（与 app.js 同一策略）
  function looksUtf8Bytes(b) {
    var i = 0, n = b.length;
    while (i < n) {
      var c = b[i];
      if (c < 0x80) { i++; continue; }
      var len = c >= 0xF0 ? 4 : (c >= 0xE0 ? 3 : (c >= 0xC0 ? 2 : 0));
      if (!len) return false;
      if (i + len > n) return false;
      for (var j = 1; j < len; j++) if ((b[i + j] & 0xC0) !== 0x80) return false;
      i += len;
    }
    return true;
  }
  function decodeBytesAuto(bytes) {
    try {
      if (bytes.length > 2 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return new TextDecoder("utf-8").decode(bytes.subarray ? bytes.subarray(3) : bytes.slice(3));
      }
      if (looksUtf8Bytes(bytes)) { try { return new TextDecoder("utf-8").decode(bytes); } catch (e) {} }
      try { return new TextDecoder("gb18030").decode(bytes); } catch (e2) {}
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) { return ""; }
  }

  function getMenuItems() {
    return [
      { k: "kbvRev", ico: "🔁", t: "智能反查" + CFG.label + "（参数→名称）", f: function () { closeMenu(); uiReverse(); } },
      { k: "kbvStat", ico: "📊", t: "统计汇总（类型 / 单位）", f: function () { closeMenu(); uiStats(); } },
      { k: "kbvDoc", ico: "📚", t: "预案 / 规程文档入库关联", f: function () { closeMenu(); uiDocs(); } },
      { k: "kbvRep", ico: "📝", t: "生成报告（doc / docx · 预览打印）", f: function () { closeMenu(); uiReport(); } },
      { k: "kbvPdf", ico: "📄", t: "PDF 转 Word 工具", f: function () { closeMenu(); uiPdf2Doc(); } },
      { k: "kbvType", ico: "🏷", t: "类型知识库（定义 · 作用）", f: function () { closeMenu(); uiTypes(); } }
    ];
  }

  global.KBV = {
    cfg: CFG, vecOf: vecOf, cos: cos,
    buildIndex: buildIndex, reverseSearch: reverseSearch,
    stats: stats, answerStats: answerStats,
    addDoc: addDoc, docList: docList, searchDocs: searchDocs, docsOfBuilding: docsOfBuilding,
    typeKb: typeKb, seedTypes: seedTypes, searchTypes: searchTypes,
    composeReport: composeReport, exportDoc: exportDoc, exportDocx: exportDocx, previewPrint: previewPrint,
    pdfToDoc: pdfToDoc, extractPdfText: extractPdfText, chunkText: chunkText,
    getMenuItems: getMenuItems
  };

  // 首次加载：构建索引 + 播种类型知识库（异步，避免阻塞启动）
  setTimeout(function () {
    try { buildIndex(false); } catch (e) {}
    try { typeKb(); } catch (e) {}
  }, 1200);
})(window);
