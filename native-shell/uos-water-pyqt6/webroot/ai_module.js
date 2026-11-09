/* =============================================================================
 * ai_module.js — 通用「智能AI设置 + 智能AI助手」模块（三端四平台共享，参数化）
 *
 * 设计目标：
 *   1. 一份代码，九处加载（三产品 × Android/Win/UOS/iOS webroot），通过 AIModule.init(cfg) 适配场景。
 *   2. 复用宿主 app.js 的 .sheet / .sheet-head / .sheet-body / .btn-* 样式，风格与三端一致。
 *   3. 不依赖宿主私有变量（$/toast/save 等均在 IIFE 内），自带最小工具集，老 WebView 亦可用。
 *
 * 接入方式（在宿主 app.js 中）：
 *   (1) index.html 在 <script src="app.js"> 之前引入本文件：
 *         <script src="ai_module.js"></script>
 *   (2) 启动处调用 AIModule.init(cfg)，并在 buildMenu() 内注入：
 *         if (window.AIModule && AIModule.getMenuGroups)
 *           AIModule.getMenuGroups().forEach(function(g){ groups.push(g); });
 *
 * cfg = {
 *   domain: "gujian"|"shuili"|"perc",      // 命名空间隔离（localStorage key 前缀）
 *   appName: "古建景点打卡",
 *   allowOnlineQuery: true | false,        // 古建=true（联网查公开文物）；水利/感知=false（内部资料不编造）
 *   fieldSchema: ["intro","features",...], // 智能更新可改写的字段白名单
 *   getRecord: function(id){ return rec|null; },
 *   searchRecords: function(q){ return [...]; },   // 按名称/城市筛选，用于选择目标
 *   listAll: function(){ return [...]; },          // 本地上下文/纠错清单
 *   applyUpdate: function(rec, patch){ 合并 patch 并 save()+render() }
 * }
 * ========================================================================== */
