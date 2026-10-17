/*
 * 无头测试：查询解析与展示 —— 时间窗口（「后天12:00后」「明天下午」）、
 * 指定事项（「英语课什么时候」）、还有多久、下一项，以及新增/更新/删除的回归
 * 运行： node tests/test-query.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');

// ---- 最小 DOM / 浏览器环境 stub ----
const store = {};
const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.Promise = Promise;
sandbox.JSON = JSON; sandbox.Math = Math; sandbox.Date = Date;
sandbox.Object = Object; sandbox.Array = Array;
sandbox.String = String; sandbox.Number = Number;
sandbox.URLSearchParams = URLSearchParams;
sandbox.location = { search: '' };
sandbox.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
sandbox.document = {
  readyState: 'loading',                       // 阻止 app.js 自动 boot
  addEventListener: () => {},
  getElementById: () => null,
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} } }),
  createDocumentFragment: () => ({ appendChild() {} })
};
sandbox.window.App = {};

vm.createContext(sandbox);
const load = rel => vm.runInContext(
  fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });

load('app.js');
load('schedule/storage.js');
load('schedule/manager.js');
load('dialog/input.js');

const App = sandbox.App;

// ---- 输出 stub ----
const chat = [], bubbles = [];
App.Output = {
  pet: t => chat.push(t), user: () => {}, error: t => chat.push('ERR:' + t),
  system: () => {}, log: () => {}, clear: () => {}
};
App.Bubble = { say: (t, o) => bubbles.push(t) };
App.StateMachine = { isBusy: () => false, requestRefuse: () => {}, tick: () => {} };

// ---- 固定时钟：2026-09-19 10:00 ----
const D1 = '2026-09-19';
const D2 = '2026-09-20';
const D3 = '2026-09-21';
const D5 = '2026-09-24';
let mockNow = at(D1, '10:00');
App.Clock.now = () => mockNow;
App.Clock.today = () => App.util.dateStr(new Date(mockNow));
App.Clock.nowDate = () => new Date(mockNow);

function at(date, hm) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(date + 'T00:00:00');
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// ---- 断言 ----
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) + ' vs ' + JSON.stringify(want));

// ---- 数据 ----
function fresh(list) {
  App.Manager.tasks = [];
  App.Manager.meta = { summaryDates: {}, suppressed: [] };
  App.Controller.pending = null;
  chat.length = 0; bubbles.length = 0;
  (list || []).forEach(t => addTask(t));
}
function addTask(t) {
  const withDate = /^\d{4}-\d{2}-\d{2}$/.test(t[0]);
  const date = withDate ? t[0] : D1;
  const start = withDate ? t[1] : t[0];
  const end = withDate ? t[2] : t[1];
  const title = withDate ? t[3] : t[2];
  const endOffset = (withDate ? t[4] : t[3]) || 0;
  return App.Manager.add({
    date, startTime: start, endTime: end, title, endOffset, category: 'studying'
  }).task;
}
const parse = text => App.Input.parse(text, { now: mockNow });
const say = text => App.Controller.handle(text);
const last = () => chat[chat.length - 1] || '';
const liCount = html => (html.match(/<li>/g) || []).length;

console.log('\n=== 1. 解析：时间窗口 ===');
let p = parse('后天12:00后还有什么安排');
eq('后天 12:00 后：意图/日期', [p.intent, p.date], ['query', D3]);
eq('后天 12:00 后：窗口',
  [p.query.scope, p.query.fromMin, p.query.toMin, p.query.windowLabel, p.query.remainingOnly].join('|'),
  ['date', '720', '', '12:00 后', 'true'].join('|'));
eq('后天 12:00 后：没有标题片段', p.query.titleFrag, null);

p = parse('后天12：00后还有什么安排');
eq('全角冒号等价', [p.query.fromMin, p.query.windowLabel].join('|'), '720|12:00 后');

p = parse('今天12点前的安排');
eq('12 点前：只设上界',
  [p.intent, p.query.fromMin, p.query.toMin, p.query.windowLabel, p.query.remainingOnly].join('|'),
  ['query', '', '720', '12:00 前', 'false'].join('|'));

p = parse('明天下午的安排');
eq('明天下午：时段窗口',
  [p.date, p.query.fromMin, p.query.toMin, p.query.windowLabel, p.query.remainingOnly].join('|'),
  [D2, '720', '1080', '下午', 'false'].join('|'));

p = parse('明天14:00到16:00的安排');
eq('显式区间',
  [p.query.fromMin, p.query.toMin, p.query.windowLabel].join('|'),
  ['840', '960', '14:00–16:00'].join('|'));

p = parse('明天14:00～16:00的安排');
eq('全角波浪号区间',
  [p.query.fromMin, p.query.toMin].join('|'), '840|960');

p = parse('接下来还有什么安排');
eq('接下来：从此刻起',
  [p.query.fromMin, p.query.toMin, p.query.windowLabel].join('|'),
  ['600', '', '现在起'].join('|'));

console.log('\n=== 2. 解析：指定事项 / 还有多久 / 下一项 ===');
p = parse('英语课什么时候');
eq('事项查询：标题片段/仍按今天起算',
  [p.intent, p.query.titleFrag, p.query.scope, p.query.remainingOnly].join('|'),
  ['query', '英语课', 'today', 'true'].join('|'));

p = parse('英语课还有多久');
eq('还有多久：askEta + 标题', [p.query.askEta, p.query.titleFrag].join('|'), 'true|英语课');

p = parse('下一项安排是什么');
eq('下一项：next/limit/无标题',
  [p.query.next, p.query.limit, p.query.titleFrag].join('|'), 'true|1|');

p = parse('明天下午英语课什么时候');
eq('日期 + 时段 + 事项',
  [p.date, p.query.fromMin, p.query.toMin, p.query.titleFrag].join('|'),
  [D2, '720', '1080', '英语课'].join('|'));

console.log('\n=== 3. 解析：不抢新增/修改/删除/复制 ===');
eq('「安排明天下午两点开会」仍是新增',
  [parse('安排明天下午两点开会').intent, parse('安排明天下午两点开会').title].join('|'), 'add|开会');
eq('「明天下午两点半上英语课」仍是新增',
  [parse('明天下午两点半上英语课').intent, parse('明天下午两点半上英语课').startTime].join('|'),
  'add|14:30');
eq('「把明天下午的会议改到四点」仍是修改', parse('把明天下午的会议改到四点').intent, 'update');
eq('「取消明天的英语课」仍是删除', parse('取消明天的英语课').intent, 'delete');
eq('「把今天的安排复制到明天」仍是复制', parse('把今天的安排复制到明天').intent, 'copy');

console.log('\n=== 4. 查询结果：窗口过滤 ===');
fresh([
  ['09:00', '10:00', '晨读'],
  ['11:00', '12:00', '数学'],
  ['13:00', '14:00', '英语课'],
  ['23:00', '01:00', '夜读', 1],
  [D2, '09:00', '10:00', '英语课'],
  [D2, '14:00', '15:00', '开会'],
  [D2, '16:00', '17:00', '英语课'],
  [D3, '12:30', '13:30', '英语课'],
  [D3, '15:00', '16:00', '物理'],
  [D5, '09:00', '10:00', '英语课']
]);

let hl = null;
App.bus.on('query:highlight', payload => { hl = payload; });

say('后天12:00后还有什么安排');
check('后天 12:00 后：命中 2 项',
  /后天 12:00 后有 2 项安排/.test(last()), last());
check('  结果含 12:30 与 15:00', /12:30/.test(last()) && /15:00/.test(last()));
check('  12:00 之前的任务不出现', !/09:00/.test(last()));
eq('  高亮日期是后天', hl && hl.date, D3);
eq('  高亮 id 数量', hl && hl.ids.length, 2);

hl = null;
say('明天下午的安排');
check('明天下午：命中 2 项',
  /明天下午有 2 项安排/.test(last()), last());
check('  上午的英语课被排除', !/09:00/.test(last()));

say('今天上午有什么安排');
check('上午窗口含已结束的历史任务',
  /今天上午有 2 项安排/.test(last()), last());
check('  09:00 的晨读标为已完成', /晨读<\/span><span class="q-state q-已完成"/.test(last()), last());
check('  11:00 的任务标为待完成', /q-待完成/.test(last()));

say('今天12:00前的安排');
check('12 点前：命中 2 项', /今天 12:00 前有 2 项安排/.test(last()), last());
check('  13:00 的任务被排除', !/13:00/.test(last()));

say('今天11:30后还有什么安排');
check('窗口按时间相交判断：11:00–12:00 算 11:30 后',
  /11:00/.test(last()), last());
check('  同时候命中了下午与晚间任务',
  /13:00/.test(last()) && /23:00/.test(last()), last());

say('明天晚上有什么安排');
check('空窗口给出无安排提示', /明天晚上没有安排/.test(last()), last());

console.log('\n=== 5. 查询结果：指定事项 / 还有多久 / 下一项 ===');
say('英语课什么时候');
check('全库未来日程里找事项',
  /找到 5 项「英语课」/.test(last()), last());
eq('  5 行结果', liCount(last()), 5);
check('  多天结果带日期标签', /class="q-date"/.test(last()), last());
check('  明天的英语课也在内', /明天/.test(last()));

say('明天下午英语课什么时候');
check('日期 + 时段 + 事项共同过滤',
  /明天下午找到 1 项「英语课」/.test(last()), last());
check('  只留下 16:00 那节', /16:00/.test(last()) && !/09:00/.test(last()), last());

say('英语课还有多久');
check('还有多久：给出剩余时长', /距离「英语课」还有 3 小时/.test(last()), last());

say('下一项安排是什么');
check('下一项：给出最近的一条',
  /下一项安排是 今天 11:00–12:00/.test(last()), last());

mockNow = at(D2, '09:30');
say('英语课还有多久');
check('正在进行时直接说明', /「英语课」正在进行中（今天 09:00–10:00）/.test(last()), last());

fresh([[D2, '09:00', '10:00', '明天的课']]);
mockNow = at(D1, '22:00');
say('下一项安排是什么');
check('今天没安排时下一项跨到明天',
  /下一项安排是 明天 09:00–10:00/.test(last()), last());
mockNow = at(D1, '10:00');

console.log('\n=== 6. 查询只读：不改数据 ===');
fresh([['09:00', '10:00', '晨读'], ['13:00', '14:00', '英语课']]);
const before = JSON.stringify(App.Manager.tasks);
say('今天还有什么安排');
say('英语课什么时候');
eq('查询前后任务数据完全一致', JSON.stringify(App.Manager.tasks), before);

console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
process.exit(fail ? 1 : 0);
