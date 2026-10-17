/*
 * 无头测试：character/packZip.js（zip 解析/打包）+ character/packStore.js（IndexedDB）
 *           + character/animation.js 的 setCharacter 切换逻辑
 * 运行： node tests/test-character-pack.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');
const FIX = path.join(__dirname, 'fixtures', 'charpacks');
const basicBytes = new Uint8Array(fs.readFileSync(path.join(FIX, 'basic-stored.zip')));
const deflateBytes = new Uint8Array(fs.readFileSync(path.join(FIX, 'deflate.zip')));

/* ---------------- 夹具内容（与生成脚本一致） ---------------- */

const IDLE = new Uint8Array(2053);
IDLE.set(Buffer.from('IDLE0'), 0);
for (let i = 0; i < 2048; i++) IDLE[5 + i] = i % 256;

const STUDY = new Uint8Array(1542);
STUDY.set(Buffer.from('STUDY0'), 0);
for (let i = 0; i < 1536; i++) STUDY[6 + i] = 255 - (i % 256);

function repeatBytes(src, times) {
  const out = new Uint8Array(src.length * times);
  for (let i = 0; i < times; i++) out.set(src, i * src.length);
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------------- zip 结构小工具（用于手工做坏包） ---------------- */

function dvOf(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

function eocdOffset(u8) {
  const dv = dvOf(u8);
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function centralEntries(u8) {
  const dv = dvOf(u8);
  const e = eocdOffset(u8);
  const count = dv.getUint16(e + 10, true);
  const cd = dv.getUint32(e + 16, true);
  const list = [];
  let off = cd;
  for (let n = 0; n < count; n++) {
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    list.push({
      name: Buffer.from(u8.slice(off + 46, off + 46 + nameLen)).toString('utf8'),
      flagsOff: off + 8,
      methodOff: off + 10,
      localOff: dv.getUint32(off + 42, true)
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return list;
}

function findEntry(u8, name) {
  return centralEntries(u8).filter(e => e.name === name)[0] || null;
}

function localDataRange(u8, name) {
  const dv = dvOf(u8);
  let off = 0;
  while (off + 30 <= u8.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const compSize = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const nm = Buffer.from(u8.slice(off + 30, off + 30 + nameLen)).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    if (nm === name) return { start: start, size: compSize, method: method };
    if (method !== 0) return null;   // 找不到可靠边界就放弃
    off = start + compSize;
  }
  return null;
}

/* ---------------- 极简 DOM / IndexedDB / URL 桩 ---------------- */

function FakeVideo() {
  this.hidden = true;
  this.loop = false;
  this.muted = false;
  this.preload = '';
  this.currentTime = 0;
  this._attrs = {};
  this._listeners = {};
  this.played = 0;
}
FakeVideo.prototype.getAttribute = function (n) {
  return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null;
};
FakeVideo.prototype.setAttribute = function (n, v) { this._attrs[n] = String(v); };
FakeVideo.prototype.removeAttribute = function (n) { delete this._attrs[n]; };
FakeVideo.prototype.addEventListener = function (t, fn) {
  (this._listeners[t] || (this._listeners[t] = [])).push(fn);
};
FakeVideo.prototype.play = function () { this.played++; return Promise.resolve(); };
FakeVideo.prototype.pause = function () {};
FakeVideo.prototype.load = function () {};

const docListeners = {};
const documentStub = {
  readyState: 'loading',
  body: null,
  createElement: function (tag) {
    if (String(tag).toLowerCase() === 'video') return new FakeVideo();
    return { dataset: {}, style: {}, children: [], appendChild: function () {} };
  },
  getElementById: function () { return null; },
  addEventListener: function (t, fn) {
    (docListeners[t] || (docListeners[t] = [])).push(fn);
  },
  querySelector: function () { return null; }
};

function FakeIDB() { this.dbs = {}; this.quota = false; }

FakeIDB.prototype.open = function (name) {
  const self = this;
  const fresh = !this.dbs[name];
  const db = this.dbs[name] || (this.dbs[name] = makeFakeDB(self));
  const req = {};
  setTimeout(function () {
    req.result = db;
    if (fresh && req.onupgradeneeded) req.onupgradeneeded();
    if (req.onsuccess) req.onsuccess();
  }, 0);
  return req;
};

function makeFakeDB(fake) {
  const stores = {};
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
        if (fake.quota) {
          tx.error = { name: 'QuotaExceededError', message: 'quota' };
          if (tx.onerror) tx.onerror();
          return;
        }
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
          },
          getAll: function () {
            const r = {};
            tx._work = function () { r.result = Array.from(store.data.values()); };
            return r;
          },
          // 与真实 IDBObjectStore 一致：删除方法叫 delete()，没有 remove()
          'delete': function (k) {
            const r = {};
            tx._work = function () { store.data.delete(k); };
            return r;
          }
        };
      };
      return tx;
    }
  };
}

const urlCreated = [];
const urlRevoked = [];
let urlSeq = 0;
const URLStub = {
  createObjectURL: function (blob) {
    const u = 'blob:test/' + (++urlSeq);
    urlCreated.push({ url: u, blob: blob });
    return u;
  },
  revokeObjectURL: function (u) { urlRevoked.push(u); }
};

/* ---------------- 沙箱 ---------------- */

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
sandbox.Blob = Blob;
sandbox.Uint8Array = Uint8Array;
sandbox.Uint32Array = Uint32Array;
sandbox.DataView = DataView;
sandbox.ArrayBuffer = ArrayBuffer;
sandbox.TextDecoder = TextDecoder;
sandbox.TextEncoder = TextEncoder;
sandbox.Response = Response;
if (typeof DecompressionStream === 'function') sandbox.DecompressionStream = DecompressionStream;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setImmediate = setImmediate;
sandbox.URL = URLStub;
sandbox.URLSearchParams = URLSearchParams;
sandbox.location = { search: '' };
sandbox.document = documentStub;
sandbox.indexedDB = new FakeIDB();
sandbox.addEventListener = function () {};
sandbox.App = {};

vm.createContext(sandbox);
const load = rel => vm.runInContext(
  fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });

