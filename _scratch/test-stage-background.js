/*
 * 无头测试：验证 settings.js 的舞台背景逻辑
 * 运行： node _scratch/test-stage-background.js
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
    textContent: '', title: '', type: '', className: '', _listeners: {},
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

const els = {
  stage: el('div'), 'btn-bg-clear': el('button'), 'bg-picker': el('div'), 'btn-bg': el('button'),
  // 壁纸相关元素：本文件不测壁纸逻辑，但 init/bindUI 会碰到它们，缺了会走不进来
  body: el('body'), 'btn-wallpaper': el('button'), 'btn-wallpaper-clear': el('button'),
  'wallpaper-picker': el('div'), 'file-wallpaper': el('input')
};
els['bg-picker'].hidden = true;    // 对应 index.html 上的 hidden 属性
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
sandbox.document = {
  readyState: 'loading',
  addEventListener: () => {},
  getElementById: id => els[id] || null,
  createElement: t => el(t),
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

console.log('\n=== 用例 1：初始无设置 ===');
S.init();
check('不设置背景图', els.stage.style.backgroundImage === '', JSON.stringify(els.stage.style.backgroundImage));
check('无 has-bg class', !els.stage.classList.contains('has-bg'));
check('清除按钮隐藏', els['btn-bg-clear'].hidden === true);
check('面板已生成选项（提示语 + 无 + 1 预设）', els['bg-picker'].children.length === 1 &&
  els['bg-picker'].children[0].children.length === 3,
  'children=' + els['bg-picker'].children[0].children.length);

console.log('\n=== 用例 2：选择预设 ===');
msgs.length = 0;
S.select(PRESET);
const bg = els.stage.style.backgroundImage;
check('inline style 含压暗层 + 图片', bg.indexOf('linear-gradient') === 0 && bg.indexOf('url("' + PRESET + '")') > 0, bg);
check('加了 has-bg class', els.stage.classList.contains('has-bg'));
check('清除按钮显示', els['btn-bg-clear'].hidden === false);
check('写入 settingsKey', store[App.Config.settingsKey] === JSON.stringify({ bg: PRESET, wallpaper: null }),
  store[App.Config.settingsKey]);
check('未污染日程 key', store[App.Config.desktop_pet_v2] === undefined && store['desktop_pet_v2'] === undefined);
check('给出用户反馈', msgs.some(m => m.startsWith('system:')) && msgs.some(m => m.startsWith('bubble:')), JSON.stringify(msgs));
check('选中项高亮',
  els['bg-picker'].querySelectorAll('[data-path]').filter(b => b.classList.contains('selected')).length === 1,
  String(els['bg-picker'].querySelectorAll('[data-path]').filter(b => b.classList.contains('selected')).length));

console.log('\n=== 用例 3：刷新后恢复（重新 init）===');
els.stage.style.backgroundImage = '';
els.stage.classList.remove('has-bg');
S.init();
check('背景被恢复', els.stage.style.backgroundImage.indexOf('url("' + PRESET + '")') > 0,
  els.stage.style.backgroundImage);
check('has-bg 恢复', els.stage.classList.contains('has-bg'));
check('选中项恢复高亮',
  els['bg-picker'].querySelectorAll('[data-path]').filter(b => b.classList.contains('selected')).length === 1);

console.log('\n=== 用例 4：清除背景 ===');
msgs.length = 0;
S.clearBg();
check('inline style 清空', els.stage.style.backgroundImage === '', JSON.stringify(els.stage.style.backgroundImage));
check('has-bg 移除', !els.stage.classList.contains('has-bg'));
check('写入 null', store[App.Config.settingsKey] === JSON.stringify({ bg: null, wallpaper: null }),
  store[App.Config.settingsKey]);
check('清除按钮隐藏', els['btn-bg-clear'].hidden === true);
const sel4 = els['bg-picker'].querySelectorAll('[data-path]').filter(b => b.classList.contains('selected'));
check('高亮落在「无」选项上', sel4.length === 1 && sel4[0].dataset.path === '', JSON.stringify(sel4.map(b => b.dataset.path)));

console.log('\n=== 用例 5：刷新后仍为无背景 ===');
S.init();
check('仍无背景', els.stage.style.backgroundImage === '');

console.log('\n=== 用例 6：非法路径被拒绝 ===');
msgs.length = 0;
S.select('data/backgrounds/../evil.jpg');
check('未写入 localStorage', store[App.Config.settingsKey] === JSON.stringify({ bg: null, wallpaper: null }));
check('未给出误导性反馈', msgs.length === 0, JSON.stringify(msgs));

console.log('\n=== 用例 7：配额满时优雅失败 ===');
msgs.length = 0;
quotaFull = true;
S.select(PRESET);
check('提示用户', msgs.some(m => m.startsWith('error:')), JSON.stringify(msgs));
check('内存状态未变更', S.bg === null || S.bg === 'data/backgrounds/bg1.jpg', String(S.bg));
check('未设置背景图（保持原状）', els.stage.style.backgroundImage === '');
quotaFull = false;

console.log('\n=== 用例 8：损坏的设置数据兜底 ===');
store[App.Config.settingsKey] = '{不是合法JSON';
S.init();
check('不抛异常且回退为无背景', S.bg === null, String(S.bg));
store[App.Config.settingsKey] = JSON.stringify({ bg: 12345 });
S.init();
check('非字符串 bg 被忽略', S.bg === null, String(S.bg));

console.log('\n=== 用例 9：面板交互 ===');
store[App.Config.settingsKey] = JSON.stringify({ bg: null });
S.init();
els['btn-bg'].fire('click');
check('点击「更换背景」展开面板', els['bg-picker'].hidden === false);
els['btn-bg'].fire('click');
check('再点收起', els['bg-picker'].hidden === true);
const thumb = els['bg-picker'].querySelectorAll('[data-path]').filter(b => b.dataset.path === PRESET)[0];
thumb.fire('click');
check('点击缩略图应用背景', els.stage.style.backgroundImage.indexOf(PRESET) > 0, els.stage.style.backgroundImage);
const noneBtn = els['bg-picker'].querySelectorAll('[data-path]').filter(b => b.dataset.path === '')[0];
noneBtn.fire('click');
check('点击「无」清除背景', els.stage.style.backgroundImage === '');

console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
process.exit(fail ? 1 : 0);
