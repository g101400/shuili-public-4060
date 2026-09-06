/* upgrade.js —— 升级数据导出 / 导入 + 跨版本兼容检查 + 网盘新版检测（三端同源，v2.4.3 新增）
 *
 * 设计要点（对应用户三条硬需求）：
 *  1) 跨版本兼容：导出包顶层【平铺 added/updated/deleted】，旧版「导入我的改动」只校验 d.added 是数组，
 *     因此新版导出的包可以被旧版原样导入（向后兼容），不会因为新增字段而报错。
 *  2) 升级不丢数据：启动时比对上次运行版本/schema，schema 落后则原地迁移（补 thumb/full 等字段，绝不覆盖原图），
 *     并在版本变化的首次启动弹窗提醒「先导出备份」，一键即等于点「升级数据导出」。
 *  3) 网盘检测新版：公开版只读 public 通道、内部版只读 internal 通道，manifest 里 channel 不匹配直接拒绝，
 *     无新版明确提示；不可达 / 未配置一律 fail-loud 给出降级路径，绝不静默失败。
 *
 * 依赖：Store（必需）、IO（必需）、KB（可选）、ImgUtil（可选）、openModal/closeModal/toast/busy/el（app.js 暴露）
 */
(function (global) {
  "use strict";

  // ---------- 平台与通道标识 ----------
  var APP_ID = global.__APP_ID__ || "shuili";
  var APP_NAME = global.__APP_NAME__ || (global.document && document.title) || APP_ID;
  var CHANNEL = (global.__BUILD_CHANNEL__ === "internal") ? "internal" : "public";
  var CHANNEL_CN = CHANNEL === "internal" ? "内部版" : "公开版";
  function appVer() { return global.__APP_VER__ || "v0.0.0"; }

  // ---------- 数据结构版本（schema）----------
  // 1: v1.8.0~v1.9.x  照片仅 dataUrl
  // 2: v2.0~v2.3      照片 thumb/full/fullPath 三态；ops_state 引入
  // 3: v2.4+          组织配置持久化(orgcfg)、quickfavs、类型管理
  // 4: v2.4.3+        备忘录/游记（journals）、升级备份包
  var SCHEMA = 4;
  var MIN_READABLE_SCHEMA = 1;   // 本版本能读回的最低 schema
  var MAGIC = "YZT-BACKUP";      // 一张图家族备份包标识

  var LS_LAST_VER = "yzt_last_run_ver";
  var LS_LAST_SCHEMA = "yzt_last_run_schema";
  var LS_MANIFEST = "yzt_update_manifest_" + CHANNEL;   // 通道隔离：两个 key 互不干扰
  var LS_BACKUP_TS = "yzt_last_backup_ts";
  var LS_BACKUP_DIR = "yzt_backup_dir";                 // v2.4.6：记住上次导出的文件夹
  var LS_BACKUP_NAME = "yzt_backup_name";               // v2.4.6：记住上次导出的文件名（不含日期）
  var LS_AUTOCHECK = "yzt_update_autocheck_" + CHANNEL;
  var LS_AUTODL = "yzt_upgrade_autodl_" + CHANNEL;      // v2.4.7：发现新版自动下载安装包（默认开） // v2.4.6：本通道是否开启自动检测新版
  var LS_AUTODL = "yzt_upgrade_autodl_" + CHANNEL;      // v2.4.7：发现新版自动下载安装包（默认开）
  var LS_SKIPVER = "yzt_update_skipver_" + CHANNEL;     // v2.4.6：「跳过此版本」不再提示

  // ---------- v2.4.6：备份包默认文件名（用户指定口径）----------
  // 水利一张图备份+日期.bak / 感知设备一张图+日期.bak / 古建景点打卡备份+日期.bak
  var BACKUP_TITLE = ({
    shuili: "水利一张图备份",
    shipin: "感知设备一张图",
    gujian: "古建景点打卡备份"
  })[APP_ID] || (APP_NAME + "备份");
  var BACKUP_EXT = ".bak";
  function dateStamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function defaultBackupName() {
    var saved = "";
    try { saved = localStorage.getItem(LS_BACKUP_NAME) || ""; } catch (e) {}
    return (saved && saved.trim()) ? saved.trim() : (BACKUP_TITLE + dateStamp() + BACKUP_EXT);
  }
  function defaultBackupDir() {
    var saved = "";
    try { saved = localStorage.getItem(LS_BACKUP_DIR) || ""; } catch (e) {}
    return (saved && saved.trim()) ? saved.trim() : "一张图备份";
  }
  // 组装落盘相对路径：文件夹/文件名（Electron 会按层级建目录；安卓走 SAF 由用户选目录，只用文件名）
  function joinPath(dir, name) {
    var d = String(dir || "").replace(/[\\/]+$/, "").trim();
    var n = String(name || "").replace(/^[\\/]+/, "").trim();
    return d ? (d + "/" + n) : n;
  }
  function baseName(p) { var s = String(p || ""); var i = s.replace(/\\/g, "/").lastIndexOf("/"); return i >= 0 ? s.slice(i + 1) : s; }

  // ---------- v2.4.6：网盘自动升级（公开版 / 内部版双通道同权）----------
  // 内置默认清单地址（可为空；留空时以用户在设置里填的为准）。渠道目录约定：
  //   …/public/latest.json   → 公开版
  //   …/internal/latest.json → 内部版
  // 百度网盘分享页不能被程序直读（需登录、无跨域许可），因此 latest.json 必须放在
  // 可匿名直读的地址（网盘直链 / 对象存储 / 静态站点）。清单里的 download 可以是百度网盘分享链接
  // （程序只负责打开与复制提取码，下载交给系统浏览器/网盘 App）。
  var MANIFEST_DEFAULT = ({
    shuili: { public: "", internal: "" },
    shipin: { public: "", internal: "" },
    gujian: { public: "", internal: "" }
  })[APP_ID] || { public: "", internal: "" };
  // 网盘（人工核对）入口：按通道分开，内部版不再共用公开版目录
  var PAN_HOME = ({
    shuili: { public: "https://pan.baidu.com/", internal: "https://pan.baidu.com/" },
    shipin: { public: "https://pan.baidu.com/", internal: "https://pan.baidu.com/" },
    gujian: { public: "https://pan.baidu.com/", internal: "https://pan.baidu.com/" }
  })[APP_ID] || { public: "https://pan.baidu.com/", internal: "https://pan.baidu.com/" };

  // 备份要带走的 localStorage 键（前缀白名单 + 精确名）
  var LS_PREFIX = ["yzt_", "ui_state", "ops_state", "appsettings_", "kb_", "quickfavs", "_kw_hist", "_quickfavs", "orgcfg", "btype"];
  var LS_SECRET = ["ai_settings", "ai_key", "appsettings_key_v1", "aicfg"];   // 含密钥，默认不导出

  function isBackupKey(k) {
    if (!k) return false;
    for (var i = 0; i < LS_PREFIX.length; i++) if (k.indexOf(LS_PREFIX[i]) >= 0) return true;
    return false;
  }
  function isSecretKey(k) {
    for (var i = 0; i < LS_SECRET.length; i++) if (k.indexOf(LS_SECRET[i]) >= 0) return true;
    return false;
  }

  // ---------- 小工具 ----------
  function T(msg) { if (typeof global.toast === "function") global.toast(msg); else console.log("[upgrade]", msg); }
  function E(id) { return global.document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function ts() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  // 备份新鲜度提示：让用户一眼判断「这是不是最新备份」
  function backupAge(iso) {
    if (!iso) return '<span style="color:#ffb454">⚠ 该文件未记录导出时间，无法判断是否最新，请人工确认。</span>';
    var t = new Date(iso).getTime();
    if (!t || isNaN(t)) return '<span style="color:#ffb454">⚠ 导出时间无法解析（' + esc(String(iso).slice(0, 24)) + '），请人工确认。</span>';
    var days = Math.floor((Date.now() - t) / 86400000);
    var when = new Date(t).toLocaleString();
    if (days < 0) return '<span style="color:#ffb454">⚠ 导出时间在未来（' + esc(when) + '），请确认设备时间是否正确。</span>';
    if (days === 0) return '<span style="color:#7ddc7d">✓ 导出于今天 ' + esc(when) + '。</span>';
    if (days <= 7) return '<span style="color:#7ddc7d">✓ 导出于 ' + days + ' 天前（' + esc(when) + '）。</span>';
    return '<span style="color:#ffb454">⚠ 该备份导出于 <b>' + days + ' 天前</b>（' + esc(when)
      + '）。若之后还有更新，用它还原会丢失后续数据，请确认这是最新一次导出。</span>';
  }
  function sizeText(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }
  // 版本比较：v2.4.10 > v2.4.2（按段数值比较，非字典序）
  function verNums(v) {
    return String(v || "").replace(/^[vV]/, "").split(/[.\-_]/).map(function (x) { return parseInt(x, 10) || 0; });
  }
  function verCmp(a, b) {
    var x = verNums(a), y = verNums(b), n = Math.max(x.length, y.length);
    for (var i = 0; i < n; i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  // 文件选择：持有引用并挂 DOM，规避 WebView GC 导致「点了没反应」（项目历史坑）
  var _pickHold = [];
  function pickFile(accept, onPick) {
    var inp = global.document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.style.position = "fixed"; inp.style.left = "-9999px";
    global.document.body.appendChild(inp);
    _pickHold.push(inp);
    var fired = false;
    inp.onchange = function () {
      fired = true;
      var f = inp.files && inp.files[0];
      try { if (f) onPick(f); } finally {
        setTimeout(function () { try { inp.remove(); } catch (e) {} }, 0);
      }
    };
    inp.click();
    // 非静默失败看门狗：2.5s 内既没选也没弹选择器，明确告知
    setTimeout(function () { if (!fired && !inp.files.length) { /* 用户可能取消，不误报，仅保留引用 */ } }, 2500);
  }

  // ---------- 采集：把全部本地数据打成一个包 ----------
  async function collect(opts) {
    opts = opts || {};
    var pkg = {
      magic: MAGIC,
      app: APP_ID,
      appName: APP_NAME,
      appVer: appVer(),
      channel: CHANNEL,
      schema: SCHEMA,
      minSchema: MIN_READABLE_SCHEMA,
      exportedAt: new Date().toISOString(),
      // ★ 顶层平铺 delta 三字段 = 旧版可直接导入（向后兼容的关键）
      added: [], updated: {}, deleted: [],
      localStore: {},
      checkins: [],
      journals: [],
      kb: [],
      counts: {},
      warnings: []
    };

    // 1) delta（增删改，照片随记录）
    var delta = { added: [], updated: {}, deleted: [] };
    try { delta = await global.Store.get(); } catch (e) { pkg.warnings.push("读取本地改动失败：" + e.message); }
    pkg.added = delta.added || [];
    pkg.updated = delta.updated || {};
    pkg.deleted = delta.deleted || [];

    // 2) 照片完整性：安卓端原图在磁盘(fullPath)，尽量回读内嵌，回读失败明确记账（不静默）
    var photoTotal = 0, embedded = 0, thumbOnly = 0;
    var recs = [].concat(pkg.added, Object.keys(pkg.updated).map(function (k) { return pkg.updated[k]; }));
    for (var i = 0; i < recs.length; i++) {
      var ps = (recs[i] && recs[i].photos) || [];
      for (var j = 0; j < ps.length; j++) {
        var p = ps[j];
        photoTotal++;
        if (p.full && String(p.full).indexOf("data:") === 0) { embedded++; continue; }
        if (p.fullPath && global.AndroidBridge && global.AndroidBridge.loadFullImage) {
          try {
            var full = global.AndroidBridge.loadFullImage(p.fullPath);
            if (full && String(full).indexOf("data:") === 0) { p.full = full; embedded++; continue; }
          } catch (e) {}
        }
        if (p.thumb || p.dataUrl) thumbOnly++;
      }
    }
    if (thumbOnly) pkg.warnings.push(thumbOnly + " 张照片仅内嵌缩略图（原图在设备磁盘未能回读），导入后可用但清晰度下降；建议同时用「导出照片」再存一份原图 zip。");

    // 3) localStorage（UI 偏好 / 运维业务 / 组织与类型配置 / 关键词历史 …）
    try {
      for (var k = 0; k < localStorage.length; k++) {
        var key = localStorage.key(k);
        if (!isBackupKey(key)) continue;
        if (isSecretKey(key) && !opts.withSecret) continue;
        pkg.localStore[key] = localStorage.getItem(key);
      }
    } catch (e) { pkg.warnings.push("读取本地偏好失败：" + e.message); }
    if (!opts.withSecret) pkg.warnings.push("已按默认排除 AI/天地图密钥（防泄露）；如需连密钥一起备份，勾选「包含密钥」。");

    // 4) 打卡记录（古建端有，水利/感知端无则为空）
    try {
      if (global.Store.checkins && global.Store.checkins.get) pkg.checkins = (await global.Store.checkins.get()) || [];
    } catch (e) { pkg.warnings.push("读取打卡记录失败：" + e.message); }

    // 5) 游记 / 备忘录（v2.4.3 新模块，未安装则为空数组）
    try {
      if (global.Journal && global.Journal.all) pkg.journals = (await global.Journal.all()) || [];
    } catch (e) { pkg.warnings.push("读取游记/备忘录失败：" + e.message); }

    // 6) 知识库（AI 可查内容，体积可能较大；可关闭）
    if (opts.withKB !== false) {
      try {
        if (global.KB && global.KB.all) pkg.kb = (await global.KB.all()) || [];
      } catch (e) { pkg.warnings.push("读取知识库失败：" + e.message); }
    }

    pkg.counts = {
      records: pkg.added.length + Object.keys(pkg.updated).length,
      added: pkg.added.length,
      updated: Object.keys(pkg.updated).length,
      deleted: (pkg.deleted || []).length,
      photos: photoTotal,
      photosEmbedded: embedded,
      photosThumbOnly: thumbOnly,
      checkins: pkg.checkins.length,
      journals: pkg.journals.length,
      kb: pkg.kb.length,
      prefs: Object.keys(pkg.localStore).length
    };
    return pkg;
  }

  // ---------- 导出 ----------
  function openExport() {
    var dDir = defaultBackupDir(), dName = defaultBackupName();
    var html = '<div class="hint">把本机<b>全部数据</b>打成一个升级备份包。升级 / 换机 / 重装前先导出，装好新版再用「升级数据导入」还原，'
      + '<b>导入格式与导出完全一致</b>；该包同时兼容旧版本的「导入我的改动」，可回退到旧版使用。</div>'
      + '<div class="field"><label>保存文件夹</label><input id="upExDir" class="inp" value="' + esc(dDir) + '" placeholder="留空=下载目录根层"></div>'
      + '<div class="field"><label>文件名</label><input id="upExName" class="inp" value="' + esc(dName) + '"></div>'
      + '<div class="hint" style="font-size:12px;opacity:.85">默认名：<b>' + esc(BACKUP_TITLE + dateStamp() + BACKUP_EXT) + '</b>'
      + '（可改；桌面版会按「文件夹/文件名」层级建目录，安卓由系统保存对话框选目录）</div>'
      + '<div class="field"><label>包含内容</label>'
      + '<div class="chips">'
      + '<label class="chip" style="cursor:pointer"><input type="checkbox" id="upExKB" checked style="vertical-align:-2px"> 知识库（AI 可查内容）</label>'
      + '<label class="chip" style="cursor:pointer"><input type="checkbox" id="upExSecret" style="vertical-align:-2px"> 包含密钥（AI / 天地图，谨慎）</label>'
      + '</div></div>'
      + '<div class="hint" id="upExStat" style="margin-top:10px;padding:9px 12px;border:1px dashed var(--accent);border-radius:10px">正在统计本机数据…</div>';
    global.openModal("升级数据导出（备份）", html,
      '<button class="btn ghost" onclick="APP.close()">取消</button><button class="btn primary" id="upExGo">📤 导出备份包</button>');

    // 预统计（不含密钥、含 KB），让用户先看到规模
    (async function () {
      try {
        var p = await collect({ withKB: true, withSecret: false });
        var s = E("upExStat");
        if (!s) return;
        var body = JSON.stringify(p);
        s.innerHTML = '将导出：<b>' + p.counts.records + '</b> 条记录改动 · <b>' + p.counts.photos + '</b> 张照片（内嵌原图 '
          + p.counts.photosEmbedded + ' / 仅缩略图 ' + p.counts.photosThumbOnly + '）· 打卡 <b>' + p.counts.checkins
          + '</b> · 游记备忘 <b>' + p.counts.journals + '</b> · 知识库 <b>' + p.counts.kb + '</b> 条 · 偏好 <b>' + p.counts.prefs
          + '</b> 项<br>预估体积约 <b>' + sizeText(body.length) + '</b>'
          + (p.warnings.length ? '<br><span style="color:#ffb454">⚠ ' + p.warnings.map(esc).join('<br>⚠ ') + '</span>' : '');
      } catch (e) {
        var s2 = E("upExStat");
        if (s2) s2.innerHTML = '<span style="color:#ff6b6b">统计失败：' + esc(e.message) + '</span>';
      }
    })();

    E("upExGo").onclick = async function () {
      var dir = (E("upExDir") && E("upExDir").value || "").trim();
      var nameRaw = (E("upExName") && E("upExName").value || "").trim() || (BACKUP_TITLE + dateStamp() + BACKUP_EXT);
      var name = nameRaw;
      if (name.toLowerCase().slice(-BACKUP_EXT.length) !== BACKUP_EXT) name += BACKUP_EXT;   // 统一 .bak 后缀
      var withKB = !!(E("upExKB") && E("upExKB").checked);
      var withSecret = !!(E("upExSecret") && E("upExSecret").checked);
      // 记住本次口径（去掉日期部分，下次沿用用户自定义前缀）
      try {
        localStorage.setItem(LS_BACKUP_DIR, dir);
        localStorage.setItem(LS_BACKUP_NAME, name);
      } catch (e) {}
      if (typeof global.busy === "function") global.busy(true, "正在打包升级数据，请稍后…");
      try {
        var pkg = await collect({ withKB: withKB, withSecret: withSecret });
        var text = JSON.stringify(pkg);
        // 安卓走 SAF 只能给文件名；桌面/网页按「文件夹/文件名」层级
        var br = global.AndroidBridge;
        var isAndroid = !!(br && typeof br.exportStart === "function");
        global.IO.downloadText(isAndroid ? name : joinPath(dir, name), text, "application/json");
        try { localStorage.setItem(LS_BACKUP_TS, String(Date.now())); } catch (e) {}
        global.closeModal();
        T("已导出升级数据：" + sizeText(text.length) + "（" + pkg.counts.records + " 条记录 / " + pkg.counts.photos
          + " 张照片）\n文件名：" + name + (dir && !isAndroid ? "\n文件夹：" + dir : ""));
      } catch (e) {
        T("导出失败：" + e.message);   // fail-loud
      } finally {
        if (typeof global.busy === "function") global.busy(false);
      }
    };
  }

  // ---------- 迁移（旧 schema → 当前）----------
  function migrateRecord(r, fromSchema) {
    if (!r) return r;
    // schema1 → 2：照片只有 dataUrl，补 thumb（渲染用）；原图不动
    if (fromSchema < 2) {
      (r.photos || []).forEach(function (p) {
        if (!p.thumb && p.dataUrl) p.thumb = p.dataUrl;
      });
    }
    // schema2 → 3：组织字段规范化（老包可能缺 province/city）
    if (fromSchema < 3) {
      if (r.province == null) r.province = "";
      if (r.city == null) r.city = "";
    }
    // schema3 → 4：无破坏性变更（新增 journals 独立存储）
    return r;
  }
  function migratePkg(pkg) {
    var from = +pkg.schema || 1, n = 0;
    if (from >= SCHEMA) return { migrated: 0, from: from };
    (pkg.added || []).forEach(function (r) { migrateRecord(r, from); n++; });
    Object.keys(pkg.updated || {}).forEach(function (k) { migrateRecord(pkg.updated[k], from); n++; });
    pkg.schema = SCHEMA;
    return { migrated: n, from: from };
  }

  // ---------- 导入 ----------
  function openImport() {
    var html = '<div class="hint" style="border:1px solid #ff6b6b;border-radius:10px;padding:10px 12px;background:rgba(255,107,107,.08)">'
      + '<b style="color:#ff6b6b">⚠ 导入会覆盖程序中的全部数据</b><br>'
      + '请<b>务必确认选择的是最新一次导出的备份</b>（默认名 ' + esc(BACKUP_TITLE + "日期" + BACKUP_EXT) + '）。'
      + '用旧备份还原会丢失之后新增的记录、照片、打卡、游记备忘与知识库内容，且<b>不可撤销</b>。<br>'
      + '不确定时请先点「先备份当前数据」把现状另存一份。</div>'
      + '<div class="hint" style="margin-top:8px">选择「升级数据导出」生成的备份包还原，支持 <b>' + BACKUP_EXT + ' / .json</b>（两者格式完全一致）；'
      + '也可读入旧版本导出的「我的改动」json（自动迁移字段，照片不丢）。</div>'
      + '<div class="field"><label>还原方式</label><div class="chips" id="upImMode">'
      + '<span class="chip on" data-m="merge">合并（保留本机现有，补入备份里缺的）</span>'
      + '<span class="chip" data-m="replace">覆盖（丢弃本机现有，完全按备份还原）</span>'
      + '</div></div>'
      + '<div class="field"><label>还原内容</label><div class="chips">'
      + '<label class="chip" style="cursor:pointer"><input type="checkbox" id="upImKB" checked style="vertical-align:-2px"> 知识库</label>'
      + '<label class="chip" style="cursor:pointer"><input type="checkbox" id="upImPrefs" checked style="vertical-align:-2px"> 偏好/组织配置</label>'
      + '</div></div>'
      + '<div class="field"><label class="chip" style="cursor:pointer"><input type="checkbox" id="upImConfirm" style="vertical-align:-2px"> '
      + '我确认这是<b>最新备份</b>，并接受它会覆盖程序中的全部数据</label></div>'
      + '<div class="hint" id="upImInfo" style="margin-top:10px;padding:9px 12px;border:1px dashed var(--accent);border-radius:10px">尚未选择文件</div>';
    global.openModal("升级数据导入（还原）", html,
      '<button class="btn ghost" onclick="APP.close()">取消</button>'
      + '<button class="btn ghost" id="upImBak">📤 先备份当前数据</button>'
      + '<button class="btn ghost" id="upImPick">📂 选择备份文件</button><button class="btn primary" id="upImGo" disabled>📥 开始还原</button>');

    var mode = "merge", pkg = null, pickedName = "";
    E("upImBak").onclick = function () { global.closeModal(); openExport(); };
    function syncGo() {
      var ok = !!(E("upImConfirm") && E("upImConfirm").checked);
      E("upImGo").disabled = !(pkg && ok);
    }
    if (E("upImConfirm")) E("upImConfirm").onchange = syncGo;
    var chips = global.document.querySelectorAll("#upImMode .chip");
    Array.prototype.forEach.call(chips, function (c) {
      c.onclick = function () {
        Array.prototype.forEach.call(chips, function (x) { x.classList.remove("on"); });
        c.classList.add("on"); mode = c.dataset.m;
      };
    });

    E("upImPick").onclick = function () {
      pickFile(BACKUP_EXT + ",.bak,.json,application/json,text/plain,*/*", function (f) {
        var fr = new FileReader();
        fr.onerror = function () { E("upImInfo").innerHTML = '<span style="color:#ff6b6b">读取文件失败：' + esc(f.name) + '</span>'; };
        fr.onload = function () {
          var info = E("upImInfo");
          try {
            var o = JSON.parse(String(fr.result));
            if (!o || (!Array.isArray(o.added) && !o.magic)) throw new Error("不是本 APP 的备份/改动文件");
            // 跨平台包拦截：水利包不能倒进古建（字段模型不同）
            if (o.app && o.app !== APP_ID) {
              info.innerHTML = '<span style="color:#ff6b6b">⛔ 通道/平台不匹配：这是「' + esc(o.appName || o.app)
                + '」的备份包，不能导入「' + esc(APP_NAME) + '」。请用对应 APP 还原。</span>';
              pkg = null; pickedName = f.name; syncGo(); return;
            }
            pkg = o; pickedName = f.name;
            var from = +o.schema || 1;
            var lines = [];
            lines.push('文件：<b>' + esc(f.name) + '</b>（' + sizeText(f.size) + '）');
            var ageTxt = backupAge(o.exportedAt);
            if (ageTxt) lines.push(ageTxt);
            lines.push('来源版本：<b>' + esc(o.appVer || "旧版（未标注）") + '</b> · 数据结构 schema <b>' + from + '</b> → 当前 <b>' + SCHEMA + '</b>');
            var recN = (o.added || []).length + Object.keys(o.updated || {}).length;
            var phN = 0;
            [].concat(o.added || [], Object.keys(o.updated || {}).map(function (k) { return o.updated[k]; }))
              .forEach(function (r) { phN += ((r && r.photos) || []).length; });
            lines.push('内容：记录 <b>' + recN + '</b> 条 · 照片 <b>' + phN + '</b> 张 · 打卡 <b>' + ((o.checkins || []).length)
              + '</b> · 游记备忘 <b>' + ((o.journals || []).length) + '</b> · 知识库 <b>' + ((o.kb || []).length) + '</b> 条');
            if (from > SCHEMA) {
              lines.push('<span style="color:#ffb454">⚠ 备份来自<b>更新的版本</b>（schema ' + from + ' > 本机 ' + SCHEMA
                + '）。将只还原本机能识别的部分，未知字段会原样保留但不生效；建议先把 APP 升级到新版再还原。</span>');
            } else if (from < SCHEMA) {
              lines.push('<span style="color:#7ddc7d">✓ 旧版备份，将自动迁移字段（补缩略图/补空字段），<b>照片与原始数据不会丢失</b>。</span>');
            } else {
              lines.push('<span style="color:#7ddc7d">✓ 版本结构一致，可直接还原。</span>');
            }
            if (o.channel && o.channel !== CHANNEL) {
              lines.push('<span style="color:#ffb454">⚠ 备份来自 ' + (o.channel === "internal" ? "内部版" : "公开版")
                + '，当前是 ' + CHANNEL_CN + '。数据可用，但组织名称口径可能不同。</span>');
            }
            info.innerHTML = lines.join("<br>");
            syncGo();
          } catch (e) {
            info.innerHTML = '<span style="color:#ff6b6b">解析失败：' + esc(e.message) + '</span>';
            pkg = null; pickedName = f.name; syncGo();
          }
        };
        fr.readAsText(f);
      });
    };

    E("upImGo").onclick = async function () {
      if (!pkg) { T("请先选择备份文件"); return; }
      if (!(E("upImConfirm") && E("upImConfirm").checked)) {
        T("请先勾选「我确认这是最新备份…」");   // 不勾选不允许还原，避免误覆盖
        return;
      }
      var warn = "即将把「" + baseName(pickedName) + "」还原到本机。\n\n"
        + (mode === "replace"
          ? "【覆盖】会丢弃本机现有的全部改动、照片、打卡、游记备忘与知识库，完全按备份还原。"
          : "【合并】保留本机现有数据，并补入备份里本机没有的内容；同 id 记录以备份为准。")
        + "\n\n请再次确认：这是最新一次导出的备份吗？此操作不可撤销。";
      if (!confirm(warn)) return;
      if (typeof global.busy === "function") global.busy(true, "正在还原升级数据，请稍后…");
      try {
        var mig = migratePkg(pkg);
        var withKB = !!(E("upImKB") && E("upImKB").checked);
        var withPrefs = !!(E("upImPrefs") && E("upImPrefs").checked);
        var rep = await applyPkg(pkg, mode, { withKB: withKB, withPrefs: withPrefs });
        global.closeModal();
        var msg = "已还原：记录 " + rep.records + " 条 · 照片 " + rep.photos + " 张";
        if (rep.checkins) msg += " · 打卡 " + rep.checkins;
        if (rep.journals) msg += " · 游记备忘 " + rep.journals;
        if (rep.kb) msg += " · 知识库 " + rep.kb;
        if (mig.migrated) msg += "（已从 schema " + mig.from + " 迁移 " + mig.migrated + " 条）";
        T(msg);
        setTimeout(function () {
          if (confirm(msg + "\n\n需要刷新页面让全部数据生效吗？")) location.reload();
        }, 300);
      } catch (e) {
        T("还原失败：" + e.message);   // fail-loud
      } finally {
        if (typeof global.busy === "function") global.busy(false);
      }
    };
  }

  // 真正写库
  async function applyPkg(pkg, mode, opts) {
    opts = opts || {};
    var rep = { records: 0, photos: 0, checkins: 0, journals: 0, kb: 0, prefs: 0 };

    // 1) delta
    var cur = { added: [], updated: {}, deleted: [] };
    try { cur = await global.Store.get(); } catch (e) {}
    var next;
    if (mode === "replace") {
      next = { added: (pkg.added || []).slice(), updated: Object.assign({}, pkg.updated || {}), deleted: (pkg.deleted || []).slice() };
    } else {
      var byId = {};
      (cur.added || []).forEach(function (r) { if (r && r.id) byId[r.id] = r; });
      (pkg.added || []).forEach(function (r) { if (r && r.id && !byId[r.id]) byId[r.id] = r; });
      next = {
        added: Object.keys(byId).map(function (k) { return byId[k]; }),
        updated: Object.assign({}, pkg.updated || {}, cur.updated || {}),   // 本机改动优先
        deleted: Array.from(new Set([].concat(cur.deleted || [], pkg.deleted || [])))
      };
    }
    await global.Store.set(next);
    rep.records = (next.added || []).length + Object.keys(next.updated || {}).length;
    [].concat(next.added || [], Object.keys(next.updated || {}).map(function (k) { return next.updated[k]; }))
      .forEach(function (r) { rep.photos += ((r && r.photos) || []).length; });

    // 2) 打卡
    if (global.Store.checkins && (pkg.checkins || []).length) {
      try {
        var curCk = (await global.Store.checkins.get()) || [];
        var ckMap = {};
        if (mode !== "replace") curCk.forEach(function (c) { if (c && c.id) ckMap[c.id] = c; });
        (pkg.checkins || []).forEach(function (c) { if (c && c.id && !ckMap[c.id]) ckMap[c.id] = c; });
        var ckArr = Object.keys(ckMap).map(function (k) { return ckMap[k]; });
        if (global.Store.checkins.clear) await global.Store.checkins.clear();
        for (var i = 0; i < ckArr.length; i++) await global.Store.checkins.add(ckArr[i]);
        rep.checkins = ckArr.length;
      } catch (e) { T("打卡记录还原失败：" + e.message); }
    }

    // 3) 游记 / 备忘录
    if (global.Journal && global.Journal.bulkPut && (pkg.journals || []).length) {
      try { rep.journals = await global.Journal.bulkPut(pkg.journals, mode === "replace"); }
      catch (e) { T("游记/备忘录还原失败：" + e.message); }
    }

    // 4) 知识库
    if (opts.withKB && global.KB && global.KB.put && (pkg.kb || []).length) {
      try {
        if (mode === "replace" && global.KB.clear) await global.KB.clear();
        for (var j = 0; j < pkg.kb.length; j++) { await global.KB.put(pkg.kb[j]); rep.kb++; }
        if (global.KB.buildIndex) await global.KB.buildIndex();
      } catch (e) { T("知识库还原失败：" + e.message); }
    }

    // 5) 偏好 / 组织配置
    if (opts.withPrefs && pkg.localStore) {
      try {
        Object.keys(pkg.localStore).forEach(function (k) {
          if (!isBackupKey(k)) return;
          localStorage.setItem(k, pkg.localStore[k]); rep.prefs++;
        });
      } catch (e) { T("偏好还原失败：" + e.message); }
    }
    return rep;
  }

  // ---------- 软件升级：检测网盘新版（v2.4.6：公开版 / 内部版双通道同权 + 自动检测）----------
  function manifestUrl() {
    try {
      var v = localStorage.getItem(LS_MANIFEST) || "";
      if (v && v.trim()) return v.trim();
    } catch (e) {}
    return (MANIFEST_DEFAULT && MANIFEST_DEFAULT[CHANNEL]) || "";
  }
  function manifestList() {
    var raw = manifestUrl();
    if (!raw) return [];
    return raw.split(/[\n,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function autoCheckOn() {
    try { return localStorage.getItem(LS_AUTOCHECK) !== "0"; } catch (e) { return true; }   // 默认开启
  }
  function setAutoCheck(on) { try { localStorage.setItem(LS_AUTOCHECK, on ? "1" : "0"); } catch (e) {} }
  function autoDlOn() {
    try { return localStorage.getItem(LS_AUTODL) !== "0"; } catch (e) { return true; }   // v2.4.7 默认开启
  }
  function setAutoDl(on) { try { localStorage.setItem(LS_AUTODL, on ? "1" : "0"); } catch (e) {} }
  function autoDlOn() {
    try { return localStorage.getItem(LS_AUTODL) !== "0"; } catch (e) { return true; }      // v2.4.7 默认开启
  }
  function setAutoDl(on) { try { localStorage.setItem(LS_AUTODL, on ? "1" : "0"); } catch (e) {} }
  function skippedVer() { try { return localStorage.getItem(LS_SKIPVER) || ""; } catch (e) { return ""; } }
  function setSkippedVer(v) { try { localStorage.setItem(LS_SKIPVER, v || ""); } catch (e) {} }

  // 百度网盘分享页不可直读（需登录 + 无跨域许可）→ 明确告知，不静默失败
  function isBaiduShare(u) { return /pan\.baidu\.com\/s\//i.test(u || ""); }
  function baiduHint() {
    return '<span style="color:#ffb454">\u26a0 \u767e\u5ea6\u7f51\u76d8\u5206\u4eab\u9875\u4e0d\u80fd\u76f4\u63a5\u8bfb\u53d6\uff08\u9700\u767b\u5f55\u4e14\u65e0\u8de8\u57df\u8bb8\u53ef\uff09\uff0c'
      + '\u6240\u4ee5<b>\u4e0d\u80fd\u5f53\u4f5c\u7248\u672c\u6e05\u5355\u5730\u5740</b>\u3002\u8bf7\u628a <code>latest.json</code> \u653e\u5728<b>\u53ef\u533f\u540d\u76f4\u8bfb</b>\u7684\u5730\u5740'
      + '\uff08\u7f51\u76d8\u76f4\u94fe / \u5bf9\u8c61\u5b58\u50a8 / \u4efb\u610f\u9759\u6001\u7ad9\u70b9\uff09\uff1b\u7f51\u76d8\u5206\u4eab\u9875\u586b\u5728\u6e05\u5355\u7684 <code>download</code> '
      + '\u5b57\u6bb5\u91cc\u4f5c\u4e3a\u4e0b\u8f7d\u5165\u53e3\uff08\u7a0b\u5e8f\u8d1f\u8d23\u68c0\u6d4b\u4e0e\u6253\u5f00\uff0c\u4e0b\u8f7d\u4ea4\u7ed9\u7cfb\u7edf\u6d4f\u89c8\u5668 / \u7f51\u76d8 App\uff09\u3002</span>';
  }

  // 逐个尝试候选地址，返回第一个成功解析的清单（多源容错：网盘直链 / 镜像 / 备用站点）
  async function fetchManifest(list, log) {
    var errs = [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!/^https?:\/\//i.test(u)) { errs.push(u + " \u2192 \u5730\u5740\u5fc5\u987b\u4ee5 http(s):// \u5f00\u5934"); continue; }
      if (isBaiduShare(u)) { errs.push(u + " \u2192 \u662f\u767e\u5ea6\u7f51\u76d8\u5206\u4eab\u9875\uff0c\u4e0d\u53ef\u76f4\u8bfb"); continue; }
      if (log) log("\u6b63\u5728\u68c0\u6d4b\u7b2c " + (i + 1) + "/" + list.length + " \u4e2a\u5730\u5740\u2026");
      try {
        var r = await fetch(u + (u.indexOf("?") >= 0 ? "&" : "?") + "_t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        var m = await r.json();
        return { manifest: m, from: u, errs: errs };
      } catch (e) {
        errs.push(u + " \u2192 " + (e && e.message ? e.message : e));
      }
    }
    return { manifest: null, from: "", errs: errs };
  }

  // 渲染「有新版本」结果（下载入口 + 提取码一键复制）
  function renderNewVersion(m, extraActions) {
    var notes = Array.isArray(m.notes) ? m.notes : (m.notes ? [m.notes] : []);
    var html = '<span style="color:#7ddc7d">\ud83c\udf89 \u53d1\u73b0\u65b0\u7248 <b>' + esc(m.version) + '</b>'
      + (m.date ? '\uff08' + esc(m.date) + '\uff09' : '') + '</span>'
      + (notes.length ? '<ul style="margin:6px 0 0 18px">' + notes.slice(0, 12).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join("") + '</ul>' : '')
      + '<div style="margin-top:8px"><b>\u5347\u7ea7\u524d\u52a1\u5fc5\u5148\u70b9\u300c\ud83d\udce4 \u5148\u5907\u4efd\u6570\u636e\u300d\u5bfc\u51fa\u5347\u7ea7\u6570\u636e\u5305\u3002</b></div>';
    if (m.download) {
      html += '<div style="margin-top:6px">\u4e0b\u8f7d\u5730\u5740\uff1a<a href="' + esc(m.download) + '" target="_blank">' + esc(m.download) + '</a></div>';
      if (m.extract) {
        html += '<div style="margin-top:4px">\u63d0\u53d6\u7801\uff1a<b style="font-size:15px;letter-spacing:2px">' + esc(m.extract) + '</b>'
          + ' <button class="btn ghost" id="upCopyCode" style="padding:2px 8px;font-size:12px">\u590d\u5236</button></div>';
      }
      html += '<div style="margin-top:6px"><button class="btn" id="upGoDownload">\u2b07\ufe0f '
        + (isBaiduShare(m.download) ? '\u6253\u5f00\u767e\u5ea6\u7f51\u76d8\u4e0b\u8f7d' : '\u4e0b\u8f7d\u5b89\u88c5\u5305') + '</button></div>';
    } else {
      html += '<div style="margin-top:6px;color:#ffb454">\u26a0 \u6e05\u5355\u672a\u63d0\u4f9b\u4e0b\u8f7d\u5730\u5740\uff0c\u8bf7\u70b9\u300c\u2601\ufe0f \u6253\u5f00\u7f51\u76d8\u624b\u52a8\u67e5\u770b\u300d\u3002</div>';
    }
    html += (extraActions || "");
    return html;
  }
  function wireVersionActions(m) {
    var dc = E("upCopyCode");
    if (dc) dc.onclick = function () {
      var code = String(m.extract || "");
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function () { T("\u63d0\u53d6\u7801\u5df2\u590d\u5236\uff1a" + code); });
        else throw new Error("no clipboard");
      } catch (e) { T("\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u8bb0\u4e0b\u63d0\u53d6\u7801\uff1a" + code); }
    };
    var dl = E("upGoDownload");
    if (dl) dl.onclick = function () { startDownload(m); };
  }

  // ---------- v2.4.7：自动下载安装包（网盘分享页→自动打开；直链→fetch→Blob→本地保存，带进度）----------
  function dlFileName(m) {
    var u = String(m.download || "");
    var base = "";
    try { base = decodeURIComponent(u.split("?")[0].split("/").pop() || ""); } catch (e) { base = u.split("/").pop() || ""; }
    if (m.filename) base = m.filename;
    if (!/\.(apk|exe|msi|zip|deb)$/i.test(base)) base = APP_NAME + "-" + m.version + ".apk";
    return base;
  }
  function startDownload(m) {
    var url = String(m.download || "");
    if (!url) { T("清单未提供下载地址"); return; }
    if (isBaiduShare(url)) {
      // 网盘分享页需登录+验证码，程序无法代取 → 自动打开页面交给用户（提取码可一键复制）
      try { global.open(url, "_blank"); } catch (e) {}
      T("已打开网盘页面，请在页内下载 " + m.version + " 安装包" + (m.extract ? "（提取码 " + m.extract + "）" : ""));
      return;
    }
    var fname = dlFileName(m);
    if (typeof global.busy === "function") global.busy(true, "正在下载 " + m.version + " 安装包…");
    fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (!r.body || !r.body.getReader) return r.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
      var total = +(r.headers.get("content-length") || 0), got = 0, reader = r.body.getReader(), chunks = [];
      function pump() {
        return reader.read().then(function (seg) {
          if (seg.done) {
            var all = new Uint8Array(got), off = 0;
            for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
            return all;
          }
          chunks.push(seg.value); got += seg.value.length;
          if (total && typeof global.busy === "function") global.busy(true, "正在下载 " + m.version + "…" + Math.round(got / total * 100) + "%");
          return pump();
        });
      }
      return pump();
    }).then(function (bytes) {
      if (typeof global.busy === "function") global.busy(false);
      if (global.IO && typeof global.IO.downloadBytes === "function") global.IO.downloadBytes(fname, bytes);
      T("已下载 " + fname + "（" + Math.round(bytes.length / 1048576 * 10) / 10 + " MB）——安卓在通知栏/下载目录，Win 在下载目录，打开即可安装");
    }).catch(function (e) {
      if (typeof global.busy === "function") global.busy(false);
      T("自动下载失败：" + (e && e.message ? e.message : e) + "，已改为打开下载页");
      try { global.open(url, "_blank"); } catch (e2) {}
    });
  }
  // 一键检查入口（设置菜单「检查新版本」按钮）
  function checkNow() {
    openUpgrade();
    setTimeout(function () { var c = E("upCheck"); if (c && typeof c.onclick === "function") c.onclick(); }, 60);
  }

  function openUpgrade() {
    var url = manifestUrl();
    var last = (function () { try { var t = +localStorage.getItem(LS_BACKUP_TS); return t ? new Date(t).toLocaleString() : "\u4ece\u672a\u5bfc\u51fa"; } catch (e) { return "\u672a\u77e5"; } })();
    var html = '<div class="hint">\u5f53\u524d\u7248\u672c <b>' + esc(appVer()) + '</b> \u00b7 \u53d1\u884c\u901a\u9053 <b>' + CHANNEL_CN
      + '</b>\uff08' + CHANNEL + '\uff09\u3002\u68c0\u6d4b\u53ea\u8bfb\u53d6<b>\u672c\u901a\u9053</b>\u7684\u6e05\u5355\uff1a' + CHANNEL_CN
      + '\u4e0d\u4f1a\u8bfb\u5230\u53e6\u4e00\u901a\u9053\u7684\u5305\uff0c\u4e24\u6761\u7ebf\u4e92\u4e0d\u4ea4\u53c9\u3002'
      + '<br><b>\u516c\u5f00\u7248\u4e0e\u5185\u90e8\u7248\u5747\u53ef\u8d70\u767e\u5ea6\u7f51\u76d8\u5347\u7ea7</b>\uff1a\u628a <code>latest.json</code> '
      + '\u653e\u5728\u53ef\u533f\u540d\u76f4\u8bfb\u7684\u5730\u5740\uff0c\u6e05\u5355\u91cc\u7684 <code>download</code> '
      + '\u586b\u767e\u5ea6\u7f51\u76d8\u5206\u4eab\u94fe\u63a5\u5373\u53ef\u3002</div>'
      + '<div class="hint" style="margin-top:6px">\u5347\u7ea7\u524d\u8bf7\u5148\u5907\u4efd\uff1a\u4e0a\u6b21\u5bfc\u51fa\u5347\u7ea7\u6570\u636e\u65f6\u95f4 <b>' + esc(last) + '</b>\u3002</div>'
      + '<div class="field"><label>' + CHANNEL_CN + '\u7248\u672c\u6e05\u5355\u5730\u5740\uff08latest.json \u76f4\u8bfb\u5730\u5740\uff1b\u652f\u6301\u591a\u4e2a\uff0c\u4e00\u884c\u4e00\u4e2a\uff0c\u9010\u4e2a\u5c1d\u8bd5\uff09</label>'
      + '<textarea id="upManifest" class="inp" rows="3" placeholder="https://\u2026/' + CHANNEL + '/latest.json">' + esc(url) + '</textarea></div>'
      + '<div class="field"><label class="chip" style="cursor:pointer"><input type="checkbox" id="upAutoChk"'
      + (autoCheckOn() ? " checked" : "") + ' style="vertical-align:-2px"> \u6bcf\u6b21\u542f\u52a8\u81ea\u52a8\u68c0\u6d4b\u65b0\u7248</label></div>'
      + '<div class="field"><label class="chip" style="cursor:pointer"><input type="checkbox" id="upAutoDl"'
      + (autoDlOn() ? " checked" : "") + ' style="vertical-align:-2px"> \u53d1\u73b0\u65b0\u7248\u81ea\u52a8\u4e0b\u8f7d\u5b89\u88c5\u5305</label></div>'
      + '<div class="hint">' + baiduHint() + '</div>'
      + '<div class="hint" id="upChkOut" style="margin-top:10px;padding:9px 12px;border:1px dashed var(--accent);border-radius:10px">\u5c1a\u672a\u68c0\u6d4b</div>';
    global.openModal("\u8f6f\u4ef6\u5347\u7ea7\uff08" + CHANNEL_CN + "\uff09", html,
      '<button class="btn ghost" onclick="APP.close()">\u5173\u95ed</button>'
      + '<button class="btn ghost" id="upBackupFirst">\ud83d\udce4 \u5148\u5907\u4efd\u6570\u636e</button>'
      + '<button class="btn ghost" id="upOpenPan">\u2601\ufe0f \u6253\u5f00\u7f51\u76d8\u624b\u52a8\u67e5\u770b</button>'
      + '<button class="btn primary" id="upCheck">\ud83d\udd0d \u68c0\u6d4b\u65b0\u7248</button>');

    E("upBackupFirst").onclick = function () { global.closeModal(); openExport(); };
    var ac = E("upAutoChk");
    if (ac) ac.onchange = function () { setAutoCheck(ac.checked); T(ac.checked ? "\u5df2\u5f00\u542f\uff1a\u6bcf\u6b21\u542f\u52a8\u81ea\u52a8\u68c0\u6d4b\u65b0\u7248" : "\u5df2\u5173\u95ed\u81ea\u52a8\u68c0\u6d4b"); };
    var ad = E("upAutoDl");
    if (ad) ad.onchange = function () { setAutoDl(ad.checked); T(ad.checked ? "\u5df2\u5f00\u542f\uff1a\u53d1\u73b0\u65b0\u7248\u81ea\u52a8\u4e0b\u8f7d\u5b89\u88c5\u5305" : "\u5df2\u5173\u95ed\u81ea\u52a8\u4e0b\u8f7d"); };
    E("upOpenPan").onclick = function () {
      var home = (PAN_HOME && PAN_HOME[CHANNEL]) || "https://pan.baidu.com/";
      var u = (E("upManifest").value || "").split(/[\n,;]+/)[0].trim();
      var open = (u && /^https?:/.test(u)) ? u.replace(/latest\.json\??.*$/, "") : home;
      try { global.open(open, "_blank"); } catch (e) {}
      T("\u5df2\u5c1d\u8bd5\u6253\u5f00" + CHANNEL_CN + "\u76ee\u5f55\uff0c\u8bf7\u4eba\u5de5\u6838\u5bf9\u6700\u65b0\u7248\u672c\u53f7");
    };
    E("upCheck").onclick = async function () {
      var out = E("upChkOut");
      var raw = (E("upManifest").value || "").trim();
      try { localStorage.setItem(LS_MANIFEST, raw); } catch (e) {}
      var list = manifestList();
      if (!list.length) {
        out.innerHTML = '<span style="color:#ffb454">\u26a0 \u672a\u914d\u7f6e\u7248\u672c\u6e05\u5355\u5730\u5740\uff0c\u65e0\u6cd5\u81ea\u52a8\u68c0\u6d4b\u3002'
          + '<br>\u964d\u7ea7\u65b9\u6848\uff1a\u70b9\u300c\u2601\ufe0f \u6253\u5f00\u7f51\u76d8\u624b\u52a8\u67e5\u770b\u300d\u4eba\u5de5\u6838\u5bf9 '
          + CHANNEL_CN + ' \u76ee\u5f55\u4e0b\u7684\u6700\u65b0\u7248\u672c\u53f7\uff0c\u518d\u624b\u52a8\u4e0b\u8f7d\u5b89\u88c5\u3002</span>';
        return;
      }
      out.innerHTML = "\u6b63\u5728\u68c0\u6d4b\u2026";
      var res = await fetchManifest(list, function (t) { out.innerHTML = esc(t); });
      if (!res.manifest) {
        out.innerHTML = '<span style="color:#ff6b6b">\u26d4 \u68c0\u6d4b\u5931\u8d25\uff08\u5df2\u5c1d\u8bd5 ' + list.length + ' \u4e2a\u5730\u5740\uff09\uff1a<br>'
          + res.errs.map(esc).join("<br>")
          + '<br>\u5e38\u89c1\u539f\u56e0\uff1a\u5730\u5740\u9700\u767b\u5f55 / \u8de8\u57df\u88ab\u62e6 / \u65e0\u7f51\u7edc\u3002'
          + '<br>\u964d\u7ea7\u65b9\u6848\uff1a\u70b9\u300c\u2601\ufe0f \u6253\u5f00\u7f51\u76d8\u624b\u52a8\u67e5\u770b\u300d\u4eba\u5de5\u6838\u5bf9\u7248\u672c\u53f7\u3002</span>';
        return;
      }
      var m = res.manifest;
      if (String(m.channel || "") !== CHANNEL) {
        out.innerHTML = '<span style="color:#ff6b6b">\u26d4 \u901a\u9053\u4e0d\u5339\u914d\uff1a\u6e05\u5355\u6807\u8bb0\u4e3a\u300c'
          + esc(m.channel === "internal" ? "\u5185\u90e8\u7248" : (m.channel || "\u672a\u6807\u6ce8")) + '\u300d\uff0c\u672c\u673a\u662f\u300c' + CHANNEL_CN
          + '\u300d\u3002\u5df2\u62d2\u7edd\u8de8\u901a\u9053\u5347\u7ea7\uff0c\u8bf7\u586b\u5199' + CHANNEL_CN + '\u4e13\u7528\u7684\u6e05\u5355\u5730\u5740\u3002</span>';
        return;
      }
      if (m.app && m.app !== APP_ID) {
        out.innerHTML = '<span style="color:#ff6b6b">\u26d4 \u6e05\u5355\u4e0d\u5c5e\u4e8e\u672c APP\uff08' + esc(m.app) + ' \u2260 ' + APP_ID + '\uff09</span>';
        return;
      }
      if (verCmp(m.version, appVer()) <= 0) {
        out.innerHTML = '<span style="color:#7ddc7d">\u2713 \u5f53\u524d\u5df2\u662f\u6700\u65b0\u7248 <b>' + esc(appVer()) + '</b>\uff08' + CHANNEL_CN
          + '\u901a\u9053\u6700\u65b0\u4e3a ' + esc(m.version || "\u672a\u6807\u6ce8") + '\uff09\uff0c\u65e0\u9700\u5347\u7ea7\u3002</span>';
        return;
      }
      setSkippedVer("");    // \u51fa\u73b0\u66f4\u65b0\u7684\u7248\u672c \u2192 \u6e05\u6389\u4e4b\u524d\u7684\u300c\u8df3\u8fc7\u300d
      out.innerHTML = renderNewVersion(m);
      wireVersionActions(m);
    };
  }

  // ---------- \u81ea\u52a8\u68c0\u6d4b\uff08\u542f\u52a8\u9759\u9ed8\u8dd1\u4e00\u6b21\uff1b\u53d1\u73b0\u65b0\u7248\u624d\u5f39\u7a97\u6253\u6270\uff09----------
  var _autoChecked = false;
  async function autoCheckUpgrade(force) {
    if (_autoChecked && !force) return;
    _autoChecked = true;
    if (!force && !autoCheckOn()) return;
    var list = manifestList();
    if (!list.length) return;                       // \u672a\u914d\u7f6e \u2192 \u9759\u9ed8\u8df3\u8fc7\uff0c\u4e0d\u6253\u6270
    var res = await fetchManifest(list, null);
    var m = res.manifest;
    if (!m || !m.version) return;                   // \u7f51\u7edc\u4e0d\u53ef\u8fbe \u2192 \u9759\u9ed8\uff0c\u4e0b\u6b21\u518d\u8bd5
    if (String(m.channel || "") !== CHANNEL) return;
    if (m.app && m.app !== APP_ID) return;
    if (verCmp(m.version, appVer()) <= 0) return;
    if (skippedVer() && skippedVer() === String(m.version)) return;
    if (typeof global.openModal !== "function") return;
    var html = '<div class="hint">\u68c0\u6d4b\u5230<b>' + CHANNEL_CN + '</b>\u65b0\u7248 <b>' + esc(m.version) + '</b>\uff08\u5f53\u524d ' + esc(appVer()) + '\uff09\u3002</div>'
      + '<div style="margin-top:8px">' + renderNewVersion(m) + '</div>';
    global.openModal("\u53d1\u73b0\u65b0\u7248\u672c\uff08" + CHANNEL_CN + "\uff09", html,
      '<button class="btn ghost" id="upAutoSkip">\u8df3\u8fc7\u6b64\u7248\u672c</button>'
      + '<button class="btn ghost" id="upAutoBak">\ud83d\udce4 \u5148\u5907\u4efd\u6570\u636e</button>'
      + '<button class="btn primary" onclick="APP.close()">\u77e5\u9053\u4e86</button>');
    var sk = E("upAutoSkip");
    if (sk) sk.onclick = function () { setSkippedVer(String(m.version)); global.closeModal(); T("\u5df2\u8df3\u8fc7 " + m.version + "\uff0c\u4e0b\u6b21\u4e0d\u518d\u63d0\u793a"); };
    var bk = E("upAutoBak");
    if (bk) bk.onclick = function () { global.closeModal(); openExport(); };
    wireVersionActions(m);
    if (autoDlOn()) startDownload(m);   // v2.4.7：发现新版自动下载
  }

  // ---------- 启动兼容检查 ----------
  async function bootCheck() {
    var lastVer, lastSchema;
    try {
      lastVer = localStorage.getItem(LS_LAST_VER) || "";
      lastSchema = parseInt(localStorage.getItem(LS_LAST_SCHEMA), 10) || 0;
    } catch (e) { return; }

    var cur = appVer();
    // 首次安装：只记录，不打扰
    if (!lastVer) {
      try { localStorage.setItem(LS_LAST_VER, cur); localStorage.setItem(LS_LAST_SCHEMA, String(SCHEMA)); } catch (e) {}
      return;
    }
    var verChanged = verCmp(cur, lastVer) !== 0;
    var schemaChanged = lastSchema && lastSchema < SCHEMA;
    if (!verChanged && !schemaChanged) return;

    // 结构升级 → 原地迁移本机数据（不覆盖原图，只补字段）
    var migrated = 0;
    if (schemaChanged) {
      try {
        await global.Store.patch(function (d) {
          (d.added || []).forEach(function (r) { migrateRecord(r, lastSchema); migrated++; });
          Object.keys(d.updated || {}).forEach(function (k) { migrateRecord(d.updated[k], lastSchema); migrated++; });
        });
      } catch (e) { T("数据迁移失败：" + e.message); }
    }

    try { localStorage.setItem(LS_LAST_VER, cur); localStorage.setItem(LS_LAST_SCHEMA, String(SCHEMA)); } catch (e) {}

    // 兼容性结论 + 升级提醒（一键导出 = 升级数据导出）
    var compat = lastSchema > SCHEMA
      ? { color: "#ffb454", txt: "本机数据结构（schema " + lastSchema + "）比当前 APP（" + SCHEMA + "）更新，可能是装了更旧的包。数据仍会保留，但新字段不生效，建议装回新版。" }
      : { color: "#7ddc7d", txt: "已确认与旧版数据<b>完全兼容</b>：原有记录、照片、打卡、知识库均保留" + (migrated ? "，并已自动迁移 " + migrated + " 条记录的字段" : "") + "。" };

    if (typeof global.openModal !== "function") return;
    var html = '<div class="hint">检测到版本变化：<b>' + esc(lastVer) + '</b> → <b>' + esc(cur) + '</b>'
      + (schemaChanged ? '（数据结构 schema ' + lastSchema + ' → ' + SCHEMA + '）' : '') + '</div>'
      + '<div class="hint" style="margin-top:8px;color:' + compat.color + '">' + compat.txt + '</div>'
      + '<div class="hint" style="margin-top:8px">强烈建议<b>现在导出一份升级数据包</b>存到网盘/电脑：万一后续需要回退旧版，'
      + '这个包可以被旧版「导入我的改动 / 升级数据导入」直接读回，照片一并还原。</div>';
    global.openModal("版本升级提醒", html,
      '<button class="btn ghost" onclick="APP.close()">稍后再说</button><button class="btn primary" id="upBootExport">📤 立即导出备份</button>');
    var b = E("upBootExport");
    if (b) b.onclick = function () { global.closeModal(); openExport(); };
  }

  // ---------- 对外接口 + 菜单自注册 ----------
  var Upgrade = {
    SCHEMA: SCHEMA, CHANNEL: CHANNEL, APP_ID: APP_ID,
    openUpgrade: openUpgrade, openExport: openExport, openImport: openImport,
    collect: collect, applyPkg: applyPkg, bootCheck: bootCheck, verCmp: verCmp,
    // v2.4.6：网盘自动升级（公开/内部双通道同权）
    autoCheckUpgrade: autoCheckUpgrade, manifestList: manifestList, fetchManifest: fetchManifest,
    defaultBackupName: defaultBackupName, defaultBackupDir: defaultBackupDir, BACKUP_EXT: BACKUP_EXT,
    joinPath: joinPath, baseName: baseName, backupAge: backupAge,
    // v2.4.7：一键检查 + 自动下载
    checkNow: checkNow, startDownload: startDownload, autoDlOn: autoDlOn
  };
  global.Upgrade = Upgrade;

  // 菜单动作自注册（app.js 的 acts 未命中时会回落到 __EXT_ACTS__）
  global.__EXT_ACTS__ = global.__EXT_ACTS__ || {};
  global.__EXT_ACTS__.swUpgrade = openUpgrade;
  global.__EXT_ACTS__.upExport = openExport;
  global.__EXT_ACTS__.upImport = openImport;
  global.__EXT_ACTS__.swCheckUpdate = checkNow;   // v2.4.7：设置菜单「检查新版本」一键检测

  // 启动检查：等 app.js 数据加载完（load() 内 render 后）再弹，避免抢在地图初始化前
  // v2.4.6：启动后先静默跑一次网盘新版检测（公开版/内部版同权），有新版才弹窗；失败一律静默不打扰
  if (global.document) {
    var fire = function () {
      setTimeout(function () {
        bootCheck().catch(function (e) { console.warn("[upgrade] bootCheck", e); });
        setTimeout(function () {
          autoCheckUpgrade(false).catch(function (e) { console.warn("[upgrade] autoCheck", e); });
        }, 1500);
      }, 3000);
    };
    if (document.readyState === "complete" || document.readyState === "interactive") fire();
    else document.addEventListener("DOMContentLoaded", fire);
  }
})(window);
