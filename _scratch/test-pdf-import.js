/*
 * 无头测试：验证 schedule/pdfImporter.js 的 PDF → CSV → 日程 回环
 * 覆盖：模板 PDF 能被解析、中文保真、跨天 (+1)、含逗号标题、规则词展开，
 *       以及「走 PDF」与「直接读 CSV」两条路径的解析结果完全一致（重构无损）。
 * 前置：先跑 npm run gen:pdf 生成模板
 * 运行： node _scratch/test-pdf-import.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const ROOT = path.join(__dirname, '..', 'desktop-pet');
const PDF_PATH = path.join(ROOT, 'data', 'schedule_template.pdf');
const CSV_PATH = path.join(ROOT, 'data', 'schedule_template.csv');

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.JSON = JSON; sandbox.Object = Object; sandbox.Array = Array;
sandbox.String = String; sandbox.Number = Number; sandbox.Math = Math;
sandbox.Date = Date; sandbox.RegExp = RegExp; sandbox.Set = Set;
sandbox.Promise = Promise; sandbox.Error = Error; sandbox.TypeError = TypeError;
// 与宿主同源的二进制类型：pdf.js 在宿主 realm 里跑，跨 realm 的 ArrayBuffer 会被判成非二进制
sandbox.ArrayBuffer = ArrayBuffer; sandbox.Uint8Array = Uint8Array;
sandbox.URLSearchParams = URLSearchParams;
sandbox.location = { search: '' };
sandbox.document = { readyState: 'loading', addEventListener: () => {} };
sandbox.window.App = {};
sandbox.pdfjsLib = pdfjsLib;   // pdfImporter.js 在 IIFE 里就取 window.pdfjsLib

vm.createContext(sandbox);
const load = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
load('app.js');
load('schedule/parser.js');
load('schedule/pdfImporter.js');

// Node 侧没有 DOM，pdf.js 改用 require 加载 worker，路径必须是包内可解析的绝对路径。
// 覆盖掉 pdfImporter.js 里给浏览器准备的相对路径（浏览器里相对 index.html 解析）。
pdfjsLib.GlobalWorkerOptions.workerSrc =
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.js');

const App = sandbox.App;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const NOW = Date.now();                       // 模板刚生成，示例日期都在未来
const today = new Date(NOW);
const pad2 = n => (n < 10 ? '0' + n : '' + n);
const dstr = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

function asArrayBuffer(file) {
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// 未来 14 天窗口（与 App.Config.materializeDays 一致）内各类日期的天数
function windowCounts() {
  const c = { all: 0, weekday: 0, weekend: 0, mon: 0, wed: 0 };
  for (let d = 0; d <= 14; d++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + d);
    const wd = day.getDay();
    c.all++;
    if (wd >= 1 && wd <= 5) c.weekday++;
    if (wd === 0 || wd === 6) c.weekend++;
    if (wd === 1) c.mon++;
    if (wd === 3) c.wed++;
  }
  return c;
}

(async () => {
  console.log('\n=== 1. 模板 PDF 解析 ===');
  const res = await App.PdfImporter.import(asArrayBuffer(PDF_PATH), NOW);
  check('fatal 为空', res.fatal === null, res.fatal);
  if (res.fatal) { console.log('\n--- 结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败 ---\n'); process.exit(1); }
  check('没有跳过的错误行', res.errors.length === 0,
    JSON.stringify(res.errors));
  check('说明文字行被忽略', (res.warnings[0] && /说明文字/.test(res.warnings[0].message)),
    JSON.stringify(res.warnings));

  const c = windowCounts();
  const expect = 3 + 2 * c.all + 2 * c.weekday + c.mon + c.wed + c.weekend;
  check('条目数 = 3 单次 + 2×每天 + 2×工作日 + 周一 + 周三 + 周末 = ' + expect,
    res.rows.length === expect, res.rows.length);

  const titles = res.rows.map(r => r.title);
  check('中文标题保真（英语听力训练）', titles.indexOf('英语听力训练') >= 0);
  check('中文标题保真（晨读背诵）', titles.indexOf('晨读背诵') >= 0);
  check('含逗号的标题按单元格边界切分', titles.indexOf('项目周会,第三会议室') >= 0,
    JSON.stringify(titles.filter(t => t.indexOf('项目') >= 0)));
  check('说明文字没被当成任务', !titles.some(t => /使用说明|导入安排表|WPS/.test(t)));

  const cross = res.rows.filter(r => r.title === '夜间实验收尾')[0];
  check('跨天 23:00 → 00:30(+1)', cross && cross.endTime === '00:30' && cross.endOffset === 1,
    cross ? cross.endTime + ' / offset=' + cross.endOffset : '未找到');

  const noCat = res.rows.filter(r => r.title === '高等数学复习')[0];
  check('category 留空按标题猜类别', noCat && noCat.category === 'studying',
    noCat && noCat.category);

  console.log('\n=== 2. 与直接读 CSV 等价（PDF → CSV 重构无损）===');
  const csvRes = App.Parser.parseCSV(fs.readFileSync(CSV_PATH, 'utf8'), NOW);
  check('CSV 路径本身没有错误', csvRes.fatal === null && csvRes.errors.length === 0,
    csvRes.fatal || JSON.stringify(csvRes.errors));
  const key = r => [r.date, r.startTime, r.endTime, r.endOffset, r.title, r.category].join('|');
  const a = res.rows.map(key).sort();
  const b = csvRes.rows.map(key).sort();
  check('两条路径的日程逐条一致（共 ' + b.length + ' 条）',
    JSON.stringify(a) === JSON.stringify(b),
    a.length + ' vs ' + b.length + ' 不一致：' +
    JSON.stringify(a.filter(x => b.indexOf(x) < 0).slice(0, 3)));

  const dates = res.rows.map(r => r.date).sort();
  check('展开日期都在今天之后', dates[0] >= dstr(today), dates[0]);

  console.log('\n=== 3. 异常输入 ===');
  const empty = await App.PdfImporter.import(new ArrayBuffer(0), NOW);
  check('空数据 → fatal', !!empty.fatal, empty.fatal);
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  const bad = await App.PdfImporter.import(junk, NOW);
  check('随机字节 → fatal', !!bad.fatal, bad.fatal);

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
