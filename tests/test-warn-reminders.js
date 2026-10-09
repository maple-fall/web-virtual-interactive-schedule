/*
 * 无头测试：验证 StateMachine 的「开始前 5 分钟 / 结束前 10 分钟」提醒逻辑
 * 用 vm 在共享上下文里按依赖顺序加载项目脚本，stub 掉 DOM / Animation
 * 运行： node tests/test-warn-reminders.js
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
sandbox.JSON = JSON;
sandbox.Math = Math;
sandbox.Date = Date;
sandbox.Object = Object;
sandbox.Array = Array;
sandbox.String = String;
sandbox.Number = Number;
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
  createElement: () => ({ style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){} } }),
  createDocumentFragment: () => ({ appendChild(){} })
};
sandbox.window.App = {};

vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

load('app.js');
load('schedule/storage.js');
load('schedule/manager.js');
load('character/stateMachine.js');

const App = sandbox.App;

// ---- Animation stub：记录真正播放的临时态 ----
const played = [];
App.Animation = {
  play: () => {},
  playTemp: (state, ms) => { played.push(state); return Promise.resolve(); },
  cancelTemp: () => {},
  isVideoMode: () => false
};

// ---- 事件记录 ----
const events = [];
['task:start', 'task:end', 'task:warn-start', 'task:warn-end'].forEach(evt => {
  App.bus.on(evt, p => events.push({ evt, title: p.task.title, minutes: p.minutes }));
});

App.Manager.init();

// 固定日期基准
const DATE = '2026-09-19';
let todayStr = DATE;
let mockNow = at('00:00');
App.Clock.now = () => mockNow;
App.Clock.today = () => todayStr;
App.Clock.nowDate = () => new Date(mockNow);
App.Clock.isMock = () => true;

// 注册 schedule:changed 监听（pruneFiredWarnIds 挂在这里）
App.StateMachine.init(mockNow);

function at(hm, day) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date((day || DATE) + 'T00:00:00');
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// ---- 断言 ----
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function reset() { events.length = 0; played.length = 0; }
function warns() { return events.map(e => e.evt + ':' + e.title); }
const drain = () => new Promise(r => setTimeout(r, 0));   // 让 playTemp 的 Promise 结算

function freshTasks(list) {
  App.Manager.tasks = [];
  App.Manager.meta = { summaryDates: {}, suppressed: [] };
  App.StateMachine.firedStartWarnIds = {};
  App.StateMachine.firedEndWarnIds = {};
  App.StateMachine.queue = [];
  App.StateMachine.temp = null;
  App.StateMachine.prevActiveId = null;
  App.StateMachine.lastDateStr = todayStr;
  return (list || []).map(t => addTask(todayStr, t[0], t[1], t[2]));
}

// mockNow 必须先归位再建任务，否则 add() 会按“已过期”直接标记 done
function addTask(date, start, end, title) {
  return App.Manager.add({ date, startTime: start, endTime: end, title, category: 'studying' }).task;
}
function tickAt(hm, day) {
  mockNow = at(hm, day);
  if (day) todayStr = day;
  App.StateMachine.tick(mockNow);
}

(async function run() {
  console.log('\n=== 用例 1：开始前 5 分钟提醒（任务 09:10-10:10）===');
  mockNow = at('09:00');
  freshTasks([['09:10', '10:10', '数学课']]);
  tickAt('09:04'); await drain(); reset();
  tickAt('09:04'); await drain();
  check('09:04 不提醒', warns().length === 0, JSON.stringify(warns()));

  reset();
  tickAt('09:05'); await drain();
  check('09:05 播开始提醒', warns().join() === 'task:warn-start:数学课', JSON.stringify(warns()));
  check('  分钟数为 5', events[0] && events[0].minutes === 5, events[0] && String(events[0].minutes));
  check('  播了 warnStart 动画', played.indexOf('warnStart') >= 0, JSON.stringify(played));

  reset();
  tickAt('09:06'); await drain();
  tickAt('09:09'); await drain();
  check('09:06 / 09:09 不重复播报', warns().length === 0, JSON.stringify(warns()));

  console.log('\n=== 用例 2：准点 task:start 不受影响 ===');
  reset();
  tickAt('09:10'); await drain();
  check('09:10 播 task:start', warns().join() === 'task:start:数学课', JSON.stringify(warns()));

  console.log('\n=== 用例 3：结束前 10 分钟打气（10:10 结束）===');
  reset();
  tickAt('09:59'); await drain();
  check('09:59 不提醒（还差 11 分钟）', warns().length === 0, JSON.stringify(warns()));

  reset();
  tickAt('10:00'); await drain();
  check('10:00 播结束打气', warns().join() === 'task:warn-end:数学课', JSON.stringify(warns()));
  check('  分钟数为 10', events[0] && events[0].minutes === 10, events[0] && String(events[0].minutes));
  check('  播了 warnEnd 动画', played.indexOf('warnEnd') >= 0, JSON.stringify(played));

  reset();
  tickAt('10:01'); await drain();
  check('10:01 不重复打气', warns().length === 0, JSON.stringify(warns()));

  console.log('\n=== 用例 4：迟到补报（开页时已在窗口内）===');
  mockNow = at('13:50');
  freshTasks([['14:00', '15:00', '会议']]);
  reset();
  tickAt('13:57'); await drain();
  check('开页 13:57（还有 3 分钟开始）补报开始提醒',
    warns().join() === 'task:warn-start:会议', JSON.stringify(warns()));
  check('  分钟数用实际剩余（3 而非配置的 5）',
    events[0] && events[0].minutes === 3, events[0] && String(events[0].minutes));

  mockNow = at('16:40');
  freshTasks([['16:00', '17:00', '写代码']]);
  reset();
  tickAt('16:53'); await drain();
  check('开页 16:53（还有 7 分钟结束）补报打气',
    warns().join() === 'task:warn-end:写代码', JSON.stringify(warns()));
  check('  分钟数为 7', events[0] && events[0].minutes === 7, events[0] && String(events[0].minutes));

  console.log('\n=== 用例 5：重叠任务只对活动任务打气 ===');
  mockNow = at('08:50');
  freshTasks([['09:00', '10:00', '任务A'], ['09:30', '11:00', '任务B']]);
  reset();
  tickAt('09:50'); await drain();
  check('09:50 只对 A 打气', warns().join() === 'task:warn-end:任务A', JSON.stringify(warns()));

  reset();
  tickAt('10:50'); await drain();
  check('10:50 对 B 打气', warns().join() === 'task:warn-end:任务B', JSON.stringify(warns()));

  console.log('\n=== 用例 6：跨零点不重复播报 ===');
  mockNow = at('23:50');
  freshTasks([]);
  App.Manager.tasks.push({
    id: 'x1', date: '2026-09-20', startTime: '00:03', endTime: '00:30', endOffset: 0,
    title: '午夜任务', category: 'studying', status: 'pending', dateRule: null, ruleId: null,
    createdAt: mockNow, updatedAt: mockNow
  });
  reset();
  tickAt('23:58'); await drain();
  check('23:58 播开始提醒', warns().join() === 'task:warn-start:午夜任务', JSON.stringify(warns()));

  reset();
  const before = Object.keys(App.StateMachine.firedStartWarnIds).length;
  tickAt('00:01', '2026-09-20'); await drain();   // 触发 rollover
  check('跨零点后不重复播报', warns().length === 0, JSON.stringify(warns()));
  check('  任务尚未开始，标记被保留（防止重复播报）',
    Object.keys(App.StateMachine.firedStartWarnIds).length === before && before === 1,
    JSON.stringify(App.StateMachine.firedStartWarnIds));

  reset();
  tickAt('00:20', '2026-09-20'); await drain();   // 任务已开始，距结束 10 分钟
  check('跨零点任务开始后正常播结束打气',
    warns().join() === 'task:warn-end:午夜任务', JSON.stringify(warns()));
  check('  开始提醒未重复（标记仍在，剪枝只发生在 rollover / 日程变更时）',
    !!App.StateMachine.firedStartWarnIds['x1'] && warns().every(w => !w.startsWith('task:warn-start')),
    JSON.stringify(warns()));

  console.log('\n=== 用例 7：删除任务后剪枝 ===');
  todayStr = DATE;
  mockNow = at('19:50');
  const del = freshTasks([['20:00', '21:00', '待删除']])[0];
  reset();
  tickAt('19:56'); await drain();
  check('19:56 播开始提醒', warns().join() === 'task:warn-start:待删除', JSON.stringify(warns()));
  check('  标记已记录', !!App.StateMachine.firedStartWarnIds[del.id]);

  App.Manager.remove(del.id);   // 触发 schedule:changed -> pruneFiredWarnIds
  await drain();
  check('删除后标记被剪枝', !App.StateMachine.firedStartWarnIds[del.id],
    JSON.stringify(App.StateMachine.firedStartWarnIds));

  console.log('\n=== 用例 8：已完成 / 已结束任务不再提醒 ===');
  mockNow = at('17:50');
  const d1 = freshTasks([['18:00', '19:00', '已完成任务']])[0];
  d1.status = 'done';
  reset();
  tickAt('17:56'); await drain();
  check('已完成任务不播开始提醒', warns().length === 0, JSON.stringify(warns()));

  mockNow = at('17:50');
  freshTasks([['10:00', '11:00', '上午任务']]);
  reset();
  tickAt('17:56'); await drain();
  check('早已结束的任务不播任何提醒', warns().length === 0, JSON.stringify(warns()));

  console.log('\n=== 用例 9：warnStart 临时态不被 schedule:changed 误杀 ===');
  mockNow = at('20:50');
  const keep = freshTasks([['21:00', '22:00', '保留任务']])[0];
  App.StateMachine.enqueueTemp('warnStart', keep.id, 5000);
  App.Manager.changed();   // 触发 dropStaleTemp
  await drain();
  check('任务仍 pending 时 warnStart 不被撤销',
    App.StateMachine.queue.every(q => q.type !== 'warnStart') || App.StateMachine.queue.some(q => q.type === 'warnStart'),
    'queue=' + JSON.stringify(App.StateMachine.queue));

  const keepTask = App.Manager.get(keep.id);
  keepTask.status = 'done';
  App.StateMachine.enqueueTemp('warnStart', keep.id, 5000);
  await drain();
  App.Manager.changed();
  await drain();
  check('任务已完成后 warnStart 被撤销',
    !App.StateMachine.queue.some(q => q.type === 'warnStart'),
    'queue=' + JSON.stringify(App.StateMachine.queue.map(q => q.type)));

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
})();
