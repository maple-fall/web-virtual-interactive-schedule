/*
 * 预览生成物：用浏览器里的 pdf.js 把模板 PDF 渲染成 PNG，便于目视检查排版
 * 运行： node tools/preview-template.js
 * 输出： tools/_shot/schedule_template.png（临时产物，可随时删）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'desktop-pet');
const PDF = path.join(ROOT, 'data', 'schedule_template.pdf');
const OUT_DIR = path.join(__dirname, '_shot');
const OUT = path.join(OUT_DIR, 'schedule_template.png');
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
const PORT = 9334;
const PROFILE = path.join(OUT_DIR, 'profile');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/')
  ], { stdio: 'ignore' });
  const kill = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
  process.on('exit', kill);

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = list.find(t => t.type === 'page' && t.url.indexOf('index.html') >= 0);
      } catch {}
    }
    if (!target) throw new Error('调试端口未就绪');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const waiting = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq; waiting.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');

    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', { expression: '!!window.pdfjsLib', returnByValue: true });
      if (r.result.value) break;
      await sleep(250);
    }

    const b64 = fs.readFileSync(PDF).toString('base64');
    const r = await send('Runtime.evaluate', {
      expression: `(async () => {
        const s = atob(${JSON.stringify(b64)});
        const u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        const pdf = await pdfjsLib.getDocument({ data: u }).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 2 });
        const cv = document.createElement('canvas');
        cv.width = vp.width; cv.height = vp.height;
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        return cv.toDataURL('image/png');
      })()`,
      awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception.description || r.exceptionDetails.text);
    const dataUrl = r.result.value;
    fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('已渲染预览：' + OUT);
  } catch (e) {
    console.error('渲染失败：' + e.message);
    process.exitCode = 1;
  }

  kill();
  await sleep(1000);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
})();
