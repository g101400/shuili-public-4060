/* idb_shim.js —— file:// 环境的 IndexedDB 兜底实现（localStorage 后端）2026-09-16
 *
 * 为什么需要：统信 UOS（无 python3）等机器上，启动器会退回 file:// 打开；
 * Chromium 系浏览器把 file:// 视为不透明源，indexedDB.open() 调用后
 * onsuccess / onerror 永不触发（实测挂起）→ store.js / kb.js / journal.js
 * 的首个 await 即卡死 → 建筑物、收藏、知识库全部不渲染。
 *
 * 本文件仅在 location.protocol === "file:" 时接管，用 localStorage 模拟本项目
 * 实际用到的 IndexedDB 子集：open / createObjectStore({keyPath}) / transaction /
 * objectStore / get / put / add / getAll / delete / clear / count。
 * http(s) 环境完全不安装，原生 IndexedDB 不受任何影响。
 */
(function (global) {
  if (!global || !global.localStorage) return;
  if (location.protocol !== "file:") return;   // 只在 file:// 下接管
  var P = "__idb__:";

  function read(db, store) {
    try { return JSON.parse(localStorage.getItem(P + db + "/" + store) || "null") || { keyPath: null, rows: {} }; }
    catch (e) { return { keyPath: null, rows: {} }; }
  }
  function write(db, store, meta) {
    try { localStorage.setItem(P + db + "/" + store, JSON.stringify(meta)); } catch (e) { /* 配额满：静默（与原生一致不抛） */ }
  }

  function makeReq(exec) {
    var req = { readyState: "pending" };
    setTimeout(function () {
      try {
        req.result = exec(); req.readyState = "done";
        if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
      } catch (e) {
        req.error = e; req.readyState = "done";
        if (typeof req.onerror === "function") req.onerror({ target: req });
      }
    }, 0);
    return req;
  }

  function fakeObjectStore(db, name) {
    var meta = read(db, name);
    var keyOf = meta.keyPath ? function (v) { return (v && v[meta.keyPath] !== undefined) ? String(v[meta.keyPath]) : null; } : null;
    return {
      get: function (k) { return makeReq(function () { return meta.rows[String(k)]; }); },
      put: function (v, k) {
        return makeReq(function () {
          var key = keyOf ? keyOf(v) : String(k);
          if (key === null || key === "undefined") throw new Error("DataError: 无法确定记录主键");
          meta.rows[key] = v; write(db, name, meta); return key;
        });
      },
      add: function (v, k) {
        return makeReq(function () {
          var key = keyOf ? keyOf(v) : String(k);
          if (meta.rows[key] !== undefined) throw new Error("ConstraintError: 主键已存在");
          meta.rows[key] = v; write(db, name, meta); return key;
        });
      },
      getAll: function () { return makeReq(function () { return Object.keys(meta.rows).map(function (k) { return meta.rows[k]; }); }); },
      delete: function (k) { return makeReq(function () { delete meta.rows[String(k)]; write(db, name, meta); }); },
      clear: function () { return makeReq(function () { meta.rows = {}; write(db, name, meta); }); },
      count: function () { return makeReq(function () { return Object.keys(meta.rows).length; }) },
      createIndex: function () { return { openCursor: function () { var r = {}; setTimeout(function () { if (typeof r.onsuccess === "function") r.onsuccess({ target: r }); }, 0); return r; } }; }
    };
  }

  function listStores(dbName) {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(P + dbName + "/") === 0) out.push(k.slice((P + dbName + "/").length));
      }
    } catch (e) {}
    return out;
  }

  global.indexedDB = {
    open: function (dbName, version) {
      var req = { readyState: "pending" };
      setTimeout(function () {
        try {
          var stores = listStores(dbName);
          var dbObj = {
            name: dbName, version: version || 1,
            objectStoreNames: { contains: function (s) { return stores.indexOf(s) >= 0; } },
            createObjectStore: function (name, opts) {
              if (stores.indexOf(name) >= 0) throw new Error("ConstraintError: store 已存在");
              write(dbName, name, { keyPath: (opts && opts.keyPath) || null, rows: {} });
              stores.push(name);
              return { createIndex: function () {} };
            },
            deleteObjectStore: function (name) { localStorage.removeItem(P + dbName + "/" + name); },
            close: function () {},
            transaction: function (name /*, mode */) {
              var names = Array.isArray(name) ? name : [name];
              var osMap = {};
              names.forEach(function (n) { osMap[n] = fakeObjectStore(dbName, n); });
              return {
                objectStore: function (n) { if (!osMap[n]) throw new Error("NotFoundError: " + n); return osMap[n]; },
                oncomplete: null, onerror: null
              };
            }
          };
          req.result = dbObj; req.readyState = "done";
          if (!stores.length && typeof req.onupgradeneeded === "function") req.onupgradeneeded({ target: req });
          if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
        } catch (e) {
          req.error = e; req.readyState = "done";
          if (typeof req.onerror === "function") req.onerror({ target: req });
        }
      }, 0);
      return req;
    },
    deleteDatabase: function (dbName) {
      return makeReq(function () {
        listStores(dbName).forEach(function (s) { localStorage.removeItem(P + dbName + "/" + s); });
      });
    },
    cmp: function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  };
})(window);
