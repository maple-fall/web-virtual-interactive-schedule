/*
 * 全套离线回归入口：把 12 个无头套件挨个起子进程跑一遍，汇总成一张表。
 * 每个套件自己打印「N 通过 / M 失败」并以退出码表态，这里只负责收集。
 *
 * 默认**不**收录那两个「要真东西」的套件，它们各自单独跑更合适：
 *   e2e-pdf-import.js   需要真实 Edge，会开关浏览器
 *   test-llm-live.js    需要真实 Ollama，一两分钟
 * 要连它们一起跑： node tests/run.js --all
 *
 * 运行： node tests/run.js     或   npm test
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

/* 顺序：从「纯逻辑」到「越界越多」，失败时先看到最可能的元凶 */
const OFFLINE = [
  'test-parse-time.js',
  'test-copy-day.js',
  'test-query.js',
  'test-bulk-edit.js',
  'test-pip.js',
  'test-character-pack.js',
  'test-stage-background.js',
  'test-wallpaper.js',
  'test-warn-reminders.js',
  'test-pdf-import.js',
  'test-timetable-import.js',
  'test-llm.js'
];
const EXTRA = ['e2e-pdf-import.js', 'test-llm-live.js'];

/* 两种汇总行格式都要认：
 *   --- 结果：48 通过 / 0 失败 ---      （数字在「通过」前）
 *   ✓ 通过 169 项，失败 0 项            （数字在「通过」后）
 */
function pick(text, word) {
  const m = text.match(new RegExp('(\\d+)\\s*' + word)) ||
            text.match(new RegExp(word + '\\s*(\\d+)'));
  return m ? Number(m[1] || m[2]) : null;
}

const list = process.argv.indexOf('--all') >= 0 ? OFFLINE.concat(EXTRA) : OFFLINE;

let passed = 0, failed = 0;
console.log('');
for (const file of list) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  const n = pick(out, '通过'), m = pick(out, '失败');

  if (ok) passed++; else failed++;
  console.log((ok ? '  ok  ' : '  !!  ') + file.padEnd(26) +
    (n === null ? '（没打印汇总行）' : n + ' 通过 / ' + (m === null ? '?' : m) + ' 失败'));

  /* 失败时把关键几行摘出来，省得再手跑一遍才发现是崩了还是断言挂了 */
  if (!ok) {
    const lines = out.split('\n')
      .filter(l => /✗|失败|Error|error:|at .*\.js:\d+/.test(l))
      .slice(0, 10);
    if (lines.length) console.log(lines.map(l => '        ' + l.trim()).join('\n'));
  }
}

if (list.length > 1) {
  console.log('\n' + (failed ? '✗ ' : '✓ ') + list.length + ' 个套件，' +
    passed + ' 个通过、' + failed + ' 个失败\n');
}
process.exit(failed ? 1 : 0);
