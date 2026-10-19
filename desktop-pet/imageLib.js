/*
 * imageLib.js — 背景/壁纸图片库：把 data/backgrounds、data/wallpapers 当成真正的图片库
 *
 * 为什么需要单独一层：
 *   双击打开 index.html 时页面是 file://，浏览器既不能枚举目录，也不能静默写盘。
 *   所以图片库有三种后端，对上层暴露同一套 API：
 *     server  HTTP 模式：由 tools/serve-desktop-pet.js 提供 api/images 的列目录/写文件接口
 *     fsa     双击模式：用户点一次「授权 data 目录」，之后用 File System Access API 读写
 *     none    两者都不可用：保持旧行为（预设白名单 + 导入图存 data URL）
 *
 * 约定：
 *   - 设置里存的是**原始相对路径**（data/backgrounds/中文名.jpg），只在写 CSS/HTTP 时编码，
 *     避免中文、空格、# 等字符把 url() 截断。
 *   - 背景与壁纸严格分目录：isImagePath(path, folder) 会拒绝跨目录的路径。
 *   - 模块加载时不碰 DOM、不探测环境；init() 才是唯一入口。App.Output/Bubble 可能在
 *     本文件加载时还不存在，所有提示都由调用方负责。
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};

  var FOLDERS = {
    backgrounds: 'data/backgrounds',
    wallpapers: 'data/wallpapers'
  };
  var FOLDER_KEYS = ['backgrounds', 'wallpapers'];
  var IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;
  var FORBIDDEN_TEST_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
  var FORBIDDEN_GLOBAL_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
  var RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  var MAX_NAME_LEN = 120;                        // 文件名总长上限（含扩展名）
  var MAX_BASE_LEN = 60;                         // 原文件名保留部分的上限
  var API_IMAGES = 'api/images';
  var API_MARKER = 'desktop-pet-images';
  var PROBE_TIMEOUT_MS = 1200;

  var DB_NAME = 'desktop_pet_images';
  var DB_VERSION = 1;
  var STORE = 'handles';
  var HANDLE_KEY = 'dataDir';

  var lib = {
    mode: 'detecting',       // detecting | server | fsa | none
    state: 'init',           // init | ready | needs-authorize | needs-permission | denied | error | unsupported
    lastError: null,
    handle: null
  };

  var cache = { backgrounds: [], wallpapers: [] };
  var _initPromise = null;
  var _refreshPromise = null;
  var _dbPromise = null;

  /* ---------------- 小工具 ---------------- */

  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function isHttp() {
    var loc = window.location;
    return !!loc && (loc.protocol === 'http:' || loc.protocol === 'https:');
  }

  function isFileProtocol() {
    var loc = window.location;
    return !!loc && loc.protocol === 'file:';
  }

  function hasFsa() {
    return typeof window.showDirectoryPicker === 'function';
  }

  function errName(e) { return e && e.name ? e.name : ''; }

  function errText(e) {
    if (!e) return '未知错误';
    return e.message || errName(e) || String(e);
  }

  function emitChanged() {
    if (App.bus && App.bus.emit) {
      App.bus.emit('imagelib:changed', getStatus());
    }
  }

  /* ---------------- 文件名 / 路径规则 ---------------- */

  function isImageName(name) {
    if (typeof name !== 'string' || !name || name.length > MAX_NAME_LEN) return false;
    if (name.charAt(0) === '.') return false;
    if (name === '.' || name === '..') return false;
    if (FORBIDDEN_TEST_RE.test(name)) return false;
    if (/[. ]$/.test(name)) return false;          // Windows 不允许尾点/尾空格
    if (!IMAGE_EXT_RE.test(name)) return false;

    // 防编码穿越：%2e%2e%2f 这类名字解码后若出现分隔符/点开头就拒绝。
    // 普通文件名里的裸 %（如 100%.jpg）解码会抛错，这种情况放行。
    try {
      var decoded = decodeURIComponent(name);
      if (decoded !== name &&
          (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0 ||
           decoded.charAt(0) === '.' || /[\u0000-\u001f]/.test(decoded))) {
        return false;
      }
    } catch (e) { /* 裸百分号，按普通字符处理 */ }

    return true;
  }

  function folderOf(path) {
    var m = /^data\/(backgrounds|wallpapers)\//.exec(String(path || ''));
    return m ? m[1] : null;
  }

  function isImagePath(path, folder) {
    if (typeof path !== 'string') return false;
    var m = /^data\/(backgrounds|wallpapers)\/([^\\/]+)$/.exec(path);
    if (!m) return false;
    if (folder && m[1] !== folder) return false;
    return isImageName(m[2]);
  }

  function encodePath(path) {
    return String(path).split('/').map(function (seg) {
      try { return encodeURIComponent(seg); } catch (e) { return seg; }
    }).join('/');
  }

  function pathFor(folder, name) {
    return FOLDERS[folder] + '/' + name;
  }

  function labelOf(name) {
    return String(name).replace(/\.[^.]+$/, '');
  }

  function filenameFor(originalName, now) {
    var base = String(originalName || 'image').replace(/\.[^.\\/]*$/, '');
    base = base.replace(FORBIDDEN_GLOBAL_RE, '-').replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (!base) base = 'image';
    if (base.length > MAX_BASE_LEN) base = base.slice(0, MAX_BASE_LEN);
    if (RESERVED_RE.test(base)) base = '_' + base;

    var d = (now instanceof Date) ? now : new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    return base + '-' + stamp + '.jpg';
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    var comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    var head = dataUrl.slice(0, comma);
    var m = /^data:([^;]+);base64$/i.exec(head);
    if (!m) return null;
    if (typeof atob !== 'function' || typeof Blob === 'undefined') return null;

    var bin;
    try { bin = atob(dataUrl.slice(comma + 1)); } catch (e) { return null; }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    try {
      return new Blob([bytes], { type: m[1] });
    } catch (e2) {
      return null;
    }
  }

  /* ---------------- IndexedDB：只存目录句柄 ---------------- */

  function idbOpen() {
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
        reject(req.error || new Error('打开图片库失败'));
      };
    });
    return _dbPromise;
  }

  function idbRun(mode, makeRequest) {
    return idbOpen().then(function (db) {
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
        tx.onerror = function () { reject(tx.error || new Error('图片库操作失败')); };
        tx.onabort = function () { reject(tx.error || new Error('图片库操作已中止')); };
      });
    });
  }

  function idbGet(key) {
    return idbRun('readonly', function (store) { return store.get(key); });
  }

  function idbPut(record) {
    return idbRun('readwrite', function (store) { return store.put(record); });
  }

  /* ---------------- 服务器后端 ---------------- */

  function fetchJson(url, init, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('当前环境不支持 fetch'));

    var opts = {};
    if (init) {
      for (var k in init) {
        if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k];
      }
    }
    opts.cache = 'no-store';

    var controller = null;
    var timer = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(function () {
        try { controller.abort(); } catch (e) { /* 忽略 */ }
      }, timeoutMs || PROBE_TIMEOUT_MS);
    }

    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      }, function () {
        return { ok: res.ok, status: res.status, body: null };
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  function probeServer() {
    return fetchJson(API_IMAGES, null, PROBE_TIMEOUT_MS).then(function (r) {
      var b = r.body;
      return !!(r.ok && b && b.ok === true && b.api === API_MARKER && b.images);
    }, function () {
      return false;
    });
  }

  function serverList() {
    return fetchJson(API_IMAGES, null, 5000).then(function (r) {
      var b = r.body;
      if (!r.ok || !b || b.ok !== true || b.api !== API_MARKER || !b.images) {
        throw new Error('图片服务返回了无法识别的数据');
      }
      var out = { backgrounds: [], wallpapers: [] };
      FOLDER_KEYS.forEach(function (folder) {
        var list = Array.isArray(b.images[folder]) ? b.images[folder] : [];
        list.forEach(function (item) {
          var name = item && item.name;
          // 不信任服务器给的 path；name 重新校验后由客户端拼路径
          if (isImageName(name)) out[folder].push(makeItem(folder, name));
        });
      });
      return out;
    });
  }

  function serverSave(folder, blob, nameHint) {
    var name = filenameFor(nameHint);
    var url = API_IMAGES + '/' + folder + '/' + encodeURIComponent(name);
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob
    }, 15000).then(function (r) {
      var b = r.body;
      if (!r.ok || !b || b.ok !== true || !isImageName(b.name)) {
        var why = (b && b.error) ? b.error : ('HTTP ' + r.status);
        throw new Error('图片保存失败：' + why);
      }
      return { ok: true, mode: 'server', name: b.name, path: pathFor(folder, b.name) };
    });
  }

  /* ---------------- 文件系统后端（FSA） ---------------- */

  function dirHasFolders(dir) {
    return Promise.all([
      dir.getDirectoryHandle('backgrounds'),
      dir.getDirectoryHandle('wallpapers')
    ]).then(function () { return true; }, function () { return false; });
  }

  /* 允许用户选 data/ 或 desktop-pet/；两种都归一成 data 目录 */
  function resolveDataDir(picked) {
    return dirHasFolders(picked).then(function (ok) {
      if (ok) return picked;
      return picked.getDirectoryHandle('data').then(function (dataDir) {
        return dirHasFolders(dataDir).then(function (ok2) {
          if (!ok2) throw new Error('所选文件夹里没有 backgrounds / wallpapers 子目录');
          return dataDir;
        });
      }, function () {
        throw new Error('请选择 desktop-pet/data 文件夹（里面有 backgrounds 和 wallpapers）');
      });
    });
  }

  function permissionOf(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') {
      return Promise.resolve('granted');
    }
    return handle.queryPermission({ mode: 'readwrite' }).then(function (p) {
      return p || 'prompt';
    }, function () {
      return 'prompt';
    });
  }

  function requestWrite(handle) {
    if (!handle || typeof handle.requestPermission !== 'function') {
      return Promise.resolve('granted');
    }
    return handle.requestPermission({ mode: 'readwrite' }).then(function (p) {
      return p || 'prompt';
    }, function (e) {
      return errName(e) === 'NotAllowedError' ? 'denied' : 'prompt';
    });
  }

  /* values() 是异步迭代器；用 Promise 递归，保持代码库的 ES5 风格 */
  function readEntries(dir) {
    var out = [];
    var iterator;
    if (typeof dir.values === 'function') iterator = dir.values();
    else if (typeof dir.entries === 'function') iterator = dir.entries();

    if (!iterator || typeof iterator.next !== 'function') {
      // 退化路径：fake/旧实现可能直接给数组
      if (Array.isArray(dir._entries)) return Promise.resolve(dir._entries.slice());
      return Promise.resolve(out);
    }

    return new Promise(function (resolve, reject) {
      function step() {
        iterator.next().then(function (r) {
          if (r.done) { resolve(out); return; }
          out.push(r.value);
          step();
        }, reject);
      }
      step();
    });
  }

  function entryName(entry) {
    if (!entry) return '';
    if (typeof entry.name === 'string') return entry.name;
    // entries() 的 value 是 [name, handle]
    if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
    return '';
  }

  function entryHandle(entry) {
    if (Array.isArray(entry)) return entry[1];
    return entry;
  }

  function fsaScanFolder(folder) {
    return lib.handle.getDirectoryHandle(folder).then(function (dir) {
      return readEntries(dir).then(function (entries) {
        var out = [];
        entries.forEach(function (entry) {
          var handle = entryHandle(entry);
          var name = entryName(entry);
          if (!name || !handle || handle.kind !== 'file') return;
          if (!isImageName(name)) return;
          out.push(makeItem(folder, name));
        });
        return out;
      });
    });
  }

  function fsaList() {
    return Promise.all(FOLDER_KEYS.map(fsaScanFolder)).then(function (lists) {
      return { backgrounds: lists[0], wallpapers: lists[1] };
    });
  }

  function fsaNameExists(folder, name) {
    return lib.handle.getDirectoryHandle(folder).then(function (dir) {
      return dir.getFileHandle(name).then(function () { return true; }, function () { return false; });
    });
  }

  function fsaUniqueName(folder, base) {
    var stem = base.replace(/\.jpg$/i, '');
    var candidate = base;
    var n = 1;

    function tryNext() {
      return fsaNameExists(folder, candidate).then(function (exists) {
        if (!exists) return candidate;
        n++;
        if (n > 999) throw new Error('同名文件太多，换一个文件名试试');
        candidate = stem + '-' + n + '.jpg';
        return tryNext();
      });
    }
    return tryNext();
  }

  function fsaSave(folder, blob, nameHint) {
    if (!lib.handle) return Promise.reject(new Error('还没有授权 data 目录'));
    return permissionOf(lib.handle).then(function (perm) {
      if (perm !== 'granted') {
        // 导入动作本身是用户手势，先尝试原地申请一次；失败再由面板按钮重试
        return requestWrite(lib.handle).then(function (p2) {
          if (p2 !== 'granted') {
            var e = new Error('目录读写权限未授予');
            e.name = 'NotAllowedError';
            throw e;
          }
        });
      }
    }).then(function () {
      var wanted = filenameFor(nameHint);
      return fsaUniqueName(folder, wanted);
    }).then(function (name) {
      return lib.handle.getDirectoryHandle(folder).then(function (dir) {
        return dir.getFileHandle(name, { create: true }).then(function (fh) {
          return fh.createWritable().then(function (writable) {
            return writable.write(blob).then(function () {
              return writable.close();
            }, function (e) {
              if (typeof writable.abort === 'function') {
                try { writable.abort(); } catch (e2) { /* 忽略 */ }
              }
              throw e;
            }).then(function () {
              return { ok: true, mode: 'fsa', name: name, path: pathFor(folder, name) };
            });
          });
        });
      });
    });
  }

  /* ---------------- 状态 / 扫描 ---------------- */

  function makeItem(folder, name) {
    var path = pathFor(folder, name);
    return {
      name: name,
      label: labelOf(name),
      path: path,
      url: encodePath(path)
    };
  }

  function sortItems(list) {
    list.sort(function (a, b) {
      return String(b.name).localeCompare(String(a.name), 'zh-CN');
    });
    return list;
  }

  function listNames(folder) {
    return cache[folder].map(function (it) { return it.name; }).join('\n');
  }

  function applyList(next) {
    var changed = false;
    FOLDER_KEYS.forEach(function (folder) {
      var before = listNames(folder);
      cache[folder] = sortItems((next && next[folder]) || []);
      if (before !== listNames(folder)) changed = true;
    });
    return changed;
  }

  function refresh() {
    if (_refreshPromise) return _refreshPromise;

    if (lib.mode === 'server') {
      _refreshPromise = serverList().then(function (next) {
        applyList(next);
        lib.state = 'ready';
        lib.lastError = null;
        emitChanged();
        return { ok: true, counts: counts() };
      }, function (e) {
        lib.state = 'error';
        lib.lastError = errText(e);
        emitChanged();
        return { ok: false, error: lib.lastError };
      });
    } else if (lib.mode === 'fsa') {
      if (!lib.handle) {
        lib.state = 'needs-authorize';
        return Promise.resolve({ ok: false, error: 'needs-authorize' });
      }
      _refreshPromise = permissionOf(lib.handle).then(function (perm) {
        if (perm !== 'granted') {
          lib.state = perm === 'denied' ? 'denied' : 'needs-permission';
          emitChanged();
          return { ok: false, error: perm };
        }
        return fsaList().then(function (next) {
          applyList(next);
          lib.state = 'ready';
          lib.lastError = null;
          emitChanged();
          return { ok: true, counts: counts() };
        });
      }).catch(function (e) {
        if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') {
          lib.state = 'needs-permission';
        } else {
          lib.state = 'error';
        }
        lib.lastError = errText(e);
        emitChanged();
        return { ok: false, error: lib.lastError };
      });
    } else {
      return Promise.resolve({ ok: false, error: 'unsupported' });
    }

    _refreshPromise.then(function (r) {
      _refreshPromise = null;
      return r;
    }, function () {
      _refreshPromise = null;
    });
    return _refreshPromise;
  }

  function counts() {
    return {
      backgrounds: cache.backgrounds.length,
      wallpapers: cache.wallpapers.length,
      total: cache.backgrounds.length + cache.wallpapers.length
    };
  }

  /* ---------------- 模式探测 ---------------- */

  function detect() {
    if (isHttp() && typeof fetch === 'function') {
      return probeServer().then(function (ok) {
        if (ok) {
          lib.mode = 'server';
          lib.state = 'ready';
          return refresh().then(function () { return getStatus(); });
        }
        return detectFsaOrNone();
      });
    }
    return detectFsaOrNone();
  }

  function detectFsaOrNone() {
    // FSA 只在 file:// 下启用：HTTP 托管时授权的本地目录和页面 URL 不是同一份文件，
    // 写进去也加载不出来，硬做只会让用户困惑。
    if (!isFileProtocol() || !hasFsa()) {
      lib.mode = 'none';
      lib.state = 'unsupported';
      return Promise.resolve(getStatus());
    }

    lib.mode = 'fsa';
    return idbGet(HANDLE_KEY).then(function (record) {
      var handle = record && record.handle;
      // 旧记录/损坏记录可能不是目录句柄，别把它当可用句柄
      if (!handle || handle.kind !== 'directory' ||
          typeof handle.getDirectoryHandle !== 'function') {
        lib.state = 'needs-authorize';
        return getStatus();
      }
      lib.handle = handle;
      return permissionOf(handle).then(function (perm) {
        if (perm === 'granted') {
          lib.state = 'ready';
          return refresh().then(function () { return getStatus(); });
        }
        lib.state = perm === 'denied' ? 'denied' : 'needs-permission';
        return getStatus();
      });
    }).catch(function () {
      // IndexedDB 不可用：本次仍可授权使用，只是下次打开要重选
      lib.state = 'needs-authorize';
      return getStatus();
    });
  }

  function init() {
    if (_initPromise) return _initPromise;
    _initPromise = detect().catch(function (e) {
      lib.state = 'error';
      lib.lastError = errText(e);
      return getStatus();
    });
    return _initPromise;
  }

  /* ---------------- 授权 ---------------- */

  function authorize() {
    if (lib.mode === 'server') {
      return refresh().then(function (r) { return r.ok; });
    }
    if (lib.mode !== 'fsa' || !hasFsa()) {
      return Promise.resolve(false);
    }

    function useHandle(handle) {
      return resolveDataDir(handle).then(function (dataDir) {
        // 文件选择框按 readwrite 打开时通常已经授权，先查再申请，避免多余弹窗
        return permissionOf(dataDir).then(function (perm) {
          return perm === 'granted' ? perm : requestWrite(dataDir);
        }).then(function (perm) {
          if (perm !== 'granted') {
            var e = new Error('没有拿到目录读写权限');
            e.name = 'NotAllowedError';
            throw e;
          }
          lib.handle = dataDir;
          lib.state = 'ready';
          lib.lastError = null;
          // 句柄持久化失败不影响本次使用
          return idbPut({ id: HANDLE_KEY, handle: dataDir, savedAt: Date.now() })
            .catch(function () {})
            .then(function () {
              return refresh().then(function (r) { return !!(r && r.ok); });
            });
        });
      });
    }

    function pick() {
      return window.showDirectoryPicker({ id: 'desktop-pet-data', mode: 'readwrite' })
        .then(useHandle);
    }

    function failAuth(e) {
      if (errName(e) === 'AbortError') {
        lib.lastError = '已取消目录授权';
      } else if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') {
        lib.state = 'denied';
        lib.lastError = '浏览器拒绝了目录权限';
      } else {
        lib.state = 'error';
        lib.lastError = errText(e);
      }
      emitChanged();
      return false;
    }

    // 已恢复的句柄：先原地申请权限（不再弹目录选择框），失败/过期再重新选。
    // 两条分支都要走 failAuth，避免用户取消选择时抛未处理的 rejection。
    var attempt;
    if (lib.handle && lib.state === 'needs-permission') {
      attempt = requestWrite(lib.handle).then(function (perm) {
        if (perm === 'granted') {
          lib.state = 'ready';
          lib.lastError = null;
          return refresh().then(function (r) { return !!(r && r.ok); });
        }
        return pick();
      }, pick);
    } else {
      attempt = pick();
    }

    return attempt.catch(failAuth);
  }

  /* ---------------- 保存 ---------------- */

  function badResult(e) {
    var reason;
    if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') {
      if (lib.mode === 'fsa') lib.state = 'needs-permission';
      reason = 'needs-permission';
    } else {
      reason = errText(e);
    }
    lib.lastError = errText(e);
    emitChanged();
    return { ok: false, mode: lib.mode, error: reason };
  }

  function save(folder, dataUrl, opts) {
    if (FOLDER_KEYS.indexOf(folder) < 0) {
      return Promise.resolve({ ok: false, error: '未知图片目录' });
    }
    if (lib.mode === 'none' || lib.mode === 'detecting') {
      return Promise.resolve({ ok: false, mode: lib.mode, error: 'unsupported' });
    }

    var blob = dataUrlToBlob(dataUrl);
    if (!blob) return Promise.resolve({ ok: false, mode: lib.mode, error: '图片数据无法解码' });
    var nameHint = (opts && opts.name) || 'image';

    var run;
    if (lib.mode === 'server') {
      if (lib.state !== 'ready') {
        return Promise.resolve({ ok: false, mode: 'server', error: '图片服务不可用' });
      }
      run = serverSave(folder, blob, nameHint);
    } else {
      if (!lib.handle) {
        return Promise.resolve({ ok: false, mode: 'fsa', error: 'needs-authorize' });
      }
      run = fsaSave(folder, blob, nameHint);
    }

    return run.then(function (res) {
      if (lib.mode === 'server') {
        return refresh().then(function () { return res; });
      }
      // FSA：把新文件并进缓存，避免为了一个文件再全量扫一遍
      var item = makeItem(folder, res.name);
      var exists = cache[folder].some(function (it) { return it.name === item.name; });
      if (!exists) {
        cache[folder].push(item);
        sortItems(cache[folder]);
        emitChanged();
      }
      lib.state = 'ready';
      return res;
    }, badResult);
  }

  /* ---------------- 对外状态 ---------------- */

  function getStatus(folder) {
    var c = counts();
    // 面板可以只关心自己那个目录的数量（背景面板显示背景数，壁纸面板显示壁纸数）
    var shown = (folder && Object.prototype.hasOwnProperty.call(c, folder)) ? c[folder] : c.total;
    var suffix = folder === 'backgrounds' ? '（背景图）'
      : (folder === 'wallpapers' ? '（壁纸）' : '');
    var canAuthorize = false;
    var canRefresh = false;
    var canWrite = false;
    var message = '';
    var tone = 'muted';

    if (lib.mode === 'server') {
      canRefresh = lib.state === 'ready';
      canAuthorize = lib.state === 'error';
      canWrite = lib.state === 'ready';
      if (lib.state === 'ready') {
        message = '图片库：本地服务模式，已同步 ' + shown + ' 张' + suffix;
        tone = 'ok';
      } else if (lib.state === 'error') {
        message = '连不上本地图片服务：' + (lib.lastError || '请确认 npm run serve 还在运行');
        tone = 'bad';
      } else {
        message = '正在连接本地图片服务…';
      }
    } else if (lib.mode === 'fsa') {
      canWrite = lib.state === 'ready';
      canRefresh = lib.state === 'ready';
      canAuthorize = lib.state !== 'ready';
      if (lib.state === 'ready') {
        message = '图片库：已授权 data 目录，已同步 ' + shown + ' 张' + suffix;
        tone = 'ok';
      } else if (lib.state === 'needs-authorize') {
        message = '授权 data 目录后，新图片会自动出现在这里，导入的图也会写回文件夹。';
      } else if (lib.state === 'needs-permission') {
        message = '目录授权已过期，点「重新授权」即可恢复（可在弹窗里选「每次访问都允许」）。';
        tone = 'bad';
      } else if (lib.state === 'denied') {
        message = '目录权限被拒绝，导入的图只能暂存在浏览器里。';
        tone = 'bad';
      } else if (lib.state === 'error') {
        message = '读取图片目录失败：' + (lib.lastError || '未知错误');
        tone = 'bad';
      } else {
        message = '正在读取图片目录…';
      }
    } else if (lib.mode === 'none') {
      message = '当前打开方式不能写入文件夹；导入的图只保存在浏览器里。' +
        '用 Chrome/Edge 双击打开并授权 data 目录，或运行 npm run serve。';
    } else {
      message = '正在读取图片目录…';
    }

    return {
      mode: lib.mode,
      state: lib.state,
      counts: c,
      canAuthorize: canAuthorize,
      canRefresh: canRefresh,
      canWrite: canWrite,
      canPickFolder: lib.mode === 'fsa',
      message: message,
      tone: tone,
      lastError: lib.lastError
    };
  }

  App.ImageLib = {
    mode: lib.mode,
    state: lib.state,
    getStatus: getStatus,
    init: init,
    authorize: authorize,
    refresh: refresh,
    list: function (folder) {
      return (cache[folder] || []).slice();
    },
    save: save,
    isImageName: isImageName,
    isImagePath: isImagePath,
    folderOf: folderOf,
    encodePath: encodePath,
    labelOf: labelOf,
    filenameFor: filenameFor,
    dataUrlToBlob: dataUrlToBlob,
    FOLDERS: FOLDERS
  };

  // 让外部读到的 mode/state 始终跟随内部状态（避免两套字段不同步）
  Object.defineProperty(App.ImageLib, 'mode', {
    enumerable: true,
    get: function () { return lib.mode; }
  });
  Object.defineProperty(App.ImageLib, 'state', {
    enumerable: true,
    get: function () { return lib.state; }
  });
})();
