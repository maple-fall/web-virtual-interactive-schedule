/*
 * 浏览器端到端测试：真实 Edge 打开 file:// 页面，走完整「选文件 → 解析 → 确认导入」链路
 * 覆盖无头测试覆盖不到的部分：vendored pdf.min.js 能否在 file:// 下加载、
 * worker 创建失败后能否自动回退、FileReader.readAsArrayBuffer → importPDF 接线。
 * 运行： node _scratch/e2e-pdf-import.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'desktop-pet');
const INDEX = path.join(ROOT, 'index.html');
const PDF = path.join(ROOT, 'data', 'schedule_template.pdf');
const CSV = path.join(ROOT, 'data', 'schedule_template.csv');
const TIMETABLE = path.join(ROOT, 'data', '梁浩贤(2026-2027-1)课表.pdf');
// 浏览器路径：优先环境变量，再按常见位置找（避免硬编码到某台机器）
function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome，可用环境变量 BROWSER 指定路径');
}
const EDGE = findBrowser();
const PORT = 9333;
const PROFILE = path.join(__dirname, '_edge_pdf');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fileUrl = p => 'file:///' + p.replace(/\\/g, '/');

/* ---------------- 极简 CDP 客户端 ---------------- */

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.waiting = new Map(); this.logs = []; }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = e => reject(new Error('CDP 连接失败: ' + (e.message || e.type)));
    }).then(cdp => {
      cdp.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && cdp.waiting.has(msg.id)) {
          const { resolve, reject } = cdp.waiting.get(msg.id);
          cdp.waiting.delete(msg.id);
          msg.error ? reject(new Error(msg.method + ': ' + msg.error.message)) : resolve(msg.result);
        } else if (msg.method === 'Runtime.consoleAPICalled') {
          cdp.logs.push((msg.params.args || []).map(a => String(a.value ?? a.description ?? '')).join(' '));
        } else if (msg.method === 'Log.entryAdded') {
          cdp.logs.push('[log] ' + (msg.params.entry.text || ''));
        }
      };
      cdp.downloadDir = path.join(__dirname, '_shot', 'e2e-downloads');
      fs.rmSync(cdp.downloadDir, { recursive: true, force: true });
      fs.mkdirSync(cdp.downloadDir, { recursive: true });
      return cdp.send('Runtime.enable')
        .then(() => cdp.send('Log.enable'))
        .then(() => cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allow', downloadPath: cdp.downloadDir, eventsEnabled: true
        }))
        .then(() => cdp);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(method + ' 超时')); }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    return r.result.value;
  }
}

/* ---------------- 造一份「别的工具产出的」PDF ---------------- */

