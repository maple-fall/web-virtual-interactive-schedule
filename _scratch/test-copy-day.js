/*
 * 无头测试：验证「把某天的全部安排复制到另一天」——解析、冲突成对询问、重叠/更换两种收尾
 * 重点覆盖用户点名的「部分时间重叠 → 合并成一条、名字逗号相连、时间段取并集」
 * 运行： node _scratch/test-copy-day.js
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
  createElement: () => ({ style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){} } }),
  createDocumentFragment: () => ({ appendChild(){} })
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

// ---- 输出 stub：记下聊天区与气泡说了什么 ----
const chat = [], bubbles = [];
App.Output = {
  pet: t => chat.push(t), user: () => {}, error: t => chat.push('ERR:' + t),
  system: () => {}, log: () => {}, clear: () => {}
};
App.Bubble = { say: (t, o) => bubbles.push(t) };
App.StateMachine = { isBusy: () => false, requestRefuse: () => {}, tick: () => {} };

// ---- 固定时钟 ----
const D1 = '2026-09-19';       // 源日（今天）
const D2 = '2026-09-20';       // 目标日（明天）
let mockNow = at(D1, '00:00'); // 基准点定在当天 0 点，源任务不会一建出来就变 done
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

// ---- 事件计数 ----
let changedCount = 0;
App.bus.on('schedule:changed', () => { changedCount++; });

/* 重建一份干净数据。
   两种写法：['09:00','10:00','A'] 落在源日 D1；
             ['2026-09-20','09:30','10:30','B'] 显式指定日期。
   两种都可带末位 endOffset（跨天），如 ['2026-09-19','23:00','01:00','夜班',1] */
