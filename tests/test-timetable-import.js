/*
 * 无头测试：验证「教务系统网格课表 PDF → 日程」的解析与展开
 * 样本：desktop-pet/data/xxx课表.pdf（90° 旋转的星期×节次网格，
 *       STSong-Light 标准字体、无内嵌 ToUnicode，必须靠内置 CMap 才提得出文字）
 * 覆盖：CMap 提取、跨页续接、单双周、折行标题、场地写进 title、节次→时间映射、
 *       学期起始日推断、过去课程过滤，以及「模板 PDF 不走课表分支」的回归。
 * 前置：在仓库根目录 npm install
 * 运行： node tests/test-timetable-import.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* pdfjs-dist 是 dev 依赖，不在仓库里。缺了要给一句人话，而不是 MODULE_NOT_FOUND 堆栈 */
let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
} catch (e) {
  console.log('\n--- 结果：0 通过 / 1 失败 ---\n');
  console.error('缺少 pdfjs-dist：请先在仓库根目录执行 npm install');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', 'desktop-pet');
const TT_PDF = path.join(ROOT, 'data', 'xxx课表.pdf');
const TPL_PDF = path.join(ROOT, 'data', 'schedule_template.pdf');

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.JSON = JSON; sandbox.Object = Object; sandbox.Array = Array;
sandbox.String = String; sandbox.Number = Number; sandbox.Math = Math;
sandbox.Date = Date; sandbox.RegExp = RegExp; sandbox.Set = Set;
sandbox.Promise = Promise; sandbox.Error = Error; sandbox.TypeError = TypeError;
sandbox.ArrayBuffer = ArrayBuffer; sandbox.Uint8Array = Uint8Array;
sandbox.URLSearchParams = URLSearchParams;
sandbox.atob = atob;                       // lib/pdfjs/cmaps.js 解 base64 用
sandbox.location = { search: '' };
sandbox.document = { readyState: 'loading', addEventListener: () => {} };
sandbox.window.App = {};
sandbox.pdfjsLib = pdfjsLib;

vm.createContext(sandbox);
const load = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
load('app.js');
load('schedule/parser.js');
load('lib/pdfjs/cmaps.js');                // 用真实产物测，别在测试里另造一份
load('schedule/timetableImporter.js');
load('schedule/pdfImporter.js');

pdfjsLib.GlobalWorkerOptions.workerSrc =
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.js');

const App = sandbox.App;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const TERM = '2026-08-31';                 // 该课表第 1 周周一（按打印日期 2026-09-19 推断）
const NOW_BEFORE = new Date(2026, 7, 30).getTime();   // 开学前一天：无过去过滤
const TPL_NOW = new Date('2026-09-20T09:00:00').getTime();  // 模板基准日：早于模板里所有写死的日期
const TOTAL = 275;                         // 全部课程展开后的节次数（手算核对）

function asArrayBuffer(file) {
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// 课程日期 -> 第几周（第 1 周周一为 TERM）
function weekOf(dateStr) {
  const mon = App.util.parseDateStr(TERM);
  const d = App.util.parseDateStr(dateStr);
  return Math.floor((d - mon) / 86400000 / 7) + 1;
}

// 样本是个人课表，可能不在仓库里；缺了就跳过依赖它的 1-6 组，7-8 组照跑
const hasSample = fs.existsSync(TT_PDF);

async function templateGroups() {
  console.log('\n=== 7. 回归：模板 PDF 不走课表分支 ===');
  /* 时钟钉死：模板里那三条单次日程是写死的日期，用 Date.now() 跑的话
     它们迟早变成「已过去」被跳过，条数断言就会莫名其妙变少。
     和 test-pdf-import.js 用同一个基准日，两个测试的期望值才对得上。 */
  const tpl = await App.PdfImporter.import(asArrayBuffer(TPL_PDF), TPL_NOW);
  check('模板仍然按五列表格解析', tpl.fatal === null && !tpl.timetable, tpl.fatal || 'timetable=' + !!tpl.timetable);
  check('模板解析出 62 条', tpl.rows.length === 62, tpl.rows.length);

  console.log('\n=== 8. 异常输入 ===');
  const junk = await App.PdfImporter.import(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, NOW_BEFORE);
  check('随机字节 → fatal', !!junk.fatal, junk.fatal);
  const empty = await App.PdfImporter.import(new ArrayBuffer(0), NOW_BEFORE);
  check('空数据 → fatal', !!empty.fatal, empty.fatal);
}

(async () => {
  if (!hasSample) {
    console.log('\n=== 1-6. 课表 PDF 解析：跳过 ===');
    console.log('  样本不在：' + path.relative(path.join(__dirname, '..'), TT_PDF));
    console.log('  那是教务系统导出的个人课表，不便入库；放回同名文件后本组自动恢复。');
    await templateGroups();
    console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败（1-6 组已跳过）---\n');
    process.exit(fail ? 1 : 0);
  }

  console.log('\n=== 1. 课表 PDF 识别 ===');
  const res = await App.PdfImporter.import(asArrayBuffer(TT_PDF), NOW_BEFORE);
  check('fatal 为空', res.fatal === null, res.fatal);
  if (res.fatal) { console.log('\n--- 结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败 ---\n'); process.exit(1); }
  check('走了课表分支（不是五列表格）', Array.isArray(res.timetable), typeof res.timetable);
  check('识别出 23 门课', res.timetable.length === 23, res.timetable.length);
  check('没有解析失败的课程', res.errors.length === 0, JSON.stringify(res.errors));

  const titles = res.timetable.map(e => e.title);
  check('title = 课程名 + 教室，校区后缀已去掉',
    titles.indexOf('软件测试与管理 H4-413') >= 0,
    JSON.stringify(titles.filter(t => /软件测试/.test(t))));
  check('折行的课程名拼接完整',
    titles.indexOf('习近平新时代中国特色社会主义思想概论 H4-411') >= 0,
    JSON.stringify(titles.filter(t => /习近平/.test(t))));
  check('含全角括号的课程名保真',
    titles.indexOf('大学英语III（听说进阶） H4-505') >= 0,
    JSON.stringify(titles.filter(t => /英语/.test(t))));
  check('同格两门课都识别出来（数字孪生 单/双周）',
    titles.filter(t => /数字孪生/.test(t)).length === 2,
    JSON.stringify(titles.filter(t => /数字孪生/.test(t))));
  check('表外文字没被当成课程',
    !titles.some(t => /梁浩贤课表|学号|打印时间|使用说明/.test(t)));

  console.log('\n=== 2. 节次 → 时间映射 ===');
  const byTitle = t => res.timetable.filter(e => e.title.indexOf(t) === 0);
  const ds = byTitle('软件测试与管理 H1-305')[0];   // 星期一 3-4 节
  check('3-4节 → 10:40-12:00', ds && ds.startTime === '10:40' && ds.endTime === '12:00',
    ds && ds.startTime + '-' + ds.endTime);
  const db = byTitle('数据库系统原理 H3-204')[0];
  check('15-16节 → 20:30-21:50', db && db.startTime === '20:30' && db.endTime === '21:50',
    db && db.startTime + '-' + db.endTime);
  check('星期一 = weekday 1', ds && ds.weekday === 1, ds && ds.weekday);
  const tx = byTitle('体能训练 III')[0];
  check('星期五 = weekday 5', tx && tx.weekday === 5, tx && tx.weekday);

  console.log('\n=== 3. 学期起始日推断 ===');
  check('按「打印时间:2026-09-19」推断出第 1 周周一 = ' + TERM,
    res.termMonday === TERM, res.termMonday);
  check('标记为推断值（不是用户存过的）', res.termSource === 'guess', res.termSource);

  console.log('\n=== 4. 展开成日程 ===');
  const exp = App.TimetableImporter.expand(res.timetable, TERM, NOW_BEFORE);
  check('展开无 fatal', exp.fatal === null, exp.fatal);
  check('展开 ' + TOTAL + ' 条（学期尚未结束，无过滤）', exp.rows.length === TOTAL, exp.rows.length);
  check('没有跳过提示', exp.warnings.length === 0, JSON.stringify(exp.warnings));

  const rs = exp.rows;
  check('日程日期都不早于今天', rs.every(r => r.date >= '2026-08-30'));
  const one = rs.filter(r => r.title.indexOf('软件测试与管理') === 0 && r.date === '2026-09-01')[0];
  check('星期二第 1 周 = 2026-09-01 09:00-10:20',
    one && one.startTime === '09:00' && one.endTime === '10:20',
    one ? one.date + ' ' + one.startTime + '-' + one.endTime : '未找到');
  check('周一第 1 周 = 2026-08-31', rs.some(r => r.date === '2026-08-31' && /软件测试/.test(r.title)));

  const single = rs.filter(r => /数字孪生/.test(r.title) && weekOf(r.date) % 2 === 1);
  const double = rs.filter(r => /数字孪生/.test(r.title) && weekOf(r.date) % 2 === 0);
  check('单周课程 9 次（1,3,…,17 周）', single.length === 9, single.length);
  check('双周课程 9 次（2,4,…,18 周）', double.length === 9, double.length);

  const weeks = rs.map(r => weekOf(r.date));
  check('周次范围 1-18', Math.min(...weeks) === 1 && Math.max(...weeks) === 18,
    Math.min(...weeks) + '-' + Math.max(...weeks));

  console.log('\n=== 5. 学期中导入：过去课程被过滤 ===');
  const NOW_MID = new Date(2026, 9, 15).getTime();     // 2026-10-15，学期中
  const mid = App.TimetableImporter.expand(res.timetable, TERM, NOW_MID);
  check('仍然是解析成功', mid.fatal === null, mid.fatal);
  check('行数 + 跳过数 = ' + TOTAL + '（没有凭空多出或丢掉）',
    mid.rows.length + parseInt((mid.warnings[0] || {}).message.replace(/\D/g, '') || 0, 10) === TOTAL,
    mid.rows.length + ' + ' + JSON.stringify(mid.warnings));
  check('剩下的课都在 2026-10-15 之后', mid.rows.every(r => r.date >= '2026-10-15'));
  check('给出了跳过提示', mid.warnings.length === 1, JSON.stringify(mid.warnings));

  console.log('\n=== 6. 日期修正（用户回复新的第 1 周周一）===');
  const shifted = App.TimetableImporter.expand(res.timetable, '2026-09-07', NOW_BEFORE);
  check('换起始日不报错', shifted.fatal === null, shifted.fatal);
  check('日期整体平移 7 天（周一第 1 周 08-31 → 09-07）',
    shifted.rows.length === exp.rows.length &&
    shifted.rows.some(r => r.date === '2026-09-07' && /软件测试/.test(r.title)),
    JSON.stringify(shifted.rows.filter(r => /软件测试/.test(r.title)).map(r => r.date).slice(0, 2)));
  check('非法日期 → fatal', !!App.TimetableImporter.expand(res.timetable, '八月三十一', NOW_BEFORE).fatal);

  await templateGroups();

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