// 用 Edge 的「打印成 PDF」导出（Skia/PDFium + 系统雅黑字体，与 pdfkit + 黑体完全是两条路径），
// 模拟「用户拿自己的表格另存成 PDF 再导入」这种情况，验证提取不依赖 pdfkit 的产物特征
function makeForeignPDF(outFile, htmlFile) {
  const pad2 = n => (n < 10 ? '0' + n : '' + n);
  const dstr = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return dstr(d); };

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 48px; }
    body { font-family: "Microsoft YaHei", SimSun, sans-serif; font-size: 12px; }
    h1 { font-size: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #888; padding: 5px 8px; text-align: left; }
    th { background: #f0f0f0; }
  </style></head><body>
  <h1>我的课表（浏览器打印导出）</h1>
  <p>这段表格外的说明文字应该被忽略，不会变成日程。</p>
  <table>
    <colgroup><col style="width:20%"><col style="width:11%"><col style="width:11%"><col style="width:40%"><col style="width:18%"></colgroup>
    <tr><th>date</th><th>start</th><th>end</th><th>title</th><th>category</th></tr>
    <tr><td>${plus(3)}</td><td>14:00</td><td>15:40</td><td>数据结构（3-4节,教学楼A301）</td><td>studying</td></tr>
    <tr><td>${plus(5)}</td><td>19:30</td><td>20:30</td><td>项目周会,第3会议室</td><td>working</td></tr>
    <tr><td>${plus(6)}</td><td>23:00</td><td>00:30(+1)</td><td>夜间实验收尾</td><td>working</td></tr>
    <tr><td>每天</td><td>07:30</td><td>08:00</td><td>早读：英语单词</td><td></td></tr>
  </table>
  <p>表格结束后的文字同样应该被忽略。</p>
  </body></html>`;

  fs.mkdirSync(path.dirname(htmlFile), { recursive: true });
  fs.writeFileSync(htmlFile, html, 'utf8');
  const profile = path.join(path.dirname(htmlFile), 'foreign-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const r = spawnSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
    '--user-data-dir=' + profile,
    '--print-to-pdf=' + outFile,
    'file:///' + htmlFile.replace(/\\/g, '/')
  ], { stdio: 'ignore', timeout: 120000 });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  if (!fs.existsSync(outFile)) throw new Error('打印导出 PDF 失败: ' + (r.error || r.status));
}

/* ---------------- 页面内测试脚本 ---------------- */

function pageScript(pdfB64, csvText, foreignB64, timetableB64) {
  return `(async () => {
  const out = {};
  const toU8 = b64 => { const s = atob(b64); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const pdfBytes = toU8(${JSON.stringify(pdfB64)});
  const foreignBytes = toU8(${JSON.stringify(foreignB64)});
  const timetableBytes = toU8(${JSON.stringify(timetableB64)});
  const csvBytes = new TextEncoder().encode(${JSON.stringify(csvText)});
  const input = document.getElementById('file-csv');

  function feed(name, mime, u8) {
    const dt = new DataTransfer();
    dt.items.add(new File([u8], name, { type: mime }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function pending() {
    return !!(App.Controller.pending && App.Controller.pending.type === 'confirm-import');
  }
  async function waitPending(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await pending()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
  }
  async function say(text) {
    document.getElementById('chat-text').value = text;
    document.getElementById('chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 150));
  }

  out.version = (window.pdfjsLib && window.pdfjsLib.version) || null;
  out.accept = input.getAttribute('accept');

  // 「下载模板」不再是 <a href="本地文件" download>：file:// 下那属于跨源，
  // download 属性会被忽略、退化成导航，PDF 被内置阅读器渲染、一个文件都不落盘。
  // 现在走 App.ScheduleTemplate（内置字节）+ Blob，这里确认按钮与数据都就位。
  const tplBtn = document.getElementById('btn-template');
  out.templateBtn = !!tplBtn && tplBtn.tagName === 'BUTTON';
  out.templateStaleAnchor = !!document.querySelector('a[href*="schedule_template"]');
  out.templateFileName = (App.ScheduleTemplate || {}).fileName || null;
  out.templateBlobBytes = App.ScheduleTemplate ? App.ScheduleTemplate.blob().size : 0;
  // 点一下：应当产生一个 blob: 的下载，而不是把页面导航到 PDF
  if (tplBtn) tplBtn.click();
  await new Promise(r => setTimeout(r, 300));
  out.templateNavigated = !/index\.html$/.test(location.pathname);
  out.templateHrefBefore = location.href;

  // 听导入结果播报（handleImport 通过事件总线报「新增 N 条，跳过重复 M 条」）
  let lastMsg = '';
  App.bus.on('schedule:imported', p => { lastMsg = p.message; });

  // 1. 导入模板 PDF
  feed('schedule_template.pdf', 'application/pdf', pdfBytes);
  out.pdfPending = await waitPending(25000);
  out.pdfRows = out.pdfPending ? App.Controller.pending.rows.length : 0;
  out.pdfTitles = out.pdfPending ? App.Controller.pending.rows.slice(0, 3).map(r => r.title) : [];
  const before = App.Manager.all().length;
  if (out.pdfPending) await say('确认');
  out.added = App.Manager.all().length - before;
  out.total = App.Manager.all().length;
  out.firstMsg = lastMsg;

  // 2. 重复导入同一份 PDF → 全部按重复跳过
  feed('schedule_template.pdf', 'application/pdf', pdfBytes);
  out.dedupePending = await waitPending(25000);
  out.dedupeRows = out.dedupePending ? App.Controller.pending.rows.length : 0;
  const before2 = App.Manager.all().length;
  if (out.dedupePending) await say('确认');
  out.dedupeAdded = App.Manager.all().length - before2;
  out.dedupeMsg = lastMsg;

  // 3. CSV 路径回归：解析条数应与 PDF 路径一致，之后取消
  feed('schedule_template.csv', 'text/csv', csvBytes);
  out.csvPending = await waitPending(25000);
  out.csvRows = out.csvPending ? App.Controller.pending.rows.length : 0;
  if (out.csvPending) await say('取消');
  out.cancelled = !App.Controller.pending;

  // 4. 非表格 PDF（用 CSV 字节冒充 pdf）应给出明确失败提示
  feed('broken.pdf', 'application/pdf', csvBytes);
  await new Promise(r => setTimeout(r, 3000));
  out.brokenPending = await pending();
  out.brokenError = (document.querySelector('.chat-log') || {}).textContent || '';
  out.brokenHasError = /导入失败/.test(out.brokenError);

  // 5. 别的工具产出的 PDF（浏览器打印导出）也要能导入
  feed('foreign.pdf', 'application/pdf', foreignBytes);
  out.foreignPending = await waitPending(25000);
  out.foreignRows = out.foreignPending ? App.Controller.pending.rows.length : 0;
  out.foreignTitles = out.foreignPending ? App.Controller.pending.rows.map(r => r.title) : [];
  out.foreignErrors = out.foreignPending
    ? +(App.Controller.pending.report.match(/错误 (\\d+) 条/) || [0, -1])[1] : -1;
  if (out.foreignPending) await say('取消');

  // 6. 教务系统网格课表：选完文件直接进待确认，不额外问日期
  // 样本是个人课表、可能不在仓库里；没有就整组跳过（ttPending 留 undefined 作标记）
  if (timetableBytes.length) {
  feed('timetable.pdf', 'application/pdf', timetableBytes);
  out.ttPending = await waitPending(30000);
  out.ttReport = out.ttPending ? App.Controller.pending.report : '';
  out.ttRows = out.ttPending ? App.Controller.pending.rows.length : 0;
  out.ttHasTermInfo = out.ttPending ? !!App.Controller.pending.termInfo : false;
  out.ttTitles = out.ttPending ? App.Controller.pending.rows.map(r => r.title) : [];

  if (out.ttPending) {
    // 回复另一个第 1 周周一 -> 就地重算，不用重新选文件
    await say('2026-09-07');
    out.ttShifted = await pending();
    out.ttShiftedReport = out.ttShifted ? App.Controller.pending.report : '';
    out.ttShiftedRows = out.ttShifted ? App.Controller.pending.rows.length : 0;
    const datesAfter = out.ttShifted ? App.Controller.pending.rows.map(r => r.date) : [];
    out.ttShiftedMoved = datesAfter.some(d => d >= '2026-09-07') &&
      datesAfter.filter(d => d < '2026-09-07').length === 0;
    const before = App.Manager.all().length;
    await say('确认');
    out.ttAdded = App.Manager.all().length - before;
    out.ttMsg = lastMsg;
  }
  }

  return out;
})()`;
}

/* ---------------- 主流程 ---------------- */

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-features=Translate',
    fileUrl(INDEX)
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  };
  process.on('exit', cleanup);

  let cdp = null;
  try {
    // 等调试端口就绪
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = list.find(t => t.type === 'page' && t.url.indexOf('index.html') >= 0);
      } catch { /* 端口还没起来 */ }
    }
    if (!target) throw new Error('Edge 调试端口未就绪');

    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');

    // 等应用初始化完成
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = await cdp.eval('!!(window.App && App.Controller && App.PdfImporter)');
      if (!ready) await sleep(250);
    }
    check('应用脚本加载完成（含 pdfImporter）', ready);

    console.log('\n=== 1. 页面接线 ===');
    const downloadDir = cdp.downloadDir;
    const pdfB64 = fs.readFileSync(PDF).toString('base64');
    const csvText = fs.readFileSync(CSV, 'utf8');
    const foreignPDF = path.join(__dirname, '_shot', 'foreign-table.pdf');
    makeForeignPDF(foreignPDF, path.join(__dirname, '_shot', 'foreign-table.html'));
    const foreignB64 = fs.readFileSync(foreignPDF).toString('base64');
    const timetableB64 = fs.existsSync(TIMETABLE)
      ? fs.readFileSync(TIMETABLE).toString('base64') : '';
    const r = await cdp.eval(pageScript(pdfB64, csvText, foreignB64, timetableB64));

    check('vendored pdf.js 在 file:// 下加载成功（v' + r.version + '）', r.version === '3.11.174', r.version);
    check('「下载模板」是按钮而非 file:// 锚点（跨源会让 download 失效）',
      r.templateBtn && !r.templateStaleAnchor, 'btn=' + r.templateBtn + ' 残留锚点=' + r.templateStaleAnchor);
    check('模板字节已内置（App.ScheduleTemplate）', r.templateBlobBytes === 30396, r.templateBlobBytes);
    check('点击后没有导航走（旧的失败表现就是跳去看 PDF）', !r.templateNavigated, r.templateHrefBefore);

    const landed = path.join(downloadDir, 'schedule_template.pdf');
    for (let i = 0; i < 40 && !fs.existsSync(landed); i++) await sleep(250);   // 等落盘
    check('文件真的落盘了', fs.existsSync(landed),
      JSON.stringify(fs.readdirSync(downloadDir)));
    if (fs.existsSync(landed)) {
      const a = fs.readFileSync(landed), b = fs.readFileSync(PDF);
      check('落盘字节与 data/schedule_template.pdf 一致',
        a.length === b.length && a.equals(b), a.length + ' vs ' + b.length);
    }
    check('文件选择框同时接受 CSV 与 PDF', /pdf/.test(r.accept || '') && /csv/.test(r.accept || ''), r.accept);

    console.log('\n=== 2. 导入模板 PDF（真实文件选择事件）===');
    check('解析出待确认的导入', r.pdfPending);
    check('解析条数与无头测试一致（62 条）', r.pdfRows === 62, r.pdfRows);
    check('中文标题保真', r.pdfTitles.join(',') === '英语听力训练,项目周会,第三会议室,夜间实验收尾', r.pdfTitles.join(','));
    check('回复「确认」后入库', r.added === r.pdfRows && r.added > 0, '新增 ' + r.added);

    console.log('\n=== 3. 重复导入去重 ===');
    check('再次导入仍能解析', r.dedupePending);
    check('解析条数不变', r.dedupeRows === r.pdfRows, r.dedupeRows + ' vs ' + r.pdfRows);
    check('全部按重复跳过（一条都不新增）',
      r.dedupeAdded === 0 && /跳过重复 62/.test(r.dedupeMsg || ''),
      r.dedupeMsg);

    console.log('\n=== 4. CSV 路径回归 + 取消 ===');
    check('CSV 也能解析', r.csvPending);
    check('CSV 与 PDF 解析条数一致', r.csvRows === r.pdfRows, r.csvRows + ' vs ' + r.pdfRows);
    check('回复「取消」后不导入', r.cancelled);

    console.log('\n=== 5. 非表格 PDF 的失败提示 ===');
    check('没有进入待确认状态', r.brokenPending === false);
    check('聊天区显示「导入失败」', r.brokenHasError);

    console.log('\n=== 6. 别的工具产出的 PDF（浏览器打印导出）===');
    check('能解析（不依赖 pdfkit 的产物特征）', r.foreignPending);
    check('解析条数 = 3 单次 + 每天 15', r.foreignRows === 18, r.foreignRows);
    check('没有跳过的错误行', r.foreignErrors === 0, r.foreignErrors);
    check('中文标题保真', r.foreignTitles.indexOf('早读：英语单词') >= 0,
      JSON.stringify(r.foreignTitles.slice(0, 4)));
    check('含逗号、括号的标题保真',
      r.foreignTitles.indexOf('数据结构（3-4节,教学楼A301）') >= 0 &&
      r.foreignTitles.indexOf('项目周会,第3会议室') >= 0,
      JSON.stringify(r.foreignTitles.slice(0, 4)));
    check('表格外的说明文字没被当成任务',
      !r.foreignTitles.some(t => /说明文字|应该被忽略|课表/.test(t)));

    console.log('\n=== 7. 教务系统网格课表（梁浩贤课表，需内置 CMap）===');
    if (!timetableB64) {
      console.log('  ~ 跳过：data/梁浩贤(2026-2027-1)课表.pdf 不在仓库（个人课表），' +
        '放回同名文件即恢复');
    } else {
    check('选完文件直接进待确认（不再问学期日期）', r.ttPending);
    check('识别为课表并写进了报告', /识别为课表|门课/.test(r.ttReport || ''),
      (r.ttReport || '').slice(0, 60));
    check('报告里给出了推断的第 1 周周一', /2026-08-31/.test(r.ttReport || ''),
      (r.ttReport || '').match(/第 1 周按.*?计算/) || '');
    check('带上了 termInfo（支持回复日期重算）', r.ttHasTermInfo);
    check('展开出可导入的日程', r.ttRows > 0, r.ttRows);
    check('中文课程名保真', r.ttTitles.some(t => /软件测试与管理/.test(t)),
      JSON.stringify(r.ttTitles.slice(0, 3)));
    check('title 带教室地点', r.ttTitles.some(t => /(H1-305|H4-413)/.test(t)),
      JSON.stringify(r.ttTitles.slice(0, 3)));
    check('表外文字没混进来',
      !r.ttTitles.some(t => /梁浩贤课表|学号|打印时间|使用说明/.test(t)));

    check('回复别的日期能就地重算', r.ttShifted);
    check('重算后日期整体后移（没有早于 09-07 的课）', r.ttShiftedMoved);
    check('重算后仍可确认入库', r.ttAdded === r.ttShiftedRows && r.ttAdded > 0,
      '新增 ' + r.ttAdded + ' / 解析 ' + r.ttShiftedRows);
    }

    console.log('\n=== 控制台信息 ===');
    const workerWarn = cdp.logs.filter(l => /worker|Worker/.test(l));
    console.log('  · worker 相关日志 ' + workerWarn.length + ' 条' +
      (workerWarn.length ? '：' + workerWarn[0].slice(0, 100) : ''));
    const errs = cdp.logs.filter(l => /^\[log\]/.test(l));
    if (errs.length) console.log('  · 其他日志 ' + errs.length + ' 条');
  } catch (e) {
    fail++;
    console.log('  ✗ 测试中断：' + e.message);
  }

  cleanup();
  await sleep(1200);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}

  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败 ---\n');
  process.exit(fail ? 1 : 0);
})();
