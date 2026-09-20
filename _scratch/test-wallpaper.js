/*
 * 无头测试：验证 settings.js 的界面壁纸逻辑
 * 运行： node _scratch/test-wallpaper.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');

// ---- 极简 DOM stub ----
function el(tag) {
  const e = {
    tagName: tag, style: {}, dataset: {}, children: [], hidden: false,
    textContent: '', title: '', type: '', className: '', value: '', _listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; },
    querySelectorAll(sel) {
      // '[data-path]' -> dataset.path（浏览器把 data-* 属性映射为去前缀的驼峰属性）
      let want = sel.replace(/[[\]]/g, '').split('=')[0];
      if (want.indexOf('data-') === 0) {
        want = want.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      }
      const out = [];
      const walk = n => { (n.children || []).forEach(k => { if (k.dataset && k.dataset[want] !== undefined) out.push(k); walk(k); }); };
      walk(this);
      return out;
    },
    contains(n) { if (n === this) return true; return (this.children || []).some(k => k.contains && k.contains(n)); },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    click() { this._clicks = (this._clicks || 0) + 1; this.fire('click'); },
    // 模拟事件冒泡：先在自身触发，再逐级向父节点传播（target 始终是起始元素）
    fire(t, ev) {
      const target = this;
      for (let n = this; n; n = n.parentNode) {
        (n._listeners[t] || []).forEach(fn => fn(Object.assign({ target }, ev)));
      }
    }
  };
  return e;
}

// canvas 需要额外的 2d 上下文与导出接口
// canvas 是在 img.onload 内部才创建的，要定制它的导出结果得提前挂到 nextCanvasDataUrl 上
let nextCanvasDataUrl = null;
const canvases = [];
function canvasEl() {
  const c = el('canvas');
  c.width = 0;
  c.height = 0;
  c._fillRects = [];
  c._draws = [];
  c._toDataURL = [];
  c._dataUrl = nextCanvasDataUrl || 'data:image/jpeg;base64,AAAA';
  nextCanvasDataUrl = null;
  c.getContext = () => ({
    fillStyle: '',
    fillRect(x, y, w, h) { c._fillRects.push([x, y, w, h]); },
    drawImage(...a) { c._draws.push(a.length); }
  });
  c.toDataURL = (mime, q) => { c._toDataURL.push([mime, q]); return c._dataUrl; };
  canvases.push(c);
  return c;
}
const lastCanvas = () => canvases[canvases.length - 1];

// FileReader / Image：只记录实例，回调由测试手动触发，便于精确控制异步时序
const readers = [];
function FakeFileReader() { this.result = null; this.onload = null; this.onerror = null; readers.push(this); }
FakeFileReader.prototype.readAsDataURL = function (f) { this._file = f; };

const images = [];
function FakeImage() { this.naturalWidth = 0; this.naturalHeight = 0; this.onload = null; this.onerror = null; images.push(this); }
const lastImage = () => images[images.length - 1];

const els = {
  stage: el('div'), 'btn-bg-clear': el('button'), 'bg-picker': el('div'), 'btn-bg': el('button'),
  body: el('body'), 'btn-wallpaper': el('button'), 'btn-wallpaper-clear': el('button'),
  'wallpaper-picker': el('div'), 'file-wallpaper': el('input')
};
els['bg-picker'].hidden = true;
els['wallpaper-picker'].hidden = true;
const store = {};
let quotaFull = false;

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.JSON = JSON;
sandbox.Object = Object;
sandbox.Array = Array;
sandbox.String = String;
sandbox.Number = Number;
sandbox.Math = Math;
sandbox.Date = Date;
sandbox.URLSearchParams = URLSearchParams;
sandbox.location = { search: '' };
sandbox.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { if (quotaFull) throw new DOMException_Quota(); store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
function DOMException_Quota() { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; return e; }
sandbox.FileReader = FakeFileReader;
sandbox.Image = FakeImage;
sandbox.document = {
  readyState: 'loading',
  addEventListener: () => {},
  getElementById: id => els[id] || null,
  createElement: t => (t === 'canvas' ? canvasEl() : el(t)),
  createDocumentFragment: () => el('#fragment'),
  body: els.body
};
sandbox.window.App = {};

vm.createContext(sandbox);
const load = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });

load('app.js');
load('settings.js');

const App = sandbox.App;

// 记录用户可见反馈
const msgs = [];
App.Output = { error: m => msgs.push('error:' + m), system: m => msgs.push('system:' + m), pet: () => {} };
App.Bubble = { say: m => msgs.push('bubble:' + m) };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const S = App.Settings;
const PRESET = 'data/backgrounds/bg1.jpg';
const WALL = 'data/wallpapers/wall1.jpg';
const KEY = App.Config.settingsKey;
const body = els.body;

// 面板里的缩略图（fragment 是 picker 唯一子节点）
const pickerItems = () => (els['wallpaper-picker'].children[0] || { children: [] }).children;
const selectedThumbs = () => els['wallpaper-picker'].querySelectorAll('[data-path]')
  .filter(b => b.classList.contains('selected'));
// 自定义缩略图是没有 data-path 的 span
const customThumb = () => pickerItems().find(n => n.tagName === 'span' && n.className.indexOf('bg-thumb') >= 0);

// 走一遍完整导入：造 File → fire change → 手动触发 reader/img 回调
function importImage({ type = 'image/png', size = 1000, w = 640, h = 480, dataUrl } = {}) {
  const file = { type, size };
  const before = readers.length;
  els['file-wallpaper'].files = [file];
  els['file-wallpaper'].fire('change');
  const reader = readers[readers.length - 1];
  if (readers.length === before) return null;      // 被前置校验拦下，没进读取阶段
  reader.result = 'data:image/png;base64,iVBORw0KGgo=';
  reader.onload();
  const img = lastImage();
  img.naturalWidth = w;
  img.naturalHeight = h;
  if (dataUrl) nextCanvasDataUrl = dataUrl;
  img.onload();
  return img;
}

console.log('\n=== 用例 1：初始无设置 ===');
S.init();
check('body 无 has-wallpaper', !body.classList.contains('has-wallpaper'));
check('5 个背景长属性为空',
  body.style.backgroundImage === '' && body.style.backgroundSize === '' &&
  body.style.backgroundPosition === '' && body.style.backgroundRepeat === '' &&
  body.style.backgroundAttachment === '',
  JSON.stringify(body.style));
check('清除壁纸按钮隐藏', els['btn-wallpaper-clear'].hidden === true);
check('面板结构（提示 + 无 + 1 预设 + 导入按钮）', pickerItems().length === 4,
  String(pickerItems().length));
check('导入按钮带 data-action', pickerItems()[3].dataset.action === 'import');
// 壁纸预设只能来自 data/wallpapers/，混进舞台背景（data/backgrounds/）会让用户分不清两者
check('壁纸预设不含舞台背景图',
  !pickerItems().some(it => String(it.dataset.path || '').indexOf('data/backgrounds/') === 0),
  pickerItems().map(it => it.dataset.path));
check('无自定义缩略图', customThumb() === undefined);

console.log('\n=== 用例 2：选择预设壁纸 ===');
msgs.length = 0;
S.selectWallpaper(WALL);
const bgImg = body.style.backgroundImage;
check('加了 has-wallpaper class', body.classList.contains('has-wallpaper'));
check('inline 背景含压暗层 + 图片',
  bgImg.indexOf('linear-gradient') === 0 && bgImg.indexOf('url("' + WALL + '")') > 0, bgImg);
check('cover / center / no-repeat / fixed',
  body.style.backgroundSize === 'cover' && body.style.backgroundPosition === 'center' &&
  body.style.backgroundRepeat === 'no-repeat' && body.style.backgroundAttachment === 'fixed',
  [body.style.backgroundSize, body.style.backgroundPosition, body.style.backgroundRepeat, body.style.backgroundAttachment].join(' | '));
check('写入 settingsKey（含 wallpaper）',
  store[KEY] === JSON.stringify({ bg: null, wallpaper: WALL }), store[KEY]);
check('清除按钮显示', els['btn-wallpaper-clear'].hidden === false);
check('选中项高亮落在该预设', selectedThumbs().length === 1 && selectedThumbs()[0].dataset.path === WALL,
  String(selectedThumbs().length));
check('给出用户反馈',
  msgs.some(m => m.startsWith('system:')) && msgs.some(m => m.startsWith('bubble:')), JSON.stringify(msgs));
check('未污染日程 key', store['desktop_pet_v2'] === undefined);

console.log('\n=== 用例 3：刷新后恢复 ===');
body.style.backgroundImage = '';
body.classList.remove('has-wallpaper');
S.init();
check('壁纸被恢复', body.style.backgroundImage.indexOf('url("' + WALL + '")') > 0, body.style.backgroundImage);
check('class 恢复', body.classList.contains('has-wallpaper'));
check('选中项恢复', selectedThumbs().length === 1 && selectedThumbs()[0].dataset.path === WALL);

console.log('\n=== 用例 4：与舞台背景互不覆盖 ===');
S.select(PRESET);
check('选舞台背景不动 wallpaper',
  store[KEY] === JSON.stringify({ bg: PRESET, wallpaper: WALL }), store[KEY]);
S.selectWallpaper(PRESET);
// 舞台背景图不在壁纸白名单里，设置应被弹回，且不影响已有的 bg
check('把舞台背景图当壁纸设置 → 拒绝',
  store[KEY] === JSON.stringify({ bg: PRESET, wallpaper: WALL }), store[KEY]);
S.clearBg();
check('清舞台背景后壁纸还在',
  store[KEY] === JSON.stringify({ bg: null, wallpaper: WALL }), store[KEY]);
check('壁纸仍在 body 上', body.classList.contains('has-wallpaper'));
S.clearWallpaper();
check('清壁纸后写入 null', store[KEY] === JSON.stringify({ bg: null, wallpaper: null }), store[KEY]);

console.log('\n=== 用例 5：清除壁纸 ===');
check('class 移除', !body.classList.contains('has-wallpaper'));
check('5 个长属性清空',
  body.style.backgroundImage === '' && body.style.backgroundSize === '' &&
  body.style.backgroundPosition === '' && body.style.backgroundRepeat === '' &&
  body.style.backgroundAttachment === '', JSON.stringify(body.style));
check('清除按钮隐藏', els['btn-wallpaper-clear'].hidden === true);
const sel5 = selectedThumbs();
check('高亮落在「无」选项上', sel5.length === 1 && sel5[0].dataset.path === '',
  JSON.stringify(sel5.map(b => b.dataset.path)));

console.log('\n=== 用例 6：非法值被拒绝 ===');
msgs.length = 0;
S.selectWallpaper('data/wallpapers/../../evil.jpg');
check('非白名单路径未写入', store[KEY] === JSON.stringify({ bg: null, wallpaper: null }), store[KEY]);
check('未给出误导性反馈', msgs.length === 0, JSON.stringify(msgs));

console.log('\n=== 用例 7：损坏 / 不可信存储兜底 ===');
const badValues = [
  ['svg data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
  ['非白名单路径', 'data/wallpapers/wall9.jpg'],
  ['数字', 12345],
  ['超长 data URL', 'data:image/jpeg;base64,' + 'A'.repeat(7 * 1024 * 1024)]
];
badValues.forEach(([label, v]) => {
  store[KEY] = JSON.stringify({ bg: null, wallpaper: v });
  S.init();
  check(label + ' → 归一为无壁纸',
    S.wallpaper === null && !body.classList.contains('has-wallpaper'), String(S.wallpaper).slice(0, 40));
});

console.log('\n=== 用例 8：导入本地图片（成功链路）===');
store[KEY] = JSON.stringify({ bg: null, wallpaper: null });
S.init();
canvases.length = 0;
msgs.length = 0;
els['file-wallpaper'].value = 'C:\\fakepath\\x.png';
importImage({ w: 4000, h: 3000 });
const c = lastCanvas();
check('canvas 等比缩到最长边 1920', c.width === 1920 && c.height === 1440, c.width + 'x' + c.height);
check('先铺底色再画图（透明 PNG 不产生黑底）',
  c._fillRects.length === 1 && c._draws.length === 1);
check('导出为 JPEG q0.8', c._toDataURL.length === 1 &&
  c._toDataURL[0][0] === 'image/jpeg' && c._toDataURL[0][1] === 0.8,
  JSON.stringify(c._toDataURL));
check('data URL 写入设置',
  store[KEY] === JSON.stringify({ bg: null, wallpaper: 'data:image/jpeg;base64,AAAA' }), store[KEY]);
check('body 立即生效', body.classList.contains('has-wallpaper') &&
  body.style.backgroundImage.indexOf('url("data:image/jpeg') > 0);
check('面板出现自定义缩略图并选中',
  customThumb() !== undefined && customThumb().className.indexOf('selected') >= 0,
  customThumb() && customThumb().className);
check('预设缩略图都不再选中', selectedThumbs().length === 0);
check('file input 已重置（同一张图可再次选择）', els['file-wallpaper'].value === '',
  JSON.stringify(els['file-wallpaper'].value));
check('给出成功反馈', msgs.some(m => m.indexOf('已压缩到最长边') > 0), JSON.stringify(msgs));

console.log('\n=== 用例 9：小图不放大 ===');
canvases.length = 0;
importImage({ w: 640, h: 480 });
check('canvas 保持原尺寸', lastCanvas().width === 640 && lastCanvas().height === 480,
  lastCanvas().width + 'x' + lastCanvas().height);

console.log('\n=== 用例 10：导入失败路径 ===');
const snap = store[KEY];
msgs.length = 0;
const n0 = readers.length;
importImage({ type: 'text/plain' });
check('非图片类型：不进读取阶段', readers.length === n0, String(readers.length - n0));
check('非图片类型：提示用户', msgs.some(m => m.startsWith('error:')), JSON.stringify(msgs));

msgs.length = 0;
const n1 = readers.length;
els['file-wallpaper'].files = [{ type: 'image/png', size: 50 * 1024 * 1024 }];
els['file-wallpaper'].fire('change');
check('超大文件：读取前拦下', readers.length === n1 && msgs.some(m => m.indexOf('太大') > 0),
  JSON.stringify(msgs));

msgs.length = 0;
const n2 = readers.length;
els['file-wallpaper'].files = [{ type: 'image/png', size: 1000 }];
els['file-wallpaper'].fire('change');
readers[readers.length - 1].onerror();
check('读取失败：提示用户', readers.length === n2 + 1 && msgs.some(m => m.indexOf('读取失败') > 0),
  JSON.stringify(msgs));

msgs.length = 0;
const n3 = images.length;
els['file-wallpaper'].files = [{ type: 'image/png', size: 1000 }];
els['file-wallpaper'].fire('change');
readers[readers.length - 1].result = 'data:image/png;base64,zzz';
readers[readers.length - 1].onload();
lastImage().onerror();
check('解码失败：提示用户', images.length === n3 + 1 && msgs.some(m => m.indexOf('解码失败') > 0),
  JSON.stringify(msgs));
check('失败后设置与 body 均未变',
  store[KEY] === snap && body.style.backgroundImage.indexOf('data:image/jpeg') > 0);

msgs.length = 0;
canvases.length = 0;
importImage({ w: 4000, h: 3000, dataUrl: 'data:image/png;base64,NOTJPEG' });
check('导出结果不是 JPEG 时拒绝', msgs.some(m => m.indexOf('处理失败') > 0), JSON.stringify(msgs));

console.log('\n=== 用例 11：配额满 ===');
msgs.length = 0;
quotaFull = true;
const before11 = S.wallpaper;
canvases.length = 0;
importImage({ w: 800, h: 600 });
check('提示用户', msgs.some(m => m.startsWith('error:')) && msgs.some(m => m.startsWith('bubble:')),
  JSON.stringify(msgs));
check('内存状态未变更', S.wallpaper === before11);
quotaFull = false;

console.log('\n=== 用例 12：面板交互 ===');
store[KEY] = JSON.stringify({ bg: null, wallpaper: null });
S.init();
els['btn-wallpaper'].fire('click');
check('点击「界面壁纸」展开壁纸面板', els['wallpaper-picker'].hidden === false);
els['btn-bg'].fire('click');
check('展开舞台面板时壁纸面板收起',
  els['bg-picker'].hidden === false && els['wallpaper-picker'].hidden === true);
els['btn-wallpaper'].fire('click');
check('再切回壁纸面板时舞台面板收起',
  els['wallpaper-picker'].hidden === false && els['bg-picker'].hidden === true);
els['btn-wallpaper'].fire('click');
check('再点收起', els['wallpaper-picker'].hidden === true);

const importBtn = pickerItems().find(n => n.dataset.action === 'import');
const clicksBefore = els['file-wallpaper']._clicks || 0;
importBtn.fire('click');
check('点击「本地图片…」触发文件选择',
  (els['file-wallpaper']._clicks || 0) === clicksBefore + 1);

const wallThumb = els['wallpaper-picker'].querySelectorAll('[data-path]').filter(b => b.dataset.path === WALL)[0];
wallThumb.fire('click');
check('点击预设缩略图应用壁纸', S.wallpaper === WALL && body.classList.contains('has-wallpaper'));
const noneBtn = els['wallpaper-picker'].querySelectorAll('[data-path]').filter(b => b.dataset.path === '')[0];
noneBtn.fire('click');
check('点击「无」清除壁纸', S.wallpaper === null && !body.classList.contains('has-wallpaper'));
els['btn-wallpaper-clear'].fire('click');
check('清除按钮可用（无壁纸时再点不报错）', S.wallpaper === null);

console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
process.exit(fail ? 1 : 0);
