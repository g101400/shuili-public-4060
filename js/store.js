/* store.js —— 用户改动的本地持久化（IndexedDB）
 * 只存「增量 delta」，基础数据(data.json)保持只读，便于重置。
 * delta = { added:[记录...], updated:{id:记录}, deleted:[id...] }
 */
(function (global) {
  const DB = "shuili_app";
  const STORE = "kv";
  const KEY = "delta";
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => { _db = req.result; res(_db); };
      req.onerror = () => rej(req.error);
    });
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function get() {
    return tx("readonly").then((os) => new Promise((res, rej) => {
      const r = os.get(KEY);
      r.onsuccess = () => res(r.result || { added: [], updated: {}, deleted: [] });
      r.onerror = () => rej(r.error);
    }));
  }

  function set(delta) {
    return tx("readwrite").then((os) => new Promise((res, rej) => {
      const r = os.put(delta, KEY);
      r.onsuccess = () => res(delta);
      r.onerror = () => rej(r.error);
    }));
  }

  async function patch(fn) {
    const d = await get();
    fn(d);
    // 清理
    d.added = d.added || [];
    d.updated = d.updated || {};
    d.deleted = d.deleted || [];
    return set(d);
  }

  const Store = {
    get, set, patch,
    async clear() { return set({ added: [], updated: {}, deleted: [] }); },
    async exportJSON() { return JSON.stringify(await get(), null, 0); },
    async importJSON(text) {
      const d = JSON.parse(text);
      if (!d || !Array.isArray(d.added)) throw new Error("格式不正确");
      return set({ added: d.added || [], updated: d.updated || {}, deleted: d.deleted || [] });
    }
  };

  // ---------- UI 偏好（轻量，存 localStorage；失败则静默降级）----------
  const UI_KEY = "ui_state";
  const ui = {
    get() { try { return JSON.parse(localStorage.getItem(UI_KEY)); } catch (e) { return null; } },
    set(s) { try { localStorage.setItem(UI_KEY, JSON.stringify(s)); } catch (e) {} },
    clear() { try { localStorage.removeItem(UI_KEY); } catch (e) {} }
  };

  global.Store = Store;
  Store.ui = ui;

  // ---------- 运行维护 / 旅游打卡 / 智能分析 业务数据（轻量，localStorage）----------
  const OPS_KEY = "ops_state";
  const ops = {
    get() { try { return JSON.parse(localStorage.getItem(OPS_KEY)) || {}; } catch (e) { return {}; } },
    set(s) { try { localStorage.setItem(OPS_KEY, JSON.stringify(s)); } catch (e) {} },
    clear() { try { localStorage.removeItem(OPS_KEY); } catch (e) {} }
  };
  Store.ops = ops;
})(window);
