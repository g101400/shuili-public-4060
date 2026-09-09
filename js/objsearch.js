/* v2.4.9 对象智能检索（参数反查 / 分类统计 / 类型定义入库 / 预案关联 / 生成 Word / PDF 转 Word）
   三应用同源：水利=建筑物、感知=设备、古建=古建 */
(function (global) {
  "use strict";
  var APP_ID = (global.__APP_ID__ || "shuili").toLowerCase();
  var LABEL = { shuili: "建筑物", shipin: "设备", gujian: "古建" }[APP_ID] || "对象";
  var IDX = { items: [], built: 0, byId: {} };

  function esc(s) { return global.esc ? global.esc(s) : String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function toast(m) { if (global.toast) global.toast(m); }
  function openModal(t, b, f) { if (global.openModal) global.openModal(t, b, f); }
  function closeModal() { if (global.closeModal) global.closeModal(); }
  function el(id) { return global.el ? global.el(id) : (document.getElementById(id)); }
  function recs() { try { return (global.__getRecords && global.__getRecords()) || []; } catch (e) { return []; } }

  // ---------------- 1. 对象参数向量索引 ----------------
  function paramLines(r) {
    var ps = r.params || r.attrs || {};
    var arr = [], k;
    for (k in ps) {
      if (!Object.prototype.hasOwnProperty.call(ps, k)) continue;
      var v = ps[k];
      if (v == null || String(v).trim() === "") continue;
      arr.push(k + "：" + String(v).trim());
    }
    return arr;
  }
  function objText(r) {
    var seg = [r.name || "", r.btype || r.type || "", r.office || "", r.station || ""];
    var t = seg.filter(Boolean).join(" | ");
    var pl = paramLines(r);
    if (pl.length) t += " || " + pl.join("；");
    return t;
  }
  function buildIndex() {
    var rs = recs();
    IDX.items = []; IDX.byId = {};
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      if (!r) continue;
      var text = objText(r);
      var it = {
        id: r.id || (r.name + "_" + i), name: r.name || ("未命名" + i),
        office: r.office || "", btype: r.btype || r.type || "", station: r.station || "",
        params: r.params || r.attrs || {}, text: text,
        vec: (global.KB && KB.embed) ? KB.embed(text) : null
      };
      IDX.items.push(it); IDX.byId[it.id] = it;
    }
    IDX.built = Date.now();
    return IDX.items.length;
  }
  function ensureIndex() { if (!IDX.items.length) buildIndex(); return IDX.items; }

  // 中文数字 / 单位解析
  var CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function parseNums(q) {
    var out = [], re = /([0-9]+(?:\.[0-9]+)?|[\u96f6\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+)\s*(米|m|厘米|cm|毫米|mm|公里|km|千米|平方米|m2|立方米|m3|吨|t|千瓦|kw|度|个|台|座|孔|扇)?/gi, m;
    while ((m = re.exec(q))) {
      var raw = m[1], n = null;
      if (/[0-9]/.test(raw)) n = parseFloat(raw);
      else if (raw.length === 1 && CN_NUM[raw] != null) n = CN_NUM[raw];
      else if (raw === "十") n = 10;
      else if (raw.length === 2 && raw.charAt(0) === "十") n = 10 + (CN_NUM[raw.charAt(1)] || 0);
      else if (raw.length === 2 && raw.charAt(1) === "十") n = (CN_NUM[raw.charAt(0)] || 0) * 10;
      if (n == null) continue;
      out.push({ n: n, unit: (m[2] || "").toLowerCase() });
    }
    return out;
  }
  var MEASURE_KEYS = {
    "宽": ["宽", "净宽", "宽度"], "高": ["高", "高度", "净高"], "长": ["长", "长度", "全长"],
    "深": ["深", "深度"], "流量": ["流量"], "孔径": ["孔径", "孔"], "厚": ["厚", "厚度"],
    "面积": ["面积"], "高程": ["高程", "标高"], "功率": ["功率"], "电压": ["电压"]
  };
  function paramHit(it, query, nums) {
    var score = 0, reason = [];
    var ps = it.params || {}, k, v;
    // 数值命中
    for (var i = 0; i < nums.length; i++) {
      var num = nums[i].n;
      for (k in ps) {
        if (!Object.prototype.hasOwnProperty.call(ps, k)) continue;
        v = String(ps[k]);
        var mv = v.match(/-?[0-9]+(?:\.[0-9]+)?/);
        if (!mv) continue;
        var pv = parseFloat(mv[0]);
        if (Math.abs(pv - num) < 1e-6) {
          score += 1.0; reason.push(k + "=" + v);
        } else if (Math.abs(pv - num) <= Math.max(0.05, Math.abs(num) * 0.1)) {
          score += 0.45; reason.push(k + "≈" + v);
        }
      }
    }
    // 度量词命中（宽/高/长…）
    for (var mk in MEASURE_KEYS) {
      if (query.indexOf(mk) < 0) continue;
      var keys = MEASURE_KEYS[mk];
      for (k in ps) {
        if (!Object.prototype.hasOwnProperty.call(ps, k)) continue;
        for (var j = 0; j < keys.length; j++) {
          if (k.indexOf(keys[j]) >= 0) { score += 0.5; reason.push(k + "=" + ps[k]); break; }
        }
      }
    }
    return { score: score, reason: reason.slice(0, 4) };
  }
  function sim(q, it) {
    var s = 0;
    if (global.KB && KB.fuzzySim) s = Math.max(s, KB.fuzzySim(q, it.text));
    if (it.vec && global.KB && KB.embed && KB.cosine) {
      var qv = KB.embed(q);
      var c = KB.cosine(qv, it.vec);
      if (isFinite(c)) s = Math.max(s, c * 1.4);
    }
    return s;
  }
  // 参数反查对象（"宽度3米的闸门" → 一个或多个对象）
  function queryByParam(q, k) {
    q = String(q || "").trim();
    if (!q) return [];
    ensureIndex();
    var nums = parseNums(q);
    var out = [];
    for (var i = 0; i < IDX.items.length; i++) {
      var it = IDX.items[i];
      var s = sim(q, it) * 0.6;
      var ph = paramHit(it, q, nums);
      s += ph.score;
      // 类型词直接命中（闸门/桥/渡槽…）
      if (it.btype && q.indexOf(it.btype) >= 0) s += 0.8;
      if (it.name && q.indexOf(it.name) >= 0) s += 1.2;
      if (s > 0.12) out.push({ id: it.id, name: it.name, office: it.office, btype: it.btype, score: s, reason: ph.reason, text: it.text });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, k || 20);
  }

  // ---------------- 2. 分类统计（Count / Group By） ----------------
  function groupCount(field, filter) {
    ensureIndex();
    var map = {}, total = 0;
    for (var i = 0; i < IDX.items.length; i++) {
      var it = IDX.items[i];
      if (filter && !filter(it)) continue;
      var key = String(it[field] || "未分类");
      map[key] = (map[key] || 0) + 1; total++;
    }
    var rows = [];
    for (var kk in map) rows.push({ key: kk, count: map[kk] });
    rows.sort(function (a, b) { return b.count - a.count; });
    return { rows: rows, total: total };
  }
  // 类型核心词：去掉通用后缀，使「闸门」能命中「进水闸/节制闸」
  var TAIL = ["管理所", "闸门", "摄像机", "监测站", "门", "机", "站", "计", "器", "仪", "桥", "所", "段", "槽", "塔", "亭", "楼", "阁", "殿", "堂", "台", "坊", "窟"];
  function coreOf(kw) {
    var s = String(kw || "").trim();
    if (s.length >= 2) {
      for (var i = 0; i < TAIL.length; i++) {
        if (s.length > TAIL[i].length && s.indexOf(TAIL[i]) === s.length - TAIL[i].length) return s.slice(0, s.length - TAIL[i].length);
      }
    }
    return s;
  }
  function matchKw(kw, text) {
    if (!kw) return true;
    text = String(text || "");
    if (text.indexOf(kw) >= 0) return true;
    var c = coreOf(kw);
    if (c && c !== kw && text.indexOf(c) >= 0) return true;
    if (kw.length >= 2 && text.length >= 2 && kw.indexOf(text) >= 0) return true;
    return false;
  }
  function statAnswer(q) {
    q = String(q || "").trim();
    ensureIndex();
    var kw = q.replace(/(多少|几个|几座|几台|数量|统计|有多少|一共有|一共|总共|各|分别|请|帮我|查询|的|是|有|？|\?|\s|[个座台条扇处项])/g, "");
    var dims = [];
    if (/所|管理|单位|部门/.test(q)) dims.push("office");
    if (!dims.length) dims.push("btype");
    var res = [];
    for (var d = 0; d < dims.length; d++) {
      var field = dims[d];
      var g = groupCount(field, kw ? function (it) {
        return matchKw(kw, it.btype) || matchKw(kw, it.office) || matchKw(kw, it.name);
      } : null);
      // 关键词收敛：命中项里再按 btype 细分
      var sub = groupCount("btype", kw ? function (it) {
        return matchKw(kw, it.btype) || matchKw(kw, it.name);
      } : null);
      res.push({ field: field, rows: g.rows, total: g.total, sub: sub.rows });
    }
    return { keyword: kw, groups: res, all: IDX.items.length };
  }

  // ---------------- 3. 类型定义向量化入库 ----------------
  var TYPE_DEFS = {
    shuili: [
      ["进水闸", "从河道、渠道或水库引水的水闸，用于控制进入下游渠道或灌区的流量，常设于渠首。"],
      ["节制闸", "建于渠道上用于调节上游水位、控制下泄流量的水闸，一般不拦断全部水流。"],
      ["泄洪闸", "用于宣泄洪水、控制库水位的水闸，布置在溢洪道或堤防上，泄流能力大。"],
      ["排水闸", "排除涝水的水闸，常建于排水渠出口，外河水位高时关闸防倒灌。"],
      ["挡潮闸", "建于入海河口防止海水倒灌的水闸，兼顾排涝与蓄淡。"],
      ["分水闸", "把上一级渠道的水量分配到下一级渠道的配水建筑物。"],
      ["退水闸", "用于泄空渠道或排除渠道多余水量的安全泄水建筑物。"],
      ["渡槽", "跨越山谷、河流、道路的输水架空渠道，属于输水建筑物。"],
      ["跌水", "渠道落差集中处的落差建筑物，用于消耗水流能量、防止冲刷。"],
      ["陡坡", "坡度较陡的落差建筑物，水流沿槽身急流下泄。"],
      ["倒虹吸", "穿越河道或洼地的压力输水建筑物，形似倒置虹吸管。"],
      ["涵洞", "埋设在填方下的过水建筑物，用于排洪或输水。"],
      ["公路桥", "跨越渠道、河道的交通桥，宽度按公路等级确定。"],
      ["生产桥", "供农用车辆通行的桥梁，荷载等级低于公路桥。"],
      ["泵站", "由水泵机组、进出水建筑物组成的提水工程。"],
      ["水库", "拦河筑坝形成的蓄水工程，具有防洪、供水、灌溉等功能。"]
    ],
    shipin: [
      ["摄像头", "视频监控设备，按形态分为球机、枪机，用于实时监视与录像回放。"],
      ["球机", "一体化球形摄像机，支持云台旋转与变倍，可远程控制方向。"],
      ["枪机", "固定式筒形摄像机，视角固定，常用于走廊、出入口定点监控。"],
      ["水位计", "测量水位的传感器，常见雷达式、超声波式、压力式。"],
      ["雨量计", "观测降雨量的仪器，常用翻斗式，输出时段雨量。"],
      ["流量计", "测量管道或渠道流量的仪表，常见电磁式、超声波式。"],
      ["闸位计", "检测闸门开度的传感器，用于闸门启闭控制与状态反馈。"],
      ["渗压计", "监测坝体或堤防渗流压力的仪器。"],
      ["GNSS", "全球导航卫星系统位移监测设备，用于变形监测。"],
      ["水质监测站", "在线监测水温、浊度、溶解氧等水质指标的一体化站点。"],
      ["视频存储", "硬盘录像机/网络录像机，负责视频数据的存储与回放。"],
      ["广播音柱", "用于远程喊话与预警广播的户外音频终端。"]
    ],
    gujian: [
      ["殿", "高大庄重的单体木构建筑，多用于供奉神佛或举行礼仪，如大雄宝殿。"],
      ["堂", "用于议事、讲学或居住的较大型建筑。"],
      ["楼", "两层及以上可登临的建筑，如钟楼、鼓楼、藏书楼。"],
      ["阁", "多为重檐、四周设隔扇或回廊的观景性建筑。"],
      ["亭", "开敞无墙的小型建筑，用于休憩与点景。"],
      ["台", "高而平的夯土或砖石构筑物，用于观景、祭天或演武。"],
      ["塔", "高耸的多层建筑，源于佛塔，后用于观景、镇水或文峰。"],
      ["桥", "跨越障碍的交通构筑物，古桥常见石拱桥、廊桥。"],
      ["城墙", "环绕城池的防御性墙体，含城门、城楼、马面、角楼。"],
      ["牌坊", "纪念性或标识性的门洞式建筑，多为石构或木构。"],
      ["石窟寺", "依山开凿的宗教建筑，内含造像与壁画。"],
      ["民居", "传统居住建筑，反映地方营造技艺与聚落形态。"]
    ]
  };
  function initTypeDefs() {
    if (!global.KB || !KB.put) { toast("知识库未装载"); return 0; }
    var defs = TYPE_DEFS[APP_ID] || [];
    var n = 0;
    for (var i = 0; i < defs.length; i++) {
      KB.put({
        id: "TYPEDEF::" + defs[i][0],
        type: "typedef",
        title: defs[i][0],
        tags: ["类型定义", LABEL + "类型"],
        md: defs[i][0] + "（" + LABEL + "类型）：" + defs[i][1],
        meta: { kind: "typedef", app: APP_ID }
      });
      n++;
    }
    return n;
  }

  // ---------------- 4. 预案 / 知识文档与对象关联 ----------------
  function linkDocs() {
    if (!global.KB || !KB.all) return { linked: 0, chunks: 0 };
    ensureIndex();
    var names = [];
    for (var i = 0; i < IDX.items.length; i++) if (IDX.items[i].name.length >= 2) names.push(IDX.items[i].name);
    var es = KB.all() || [];
    var linked = 0, chunks = 0;
    for (var j = 0; j < es.length; j++) {
      var e = es[j];
      if (e.type === "object" || e.type === "typedef" && !e.md) continue;
      var txt = String(e.md || "");
      if (!txt) continue;
      chunks++;
      var hit = [];
      for (var k = 0; k < names.length; k++) {
        if (txt.indexOf(names[k]) >= 0) { hit.push(names[k]); if (hit.length >= 8) break; }
      }
      var meta = e.meta || {};
      if (hit.length && (meta.buildings || []).join("|") !== hit.join("|")) {
        meta.buildings = hit;
        (function (ee, mm) { KB.put({ id: ee.id, type: ee.type, title: ee.title, tags: ee.tags, md: ee.md, meta: mm }); })(e, meta);
        linked++;
      }
    }
    return { linked: linked, chunks: chunks };
  }
  function queryDocByObject(name, k) {
    if (!global.KB || !KB.all) return [];
    var es = KB.all() || [], out = [];
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      var meta = e.meta || {};
      var b = meta.buildings || [];
      var inMeta = false;
      for (var j = 0; j < b.length; j++) if (b[j] === name) inMeta = true;
      if (!inMeta && String(e.md || "").indexOf(name) < 0) continue;
      var idx = String(e.md || "").indexOf(name);
      var snip = idx >= 0 ? String(e.md).slice(Math.max(0, idx - 60), idx + 180) : String(e.md || "").slice(0, 240);
      out.push({ title: e.title || e.id, chunk: snip, tags: e.tags || [] });
      if (out.length >= (k || 10)) break;
    }
    return out;
  }

  // ---------------- 5. 生成小作文 + Word 导出 / 预览 / 打印 ----------------
  function docHtml(title, bodyHtml) {
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
      + '<head><meta charset="utf-8"><title>' + esc(title) + '</title>'
      + '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->'
      + '<style>body{font-family:"Microsoft YaHei",SimSun,serif;font-size:14px;line-height:1.8}h1{font-size:20px}h2{font-size:16px;margin-top:14px}'
      + 'table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:5px 8px;font-size:13px}.src{color:#666;font-size:12px}</style></head>'
      + '<body><h1>' + esc(title) + '</h1>' + bodyHtml + '</body></html>';
  }
  function downloadBlob(name, data, mime) {
    var blob = (data instanceof Blob) ? data : new Blob(["\ufeff" + data], { type: mime || "application/msword" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
  }
  function exportWord(title, html) { downloadBlob(title + ".doc", docHtml(title, html), "application/msword"); toast("已导出 Word：" + title + ".doc"); }
  function previewWord(title, html) {
    var w = window.open("", "_blank");
    if (!w) { toast("浏览器拦截了新窗口，请允许弹窗后重试"); return; }
    var full = docHtml(title, html)
      + '<div style="position:fixed;right:16px;bottom:16px"><button onclick="window.print()" style="padding:10px 16px;font-size:14px">打印 / 另存为 PDF</button></div>';
    w.document.write(full); w.document.close();
  }

  // 根据检索结果生成结构化小作文（本地模板，AI 可用则用 AI 润色）
  function composeArticle(q, objs, docHits, stat) {
    var h = "";
    h += '<p class="src">生成时间：' + new Date().toLocaleString() + '　检索式：' + esc(q) + '</p>';
    h += '<h2>一、检索概况</h2><p>本次检索共命中相关' + LABEL + ' <b>' + (objs ? objs.length : 0) + '</b> 个，'
      + '关联预案 / 知识片段 <b>' + (docHits ? docHits.length : 0) + '</b> 条'
      + (stat ? ('，当前库内' + LABEL + '总数 <b>' + stat.all + '</b> 个') : '') + '。</p>';
    if (objs && objs.length) {
      h += '<h2>二、命中' + LABEL + '清单</h2><table><tr><th>序号</th><th>名称</th><th>类型</th><th>管理单位</th><th>匹配依据</th><th>相关度</th></tr>';
      for (var i = 0; i < objs.length; i++) {
        var o = objs[i];
        h += '<tr><td>' + (i + 1) + '</td><td>' + esc(o.name) + '</td><td>' + esc(o.btype || "") + '</td><td>' + esc(o.office || "")
          + '</td><td>' + esc((o.reason || []).join("；")) + '</td><td>' + Math.round(Math.min(1, (o.score || 0) / 2) * 100) + '%</td></tr>';
      }
      h += '</table>';
      var first = objs[0];
      h += '<h2>三、典型' + LABEL + '详述</h2><p><b>' + esc(first.name) + '</b>'
        + (first.office ? '隶属于' + esc(first.office) : '')
        + (first.btype ? '，类型为' + esc(first.btype) : '') + '。主要参数如下：</p><ul>';
      var pl = paramLines(IDX.byId[first.id] || { params: first.params });
      for (var j = 0; j < Math.min(pl.length, 20); j++) h += '<li>' + esc(pl[j]) + '</li>';
      h += '</ul>';
    }
    if (docHits && docHits.length) {
      h += '<h2>四、预案 / 规范中的相关要求</h2>';
      for (var k = 0; k < docHits.length; k++) {
        h += '<p><b>' + esc(docHits[k].title) + '</b><br/>' + esc(String(docHits[k].chunk || "").slice(0, 300)) + '</p>';
      }
    }
    if (stat && stat.groups && stat.groups.length) {
      h += '<h2>五、分类统计</h2><table><tr><th>类型</th><th>数量</th></tr>';
      var rows = (stat.groups[0].sub && stat.groups[0].sub.length) ? stat.groups[0].sub : stat.groups[0].rows;
      for (var m2 = 0; m2 < rows.length; m2++) h += '<tr><td>' + esc(rows[m2].key) + '</td><td>' + rows[m2].count + '</td></tr>';
      h += '</table>';
    }
    h += '<h2>六、结论与建议</h2><p>以上结果由本地向量检索与参数匹配生成，供现场核对与方案编制参考；'
      + '如与实际不符，请在「存疑与反向查询」中标注，便于后续校正。</p>';
    return h;
  }

  // ---------------- 6. PDF 转 Word ----------------
  function pickFile(accept, cb) {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept || ".pdf"; inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = function () { if (inp.files && inp.files[0]) cb(inp.files[0]); if (inp.parentNode) inp.parentNode.removeChild(inp); };
    inp.click();
  }
  function readBytes(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(new Error("读取文件失败")); };
      fr.readAsArrayBuffer(file);
    });
  }
  async function pdfToWord(file) {
    if (!global.KB) throw new Error("知识库模块未装载");
    var bytes = await readBytes(file);
    var md = "", used = "text";
    try { md = await KB.pdfToMd(bytes, function () {}); } catch (e) { md = ""; }
    if (!md || String(md).replace(/\s/g, "").length < 20) {
      used = "ocr";
      md = await KB.pdfOcrToMd(bytes, function () {});
    }
    var html = KB.mdToHtml ? KB.mdToHtml(md) : ("<pre>" + esc(md) + "</pre>");
    var base = String(file.name || "document").replace(/\.pdf$/i, "");
    return { name: base, html: html, md: md, mode: used };
  }

  // ---------------- UI ----------------
  function openObjParamSearch() {
    var n = ensureIndex().length;
    openModal("参数反查" + LABEL,
      '<div class="hint">已建索引 <b>' + n + '</b> 个' + LABEL + '。输入参数描述即可反查，例如：宽度 3 米的闸门、两米宽的公路桥、高程 50 米的渡槽。</div>'
      + '<div class="field"><input id="opsQ" class="inp" placeholder="如：宽度3米的闸门"></div>'
      + '<div id="opsOut" style="max-height:46vh;overflow:auto;margin-top:8px"></div>',
      '<button class="btn ghost" id="opsRebuild">重建索引</button><button class="btn ghost" id="opsDoc">导出Word</button><button class="btn primary" id="opsGo">查询</button>');
    var last = null;
    function run() {
      var q = (el("opsQ") || {}).value || "";
      var r = queryByParam(q, 30);
      last = { q: q, objs: r };
      var box = el("opsOut");
      if (!box) return;
      if (!r.length) { box.innerHTML = '<div class="hint">没有匹配的' + LABEL + '，换个说法试试（如“3米宽闸门”）。</div>'; return; }
      box.innerHTML = r.map(function (o, i) {
        return '<div class="hist-item" data-ops="' + i + '"><div class="hist-top"><b>' + esc(o.name) + '</b>'
          + '<span class="hist-badge off">' + Math.round(Math.min(1, o.score / 2) * 100) + '%</span></div>'
          + '<div class="hint">' + esc(o.office || "") + (o.btype ? " · " + esc(o.btype) : "") + '</div>'
          + '<div class="hist-q">' + esc((o.reason || []).join("；") || o.text.slice(0, 120)) + '</div></div>';
      }).join("");
      var items = box.querySelectorAll("[data-ops]");
      for (var i = 0; i < items.length; i++) {
        items[i].onclick = (function (o) { return function () { showObjDetail(o); }; })(r[i]);
      }
    }
    function showObjDetail(o) {
      var it = IDX.byId[o.id] || {};
      var pl = paramLines(it);
      openModal(LABEL + "详情 · " + o.name,
        '<div class="hint">' + esc(o.office || "") + (o.btype ? " · " + esc(o.btype) : "") + '</div>'
        + '<div style="max-height:44vh;overflow:auto">' + (pl.length ? pl.map(function (s) { return '<div>' + esc(s) + '</div>'; }).join("") : '<div class="hint">无参数记录</div>') + '</div>'
        + '<div class="hint" style="margin-top:8px">相关预案 / 规范：' + (function () {
          var d = queryDocByObject(o.name, 3);
          return d.length ? d.map(function (x) { return esc(x.title); }).join("、") : "暂无";
        })() + '</div>',
        '<button class="btn ghost" id="odDoc">生成小作文</button><button class="btn primary" id="odClose">关闭</button>');
      var dc = el("odClose"); if (dc) dc.onclick = closeModal;
      var gd = el("odDoc");
      if (gd) gd.onclick = function () {
        var docs = queryDocByObject(o.name, 6);
        var html = composeArticle(o.name + " 参数与用途", [o], docs, null);
        exportWord(o.name + "说明", html);
        previewWord(o.name + "说明", html);
      };
    }
    var g = el("opsGo"); if (g) g.onclick = run;
    var q = el("opsQ"); if (q) q.onkeydown = function (e) { if (e && e.key === "Enter") run(); };
    var rb = el("opsRebuild");
    if (rb) rb.onclick = function () { var c = buildIndex(); toast("索引已重建：" + c + " 个" + LABEL); };
    var ex = el("opsDoc");
    if (ex) ex.onclick = function () {
      if (!last || !last.objs.length) { toast("请先查询"); return; }
      var st = statAnswer(last.q);
      var docs = last.objs.length ? queryDocByObject(last.objs[0].name, 6) : [];
      var html = composeArticle(last.q, last.objs, docs, st);
      exportWord(LABEL + "检索报告", html);
      previewWord(LABEL + "检索报告", html);
    };
  }
  function openObjStats() {
    var st = statAnswer("");
    var rows = st.groups[0].rows;
    openModal(LABEL + "分类统计",
      '<div class="hint">当前库内共 <b>' + st.all + '</b> 个' + LABEL + '。输入关键词可按类型收敛（如“闸门”“桥”）。</div>'
      + '<div class="field"><input id="osQ" class="inp" placeholder="如：闸门"></div>'
      + '<div id="osOut" style="max-height:46vh;overflow:auto;margin-top:8px"></div>',
      '<button class="btn ghost" id="osExport">导出Word</button><button class="btn primary" id="osGo">统计</button>');
    function render(st2) {
      var box = el("osOut"); if (!box) return;
      var r = st2.groups[0].sub.length && st2.keyword ? st2.groups[0].sub : st2.groups[0].rows;
      box.innerHTML = '<table style="width:100%;font-size:13px"><tr><th style="text-align:left">类型</th><th style="text-align:right">数量</th></tr>'
        + r.map(function (x) { return '<tr><td>' + esc(x.key) + '</td><td style="text-align:right">' + x.count + '</td></tr>'; }).join("")
        + '</table>';
    }
    render(st);
    var g = el("osGo");
    if (g) g.onclick = function () { var s = statAnswer((el("osQ") || {}).value || ""); render(s); el("osOut").setAttribute("data-last", "1"); window.__LAST_STAT__ = s; };
    var ex = el("osExport");
    if (ex) ex.onclick = function () {
      var s = window.__LAST_STAT__ || statAnswer((el("osQ") || {}).value || "");
      var rows = s.groups[0].sub.length && s.keyword ? s.groups[0].sub : s.groups[0].rows;
      var html = '<h2>' + LABEL + '分类统计</h2><table><tr><th>类型</th><th>数量</th></tr>'
        + rows.map(function (x) { return '<tr><td>' + esc(x.key) + '</td><td>' + x.count + '</td></tr>'; }).join("")
        + '</table><p>合计：' + s.all + ' 个' + LABEL + '。</p>';
      exportWord(LABEL + "分类统计", html);
      previewWord(LABEL + "分类统计", html);
    };
  }
  function openTypeDefInit() {
    var n = initTypeDefs();
    if (global.KB && KB.buildIndex) { try { KB.buildIndex(); } catch (e) {} }
    toast("已写入 " + n + " 条" + LABEL + "类型定义到本地知识库");
  }
  function openDocLink() {
    var r = linkDocs();
    if (global.KB && KB.buildIndex) { try { KB.buildIndex(); } catch (e) {} }
    toast("已扫描 " + r.chunks + " 条知识片段，关联 " + r.linked + " 条");
  }
  function openPdf2Word() {
    openModal("PDF 转 Word",
      '<div class="hint">选择 PDF 文件：有文本层时直接提取（保留标题 / 表格 / 列表），扫描件自动走轻量化 OCR 识别。转换后可预览、打印并导出 .doc。</div>'
      + '<div id="p2wOut" style="margin-top:8px"></div>',
      '<button class="btn ghost" id="p2wCancel">关闭</button><button class="btn primary" id="p2wPick">选择 PDF</button>');
    var c = el("p2wCancel"); if (c) c.onclick = closeModal;
    var p = el("p2wPick");
    if (p) p.onclick = function () {
      pickFile(".pdf", function (file) {
        var out = el("p2wOut"); if (out) out.innerHTML = '<div class="hint">正在转换：' + esc(file.name) + ' …</div>';
        pdfToWord(file).then(function (r) {
          var out2 = el("p2wOut");
          if (out2) out2.innerHTML = '<div class="hint">转换完成（' + (r.mode === "ocr" ? "OCR 识别" : "文本层提取") + '），可预览后导出。</div>';
          closeModal();
          openModal("PDF 转 Word · " + r.name,
            '<div class="hint">来源：' + esc(file.name) + '，转换方式：' + (r.mode === "ocr" ? "OCR 识别" : "文本层提取") + '</div>'
            + '<div id="p2wPrev" style="max-height:50vh;overflow:auto;border:1px solid rgba(127,127,127,.25);padding:10px;border-radius:8px">' + r.html + '</div>',
            '<button class="btn ghost" id="p2wPrint">打印</button><button class="btn ghost" id="p2wPreview">新窗口预览</button><button class="btn primary" id="p2wSave">导出 Word</button>');
          var s = el("p2wSave"); if (s) s.onclick = function () { exportWord(r.name, r.html); };
          var pv = el("p2wPreview"); if (pv) pv.onclick = function () { previewWord(r.name, r.html); };
          var pr = el("p2wPrint"); if (pr) pr.onclick = function () { previewWord(r.name, r.html); };
        }).catch(function (e) {
          var out3 = el("p2wOut");
          if (out3) out3.innerHTML = '<div class="hint" style="color:#ff9a9a">转换失败：' + esc(e && e.message ? e.message : e) + '</div>';
        });
      });
    };
  }
  function openGenReport() {
    openModal("生成" + LABEL + "说明文档",
      '<div class="hint">输入主题或' + LABEL + '名称，系统综合「参数检索 + 分类统计 + 预案关联」生成一篇结构化小作文，并导出 Word（可预览 / 打印）。</div>'
      + '<div class="field"><input id="grQ" class="inp" placeholder="如：进水闸的运行与调度"></div>',
      '<button class="btn ghost" id="grCancel">取消</button><button class="btn primary" id="grGo">生成</button>');
    var c = el("grCancel"); if (c) c.onclick = closeModal;
    var g = el("grGo");
    if (g) g.onclick = function () {
      var q = (el("grQ") || {}).value || "";
      if (!q.trim()) { toast("请输入主题"); return; }
      var objs = queryByParam(q, 12);
      var st = statAnswer(q);
      var docs = objs.length ? queryDocByObject(objs[0].name, 6) : queryDocByObject(q, 6);
      var html = composeArticle(q, objs, docs, st);
      exportWord(LABEL + "说明_" + q.slice(0, 20), html);
      previewWord(LABEL + "说明_" + q.slice(0, 20), html);
    };
  }

  // 自动建索引 + 自动入库类型定义（首次）
  try {
    if (!global.__OBJIDX_AUTOBOOT__) {
      global.__OBJIDX_AUTOBOOT__ = 1;
      setTimeout(function () {
        try { buildIndex(); } catch (e) {}
        try { if (global.KB && KB.all) { var es = KB.all() || [], has = false; for (var i = 0; i < es.length; i++) if (es[i].type === "typedef") has = true; if (!has) initTypeDefs(); } } catch (e) {}
      }, 1200);
    }
  } catch (e) {}

  // 导入外部文档后自动与对象关联（预案/规范 → 建筑物 / 设备 / 古建）
  try {
    if (global.KB && typeof KB.importDocuments === "function" && !KB.__objLinkedHook) {
      var _imp = KB.importDocuments;
      KB.importDocuments = function (files, onProg) {
        var pr = _imp.call(KB, files, onProg);
        return Promise.resolve(pr).then(function (r) {
          try { linkDocs(); if (KB.buildIndex) KB.buildIndex(); } catch (e) {}
          return r;
        });
      };
      KB.__objLinkedHook = 1;
    }
  } catch (e) {}

  try {
    if (!global.__EXT_ACTS__) global.__EXT_ACTS__ = {};
    global.__EXT_ACTS__.objParamSearch = openObjParamSearch;
    global.__EXT_ACTS__.objStats = openObjStats;
    global.__EXT_ACTS__.objTypeDef = openTypeDefInit;
    global.__EXT_ACTS__.objDocLink = openDocLink;
    global.__EXT_ACTS__.objReport = openGenReport;
    global.__EXT_ACTS__.pdf2word = openPdf2Word;
  } catch (e) {}

  global.OBJS = {
    buildIndex: buildIndex, queryByParam: queryByParam, statAnswer: statAnswer, groupCount: groupCount, matchKw: matchKw, coreOf: coreOf,
    initTypeDefs: initTypeDefs, linkDocs: linkDocs, queryDocByObject: queryDocByObject,
    composeArticle: composeArticle, exportWord: exportWord, previewWord: previewWord, docHtml: docHtml,
    pdfToWord: pdfToWord, parseNums: parseNums, objText: objText, LABEL: LABEL, _idx: IDX
  };
})(window);
