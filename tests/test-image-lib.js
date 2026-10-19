/*
 * 无头测试：imageLib.js 的三种后端（none / server / fsa）+ 与 settings.js 的接线
 * 运行： node tests/test-image-lib.js
 *
 * FSA 的原生目录选择框没法在无头环境里弹出，这里用 fake handle 模拟
 * queryPermission / requestPermission / values / createWritable 的行为。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');
const DATA_URL = 'data:image/jpeg;base64,/9j/';       // FF D8 FF
const KEY = 'desktop_pet_settings';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

/* ---------------- Fake IndexedDB（只支持 imageLib 用到的 get/put） ---------------- */

function FakeIDB() {
  this.dbs = Object.create(null);
}

FakeIDB.prototype.open = function (name) {
  const fresh = !this.dbs[name];
  const db = this.dbs[name] || (this.dbs[name] = makeFakeDB());
  const req = {};
  setTimeout(function () {
    req.result = db;
    if (fresh && req.onupgradeneeded) req.onupgradeneeded();
    if (req.onsuccess) req.onsuccess();
  }, 0);
  return req;
};

function makeFakeDB() {
  const stores = Object.create(null);
  return {
    objectStoreNames: {
      contains: function (n) { return Object.prototype.hasOwnProperty.call(stores, n); }
    },
    createObjectStore: function (n, opts) {
      stores[n] = { data: new Map(), keyPath: opts && opts.keyPath };
      return {};
    },
    transaction: function (n) {
      const store = stores[n];
      if (!store) throw new Error('store 不存在：' + n);
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null, _work: null };
      setTimeout(function () {
        try {
          if (tx._work) tx._work();
          if (tx.oncomplete) tx.oncomplete();
        } catch (e) {
          tx.error = e;
          if (tx.onerror) tx.onerror();
        }
      }, 0);
      tx.objectStore = function () {
        return {
          put: function (v) {
            const r = { result: v.id };
            tx._work = function () { store.data.set(v.id, v); };
            return r;
          },
          get: function (k) {
            const r = {};
            tx._work = function () { r.result = store.data.get(k); };
            return r;
          }
        };
      };
      return tx;
    }
  };
}

/* ---------------- Fake File System Access 句柄 ---------------- */

class FakeFileHandle {
  constructor(name) {
    this.kind = 'file';
    this.name = name;
    this.blob = null;
    this.closed = false;
    this.aborted = false;
  }
  createWritable() {
    const self = this;
    return Promise.resolve({
      write: function (blob) { self.blob = blob; return Promise.resolve(); },
      close: function () { self.closed = true; return Promise.resolve(); },
      abort: function () { self.aborted = true; }
    });
  }
}

class FakeDirHandle {
  constructor(name, perm) {
    this.kind = 'directory';
    this.name = name;
    this.dirs = Object.create(null);
    this.files = Object.create(null);
    this.perm = perm || 'granted';
    this.requested = 0;
  }
  queryPermission() { return Promise.resolve(this.perm); }
  requestPermission() {
    this.requested++;
    if (this.perm === 'denied') return Promise.resolve('denied');
    this.perm = 'granted';
    return Promise.resolve('granted');
  }
  getDirectoryHandle(n) {
    if (this.dirs[n]) return Promise.resolve(this.dirs[n]);
    const e = new Error('not found: ' + n);
    e.name = 'NotFoundError';
    return Promise.reject(e);
  }
  getFileHandle(n, opts) {
    if (this.files[n]) return Promise.resolve(this.files[n]);
    if (opts && opts.create) {
      this.files[n] = new FakeFileHandle(n);
      return Promise.resolve(this.files[n]);
    }
    const e = new Error('not found: ' + n);
    e.name = 'NotFoundError';
    return Promise.reject(e);
  }
  addDir(name) {
    const d = new FakeDirHandle(name);
    this.dirs[name] = d;
    return d;
  }
  addFile(name) {
    const f = new FakeFileHandle(name);
    this.files[name] = f;
    return f;
  }
  values() {
    const items = Object.values(this.dirs).concat(Object.values(this.files));
    let i = 0;
    return {
      next: function () {
        return Promise.resolve(i < items.length
          ? { value: items[i++], done: false }
          : { value: undefined, done: true });
      }
    };
  }
}

