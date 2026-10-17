/*
 * 无头测试：pip.js —— 开窗尺寸钳位 + 舞台搬进/搬回画中画窗口 + 底部计划栏刷新
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
Object.defineProperty(El.prototype, 'firstChild', {
  get() { return this.children.length ? this.children[0] : null; }
});

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
const clearedTimers = [];
sandbox.setInterval = function (fn, ms) { return { fn: fn, ms: ms }; };
sandbox.clearInterval = function (t) { if (t) clearedTimers.push(t); };
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

/* 计划面板依赖的 App 桩：固定时钟 + 内存任务表 + 可手动触发的总线 */
let NOW = new Date(2026, 8, 19, 10, 0).getTime();
let planTasks = [];
const busListeners = {};
sandbox.App.Clock = {
  now: () => NOW,
  today: () => '2026-09-19'
};
function dayMs(s) { return new Date(s + 'T00:00:00').getTime(); }
function hmMin(s) { const p = s.split(':'); return +p[0] * 60 + +p[1]; }
sandbox.App.util = {
  addDaysStr(s, n) {
    const d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() + n);
    const p = x => (x < 10 ? '0' : '') + x;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },
  dayStartMs: dayMs,
  taskStartMs: t => dayMs(t.date) + hmMin(t.startTime) * 60000,
  taskEndMs: t => dayMs(t.date) + (hmMin(t.endTime) + (t.endOffset || 0) * 1440) * 60000
};
sandbox.App.Manager = { all: () => planTasks };
sandbox.App.bus = {
  on(evt, fn) { (busListeners[evt] || (busListeners[evt] = [])).push(fn); },
  off(evt, fn) {
    const l = busListeners[evt] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  },
  emit(evt, payload) { (busListeners[evt] || []).slice().forEach(fn => fn(payload)); }
};

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
  if (App.Pip._unbindPlan) App.Pip._unbindPlan();
  if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  pane.children.length = 0;
  wrap.parentNode = null;
  pane.appendChild(wrap);
  btn.textContent = '';
  btn.hidden = true;
  requested.length = 0;
  plays = 0;
  bubbles.length = 0;
  clearedTimers.length = 0;
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
  eq('常规舞台：宽度钳到 460，高度按比例并给计划栏留位', App.Pip._sizeFor(wrap), { width: 460, height: 494 });

  wrap._rect = { width: 2000, height: 400 };
  eq('超宽舞台：高度顶到下限 280', App.Pip._sizeFor(wrap), { width: 460, height: 280 });

  wrap._rect = { width: 300, height: 900 };
  eq('超竖舞台：高度顶到上限 620', App.Pip._sizeFor(wrap), { width: 300, height: 620 });

  wrap._rect = { width: 100, height: 100 };
  eq('过小舞台：宽度顶到下限，高度加计划栏', App.Pip._sizeFor(wrap), { width: 240, height: 360 });

  wrap._rect = null;
  eq('量不到尺寸时用兜底值，不出 NaN', App.Pip._sizeFor(wrap), { width: 360, height: 600 });

  console.log('\n=== 打开：舞台搬进画中画 ===');
  resetScene();
  nextWin = makePipWin();
  wrap._rect = { width: 688, height: 560 };
  App.Pip.open();
  await tick();
  await tick();

  eq('requestWindow 收到钳位后的尺寸', requested, [{ width: 460, height: 494 }]);
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

  console.log('\n=== 画中画计划面板 ===');
  resetScene();
  NOW = new Date(2026, 8, 19, 10, 0).getTime();
  planTasks = [
    { date: '2026-09-19', startTime: '09:00', endTime: '09:40', title: '已结束' },
    { date: '2026-09-19', startTime: '10:00', endTime: '10:45', title: '进行中任务' },
    { date: '2026-09-19', startTime: '11:00', endTime: '12:00', title: '今天下一项' },
    { date: '2026-09-20', startTime: '08:00', endTime: '09:00', title: '明天早课' },
    { date: '2026-09-21', startTime: '14:00', endTime: '15:00', title: '后天会议' },
    { date: '2026-09-24', startTime: '09:00', endTime: '10:00', title: '四天后' }
  ];
  nextWin = makePipWin();
  App.Pip.open();
  await tick();
  await tick();

  check('计划面板已创建并挂在画中画文档', !!App.Pip._plan &&
    App.Pip._plan.parentNode === nextWin.document.body);
  const rowsNow = () => App.Pip._planList.children.filter(
    c => c.className.indexOf('pip-plan-row') === 0);
  const rowText = row => row.children.map(c => c.textContent);
  eq('只列今起三天、未结束的任务', rowsNow().length, 4);
  eq('今天剩余项数', App.Pip._planCount.textContent, '今天 2 项');
  eq('第一行是进行中的今天任务', rowText(rowsNow()[0]), ['10:00', '进行中任务', '进行中']);
  check('进行中行带高亮类', rowsNow()[0].className.indexOf('is-active') >= 0);
  eq('明天任务带日期前缀', rowText(rowsNow()[2]), ['明天 08:00', '明天早课']);
  eq('后天任务带日期前缀', rowText(rowsNow()[3]), ['后天 14:00', '后天会议']);

  planTasks.push({ date: '2026-09-19', startTime: '13:00', endTime: '14:00', title: '新加任务' });
  App.bus.emit('schedule:changed', {});
  eq('schedule:changed 后立即刷新', rowsNow().length, 5);
  eq('刷新后今天项数同步', App.Pip._planCount.textContent, '今天 3 项');

  planTasks.push({ date: '2026-09-19', startTime: '15:00', endTime: '16:00', title: '第六项' });
  App.bus.emit('state:change', {});
  const more = App.Pip._planList.children.find(c => c.className === 'pip-plan-more');
  eq('超过 5 项时只显示 5 行', rowsNow().length, 5);
  eq('剩余项数提示', more && more.textContent, '还有 1 项');

  App.Pip.close();
  check('关闭后计划面板从画中画文档移除',
    nextWin.document.body.children.every(c => c.className !== 'pip-plan'));
  eq('关闭后 schedule:changed 监听已解绑', (busListeners['schedule:changed'] || []).length, 0);
  eq('关闭后 state:change 监听已解绑', (busListeners['state:change'] || []).length, 0);
  check('关闭后刷新定时器已清理', clearedTimers.length === 1, clearedTimers.length);

  resetScene();
  planTasks = [];
  nextWin = makePipWin();
  App.Pip.open();
  await tick();
  await tick();
  const empty = App.Pip._planList.children[0];
  eq('没有安排时显示空状态', empty && empty.className, 'pip-plan-empty');
  eq('空状态文案', empty && empty.textContent, '接下来没有安排，休息一下～');
  App.Pip.close();

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
