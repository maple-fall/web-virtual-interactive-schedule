/*
 * 无头测试：pip.js —— 开窗尺寸钳位 + 舞台搬进/搬回画中画窗口的全流程
 * 运行： node tests/test-pip.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');

/* ---------------- 极简 DOM ---------------- */

function El(tag, doc) {
  this.tagName = String(tag).toUpperCase();
  this.ownerDocument = doc;
  this.children = [];
  this.parentNode = null;
  this.style = {};
  this.dataset = {};
  this.className = '';
  this.textContent = '';
  this.hidden = false;
  this._listeners = {};
  this._rect = null;
}
El.prototype.appendChild = function (n) { return this.insertBefore(n, null); };
El.prototype.insertBefore = function (n, ref) {
  if (n.parentNode) n.parentNode.removeChild(n);            // 换父节点时先脱离（同真实 DOM）
  const i = ref ? this.children.indexOf(ref) : this.children.length;
  if (ref && i < 0) throw new Error('insertBefore: 参照节点不是子节点');
  this.children.splice(i, 0, n);
  n.parentNode = this;
  return n;
};
El.prototype.removeChild = function (n) {
  const i = this.children.indexOf(n);
  if (i < 0) throw new Error('removeChild: 不是子节点');
  this.children.splice(i, 1);
  n.parentNode = null;
  return n;
};
El.prototype.querySelector = function (sel) {
  const want = sel.charAt(0) === '.' ? 'className' : 'tagName';
  const val = sel.charAt(0) === '.' ? sel.slice(1) : sel.toUpperCase();
  for (const c of this.children) {
    if (c[want] === val) return c;
    const deep = c.querySelector(sel);
    if (deep) return deep;
  }
  return null;
};
El.prototype.querySelectorAll = function () { return []; };
El.prototype.addEventListener = function (t, fn) {
  (this._listeners[t] || (this._listeners[t] = [])).push(fn);
};
El.prototype.fire = function (t) {
  (this._listeners[t] || []).forEach(fn => fn({ type: t }));
};
El.prototype.getBoundingClientRect = function () {
  return this._rect || { width: 0, height: 0 };
};

function makeDoc(baseURI) {
  const doc = {
    head: null, body: null, baseURI: baseURI, _byId: {},
    createElement: t => new El(t, doc),
    getElementById: id => doc._byId[id] || null,
    querySelector: sel => doc.body.querySelector(sel),
    querySelectorAll: () => []
  };
  doc.head = new El('head', doc);
  doc.body = new El('body', doc);
  return doc;
}

function makePipWin() {
  const win = {
    document: makeDoc('about:blank'), closed: false, _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); },
    fire(t) { (this._listeners[t] || []).forEach(fn => fn({ type: t })); },
    close() { this.closed = true; this.fire('pagehide'); }
  };
  return win;
}

/* ---------------- 沙箱 ---------------- */

const requested = [];
let nextWin = null;
let rejectNext = false;
let plays = 0;
const bubbles = [];

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.JSON = JSON;
sandbox.Math = Math;
sandbox.Object = Object;
sandbox.Array = Array;
sandbox.document = makeDoc('file:///D:/AIcompete/desktop-pet/index.html');
sandbox.documentPictureInPicture = {
  requestWindow(size) {
    requested.push(size);
    return rejectNext ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(nextWin);
  }
};
sandbox.window.App = {};

vm.createContext(sandbox);
const load = rel => vm.runInContext(
  fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });

load('pip.js');

const App = sandbox.App;
sandbox.App.Animation = {
  stage: null,
  mode: 'video',
  isVideoMode: () => true,
  video: { hidden: false, play() { plays++; return { catch() {} }; } }
};
sandbox.App.Bubble = { say(text) { bubbles.push(text); } };

/* ---------------- 断言 ---------------- */

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) + ' vs ' + JSON.stringify(want));
const tick = () => new Promise(r => setImmediate(r));

/* ---------------- 场景 ---------------- */

const doc = sandbox.document;
const pane = new El('div', doc);
pane.className = 'character-pane';
const wrap = new El('div', doc);
wrap.className = 'stage-wrap';
pane.appendChild(wrap);
doc.body.appendChild(pane);
const btn = new El('button', doc);
btn.id = 'btn-pip';
btn.hidden = true;
doc._byId['btn-pip'] = btn;

function resetScene() {
  if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  pane.children.length = 0;
  wrap.parentNode = null;
  pane.appendChild(wrap);
  btn.textContent = '';
  btn.hidden = true;
  requested.length = 0;
  plays = 0;
  bubbles.length = 0;
  nextWin = null;
  rejectNext = false;
  App.Pip.win = null;
  App.Pip._wrap = null;
  App.Pip._slot = null;
  App.Pip._opening = false;
}