function makeProjectTree() {
  const data = new FakeDirHandle('data');
  const backgrounds = data.addDir('backgrounds');
  backgrounds.addFile('a.jpg');
  backgrounds.addFile('note.txt');
  backgrounds.addFile('.hidden.jpg');
  const wallpapers = data.addDir('wallpapers');
  wallpapers.addFile('b.png');
  const project = new FakeDirHandle('desktop-pet');
  project.dirs.data = data;
  return { project, data, backgrounds, wallpapers };
}

/* ---------------- 沙箱 ---------------- */

function makeSandbox(opts) {
  opts = opts || {};
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.Object = Object;
  sandbox.Array = Array;
  sandbox.String = String;
  sandbox.Number = Number;
  sandbox.Date = Date;
  sandbox.RegExp = RegExp;
  sandbox.Promise = Promise;
  sandbox.Error = Error;
  sandbox.Blob = Blob;
  sandbox.Uint8Array = Uint8Array;
  sandbox.atob = atob;
  sandbox.btoa = btoa;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.AbortController = AbortController;
  sandbox.decodeURIComponent = decodeURIComponent;
  sandbox.encodeURIComponent = encodeURIComponent;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.URL = URL;
  sandbox.location = { protocol: opts.protocol || 'file:', search: '' };
  sandbox.indexedDB = opts.indexedDB || new FakeIDB();
  if (opts.fetch) sandbox.fetch = opts.fetch;
  if (opts.showDirectoryPicker) sandbox.showDirectoryPicker = opts.showDirectoryPicker;
  sandbox.addEventListener = function () {};
  sandbox.document = {
    readyState: 'loading',
    addEventListener: function () {},
    getElementById: function () { return null; }
  };
  sandbox.App = {};

  if (opts.withSettings) {
    sandbox.document = makeDocument();
    sandbox.localStorage = makeLocalStorage(opts.store);
  }

  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(
    fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });

  if (opts.withSettings) {
    load('app.js');
    load('imageLib.js');
    load('settings.js');
  } else {
    load('imageLib.js');
  }
  return sandbox;
}

/* ---------------- 极简 DOM（只给 settings 集成测试用） ---------------- */

function el(tag) {
  const e = {
    tagName: tag, style: {}, dataset: {}, children: [], hidden: false,
    textContent: '', title: '', type: '', className: '', value: '', files: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) {
        if (on === undefined) (this._s.has(c) ? this._s.delete(c) : this._s.add(c));
        else (on ? this._s.add(c) : this._s.delete(c));
      },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; },
    querySelectorAll(sel) {
      let want = sel.replace(/[[\]]/g, '').split('=')[0];
      if (want.indexOf('data-') === 0) {
        want = want.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      }
      const out = [];
      const walk = (n) => {
        (n.children || []).forEach((k) => {
          if (k.dataset && k.dataset[want] !== undefined) out.push(k);
          walk(k);
        });
      };
      walk(this);
      return out;
    },
    contains(n) { return n === this || (this.children || []).some((k) => k.contains && k.contains(n)); },
    addEventListener(t, fn) { (this._listeners = this._listeners || {}); (this._listeners[t] = this._listeners[t] || []).push(fn); },
    click() { this.fire('click'); },
    fire(t, ev) {
      const target = this;
      for (let n = this; n; n = n.parentNode) {
        ((n._listeners && n._listeners[t]) || []).forEach((fn) => fn(Object.assign({ target }, ev)));
      }
    }
  };
  return e;
}

function makeDocument() {
  const els = {
    stage: el('div'),
    body: el('body'),
    'bg-picker': el('div'),
    'wallpaper-picker': el('div'),
    'btn-bg': el('button'),
    'btn-bg-clear': el('button'),
    'btn-wallpaper': el('button'),
    'btn-wallpaper-clear': el('button'),
    'file-bg': el('input'),
    'file-wallpaper': el('input')
  };
  els['bg-picker'].hidden = true;
  els['wallpaper-picker'].hidden = true;
  return {
    readyState: 'loading',
    addEventListener: function () {},
    getElementById: function (id) { return els[id] || null; },
    createElement: function (tag) { return el(tag); },
    createDocumentFragment: function () { return el('#fragment'); },
    body: els.body,
    _els: els
  };
}