(function (global) {
  "use strict";

  /* ---------- 自包含基础工具（宿主 $/esc/toast 非全局，这里自备）---------- */
  function q(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(msg) {
    var t = q("toast");
    if (t) { t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2000); }
  }
  function openGen(title, html) {
    var gt = q("genTitle"), gb = q("genBody");
    if (!gt || !gb) { toast("UI 未就绪"); return; }
    gt.textContent = title; gb.innerHTML = html;
    if (global.openSheet) global.openSheet("sheetGen");
  }
  function bindData(attr, fn) {
    var gb = q("genBody"); if (!gb) return;
    gb.querySelectorAll("[" + attr + "]").forEach(function (el) { el.onclick = function () { fn(el.getAttribute(attr), el); }; });
  }
  function busy(on) {
    var el = q("busyOverlay");
    if (!el) {
      el = document.createElement("div"); el.id = "busyOverlay";
      el.innerHTML = '<div class="busy-box"><div class="busy-spin"></div><div class="busy-msg">请稍后…</div></div>';
      (q("app") || document.body).appendChild(el);
    }
    el.classList.toggle("show", !!on);
  }

  /* ---------- 存储（按 domain 命名空间隔离）---------- */
  function kModels(d) { return "ai_models_" + d; }
  function kDef(d) { return "ai_default_" + d; }
  function kStrat(d) { return "ai_strategy_" + d; }
  function kCorr(d) { return "ai_corrections_" + d; }
  function kOnline(d) { return "ai_online_" + d; }       // v3.40：联网查询开关（持久化，默认 古建开 / 水利·感知关）
  function kHist(d) { return "ai_query_history_" + d; }  // v3.40：查询历史
  function load(key, def) { try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : def; } catch (e) { return def; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

  var OR_BASE = "https://openrouter.ai/api/v1";
  // v3.35：内置三个 OpenRouter 免费模型预设（均兼容 OpenAI，key 由 ai_seed.js 或用户在设置中填写）
  function defaults() {
    return [
      { id: "qwen38-free", name: "Qwen 3.8 27B (免费)", baseUrl: OR_BASE, protocol: "openai", modelId: "qwen/qwen3.8-27b:free", apiKey: "", local: false },
      { id: "nemotron-super-free", name: "Nemotron 3 Super 120B (免费·NVIDIA)", baseUrl: OR_BASE, protocol: "openai", modelId: "nvidia/nemotron-3-super-120b-a12b:free", apiKey: "", local: false },
      { id: "nemotron35-free", name: "Nemotron 3.5 Lightning (免费·NVIDIA)", baseUrl: OR_BASE, protocol: "openai", modelId: "nvidia/nemotron-3.5-lightning:free", apiKey: "", local: false }
    ];
  }

  var CFG = null;
  var RR_INDEX = 0;
  var pendingRecId = null;   // 智能更新/纠错当前选中的记录
  var pendingPatch = null;   // 智能更新待应用补丁

  /* ============================ 初始化 ============================ */
  function init(cfg0) {
    if (!cfg0 || !cfg0.domain) { if (global.console) console.warn("AIModule.init 缺少 domain"); return; }
    CFG = cfg0;
    CFG.allowOnlineQuery = true; // v3.40：联网查询能力对所有域开放（默认开关见 onlineEnabled()）
    if (!CFG.fieldSchema || !CFG.fieldSchema.length) CFG.fieldSchema = ["intro", "features"];
    if (!localStorage.getItem(kModels(CFG.domain))) save(kModels(CFG.domain), defaults());
    if (!localStorage.getItem(kDef(CFG.domain))) save(kDef(CFG.domain), "qwen38-free");
    if (!localStorage.getItem(kStrat(CFG.domain))) save(kStrat(CFG.domain), { mode: "failover" });
    if (!localStorage.getItem(kKB(CFG.domain))) save(kKB(CFG.domain), { index: [], bodies: {} }); // v3.38：知识库骨架
    if (!localStorage.getItem(kOnline(CFG.domain))) save(kOnline(CFG.domain), CFG.domain === "gujian"); // v3.40：默认 古建联网 / 水利·感知本地
    applySeed();
    try { mergeSeed(); } catch (e) { if (global.console) console.warn("mergeSeed 失败", e); }   // v3.41：发行前预生成建筑骨干种子合并
    try { seedBuildings(); } catch (e) { if (global.console) console.warn("seedBuildings 失败", e); } // v3.40：运行时尚无种子时兜底播种
    global.AIModule = API;
  }
  // 本地种子：由 ai_seed.js 设置 window.AI_SEED = { apiKey, default?, strategy? }，把密钥/默认填入。
  // 密钥不写进本共享模块源码（避免泄露），仅在本地 webroot 的 ai_seed.js 中提供。
  function applySeed() {
    var s = global.AI_SEED; if (!s || typeof s !== "object") return;
    var models = getModels();
    if (s.apiKey) models.forEach(function (m) { if (!m.apiKey) m.apiKey = s.apiKey; });
    save(kModels(CFG.domain), models);
    if (s.default) save(kDef(CFG.domain), s.default);
    if (s.strategy && s.strategy.mode) save(kStrat(CFG.domain), s.strategy);
  }

  function getModels() { return load(kModels(CFG.domain), defaults()); }
  function getDef() { return load(kDef(CFG.domain), null); }
  function getStrat() { return load(kStrat(CFG.domain), { mode: "manual" }); }
  // v3.40：联网查询开关（持久化）；查询历史（按时间保存，最多 30 条）
  function onlineEnabled() { return load(kOnline(CFG.domain), CFG.domain === "gujian"); }
  function setOnline(on) { save(kOnline(CFG.domain), !!on); }
  function getHist() { return load(kHist(CFG.domain), []); }
  function addHist(qtext, out, online) {
    var list = getHist().filter(function (h) { return h.q !== qtext; });
    list.unshift({ q: qtext, mode: online ? "online" : "local", ts: new Date().toLocaleString("zh-CN"), out: (out || "").slice(0, 2000) });
    if (list.length > 30) list = list.slice(0, 30);
    save(kHist(CFG.domain), list);
  }

  /* ============================ 模型调用 ============================ */
  // 自动调用策略：manual=仅默认；failover=失败切下一个；roundrobin=多模型轮询
  function resolveOrder() {
    var models = getModels(), def = getDef(), strat = getStrat();
    if (!models.length) return [];
    if (strat.mode === "roundrobin" && models.length > 1) {
      var idx = RR_INDEX % models.length; RR_INDEX++;
      return models.slice(idx).concat(models.slice(0, idx));
    }
    if (strat.mode === "failover") {
      var arr = [], primary = models.find(function (m) { return m.id === def; });
      if (primary) arr.push(primary);
      models.forEach(function (m) { if (m !== primary) arr.push(m); });
      return arr;
    }
    var d = models.find(function (m) { return m.id === def; }) || models[0];
    return d ? [d] : [];
  }

  function toLatin1(s) {
    if (typeof s !== "string") return s == null ? "" : String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) out += s.charCodeAt(i) <= 0xFF ? s[i] : "?";
    return out;
  }

  function chatOne(model, messages) {
    var url = (model.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
    if (!url) return Promise.reject(new Error("模型「" + model.name + "」引用地址为空"));
    if (typeof fetch !== "function") return Promise.reject(new Error("当前环境不支持 fetch（无法联网）"));
    var body = { model: model.modelId, messages: messages, stream: false };
    if (model.temperature != null) body.temperature = model.temperature;
    // HTTP 头仅允许 ISO-8859-1 字符；appName 含中文会令 fetch 抛 "String contains non ISO-8859-1 code point"
    var ak = toLatin1(model.apiKey || "");
    var headers = { "Content-Type": "application/json", "Authorization": "Bearer " + ak };
    // OpenRouter 推荐头（可选，强制 ASCII）：提升路由排名、避免部分 provider 拒绝匿名请求
    var siteId = (CFG && CFG.domain) ? CFG.domain : "app";
    headers["HTTP-Referer"] = "https://" + siteId + ".local/";
    headers["X-Title"] = "YituMap-" + siteId;
    if (model.extraHeaders) Object.keys(model.extraHeaders).forEach(function (k) { headers[k] = toLatin1(model.extraHeaders[k]); });
    return fetch(url, { method: "POST", headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) {
          var msg = "HTTP " + r.status;
          if (r.status === 429) msg += "：免费模型上游限流（稍后重试或自动切换下一模型）";
          else if (r.status === 401) msg += "：API Key 无效或未配置";
          if (t) msg += "：" + t.slice(0, 200);
          throw new Error(msg);
        });
        return r.json();
      })
      .then(function (j) {
        var m0 = j && j.choices && j.choices[0] && j.choices[0].message;
        var c = m0 ? (m0.content || "") : "";
        if (!c && m0 && m0.reasoning) c = "（模型仅返回思考过程）" + String(m0.reasoning).slice(0, 200);
        return c;
      });
  }

  function chat(messages) {
    var order = resolveOrder();
    if (!order.length) return Promise.reject(new Error("未配置任何模型，请先到「智能AI设置」添加"));
    var i = 0;
    function attempt() {
      return chatOne(order[i], messages).catch(function (e) {
        if (i < order.length - 1) { i++; toast("模型「" + order[i - 1].name + "」失败，切换：" + order[i].name); return attempt(); }
        throw new Error("全部模型失败：" + e.message);
      });
    }
    return attempt();
  }

  function systemPrompt() {
    if (onlineEnabled()) {
      if (CFG.domain === "gujian") {
        return "你是文物/古建知识助手。用户会提供某处古建的名称与现有资料，并可能要求联网核实公开信息。" +
          "请基于可靠的公开知识作答；如不确定请说明。回答用中文，简明有条理。";
      }
      return "你是「" + (CFG.appName || "本系统") + "」的联网查询助手。用户会提供某建筑物/设备的名称与现有资料，" +
        "可联网核实公开信息（如标准参数、行业规范、厂家、同类工程案例）。" +
        // v3.46：强调 5 级组织（局/管理处/所/站/段）概念 + 数据源 — 用户问"京密引水管理处有几个管理所"时能基于组织清单回答
        "**数据组织原则**：本系统采用 5 级组织（局 → 管理处 → 所 → 站 → 段），用户查询时尽量按 5 级层级回答；" +
        "当用户问『管理处下属多少所/站/段』时，结合组织清单 + 实际数据回答。" +
        "请基于可靠公开知识作答；如不确定请说明。" +
        "回答用中文，简明有条理。";
    }
    return "你是「" + (CFG.appName || "本系统") + "」的本地数据辅助助手。" +
      // v3.46：本地兜底也强调 5 级组织概念
      "本系统采用 5 级组织（局 → 管理处 → 所 → 站 → 段），用户问『×下属多少×』时按组织清单回答。" +
      "本系统的建筑物/设备为内部资料，公开大模型没有其准确数据，禁止编造或臆测任何内部参数与坐标。" +
      "你只能基于用户提供的本地记录上下文进行分析、补全缺失字段、指出存疑项，不要声称来自外部网络。" +
      "回答用中文，简明。";
  }

  function buildLocalContext(filter) {
    var recs = CFG.listAll ? CFG.listAll() : [];
    if (filter) recs = recs.filter(function (r) { return (r.name || "").indexOf(filter) >= 0 || (r.city || "").indexOf(filter) >= 0; });
    recs = recs.slice(0, 30);
    return recs.map(function (r) {
      return "- " + (r.name || "?") + "（" + (r.city || "") + (r.type ? "·" + r.type : "") + "）：" + (r.intro || "") + (r.features ? " 特点：" + r.features : "");
    }).join("\n") || "（无本地记录）";
  }

  /* ============================ 菜单注入 ============================ */
  function getMenuGroups() {
    if (!CFG) return [];
    var online = onlineEnabled();
    return [
      { g: "设置", ico: "⚙️", items: [
        { ico: "🤖", t: "智能AI设置", f: function () { if (global.closeSheet) global.closeSheet("sheetMenu"); API._openSettings(); } },
        { ico: "📚", t: "知识库管理", f: function () { if (global.closeSheet) global.closeSheet("sheetMenu"); API._openKB(); } }
      ]},
      { g: online ? "智能AI" : "智能AI（本地辅助）", ico: online ? "✨" : "🔒", items: [
        { ico: "🔍", t: online ? "智能查询（联网）" : "智能问答（本地）", f: function () { if (global.closeSheet) global.closeSheet("sheetMenu"); API._openSmartQuery(); } },
        { ico: "🔄", t: online ? "智能更新（联网补全）" : "智能补全（本地）", f: function () { if (global.closeSheet) global.closeSheet("sheetMenu"); API._openSmartUpdate(); } },
        { ico: "✅", t: online ? "智能纠错（标注差异）" : "存疑标注（复核）", f: function () { if (global.closeSheet) global.closeSheet("sheetMenu"); API._openSmartCorrect(); } }
      ]}
    ];
  }

  /* ============================ 智能AI设置 ============================ */
function _openExt(url) {
  try { if (window.Android && typeof window.Android.openExternal === "function") { window.Android.openExternal(url); return; } } catch (e) {}
  try { var a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 500); } catch (e2) { try { window.open(url, "_blank"); } catch (e3) {} }
}
function providerBtn(name, url) {
  return '<button class="tbtn" data-prov="' + esc(url) + '" style="font-size:12px">' + esc(name) + "</button>";
}

  function openSettings() {
    var models = getModels(), def = getDef(), strat = getStrat();
    var mlist = models.map(function (m) {
      var tag = m.local ? "🖥️本地" : "☁️云端";
      var isDef = m.id === def;
      return '<div class="bm-row"><div style="flex:1">' +
        '<div style="font-weight:600">' + esc(m.name) + (isDef ? ' <span style="color:#b8862f">★默认</span>' : "") + "</div>" +
        '<div style="font-size:12px;color:#8a7c70">' + tag + " · " + esc(m.protocol) + " · " + esc(m.modelId) + "</div>" +
        '<div style="font-size:11px;color:#aab4be;word-break:break-all">' + esc(m.baseUrl) + "</div></div>" +
        '<button class="tbtn" data-edit="' + esc(m.id) + '">编辑</button> ' +
        '<button class="tbtn" data-del="' + esc(m.id) + '">删除</button> ' +
        '<button class="tbtn" data-test="' + esc(m.id) + '">测连</button></div>';
    }).join("") || '<div class="empty-tip">尚未添加模型</div>';

    var stratLabel = { manual: "仅用默认模型", failover: "失败自动切换下一个", roundrobin: "多模型轮询" }[strat.mode] || strat.mode;

    var html =
      '<p style="font-size:13px;color:#3a2e28;line-height:1.6">管理大模型接入方式。可添加多个模型（含本地部署），设置默认模型与自动调用策略。</p>' +
      '<div style="display:flex;gap:8px;margin:10px 0">' +
        '<button class="btn-save" style="flex:1" id="btnAddModel">＋ 添加模型</button>' +
        '<button class="btn-cancel" style="flex:1" id="btnStrategy">⚙ 调用策略</button></div>' +
      '<h4 style="color:#6b2e2e;margin:12px 0 6px">已配置模型（' + models.length + "）</h4>" +
      '<div id="bmList">' + mlist + "</div>" +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button class="btn-cancel" style="flex:1" id="btnExport">⬇ 导出配置</button>' +
        '<button class="btn-cancel" style="flex:1" id="btnImport">⬆ 导入配置</button></div>' +
      '<h4 style="color:#6b2e2e;margin:14px 0 6px">🔑 申请 / 获取 API Key</h4>' +
      '<p style="font-size:12px;color:#8a7c70;margin-bottom:6px">点击下方厂商，跳转其官网创建并复制 API Key，再回到「添加模型」粘贴即可。</p>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px" id="keyProviders">' +
        providerBtn("OpenRouter", "https://openrouter.ai/keys") +
        providerBtn("OpenAI", "https://platform.openai.com/api-keys") +
        providerBtn("Anthropic", "https://console.anthropic.com/settings/keys") +
        providerBtn("Google Gemini", "https://aistudio.google.com/app/apikey") +
        providerBtn("DeepSeek", "https://platform.deepseek.com/api_keys") +
        providerBtn("Kimi(Moonshot)", "https://platform.moonshot.cn/console/api-keys") +
        providerBtn("智谱 GLM", "https://open.bigmodel.cn/usercenter/apikeys") +
        providerBtn("通义 Qwen", "https://dashscope.console.aliyun.com/apiKey") +
        providerBtn("NVIDIA", "https://build.nvidia.com/") +
        providerBtn("Mistral", "https://console.mistral.ai/api-keys/") +
        providerBtn("Groq", "https://console.groq.com/keys") +
        providerBtn("硅基流动", "https://cloud.siliconflow.cn/i/VXhMELo8") +
      "</div>" +

      '<div style="margin-top:10px;font-size:12px;color:#8a7c70">当前策略：' + esc(stratLabel) + "</div>";
    openGen("智能AI设置", html);

    q("btnAddModel").onclick = function () { openModelForm(null); };
    q("btnStrategy").onclick = openStrategy;
    q("btnExport").onclick = exportCfg;
    q("btnImport").onclick = importCfg;
    bindData("data-edit", function (id) { var m = getModels().find(function (x) { return x.id === id; }); openModelForm(m); });
    bindData("data-del", function (id) { delModel(id); });
    bindData("data-test", function (id) { testModel(id); });
    (function(){ var pv = q("keyProviders"); if (pv) pv.onclick = function (e) { var t = e.target.closest ? e.target.closest("[data-prov]") : null; if (t) { _openExt(t.getAttribute("data-prov")); } }; })();
  }

  function openModelForm(model) {
    var isEdit = !!model;
    var m = model || { id: "", name: "", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", modelId: "", apiKey: "", local: false };
    var html =
      '<label class="f">模型名称</label><input class="f" id="mName" value="' + esc(m.name) + '" placeholder="如：本地Qwen / OpenRouter-GPT">' +
      '<label class="f">引用地址（API Base）</label><input class="f" id="mUrl" value="' + esc(m.baseUrl) + '" placeholder="https://openrouter.ai/api/v1">' +
      '<label class="f">协议</label><select class="f" id="mProto">' +
        ["openai", "openai-compatible", "anthropic", "custom"].map(function (p) { return '<option' + (p === m.protocol ? " selected" : "") + ">" + p + "</option>"; }).join("") + "</select>" +
      '<label class="f">模型 ID</label><input class="f" id="mId" value="' + esc(m.modelId) + '" placeholder="如 openai/gpt-4o-mini 或本地模型名">' +
      '<label class="f">API Key（本地部署可留空）</label><input class="f" id="mKey" type="password" value="' + esc(m.apiKey) + '" placeholder="Bearer Token，可空">' +
      '<label style="display:flex;align-items:center;gap:8px;margin:12px 0;font-size:14px;color:#3a2e28"><input type="checkbox" id="mLocal"' + (m.local ? " checked" : "") + "> 本地部署模型（不走公网）</label>" +
      '<div class="form-actions">' +
        '<button class="btn-cancel" id="mCancel">取消</button>' +
        '<button class="btn-save" id="mSave">保存</button></div>';
    openGen(isEdit ? "编辑模型" : "添加模型", html);
    q("mCancel").onclick = openSettings;
    q("mSave").onclick = function () { saveModel(isEdit ? m.id : ""); };
  }

  function saveModel(editId) {
    var name = q("mName").value.trim();
    var baseUrl = q("mUrl").value.trim();
    var protocol = q("mProto").value;
    var modelId = q("mId").value.trim();
    var apiKey = q("mKey").value;
    var local = q("mLocal").checked;
    if (!name) { toast("请填模型名称"); return; }
    if (!modelId) { toast("请填模型 ID"); return; }
    var models = getModels();
    if (editId) {
      var m = models.find(function (x) { return x.id === editId; });
      if (m) { m.name = name; m.baseUrl = baseUrl; m.protocol = protocol; m.modelId = modelId; m.apiKey = apiKey; m.local = local; }
    } else {
      models.push({ id: "m_" + Date.now(), name: name, baseUrl: baseUrl, protocol: protocol, modelId: modelId, apiKey: apiKey, local: local });
    }
    save(kModels(CFG.domain), models);
    if (!getDef()) save(kDef(CFG.domain), models[0].id);
    toast("已保存"); openSettings();
  }

  function delModel(id) {
    if (!global.ask) { var models = getModels().filter(function (m) { return m.id !== id; }); commitDel(models, id); return; }
    global.ask("删除模型", "确定删除该模型配置？", [
      { t: "取消", cls: "btn-cancel", v: 0 }, { t: "删除", cls: "btn-confirm2", v: 1 }
    ], function (v) { if (v) { var ms = getModels().filter(function (m) { return m.id !== id; }); commitDel(ms, id); } });
  }
  function commitDel(models, id) {
    save(kModels(CFG.domain), models);
    if (getDef() === id) save(kDef(CFG.domain), models[0] ? models[0].id : null);
    toast("已删除"); openSettings();
  }

  function openStrategy() {
    var strat = getStrat(), models = getModels();
    var opts = ["manual", "failover", "roundrobin"].map(function (mm) {
      var label = { manual: "仅用默认模型", failover: "失败自动切换下一个", roundrobin: "多模型轮询" }[mm];
      return '<div class="bm-row"><label style="flex:1;font-size:14px;color:#3a2e28"><input type="radio" name="strat" value="' + mm + '"' + (strat.mode === mm ? " checked" : "") + "> " + label + "</label></div>";
    }).join("");
    var defOpts = models.map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === getDef() ? " selected" : "") + ">" + esc(m.name) + "</option>"; }).join("");
    var html =
      '<p style="font-size:13px;color:#3a2e28;line-height:1.6">自动调用策略：多个模型间如何切换（failover / roundrobin 需≥2 个模型）。</p>' +
      '<h4 style="color:#6b2e2e;margin:12px 0 6px">默认模型</h4>' +
      (models.length ? '<select class="f" id="sDef">' + defOpts + "</select>" : '<div class="empty-tip">请先添加模型</div>') +
      '<h4 style="color:#6b2e2e;margin:14px 0 6px">切换策略</h4>' + opts +
      '<div class="form-actions"><button class="btn-cancel" id="sBack">返回</button>' +
      '<button class="btn-save" id="sSave">保存</button></div>';
    openGen("模型自动调用策略", html);
    q("sBack").onclick = openSettings;
    q("sSave").onclick = saveStrategy;
  }
  function saveStrategy() {
    var checked = q("genBody").querySelector('input[name="strat"]:checked');
    var mode = checked ? checked.value : "manual";
    var def = q("sDef") ? q("sDef").value : getDef();
    save(kStrat(CFG.domain), { mode: mode });
    if (def) save(kDef(CFG.domain), def);
    toast("已保存策略"); openSettings();
  }

  function testModel(id) {
    var m = getModels().find(function (x) { return x.id === id; });
    if (!m) return;
    toast("正在测试连接…"); busy(true);
    chatOne(m, [{ role: "user", content: "ping，只回 pong" }]).then(function (txt) {
      busy(false);
      if (!global.ask) { toast("连接成功：" + txt.slice(0, 40)); return; }
      global.ask("连接测试", "模型「" + m.name + "」返回：<br><pre style='white-space:pre-wrap;font-size:12px'>" + esc(txt.slice(0, 200)) + "</pre>", [
        { t: "确定", cls: "btn-confirm2", v: 1 }
      ], function () {});
    }).catch(function (e) { busy(false); toast("连接失败：" + e.message); });
  }

  function exportCfg() {
    var data = { models: getModels(), default: getDef(), strategy: getStrat() };
    var s = JSON.stringify(data, null, 2);
    var html = '<p style="font-size:13px;color:#3a2e28">配置 JSON（可复制保存，再用「导入配置」恢复）：</p>' +
      '<textarea class="f" id="expText" rows="10" readonly>' + esc(s) + "</textarea>" +
      '<div class="form-actions"><button class="btn-cancel" id="expBack">返回</button>' +
      '<button class="btn-save" id="expCopy">复制</button></div>';
    openGen("导出配置", html);
    q("expBack").onclick = openSettings;
    q("expCopy").onclick = function () { var t = q("expText"); t.select(); try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("请长按文本框手动复制"); } };
  }
  function importCfg() {
    var html = '<p style="font-size:13px;color:#3a2e28">粘贴导出的配置 JSON，或选择文件：</p>' +
      '<input type="file" id="impFile" accept=".json,application/json">' +
      '<textarea class="f" id="impText" rows="6" placeholder="在此粘贴配置 JSON"></textarea>' +
      '<div class="form-actions"><button class="btn-cancel" id="impBack">取消</button>' +
      '<button class="btn-save" id="impDo">导入</button></div>';
    openGen("导入配置", html);
    q("impBack").onclick = openSettings;
    q("impFile").onchange = function () { var f = this.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { q("impText").value = r.result; }; r.readAsText(f); };
    q("impDo").onclick = doImport;
  }
  function doImport() {
    var s = q("impText").value.trim(); if (!s) { toast("请粘贴或选择文件"); return; }
    try {
      var d = JSON.parse(s);
      if (!d.models || !d.models.length) { toast("配置无效：缺少 models"); return; }
      save(kModels(CFG.domain), d.models);
      if (d.default) save(kDef(CFG.domain), d.default);
      if (d.strategy) save(kStrat(CFG.domain), d.strategy);
      toast("导入成功"); openSettings();
    } catch (e) { toast("JSON 解析失败：" + e.message); }
  }

  /* ============================ 查询融合引擎（v3.41：本地优先 → 在线兜底 → 来源标注）============================ */
  // 智能AI查询 与 知识库管理查询 共用：先搜本地 KB（命中标🔒本地）→ 未命中且允许联网 → LLM 检索（标🌐在线）
  // → 全程 resolve 不 reject，异常转成友好结果，杜绝“运行错误: script error”冒泡。
  // v3.46：根据查询文本智能注入 5 级组织上下文（用户问"京密引水管理处有几个管理所"时自动给出组织清单+建筑物分布）
  function _orgContextForQuery(qtext) {
    try {
      if (!qtext || !CFG || typeof CFG.listAll !== "function") return null;
      // v3.46：以 ORG_LEVELS 适配（ju/guanchu/suo/zhan/duan）—— 感知=perc=5级shuili；古建=spot/area/sub/point/tag
      var lvls = CFG.domain === "gujian"
        ? [{ k: "spot", t: "景区" }, { k: "area", t: "园区" }, { k: "sub", t: "子景点" }, { k: "point", t: "打卡位" }, { k: "tag", t: "标签" }]
        : [{ k: "ju", t: "局" }, { k: "guanchu", t: "管理处" }, { k: "suo", t: "所" }, { k: "zhan", t: "站" }, { k: "duan", t: "段" }];
      var recs = CFG.listAll();
      var fieldMap = CFG.domain === "gujian"
        ? { spot: "spot", area: "area", sub: "sub", point: "point", tag: "tag" }
        : { ju: "ju", guanchu: "guanchu", suo: "office", zhan: "station", duan: "chan" };
      // 命中：query 含某个组织的"显示名"或"stem"
      var matchedLvls = [];
      for (var i = 0; i < lvls.length; i++) {
        var L = lvls[i];
        var v = qtext.indexOf(L.t) >= 0;
        // 来自数据的所有 distinct 值
        var seen = {};
        recs.forEach(function (r) { var x = r[fieldMap[L.k]]; if (x) seen[x] = 1; });
        var names = Object.keys(seen);
        var matchedName = null;
        for (var n = 0; n < names.length; n++) {
          if (qtext.indexOf(names[n]) >= 0) { matchedName = names[n]; break; }
        }
        if (v || matchedName) matchedLvls.push({ level: L, count: names.length, names: names, matched: matchedName });
      }
      if (!matchedLvls.length) return null;
      var lines = matchedLvls.map(function (m) {
        return "· " + m.level.t + "（" + m.count + " 项" + (m.matched ? "，命中：" + m.matched : "") + "）：" + (m.names.slice(0, 30).join("、") + (m.names.length > 30 ? " …(共" + m.names.length + "项)" : ""));
      });
      return lines.join("\n");
    } catch (e) { return null; }
  }

  function queryEngine(qtext, progress) {
    return new Promise(function (resolve) {
      try {
        var q = (qtext || "").trim();
        if (!q) { resolve({ source: "empty", q: q }); return; }
        // v3.46：在本地知识库检索前，先用「5 级组织」视角构造预上下文（用户问"京密引水管理处有几个管理所"时，
        //   即使本地知识库没相关条目，也能让大模型基于组织清单回答）。
        var orgCtx = _orgContextForQuery(q);
        // v3.55：优先走 RAG 混合检索（向量余弦 + BM25 + 模糊包含）
        var ragHits = [];
        try { if (window.KBRag && window.KBRag.stats().chunks > 0) ragHits = kbHybridSearch(q, 8); } catch (e) {}
        var hits = ragHits.length ? ragHits : kbSearch(q).slice(0, 8);
        if (hits.length) { resolve({ source: "local", hits: hits, q: q, orgCtx: orgCtx, rag: ragHits.length > 0 }); return; }
        if (onlineEnabled() || orgCtx) {
          if (progress) progress("🌐 本地无命中，正在检索（含组织层级上下文）…");
          var msgs = [{ role: "system", content: systemPrompt() }];
          if (orgCtx) msgs.push({ role: "system", content: "【本系统 5 级组织数据（按局/管理处/所/站/段）】\n" + orgCtx });
          // RAG：把混合检索到的片段也作为上下文喂给大模型，即使关键词未直接命中
          try {
            if (window.KBRag) {
              var ctxHits = kbHybridSearch(q, 5);
              if (ctxHits.length) {
                var ragCtx = ctxHits.map(function (h, i) { return "[" + (i + 1) + "] " + (h.title || "") + "\n" + (h.snippet || ""); }).join("\n\n");
                msgs.push({ role: "system", content: "【知识库相关资料】\n" + ragCtx + "\n（引用时标注 [编号]）" });
              }
            }
          } catch (e) {}
          msgs.push({ role: "user", content: q });
          chat(msgs).then(function (txt) { resolve({ source: "online", text: txt, q: q, orgCtx: orgCtx }); })
            .catch(function (e) { resolve({ source: "online-error", error: e.message, q: q }); });
        } else {
          resolve({ source: "none", q: q });
        }
      } catch (e) { resolve({ source: "error", error: (e && e.message) || String(e), q: qtext }); }
    });
  }
  function renderQueryOutcome(res) {
    if (res.source === "empty") return '<div class="busy-sub">请输入查询内容</div>';
    if (res.source === "local") {
      var items = res.hits.map(function (r) {
        return '<div class="bm-row"><div style="flex:1"><div style="font-size:13px;font-weight:600">📄 ' + esc(r.title) + "</div>" +
          '<div style="font-size:11px;color:#aab4be">' + esc((r.tags || []).join(" ")) + "</div></div>" +
          '<button class="tbtn" data-kview="' + esc(r.id) + '">查看</button></div>';
      }).join("");
      return '<div style="font-size:12px;color:#6b2e2e;margin:6px 0">🔒 本地知识库命中 ' + res.hits.length + " 条</div>" + items;
    }
    if (res.source === "online") {
      // v3.46：在原文下方插入"进一步查询"操作提示 + 复制按钮（智能查询 → 关键词回填，深度递进）
      var hint = '<div style="margin-top:10px;padding:8px 10px;background:#fff7e6;border:1px solid #ffe7a3;border-radius:8px;font-size:12px;color:#6b4a00">💡 <b>后续操作</b>：单击下方<b>复制</b>将原句拷到查询框；<b>双击</b>「常见追问」chip 自动回填查询（无需重新输入）</div>';
      var chips = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">' +
        '<span class="chip" data-refill="查看完整列表" style="cursor:pointer">📋 完整列表</span>' +
        '<span class="chip" data-refill="' + esc(res.text.slice(0, 20)) + '（详细）" style="cursor:pointer">🔍 详细</span>' +
        '<span class="chip" data-refill="' + esc(res.text.slice(0, 20)) + '（参数）" style="cursor:pointer">📊 参数</span>' +
        '<span class="chip" data-refill="' + esc(res.text.slice(0, 20)) + '（设计）" style="cursor:pointer">🪜 设计</span>' +
      '</div>';
      return '<div style="font-size:12px;color:#2e6b4f;margin:6px 0">🌐 在线检索（本地无命中，已联网补全）</div>' +
        '<div class="md-body" id="qOnlineBody" style="background:var(--soft);border-radius:10px;padding:12px;font-size:13px;line-height:1.7;color:#3a2e28">' + md2html(res.text) + "</div>" +
        hint + chips + '<div id="qRefillHint" style="margin-top:6px;font-size:11px;color:#6b4a00"></div>';
    }
    if (res.source === "none") {
      return '<div style="font-size:13px;color:#8a7c70;background:var(--soft);border-radius:10px;padding:12px;line-height:1.6">🔒 本地知识库无相关条目。如需联网核实公开信息，请开启「🌐 联网在线查询」后重试。<br><br><b>💡 试试这么问</b>：<span class="chip" data-refill="' + esc((q("qInput") && q("qInput").value) || "") + '" style="cursor:pointer;margin-right:4px">🔁 复用原句</span> 或换更具体的名称/段名。</div>';
    }
    return '<div style="font-size:13px;color:var(--danger)">查询未能完成：' + esc(res.error || "未知错误") + "</div>";
  }

  /* ============================ 智能查询 ============================ */
  function openSmartQuery() {
    var online = onlineEnabled();
    var html =
      '<p style="font-size:13px;color:#3a2e28;line-height:1.6">智能查询：先检索本地知识库，本地无命中且已开启联网时再联网补全。结果注明来源（🔒本地 / 🌐在线）。</p>' +
      '<label style="display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px;color:#3a2e28;cursor:pointer">' +
        '<input type="checkbox" id="qOnline"' + (online ? " checked" : "") + '> 🌐 联网在线查询（关闭则仅本地知识库）</label>' +
      // v3.43：古建/感知/水利 placeholder 按 APPNAME 自动适配
      '<label class="f">查询内容</label><textarea class="f" id="qInput" rows="3" placeholder="' + (
        CFG && CFG.appName && CFG.appName.indexOf("古建") >= 0 ? "如：颐和园佛香阁的建筑年代与结构特点" :
        CFG && CFG.appName && CFG.appName.indexOf("感知") >= 0 ? "如：北台上液位传感器最近一次监测数据" :
        "如：龚庄子进水闸的设计流量与结构特点"
      ) + '"></textarea>' +
      '<div id="qHist"></div>' +
      '<div class="form-actions"><button class="btn-cancel" onclick="closeSheet(\'sheetGen\')">关闭</button>' +
      '<button class="btn-save" id="qRun">查询</button></div>' +
      '<div id="qOut" style="margin-top:12px"></div>';
    openGen("智能查询", html);
    q("qOnline").onchange = function () { setOnline(this.checked); toast(this.checked ? "已开启联网查询" : "已切换为仅本地知识库"); };
    q("qRun").onclick = function () { runQuery(); };
    renderQueryHistory();
  }
  function runQuery() {
    var qtext = q("qInput").value.trim(); if (!qtext) { toast("请输入查询内容"); return; }
    busy(true); q("qOut").innerHTML = '<div class="busy-sub">🔒 正在检索本地知识库…</div>';
    queryEngine(qtext, function (msg) { q("qOut").innerHTML = '<div class="busy-sub">' + esc(msg) + "</div>"; }).then(function (res) {
      busy(false);
      if (res.source === "online") addHist(qtext, res.text, true);
      else if (res.source === "local") addHist(qtext, "本地命中 " + res.hits.length + " 条", false);
      q("qOut").innerHTML = renderQueryOutcome(res);
      var box = q("qOut");
      if (box) box.querySelectorAll("[data-kview]").forEach(function (el) {
        el.onclick = function () { var k = kbGet(el.getAttribute("data-kview")); openGen("知识库条目", kbViewHtml(k)); q("kbBack").onclick = openSmartQuery; };
      });
      // v3.46：单击复制 + 双击回填 + 自动查询（data-refill）
      if (box) box.querySelectorAll("[data-refill]").forEach(function (el) {
        var v = el.getAttribute("data-refill") || "";
        el.onclick = function (e) {
          // 单击：把这条 chip 上的文本复制到剪贴板（不再打开新查询）
          try { navigator.clipboard && navigator.clipboard.writeText(v); } catch (e2) {}
          toast("✅ 已复制：" + v.slice(0, 30) + (v.length > 30 ? "…" : ""));
          var h = q("qRefillHint"); if (h) h.innerHTML = "📋 已复制。按住 Ctrl/⌘ 点击 取消选中，或点查询以再次执行：<b>" + esc(v) + "</b>";
        };
        el.ondblclick = function (e) {
          // 双击：自动回填 + 触发查询
          try { navigator.clipboard && navigator.clipboard.writeText(v); } catch (e2) {}
          q("qInput").value = v;
          toast("📥 已回填 + 自动查询：" + v.slice(0, 30) + (v.length > 30 ? "…" : ""));
          runQuery();
        };
      });
      if (res.source === "online") {
        box.insertAdjacentHTML("beforeend", '<div class="form-actions" style="margin-top:8px"><button class="btn-save" id="qSaveKB">💾 保存知识库（精简）</button></div>');
        q("qSaveKB").onclick = function () { saveQueryToKB(qtext, res.text); };
      }
      hermesLearn("智能查询", qtext, res.source === "online" ? res.text : ("本地命中" + res.hits.length + "条"));
      renderQueryHistory();
    });
  }

  /* ============================ 智能更新 ============================ */
  function openSmartUpdate() {
    var html =
      '<p style="font-size:13px;color:#3a2e28;line-height:1.6">' +
      (onlineEnabled() ? "选择一条记录，联网检索后自动生成可应用的更新补丁（你确认后才写入）。" : "选择一条本地记录，由模型基于本地上下文补全缺失字段（不引用外部数据）。") +
      "</p>" +
      '<label class="f">选择记录（输入名称筛选）</label><input class="f" id="uFilter" placeholder="输入名称…">' +
      '<div id="uList" style="max-height:30vh;overflow:auto;margin:8px 0"></div>' +
      '<div id="uForm" style="display:none">' +
        '<label class="f">补全/核实主题</label><textarea class="f" id="uTopic" rows="2" placeholder="如：补全保护历史与建筑特点"></textarea>' +
        '<div class="form-actions"><button class="btn-cancel" id="uHide">收起</button>' +
        '<button class="btn-save" id="uRun">生成更新</button></div>' +
        '<div id="uOut" style="margin-top:10px"></div>' +
      "</div>";
    openGen("智能更新", html);
    q("uFilter").oninput = function () { renderUpdateList(this.value.trim()); };
    q("uHide").onclick = function () { q("uForm").style.display = "none"; };
    q("uRun").onclick = runUpdate;
    renderUpdateList("");
  }
  function renderUpdateList(filter) {
    var recs = (CFG.searchRecords ? CFG.searchRecords(filter) : (CFG.listAll ? CFG.listAll() : [])).slice(0, 40);
    var box = q("uList");
    box.innerHTML = recs.map(function (r) {
      return '<div class="sel-item"><span style="flex:1;font-size:13px">' + esc(r.name) + (r.city ? ' <span style="color:#8a7c70">' + esc(r.city) + "</span>" : "") + '</span>' +
        '<button class="tbtn" data-pick="' + esc(r.id) + '">选择</button></div>';
    }).join("") || '<div class="empty-tip">无匹配记录</div>';
    bindData("data-pick", function (id) {
      pendingRecId = id;
      var r = CFG.getRecord(id);
      q("uForm").style.display = "block";
      q("uOut").innerHTML = '<div style="font-size:12px;color:#8a7c70;margin-bottom:6px">当前：' + esc(r ? r.name : "") + "</div>" + currentFieldsHtml(r);
    });
  }
  function currentFieldsHtml(r) {
    if (!r) return "";
    return CFG.fieldSchema.map(function (k) {
      return '<div style="font-size:12px;color:#3a2e28"><b>' + esc(k) + "</b>：" + esc(r[k] || "（空）") + "</div>";
    }).join("");
  }
  function runUpdate() {
    var rec = CFG.getRecord(pendingRecId); if (!rec) { toast("请先选择记录"); return; }
    var topic = q("uTopic").value.trim() || "补全缺失字段";
    var schema = CFG.fieldSchema;
    var sys = systemPrompt() + "\n你是一个数据补全助手。用户给你一条记录现有字段与主题，请返回 JSON 补丁（仅含可更新的字段），格式：\n{\"patch\":{\"字段\":\"新值\"}}\n只返回 JSON，不要解释。可更新的字段仅限：" + schema.join(", ") + "。";
    var userCtx = "现有记录：\n" + schema.map(function (k) { return k + ": " + (rec[k] || "（空）"); }).join("\n");
    userCtx += onlineEnabled() ? "\n\n主题：" + topic + "（可联网核实公开信息）" : "\n\n主题：" + topic + "（仅基于本地上下文，禁止外部臆测）";
    busy(true); q("uOut").innerHTML = '<div class="busy-sub">生成中…</div>';
    chat([{ role: "system", content: sys }, { role: "user", content: userCtx }]).then(function (txt) {
      busy(false);
      var patch = parsePatch(txt);
      if (!patch) { q("uOut").innerHTML = '<div style="color:var(--danger);font-size:13px">未能解析补丁，模型返回：<br>' + esc(txt.slice(0, 300)) + "</div>"; return; }
      showPatchPreview(rec, patch);
    }).catch(function (e) { busy(false); q("uOut").innerHTML = '<div style="color:var(--danger);font-size:13px">生成失败：' + esc(e.message) + "</div>"; });
  }
  function parsePatch(txt) {
    try {
      var s = txt.trim(), i = s.indexOf("{"), j = s.lastIndexOf("}");
      if (i >= 0 && j > i) s = s.slice(i, j + 1);
      var o = JSON.parse(s);
      if (o && o.patch && typeof o.patch === "object") return o.patch;
      if (o && typeof o === "object") return o;
    } catch (e) {}
    return null;
  }
  function showPatchPreview(rec, patch) {
    pendingPatch = patch;
    var rows = Object.keys(patch).filter(function (k) { return CFG.fieldSchema.indexOf(k) >= 0; }).map(function (k, idx) {
      return '<div style="font-size:13px;margin:6px 0"><label style="display:block;font-size:12px;color:#8a7c70">' + esc(k) + "</label>" +
        '<textarea class="f" id="pk_' + idx + '" rows="2" data-k="' + esc(k) + '">' + esc(patch[k]) + "</textarea></div>";
    }).join("");
    if (!rows) { q("uOut").innerHTML = '<div style="color:#8a7c70;font-size:13px">模型未给出可更新字段</div>'; return; }
    q("uOut").innerHTML = '<div style="background:var(--soft);border-radius:10px;padding:10px;margin-bottom:8px"><b style="color:#6b2e2e">更新预览（可修改后应用）</b>' + rows + "</div>" +
      '<div class="form-actions"><button class="btn-cancel" id="uCancel">取消</button>' +
      '<button class="btn-save" id="uApply">应用更新</button></div>';
    q("uCancel").onclick = function () { q("uOut").innerHTML = ""; };
    q("uApply").onclick = applyPatch;
  }
  function applyPatch() {
    var rec = CFG.getRecord(pendingRecId); if (!rec) { toast("记录丢失"); return; }
    if (!pendingPatch) { toast("无补丁"); return; }
    var keys = Object.keys(pendingPatch).filter(function (k) { return CFG.fieldSchema.indexOf(k) >= 0; });
    keys.forEach(function (k, i) { var el = q("pk_" + i); if (el) pendingPatch[k] = el.value; }); // 读取用户修改后的值，再应用
    try { CFG.applyUpdate(rec, pendingPatch); toast("已应用更新"); q("uOut").innerHTML = '<div style="color:#6b2e2e;font-size:13px">✅ 已更新「' + esc(rec.name) + "」</div>";
      kbAdd({ title: "更新「" + (rec.name || "") + "」", tags: ["operation", "智能更新"], type: "operation", buildingId: rec.id },
        keys.map(function (k) { return k + "：" + pendingPatch[k]; }).join("\n"));
      hermesLearn("智能更新", (rec.name || "") + " " + JSON.stringify(pendingPatch), "已应用更新");
    }
    catch (e) { toast("应用失败：" + e.message); }
  }

  /* ============================ 智能纠错 ============================ */
  function corrections() { return load(kCorr(CFG.domain), []); }
  function correctionsHtml() {
    var list = corrections();
    if (!list.length) return '<div class="empty-tip">暂无标注</div>';
    return list.map(function (c, i) {
      return '<div class="bm-row"><div style="flex:1"><div style="font-size:13px;font-weight:600">' + esc(c.name) + "</div>" +
        '<div style="font-size:12px;color:#8a7c70">' + esc(c.note) + "</div>" +
        '<div style="font-size:11px;color:#aab4be">' + esc(c.ts || "") + "</div></div>" +
        '<button class="tbtn" data-rm="' + i + '">删除</button></div>';
    }).join("");
  }
  function openSmartCorrect() {
    var html =
      '<p style="font-size:13px;color:#3a2e28;line-height:1.6">' +
      (onlineEnabled() ? "选择一条记录，联网核对公开说法；若本 app 信息正确而网上有误，可标注差异留存。" : "选择一条本地记录，标注存疑项交由人工复核（内部数据不联网比对）。") +
      "</p>" +
      '<label class="f">选择记录</label><input class="f" id="cFilter" placeholder="输入名称…">' +
      '<div id="cList" style="max-height:26vh;overflow:auto;margin:8px 0"></div>' +
      '<div id="cForm" style="display:none">' +
        (onlineEnabled()
          ? '<label class="f">核对主题</label><textarea class="f" id="cTopic" rows="2" placeholder="如：核对网上关于其年代的记载"></textarea>' +
            '<div class="form-actions"><button class="btn-cancel" id="cHide">收起</button>' +
            '<button class="btn-save" id="cRun">联网核对</button></div>'
          : '<div style="font-size:13px;color:#8a7c70">内部数据无公开来源，请直接填写存疑说明：</div>' +
            '<textarea class="f" id="cNote" rows="3" placeholder="如：该设备型号疑似记录有误，待核实"></textarea>' +
            '<div class="form-actions"><button class="btn-cancel" id="cHide">收起</button>' +
            '<button class="btn-save" id="cSave">保存标注</button></div>') +
        '<div id="cOut" style="margin-top:10px"></div>' +
      "</div>" +
      '<h4 style="color:#6b2e2e;margin:14px 0 6px">已标注（' + corrections().length + "）</h4>" +
      '<div id="cList2">' + correctionsHtml() + "</div>";
    openGen("智能纠错", html);
    q("cFilter").oninput = function () { renderCorrectList(this.value.trim()); };
    q("cHide").onclick = function () { q("cForm").style.display = "none"; };
    if (onlineEnabled()) q("cRun").onclick = runCorrect; else q("cSave").onclick = addCorrection;
    bindData("data-rm", function (i) { var list = corrections(); list.splice(+i, 1); save(kCorr(CFG.domain), list); openSmartCorrect(); });
    renderCorrectList("");
  }
  function renderCorrectList(filter) {
    var recs = (CFG.searchRecords ? CFG.searchRecords(filter) : (CFG.listAll ? CFG.listAll() : [])).slice(0, 40);
    var box = q("cList");
    box.innerHTML = recs.map(function (r) {
      return '<div class="sel-item"><span style="flex:1;font-size:13px">' + esc(r.name) + "</span><button class=\"tbtn\" data-cpick=\"" + esc(r.id) + "\">选择</button></div>";
    }).join("") || '<div class="empty-tip">无匹配记录</div>';
    bindData("data-cpick", function (id) {
      pendingRecId = id;
      var r = CFG.getRecord(id);
      q("cForm").style.display = "block";
      q("cOut").innerHTML = '<div style="font-size:12px;color:#8a7c70">当前：' + esc(r ? r.name : "") + "</div>";
    });
  }
  function runCorrect() {
    var rec = CFG.getRecord(pendingRecId); if (!rec) { toast("请先选择记录"); return; }
    var topic = q("cTopic").value.trim() || "核对本记录与公开记载的差异";
    var sys = systemPrompt() + "\n请联网核实公开资料，并与用户提供的本 app 记录逐字段比对。" +
      "若本 app 信息正确而网上有误，请明确指出差异并给出结论。仅返回 JSON：\n" +
      '{"appCorrect":true/false,"diffs":[{"field":"字段","app":"本app值","online":"网上说法"}],"conclusion":"结论"}';
    var userCtx = "本 app 记录：\n" + CFG.fieldSchema.map(function (k) { return k + ": " + (rec[k] || "（空）"); }).join("\n") + "\n\n核对主题：" + topic;
    busy(true); q("cOut").innerHTML = '<div class="busy-sub">核对中…</div>';
    chat([{ role: "system", content: sys }, { role: "user", content: userCtx }]).then(function (txt) {
      busy(false);
      var o = parseCorrect(txt);
      if (!o) { q("cOut").innerHTML = '<div style="color:var(--danger);font-size:13px">未能解析：<br>' + esc(txt.slice(0, 300)) + "</div>"; return; }
      var diffs = (o.diffs || []).map(function (d) { return '<div style="font-size:12px;margin:3px 0"><b>' + esc(d.field) + "</b>：本app「" + esc(d.app) + "」 vs 网上「" + esc(d.online) + "」</div>"; }).join("");
      q("cOut").innerHTML =
        '<div style="background:var(--soft);border-radius:10px;padding:10px;font-size:13px;line-height:1.6">' +
        "<div>结论：" + (o.appCorrect ? "✅ 本app信息正确" : "⚠️ 可能存在差异") + "</div>" + diffs + "</div>" +
        '<div class="form-actions"><button class="btn-cancel" id="cClose">关闭</button>' +
        '<button class="btn-save" id="cMark">标注差异</button></div>';
      q("cClose").onclick = function () { q("cOut").innerHTML = ""; };
      q("cMark").onclick = function () { saveCorrectionNote(typeof o.conclusion === "string" ? o.conclusion : "（联网核对标注）"); };
    }).catch(function (e) { busy(false); q("cOut").innerHTML = '<div style="color:var(--danger);font-size:13px">核对失败：' + esc(e.message) + "</div>"; });
  }
  function parseCorrect(txt) {
    try { var s = txt.trim(), i = s.indexOf("{"), j = s.lastIndexOf("}"); if (i >= 0 && j > i) s = s.slice(i, j + 1); return JSON.parse(s); } catch (e) { return null; }
  }
  function saveCorrectionNote(note) {
    var rec = CFG.getRecord(pendingRecId); if (!rec) { toast("记录丢失"); return; }
    saveCorrection(rec.name, note || "（联网核对标注）");
  }
  function addCorrection() {
    var rec = CFG.getRecord(pendingRecId); if (!rec) { toast("请先选择记录"); return; }
    var note = q("cNote") ? q("cNote").value.trim() : "";
    if (!note) { toast("请填写存疑说明"); return; }
    saveCorrection(rec.name, note);
  }
  function saveCorrection(name, note) {
    var list = corrections();
    list.unshift({ name: name, note: note, ts: new Date().toLocaleString("zh-CN"), domain: CFG.domain });
    save(kCorr(CFG.domain), list);
    hermesLearn("智能纠错", name, note); // v3.38：Hermes 自我学习
    toast("已标注"); openSmartCorrect();
  }

  /* ============================ 知识库（md + json 混合 + Hermes 自我学习）============================ */
  // 架构：每条目 = 元数据(.json: id/title/tags/type/source/ts/buildingId) + 正文(.md)
  //   小数据直喂 md；大数据用轻量评分先查 index 再读 body。导入/导出 zip 打包 .md+.json。
  function kKB(d) { return "kb_" + d; }
  function kbLoad() {
    var o = load(kKB(CFG.domain), null);
    if (!o || !o.index) o = { index: [], bodies: {} };
    if (!o.bodies) o.bodies = {};
    if (!o.chunks) o.chunks = {};
    if (!o.chunkSigs) o.chunkSigs = {};
    return o;
  }
  /* —— 保存前切片（v3.54）：条目入库/更新时先按句切片再落盘，语句保持相对完整 ——
   * 与 kb_rag.js 的 chunkText 同一套规则（整句优先、句末标点收口、仅超长句才按逗号级再切），
   * kb_rag.js 未加载时也能切片；kbSave 作为唯一写入口统一兜底同步切片。 */
  function kbSplitSents(s) {
    var out = [], cur = "";
    for (var i = 0; i < s.length; i++) {
      cur += s.charAt(i);
      if (/[。！？；!?;\n]/.test(s.charAt(i))) { if (cur.trim()) out.push(cur); cur = ""; }
    }
    if (cur.trim()) out.push(cur);
    return out.length ? out : [s];
  }
  function kbSplitClauses(s) {
    var out = [], cur = "";
    for (var i = 0; i < s.length; i++) {
      cur += s.charAt(i);
      if (/[，,、：:]/.test(s.charAt(i))) { if (cur.trim()) out.push(cur); cur = ""; }
    }
    if (cur.trim()) out.push(cur);
    return out.length ? out : [s];
  }
  function kbSliceText(text, size, overlap) {
    size = size || 520; overlap = overlap || 80;
    var body = String(text || "").trim();
    if (!body) return [];
    var sents = [], raw = body.split(/\n(?=\s*#{1,6}\s|\s*【)|\n\s*\n/);
    raw.forEach(function (b) {
      kbSplitSents(b).forEach(function (s) {
        if (s.length <= size) { sents.push(s); return; }
        var subs = kbSplitClauses(s), acc = "";
        subs.forEach(function (c) {
          if ((acc + c).length > size && acc) { sents.push(acc); acc = c; }
          else acc += c;
        });
        if (acc.trim()) sents.push(acc);
      });
    });
    var flat = [];
    sents.forEach(function (s) {
      if (s.length > size * 1.6) { var i = 0; while (i < s.length) { flat.push(s.substr(i, size)); i += size; } }
      else flat.push(s);
    });
    var out = [], cur = "", curSents = [];
    function pushCur() { if (cur.trim()) out.push(cur.trim()); }
    flat.forEach(function (s) {
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
  function kbSlice(md) { return kbSliceText(md); }
  function kbSliceSig(body) { body = String(body || ""); return body.length + ":" + body.slice(0, 16) + ":" + body.slice(-16); }
  // 切片同步：正文变了（或首次入库）才重切，签名避免重复切片开销
  function kbSyncChunks(o, id, title, body) {
    var sig = kbSliceSig(body);
    if (o.chunkSigs[id] === sig && o.chunks[id]) return;
    o.chunks[id] = kbSliceText((title ? title + "\n" : "") + (body || ""));
    o.chunkSigs[id] = sig;
  }
  function kbSave(o) {
    // 保存前统一切片：kbAdd / 各类导入 / Hermes 沉淀 / 查询保存 全部经此写入口
    try {
      if (o && o.index) {
        o.chunks = o.chunks || {}; o.chunkSigs = o.chunkSigs || {};
        o.index.forEach(function (m) {
          kbSyncChunks(o, m.id, m.title || "", (o.bodies && o.bodies[m.id]) || "");
        });
      }
    } catch (e) {}
    save(kKB(CFG.domain), o);
  }
  function kbAdd(meta, md) {
    var o = kbLoad();
    var id = "kb_" + Date.now() + "_" + Math.floor(Math.random() * 1e4).toString(36);
    meta = meta || {};
    o.index.unshift({
      id: id, title: meta.title || "未命名", tags: meta.tags || [], type: meta.type || "note",
      source: meta.source || "", buildingId: meta.buildingId || null,
      ts: new Date().toLocaleString("zh-CN"), domain: CFG.domain
    });
    o.bodies[id] = md || "";
    kbSave(o);   // kbSave 内先切片再落盘
    // RAG：入库即用已存切片向量化（异步，失败不影响入库）
    try { kbRagAdd({ id: id, title: meta.title || "未命名", body: md || "", type: meta.type || "note", source: meta.source || "", chunks: (o.chunks && o.chunks[id]) || null }); } catch (e) {}
    return id;
  }
  // —— RAG（kb_rag.js 懒加载）——
  function kbRagEnsure() {
    if (window.KBRag) return Promise.resolve(window.KBRag);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "kb_rag.js";
      s.onload = function () {
        if (!window.KBRag) { rej(new Error("RAG 脚本异常")); return; }
        window.KBRag.init({
          domain: CFG.domain, chat: chat,
          // hermes 自学习：把「问题 + 命中来源 + 答案」沉淀为 hermes 条目（operation 固定为「智能问答」）
          hermesLearn: function (q, a, hits) {
            try {
              var src = (hits || []).map(function (h) { return h.title || h.source || h.docId; }).slice(0, 3).join("、");
              hermesLearn("智能问答", "问题：" + q + "\n命中来源：" + src, a);
            } catch (e) {}
          }
        });
        res(window.KBRag);
      };
      s.onerror = function () { rej(new Error("RAG 组件缺失（assets/kb_rag.js）")); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function kbRagAdd(doc) {
    try {
      if (!window.KBRag) { kbRagEnsure().then(function (R) { R.addDoc(doc); }).catch(function () {}); return; }
      window.KBRag.addDoc(doc);
    } catch (e) {}
  }
  // 把现有知识库全量重建为向量索引（带进度）
  function kbRagRebuild(onProgress) {
    return kbRagEnsure().then(function (R) {
      var o = kbLoad();
      var docs = o.index.map(function (m) { return { id: m.id, title: m.title, body: o.bodies[m.id] || "", type: m.type, source: m.source, chunks: (o.chunks && o.chunks[m.id]) || null }; });
      return R.buildIndex(docs, onProgress);
    });
  }
  // 混合检索（向量+关键词+模糊）；RAG 不可用时退回原关键词检索
  function kbHybridSearch(q, topK) {
    if (window.KBRag) {
      var hits = window.KBRag.search(q, { topK: topK || 6 });
      if (hits && hits.length) return hits.map(function (h) {
        return { id: h.docId, title: h.title || "(无标题)", tags: [h.source || h.type || ""], snippet: h.text.slice(0, 220), score: h.score, detail: h.detail };
      });
    }
    return kbSearch(q).slice(0, topK || 6);
  }
  function kbGet(id) { var o = kbLoad(); return { meta: o.index.find(function (x) { return x.id === id; }) || null, md: o.bodies[id] || "" }; }
  function kbRemove(id) { var o = kbLoad(); o.index = o.index.filter(function (x) { return x.id !== id; }); delete o.bodies[id]; delete o.chunks[id]; delete o.chunkSigs[id]; kbSave(o); }
  // BM25-lite：关键词在 title+tags+md 上的命中评分
  function kbScore(rec, q) {
    if (!q) return 1;
    var hay = (rec.title + " " + (rec.tags || []).join(" ") + " " + (kbLoad().bodies[rec.id] || "")).toLowerCase();
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean), s = 0;
    terms.forEach(function (t) { var i = 0; while ((i = hay.indexOf(t, i)) >= 0) { s++; i += t.length; } });
    return s;
  }
  function kbSearch(q) {
    var o = kbLoad();
    var list = o.index.map(function (rec) { return { rec: rec, s: kbScore(rec, q) }; });
    if (q) list = list.filter(function (x) { return x.s > 0; });
    list.sort(function (a, b) { return b.s - a.s; });
    return list.map(function (x) { return x.rec; });
  }
  function kbList() { return kbLoad().index; }
  // 本地知识库上下文字符串（供后续查询注入 Hermes 笔记，实现自我学习）
  function kbContext(limit) {
    var list = kbList().filter(function (r) { return r.type === "hermes" || r.type === "operation"; }).slice(0, limit || 12);
    if (!list.length) return "";
    return list.map(function (r) {
      return "【" + r.type + "】" + r.title + (r.buildingId ? " (#" + r.buildingId + ")" : "") + "：" +
        (kbLoad().bodies[r.id] || "").replace(/\n+/g, " ").slice(0, 240);
    }).join("\n");
  }
  // v3.53：导出改为主流知识库格式 md / txt / html（Obsidian/Notion 等可直接导入），zip 备份退役
  // v3.5x：知识库导出——先弹窗让用户自定义文件名（默认 知识库_YYYYMMDD.md/txt/html）与保存文件夹（安卓原生可指定目录），再导出
  function kbExport(fmt) {
    try {
      var o = kbLoad();
      if (!o.index.length) { toast("知识库为空，无可导出内容"); return; }
      var now = new Date();
      function pad2(n) { return (n < 10 ? "0" : "") + n; }
      var dateS = "" + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
      var defName = "知识库_" + dateS + "." + fmt;
      var html =
        '<p style="font-size:13px;color:#3a2e28;line-height:1.6">将导出知识库 <b>' + o.index.length + '</b> 条为 <b>' + String(fmt).toUpperCase() + '</b> 文件（md/txt/html 均可被 Obsidian/Notion 等主流知识库直接导入）。</p>' +
        '<label class="f" style="display:block;margin:8px 0 4px">文件名（默认：知识库_' + dateS + '.' + fmt + '）</label>' +
        '<input class="f" id="kbExpName" style="width:100%;box-sizing:border-box" value="' + esc(defName) + '">' +
        '<label class="f" style="display:block;margin:8px 0 4px">保存文件夹（安卓原生可指定目录；Win/统信/网页留空=系统下载目录）</label>' +
        '<input class="f" id="kbExpDir" style="width:100%;box-sizing:border-box" placeholder="如：知识库导出（可留空）">' +
        '<div class="form-actions">' +
          '<button class="btn-save" id="kbExpOk" style="flex:1">⬇️ 导出</button>' +
          '<button class="btn-cancel" id="kbExpCancel" style="flex:1">取消</button>' +
        '</div>';
      openGen("知识库导出（" + String(fmt).toUpperCase() + "）", html);
      q("kbExpOk").onclick = function () {
        var name = (q("kbExpName") && q("kbExpName").value || "").trim() || defName;
        if (!/\.[a-zA-Z0-9]+$/.test(name)) name = name + "." + fmt;
        var folder = (q("kbExpDir") && q("kbExpDir").value || "").trim();
        kbExportSave(name, folder, fmt, o);
      };
      q("kbExpCancel").onclick = function () { kbCloseGen(); };
    } catch (e) { try { toast("导出失败：" + (e && e.message || e)); } catch (e2) {} }
  }
  function kbExportSave(name, folder, fmt, o) {
    try {
      var doc = kbBuildDoc(fmt, o);
      var A = (typeof window !== "undefined") ? window.Android : null;
      var saved = false, where = "";
      if (A && typeof A.saveBlobTo === "function") {
        var b64 = kbToB64(doc);
        if (b64) { A.saveBlobTo("data:application/octet-stream;base64," + b64, folder || "", name); saved = true; where = "Download/" + (folder || "") + "/" + name; }
      }
      if (!saved) {
        var mime = (fmt === "html") ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
        downloadBlob(name, new Blob([doc], { type: mime }));
        where = "系统下载目录：" + name + (folder ? "（当前环境不支持自选文件夹，已忽略：" + folder + "）" : "");
      }
      toast("已导出 " + o.index.length + " 条：" + where);
      kbCloseGen();
    } catch (e) { try { toast("导出失败：" + (e && e.message || e)); } catch (e2) {} }
  }
  function kbToB64(s) {
    try { return btoa(unescape(encodeURIComponent(s))); } catch (e) { return ""; }
  }
  function kbCloseGen() {
    try { if (global.closeSheet) global.closeSheet("sheetGen"); else if (window.closeSheet) window.closeSheet("sheetGen"); } catch (e) {}
  }
  function kbBuildDoc(fmt, o) {
    var parts = o.index.map(function (m) {
      return {
        title: m.title || "未命名",
        meta: "标签：" + (m.tags || []).join("、") + (m.source ? "｜来源：" + m.source : "") + "｜时间：" + (m.ts || ""),
        body: o.bodies[m.id] || ""
      };
    });
    var head = "知识库导出（" + (CFG.domain || "") + " · " + new Date().toLocaleString("zh-CN") + "）";
    if (fmt === "md") {
      return "# " + head + "\n\n" + parts.map(function (p) {
        return "## " + p.title + "\n\n> " + p.meta + "\n\n" + p.body;
      }).join("\n\n---\n\n");
    }
    if (fmt === "txt") {
      return head + "\n\n" + parts.map(function (p) {
        return "【" + p.title + "】\n" + p.meta + "\n" + p.body;
      }).join("\n\n====================\n\n");
    }
    // html（默认）
    var body = parts.map(function (p) {
      return '<section><h2>' + esc(p.title) + '</h2><p class="kb-meta">' + esc(p.meta) + "</p>" + mdLiteToHtml(p.body) + "</section>";
    }).join("\n<hr>\n");
    return "<!doctype html><html><head><meta charset='utf-8'><title>" + esc(head) + "</title>" +
      "<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:820px;margin:24px auto;padding:0 12px;line-height:1.65;color:#222}.kb-meta{color:#888;font-size:12px;margin:4px 0 10px}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 8px}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}pre{background:#f6f8fa;padding:10px;border-radius:6px;overflow:auto}blockquote{border-left:3px solid #ddd;margin:6px 0;padding:2px 10px;color:#666}</style>" +
      "</head><body><h1>" + esc(head) + "</h1>" + body + "</body></html>";
  }
  // 轻量 Markdown → HTML（标题/加粗/行内代码/列表/引用/表格/段落），供 html 导出用
  function mdLiteToHtml(md) {
    var lines = String(md || "").split(/\r?\n/), out = [], inUl = false, inTable = false;
    function closeAll() { if (inUl) { out.push("</ul>"); inUl = false; } if (inTable) { out.push("</table>"); inTable = false; } }
    function inline(s) {
      s = esc(s);
      return s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    }
    lines.forEach(function (ln) {
      var h = ln.match(/^(#{1,6})\s+(.*)$/);
      var ul = ln.match(/^\s*[-*]\s+(.*)$/);
      var row = ln.match(/^\s*\|(.+)\|\s*$/);
      if (h) {
        closeAll();
        var lv = Math.min(h[1].length + 1, 6);
        out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">");
      } else if (row) {
        if (inUl) { out.push("</ul>"); inUl = false; }
        var cells = row[1].split("|");
        if (/^[\s:-]+$/.test(row[1]) && cells.every(function (c) { return /^\s*-+\s*$/.test(c) || c.trim() === ""; })) return; // 表头分隔行
        if (!inTable) { out.push("<table>"); inTable = true; out.push("<tr>" + cells.map(function (c) { return "<th>" + inline(c.trim()) + "</th>"; }).join("") + "</tr>"); }
        else out.push("<tr>" + cells.map(function (c) { return "<td>" + inline(c.trim()) + "</td>"; }).join("") + "</tr>");
      } else if (ul) {
        if (inTable) { out.push("</table>"); inTable = false; }
        if (!inUl) { out.push("<ul>"); inUl = true; }
        out.push("<li>" + inline(ul[1]) + "</li>");
      } else if (/^>\s?/.test(ln)) {
        closeAll(); out.push("<blockquote>" + inline(ln.replace(/^>\s?/, "")) + "</blockquote>");
      } else if (ln.trim() === "") {
        closeAll();
      } else {
        closeAll(); out.push("<p>" + inline(ln) + "</p>");
      }
    });
    closeAll();
    return out.join("\n");
  }
  function kbImportZip(file) {
    try {
      var JSZip = global.JSZip;
      if (!JSZip) { toast("未加载 zip 库，无法导入"); return; }
      var reader = new FileReader();
      reader.onerror = function () { try { toast("读取压缩包失败：" + (file && file.name || "")); } catch (e) {} };
      reader.onload = function () {
        try {
          JSZip.loadAsync(reader.result).then(function (zip) {
            var o = kbLoad(), cnt = 0; var proms = [];
            zip.forEach(function (path, entry) {
              if (entry.dir) return;
              if (/kb_index\.json$/i.test(path)) return;
              if (/\.json$/i.test(path)) {
                proms.push(entry.async("string").then(function (txt) {
                  try {
                    var m = JSON.parse(txt); if (!m || !m.id) return;
                    var rec = { id: m.id, title: m.title || "未命名", tags: m.tags || [], type: m.type || "note", source: m.source || "", buildingId: m.buildingId || null, ts: m.ts || new Date().toLocaleString("zh-CN"), domain: CFG.domain };
                    var ex = o.index.find(function (x) { return x.id === m.id; }); if (ex) Object.assign(ex, rec); else o.index.unshift(rec);
                    if (o.bodies[m.id] == null) o.bodies[m.id] = ""; cnt++;
                  } catch (e) {}
                }));
              } else if (/\.md$/i.test(path)) {
                proms.push(entry.async("string").then(function (txt) {
                  var fid = path.split("/").pop().replace(/\.md$/i, "").replace(/[^\w.-]/g, "_");
                  var m = o.index.find(function (x) { return x.id.replace(/[^\w.-]/g, "_") === fid; });
                  if (m) o.bodies[m.id] = txt; else o.bodies["orphan_" + fid] = txt;
                }));
              }
            });
            Promise.all(proms).then(function () { kbSave(o); toast("已导入 " + cnt + " 条知识库条目"); openKB(); });
          }).catch(function (e) { toast("zip 解析失败：" + (e && e.message || e)); });
        } catch (e) { toast("导入出错：" + (e && e.message || e)); }
      };
      reader.readAsArrayBuffer(file);
    } catch (e) { try { toast("导入出错：" + (e && e.message || e)); } catch (e2) {} }
  }
  // v3.53：导入文档（md/txt/html/json，兼容旧 zip）——按标题智能分条，同名条目更新正文不重复
  function kbImportDoc(file) {
    try {
      var name = file.name || "文档", lower = name.toLowerCase();
      var ext = (lower.match(/\.([a-z0-9]+)$/) || [0, "txt"])[1];
      var reader = new FileReader();
      reader.onerror = function () { try { toast("读取文件失败：" + name); } catch (e) {} };
      reader.onload = function () {
        try {
          var raw = (typeof reader.result === "string") ? reader.result : new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(reader.result));
          var entries = [];
          if (/^(html?|htm)$/.test(ext)) {
            entries = kbSplitHtml(raw);
          } else if (/^(md|markdown)$/.test(ext)) {
            entries = kbSplitMd(raw);
          } else if (ext === "json") {
            // 兼容旧版 JSON 备份（{index, bodies}）
            try {
              var j = JSON.parse(raw);
              if (j && j.index && j.bodies) {
                var o0 = kbLoad(), c0 = 0;
                j.index.forEach(function (m) {
                  if (!m || !m.id) return;
                  var rec = { id: m.id, title: m.title || "未命名", tags: m.tags || [], type: m.type || "note", source: m.source || "", buildingId: m.buildingId || null, ts: m.ts || new Date().toLocaleString("zh-CN"), domain: CFG.domain };
                  var ex0 = o0.index.find(function (x) { return x.id === m.id; }); if (ex0) Object.assign(ex0, rec); else o0.index.unshift(rec);
                  if (o0.bodies[m.id] == null) o0.bodies[m.id] = j.bodies[m.id] || ""; c0++;
                });
                kbSave(o0); toast("已导入 JSON 备份 " + c0 + " 条"); openKB(); return;
              }
            } catch (e) {}
            entries = [{ title: name.replace(/\.[^.]+$/, ""), body: raw.slice(0, 20000) }];
          } else {
            entries = kbSplitTxt(raw);
          }
          entries = entries.filter(function (e) { return (e.title || "").trim() || (e.body || "").trim(); });
          if (!entries.length) { toast("未解析出可入库内容（" + name + "）"); return; }
          var o = kbLoad(), add = 0, upd = 0;
          entries.forEach(function (en, i) {
            var title = ((en.title || "").trim() || name.replace(/\.[^.]+$/, "")).slice(0, 60) || ("未命名" + (i + 1));
            var body = String(en.body || "").replace(/\n{3,}/g, "\n\n").trim();
            if (!body && !title) return;
            var ex = o.index.find(function (x) { return x.title === title; });
            if (ex) { o.bodies[ex.id] = body; ex.ts = new Date().toLocaleString("zh-CN"); upd++; }
            else {
              var id = "kb_" + Date.now() + "_" + Math.floor(Math.random() * 1e4).toString(36) + "_" + i;
              o.index.unshift({ id: id, title: title, tags: ["文档导入", ext], type: "external", source: name, buildingId: null, ts: new Date().toLocaleString("zh-CN"), domain: CFG.domain });
              o.bodies[id] = body; add++;
            }
          });
          kbSave(o);
          toast("导入完成：新增 " + add + " 条、更新 " + upd + " 条");
          openKB();
        } catch (e) { try { toast("导入出错：" + (e && e.message || e)); } catch (e2) {} }
      };
      reader.readAsText(file);
    } catch (e) { try { toast("导入出错：" + (e && e.message || e)); } catch (e2) {} }
  }
  // md 按 1-2 级标题分条
  function kbSplitMd(md) {
    var lines = String(md || "").split(/\r?\n/), entries = [], cur = null;
    lines.forEach(function (ln) {
      var m = ln.match(/^(#{1,2})\s+(.+)$/);
      if (m) { if (cur) entries.push(cur); cur = { title: m[2].trim(), body: "" }; }
      else { if (!cur) cur = { title: "", body: "" }; cur.body += ln + "\n"; }
    });
    if (cur) entries.push(cur);
    return entries.map(function (e) { e.body = String(e.body || "").replace(/\n{3,}/g, "\n\n").trim(); return e; });
  }
  // txt 按【标题】分节；无分节标记则整文件一条
  function kbSplitTxt(txt) {
    txt = String(txt || "");
    var parts = txt.split(/\r?\n(?=【[^】\n]{1,60}】\s*(?:\r?\n|$))/);
    if (parts.length > 1) {
      return parts.map(function (p) {
        var m = p.match(/^【([^】]+)】\s*\n?/);
        return m ? { title: m[1].trim(), body: p.slice(m[0].length).trim() } : { title: "", body: p.trim() };
      });
    }
    return [{ title: "", body: txt.trim() }];
  }
  // html 按 h1-h3 分条，块级元素转 Markdown
  function kbSplitHtml(html) {
    try {
      var d = new DOMParser().parseFromString(html, "text/html");
      var docTitle = (d.title || "").trim();
      var entries = [], cur = null;
      var nodes = d.body ? d.body.children : [];
      Array.prototype.forEach.call(nodes, function (el) {
        var tag = (el.tagName || "").toLowerCase();
        if (/^h[1-3]$/.test(tag)) {
          if (cur) entries.push(cur);
          cur = { title: (el.textContent || "").trim(), body: "" };
        } else {
          if (!cur) cur = { title: docTitle, body: "" };
          cur.body += kbHtmlBlockToMd(el) + "\n";
        }
      });
      if (cur) entries.push(cur);
      if (!entries.length && (docTitle || (d.body && d.body.textContent.trim()))) {
        entries.push({ title: docTitle, body: (d.body ? d.body.textContent : "").trim() });
      }
      return entries;
    } catch (e) { return [{ title: "", body: extractTextFromHtml(html) }]; }
  }
  function kbHtmlBlockToMd(el) {
    try {
      var tag = (el.tagName || "").toLowerCase();
      var txt = function (n) { return (n.textContent || "").replace(/\s+/g, " ").trim(); };
      if (/^h[4-6]$/.test(tag)) return "#### " + txt(el);
      if (tag === "ul" || tag === "ol") {
        return Array.prototype.map.call(el.children, function (li, i) { return (tag === "ol" ? (i + 1) + ". " : "- ") + txt(li); }).join("\n");
      }
      if (tag === "table") {
        var rows = Array.prototype.map.call(el.rows || el.querySelectorAll("tr"), function (tr) {
          return Array.prototype.map.call(tr.cells, function (td) { return txt(td).replace(/\|/g, "\\|"); });
        });
        if (!rows.length) return "";
        var n = Math.max.apply(null, rows.map(function (r) { return r.length; }));
        var pad = function (r) { while (r.length < n) r.push(""); return r; };
        var head = pad(rows[0]);
        var lines = ["| " + head.join(" | ") + " |", "|" + head.map(function () { return " --- "; }).join("|") + "|"];
        rows.slice(1).forEach(function (r) { lines.push("| " + pad(r).join(" | ") + " |"); });
        return lines.join("\n");
      }
      if (tag === "hr") return "---";
      if (tag === "blockquote") return "> " + txt(el);
      if (tag === "pre") return "```\n" + (el.textContent || "").trim() + "\n```";
      var kids = el.children || [];
      if (kids.length) {
        return Array.prototype.map.call(kids, kbHtmlBlockToMd).filter(function (s) { return String(s).trim(); }).join("\n") + "\n" + (Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return (n.textContent || "").trim(); }).filter(Boolean).join(" ") || "");
      }
      return txt(el);
    } catch (e) { return (el.textContent || "").trim(); }
  }
  // v3.53：外部文件（pdf/docx/xlsx/csv 等非 md 格式）智能转 Markdown 入库，全过程进度条
  function kbImportExternal(file) {
    try {
      var name = file.name || "外部文件", lower = name.toLowerCase();
      var ext = (lower.match(/\.([a-z0-9]+)$/) || [0, ""])[1];
      var title = name.replace(/\.[^.]+$/, "").slice(0, 60) || "外部文档";
      openGen("外部文件 → Markdown（智能转换）",
        '<div style="font-size:13px;color:#3a2e28;margin-bottom:8px">📄 ' + esc(name) + "</div>" +
        '<div id="kbConvMsg" style="font-size:12px;color:#8a7c70;margin-bottom:6px">准备中…</div>' +
        '<div style="background:#e8e2da;border-radius:8px;height:14px;overflow:hidden">' +
        '<div id="kbConvBar" style="width:4%;height:100%;background:linear-gradient(90deg,#4a90d9,#6bbd6b);transition:width .25s"></div></div>' +
        '<div style="font-size:11px;color:#aaa;margin-top:6px">支持 .pdf / .docx / .xlsx / .csv / 图片(.jpg/.png等) 离线转换；扫描版 PDF 与图片自动 OCR 识别（内置引擎，首次使用需加载数秒）；旧版 .doc/.xls 请先另存为 .docx/.xlsx</div>');
      function prog(p, msg) { var b = q("kbConvBar"), m = q("kbConvMsg"); if (b) b.style.width = Math.max(0, Math.min(100, Math.round(p))) + "%"; if (m) m.textContent = msg; }
      function fail(msg) { prog(100, "❌ " + msg); try { toast(msg); } catch (e) {} setTimeout(function () { openKB(); }, 1500); }
      function done(mdBody) {
        prog(92, "步骤 4/4：存入知识库…");
        setTimeout(function () {
          try {
            mdBody = String(mdBody || "").replace(/\n{3,}/g, "\n\n").trim();
            if (!mdBody) { fail("未能提取有效内容"); return; }
            kbAdd({ title: title, tags: ["外部入库", ext], type: "external", source: name }, mdBody);
            prog(100, "✅ 转换完成，已入库");
            setTimeout(function () { try { toast("已转换入库：" + title); } catch (e) {} openKB(); }, 600);
          } catch (e) { fail("入库失败：" + (e && e.message || e)); }
        }, 80);
      }
      prog(10, "步骤 1/4：读取文件…");
      var reader = new FileReader();
      reader.onerror = function () { fail("读取文件失败：" + name); };
      reader.onload = function () {
        setTimeout(function () {
          try {
            prog(32, "步骤 2/4：解析结构…");
            var buf = reader.result, p;
            if (ext === "docx") p = kbConvDocx(buf);
            else if (ext === "xlsx") p = kbConvXlsx(buf, prog);
            else if (ext === "pdf") p = kbConvPdf(buf, prog);
            else if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "bmp") p = kbConvImage(buf, ext, prog);
            else if (ext === "csv") p = Promise.resolve(kbCsvToMd(new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf))));
            else if (ext === "doc" || ext === "xls") { fail("旧版二进制 " + ext.toUpperCase() + " 暂无法离线解析：请先用 Office/WPS 另存为 .docx / .xlsx（或导出 .pdf / .csv）再导入"); return; }
            else p = Promise.resolve(new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf)).replace(/[^\x09\x0A\x0D\x20-\x7E一-龥。，、：；！？（）《》\s]/g, " ").slice(0, 20000));
            p.then(function (md) {
              prog(72, "步骤 3/4：生成 Markdown…");
              setTimeout(function () { done(md); }, 80);
            }).catch(function (e) { fail("转换失败：" + (e && e.message || e)); });
          } catch (e) { fail("解析出错：" + (e && e.message || e)); }
        }, 80);
      };
      reader.readAsArrayBuffer(file);
    } catch (e) { try { toast("读取外部文件出错：" + (e && e.message || e)); } catch (e2) {} }
  }
  // CSV → Markdown 表格（RFC4180 引号感知）
  function kbCsvToMd(text) {
    var rows = [], row = [], cur = "", inQ = false;
    text = String(text || "").replace(/^\uFEFF/, "");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.some(function (x) { return x !== ""; })) rows.push(row);
        row = [];
      } else cur += ch;
    }
    if (cur !== "" || row.length) { row.push(cur); if (row.some(function (x) { return x !== ""; })) rows.push(row); }
    return rows.length ? kbTableMd(rows) : "";
  }
  // 二维数组 → Markdown 表格
  function kbTableMd(rows) {
    if (!rows || !rows.length) return "";
    var n = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    var e = function (s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, " "); };
    while (rows[0].length < n) rows[0].push("");
    var lines = ["| " + rows[0].map(e).join(" | ") + " |", "|" + rows[0].map(function () { return " --- "; }).join("|") + "|"];
    rows.slice(1).forEach(function (r) { while (r.length < n) r.push(""); lines.push("| " + r.map(e).join(" | ") + " |"); });
    return lines.join("\n");
  }
  // .docx → Markdown（word/document.xml：段落 + 表格）
  function kbConvDocx(buf) {
    var JSZip = global.JSZip;
    if (!JSZip) return Promise.reject(new Error("zip 组件未加载"));
    return JSZip.loadAsync(buf).then(function (zip) {
      var f = zip.file("word/document.xml");
      if (!f) throw new Error("不是有效的 .docx 文件");
      return f.async("string").then(function (xml) {
        var out = [], tbls = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
        tbls.forEach(function (tbl, i) {
          xml = xml.replace(tbl, "\u0000TBL" + i + "\u0000");
        });
        xml.split(/<w:p[ >]/).slice(1).forEach(function (pXml) {
          var texts = pXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
          var line = texts.map(function (t) { return t.replace(/<[^>]+>/g, ""); }).join("").trim();
          if (line) out.push(line);
        });
        tbls.forEach(function (tbl, i) {
          var rows = tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [];
          var grid = rows.map(function (tr) {
            return (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(function (tc) {
              return (tc.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map(function (t) { return t.replace(/<[^>]+>/g, ""); }).join("").trim();
            });
          }).filter(function (r) { return r.some(function (c) { return c !== ""; }); });
          out.splice(out.indexOf("\u0000TBL" + i + "\u0000") >= 0 ? out.indexOf("\u0000TBL" + i + "\u0000") : out.length, 1, kbTableMd(grid));
        });
        var md = out.join("\n\n").replace(/\u0000TBL\d+\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
        if (!md) throw new Error("文档中未提取到文本内容");
        return md;
      });
    });
  }
  // .xlsx → Markdown（xl/worksheets/*.xml + sharedStrings）
  function kbConvXlsx(buf, prog) {
    var JSZip = global.JSZip;
    if (!JSZip) return Promise.reject(new Error("zip 组件未加载"));
    return JSZip.loadAsync(buf).then(function (zip) {
      var sheetNames = Object.keys(zip.files).filter(function (p) { return /^xl\/worksheets\/sheet\d+\.xml$/i.test(p); }).sort();
      if (!sheetNames.length) throw new Error("不是有效的 .xlsx 文件");
      var ssF = zip.file("xl/sharedStrings.xml");
      return (ssF ? ssF.async("string") : Promise.resolve("")).then(function (ssXml) {
        var shared = [];
        (String(ssXml || "").match(/<si>[\s\S]*?<\/si>/g) || []).forEach(function (si) {
          var ts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
          shared.push(ts.map(function (x) { return x.replace(/<[^>]+>/g, ""); }).join(""));
        });
        var out = [], chain = Promise.resolve();
        sheetNames.forEach(function (sf, si) {
          chain = chain.then(function () {
            if (prog) prog(32 + 38 * si / sheetNames.length, "步骤 2/4：解析工作表 " + (si + 1) + "/" + sheetNames.length + "…");
            return zip.file(sf).async("string").then(function (xml) {
              var rows = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
              var grid = rows.map(function (rowXml) {
                return (rowXml.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || []).map(function (c) {
                  var v = (c.match(/<v>([\s\S]*?)<\/v>/) || [0, null])[1];
                  if (/t="s"/.test(c) && v != null) return shared[parseInt(v, 10)] != null ? shared[parseInt(v, 10)] : "";
                  if (/t="inlineStr"/.test(c)) { var m = c.match(/<t[^>]*>([\s\S]*?)<\/t>/); return m ? m[1].replace(/<[^>]+>/g, "") : ""; }
                  return v != null ? v : "";
                });
              }).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
              if (grid.length) out.push("**工作表 " + (si + 1) + "**（" + grid.length + " 行）\n\n" + kbTableMd(grid));
            });
          });
        });
        return chain.then(function () {
          var md = out.join("\n\n").trim();
          if (!md) throw new Error("表格中未提取到内容");
          return md;
        });
      });
    });
  }
  // .pdf → Markdown（离线两级策略：先文本层抽取；文本层无效（扫描件/图片型 PDF）自动降级内置 OCR 逐页识别）
  function kbConvPdf(buf, prog) {
    return kbPdfTextLayer(buf, prog).then(function (text) {
      var good = (text.match(/[一-龥A-Za-z0-9]/g) || []).length;
      if (text.length >= 20 && good / text.length >= 0.3) {
        return "（PDF 离线提取，个别符号可能有出入）\n\n" + text.slice(0, 60000);
      }
      // 文本层缺失/过少 → 扫描件：内置 OCR 逐页识别
      return kbPdfOcr(buf, prog);
    });
  }
  // 文本层抽取（原 v3.53 逻辑：FlateDecode 流解压 + 文本操作符）
  function kbPdfTextLayer(buf, prog) {
    if (typeof DecompressionStream === "undefined") return Promise.resolve(""); // 无流解压能力直接走 OCR
    var bytes = new Uint8Array(buf);
    var latin = "", CH = 32768;
    for (var i = 0; i < bytes.length; i += CH) latin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    var streams = latin.match(/stream\r?\n?[\s\S]*?endstream/g) || [];
    var texts = [], chain = Promise.resolve();
    streams.forEach(function (s, idx) {
      chain = chain.then(function () {
        if (prog && idx % 8 === 0) prog(32 + 38 * idx / Math.max(streams.length, 1), "步骤 2/4：解压内容流 " + idx + "/" + streams.length + "…");
        var content = s.replace(/^stream\r?\n/, "").replace(/endstream[\s]*$/, "");
        if (!content.length || content.length > 4e6) return;
        return kbInflate(content).then(function (dec) {
          if (!/BT|Tj|TJ/.test(dec)) return;
          var ops = dec.match(/\((?:\\.|[^\\)])*\)\s*Tj|\[[\s\S]{0,4000}?\]\s*TJ|<[0-9A-Fa-f\s]{4,}>\s*Tj/g) || [];
          var line = ops.map(function (op) {
            var parts = op.match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>/g) || [];
            return parts.map(function (p) {
              if (p[0] === "(") return p.slice(1, -1).replace(/\\([()\\])/g, "$1").replace(/\\[nrbt]/g, " ");
              var hex = p.slice(1, -1).replace(/\s+/g, "");
              var out = "";
              try {
                if (/^[0-9A-Fa-f]+$/.test(hex) && hex.length % 4 === 0) { for (var k = 0; k < hex.length; k += 4) out += String.fromCharCode(parseInt(hex.substr(k, 4), 16)); }
                else if (/^[0-9A-Fa-f]+$/.test(hex) && hex.length % 2 === 0) { for (var j = 0; j < hex.length; j += 2) out += String.fromCharCode(parseInt(hex.substr(j, 2), 16)); }
              } catch (e) {}
              return out;
            }).join("");
          }).join(" ").trim();
          if (line) texts.push(line);
        }).catch(function () {});
      });
    });
    return chain.then(function (texts) { return texts.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); });
  }
  // 懒加载本地 OCR 组件（assets/ocr/ocr_engine.js）
  function kbEnsureOcr() {
    if (window.OCREngine) return Promise.resolve(window.OCREngine);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "ocr/ocr_engine.js";
      s.onload = function () { window.OCREngine ? res(window.OCREngine) : rej(new Error("OCR 引擎脚本异常")); };
      s.onerror = function () { rej(new Error("OCR 组件缺失（assets/ocr/）")); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  // 扫描版 PDF：pdf.js 渲染每页为位图 → 内置 OCR 逐页识别 → Markdown
  function kbPdfOcr(buf, prog) {
    return kbEnsureOcr().then(function () {
      if (prog) prog(30, "步骤 2/4：文本层缺失，加载 PDF 渲染引擎…");
      return kbEnsurePdfJs();
    }).then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = "ocr/pdf.worker.min.js";
      return pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false, useSystemFonts: false }).promise;
    }).then(function (doc) {
      var N = Math.min(doc.numPages, 50); // 上限 50 页，防超长扫描件卡死
      if (doc.numPages > N) { try { toast("扫描件超过 " + N + " 页，仅识别前 " + N + " 页"); } catch (e) {} }
      var texts = [];
      var chain = Promise.resolve();
      for (var pg = 0; pg < N; pg++) {
        (function (pg) {
          chain = chain.then(function () {
            return doc.getPage(pg + 1).then(function (page) {
              var scale = 2, vp = page.getViewport({ scale: scale });
              var maxW = 1700;
              if (vp.width > maxW) { scale = maxW / vp.width; vp = page.getViewport({ scale: scale }); }
              var cv = document.createElement("canvas");
              cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
              var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
              return page.render({ canvasContext: cx, viewport: vp }).promise.then(function () { return cv; });
            }).then(function (cv) {
              return window.OCREngine.recognize(cv, function (f) {
                if (prog) prog(32 + 45 * ((pg + f) / N), "步骤 2/4：OCR 识别第 " + (pg + 1) + "/" + N + " 页…");
              });
            }).then(function (t) { texts.push(t || ""); });
          });
        })(pg);
      }
      return chain.then(function () {
        try { window.OCREngine.dispose(); } catch (e) {}
        var text = texts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
        var good = (text.match(/[一-龥A-Za-z0-9]/g) || []).length;
        if (good < 10) throw new Error("OCR 未识别到有效文字（可能为空白页/清晰度过低）。建议提高扫描分辨率后重试");
        return "（扫描版 PDF，内置 OCR 识别，个别字可能有出入）\n\n" + text.slice(0, 60000);
      });
    }).catch(function (e) {
      try { window.OCREngine.dispose(); } catch (e2) {}
      throw e;
    });
  }
  // 懒加载本地 pdf.js 渲染引擎
  function kbEnsurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "ocr/pdf.min.js";
      s.onload = function () { window.pdfjsLib ? res(window.pdfjsLib) : rej(new Error("PDF 渲染引擎脚本异常")); };
      s.onerror = function () { rej(new Error("PDF 渲染组件缺失（assets/ocr/）")); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  // 图片（.png/.jpg/.jpeg/.webp/.bmp）→ 内置 OCR → Markdown
  function kbConvImage(buf, ext, prog) {
    return kbEnsureOcr().then(function () {
      if (prog) prog(32, "步骤 2/4：解码图片…");
      var mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "bmp" ? "image/bmp" : "image/jpeg";
      var url = URL.createObjectURL(new Blob([buf], { type: mime }));
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(img); };
        img.onerror = function () { rej(new Error("图片解码失败，文件可能已损坏")); };
        img.src = url;
      }).then(function (img) {
        var maxW = 1700, sc = Math.min(1, maxW / (img.naturalWidth || img.width || maxW));
        var cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round((img.naturalWidth || img.width) * sc));
        cv.height = Math.max(1, Math.round((img.naturalHeight || img.height) * sc));
        var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        if (prog) prog(38, "步骤 2/4：OCR 识别图片文字…");
        return window.OCREngine.recognize(cv, function (f) { if (prog) prog(38 + 32 * f, "步骤 2/4：OCR 识别图片文字…"); });
      });
    }).then(function (text) {
      var good = (String(text).match(/[一-龥A-Za-z0-9]/g) || []).length;
      if (good < 5) throw new Error("OCR 未识别到有效文字（可能为空白图/清晰度过低）。建议使用更清晰的原图");
      return "（图片 OCR 识别，个别字可能有出入）\n\n" + text.slice(0, 60000);
    });
  }
  function kbInflate(s) {
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xFF;
    function once(fmt) {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt));
      return new Response(stream).arrayBuffer().then(function (ab) { return new TextDecoder("latin1").decode(ab); });
    }
    return once("deflate").catch(function () { return once("deflate-raw"); });
  }
  // 读取网页链接入库（普通网页 / 微信公众号 / 微博）：fetch + 抽取正文（best-effort，动态 SPA 可能不全）
  function fetchUrlText(url, viaProxy) {
    if (typeof fetch !== "function") return Promise.reject(new Error("当前环境不支持 fetch"));
    var opt = { redirect: "follow" };
    var u = url;
    if (viaProxy) {
      // 公共 CORS 代理：绕过公众号/普通站的跨域限制（best-effort，不保证可用性）
      u = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
    } else {
      opt.mode = "cors";
    }
    return fetch(u, opt).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
  }
  function tryFetchUrl(url) {
    // 先直连（带 CORS），失败再用代理兜底
    return fetchUrlText(url, false).catch(function () { return fetchUrlText(url, true); });
  }
  function extractTextFromHtml(html) {
    var h = (html || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\s+/g, " ").trim();
    return h;
  }
  function kbImportUrl(url) {
    return tryFetchUrl(url).then(function (html) {
      var text = extractTextFromHtml(html);
      if (!text) throw new Error("未能提取正文（可能是动态加载页面，建议用「①读外部文件」或手动粘贴）");
      var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      var title = (m ? m[1] : url).replace(/\s+/g, " ").trim().slice(0, 60) || url;
      kbAdd({ title: title, tags: ["网页入库", "url"], type: "web", source: url }, text.slice(0, 20000));
      return true;
    }).catch(function (e) {
      // 自动抓取失败（跨域/网络受限）：提供手动粘贴降级方案，绝不抛未捕获错误
      openKbPasteFallback(url, e && e.message);
      return false;
    });
  }
  // 自动抓取失败时的手动降级：复制链接 → 浏览器打开 → 粘贴正文入库
  function openKbPasteFallback(url, msg) {
    var html =
      '<p style="font-size:13px;color:#a33;line-height:1.5">⚠️ ' + esc(msg || "自动抓取失败") + '</p>' +
      '<p style="font-size:13px;color:#3a2e28;line-height:1.6">公众号/部分网站禁止跨域抓取。请在浏览器打开下方链接，全选复制网页正文，粘贴到此处入库：</p>' +
      '<div style="display:flex;gap:6px;margin:6px 0"><input class="f" id="kbPasteUrl" style="flex:1" readonly value="' + esc(url) + '">' +
      '<button class="btn-save" onclick="kbCopyUrl()">复制链接</button></div>' +
      '<textarea class="f" id="kbPasteBody" rows="8" placeholder="在此粘贴网页正文…"></textarea>' +
      '<div class="form-actions"><button class="btn-save" onclick="kbPasteSubmit()">手动粘贴入库</button>' +
      '<button class="btn-cancel" onclick="openKB()">返回</button></div>';
    openGen("网页入库（手动降级）", html);
  }
  window.kbCopyUrl = function () {
    var t = $("kbPasteUrl"); if (t) { t.select(); try { document.execCommand("copy"); toast("已复制链接"); } catch (e) { toast("请手动复制"); } }
  };
  window.kbPasteSubmit = function () {
    var txt = (($("kbPasteBody") && $("kbPasteBody").value) || "").trim();
    if (!txt) { toast("请先粘贴网页正文"); return; }
    var url = ($("kbPasteUrl") && $("kbPasteUrl").value) || "";
    var title = (txt.split("\n")[0] || url).slice(0, 60);
    kbAdd({ title: title, tags: ["网页入库", "手动"], type: "web", source: url }, txt.slice(0, 20000));
    toast("已手动入库"); openKB();
  };
  function downloadText(fn, txt) {
    try { downloadBlob(fn, new Blob([txt], { type: "text/plain;charset=utf-8" })); }
    catch (e) { copyFallback(txt); }
  }
  function downloadBlob(fn, blob) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a"); a.href = url; a.download = fn;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
    } catch (e) {
      var r = new FileReader(); r.onload = function () { copyFallback(String(r.result).replace(/^data:.*;base64,/, "")); }; r.readAsDataURL(blob);
    }
  }
  function copyFallback(b64) {
    var html = '<p style="font-size:13px">当前环境无法直接下载，已生成 base64，请复制保存为 .zip/.json：</p>' +
      '<textarea class="f" id="kbB64" rows="6" readonly>' + esc(b64) + "</textarea>" +
      '<div class="form-actions"><button class="btn-save" id="kbCopy">复制</button></div>';
    openGen("知识库导出（base64）", html);
    q("kbCopy").onclick = function () { var t = q("kbB64"); t.select(); try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("请手动复制"); } };
  }
  function kbViewHtml(k) {
    var meta = k.meta;
    return '<h4>' + esc(meta ? meta.title : "") + "</h4>" +
      '<div style="font-size:12px;color:#8a7c70;margin-bottom:6px">' + esc((meta && meta.tags || []).join(" ")) + "</div>" +
      '<div style="background:var(--soft);border-radius:10px;padding:12px;font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:50vh;overflow:auto;color:#3a2e28">' + esc(k.md || "") + "</div>" +
      '<div class="form-actions"><button class="btn-cancel" id="kbBack">返回</button></div>';
  }
  function openKB() {
    var bCount = kbList().filter(function (r) { return r.type === "building"; }).length;
    var html =
      '<p style="font-size:13px;color:#3a2e28;line-height:1.6">知识库（Markdown 正文 + 元数据，与主流知识库格式互通）。<b>①导入文档</b>(.md/.txt/.html，按标题分条) <b>②读网页链接</b>(公众号/微博/普通) <b>③导出</b> md / txt / html（Obsidian/Notion 等可直接导入）。外部文件 <b>.pdf/.docx/.xlsx/.csv 及图片(.jpg/.png等) 自动智能转 Markdown</b> 入库（带进度条；扫描版 PDF 与图片内置 OCR 离线识别；旧版 .doc/.xls 请先另存为 .docx/.xlsx）。' +
      '智能操作自动沉淀为「operation / hermes」条目，供查询自我学习。当前已含建筑骨干 <b>' + bCount + '</b> 条。</p>' +
      '<div style="display:flex;gap:6px;margin:10px 0">' +
        '<button class="btn-cancel" style="flex:1" id="kbInFile">①导入外部文件(pdf/docx/表格/图片OCR)</button>' +
        '<button class="btn-cancel" style="flex:1" id="kbImportDoc">④导入文档(md/txt/html)</button></div>' +
      '<div style="display:flex;gap:6px;margin:6px 0">' +
        '<button class="btn-cancel" style="flex:1" id="kbExportMd">③导出md</button>' +
        '<button class="btn-cancel" style="flex:1" id="kbExportTxt">③导出txt</button>' +
        '<button class="btn-cancel" style="flex:1" id="kbExportHtml">③导出html</button></div>' +
      '<div style="display:flex;gap:6px;margin:6px 0"><button class="btn-cancel" style="flex:1" id="kbSeed">🌱 重新播种建筑骨干</button></div>' +
      '<div style="display:flex;gap:6px;margin:6px 0"><button class="btn-cancel" style="flex:1" id="kbReindex">🧠 重建向量索引（切片+向量化）</button>' +
      '<button class="btn-cancel" style="flex:1" id="kbRagStat">📊 索引状态</button></div>' +
      '<div style="border-top:1px dashed #ddd;margin:10px 0 6px"></div>' +
      '<h4 style="color:#6b2e2e;margin:4px 0">智能问答（RAG：混合检索 + 大模型）</h4>' +
      '<div style="display:flex;gap:6px"><input class="f" id="kbRagQ" style="flex:1" placeholder="直接问：闸门启闭顺序是什么？">' +
        '<button class="btn-save" id="kbRagGo">智能回答</button></div>' +
      '<div style="display:flex;gap:6px;margin:6px 0"><button class="btn-cancel" style="flex:1" id="kbRagRev">🔄 反向查条目（粘贴内容找出处）</button></div>' +
      '<div id="kbPromptChips" style="font-size:12px;color:#8a7c70;margin:4px 0"></div>' +
      '<div id="kbRagOut" style="margin-top:8px"></div>' +
      '<div style="display:flex;gap:6px;margin:8px 0 4px"><input class="f" id="kbUrl" style="flex:1" placeholder="②粘贴网页链接（公众号/微博/普通网页）">' +
        '<button class="btn-save" id="kbUrlGo">读入</button></div>' +
      '<input type="file" id="kbFile" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.md,.txt,.html,.htm,.json,.zip,.png,.jpg,.jpeg,.webp,.bmp" style="display:none">' +
      '<div style="border-top:1px dashed #ddd;margin:10px 0 6px"></div>' +
      '<h4 style="color:#6b2e2e;margin:4px 0">知识库查询（先本地，本地无且允许再联网）</h4>' +
      '<div style="display:flex;gap:6px"><input class="f" id="kbQ2" style="flex:1" placeholder="输入问题，如：潮河所管辖哪些闸">' +
        '<button class="btn-save" id="kbQrun">查询</button></div>' +
      '<div id="kbQout" style="margin-top:8px"></div>' +
      '<label class="f">搜索知识库条目</label><input class="f" id="kbQ" placeholder="关键词…">' +
      '<div id="kbList" style="max-height:30vh;overflow:auto;margin:8px 0"></div>';
    openGen("知识库管理", html);
    q("kbInFile").onclick = function () { var f = q("kbFile"); f.setAttribute("accept", ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp,.bmp"); f.click(); };
    q("kbExportMd").onclick = function () { kbExport("md"); };
    q("kbExportTxt").onclick = function () { kbExport("txt"); };
    q("kbExportHtml").onclick = function () { kbExport("html"); };
    q("kbSeed").onclick = function () { var n = seedBuildings(true); toast(n > 0 ? ("已播种 " + n + " 条建筑骨干") : "建筑骨干已是最新"); openKB(); };
    // —— RAG：重建索引 / 索引状态 / 智能问答 / 反向查条目 ——
    q("kbReindex").onclick = function () {
      var out = q("kbRagOut");
      out.innerHTML = '<div class="busy-sub">🧠 正在切片并向量化…</div>';
      kbRagRebuild(function (p, m) { out.innerHTML = '<div class="busy-sub">🧠 ' + esc(m || ("进度 " + Math.round(p * 100) + "%")) + "</div>"; })
        .then(function (n) {
          out.innerHTML = '<div class="up-ok">✅ 向量索引已重建：' + n + " 个切片</div>";
          try { toast("向量索引重建完成：" + n + " 切片"); } catch (e) {}
        })
        .catch(function (e) { out.innerHTML = '<span class="up-warn">重建失败：' + esc(e && e.message || e) + "</span>"; });
    };
    q("kbRagStat").onclick = function () {
      var out = q("kbRagOut");
      try {
        if (!window.KBRag) { out.innerHTML = '<span class="up-warn">RAG 未加载</span>'; return; }
        var s = window.KBRag.stats();
        out.innerHTML = '<div class="up-info">向量索引：切片 <b>' + s.chunks + "</b> 个 / 文档 <b>" + s.docs + "</b> 篇 / 维度 " + s.dim +
          "<br>更新时间：" + (s.updatedAt ? new Date(s.updatedAt).toLocaleString("zh-CN") : "—") +
          "<br>对话记忆：" + window.KBRag.memLoad().length + " 条</div>";
      } catch (e) { out.innerHTML = '<span class="up-warn">' + esc(e.message) + "</span>"; }
    };
    q("kbRagGo").onclick = function () {
      var t = (q("kbRagQ").value || "").trim(); if (!t) { toast("请输入问题"); return; }
      var out = q("kbRagOut");
      out.innerHTML = '<div class="busy-sub">🔍 检索中…</div>';
      kbRagEnsure().then(function (R) {
        if (!R.stats().chunks) { out.innerHTML = '<span class="up-warn">向量索引为空，请先点「重建向量索引」</span>'; return null; }
        return R.askSmart(t, {
          chat: chat, llm: (onlineEnabled() || true), expand: false,
          onProgress: function (p, m) { out.innerHTML = '<div class="busy-sub">' + esc(m || ("进度 " + Math.round(p * 100) + "%")) + "</div>"; }
        });
      }).then(function (res) {
        if (!res) return;
        var cites = (res.hits || []).map(function (h, i) {
          return '<div style="font-size:12px;color:#666;margin-top:4px">[' + (i + 1) + "] " + esc(h.title || h.source || h.docId) +
            (h.detail ? " <span style=\"color:#aaa\">（向量 " + h.detail.vector.toFixed(2) + " / 关键词 " + h.detail.bm25.toFixed(2) + " / 模糊 " + h.detail.fuzzy.toFixed(2) + "）</span>" : "") + "</div>";
        }).join("");
        out.innerHTML = '<div style="background:#f6f8fa;border-radius:8px;padding:10px;font-size:13px;white-space:pre-wrap">' + esc(res.answer) + "</div>" +
          '<div style="margin-top:6px;font-size:12px;color:#888">来源（' + (res.source === "llm" ? "大模型生成" : res.source === "offline" ? "离线抽取" : "降级抽取") + "）：</div>" + cites;
      }).catch(function (e) { out.innerHTML = '<span class="up-warn">智能问答失败：' + esc(e && e.message || e) + "</span>"; });
    };
    q("kbRagRev").onclick = function () {
      var t = (q("kbRagQ").value || "").trim(); if (!t) { toast("请粘贴一段内容，用于反查它出自哪些条目"); return; }
      var out = q("kbRagOut");
      kbRagEnsure().then(function (R) {
        var docs = R.reverseQuery(t, 5);
        out.innerHTML = docs.length
          ? docs.map(function (d) { return '<div class="bm-row"><div style="flex:1"><div style="font-size:13px;font-weight:600">📄 ' + esc(d.title || d.docId) + "</div>" +
              '<div style="font-size:11px;color:#aab4be">' + esc(String(d.snippets[0] || "").slice(0, 60)) + "</div></div>" +
              '<button class="tbtn" data-kview="' + esc(d.docId) + '">查看</button></div>'; }).join("")
          : '<span class="up-warn">未找到匹配条目（可先重建向量索引）</span>';
      }).catch(function (e) { out.innerHTML = '<span class="up-warn">' + esc(e.message) + "</span>"; });
    };
    // 首次打开且向量索引为空 → 后台自动重建（原有知识库也向量化）
    try {
      if (window.KBRag && window.KBRag.stats().chunks === 0 && kbList().length > 0) {
        toast("正在为知识库建立向量索引…");
        kbRagRebuild(function () {}).then(function (n) { try { toast("向量索引就绪：" + n + " 个切片，可用智能问答"); } catch (e) {} }).catch(function () {});
      }
    } catch (e) {}
    // 智能生成候选提示词
    try {
      var o0 = kbLoad();
      var d0 = o0.index.slice(0, 40).map(function (m) { return { title: m.title, body: o0.bodies[m.id] || "" }; });
      var chips = (window.KBRag ? window.KBRag.suggestPrompts(d0, 4) : []);
      if (chips.length) {
        q("kbPromptChips").innerHTML = "推荐提问：" + chips.map(function (c) {
          return '<span style="display:inline-block;background:#eef3f8;border-radius:10px;padding:3px 8px;margin:2px 4px 2px 0;cursor:pointer" onclick="var e=document.getElementById(\'kbRagQ\');if(e){e.value=' + JSON.stringify(c).replace(/"/g, "&quot;") + '}">💡 ' + esc(c) + "</span>";
        }).join("");
      }
    } catch (e) {}
    q("kbImportDoc").onclick = function () { var f = q("kbFile"); f.setAttribute("accept", ".md,.markdown,.txt,.html,.htm,.json,.zip,application/zip"); f.click(); };
    q("kbUrlGo").onclick = function () {
      var url = q("kbUrl").value.trim(); if (!url) { toast("请粘贴网页链接"); return; }
      busy(true); q("kbUrlGo").disabled = true;
      kbImportUrl(url).then(function () { busy(false); q("kbUrlGo").disabled = false; toast("已入库网页"); openKB(); })
        .catch(function (e) { busy(false); q("kbUrlGo").disabled = false; toast("网页读取失败：" + e.message); });
    };
    q("kbFile").onchange = function () {
      var f = this.files[0]; if (!f) return;
      var n = (f.name || "").toLowerCase();
      if (/\.zip$/i.test(n)) kbImportZip(f);                                  // 兼容旧版 zip 备份
      else if (/\.(md|markdown|txt|html?|json)$/i.test(n)) kbImportDoc(f);    // 主流文档格式
      else kbImportExternal(f);                                               // pdf/docx/xlsx/csv → 智能转 md
      this.value = "";
    };
    q("kbQrun").onclick = function () {
      var t = q("kbQ2").value; if (!t.trim()) { toast("请输入查询内容"); return; }
      q("kbQout").innerHTML = '<div class="busy-sub">🔒 正在检索本地知识库…</div>';
      queryEngine(t, function (m) { q("kbQout").innerHTML = '<div class="busy-sub">' + esc(m) + "</div>"; }).then(function (res) {
        q("kbQout").innerHTML = renderQueryOutcome(res);
        var box = q("kbQout");
        if (box) box.querySelectorAll("[data-kview]").forEach(function (el) {
          el.onclick = function () { var k = kbGet(el.getAttribute("data-kview")); openGen("知识库条目", kbViewHtml(k)); q("kbBack").onclick = openKB; };
        });
      });
    };
    q("kbQ").oninput = function () { renderKBList(this.value.trim()); };
    renderKBList("");
  }
  function renderKBList(kw) {
    var list = kbSearch(kw);
    var box = q("kbList"); if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="empty-tip">知识库为空，点击「①读外部文件」或智能操作后自动沉淀</div>'; return; }
    box.innerHTML = list.map(function (r) {
      var tag = (r.type === "hermes") ? "🧠" : (r.type === "operation") ? "✏️" : (r.type === "external") ? "📥" : "📄";
      return '<div class="bm-row"><div style="flex:1"><div style="font-size:13px;font-weight:600">' + tag + " " + esc(r.title) + "</div>" +
        '<div style="font-size:11px;color:#aab4be">' + esc((r.tags || []).join(" ")) + " · " + esc(r.ts || "") + "</div></div>" +
        '<button class="tbtn" data-view="' + esc(r.id) + '">查看</button> ' +
        '<button class="tbtn" data-rm="' + esc(r.id) + '">删除</button></div>';
    }).join("");
    bindData("data-view", function (id) {
      var k = kbGet(id);
      openGen("知识库条目", '<h4>' + esc(k.meta ? k.meta.title : "") + "</h4>" +
        '<div style="font-size:12px;color:#8a7c70;margin-bottom:6px">' + esc((k.meta && k.meta.tags || []).join(" ")) + "</div>" +
        '<div style="background:var(--soft);border-radius:10px;padding:12px;font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:50vh;overflow:auto;color:#3a2e28">' + esc(k.md || "") + "</div>" +
        '<div class="form-actions"><button class="btn-cancel" id="kbBack">返回</button></div>');
      q("kbBack").onclick = openKB;
    });
    bindData("data-rm", function (id) { kbRemove(id); renderKBList(q("kbQ") ? q("kbQ").value.trim() : ""); });
  }
  // Hermes 自我学习循环：每次智能操作后异步抽提「关键参数 + 操作偏好」沉淀为 hermes 条目
  function hermesLearn(operation, inputText, outputText) {
    var sys = "你是「" + (CFG.appName || "本系统") + "」的学习助手。用户刚完成一次「" + operation + "」操作。" +
      "请从中抽取对今后有用的「关键参数」与「操作偏好」，用简体中文、要点式输出（不超过 6 条，每条一行，不要解释）。";
    var user = "用户输入：\n" + (inputText || "") + "\n\n" + (CFG.appName ? "系统产出/结果：\n" : "") + (outputText || "").slice(0, 1200);
    chat([{ role: "system", content: sys }, { role: "user", content: user }]).then(function (txt) {
      if (!txt || !txt.trim()) return;
      kbAdd({ title: operation + " · " + new Date().toLocaleDateString("zh-CN"), tags: ["hermes", operation], type: "hermes", source: "Hermes自动学习" }, txt.trim());
    }).catch(function () { /* 无模型/失败则静默，不影响主流程 */ });
  }

  /* ============================ v3.40 新增：查询历史回显 / 美观排版 / 保存知识库 / 建筑骨干播种 ============================ */
  // 查询历史 chips：点击复用缓存（省词元），可点「强制重新查询」重新联网
  function renderQueryHistory() {
    var box = q("qHist"); if (!box) return;
    var list = getHist();
    if (!list.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div style="font-size:12px;color:#8a7c70;margin:8px 0 4px">最近查询（点击查看缓存，省词元）</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' + list.slice(0, 8).map(function (h, i) {
        return '<button class="tbtn" data-q="' + i + '">' + esc(h.q.slice(0, 16)) + "</button>";
      }).join("") + "</div>";
    box.querySelectorAll("[data-q]").forEach(function (el) {
      el.onclick = function () {
        var h = getHist()[+el.getAttribute("data-q")];
        q("qInput").value = h.q;
        q("qOut").innerHTML = renderResult(h.out, h.q) +
          '<div style="margin-top:8px;font-size:11px;color:#aab4be">📋 缓存于 ' + esc(h.ts) + " · " + (h.mode === "online" ? "🌐 联网" : "🔒 本地") + "</div>" +
          '<div class="form-actions"><button class="btn-cancel" id="qForce">🔄 强制重新查询</button></div>';
        q("qSaveKB").onclick = function () { saveQueryToKB(h.q, h.out); };
        var _er = q("qExportRpt"); if (_er) _er.onclick = function () { exportQueryReport(h.q, h.out); };
        q("qNoSave").onclick = function () { var a = q("qOut").querySelector(".kb-actions"); if (a) a.remove(); toast("未保存知识库"); };
        q("qForce").onclick = function () { runQuery(); };
      };
    });
  }
  // 轻量 Markdown 渲染（标题/列表/粗斜体），先转义 HTML 防 XSS
  function inlineMd(t) { return t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>"); }
  function md2html(s) {
    if (!s) return "";
    var lines = esc(s).split(/\n/), html = "", inList = false;
    function closeList() { if (inList) { html += "</ul>"; inList = false; } }
    lines.forEach(function (ln) {
      var t = ln.trim();
      var mh = t.match(/^(#{1,3})\s+(.*)$/);
      if (mh) { closeList(); var lv = mh[1].length; html += "<h" + lv + ' style="margin:8px 0 4px;color:#6b2e2e;font-size:' + (18 - lv * 2) + 'px">' + inlineMd(mh[2]) + "</h" + lv + ">"; }
      else if (/^[-*]\s+/.test(t)) { if (!inList) { html += '<ul style="margin:4px 0;padding-left:18px">'; inList = true; } html += "<li>" + inlineMd(t.replace(/^[-*]\s+/, "")) + "</li>"; }
      else if (t === "") { closeList(); }
      else { closeList(); html += '<p style="margin:4px 0">' + inlineMd(t) + "</p>"; }
    });
    closeList();
    return html;
  }
  function compactMd(s) {
    return String(s || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
  }
  // 查询结果美观排版 + 「保存知识库(精简)」/「不保存」选项
  function renderResult(txt, qtext) {
    var body = '<div class="md-body" style="background:var(--soft);border-radius:10px;padding:12px;font-size:13px;line-height:1.7;color:#3a2e28">' + md2html(txt) + "</div>";
    var actions = '<div class="kb-actions" style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn-save" style="flex:1" id="qSaveKB">💾 保存知识库（精简）</button>' +
      '<button class="btn-save" style="flex:1" id="qExportRpt">📄 导出报告</button>' +
      '<button class="btn-cancel" style="flex:1" id="qNoSave">✕ 不保存</button></div>';
    return body + actions;
  }
  // D-6：查询报告导出（Markdown 下载），闭环的「报告」环节
  function downloadText(fn, text) {
    try {
      var blob = new Blob([String(text || "")], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a"); a.href = url; a.download = fn;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
    } catch (e) { toast("导出失败：" + ((e && e.message) || e)); }
  }
  function exportQueryReport(qtext, txt) {
    var md = (global.KBCore && global.KBCore.buildReport)
      ? global.KBCore.buildReport(qtext, txt, { source: "智能查询", title: "智能查询报告 · " + String(qtext || "").slice(0, 20) })
      : ("# 查询报告\n\n## 查询\n" + (qtext || "") + "\n\n## 答案\n" + (txt || ""));
    downloadText("智能查询报告_" + new Date().toISOString().slice(0, 10) + ".md", md);
    toast("已导出 Markdown 报告");
  }
  window.exportQueryReport = exportQueryReport;
  // 保存查询结果为知识库条目（正文尽可能精简，可点「自动精简」或手动删减）
  function saveQueryToKB(qtext, rawText) {
    var html = '<p style="font-size:13px;color:#3a2e28">保存进知识库将长期占用空间，建议精简。可点「自动精简」压缩，或手动删减后保存。</p>' +
      '<label class="f">条目标题</label><input class="f" id="kbTitle" value="' + esc((qtext || "").slice(0, 40)) + '">' +
      '<label class="f">正文（精简）</label><textarea class="f" id="kbBody" rows="8">' + esc(compactMd(rawText)) + "</textarea>" +
      '<div class="form-actions"><button class="btn-cancel" id="kbAuto">自动精简</button>' +
      '<button class="btn-cancel" id="kbCancel">取消</button>' +
      '<button class="btn-save" id="kbDo">保存</button></div>';
    openGen("保存知识库（精简）", html);
    q("kbAuto").onclick = function () { q("kbBody").value = compactMd(q("kbBody").value); toast("已精简"); };
    q("kbCancel").onclick = openSmartQuery;
    q("kbDo").onclick = function () {
      var title = q("kbTitle").value.trim() || (qtext || "未命名查询");
      var body = q("kbBody").value.trim();
      if (!body) { toast("正文为空，未保存"); return; }
      kbAdd({ title: title, tags: ["query", onlineEnabled() ? "online" : "local"], type: "query", source: "智能查询保存" }, body);
      toast("已保存到知识库"); openKB();
    };
  }
  // 建筑骨干自动播种（Feature⑦①）：从 CFG.listAll() 生成 type:"building" 条目，含参数/照片状态/存储路径
  function buildBuildingBody(r) {
    var L = [];
    L.push("# " + (r.name || "?"));
    if (r.office) L.push("- 管理所：" + r.office);
    if (r.station) L.push("- 站：" + r.station);
    if (r.btype) L.push("- 类型：" + r.btype);
    if (r.chan) L.push("- 渠道：" + r.chan);
    if (r.path) L.push("- 存储路径：" + r.path);
    // v3.41：通用扩展字段（感知=子系统；古建=属地/朝代/级别/简介/特点），无该字段的域自动跳过
    if (r.subsystem) L.push("- 子系统：" + r.subsystem);
    if (r.province || r.city) L.push("- 所属地：" + [r.province, r.city].filter(Boolean).join(" "));
    if (r.dynasty) L.push("- 朝代：" + r.dynasty);
    if (r.level) L.push("- 级别：" + r.level);
    if (r.intro) L.push("- 简介：" + r.intro);
    if (r.features) L.push("- 特点：" + r.features);
    if (r.lon != null && r.lat != null) L.push("- 坐标：" + r.lon + ", " + r.lat);
    var photos = (r.photos && r.photos.length) ? ("有 " + r.photos.length + " 张照片") : "无照片";
    L.push("- 照片：" + photos);
    if (r.attrs && r.attrs.length) {
      L.push(""); L.push("## 参数");
      r.attrs.forEach(function (a) { if (a && a.length >= 2 && (a[0] || a[1])) L.push("- " + a[0] + "：" + a[1]); });
    }
    return L.join("\n");
  }
  function seedBuildings(force) {
    if (!CFG.listAll) return 0;
    var o = kbLoad();
    if (!force && o.index.some(function (x) { return x.type === "building"; })) return 0;
    var recs = CFG.listAll() || [], n = 0;
    recs.forEach(function (r) {
      if (!r || !r.id) return;
      var ex = o.index.find(function (x) { return x.type === "building" && x.buildingId === r.id; });
      var title = r.name || ("建筑#" + r.id);
      var body = buildBuildingBody(r);
      if (ex) { ex.title = title; ex.ts = new Date().toLocaleString("zh-CN"); o.bodies[ex.id] = body; }
      else {
        var id = "kb_" + Date.now() + "_" + Math.floor(Math.random() * 1e4).toString(36);
        o.index.unshift({ id: id, title: title, tags: ["building", r.office, r.btype].filter(Boolean), type: "building", source: "建筑骨干自动播种", buildingId: r.id, ts: new Date().toLocaleString("zh-CN"), domain: CFG.domain });
        o.bodies[id] = body; n++;
      }
    });
    kbSave(o);
    return n;
  }
  function kSeed(d) { return "kb_seed_" + d; }
  // 发行前预生成：构建脚本把建筑骨干写成 window.KB_BUILDING_SEED（全局数组），
  // init 时合并进本地 KB（buildingId 去重，不覆盖用户后续增改）。无需 fetch，file:// 离线可用。
  function mergeSeed() {
    var arr = global.KB_BUILDING_SEED;
    if (!arr || !arr.length) return 0;
    var o = kbLoad(), byId = {}, n = 0;
    o.index.forEach(function (x) { if (x.type === "building" && x.buildingId != null) byId[x.buildingId] = x; });
    arr.forEach(function (r) {
      if (!r || !r.id) return;
      var ex = byId[r.id], title = r.name || ("建筑#" + r.id), body = buildBuildingBody(r);
      if (ex) { ex.title = title; ex.ts = r.ts || ex.ts; o.bodies[ex.id] = body; }
      else {
        var id = "kb_" + Date.now() + "_" + Math.floor(Math.random() * 1e4).toString(36);
        o.index.unshift({ id: id, title: title, tags: ["building", r.office, r.btype].filter(Boolean), type: "building", source: "建筑骨干预生成种子", buildingId: r.id, ts: r.ts || new Date().toLocaleString("zh-CN"), domain: CFG.domain });
        o.bodies[id] = body; n++;
      }
    });
    kbSave(o); return n;
  }

  /* ============================ 对外 API ============================ */
  var API = {
    init: init,
    getMenuGroups: getMenuGroups,
    setOnline: setOnline, isOnline: onlineEnabled,
    _openSettings: openSettings,
    _openSmartQuery: openSmartQuery,
    _openSmartUpdate: openSmartUpdate,
    _openSmartCorrect: openSmartCorrect,
    _openKB: openKB,
    // 知识库对外接口（宿主建筑增改时可调用，把参数/操作过程沉淀进知识库）
    kbAdd: kbAdd,
    kbSliceText: kbSliceText,
    kbList: kbList,
    kbSearch: kbSearch,
    kbContext: kbContext,
    hermesLearn: hermesLearn,
    // 宿主直接调用 LLM（用于智能补全 / 智能描述等地）：messages 为 OpenAI 格式
    ask: function (messages) { return chat(messages); }
  };
  // init 成功后才挂到 window；此处先声明，init 内会再赋值一次
  if (!global.AIModule) global.AIModule = API;
  // v3.47：把知识库入口挂到 window，供内联 onclick 调用（修复 openKB/openGen is not defined）
  window.openKB = openKB;
  window.openGen = openGen;
  // D-1：暴露 KB 混合检索与条目查看，供宿主 app.js 智能推荐复用（替代 app.js 内孤立文本匹配）
  window.kbHybridSearch = kbHybridSearch;
  window.kbViewDocById = function (id) {
    try {
      var k = kbGet(id);
      if (!k || !k.meta) { toast("未找到该知识库条目"); return; }
      openGen("知识库条目", kbViewHtml(k));
      var _b = q("kbBack"); if (_b) _b.onclick = openSmartQuery;
    } catch (e) {}
  };

})(typeof window !== "undefined" ? window : this);
