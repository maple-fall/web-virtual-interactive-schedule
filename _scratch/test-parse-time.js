/*
 * 无头测试：验证 dialog/input.js 的自然语言时间解析
 * 重点覆盖「起点 到 终点」区间，尤其是终点省略时段前缀的情况
 * 运行： node _scratch/test-parse-time.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.JSON = JSON; sandbox.Object = Object; sandbox.Array = Array;
sandbox.String = String; sandbox.Number = Number; sandbox.Math = Math;
sandbox.Date = Date; sandbox.RegExp = RegExp; sandbox.Set = Set;
sandbox.URLSearchParams = URLSearchParams;
sandbox.location = { search: '' };
// boot() 挂在 DOMContentLoaded 上，本测试只取纯函数，不触发
sandbox.document = { readyState: 'loading', addEventListener: () => {} };
sandbox.window.App = {};

vm.createContext(sandbox);
const load = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
load('app.js');
load('dialog/input.js');

const App = sandbox.App;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

// 固定「今天」= 2026-09-19（周六），明天 = 09-20
const TODAY = '2026-09-19';
const TOMORROW = '2026-09-20';
const at = now => ({ now: new Date(now + 'T10:00:00') });
const parse = text => App.Input.parse(text, at(TODAY));

// 断言一条新增指令解析成期望的 {date, start, end, title}
function expectAdd(text, want) {
  const r = parse(text);
  if (!r.ok) { check(text, false, 'ok=false reason=' + r.reason); return; }
  const got = r.date + ' ' + r.startTime + '-' + r.endTime + ' 《' + r.title + '》';
  const exp = want.date + ' ' + want.start + '-' + want.end + ' 《' + want.title + '》';
  check(text, got === exp, got + '  ≠  ' + exp);
}

console.log('\n=== 1. 区间终点省略时段前缀（本次修复的 bug）===');
expectAdd('明天下午2点到4点开会', { date: TOMORROW, start: '14:00', end: '16:00', title: '开会' });
expectAdd('明天下午两点到四点开会', { date: TOMORROW, start: '14:00', end: '16:00', title: '开会' });
expectAdd('明天下午2点到4点半开会', { date: TOMORROW, start: '14:00', end: '16:30', title: '开会' });
expectAdd('明天上午9点到11点数学复习', { date: TOMORROW, start: '09:00', end: '11:00', title: '数学复习' });
expectAdd('明天晚上7点到9点看电影', { date: TOMORROW, start: '19:00', end: '21:00', title: '看电影' });
expectAdd('明天中午12点到1点吃饭', { date: TOMORROW, start: '12:00', end: '13:00', title: '吃饭' });
expectAdd('明天下午3点至5点写周报', { date: TOMORROW, start: '15:00', end: '17:00', title: '写周报' });

console.log('\n=== 1b. 「晚」单字也要当真（本次修复的 bug）===');
expectAdd('晚8点到9点学习英语', { date: TODAY, start: '20:00', end: '21:00', title: '学习英语' });
expectAdd('今晚8点到9点学习英语', { date: TODAY, start: '20:00', end: '21:00', title: '学习英语' });
expectAdd('明晚8点到9点学习英语', { date: TOMORROW, start: '20:00', end: '21:00', title: '学习英语' });
expectAdd('晚11点到1点值守', { date: TODAY, start: '23:00', end: '01:00', title: '值守' });

console.log('\n=== 2. 终点自带时段前缀（不受影响）===');
expectAdd('明天下午2点到下午4点开会', { date: TOMORROW, start: '14:00', end: '16:00', title: '开会' });
expectAdd('明天上午10点到下午3点实训', { date: TOMORROW, start: '10:00', end: '15:00', title: '实训' });

console.log('\n=== 3. 真想跨夜的说法不被误改 ===');
expectAdd('明天晚上10点到2点值班', { date: TOMORROW, start: '22:00', end: '02:00', title: '值班' });
expectAdd('明天晚上11点到1点夜班', { date: TOMORROW, start: '23:00', end: '01:00', title: '夜班' });
expectAdd('明天下午4点到2点盘点', { date: TOMORROW, start: '16:00', end: '02:00', title: '盘点' });

console.log('\n=== 4. 两端都无时段前缀（24 小时制直读）===');
expectAdd('明天9点到11点数学复习', { date: TOMORROW, start: '09:00', end: '11:00', title: '数学复习' });
expectAdd('明天14点到16点复盘', { date: TOMORROW, start: '14:00', end: '16:00', title: '复盘' });

console.log('\n=== 5. 非区间：时长与默认时长 ===');
expectAdd('明天下午2点开会', { date: TOMORROW, start: '14:00', end: '15:00', title: '开会' });
expectAdd('明天下午2点开会1个半小时', { date: TOMORROW, start: '14:00', end: '15:30', title: '开会' });

console.log('\n=== 6. 终点带分钟、起点带分钟 ===');
expectAdd('明天下午2点15到3点45面试', { date: TOMORROW, start: '14:15', end: '15:45', title: '面试' });
expectAdd('明天早上8点半到10点跑步', { date: TOMORROW, start: '08:30', end: '10:00', title: '跑步' });

console.log('\n=== 7. 跨天：起点自己就是次日 ===');
expectAdd('明天晚上十二点交作业', { date: TOMORROW, start: '00:00', end: '01:00', title: '交作业' });
const nd = parse('晚上十二点交作业');
check('无日期 + 晚上十二点 → 落到次日',
  nd.ok && nd.date === TOMORROW && nd.startTime === '00:00',
  nd.date + ' ' + nd.startTime);

console.log('\n=== 8. 修改句的时段继承（既有逻辑回归）===');
const up = parse('把明天下午三点的会议改成四点');
check('「改成四点」继承下午 → 16:00',
  up.ok && up.patches && up.patches.startTime === '16:00',
  up.ok ? JSON.stringify(up.patches) : up.reason);

console.log('\n=== 9. 删除 / 查询不回归 ===');
const del = parse('删掉明天下午2点的开会');
check('删除识别到标题与时间',
  del.ok && del.intent === 'delete' && del.title === '开会' && del.startTime === '14:00',
  del.ok ? JSON.stringify({ t: del.title, s: del.startTime }) : del.reason);
const q = parse('明天有什么安排');
check('查询识别为 date 范围', q.ok && q.intent === 'query' && q.date === TOMORROW,
  q.ok ? JSON.stringify(q.query) : q.reason);

console.log('\n=== 10. 整日复制：把某天的安排复制到另一天 ===');
// 约定沿用 update：date = 目标日（搬到哪），targetDate = 源日（从哪搬）
function expectCopy(text, want) {
  const r = parse(text);
  if (!r.ok) { check(text, false, 'ok=false reason=' + r.reason); return; }
  const got = r.intent + ' 源=' + r.targetDate + ' 目标=' + r.date;
  const exp = 'copy 源=' + want.src + ' 目标=' + want.dst;
  check(text, got === exp, got + '  ≠  ' + exp);
}
expectCopy('把9月20日的安排复制到9月25日', { src: TOMORROW, dst: '2026-09-25' });
expectCopy('把周二的安排拷贝到周三', { src: '2026-09-22', dst: '2026-09-23' });
expectCopy('把明天的安排抄到后天', { src: TOMORROW, dst: '2026-09-21' });
expectCopy('把安排复制到9月25日', { src: TODAY, dst: '2026-09-25' });   // 左边不写日期 = 今天
expectCopy('把9月30日的安排复制到10月3日', { src: '2026-09-30', dst: '2026-10-03' });
const cp = parse('把明天的安排复制到周五');
check('复制意图不带时间/标题（整日搬运）',
  cp.ok && cp.startTime === null && cp.title === null, JSON.stringify(cp.title));

console.log('\n=== 10b. 复制的反例 ===');
const nc1 = parse('把明天的安排复制到');
check('没写目标日 → copy_no_target', !nc1.ok && nc1.reason === 'copy_no_target',
  nc1.ok ? 'ok=true' : nc1.reason);
const nc2 = parse('把明天的安排复制明天');
check('「复制明天」不带「到」→ 不认', !nc2.ok && nc2.reason === 'copy_no_target',
  nc2.ok ? 'ok=true intent=' + nc2.intent : nc2.reason);
const nc3 = parse('把明天下午三点的会议复制到周五');
check('写了单条名字 → copy_day_only 拦住', !nc3.ok && nc3.reason === 'copy_day_only',
  nc3.ok ? 'ok=true' : nc3.reason);
check('copy_day_only 给了复制例句',
  nc3.examples && nc3.examples.length > 0 && /复制到/.test(nc3.examples[0]),
  JSON.stringify(nc3.examples));

console.log('\n=== 11. 复制分支不抢别的意图（回归）===');
const rUp1 = parse('把明天的会议挪到周五');
check('「挪到」仍是 update', rUp1.ok && rUp1.intent === 'update',
  rUp1.ok ? rUp1.intent : rUp1.reason);
const rUp2 = parse('把明天的会议改到周五');
check('「改到」仍是 update', rUp2.ok && rUp2.intent === 'update',
  rUp2.ok ? rUp2.intent : rUp2.reason);
const rDel = parse('删掉明天的英语课');
check('「删掉」仍是 delete', rDel.ok && rDel.intent === 'delete',
  rDel.ok ? rDel.intent : rDel.reason);
const rAdd = parse('明天下午两点开会');
check('普通新增仍是 add', rAdd.ok && rAdd.intent === 'add',
  rAdd.ok ? rAdd.intent : rAdd.reason);
const rAdd2 = parse('晚上8点抄作业');
check('「抄作业」不被当成复制', rAdd2.ok && rAdd2.intent === 'add' && rAdd2.title === '抄作业',
  rAdd2.ok ? rAdd2.intent + '/' + rAdd2.title : rAdd2.reason);
const rQ = parse('明天有什么安排');
check('查询仍是 query', rQ.ok && rQ.intent === 'query', rQ.ok ? rQ.intent : rQ.reason);

console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
process.exit(fail ? 1 : 0);