function makeLocalStorage(store) {
  const data = store || {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

function pickerItems(doc, id) {
  return (doc._els[id].children[0] || { children: [] }).children;
}

function jsonResponse(body, status) {
  return Promise.resolve({
    ok: status == null || status < 400,
    status: status || 200,
    json: function () { return Promise.resolve(body); }
  });
}

async function main() {
  console.log('\n=== 用例 1：none 模式与纯函数 ===');
  {
    const sb = makeSandbox({ protocol: 'file:' });
    const lib = sb.App.ImageLib;
    await lib.init();
    check('file:// 且无 FSA → mode none', lib.mode === 'none', lib.mode);
    check('状态为 unsupported', lib.state === 'unsupported', lib.state);
    check('列表为空', lib.list('backgrounds').length === 0);

    check('合法背景路径', lib.isImagePath('data/backgrounds/a.jpg', 'backgrounds'));
    check('背景路径不能当壁纸', !lib.isImagePath('data/backgrounds/a.jpg', 'wallpapers'));
    check('拒绝 ../ 穿越', !lib.isImagePath('data/backgrounds/../evil.jpg', 'backgrounds'));
    check('拒绝编码穿越', !lib.isImagePath('data/backgrounds/%2e%2e%2fevil.jpg', 'backgrounds'));
    check('拒绝 SVG', !lib.isImagePath('data/backgrounds/a.svg', 'backgrounds'));
    check('拒绝点文件', !lib.isImagePath('data/backgrounds/.a.jpg', 'backgrounds'));
    check('接受 png/webp/gif',
      lib.isImagePath('data/wallpapers/a.png', 'wallpapers') &&
      lib.isImagePath('data/wallpapers/a.webp', 'wallpapers') &&
      lib.isImagePath('data/wallpapers/a.gif', 'wallpapers'));

    const d = new Date(2026, 9, 19, 13, 45, 0);
    check('文件名 = 原名 + 时间戳',
      lib.filenameFor('二次元.png', d) === '二次元-20261019-134500.jpg',
      lib.filenameFor('二次元.png', d));
    const dirty = lib.filenameFor('a:b*c?.png', d);
    check('非法字符被替换', !/[\\/:*?"<>|]/.test(dirty) && /\.jpg$/.test(dirty), dirty);
    check('Windows 保留名加前缀',
      lib.filenameFor('CON.png', d).indexOf('_CON-') === 0, lib.filenameFor('CON.png', d));
    const longName = lib.filenameFor('x'.repeat(200) + '.png', d);
    check('超长原文件名被截断', longName.length < 90, String(longName.length));

    check('encodePath 逐段编码',
      lib.encodePath('data/backgrounds/二 次#%.jpg') ===
      'data/backgrounds/%E4%BA%8C%20%E6%AC%A1%23%25.jpg',
      lib.encodePath('data/backgrounds/二 次#%.jpg'));

    const blob = lib.dataUrlToBlob(DATA_URL);
    check('dataUrlToBlob 还原 JPEG', blob && blob.type === 'image/jpeg' && blob.size === 3,
      blob && (blob.type + '/' + blob.size));

    const missing = await lib.save('backgrounds', DATA_URL, { name: 'x.png' });
    check('none 模式 save 明确失败', missing.ok === false && missing.error === 'unsupported',
      JSON.stringify(missing));
  }

  console.log('\n=== 用例 2：server 模式（探测、列表、上传） ===');
  {
    const calls = { get: 0, post: [] };
    let backgrounds = [{ name: 'bg1.jpg' }, { name: '新背景.jpg' }, { name: '../evil.jpg' }, { name: 'x.svg' }];
    const wallpapers = [{ name: 'wall1.jpg' }];
    const fetchStub = function (url, opts) {
      opts = opts || {};
      if (!opts.method || opts.method === 'GET') {
        calls.get++;
        return jsonResponse({
          ok: true, api: 'desktop-pet-images', version: 1,
          images: { backgrounds: backgrounds, wallpapers: wallpapers }
        });
      }
      calls.post.push({ url: url, opts: opts });
      const m = /api\/images\/([^/]+)\/(.+)$/.exec(url);
      const name = decodeURIComponent(m[2]);
      backgrounds = [{ name: name }].concat(backgrounds);
      return jsonResponse({ ok: true, folder: m[1], name: name, path: 'data/' + m[1] + '/' + name }, 201);
    };

    const sb = makeSandbox({ protocol: 'http:', fetch: fetchStub });
    const lib = sb.App.ImageLib;
    await lib.init();
    check('HTTP + API 标记 → mode server', lib.mode === 'server', lib.mode);
    const bgNames = lib.list('backgrounds').map((x) => x.name);
    check('背景列表过滤非法名字',
      bgNames.length === 2 && bgNames.indexOf('bg1.jpg') >= 0 && bgNames.indexOf('新背景.jpg') >= 0,
      bgNames.join(','));
    check('壁纸列表独立', lib.list('wallpapers').map((x) => x.name).join(',') === 'wall1.jpg');
    check('状态 ready', lib.state === 'ready', lib.state);

    const res = await lib.save('backgrounds', DATA_URL, { name: '导入图.png' });
    check('save 成功并返回客户端拼的路径',
      res.ok && /^data\/backgrounds\/导入图-\d{8}-\d{6}\.jpg$/.test(res.path), JSON.stringify(res));
    check('POST 地址逐段编码',
      calls.post.length === 1 && calls.post[0].url.indexOf('api/images/backgrounds/') === 0 &&
      calls.post[0].url.indexOf('%E5%AF%BC%E5%85%A5%E5%9B%BE-') > 0,
      calls.post[0] && calls.post[0].url);
    check('POST Content-Type 是 JPEG',
      calls.post[0].opts.headers['Content-Type'] === 'image/jpeg');
    check('POST body 是 Blob', typeof Blob !== 'undefined' && calls.post[0].opts.body instanceof Blob);
    check('保存后重新拉列表', calls.get >= 3, String(calls.get));
  }

  console.log('\n=== 用例 3：HTTP 探测失败 → 回落 none（不误用 FSA） ===');
  {
    const fetchStub = function () {
      return jsonResponse({ message: 'not found' }, 404);
    };
    let pickerCalled = 0;
    const sb = makeSandbox({
      protocol: 'http:',
      fetch: fetchStub,
      showDirectoryPicker: function () { pickerCalled++; return Promise.reject(new Error('no')); }
    });
    const lib = sb.App.ImageLib;
    await lib.init();
    check('HTTP 下没有图片服务 → mode none', lib.mode === 'none', lib.mode);
    check('不会在 HTTP 下弹目录选择', pickerCalled === 0);
  }

  console.log('\n=== 用例 4：FSA 首次授权、扫描、写入 ===');
  {
    const tree = makeProjectTree();
    const idb = new FakeIDB();
    let pickerCalls = 0;
    const sb = makeSandbox({
      protocol: 'file:',
      indexedDB: idb,
      showDirectoryPicker: function () { pickerCalls++; return Promise.resolve(tree.project); }
    });
    const lib = sb.App.ImageLib;
    await lib.init();
    check('无句柄 → needs-authorize', lib.mode === 'fsa' && lib.state === 'needs-authorize', lib.mode + '/' + lib.state);
    check('启动时不弹目录选择', pickerCalls === 0);

    const ok = await lib.authorize();
    check('授权成功', ok === true, String(ok));
    check('背景只列图片', lib.list('backgrounds').map((x) => x.name).join(',') === 'a.jpg',
      lib.list('backgrounds').map((x) => x.name).join(','));
    check('壁纸列表独立', lib.list('wallpapers').map((x) => x.name).join(',') === 'b.png');
    check('动态路径可选', lib.isImagePath(lib.list('backgrounds')[0].path, 'backgrounds'));

    const r1 = await lib.save('backgrounds', DATA_URL, { name: '新图.png' });
    check('FSA 写入成功', r1.ok && /^data\/backgrounds\/新图-\d{8}-\d{6}\.jpg$/.test(r1.path),
      JSON.stringify(r1));
    check('文件真的写进目录', !!tree.backgrounds.files[r1.name]);
    check('写入的是 Blob', tree.backgrounds.files[r1.name].blob instanceof Blob);
    check('writable 已 close', tree.backgrounds.files[r1.name].closed === true);

    const r2 = await lib.save('backgrounds', DATA_URL, { name: '新图.png' });
    check('同秒重名自动加 -2', r2.ok && /-2\.jpg$/.test(r2.name), JSON.stringify(r2));

    tree.data.perm = 'prompt';
    const r3 = await lib.refresh();
    check('权限过期 → needs-permission', r3.ok === false &&
      lib.state === 'needs-permission', lib.state);

    tree.data.perm = 'granted';
    const beforeRestore = tree.data.requested;
    const sb2 = makeSandbox({
      protocol: 'file:',
      indexedDB: idb,
      showDirectoryPicker: function () { throw new Error('不应该再弹选择框'); }
    });
    const lib2 = sb2.App.ImageLib;
    await lib2.init();
    check('下次打开恢复句柄并扫描', lib2.state === 'ready' &&
      lib2.list('backgrounds').length >= 1, lib2.state);
    check('恢复时不重复申请权限', lib2.mode === 'fsa' && tree.data.requested === beforeRestore,
      String(tree.data.requested - beforeRestore));
  }

  console.log('\n=== 用例 5：FSA 恢复句柄但权限是 prompt ===');
  {
    const tree = makeProjectTree();
    tree.data.perm = 'prompt';
    const idb = new FakeIDB();
    // 先手工塞一个句柄记录
    await new Promise((resolve) => {
      const req = idb.open('desktop_pet_images');
      req.onupgradeneeded = function () {
        req.result.createObjectStore('handles', { keyPath: 'id' });
      };
      req.onsuccess = function () {
        const db = req.result;
        const tx = db.transaction('handles');
        tx.objectStore('handles').put({ id: 'dataDir', handle: tree.data, savedAt: Date.now() });
        tx.oncomplete = resolve;
      };
    });

    const sb = makeSandbox({
      protocol: 'file:',
      indexedDB: idb,
      showDirectoryPicker: function () { throw new Error('不应弹出'); }
    });
    const lib = sb.App.ImageLib;
    await lib.init();
    check('恢复句柄但未授权 → needs-permission', lib.state === 'needs-permission', lib.state);
    check('不自动调用 requestPermission', tree.data.requested === 0, String(tree.data.requested));
    const st = lib.getStatus();
    check('状态里提供重新授权入口', st.canAuthorize === true && st.canWrite === false);
  }

  console.log('\n=== 用例 6：FSA 选错目录 ===');
  {
    const wrong = new FakeDirHandle('downloads');
    const sb = makeSandbox({
      protocol: 'file:',
      showDirectoryPicker: function () { return Promise.resolve(wrong); }
    });
    const lib = sb.App.ImageLib;
    await lib.init();
    const ok = await lib.authorize();
    check('选错目录 → 授权失败', ok === false, String(ok));
    check('给出可读错误', /data|backgrounds|wallpapers/.test(lib.getStatus().lastError || ''),
      lib.getStatus().lastError);
  }

  console.log('\n=== 用例 7：settings.js 接线 ===');
  {
    const store = {};
    const backgrounds = [{ name: 'bg1.jpg' }, { name: '新背景.jpg' }];
    const wallpapers = [{ name: 'wall1.jpg' }, { name: '新壁纸.png' }];
    const posts = [];
    const fetchStub = function (url, opts) {
      opts = opts || {};
      if (!opts.method || opts.method === 'GET') {
        return jsonResponse({
          ok: true, api: 'desktop-pet-images', version: 1,
          images: { backgrounds: backgrounds, wallpapers: wallpapers }
        });
      }
      posts.push({ url: url, opts: opts });
      const m = /api\/images\/([^/]+)\/(.+)$/.exec(url);
      const name = decodeURIComponent(m[2]);
      (m[1] === 'backgrounds' ? backgrounds : wallpapers).unshift({ name: name });
      return jsonResponse({ ok: true, name: name }, 201);
    };

    const sb = makeSandbox({
      protocol: 'http:',
      fetch: fetchStub,
      withSettings: true,
      store: store
    });
    const doc = sb.document;
    const App = sb.App;
    const msgs = [];
    App.Output = {
      error: (m) => msgs.push('error:' + m),
      system: (m) => msgs.push('system:' + m),
      pet: function () {}
    };
    App.Bubble = { say: function (m) { msgs.push('bubble:' + m); } };

    const S = App.Settings;
    S.init();
    await tick(30);

    const bgItems = pickerItems(doc, 'bg-picker');
    const bgPaths = bgItems.filter((n) => n.dataset && n.dataset.path !== undefined)
      .map((n) => n.dataset.path);
    check('背景面板：无 + 预设 + 动态（去重）',
      bgPaths.join(',') === ',data/backgrounds/bg1.jpg,data/backgrounds/新背景.jpg',
      bgPaths.join(','));
    check('背景导入按钮仍在最后',
      bgItems[bgItems.length - 1].dataset.action === 'import');
    check('状态行是第二个子节点',
      doc._els['bg-picker'].children.length === 2 &&
      doc._els['bg-picker'].children[1].className === 'image-lib-status');
    check('状态行显示本目录的同步数量',
      doc._els['bg-picker'].children[1].children[0].textContent.indexOf('已同步 2 张（背景图）') >= 0,
      doc._els['bg-picker'].children[1].children[0].textContent);

    const wpPaths = pickerItems(doc, 'wallpaper-picker')
      .filter((n) => n.dataset && n.dataset.path !== undefined).map((n) => n.dataset.path);
    check('壁纸面板不含背景图',
      wpPaths.indexOf('data/backgrounds/新背景.jpg') < 0 &&
      wpPaths.indexOf('data/wallpapers/新壁纸.png') > 0,
      wpPaths.join(','));

    const dyn = bgItems.filter((n) => n.dataset.path === 'data/backgrounds/新背景.jpg')[0];
    dyn.fire('click');
    check('点动态缩略图 → CSS 使用编码后的 URL',
      doc._els.stage.style.backgroundImage.indexOf(
        'url("data/backgrounds/%E6%96%B0%E8%83%8C%E6%99%AF.jpg")') > 0,
      doc._els.stage.style.backgroundImage);

    msgs.length = 0;
    S._storeImportedImage('backgrounds', 'bg', DATA_URL, { name: '导入图.png' }, function (m) {
      msgs.push('fail:' + m);
    });
    await tick(40);

    const saved = JSON.parse(store[KEY]);
    check('导入后设置里存路径而不是 base64',
      /^data\/backgrounds\/导入图-\d{8}-\d{6}\.jpg$/.test(saved.bg || ''), saved.bg);
    check('确实向服务器 POST 了', posts.length === 1, String(posts.length));
    check('提示里说明保存位置',
      msgs.some((m) => m.indexOf('保存到 data/backgrounds/') >= 0), JSON.stringify(msgs));
    check('舞台使用新路径',
      doc._els.stage.style.backgroundImage.indexOf(
        'url("data/backgrounds/%E5%AF%BC%E5%85%A5%E5%9B%BE-') > 0,
      doc._els.stage.style.backgroundImage);

    // 图片从目录里消失：授权/扫描成功后清理选择
    S.bg = 'data/backgrounds/gone.jpg';
    S.reconcileImageSelections();
    check('目录里不存在的动态选择被清空', S.bg === null, String(S.bg));
    check('清空后舞台回到纯色', doc._els.stage.style.backgroundImage === '',
      doc._els.stage.style.backgroundImage);
  }

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