function fresh(list) {
  App.Manager.tasks = [];
  App.Manager.meta = { summaryDates: {}, suppressed: [] };
  App.Controller.pending = null;
  chat.length = 0; bubbles.length = 0; changedCount = 0;
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
function day(date) {
  return App.Manager.tasksOfDate(date)
    .sort((a, b) => (a.startTime < b.startTime ? -1 : 1))
    .map(t => t.title + ' ' + t.startTime + '-' + t.endTime + (t.endOffset ? '+1' : ''));
}
function say(text) { App.Controller.handle(text); }

console.log('\n=== 1. 无冲突：直接整日复制 ===');
fresh([['09:00', '10:00', 'A'], ['14:00', '15:00', 'B'], [D1, '23:00', '01:00', 'C', 1]]);
const srcIds = App.Manager.tasksOfDate(D1).map(t => t.id);
changedCount = 0;
say('把今天的安排复制到明天');
check('目标日多出 3 条', App.Manager.tasksOfDate(D2).length === 3,
  JSON.stringify(day(D2)));
check('源日一条不少', JSON.stringify(day(D1)) ===
  JSON.stringify(['A 09:00-10:00', 'B 14:00-15:00', 'C 23:00-01:00+1']),
  JSON.stringify(day(D1)));
check('副本是全新 id', App.Manager.tasksOfDate(D2).every(t => srcIds.indexOf(t.id) < 0));
check('副本切断周期规则（dateRule/ruleId 都是 null）',
  App.Manager.tasksOfDate(D2).every(t => t.dateRule === null && t.ruleId === null));
const cC = App.Manager.tasksOfDate(D2).filter(t => t.title === 'C')[0];
check('跨天 endOffset 透传', cC && cC.endOffset === 1, cC && cC.endOffset);
check('schedule:changed 恰好 1 次', changedCount === 1, changedCount);
check('没有进待确认态', App.Controller.pending === null);
check('播报了复制条数', /3 项安排已复制到明天/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);

console.log('\n=== 2. 有冲突：成对展示后等回答 ===');
fresh([['09:00', '10:00', 'A'], [D2, '09:30', '10:30', 'B']]);
say('把今天的安排复制到明天');
const pend = App.Controller.pending;
check('进了 confirm-copy 待确认态', pend && pend.type === 'confirm-copy',
  pend && pend.type);
check('识别出 1 对冲突', pend && pend.pairs.length === 1,
  pend && pend.pairs.length);
check('  from 是源任务 A', pend && pend.pairs[0].from.title === 'A');
check('  to 是目标日已有任务 B', pend && pend.pairs[0].to.title === 'B');
check('还没写库（目标日仍只有 B）', JSON.stringify(day(D2)) === JSON.stringify(['B 09:30-10:30']),
  JSON.stringify(day(D2)));
const ask = chat[chat.length - 1] || '';
check('两个名字在同一个框里（li.conflict-pair）',
  /<li class="conflict-pair">[^<]*要复制 <b>A<\/b>[^<]*／ 已有 <b>B<\/b>/.test(ask), ask);
check('询问文案给了「重叠」「更换」「取消」三个出口',
  /重叠/.test(ask) && /更换/.test(ask) && /取消/.test(ask));

console.log('\n=== 3. 回复「重叠」：两边都留 ===');
say('重叠');
check('目标日两条都在', JSON.stringify(day(D2)) === JSON.stringify(['A 09:00-10:00', 'B 09:30-10:30']),
  JSON.stringify(day(D2)));
check('待确认态已清空', App.Controller.pending === null);
check('播报了「冲突的也都留下」', /冲突的也都留下/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);

console.log('\n=== 4. 回复「更换」：部分重叠合并成一条（用户点名场景）===');
fresh([['09:00', '10:00', 'A'], ['15:00', '16:00', 'C'], [D2, '09:30', '10:30', 'B']]);
say('把今天的安排复制到明天');
say('更换');
check('B 被并掉、A 与 C 都到目标日',
  JSON.stringify(day(D2)) === JSON.stringify(['A,B 09:00-10:30', 'C 15:00-16:00']),
  JSON.stringify(day(D2)));
check('源日不受影响', JSON.stringify(day(D1)) === JSON.stringify(['A 09:00-10:00', 'C 15:00-16:00']),
  JSON.stringify(day(D1)));
check('播报了合并条数', /1 项撞上的旧安排已合并/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);

console.log('\n=== 5. 一条新安排撞两条旧安排 ===');
fresh([['10:00', '11:00', 'A'], [D2, '09:45', '10:30', 'B1'], [D2, '10:30', '11:15', 'B2']]);
say('把今天的安排复制到明天');
say('更换');
check('名字按撞上的顺序逗号串起来，时间取并集 09:45-11:15',
  JSON.stringify(day(D2)) === JSON.stringify(['A,B1,B2 09:45-11:15']),
  JSON.stringify(day(D2)));

console.log('\n=== 6. 一条旧安排被两条新安排撞上：只并进排序键最小的那条 ===');
fresh([['09:00', '10:00', 'A1'], ['09:30', '10:30', 'A2'], [D2, '09:15', '09:45', 'B']]);
say('把今天的安排复制到明天');
say('更换');
check('B 并进 A1（开始更早），A2 原样添加',
  JSON.stringify(day(D2)) === JSON.stringify(['A1,B 09:00-10:00', 'A2 09:30-10:30']),
  JSON.stringify(day(D2)));

console.log('\n=== 7. 跨天并集 ===');
// 副本落在目标日 23:00 起、次日 01:00 止；目标日当天 22:00-23:30 的任务与它尾部重合
fresh([[D1, '23:00', '01:00', 'A', 1], [D2, '22:00', '23:30', 'B']]);
say('把今天的安排复制到明天');
check('识别出撞车', App.Controller.pending && App.Controller.pending.pairs.length === 1,
  App.Controller.pending && App.Controller.pending.pairs.length);
say('更换');
check('并集 22:00-01:00(+1)',
  JSON.stringify(day(D2)) === JSON.stringify(['A,B 22:00-01:00+1']),
  JSON.stringify(day(D2)));
const merged = App.Manager.tasksOfDate(D2)[0];
check('endOffset 置 1', merged && merged.endOffset === 1, merged && merged.endOffset);

console.log('\n=== 8. 被并掉的周期任务不会复活 ===');
fresh([['09:00', '10:00', 'A'], [D2, '09:30', '10:30', 'B']]);
App.Manager.tasksOfDate(D2)[0].ruleId = 'rule-1';
App.Manager.tasksOfDate(D2)[0].dateRule = '每天';
say('把今天的安排复制到明天');
say('更换');
check('记下了 suppressed（ruleId@date）',
  App.Manager.meta.suppressed.indexOf('rule-1@' + D2) >= 0,
  JSON.stringify(App.Manager.meta.suppressed));
App.Manager.materializeRules();
check('materializeRules 没把它复活',
  !App.Manager.tasksOfDate(D2).some(t => t.title === 'B'),
  JSON.stringify(day(D2)));

console.log('\n=== 9. 边界：源日为空 / 全已完成 / 源=目标 ===');
fresh([]);
say('把今天的安排复制到明天');
check('源日无安排时给出提示', /没有安排，没什么可复制的/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);
check('  不写库', App.Manager.tasks.length === 0);

fresh([['09:00', '10:00', 'A']]);
App.Manager.tasksOfDate(D1)[0].status = 'done';
say('把今天的安排复制到明天');
check('源日全已完成时不复制', /都已经完成了/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);
check('  目标日仍为空', App.Manager.tasksOfDate(D2).length === 0);

fresh([['09:00', '10:00', 'A']]);
say('把今天的安排复制到今天');
check('源=目标时叫停', /就是它自己呀/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);
check('  没多出任务', App.Manager.tasks.length === 1);

console.log('\n=== 10. 部分已完成：只复制未完成的，并注明条数 ===');
fresh([['09:00', '10:00', 'A'], ['14:00', '15:00', 'B']]);
App.Manager.tasksOfDate(D1)[1].status = 'done';
say('把今天的安排复制到明天');
check('只复制了 1 条', JSON.stringify(day(D2)) === JSON.stringify(['A 09:00-10:00']),
  JSON.stringify(day(D2)));
check('播报里注明了已完成的条数', /另有 1 项已完成，没复制/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);

console.log('\n=== 11. 待确认期间时间溜走：已过去的副本记为 done ===');
// 解析时还是 09-19，「明天」= 09-20；等回答的这半天里时钟走到了 09-20 深夜
fresh([['09:00', '10:00', 'A'], [D2, '09:30', '10:30', 'B']]);
say('把今天的安排复制到明天');
mockNow = at(D2, '23:00');
say('重叠');
const pasted = App.Manager.tasksOfDate(D2).filter(t => t.title === 'A')[0];
check('副本已标 done（09-20 10:00 早过了）',
  pasted && pasted.status === 'done', pasted && pasted.status);
check('播报里带过去说明', /已经过了时间，先记为已完成/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);
mockNow = at(D1, '00:00');

console.log('\n=== 12. 取消 / 无效回复 ===');
fresh([['09:00', '10:00', 'A'], [D2, '09:30', '10:30', 'B']]);
say('把今天的安排复制到明天');
changedCount = 0;
say('取消');
check('取消后目标日原样', JSON.stringify(day(D2)) === JSON.stringify(['B 09:30-10:30']),
  JSON.stringify(day(D2)));
check('  一条都没写库（changed 0 次）', changedCount === 0, changedCount);
check('  待确认态已清空', App.Controller.pending === null);
check('  播报了取消', /已取消复制/.test(chat[chat.length - 1] || ''), chat[chat.length - 1]);

fresh([['09:00', '10:00', 'A'], [D2, '09:30', '10:30', 'B']]);
say('把今天的安排复制到明天');
bubbles.length = 0;
say('随便说点什么');
check('无效回复：待确认态保留', App.Controller.pending !== null);
check('  气泡提示三个出口', /回复「重叠」「更换」或「取消」/.test(bubbles[0] || ''), bubbles[0]);
check('  没有写库', JSON.stringify(day(D2)) === JSON.stringify(['B 09:30-10:30']));

console.log('\n=== 13. 提交前重查：pending 期间源任务被标成 done ===');
fresh([['09:00', '10:00', 'A'], [D2, '09:30', '10:30', 'B']]);
say('把今天的安排复制到明天');
App.Manager.tasksOfDate(D1)[0].status = 'done';       // catchup 之类的副作用
changedCount = 0;
say('重叠');
check('没有把已完成的任务复制过去', App.Manager.tasksOfDate(D2).length === 1,
  JSON.stringify(day(D2)));
check('  播报了「都已经完成」', /都已经完成/.test(chat[chat.length - 1] || ''),
  chat[chat.length - 1]);
check('  没写库', changedCount === 0, changedCount);

console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
process.exit(fail ? 1 : 0);
