/*
 * character/packStore.js — 形象包的 IndexedDB 存储
 *
 * file:// 下浏览器不能写 videos/ 目录，导入的形象包存在 IndexedDB：
 *   DB desktop_pet_packs v1 / store packs（keyPath 'id'）
 * Blob 按结构化克隆直存，不需要 base64。
 */
(function () {
  'use strict';
  var App = window.App;

  var DB_NAME = 'desktop_pet_packs';
  var DB_VERSION = 1;
  var STORE = 'packs';
  var _dbPromise = null;

  function _open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        _dbPromise = null;
        reject(e);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () {
          try { db.close(); } catch (e) { /* 忽略 */ }
          _dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = function () {
        _dbPromise = null;
        reject(req.error || new Error('打开形象库失败'));
      };
    });
    return _dbPromise;
  }

  // makeRequest(store) -> IDBRequest；事务完成时以 request.result 解析
  function _run(mode, makeRequest) {
    return _open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, req;
        try {
          tx = db.transaction(STORE, mode);
          req = makeRequest(tx.objectStore(STORE));
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = function () { resolve(req.result); };
        tx.onerror = function () { reject(tx.error || new Error('形象库操作失败')); };
        tx.onabort = function () { reject(tx.error || new Error('形象库操作已中止')); };
      });
    });
  }

  function getAll() {
    return _run('readonly', function (store) { return store.getAll(); }).then(function (list) {
      list = list || [];
      list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      return list;
    });
  }

  function get(id) {
    return _run('readonly', function (store) { return store.get(id); }).then(function (pack) {
      return pack == null ? null : pack;
    });
  }

  function put(pack) {
    return _run('readwrite', function (store) { return store.put(pack); }).then(function () {
      return pack;
    });
  }

  function remove(id) {
    // 注意：IDBObjectStore 的删除方法叫 delete()，不是 remove()
    return _run('readwrite', function (store) { return store.delete(id); }).then(function () {
      return true;
    });
  }

  function totalBytes(pack) {
    if (!pack || !pack.files) return 0;
    var total = 0;
    for (var state in pack.files) {
      if (Object.prototype.hasOwnProperty.call(pack.files, state)) {
        total += pack.files[state].size || 0;
      }
    }
    return total;
  }

  App.PackStore = {
    getAll: getAll,
    get: get,
    put: put,
    remove: remove,
    totalBytes: totalBytes
  };
})();