load('app.js');
load('character/packZip.js');
load('character/packStore.js');
load('character/builtin.js');
load('character/animation.js');

const App = sandbox.App;
const PZ = App.PackZip;
const PS = App.PackStore;
const A = App.Animation;

/* ---------------- 断言 ---------------- */

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) + ' vs ' + JSON.stringify(want));

function ab(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
async function zipBytes(files, manifest) {
  const blob = await PZ.buildZip(files, manifest);
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------------- 场景 ---------------- */

(async function run() {
  console.log('\n=== A. CRC32 ===');
  eq('标准串 CRC32 = 0xCBF43926', PZ.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  eq('空数据 CRC32 = 0', PZ.crc32(new Uint8Array(0)), 0);

  console.log('\n=== B. stateFromName ===');
  eq('idle.webm', PZ.stateFromName('idle.webm'), 'idle');
  eq('studying .webm（尾随空格）', PZ.stateFromName('studying .webm'), 'studying');
  eq('MyChar/Alert.MP4（目录+大写）', PZ.stateFromName('MyChar/Alert.MP4'), 'alert');
  eq('backup/idle.webm（多层目录）', PZ.stateFromName('backup/idle.webm'), 'idle');
  eq('work-ing.webm（连字符）', PZ.stateFromName('work-ing.webm'), 'working');
  eq('random.webm -> null', PZ.stateFromName('random.webm'), null);
  eq('idle.webm.txt -> null', PZ.stateFromName('idle.webm.txt'), null);

  console.log('\n=== C. parseZip：STORED / 损坏输入 ===');
  const parsed = await PZ.parseZip(ab(basicBytes));
  eq('条目数', parsed.entries.length, 6);
  eq('条目顺序与名字',
    parsed.entries.map(e => e.name),
    ['MyChar/idle.webm', 'MyChar/studying .webm', 'MyChar/backup/idle.webm',
      'MyChar/junk.txt', 'MyChar/中文.txt', 'MyChar/manifest.json']);
  const entryIdle = parsed.entries[0];
  eq('idle 大小取中央目录', entryIdle.size, IDLE.length);
  eq('STORED 条目 method=0', entryIdle.method, 0);
  check('STORED getBlob 字节一致',
    equalBytes(await bytesOf(await entryIdle.getBlob()), IDLE));
  check('UTF-8 文件名解码正确（flag 0x800）',
    parsed.entries[4].name === 'MyChar/中文.txt' && (parsed.entries[4].flags & 0x800) !== 0,
    parsed.entries[4].name + ' flags=' + parsed.entries[4].flags);

  let nonZipMsg = '';
  await PZ.parseZip(new Uint8Array([1, 2, 3, 4]).buffer)
    .then(() => { nonZipMsg = 'resolved'; }, e => { nonZipMsg = e.message; });
  check('非 zip 字节 reject 且消息含 zip', /zip/i.test(nonZipMsg), nonZipMsg);

  let truncMsg = '';
  await PZ.parseZip(ab(basicBytes.slice(0, basicBytes.length - 25)))
    .then(() => { truncMsg = 'resolved'; }, e => { truncMsg = e.message; });
  check('截断 zip reject', /zip/i.test(truncMsg), truncMsg);

  // 手工把 method 改成 99：解析应保留条目，getBlob 明确拒绝
  const methodZip = await zipBytes({ idle: { blob: new Blob([IDLE]), ext: '.webm' } }, null);
  const methodEntry = findEntry(methodZip, 'idle.webm');
  const mDv = dvOf(methodZip);
  mDv.setUint16(methodEntry.methodOff, 99, true);
  mDv.setUint16(methodEntry.localOff + 8, 99, true);
  const parsed99 = await PZ.parseZip(ab(methodZip));
  eq('未知 method 保留在条目上', parsed99.entries[0].method, 99);
  let methodErr = '';
  await parsed99.entries[0].getBlob()
    .then(() => { methodErr = 'resolved'; }, e => { methodErr = e.message; });
  check('未知 method 的 getBlob 明确报错', /不支持/.test(methodErr), methodErr);

  console.log('\n=== D. parseZip：DEFLATE ===');
  if (typeof DecompressionStream === 'function') {
    const deflated = await PZ.parseZip(ab(deflateBytes));
    const dIdle = deflated.entries.filter(e => e.name === 'MyChar/idle.webm')[0];
    const got = await bytesOf(await dIdle.getBlob());
    check('DEFLATE 解压字节一致', equalBytes(got, repeatBytes(IDLE, 40)),
      got.length + ' vs ' + IDLE.length * 40);
    eq('压缩体积确实小于原体积', dIdle.compSize < dIdle.size, true);

    // 临时抽掉 DecompressionStream，验证错误文案
    const saved = sandbox.DecompressionStream;
    delete sandbox.DecompressionStream;
    let noDsMsg = '';
    await dIdle.getBlob().then(() => { noDsMsg = 'resolved'; }, e => { noDsMsg = e.message; });
    check('无 DecompressionStream 时提示用 char_pack.py 重打包',
      /deflate|char_pack/i.test(noDsMsg), noDsMsg);
    sandbox.DecompressionStream = saved;
  } else {
    console.log('  （跳过：当前 Node 没有 DecompressionStream）');
  }

  console.log('\n=== E. packFromZip ===');
  const basic = await PZ.packFromZip(ab(basicBytes), { zipName: 'basic-stored.zip' });
  check('basic-stored 导入成功', basic.ok === true, basic.message);
  eq('只收 idle/studying', Object.keys(basic.pack.files).sort(), ['idle', 'studying']);
  eq('manifest 名优先', basic.pack.name, '测试角色');
  eq('manifest 作者/版本', [basic.pack.author, basic.pack.version], ['测试作者', '2.0']);
  check('重复状态有警告且 first wins',
    basic.warnings.some(w => /重复状态 idle/.test(w)),
    JSON.stringify(basic.warnings));
  check('first wins 的是第一个 idle',
    equalBytes(await bytesOf(basic.pack.files.idle.blob), IDLE));

  const noManifest = await zipBytes(
    { idle: { blob: new Blob([IDLE]), ext: '.webm' } }, null);
  const noMan = await PZ.packFromZip(ab(noManifest), { zipName: '我的角色.zip' });
  check('无 manifest 时回退 zip 文件名', noMan.ok && noMan.pack.name === '我的角色',
    noMan.pack && noMan.pack.name);

  // 把 manifest.json 的数据改成非法 JSON（长度不变，避免破坏 zip 结构）
  const badManifestZip = new Uint8Array(basicBytes);
  const mRange = localDataRange(badManifestZip, 'MyChar/manifest.json');
  badManifestZip.fill(0x20, mRange.start, mRange.start + mRange.size);
  badManifestZip.set(Buffer.from('{oops'), mRange.start);
  const badMan = await PZ.packFromZip(ab(badManifestZip), { zipName: '坏清单.zip' });
  check('manifest 非法 JSON：警告并回退 zip 名',
    badMan.ok && badMan.pack.name === '坏清单' &&
      badMan.warnings.some(w => /manifest\.json/.test(w)),
    (badMan.pack && badMan.pack.name) + ' / ' + JSON.stringify(badMan.warnings));

  const emptyZip = await zipBytes({}, null);
  const empty = await PZ.packFromZip(ab(emptyZip), { zipName: '空.zip' });
  check('空包 / 全垃圾：拒收且说明原因',
    empty.ok === false && /没有找到/.test(empty.message), empty.message);

  const bigFile = await zipBytes(
    { idle: { blob: new Blob([new Uint8Array(100)]), ext: '.webm' } }, null);
  const capped = await PZ.packFromZip(ab(bigFile), { zipName: '大.zip', maxFileBytes: 10 });
  check('单文件超限：跳过并警告，最终无可用状态',
    capped.ok === false && capped.warnings.some(w => /过大/.test(w)),
    JSON.stringify(capped.warnings));

  const totalFiles = await zipBytes({
    idle: { blob: new Blob([new Uint8Array(6)]), ext: '.webm' },
    studying: { blob: new Blob([new Uint8Array(6)]), ext: '.webm' }
  }, null);
  const totalCap = await PZ.packFromZip(ab(totalFiles), {
    zipName: '总上限.zip', maxFileBytes: 100, maxTotalBytes: 10
  });
  check('总大小超限：后续文件跳过并警告',
    totalCap.ok === true && !totalCap.pack.files.studying &&
      totalCap.warnings.some(w => /总大小上限/.test(w)),
    JSON.stringify(totalCap.warnings) + ' files=' + Object.keys(totalCap.pack.files));

  const noIdleZip = await zipBytes(
    { studying: { blob: new Blob([STUDY]), ext: '.webm' } }, null);
  const noIdle = await PZ.packFromZip(ab(noIdleZip), { zipName: '缺idle.zip' });
  check('缺 idle 仍导入成功，只给警告',
    noIdle.ok === true && noIdle.warnings.some(w => /idle/.test(w)),
    JSON.stringify(noIdle.warnings));

  // 加密位：置 central + local flags bit0
  const encZip = await zipBytes(
    { idle: { blob: new Blob([IDLE]), ext: '.webm' } }, null);
  const encEntry = findEntry(encZip, 'idle.webm');
  const eDv = dvOf(encZip);
  eDv.setUint16(encEntry.flagsOff, eDv.getUint16(encEntry.flagsOff, true) | 1, true);
  eDv.setUint16(encEntry.localOff + 6, eDv.getUint16(encEntry.localOff + 6, true) | 1, true);
  const enc = await PZ.packFromZip(ab(encZip), { zipName: '加密.zip' });
  check('加密条目：跳过并警告',
    enc.ok === false && enc.warnings.some(w => /加密/.test(w)),
    JSON.stringify(enc.warnings));

  // 非法 method：packFromZip 里应跳过并警告
  const badMethodZip = await zipBytes(
    { idle: { blob: new Blob([IDLE]), ext: '.webm' } }, null);
  const bmEntry = findEntry(badMethodZip, 'idle.webm');
  const bmDv = dvOf(badMethodZip);
  bmDv.setUint16(bmEntry.methodOff, 99, true);
  bmDv.setUint16(bmEntry.localOff + 8, 99, true);
  const badMethod = await PZ.packFromZip(ab(badMethodZip), { zipName: '坏method.zip' });
  check('非法压缩方式：读取失败 + 警告',
    badMethod.ok === false && badMethod.warnings.some(w => /不支持/.test(w)),
    JSON.stringify(badMethod.warnings));

  console.log('\n=== F. buildZip 回环 ===');
  const buildFiles = {
    idle: { blob: new Blob([IDLE]), ext: '.webm' },
    studying: { blob: new Blob([STUDY]), ext: '.mp4' }
  };
  const manifest = {
    name: '中文角色', author: '某人', version: '1.2', note: '说明', created: '2026-10-17'
  };
  const built = await zipBytes(buildFiles, manifest);
  const back = await PZ.parseZip(ab(built));
  eq('条目顺序：manifest 最先', back.entries.map(e => e.name),
    ['manifest.json', 'idle.webm', 'studying.mp4']);
  check('全部 STORED', back.entries.every(e => e.method === 0));
  check('条目带 UTF-8 文件名 flag', back.entries.every(e => (e.flags & 0x800) !== 0));
  eq('idle CRC 与 crc32 一致', back.entries[1].crc32, PZ.crc32(IDLE));
  check('idle 字节回环一致', equalBytes(await bytesOf(await back.entries[1].getBlob()), IDLE));
  const manifestText = await (await back.entries[0].getBlob()).text();
  eq('中文 manifest 往返无损', JSON.parse(manifestText), manifest);

  const loop = await PZ.packFromZip(ab(built), { zipName: '忽略.zip' });
  check('buildZip -> packFromZip 名字/扩展名正确',
    loop.ok && loop.pack.name === '中文角色' &&
      loop.pack.files.studying.ext === '.mp4',
    loop.ok ? loop.pack.name : loop.message);

  console.log('\n=== G. PackStore（内存假 IndexedDB） ===');
  const blobA = new Blob([IDLE]);
  const packA = {
    id: 'p_a', name: 'A', createdAt: 100, totalBytes: 10,
    files: { idle: { blob: blobA, ext: '.webm', size: 10 } }
  };
  const packB = { id: 'p_b', name: 'B', createdAt: 300, files: {} };
  const packC = { id: 'p_c', name: 'C', createdAt: 200, files: {} };
  const putA = await PS.put(packA);
  await PS.put(packB);
  await PS.put(packC);
  check('put 返回 pack', putA === packA);
  const gotA = await PS.get('p_a');
  check('get 一致且 Blob 保留', gotA === packA && gotA.files.idle.blob === blobA);
  eq('get 不存在 -> null', await PS.get('nope'), null);
  eq('getAll 按 createdAt 降序', (await PS.getAll()).map(p => p.id), ['p_b', 'p_c', 'p_a']);
  eq('totalBytes 汇总 files', PS.totalBytes(packA), 10);
  await PS.remove('p_c');
  eq('remove 后 get -> null', await PS.get('p_c'), null);

  sandbox.indexedDB.quota = true;
  let quotaName = '';
  await PS.put({ id: 'q', files: {} }).then(
    () => { quotaName = 'resolved'; },
    e => { quotaName = e && e.name; });
  sandbox.indexedDB.quota = false;
  check('QuotaExceededError 原样 reject', quotaName === 'QuotaExceededError', quotaName);

  console.log('\n=== H. Animation.setCharacter ===');
  const svgBox = { hidden: false };
  const mainVideo = new FakeVideo();
  const stage = {
    dataset: {},
    innerHTML: '',
    parentNode: null,
    querySelector: function (sel) {
      if (sel === '.pet-video') return mainVideo;
      if (sel === '.pet-svg') return svgBox;
      return null;
    }
  };
  A.init(stage);
  A.ext = '.webm';
  A.forced = false;

  function bfile(bytes) { return { blob: new Blob([bytes]), ext: '.webm' }; }
  function mkPack(id, files) { return { id: id, name: '形象-' + id, files: files }; }

  A.setCharacter(mkPack('p1', { idle: bfile([1, 2, 3]), studying: bfile([4, 5]) }));
  check('包内 idle：进入视频模式', A.mode === 'video' && stage.dataset.mode === 'video');
  check('包内 idle：视频显示、SVG 隐藏', mainVideo.hidden === false && svgBox.hidden === true);
  const p1Idle = A._packUrls.idle;
  const p1Study = A._packUrls.studying;
  check('setCharacter 立即播放包内 idle',
    mainVideo.getAttribute('src') === p1Idle, mainVideo.getAttribute('src'));
  A.play('studying');
  check('studying 用包内 blob', mainVideo.getAttribute('src') === p1Study);
  A.play('talking');
  check('缺 talking 时回包内 idle', mainVideo.getAttribute('src') === p1Idle);

  const revokedBefore = urlRevoked.length;
  A.setCharacter(null);
  check('切回默认：旧 URL 只进 stale 不立即 revoke',
    A._staleUrls.indexOf(p1Idle) >= 0 && A._staleUrls.indexOf(p1Study) >= 0 &&
      urlRevoked.length === revokedBefore,
    urlRevoked.length + ' vs ' + revokedBefore);
  check('切回默认：播放磁盘对应状态',
    mainVideo.getAttribute('src') === 'videos/talking.webm',
    mainVideo.getAttribute('src'));

  A.setCharacter(mkPack('p2', { idle: bfile([9]) }));
  check('下一次切换才撤销上一批 URL',
    urlRevoked.indexOf(p1Idle) >= 0 && urlRevoked.indexOf(p1Study) >= 0);

  // talking 计时中切换：只换 src，不打断计时
  const tempPromise = A.playTemp('talking', 90000, { loop: true });
  const tempTimer = A._tempTimer;
  const tempResolve = A._tempResolve;
  A.setCharacter(mkPack('p3', { idle: bfile([7]) }));
  check('临时态播放中切换：计时器未重置',
    A._tempTimer === tempTimer && A._tempResolve === tempResolve);
  check('临时态播放中切换：src 已换成新包 idle',
    mainVideo.getAttribute('src') === A._packUrls.idle);
  A.cancelTemp();
  await tempPromise;

  // 包内 blob 播不了：退回磁盘 idle
  A.setCharacter(mkPack('p4', { idle: bfile([8]) }));
  const p4Idle = A._packUrls.idle;
  A.onVideoError();
  check('包素材错误：退出包并落磁盘 idle',
    A.pack === null && mainVideo.getAttribute('src') === 'videos/idle.webm',
    mainVideo.getAttribute('src'));
  check('包素材错误：坏 URL 已撤销', urlRevoked.indexOf(p4Idle) >= 0);

  // 缺 idle 但 ext 已知
  A.ext = '.webm';
  A.setCharacter(mkPack('p5', { studying: bfile([6]) }));
  check('缺 idle 但 ext 已知：仍进视频模式', A.mode === 'video');
  A.play('idle');
  check('缺 idle：idle 状态落磁盘素材',
    mainVideo.getAttribute('src') === 'videos/idle.webm',
    mainVideo.getAttribute('src'));

  // 缺 idle 且 ext 未知
  A.ext = null;
  A.mode = 'svg';
  A.video.hidden = true;
  A.setCharacter(mkPack('p6', { studying: bfile([5]) }));
  check('缺 idle 且 ext 未知：不进视频模式', A.mode === 'svg');
  A._probeStop();

  // 回默认但 ext 还没探测：先探测，不能拼出 videos/idlenull
  A.mode = 'video';
  A.video.hidden = false;
  A.ext = null;
  mainVideo.setAttribute('src', 'videos/stale.webm');
  A.setCharacter(null);
  check('ext 未知回默认：不写非法 src 且启动探测',
    mainVideo.getAttribute('src') === 'videos/stale.webm' && !!A._probeEl,
    mainVideo.getAttribute('src'));
  if (A._probeEl && A._probeEl._listeners.loadedmetadata) {
    A._probeEl._listeners.loadedmetadata[0]();
  }
  check('探测成功后按磁盘地址重播（已在视频模式也要换源）',
    A.ext === '.webm' && mainVideo.getAttribute('src') === 'videos/idle.webm',
    A.ext + ' / ' + mainVideo.getAttribute('src'));

  // forced (?novideo=1)
  A.forced = true;
  A.mode = 'svg';
  A.ext = '.webm';
  A.setCharacter(mkPack('p7', { idle: bfile([4]) }));
  check('forced 时切包也不进视频模式', A.mode === 'svg');
  A.forced = false;

  // 内置形象（videos/ 目录，相对路径而不是 blob）
  check('内置登记表：zhenzhu 为默认形象',
    App.Builtin.defaultEntry().id === 'zhenzhu');
  const builtinPack = App.Builtin.toPack(App.Builtin.byId('zhenzhu'));
  check('内置 pack：7 个状态且是相对路径',
    Object.keys(builtinPack.files).length === 7 && builtinPack.builtin === true &&
      builtinPack.files.idle.url === 'videos/zhenzhu/idle.webm',
    builtinPack.files.idle.url);

  const createdBefore = urlCreated.length;
  A.ext = '.webm';
  A.setCharacter(builtinPack);
  check('内置形象：进入视频模式并播放目录素材',
    A.mode === 'video' && mainVideo.getAttribute('src') === 'videos/zhenzhu/idle.webm',
    mainVideo.getAttribute('src'));
  check('内置形象：不创建 blob URL', urlCreated.length === createdBefore);
  A.setCharacter(null);
  A.setCharacter(mkPack('p8', { idle: bfile([1]) }));
  check('内置形象切走：普通路径不会被 revokeObjectURL',
    urlRevoked.every(u => u.indexOf('blob:') === 0),
    urlRevoked.filter(u => u.indexOf('blob:') !== 0).join(','));

  A.destroy();

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  console.log('\n--- 结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败 ---\n');
  process.exit(1);
});
