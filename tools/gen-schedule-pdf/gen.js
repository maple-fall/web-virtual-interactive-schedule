/*
 * gen-schedule-pdf/gen.js — 一次性生成「安排表导入模板」（PDF + CSV）
 * 应用本身不做运行时生成：产物 desktop-pet/data/schedule_template.pdf 直接提交进仓库，
 * 「下载模板」按钮下载的就是它。CSV 一并写出，作为格式参考与回归测试样本。
 * 两份输出共用同一份行数据，保证内容一致（回环测试依赖这一点）。
 *
 * 用法：在仓库根目录执行 npm run gen:pdf
 */
'use strict';

var fs = require('fs');
var path = require('path');
var PDFDocument = require('pdfkit');

var ROOT = path.resolve(__dirname, '..', '..');
var OUT_PDF = path.join(ROOT, 'desktop-pet', 'data', 'schedule_template.pdf');
var OUT_CSV = path.join(ROOT, 'desktop-pet', 'data', 'schedule_template.csv');
var OUT_JS = path.join(ROOT, 'desktop-pet', 'schedule', 'scheduleTemplate.js');

/* ---------------- 中文字体 ---------------- */

// 优先单文件 TTF：.ttc 是字体集合，fontkit 打开时取哪个面不稳定，只作兜底
var FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/simfang.ttf',
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/msyh.ttc'
];

function pickFont() {
  for (var i = 0; i < FONT_CANDIDATES.length; i++) {
    if (fs.existsSync(FONT_CANDIDATES[i])) return FONT_CANDIDATES[i];
  }
  throw new Error('未找到可用的中文字体，请手动指定：' + FONT_CANDIDATES.join(' / '));
}

