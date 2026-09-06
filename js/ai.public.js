/* ai.js —— 通用大模型 AI 引擎（三端复用：古建/水利/感知）
 * 不依赖任何框架，仅用浏览器 fetch + 全局 helpers（el/openModal/closeModal/toast/esc/busy/Store）。
 * 领域差异由各 App 在加载后设置 window.AI.domain 适配（见 app.js）。
 *
 * 能力：
 *  设置：自定义模型(名称/引用地址/协议 openai 兼容/模型ID/本地模型开关)、默认模型、自动调用策略(单模型/失败回退/轮询切换)
 *  智能：查询 / 更新(写回 delta.updated) / 纠错(标注，不改原值) / 对话助手
 */
(function (global) {
  const LS_KEY = "ai_settings_v1";

  // OpenRouter 默认密钥（用户 jykjk2010 提供，2026-08-28 轮换导入）。
  // 仅用于本地 App 调用；如对外分发请改为空字符串让用户自行填写，并建议到 openrouter.ai 重置该密钥。
  const DEFAULT_OR_KEY = """";

  // ---------- 设置持久化 ----------
  // 默认预置 3 个 OpenRouter 免费模型（已实测可用 2026-08-28）：
  //  MiniMax M2.7(推理型，需较多 token) / GLM 5.2(中文强，共享池偶发 429) / MiniMax M3(快、稳)
  // 默认策略 fallback：任一模型触发限流/失败自动切下一个，规避免费模型限流。
  function defaultSettings() {
    return {
      models: [
        { id: "mx_m27", name: "MiniMax M2.7 (免费)", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", apiKey: DEFAULT_OR_KEY, modelId: "minimax/minimax-m2.7:free", local: false, reasoning: true },
        { id: "glm52", name: "GLM 5.2 (免费·智谱)", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", apiKey: DEFAULT_OR_KEY, modelId: "z-ai/glm-5.2:free", local: false },
        { id: "mx_m3", name: "MiniMax M3 (免费)", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", apiKey: DEFAULT_OR_KEY, modelId: "minimax/minimax-m3:free", local: false },
        { id: "local_ollama", name: "本地 Ollama", baseUrl: "http://localhost:11434/v1", protocol: "openai", apiKey: "ollama", modelId: "llama3", local: true }
      ],
      defaultModel: "mx_m27",
      strategy: { mode: "fallback", order: ["mx_m27", "glm52", "mx_m3", "local_ollama"], last: 0 }
    };
  }
  function isAscii(s) { return typeof s === "string" && /^[\x00-\xFF]*$/.test(s); }
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY));
      if (s && Array.isArray(s.models) && s.models.length) {
        const merged = Object.assign(defaultSettings(), s);
        // 自愈：个别设备早期版本曾把中文 appName 误写入模型 apiKey 并持久化，导致 fetch 头含非 ISO-8859-1
        // 字符而抛 "String contains non ISO-8859-1 code point"。这里把非 ASCII 的 apiKey 回退到默认密钥，恢复可用。
        merged.models.forEach((m) => { if (!isAscii(m.apiKey)) m.apiKey = DEFAULT_OR_KEY; });
        return merged;
      }
    } catch (e) {}
    return defaultSettings();
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  // ---------- 底层调用 ----------
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function isRetryable(err) {
    if (!err) return false;
    const msg = (err.message || "").toLowerCase();
    return err.status === 429 || /rate.?limit|429|too many requests|temporarily|upstream_429|exceeded.*limit/i.test(msg);
  }
  async function callOne(m, prompt, opts) {
    opts = opts || {};
    const url = (m.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
    if (!url || url.indexOf("http") !== 0) throw new Error("模型引用地址无效：" + (m.baseUrl || ""));
    const maxTokens = opts.maxTokens != null ? opts.maxTokens : (opts.json ? 1600 : 1200);
    const body = {
      model: m.modelId || "",
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: prompt }
      ],
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      max_tokens: maxTokens,
      stream: false
    };
    // 推理模型（如 MiniMax M2.7）开启 reasoning 以便拿到最终 content；非推理模型忽略该字段
    if (m.reasoning || opts.reasoning) body.include_reasoning = true;
    if (opts.json) body.response_format = { type: "json_object" };
    const headers = { "Content-Type": "application/json" };
    if (m.apiKey) headers["Authorization"] = "Bearer " + m.apiKey;
    // HTTP 头值必须是 Latin1（ISO-8859-1）；任何非 ASCII 都会让浏览器/WebView 的 fetch 直接抛错。
    // 兜底清洗一次，确保配置异常也不会让请求崩溃。
    for (const k in headers) headers[k] = String(headers[k]).replace(/[^\x00-\xFF]/g, "");

    // 免费模型共享池偶发限流(429)，本地做 1 次退避重试
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          const e = new Error("HTTP " + res.status + " " + (t || "").slice(0, 200));
          e.status = res.status;
          if (res.status === 429) { lastErr = e; await sleep(900 * (attempt + 1)); continue; }
          throw e;
        }
        const j = await res.json();
        const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
        // 优先取最终 content；推理模型 content 为空时回退到 reasoning 文本
        const content = msg.content || (msg.reasoning || "");
        return content || "";
      } catch (e) {
        lastErr = e;
        if (isRetryable(e)) { await sleep(900 * (attempt + 1)); continue; }
        throw e;
      }
    }
    throw lastErr || new Error("调用失败");
  }

  // ---------- 自动调用策略 ----------
  function resolveOrder(s) {
    if (s.strategy.mode === "single") return [s.defaultModel].filter(Boolean);
    if (s.strategy.mode === "fallback") return (s.strategy.order && s.strategy.order.length) ? s.strategy.order : [s.defaultModel];
    if (s.strategy.mode === "roundrobin") {
      const base = (s.strategy.order && s.strategy.order.length) ? s.strategy.order : [s.defaultModel];
      let idx = (typeof s.strategy.last === "number") ? s.strategy.last : 0;
      if (idx >= base.length || idx < 0) idx = 0;
      const rotated = base.slice(idx).concat(base.slice(0, idx));
      s.strategy.last = (idx + 1) % base.length;
      return rotated;
    }
    return [s.defaultModel];
  }

  async function strategyCall(prompt, opts) {
    // 需求③ + v2.4.6 智能框架：注入本地知识库上下文 + Hermes 自我学习记忆（无则优雅降级）
    const kbc = (window.__kbContext && typeof window.__kbContext === "function") ? await window.__kbContext(prompt) : "";
    const memc = (window.__kbMemoryContext && typeof window.__kbMemoryContext === "function") ? await window.__kbMemoryContext() : "";
    let fullPrompt = prompt;
    if (kbc) fullPrompt = "【本地知识库参考】\n" + kbc + "\n\n---\n\n" + fullPrompt;
    if (memc) fullPrompt = "【自我学习记忆·Hermes】\n" + memc + "\n\n---\n\n" + fullPrompt;
    const s = loadSettings();
    const order = resolveOrder(s);
    let lastErr;
    for (const id of order) {
      const m = s.models.find((x) => x.id === id) || s.models.find((x) => x.id === s.defaultModel);
      if (!m) continue;
      try {
        const r = await callOne(m, fullPrompt, opts);
        saveSettings(s);
        return r;
      } catch (e) {
        lastErr = e;
        if (s.strategy.mode === "single") break; // 单模型不回退
      }
    }
    saveSettings(s);
    throw lastErr || new Error("未配置可用模型，请先在「AI设置」中添加");
  }

  // ---------- 数据读写（复用 app 的 delta 机制）----------
  function baseFind(id) {
    const arr = (global.__DATA__ && global.__DATA__.features) || [];
    return arr.find((r) => r.id === id);
  }
  function mergedOne(id) {
    const base = baseFind(id) || {};
    let upd = {};
    try { upd = (typeof DELTA !== "undefined" && DELTA && DELTA.updated) ? (DELTA.updated[id] || {}) : {}; } catch (e) {}
    return Object.assign({}, base, upd);
  }
  function mergedRecords() {
    const base = (global.__DATA__ && global.__DATA__.features) || [];
    let d = { added: [], updated: {}, deleted: [] };
    try { if (typeof DELTA !== "undefined" && DELTA) d = DELTA; } catch (e) {}
    const byId = {};
    base.forEach((r) => (byId[r.id] = Object.assign({}, r)));
    (d.added || []).forEach((r) => (byId[r.id] = Object.assign({}, r)));
    Object.keys(d.updated || {}).forEach((id) => (byId[id] = Object.assign({}, byId[id] || baseFind(id) || {}, d.updated[id])));
    (d.deleted || []).forEach((id) => delete byId[id]);
    return Object.values(byId);
  }
  async function applyUpdate(id, patch) {
    await Store.patch((dd) => {
      dd.updated = dd.updated || {};
      const cur = Object.assign({}, baseFind(id) || {}, dd.updated[id] || {});
      dd.updated[id] = Object.assign({}, cur, patch);
    });
  }
  async function addCorrection(id, corr) {
    await Store.patch((dd) => {
      dd.updated = dd.updated || {};
      const cur = Object.assign({}, baseFind(id) || {}, dd.updated[id] || {});
      const corrections = (cur.corrections || []).slice();
      corrections.push(corr);
      dd.updated[id] = Object.assign({}, cur, { corrections });
    });
  }

  // ---------- 辅助 ----------
  function esc2(s) { return (typeof esc === "function") ? esc(s) : String(s == null ? "" : s); }
  function mdLite(s) {
    if (s == null) return "";
    s = String(s);
    const lines = s.split("\n");
    let html = "", inCode = false, codeBuf = [], inList = false, listType = "";
    const closeList = () => { if (inList) { html += listType === "ol" ? "</ol>" : "</ul>"; inList = false; listType = ""; } };
    const inline = (x) => x
      .replace(/&lt;br&gt;/g, "<br>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (/^\s*```/.test(line)) {
        if (inCode) { html += "<pre class='md-code'>" + esc2(codeBuf.join("\n")) + "</pre>"; codeBuf = []; inCode = false; }
        else { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      const t = line.trim();
      if (!t) { closeList(); continue; }
      let m;
      if ((m = t.match(/^(#{1,4})\s+(.*)$/))) { closeList(); const lv = m[1].length; html += `<h${lv} class="md-h">${inline(esc2(m[2]))}</h${lv}>`; continue; }
      if ((m = t.match(/^[-*]\s+(.*)$/))) { if (!inList || listType !== "ul") { closeList(); html += "<ul class='md-ul'>"; inList = true; listType = "ul"; } html += `<li>${inline(esc2(m[1]))}</li>`; continue; }
      if ((m = t.match(/^(\d+)[.)]\s+(.*)$/))) { if (!inList || listType !== "ol") { closeList(); html += "<ol class='md-ol'>"; inList = true; listType = "ol"; } html += `<li>${inline(esc2(m[2]))}</li>`; continue; }
      if (/^(-{3,}|\*{3,}|={3,})$/.test(t)) { closeList(); html += "<hr class='md-hr'>"; continue; }
      closeList();
      html += `<p class="md-p">${inline(esc2(t))}</p>`;
    }
    closeList();
    if (inCode) html += "<pre class='md-code'>" + esc2(codeBuf.join("\n")) + "</pre>";
    return html;
  }
  function parseJsonSafe(s) {
    if (!s) return null;
    s = String(s).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "");
    const a = s.indexOf("{"); const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // ---------- 条目选择器 ----------
  function pickRecord(dm, cb) {
    const recs = mergedRecords();
    let q = "";
    // v2.4.1：占位符清晰 + 试试搜 chips（贴近水利：跌水/进水闸/节制闸）
    const seed = (recs || []).slice(0, 5).map((r) => dm.recName(r)).filter(Boolean);
    const seedChips = seed.length ? seed.map((s) => `<span class="chip" data-seed="${esc2(s)}">${esc2(s)}</span>`).join("") : "";
    const render = () => {
      const ql = q.toLowerCase();
      const list = recs.filter((r) => !ql || (r.name || "").toLowerCase().includes(ql) || (dm.recMeta(r) || "").toLowerCase().includes(ql)).slice(0, 200);
      const html =
        `<div class="field"><input id="pkSearch" class="inp" placeholder="输入名称 / 关键字搜索建筑物台账（如：跌水节制闸 / 翠屏山所 / 进水闸设计流量）" value="${esc2(q)}"></div>` +
        (!q && seedChips ? `<div class="field"><label>试试搜（点击即用）</label><div class="chips" id="pkSeed">${seedChips}</div></div>` : "") +
        `<div class="filelist" id="pkList">` +
        list.map((r) => `<div class="pk-item" data-id="${esc2(r.id)}"><span class="pk-name">${esc2(dm.recName(r))}</span><span class="pk-meta">${esc2(dm.recMeta(r) || "")}</span></div>`).join("") +
        (list.length === 0 ? '<div class="hint">无匹配条目</div>' : "") +
        `</div>`;
      openModal("选择条目", html, `<button class="btn ghost" id="pkClose">取消</button>`);
      el("pkClose").onclick = closeModal;
      el("pkSearch").oninput = (e) => { q = e.target.value; render(); };
      const seedBox = el("pkSeed");
      if (seedBox) seedBox.querySelectorAll(".chip").forEach((c) => c.onclick = () => { q = c.dataset.seed; render(); el("pkSearch").focus(); });
      document.querySelectorAll(".pk-item").forEach((it) => (it.onclick = () => {
        const rec = recs.find((x) => x.id === it.dataset.id);
        closeModal();
        cb(rec);
      }));
    };
    render();
  }

  // ---------- 智能查询 ----------
  // 需求①：联网在线查询开关（仅内部台账域 水利/感知 显示，默认本地查询）
  const ONLINE_KEY = "ai_online_v1";
  function querySysPrompt(dm, online) {
    if (!dm.internal) return "你是古建文化知识助手，回答准确、专业、简明。";
    return online
      ? "你是内部台账分析助手，可结合公开网络资料辅助分析。可引用公开信息，但须明确区分『本地台账数据』与『公开网络信息』，标注数据来源与时效；对无法确认的内容标注存疑。"
      : "你是内部台账分析助手。仅基于用户提供的本地数据作答，不要编造公开网络信息。";
  }
  function modeBarHtml(dm, online) {
    if (!dm.internal) return "";
    return `<div class="ai-mode" style="padding:8px 10px;margin-bottom:10px;background:#f3f6fb;border-radius:8px;font-size:13px">
      <span style="margin-right:8px;color:#555">查询模式</span>
      <label style="margin-right:14px;cursor:pointer"><input type="radio" name="aimode" value="local" ${online ? "" : "checked"}> 本地查询</label>
      <label style="cursor:pointer"><input type="radio" name="aimode" value="online" ${online ? "checked" : ""}> 联网在线查询</label>
    </div>`;
  }

  // 需求③：查询历史记录（按时间保存，可查看 / 强制二次查询，省词元）
  const HIST_KEY = "ai_query_hist_v1";
  const HIST_MAX = 50;
  function getHistory() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch (e) { return []; } }
  function pushHistory(item) {
    const h = getHistory();
    h.unshift(item);
    while (h.length > HIST_MAX) h.pop();
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) {}
  }
  // 需求④：查询结果存入知识库须精简；默认不保存，由用户主动点「保存到知识库」
  function saveQueryToKB(prompt, answer, dm, online) {
    if (!window.KB) { toast("知识库未启用"); return; }
    const plain = String(answer).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const concise = plain.slice(0, 600);
    window.KB.put({
      id: "qa_" + Date.now().toString(36),
      type: "qa",
      title: (prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt),
      domain: dm.appName,
      mode: online ? "online" : "local",
      body: concise,
      time: new Date().toISOString()
    }).then(() => toast("已保存到知识库")).catch((e) => toast("保存失败：" + e.message));
  }
  function openHistory(dm) {
    const h = getHistory();
    const rows = h.length ? h.map((it, i) =>
      `<div class="hist-item">
        <div class="hist-top"><span class="hist-badge ${it.online ? "on" : "off"}">${it.online ? "联网" : "本地"}</span><span class="hist-time">${it.time ? new Date(it.time).toLocaleString() : ""}</span></div>
        <div class="hist-q">${esc2(it.recName || it.q || "")}</div>
        <div class="hist-acts"><button class="btn ghost sm" data-act="view" data-i="${i}">查看</button><button class="btn ghost sm" data-act="re" data-i="${i}">强制二次查询</button></div>
      </div>`).join("")
      : '<div class="hint">暂无查询历史</div>';
    openModal("查询历史", `<div class="hist-list">${rows}</div>`,
      `<button class="btn ghost" id="histClose">关闭</button><button class="btn primary" id="histClear">清空历史</button>`);
    el("histClose").onclick = closeModal;
    el("histClear").onclick = () => { if (window.confirm("确认清空全部查询历史？")) { localStorage.removeItem(HIST_KEY); closeModal(); toast("已清空历史"); } };
    document.querySelectorAll(".hist-item").forEach((node) => {
      const i = +node.querySelector('[data-act="view"]').dataset.i;
      const it = h[i];
      node.querySelector('[data-act="view"]').onclick = () => {
        openModal("历史 · " + esc2(it.recName || "查询"), `<div class="ai-out">${it.answer ? mdLite(it.answer) : '<div class="hint">无缓存结果</div>'}</div>`,
          `<button class="btn ghost" id="hvClose">关闭</button>`);
        el("hvClose").onclick = closeModal;
      };
      node.querySelector('[data-act="re"]').onclick = () => {
        closeModal();
        const rec = mergedRecords().find((x) => x.id === it.recId);
        if (!rec) { toast("原条目已不存在，无法重查"); return; }
        AI.query(rec);
      };
    });
  }

  async function runQuery(dm, rec) {
    const prompt = dm.queryPrompt(rec);
    let online = localStorage.getItem(ONLINE_KEY) === "1" && dm.internal;
    openModal("智能查询 · " + dm.recName(rec),
      modeBarHtml(dm, online) + `<div id="aiOut" class="ai-out"></div><div id="aiActions" class="ai-actions"></div><div id="aiFollowups" class="ai-followups"></div>`,
      `<button class="btn ghost" id="aiClose">关闭</button><button class="btn primary" id="aiCopy">复制结果</button>`);
    el("aiClose").onclick = closeModal;
    el("aiCopy").onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(el("aiOut").innerText); toast("已复制"); };
    const renderActions = (txt) => {
      const box = document.getElementById("aiActions");
      if (!box) return;
      let h = '<button class="btn ghost" id="aiHist">查看历史</button>';
      if (window.KB) h += '<button class="btn primary" id="aiSaveKB">保存到知识库</button>';
      box.innerHTML = h;
      el("aiHist").onclick = () => openHistory(AI.domain);
      if (window.KB) el("aiSaveKB").onclick = () => saveQueryToKB(prompt, txt, dm, online);
    };
    const doQuery = async () => {
      el("aiOut").innerHTML = '<div class="hint">正在调用大模型查询，请稍候…</div>';
      const box = document.getElementById("aiActions"); if (box) box.innerHTML = "";
      try {
        const txt = await strategyCall(prompt, { system: querySysPrompt(dm, online) });
        const localHit = !!window.__kbLocalHit;
        let badge = "";
        if (localHit) badge += '<div class="src-badge">[本地知识库已参考]</div>';
        if (online) badge += '<div class="src-badge online">[联网]</div>';
        else if (!localHit) badge += '<div class="src-badge">[本地]</div>';
        el("aiOut").innerHTML = badge + mdLite(txt);
        renderActions(txt);
        renderFollowups(txt, "aiFollowups");
        pushHistory({ q: prompt, recId: rec.id, recName: dm.recName(rec), online, time: Date.now(), answer: txt });
        if (window.__hermesNote) window.__hermesNote("查询", (online ? "[联网] " : "[本地] ") + prompt.slice(0, 80) + " → " + (txt || "").slice(0, 80));
      } catch (e) {
        el("aiOut").innerHTML = '<div class="err">调用失败：' + esc2(e.message) + "</div>";
      }
    };
    if (dm.internal) {
      document.querySelectorAll('input[name="aimode"]').forEach((r) => (r.onchange = () => {
        online = r.value === "online";
        localStorage.setItem(ONLINE_KEY, online ? "1" : "0");
        doQuery();
      }));
    }
    await doQuery();
  }

  // ---------- 智能查询后续操作（#8）：从结果提取关键词，单击复制 / 双击回填检索 ----------
  function renderFollowups(txt, containerId) {
    const box = document.getElementById(containerId);
    if (!box) return;
    const dm = AI.domain;
    let kws = [];
    if (dm && typeof dm.suggestFrom === "function") kws = dm.suggestFrom(txt);
    kws = (kws || []).filter(Boolean).slice(0, 10);
    if (!kws.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="fup-hint">💡 进一步查询：单击复制关键词，双击填入查询框并检索</div>' +
      kws.map((k) => `<span class="fup-chip" data-kw="${esc2(k)}" title="单击复制 / 双击检索：${esc2(k)}">${esc2(k)}</span>`).join("");
    box.querySelectorAll(".fup-chip").forEach((c) => {
      const kw = c.dataset.kw;
      let timer = 0;
      c.addEventListener("click", () => {
        // 220ms 内若发生双击，由 dblclick 清掉此计时，避免重复复制
        timer = setTimeout(() => {
          try { if (navigator.clipboard) navigator.clipboard.writeText(kw); } catch (e) {}
          toast("已复制关键词：" + kw);
        }, 220);
      });
      c.addEventListener("dblclick", () => {
        clearTimeout(timer);
        if (dm && typeof dm.runSearch === "function") dm.runSearch(kw);
        else if (typeof closeModal === "function") closeModal();
      });
    });
  }

  // ---------- 智能问询（#7）：自由提问机构级 / 汇总类问题，注入本地机构层级统计 ----------
  async function openFreeQuery(dm) {
    dm = dm || AI.domain;
    if (!dm) return toast("AI 未初始化");
    openModal("智能问询 · " + (dm.appName || "台账"),
      `<div class="hint">直接问机构级 / 汇总类问题，例如「${dm.internal ? "清源灌区管理处有几个管理所" : "某古建的营造年代"}」。系统会注入本地台账统计信息，由大模型基于真实数据作答。</div>
       <div class="field" style="margin-top:10px"><textarea id="aiFQIn" class="inp" rows="3" placeholder="输入你的问题…（Ctrl/⌘+Enter 发送）"></textarea></div>
       <div id="aiFQOut" class="ai-out"></div><div id="aiFQActions" class="ai-actions"></div><div id="aiFQFollowups" class="ai-followups"></div>`,
      `<button class="btn ghost" id="aiFQClose">关闭</button><button class="btn primary" id="aiFQSend">问询</button>`);
    el("aiFQClose").onclick = closeModal;
    const send = async () => {
      const q = (el("aiFQIn") ? el("aiFQIn").value : "").trim();
      if (!q) { toast("请输入问题"); return; }
      el("aiFQOut").innerHTML = '<div class="hint">正在调用大模型问询，请稍候…</div>';
      const actBox = document.getElementById("aiFQActions"); if (actBox) actBox.innerHTML = "";
      try {
        const ctx = (dm.orgContext && typeof dm.orgContext === "function") ? dm.orgContext(q) : "";
        const sys = dm.internal
          ? "你是水利工程内部台账智能问询助手。下面提供了本地台账的机构层级与统计信息（这是权威数据，请严格基于它作答，不要编造；无法从数据得出的内容请明确说明『无足够数据』。回答简明、用中文。"
          : "你是古建知识助手，基于你掌握的资料与本地知识库作答，简明、专业。";
        const prompt = ctx ? ("【本地台账统计信息】\n" + ctx + "\n\n---\n\n用户问题：" + q) : q;
        const txt = await strategyCall(prompt, { system: sys, maxTokens: 1400 });
        el("aiFQOut").innerHTML = mdLite(txt);
        let h = '<button class="btn ghost" id="aiFQCopy">复制结果</button>';
        if (window.KB) h += '<button class="btn primary" id="aiFQSaveKB">保存到知识库</button>';
        if (actBox) {
          actBox.innerHTML = h;
          const cp = document.getElementById("aiFQCopy"); if (cp) cp.onclick = () => { try { if (navigator.clipboard) navigator.clipboard.writeText(txt); } catch (e) {} toast("已复制"); };
          const sk = document.getElementById("aiFQSaveKB"); if (sk) sk.onclick = () => saveQueryToKB(q, txt, dm, false);
        }
        renderFollowups(txt, "aiFQFollowups");
        pushHistory({ q, recId: "", recName: "智能问询：" + q.slice(0, 30), online: false, time: Date.now(), answer: txt });
        if (window.__hermesNote) window.__hermesNote("智能问询", q.slice(0, 80) + " → " + (txt || "").slice(0, 80));
      } catch (e) {
        el("aiFQOut").innerHTML = '<div class="err">调用失败：' + esc2(e.message) + "</div>";
      }
    };
    el("aiFQSend").onclick = send;
    el("aiFQIn").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send(); });
  }

  // ---------- 智能更新 ----------
  async function runUpdate(dm, rec) {
    openModal("智能更新 · " + dm.recName(rec),
      `<div class="hint">大模型将基于已知信息补全/校正该条目，请人工复核后应用（仅写入本地改动，可随时重置）。</div><div id="aiUpd"></div>`,
      `<button class="btn ghost" id="aiUpdClose">关闭</button><button class="btn primary" id="aiUpdApply" disabled>应用更新</button>`);
    el("aiUpdClose").onclick = closeModal;
    const sys = dm.internal
      ? '你是水利工程内部台账助手。仅依据用户提供的本地台账字段，对缺失项做合理补全建议、对错漏项做校验提示。严禁编造公开网络数据。返回严格 JSON：{"params":{"键":"值"},"description":"一句话描述","changes":["变更说明"]}。只返回 JSON。'
      : '你是古建资料助手。依据用户提供的已知条目，补充权威、准确的建筑背景与参数。返回严格 JSON：{"params":{"键":"值"},"description":"一句话描述","changes":["变更说明"]}。只返回 JSON。';
    try {
      const raw = await strategyCall(dm.updatePrompt(rec), { system: sys, json: true });
      const obj = parseJsonSafe(raw);
      if (!obj || !obj.params) throw new Error("模型未返回可解析的 JSON（params 缺失）");
      const cur = mergedOne(rec.id);
      let html = '<div class="ai-diff">';
      html += '<div class="ai-row"><b>简介</b><textarea id="aiUDesc" class="inp" rows="2" style="width:100%;margin-top:4px">' + esc2(obj.description || "") + "</textarea></div>";
      html += '<div class="ai-row"><b>参数</b><span class="hint" style="display:inline">（新值可编辑，留空或与原值相同则不改动）</span><table class="ai-tbl"><tr><th>键</th><th>原值</th><th>新值</th></tr>';
      const keys = new Set([...(cur.params ? Object.keys(cur.params) : []), ...(obj.params ? Object.keys(obj.params) : [])]);
      keys.forEach((k) => {
        const oldV = cur.params && cur.params[k] != null ? cur.params[k] : "";
        const newV = obj.params && obj.params[k] != null ? obj.params[k] : "";
        const cls = String(oldV) !== String(newV) ? "chg" : "";
        html += `<tr class="${cls}" data-old="${esc2(oldV)}"><td>${esc2(k)}</td><td>${esc2(oldV)}</td><td><input class="ai-edit" data-k="${esc2(k)}" value="${esc2(newV)}"></td></tr>`;
      });
      html += "</table></div>";
      if (obj.changes && obj.changes.length) html += '<div class="hint">' + obj.changes.map((c) => "• " + esc2(c)).join("<br>") + "</div>";
      html += "</div>";
      el("aiUpd").innerHTML = html;
      // 新值编辑时实时高亮：与原值不同则标 chg
      el("aiUpd").querySelectorAll("input.ai-edit").forEach((inp) => {
        inp.addEventListener("input", () => {
          const tr = inp.closest("tr");
          if (tr) tr.classList.toggle("chg", inp.value !== tr.dataset.old);
        });
      });
      el("aiUpdApply").disabled = false;
      el("aiUpdApply").onclick = async () => {
        const desc = el("aiUDesc").value.trim();
        const finalParams = Object.assign({}, cur.params || {});
        el("aiUpd").querySelectorAll("input.ai-edit").forEach((inp) => {
          const k = inp.dataset.k;
          const ov = cur.params && cur.params[k] != null ? String(cur.params[k]) : "";
          if (inp.value !== ov) finalParams[k] = inp.value; // 仅写入有变动的键
        });
        await applyUpdate(rec.id, { params: finalParams, description: desc || cur.description });
        if (window.__hermesNote) window.__hermesNote("更新", "已应用更新(人工复核)：" + rec.name + " :: " + (obj.changes || []).join("；"));
        closeModal();
        toast("已应用智能更新（可到「重置为基础数据」撤销）");
      };
    } catch (e) {
      el("aiUpd").innerHTML = '<div class="err">智能更新失败：' + esc2(e.message) + "</div>";
    }
  }

  // ---------- 智能纠错（标注，不改原值）----------
  function showCorrectForm(dm, rec) {
    const cur = mergedOne(rec.id);
    const firstKey = cur.params ? Object.keys(cur.params)[0] : "";
    openModal("智能纠错 · " + dm.recName(rec),
      `<div class="hint">若本 App 信息正确，但常见资料/网络说法有误，可在此标注纠错，便于团队核对，不影响原数据展示。</div>
       <div class="field"><label>纠错字段</label><input id="cfField" class="inp" placeholder="如：建造年代 / 保护级别" value="${esc2(firstKey || "")}"></div>
       <div class="field"><label>本 App 正确值</label><input id="cfApp" class="inp" value="${esc2((cur.params && cur.params[firstKey]) || "")}"></div>
       <div class="field"><label>常见错误/网络说法</label><input id="cfWrong" class="inp" placeholder="如：网上误写为唐代"></div>
       <div class="field"><label>说明/依据</label><textarea id="cfNote" class="inp" rows="3" placeholder="纠错依据…"></textarea></div>`,
      `<button class="btn ghost" id="cfCancel">取消</button><button class="btn primary" id="cfSave">保存纠错标注</button>`);
    el("cfCancel").onclick = closeModal;
    el("cfSave").onclick = async () => {
      const corr = {
        id: "c" + Date.now().toString(36),
        field: (el("cfField").value || "").trim(),
        appValue: (el("cfApp").value || "").trim(),
        wrong: (el("cfWrong").value || "").trim(),
        note: (el("cfNote").value || "").trim(),
        time: new Date().toISOString()
      };
      if (!corr.field && !corr.wrong) { toast("请至少填写纠错字段或错误说法"); return; }
      await addCorrection(rec.id, corr);
      if (window.__hermesNote) window.__hermesNote("纠错", "已标注纠错：" + rec.name + " :: " + (corr.field || "") + " → " + (corr.note || ""));
      closeModal();
      toast("已保存纠错标注");
    };
  }

  // ---------- AI 对话助手 ----------
  function openChat(dm) {
    let online = localStorage.getItem(ONLINE_KEY) === "1" && dm.internal;
    const chatSys = (on) => {
      if (!dm.internal) return "你是" + dm.appName + "知识助手，专业、简明。";
      return on
        ? "你是" + dm.appName + "内部台账智能助手，可结合公开网络资料辅助回答，并标注信息来源与时效，对不确定内容标注存疑。"
        : "你是" + dm.appName + "内部台账智能助手，基于用户提供的本地数据回答问题，不编造公开信息。";
    };
    openModal("AI 对话助手",
      modeBarHtml(dm, online) +
      `<div class="ai-chat" id="aiChatLog"></div>
       <div class="field" style="margin-top:10px"><textarea id="aiChatIn" class="inp" rows="3" placeholder="问点什么…（Ctrl/⌘+Enter 发送）"></textarea></div>`,
      `<button class="btn ghost" id="aiChatClose">关闭</button><button class="btn primary" id="aiChatSend">发送</button>`);
    el("aiChatClose").onclick = closeModal;
    const log = el("aiChatLog");
    const send = async () => {
      const v = el("aiChatIn").value.trim();
      if (!v) return;
      el("aiChatIn").value = "";
      const me = document.createElement("div");
      me.className = "bub me"; me.textContent = v; log.appendChild(me);
      const ai = document.createElement("div");
      ai.className = "bub ai"; ai.textContent = "思考中…"; log.appendChild(ai); log.scrollTop = log.scrollHeight;
      try {
        const t = await strategyCall(v, { system: chatSys(online) });
        ai.innerHTML = mdLite(t);
        if (window.__hermesNote) window.__hermesNote("对话", (online ? "[联网] " : "[本地] ") + v + " → " + (t || "").slice(0, 120));
      } catch (e) {
        ai.innerHTML = '<span class="err">' + esc2(e.message) + "</span>";
      }
      log.scrollTop = log.scrollHeight;
    };
    if (dm.internal) {
      document.querySelectorAll('input[name="aimode"]').forEach((r) => (r.onchange = () => {
        online = r.value === "online";
        localStorage.setItem(ONLINE_KEY, online ? "1" : "0");
      }));
    }
    el("aiChatSend").onclick = send;
    el("aiChatIn").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send(); });
  }

  // ---------- 设置面板 ----------
  function openSettings() {
    const s = loadSettings();
    const modelRows = () => s.models.map((m, i) =>
      `<div class="ai-model" data-i="${i}">
        <div class="am-head"><b>${esc2(m.name || "模型" + (i + 1))}</b>${m.local ? '<span class="tag">本地</span>' : ""}<span class="am-proto">${esc2(m.protocol || "openai")}</span></div>
        <div class="am-grid">
          <label>名称<input class="inp am-name" value="${esc2(m.name || "")}"></label>
          <label>引用地址<input class="inp am-url" value="${esc2(m.baseUrl || "")}" placeholder="https://openrouter.ai/api/v1"></label>
          <label>协议<input class="inp am-proto" value="${esc2(m.protocol || "openai")}"></label>
          <label>模型ID<input class="inp am-mid" value="${esc2(m.modelId || "")}" placeholder="如 openai/gpt-4o-mini"></label>
          <label>API Key<input class="inp am-key" type="password" value="${esc2(m.apiKey || "")}" placeholder="留空则不带鉴权"></label>
          <label class="am-local"><input type="checkbox" class="am-loc" ${m.local ? "checked" : ""}> 本地模型(同机/局域网)</label>
        </div>
        <button class="btn ghost am-del">删除</button>
      </div>`).join("");
    const syncEdits = () => {
      document.querySelectorAll(".ai-model").forEach((node) => {
        const i = +node.dataset.i; const m = s.models[i]; if (!m) return;
        m.name = node.querySelector(".am-name").value.trim() || m.name;
        m.baseUrl = node.querySelector(".am-url").value.trim();
        m.protocol = (node.querySelector("input.am-proto") || node.querySelector(".am-proto")).value.trim() || "openai";
        m.modelId = node.querySelector(".am-mid").value.trim();
        m.apiKey = node.querySelector(".am-key").value;
        m.local = node.querySelector(".am-loc").checked;
      });
    };
    const render = () => {
      const defOpts = s.models.map((m) => `<option value="${esc2(m.id)}" ${m.id === s.defaultModel ? "selected" : ""}>${esc2(m.name || m.id)}</option>`).join("");
      const orderOpts = s.models.map((m) => `<option value="${esc2(m.id)}" ${((s.strategy.order || []).indexOf(m.id) >= 0) ? "selected" : ""}>${esc2(m.name || m.id)}</option>`).join("");
      const html =
        `<div class="hint">配置大模型接口。默认引用地址为 OpenRouter（OpenAI 兼容协议）。也可填本地部署模型（Ollama 默认 http://localhost:11434/v1，LM Studio http://localhost:1234/v1）。浏览器/PWA 下本地模型需开启 CORS；安卓端 localhost 指向手机本身，请填 PC 局域网 IP。</div>
         <div id="aiModels">${modelRows()}</div>
         <button class="btn ghost" id="aiAddModel">＋ 添加模型</button>
         <div class="field" style="margin-top:12px"><label>默认模型</label><select id="aiDefault" class="inp">${defOpts}</select></div>
         <div class="field"><label>自动调用策略</label><select id="aiStrat" class="inp">
           <option value="single" ${s.strategy.mode === "single" ? "selected" : ""}>单模型（仅默认）</option>
           <option value="fallback" ${s.strategy.mode === "fallback" ? "selected" : ""}>失败回退（按顺序尝试下一个）</option>
           <option value="roundrobin" ${s.strategy.mode === "roundrobin" ? "selected" : ""}>轮询切换（多模型负载均衡）</option>
         </select></div>
         <div class="field" id="aiOrderWrap" style="${s.strategy.mode === "single" ? "display:none" : ""}"><label>策略模型顺序（Ctrl/⌘ 多选）</label><select id="aiOrder" class="inp" multiple size="4">${orderOpts}</select></div>`;
      openModal("大模型 AI 设置", html,
        `<button class="btn ghost" id="aiSetCancel">取消</button><button class="btn primary" id="aiSetSave">保存</button><button class="btn ghost" id="aiSetTest">测试默认模型</button>`);
      el("aiSetCancel").onclick = closeModal;
      el("aiStrat").onchange = () => { el("aiOrderWrap").style.display = el("aiStrat").value === "single" ? "none" : ""; };
      el("aiAddModel").onclick = () => { syncEdits(); s.models.push({ id: "m" + Date.now().toString(36), name: "新模型", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", apiKey: "", modelId: "", local: false }); render(); };
      document.querySelectorAll(".am-del").forEach((b) => (b.onclick = () => { syncEdits(); const i = +b.closest(".ai-model").dataset.i; s.models.splice(i, 1); render(); }));
      el("aiSetTest").onclick = async () => {
        syncEdits();
        const m = s.models.find((x) => x.id === el("aiDefault").value);
        if (!m) { toast("请先选择默认模型"); return; }
        busy("正在测试…");
        try { const t = await callOne(m, "回复 OK 两个字", {}); toast("测试成功：" + t.slice(0, 40)); }
        catch (e) { toast("测试失败：" + e.message); }
      };
      el("aiSetSave").onclick = () => {
        syncEdits();
        s.defaultModel = el("aiDefault").value;
        s.strategy.mode = el("aiStrat").value;
        s.strategy.order = [].slice.call(el("aiOrder").selectedOptions).map((o) => o.value);
        if (!s.strategy.order.length) s.strategy.order = [s.defaultModel];
        s.strategy.last = 0;
        saveSettings(s);
        closeModal();
        toast("AI 设置已保存");
      };
    };
    render();
  }

  // ---------- 对外入口 ----------
  const AI = {
    domain: null,
    loadSettings, saveSettings, defaultSettings,
    openSettings,
    openQuery() { if (!AI.domain) return toast("AI 未初始化"); pickRecord(AI.domain, (r) => runQuery(AI.domain, r)); },
    openUpdate() { if (!AI.domain) return toast("AI 未初始化"); pickRecord(AI.domain, (r) => runUpdate(AI.domain, r)); },
    openCorrect() { if (!AI.domain) return toast("AI 未初始化"); pickRecord(AI.domain, (r) => showCorrectForm(AI.domain, r)); },
    openChat() { if (!AI.domain) return toast("AI 未初始化"); openChat(AI.domain); },
    openFreeQuery() { if (!AI.domain) return toast("AI 未初始化"); openFreeQuery(AI.domain); },
    // 右键菜单等场景：对指定记录直接调用（不再弹选择器）
    query(rec) { if (!AI.domain) return toast("AI 未初始化"); rec ? runQuery(AI.domain, rec) : AI.openQuery(); },
    update(rec) { if (!AI.domain) return toast("AI 未初始化"); rec ? runUpdate(AI.domain, rec) : AI.openUpdate(); },
    correct(rec) { if (!AI.domain) return toast("AI 未初始化"); rec ? showCorrectForm(AI.domain, rec) : AI.openCorrect(); },
    openHistory() { if (!AI.domain) return toast("AI 未初始化"); openHistory(AI.domain); },
    strategyCall,
    // 知识库联网查询桥接：供 app.js「知识库查询」在本地无结果时兜底
    kbOnlineQuery(q) {
      const sys = "你是水利工程内部台账与资料助手。基于用户提供的本地台账与可靠信息，回答工程/建筑物相关查询；如需补充公开常识请注明来源。用中文、简洁、准确。";
      return strategyCall(q, { system: sys });
    },
    mdLite, esc2
  };
  global.AI = AI;
})(window);