(async function run() {
  console.log('\n=== 能力检测 / 按钮显隐 ===');
  check('有 documentPictureInPicture 时 supported() 为 true', App.Pip.supported() === true);

  App.Pip.init();
  check('支持时按钮解除 hidden', btn.hidden === false, btn.hidden);

  const saved = sandbox.documentPictureInPicture;
  delete sandbox.documentPictureInPicture;
  check('没有 API 时 supported() 为 false', App.Pip.supported() === false);
  btn.hidden = true;
  App.Pip.init();
  check('不支持时按钮保持隐藏', btn.hidden === true);
  sandbox.documentPictureInPicture = saved;

  console.log('\n=== _sizeFor：按舞台比例开窗并钳位 ===');
  wrap._rect = { width: 688, height: 560 };
  eq('常规舞台：宽度钳到 460，高度按比例', App.Pip._sizeFor(wrap), { width: 460, height: 374 });

  wrap._rect = { width: 2000, height: 400 };
  eq('超宽舞台：高度顶到下限 280', App.Pip._sizeFor(wrap), { width: 460, height: 280 });

  wrap._rect = { width: 300, height: 900 };
  eq('超竖舞台：高度顶到上限 620', App.Pip._sizeFor(wrap), { width: 300, height: 620 });

  wrap._rect = { width: 100, height: 100 };
  eq('过小舞台：双向都顶到下限', App.Pip._sizeFor(wrap), { width: 240, height: 280 });

  wrap._rect = null;
  eq('量不到尺寸时用兜底值，不出 NaN', App.Pip._sizeFor(wrap), { width: 360, height: 480 });

  console.log('\n=== 打开：舞台搬进画中画 ===');
  resetScene();
  nextWin = makePipWin();
  wrap._rect = { width: 688, height: 560 };
  App.Pip.open();
  await tick();
  await tick();

  eq('requestWindow 收到钳位后的尺寸', requested, [{ width: 460, height: 374 }]);
  check('舞台已移到画中画文档', wrap.parentNode === nextWin.document.body);
  check('舞台已不在主文档的 pane 里', pane.children.indexOf(wrap) < 0);
  check('原位置留了占位', pane.children.length === 1 &&
    pane.children[0].className === 'stage-slot', pane.children.map(c => c.className).join(','));
  check('active() 为 true', App.Pip.active() === true);
  check('按钮文案变为「关闭画中画」', btn.textContent === '关闭画中画', btn.textContent);
  check('搬过去后重新起播视频', plays === 1, plays);
  check('画中画文档注入了 base', nextWin.document.head.children.some(n => n.tagName === 'BASE'));
  const styleNode = nextWin.document.head.children.find(n => n.tagName === 'STYLE');
  check('画中画文档注入了兜底样式（舞台铺满窗口）',
    !!styleNode && styleNode.textContent.indexOf('.stage { width: 100%') >= 0);

  console.log('\n=== 重复点击 ===');
  App.Pip.open();
  await tick();
  check('已在画中画时再点不会重复开窗', requested.length === 1, requested.length);

  console.log('\n=== 关闭：舞台搬回主文档 ===');
  App.Pip.close();
  check('窗口被关掉', nextWin.closed === true);
  check('舞台回到原来的父节点', wrap.parentNode === pane);
  check('回到原位置且占位已移除',
    pane.children.length === 1 && pane.children[0] === wrap,
    pane.children.map(c => c.className).join(','));
  check('active() 变回 false', App.Pip.active() === false);
  check('按钮文案复原', btn.textContent === '画中画', btn.textContent);
  check('搬回后重新起播视频', plays === 2, plays);

  console.log('\n=== 用户直接关掉画中画窗口（pagehide） ===');
  resetScene();
  nextWin = makePipWin();
  App.Pip.open();
  await tick();
  await tick();
  check('已搬进画中画', wrap.parentNode === nextWin.document.body);
  nextWin.fire('pagehide');
  check('pagehide 后舞台自动搬回', wrap.parentNode === pane);
  check('pagehide 后占位已清理',
    pane.children.length === 1 && pane.children[0] === wrap);
  check('pagehide 后按钮文案复原', btn.textContent === '画中画', btn.textContent);

  console.log('\n=== 幂等 / 异常路径 ===');
  App.Pip._detach();
  check('重复 _detach 不抛错也不破坏布局',
    pane.children.length === 1 && pane.children[0] === wrap);

  resetScene();
  rejectNext = true;
  App.Pip.open();
  await tick();
  await tick();
  check('开窗被拒时不搬舞台', wrap.parentNode === pane);
  check('开窗被拒时给出气泡提示', bubbles.length === 1, JSON.stringify(bubbles));
  check('开窗被拒后仍可再次尝试', App.Pip._opening === false);

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
})();
