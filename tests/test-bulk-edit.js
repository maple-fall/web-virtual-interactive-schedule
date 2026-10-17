/*
 * 无头测试：批量增删改查
 * 覆盖：按星期聚合的移动 / 改名 / 改时间 / 平移时长 / 批量删除，
 *       多条命中的确认流程，已完成任务的跳过，以及单条修改不受影响。
 * 运行： node tests/test-bulk-edit.js
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

// ---- 固定时钟：2026-09-19（周六）10:00 ----
const TODAY = '2026-09-19';
const MON1 = '2026-09-21';
const TUE1 = '2026-09-22';
const WED1 = '2026-09-23';
const MON2 = '2026-09-28';
const TUE2 = '2026-09-29';
const WED2 = '2026-09-30';
let mockNow = at(TODAY, '10:00');
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
  const date = withDate ? t[0] : TODAY;
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
const byDate = d => App.Manager.tasksOfDate(d);

function dbMondayFixture() {
  fresh([
    [MON1, '20:30', '21:50', '数据库系统原理 H3-204'],
    [MON2, '20:30', '21:50', '数据库系统原理 H3-204'],
    [TUE1, '19:00', '20:20', '走在前列的广东实践 学生发展中心401'],
    [TUE2, '19:00', '20:20', '走在前列的广东实践 学生发展中心401'],
    [MON1, '09:00', '10:00', '软件测试与管理 H4-413']
  ]);
}

console.log('\n=== 1. 解析：批量修改 ===');
let p = parse('将安排中周一的数据库系统原理的安排都改到周二的晚上相同的时间');
eq('周一全部 → 周二：意图 / 批量标记',
  [p.intent, p.bulk].join('|'), 'update|true');
eq('定位条件：星期 + 标题',
  [p.target.weekday, p.target.titleFrag].join('|'), '1|数据库系统原理');
eq('修改内容：只换星期，不带时间',
  [p.patches.weekday, p.patches.startTime, p.patches.title].join('|'), '2||');

p = parse('把所有周一的数据库系统原理都改到晚上八点');
eq('批量改开始时间', [p.target.weekday, p.patches.startTime].join('|'), '1|20:00');

p = parse('把所有周一的数据库系统原理都往后挪半小时');
eq('批量平移：延后 30 分钟', [p.target.weekday, p.patches.timeDeltaMin].join('|'), '1|30');

p = parse('把所有周一的数据库系统原理都提前一小时');
eq('批量平移：提前 60 分钟', p.patches.timeDeltaMin, -60);

p = parse('把「数据库系统原理 H3-204」改名成「数据库原理」');
eq('改名不带日期：全库同名安排',
  [p.target.weekday, p.target.titleFrag, p.patches.title].join('|'),
  '|数据库系统原理 H3-204|数据库原理');

p = parse('周二的走在“前列的广东实践 学生发展中心401”改名成“前列的广东实践”并改放到周三晚上相同的时间段');
eq('改名 + 换星期：定位',
  [p.target.weekday, p.target.titleFrag].join('|'),
  '2|走在前列的广东实践 学生发展中心401');
eq('改名 + 换星期：修改内容',
  [p.patches.title, p.patches.weekday].join('|'), '前列的广东实践|3');

p = parse('把所有周一的数据库系统原理都删掉');
eq('批量删除：意图 / 星期 / 标题',
  [p.intent, p.bulk, p.target.weekday, p.target.titleFrag].join('|'),
  'delete|true|1|数据库系统原理');

p = parse('删除所有明天的安排');
eq('批量删除：具体日期 + 全部',
  [p.target.date, p.target.titleFrag].join('|'), '2026-09-20|');

console.log('\n=== 2. 解析：按星期查询 / 不抢单条指令 ===');
p = parse('每周一都有什么安排');
eq('每周一：聚合查询', [p.intent, p.query.scope, p.query.weekday].join('|'), 'query|weekday|1');

p = parse('周一的课都有哪些');
eq('周一都…：聚合查询且不把「课」当标题',
  [p.query.scope, p.query.weekday, p.query.titleFrag].join('|'), 'weekday|1|');

p = parse('下周一都有什么安排');
eq('下周一仍是具体日期', [p.query.scope, p.date].join('|'), 'date|' + MON1);

p = parse('把下午三点的会议改成四点');
eq('普通单条修改不受影响',
  [p.intent, p.bulk === undefined, p.patches.startTime].join('|'), 'update|true|16:00');

p = parse('取消明天的英语课');
eq('普通单条删除不受影响',
  [p.intent, p.bulk === undefined, p.date].join('|'), 'delete|true|2026-09-20');

p = parse('把周一的会议改到周二');
check('没有「都 / 所有」时不抢单条语义', p.bulk === undefined, p.bulk);

console.log('\n=== 3. Manager.updateMany：移动 / 改名 / 保持时长 ===');
fresh([
  [MON1, '20:30', '21:50', '数据库系统原理 H3-204'],
  [MON2, '20:30', '21:50', '数据库系统原理 H3-204'],
  [MON1, '09:00', '10:30', '软件测试与管理']
]);
let ids = App.Manager.findCandidates({ weekday: 1, titleFrag: '数据库系统原理' })
  .map(t => t.id);
let res = App.Manager.updateMany(ids, { weekday: 2, title: '数据库原理' });
eq('统计：更新 2 条，移动 2 条，改名 2 条',
  [res.updated, res.moved, res.renamed].join('|'), '2|2|2');
eq('第 1 条移到同周周二，时间不变',
  [byDate(TUE1)[0].date, byDate(TUE1)[0].startTime, byDate(TUE1)[0].endTime].join('|'),
  TUE1 + '|20:30|21:50');
eq('第 2 条移到下周二',
  [byDate(TUE2)[0].date, byDate(TUE2)[0].title].join('|'), TUE2 + '|数据库原理');
check('周一的其他课没被移动', byDate(MON1).some(t => t.title === '软件测试与管理'));

console.log('\n=== 4. 端到端：周一 → 周二（确认后执行）===');
dbMondayFixture();
say('将安排中周一的数据库系统原理的安排都改到周二的晚上相同的时间');
check('多条命中先确认', App.Controller.pending &&
  App.Controller.pending.type === 'confirm-bulk-update', App.Controller.pending && App.Controller.pending.type);
check('确认提示给出条数和目标', /找到 2 项.*数据库系统原理/.test(last()) && /移到每周二/.test(last()), last());
eq('确认前数据没动', byDate(TUE1).length, 1);

say('确认');
check('确认后给出更新结果', /已更新 2 项安排/.test(last()), last());
eq('周一的两条数据库课都到了周二',
  App.Manager.findCandidates({ weekday: 2, titleFrag: '数据库系统原理' }).length, 2);
eq('周二原有课程还在', byDate(TUE1).length, 2);
eq('时间保持不变', byDate(TUE1).filter(t => /数据库/.test(t.title))[0].startTime, '20:30');
eq('周一只剩软件测试', byDate(MON1).map(t => t.title).join('|'), '软件测试与管理 H4-413');

console.log('\n=== 5. 端到端：改名 + 换到周三 ===');
dbMondayFixture();
say('周二的走在“前列的广东实践 学生发展中心401”改名成“前列的广东实践”并改放到周三晚上相同的时间段');
check('改名 + 换天先确认', App.Controller.pending &&
  App.Controller.pending.type === 'confirm-bulk-update');
say('确认');
eq('两条都改名并移到周三',
  App.Manager.findCandidates({ weekday: 3, titleFrag: '前列的广东实践' }).length, 2);
eq('周三的时间保持 19:00–20:20',
  [byDate(WED1)[0].startTime, byDate(WED1)[0].endTime].join('|'), '19:00|20:20');
eq('周二不再有旧名字',
  App.Manager.findCandidates({ weekday: 2, titleFrag: '走在前列的' }).length, 0);

console.log('\n=== 6. 端到端：批量改时间 / 平移 / 删除 ===');
dbMondayFixture();
say('把所有周一的数据库系统原理都改到晚上八点');
say('确认');
eq('统一改成 20:00，结束时间按时长顺延',
  [byDate(MON1).filter(t => /数据库/.test(t.title))[0].startTime,
   byDate(MON1).filter(t => /数据库/.test(t.title))[0].endTime].join('|'),
  '20:00|21:20');

dbMondayFixture();
say('把所有周一的数据库系统原理都往后挪半小时');
say('确认');
eq('整体延后 30 分钟',
  [byDate(MON1).filter(t => /数据库/.test(t.title))[0].startTime,
   byDate(MON1).filter(t => /数据库/.test(t.title))[0].endTime].join('|'),
  '21:00|22:20');

dbMondayFixture();
say('把所有周一的数据库系统原理都删掉');
check('批量删除先确认', App.Controller.pending &&
  App.Controller.pending.type === 'confirm-bulk-delete');
say('确认');
eq('两条都删掉',
  App.Manager.findCandidates({ weekday: 1, titleFrag: '数据库系统原理' }).length, 0);

console.log('\n=== 7. 已完成任务默认不动 ===');
dbMondayFixture();
// 只把第一个周一那条标成已完成，另一条仍待办
App.Manager.tasksOfDate(MON1)
  .filter(t => /数据库/.test(t.title))
  .forEach(t => { t.status = 'done'; });
say('把所有周一的数据库系统原理都改到周二');
check('只剩 1 条待改，直接执行', /已更新 1 项安排/.test(last()), last());
check('提示里说明跳过了几条', /另有 1 项已完成/.test(last()), last());
eq('已完成的周一课仍在原地',
  App.Manager.findCandidates({ date: MON1, titleFrag: '数据库系统原理' }).length, 1);
eq('未完成的那条到了下周二',
  App.Manager.findCandidates({ date: TUE2, titleFrag: '数据库系统原理' }).length, 1);

console.log('\n=== 8. 按星期查询 ===');
dbMondayFixture();
chat.length = 0;
say('每周一都有什么安排');
check('列出所有未来周一',
  /每周一有 3 项安排/.test(last()), last());
check('包含两个周一的数据库课和软件测试',
  (last().match(/数据库系统原理/g) || []).length === 2 &&
  /软件测试/.test(last()), last());
check('带日期标签', /class="q-date"/.test(last()), last());

console.log('\n=== 9. 单条修改：时长补丁 ===');
fresh([[TODAY, '15:00', '16:00', '会议']]);
say('把下午三点的会议改成一个半小时');
check('单条修改提示时长', /时长改成 90 分钟/.test(last()), last());
eq('结束时间按新时长顺延',
  [byDate(TODAY)[0].startTime, byDate(TODAY)[0].endTime].join('|'), '15:00|16:30');

console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
process.exit(fail ? 1 : 0);