/* ---------------- 模板内容（PDF 与 CSV 共用） ---------------- */

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function dateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function daysFromNow(n) {
  var d = new Date();
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

// 示例日期按生成日推算，避免模板放久了示例日期过期、导入时报「日期已过去」
var D1 = daysFromNow(7);
var D2 = daysFromNow(12);
var D3 = daysFromNow(13);

var ROWS = [
  { date: D1, start: '09:00', end: '10:30', title: '英语听力训练', category: 'studying' },
  { date: D2, start: '19:00', end: '20:00', title: '项目周会,第三会议室', category: 'working' },
  { date: D3, start: '23:00', end: '00:30(+1)', title: '夜间实验收尾', category: 'working' },
  { date: '工作日', start: '08:30', end: '09:00', title: '晨读背诵', category: 'studying' },
  { date: '工作日', start: '09:30', end: '11:30', title: '写代码', category: 'working' },
  { date: '周一', start: '14:00', end: '15:30', title: '高等数学复习', category: '' },
  { date: '周三', start: '14:00', end: '15:30', title: '英语精读', category: '' },
  { date: '每天', start: '12:10', end: '12:50', title: '午休', category: 'general' },
  { date: '每天', start: '22:30', end: '23:00', title: '睡前复盘', category: '' },
  { date: '周末', start: '10:00', end: '11:30', title: '兴趣手绘', category: '' }
];

// PDF 顶部说明区。每行都是独立一行文本（lineBreak:false 不折行），
// 行首带 # ：导入时按「以 # 开头的整行」自动忽略，不会当成日程
var PDF_NOTES = [
  '# 使用说明',
  '# 1. 用 WPS / Adobe 打开本文件，直接在表格里填；填好后回应用点「导入安排表」选本 PDF。',
  '# 2. date ：YYYY-MM-DD 具体日期，或规则词：每天 / 工作日 / 周末 / 周一 ~ 周日',
  '# 3. start：24 小时制 HH:MM，必填。end：可留空（默认 60 分钟），跨天写成 00:30(+1)',
  '# 4. title：任务名称，单元格里可以带逗号。',
  '#    category：studying / working / general（也可写 学习 / 工作 / 通用），留空按标题自动判断',
  '# 5. 表格之外的文字（本说明区、页脚）导入时自动忽略，不会变成日程。',
  '# 6. 每个单元格请保持单行，不要手动换行；列的位置也不要改动。',
  '# 7. 带规则词的行（工作日 / 每天 / 周一 …）导入时会展开成未来 14 天的具体安排。',
  '# 8. 下面的示例日期按模板生成日推算，实际使用时请改成你自己的日期。'
];

var CSV_NOTES_BEFORE = [
  '# ===== 使用说明 =====',
  '# date  : YYYY-MM-DD 具体日期，或规则词：每天 / 工作日 / 周末 / 周一~周日',
  '# start : 24 小时制 HH:MM，必填',
  '# end   : 可留空（默认 60 分钟）；跨天写成 00:30(+1)',
  '# title : 任务名称。单元格里可以带逗号，PDF 导入时按列边界切分，无需引号',
  '# category: studying / working / general（也可写 学习 / 工作 / 通用），留空按标题自动判断',
  '# 以 # 开头的行是说明文字，不会导入',
  '# ===== 单次安排（示例日期按生成日推算，请改成你自己的日期）====='
];
var CSV_NOTE_RULES = '# ===== 周期规则（导入时自动展开为未来 14 天）=====';

/* ---------------- 输出 CSV ---------------- */

function csvCell(s) {
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvLine(r) {
  return [r.date, r.start, r.end, r.title, r.category].map(csvCell).join(',');
}

function writeCSV() {
  var lines = ['date,start,end,title,category'].concat(CSV_NOTES_BEFORE);
  var ruleStarted = false;
  ROWS.forEach(function (r) {
    // 前 3 行是具体日期，之后是周期规则
    if (!ruleStarted && r.date.indexOf('-') < 0) {
      lines.push(CSV_NOTE_RULES);
      ruleStarted = true;
    }
    lines.push(csvLine(r));
  });
  fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n', 'utf8');
}

/* ---------------- 输出 PDF ---------------- */

var PAGE_W = 595.28;                 // A4 纵向
var COLS = [
  { key: 'date',     label: 'date',     x: 36,  w: 90 },
  { key: 'start',    label: 'start',    x: 126, w: 55 },
  { key: 'end',      label: 'end',      x: 181, w: 65 },
  { key: 'title',    label: 'title',    x: 246, w: 220 },
  { key: 'category', label: 'category', x: 466, w: 90 }
];
var TABLE_RIGHT = COLS[COLS.length - 1].x + COLS[COLS.length - 1].w;   // 556
var PAD = 4;
var HEADER_H = 22;
var ROW_H = 20;
var LINE_COLOR = '#c8c8c8';
var MUTED = '#7a7a7a';

function drawTable(doc, top) {
  var tableBottom = top + HEADER_H + ROWS.length * ROW_H;

  // 表头底色
  doc.save().rect(COLS[0].x, top, TABLE_RIGHT - COLS[0].x, HEADER_H).fill('#ececec').restore();

  // 表头文字
  doc.fillColor('#222222').fontSize(10);
  COLS.forEach(function (c) {
    doc.text(c.label, c.x + PAD, top + 6, { width: c.w - PAD * 2, lineBreak: false });
  });

  // 横线（表头上下 + 每行下方）
  doc.lineWidth(0.6).strokeColor(LINE_COLOR);
  for (var i = 0; i <= ROWS.length + 1; i++) {
    var y = top + (i === 0 ? 0 : HEADER_H + (i - 1) * ROW_H);
    doc.moveTo(COLS[0].x, y).lineTo(TABLE_RIGHT, y).stroke();
  }
  // 竖线
  COLS.forEach(function (c) {
    doc.moveTo(c.x, top).lineTo(c.x, tableBottom).stroke();
  });
  doc.moveTo(TABLE_RIGHT, top).lineTo(TABLE_RIGHT, tableBottom).stroke();

  // 数据行：lineBreak:false 保证每格单行，单元格不会折行 —— 回导解析依赖这一点
  doc.fillColor('#111111').fontSize(10);
  ROWS.forEach(function (r, idx) {
    var y = top + HEADER_H + idx * ROW_H + 6;
    COLS.forEach(function (c) {
      doc.text(r[c.key] || '', c.x + PAD, y, { width: c.w - PAD * 2, lineBreak: false });
    });
  });

  return tableBottom;
}

function buildPDF(fontPath) {
  var doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    info: { Title: '安排表导入模板', Creator: '桌面虚拟宠物日程助手' }
  });
  doc.registerFont('cjk', fontPath);

  var stream = fs.createWriteStream(OUT_PDF);
  doc.pipe(stream);
  doc.font('cjk');

  // 标题
  doc.fillColor('#111111').fontSize(15);
  doc.text('安排表导入模板', 36, 44, { lineBreak: false });
  doc.fillColor(MUTED).fontSize(9);
  doc.text('桌面虚拟宠物日程助手 · 填好后用「导入安排表」选择本 PDF（也支持导入 CSV）',
    36, 68, { lineBreak: false });

  // 说明区
  var noteY = 94;
  doc.fontSize(8).fillColor(MUTED);
  PDF_NOTES.forEach(function (line) {
    doc.text(line, 36, noteY, { width: PAGE_W - 72, lineBreak: false });
    noteY += 13;
  });

  // 表格
  var tableBottom = drawTable(doc, noteY + 10);

  // 页脚
  doc.fontSize(8).fillColor(MUTED);
  doc.text('说明文字导入时自动忽略 · 表格外不要放数据；每个单元格保持单行。',
    36, tableBottom + 14, { width: PAGE_W - 72, lineBreak: false });

  doc.end();
  return new Promise(function (resolve, reject) {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

/* 把 PDF 字节内联成 schedule/scheduleTemplate.js，供「下载模板」按钮使用。

   为什么不能直接 <a href="data/schedule_template.pdf" download>：
   双击 index.html 走 file:// 协议，此时每个本地文件都是独立的 opaque origin，
   index.html 指向 data/ 下的 PDF 属于跨源 —— 按 HTML 规范，download 属性在跨源
   URL 上被忽略，链接退化成普通导航；Edge 有内置 PDF 阅读器，会直接把 PDF 渲染在
   当前标签页里，用户一个文件都拿不到（改用 CSV 时代之所以「能下载」，只是因为浏览器
   没法内联渲染 CSV，只好下载它，纯属巧合）。
   改成 Blob + URL.createObjectURL 触发下载即可：blob: 继承本文档的源，download 生效。
   但 file:// 下 fetch/XHR 读本地文件会被 CORS 拦死，所以字节必须随脚本一起加载。 */
function writeJS() {
  var b64 = fs.readFileSync(OUT_PDF).toString('base64');
  var lines = [
    '/*',
    ' * schedule/scheduleTemplate.js — 「下载模板」按钮用的模板 PDF 字节',
    ' *',
    ' * 【本文件由 gen-schedule-pdf/gen.js 生成，请勿手改】',
    ' * 与 data/schedule_template.pdf、data/schedule_template.csv 同一次生成写出，',
    ' * 三者内容必须一致；改动模板请重新生成：npm run gen:pdf（在仓库根目录执行）',
    ' *',
    ' * 内联成 base64 的原因见 gen.js 里 writeJS() 的注释：file:// 下 <a download> 指向',
    ' * 本地文件会因跨源而失效，只能把字节读进内存用 Blob 触发下载；而 file:// 下',
    ' * fetch/XHR 读本地文件被 CORS 拦截，所以字节只能跟着脚本走。',
    ' */',
    '(function () {',
    "  'use strict';",
    '  var App = window.App = window.App || {};',
    '  var cache = null;',
    '',
    '  App.ScheduleTemplate = {',
    "    fileName: 'schedule_template.pdf',",
    "    mime: 'application/pdf',",
    '    base64: ' + JSON.stringify(b64) + ',',
    '',
    '    /* 惰性解成 Blob 并缓存：连点多次不会重复解码这 ' + b64.length + ' 个字符 */',
    '    blob: function () {',
    '      if (!cache) {',
    '        var bin = window.atob(App.ScheduleTemplate.base64);',
    '        var bytes = new Uint8Array(bin.length);',
    '        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);',
    '        cache = new Blob([bytes], { type: App.ScheduleTemplate.mime });',
    '      }',
    '      return cache;',
    '    }',
    '  };',
    '})();',
    ''
  ];
  fs.writeFileSync(OUT_JS, lines.join('\n'), 'utf8');
  return b64.length;
}

/* ---------------- 主流程 ---------------- */

var fontPath = pickFont();
writeCSV();
buildPDF(fontPath).then(function () {
  var b64Len = writeJS();
  console.log('字体    : ' + fontPath);
  console.log('示例日期: ' + D1 + ' / ' + D2 + ' / ' + D3);
  console.log('已写出  : ' + OUT_CSV);
  console.log('已写出  : ' + OUT_PDF);
  console.log('已写出  : ' + OUT_JS + '（base64 ' + b64Len + ' 字符）');
}).catch(function (e) {
  console.error('生成失败：' + e.message);
  process.exit(1);
});
