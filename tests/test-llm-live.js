/*
 * 联网冒烟测试：dialog/llm.js 接**真实** Ollama（默认 http://127.0.0.1:11434 + qwen3:4b）
 *
 * 与 test-llm.js 的分工：
 *   test-llm.js      —— fetch 全打桩，毫秒级，管逻辑与契约（提交前必跑）
 *   test-llm-live.js —— 真连模型，一两分钟，管「提示词 + format 约束是否真能管住 qwen3」
 *                       （改提示词、换模型、升 Ollama 之后跑一次）
 *
 * 跑之前：
 *   ollama serve                        桌面版在托盘里跑着也算
 *   ollama pull qwen3:4b
 * 浏览器里用 file:// 打开才需要 OLLAMA_ORIGINS=*；本测试走 Node，不受同源策略限制。
 *
 * 运行：
 *   node tests/test-llm-live.js
 *   OLLAMA_ENDPOINT=http://192.168.1.9:11434 OLLAMA_MODEL=qwen3:8b node tests/test-llm-live.js
 *
 * 连不上或没 pull 模型 → 打印跳过原因，退出码 0，不拖累离线回归。
 * 硬断言失败 → 退出码 1；软断言（模型措辞类）只提醒，不影响退出码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');
const ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b';

/* 冻结时钟：2026-10-09 是周五，20:30 —— 「明天」= 2026-10-10，断言才有确定期望值 */
const TODAY = '2026-10-09';
const TOMORROW = '2026-10-10';

/* ---------------- 沙箱 ---------------- */

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setInterval = setInterval;
sandbox.clearInterval = clearInterval;
sandbox.JSON = JSON; sandbox.Object = Object; sandbox.Array = Array;
sandbox.String = String; sandbox.Number = Number; sandbox.Math = Math;
sandbox.Date = Date; sandbox.RegExp = RegExp; sandbox.Set = Set; sandbox.Map = Map;
sandbox.Promise = Promise; sandbox.Error = Error;
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.TextDecoder = TextDecoder;
sandbox.AbortController = AbortController;
sandbox.fetch = fetch;                       // ← 与离线测试唯一的实质差别：真网络
sandbox.location = { search: '?time=20:30&date=' + TODAY + '&freeze=1' };
sandbox.addEventListener = () => {};
sandbox.document = {
  readyState: 'loading',
  addEventListener: () => {},
  activeElement: null,
  getElementById: () => null,
  body: { classList: { add() {}, remove() {}, toggle() {} }, style: {} },
  createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, dataset: {},
                          appendChild() {}, setAttribute() {} })
};
sandbox.window.App = {};

const store = {};
sandbox.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
sandbox.window.App.Storage = {
  load: () => ({ tasks: [], meta: { summaryDates: {}, suppressed: [] } }),
  save: () => {}
};

/* App.Settings 留空：llm.js 内部有空值保护，测试也不碰设置面板 */
sandbox.window.App.Settings = null;

/* DOM 层桩：记录调用 + 记流式首字时间（模型首 token 延迟就看这个） */
const log = { pet: [], system: [], error: [], stream: [], temp: [], bubble: [] };
sandbox.window.App.Output = {
  pet: (html, opts) => { log.pet.push({ html: String(html), mood: opts && opts.mood }); },
  system: t => { log.system.push(String(t)); },
  error: h => { log.error.push(String(h)); },
  user: () => {},
  stream: opts => {
    const h = { text: '', firstAt: null, t0: Date.now(), closed: false, errored: false, opts: opts };
    log.stream.push(h);
    return {
      append: c => { if (h.firstAt === null) h.firstAt = Date.now(); h.text += String(c); },
      end: t => { h.closed = true; if (t != null) h.text = String(t); },
      error: e => { h.errored = true; h.errorHtml = String(e); },
      text: () => h.text
    };
  }
};
sandbox.window.App.Bubble = { say: t => { log.bubble.push(String(t)); } };
sandbox.window.App.StateMachine = {
  enqueueTemp: (type, taskId, ms, opts) => { log.temp.push({ type, taskId, ms, opts }); },
  endTemp: type => { log.temp.push({ end: type }); return true; },
  isBusy: () => false
};
/* App.Controller 不打桩：app.js 自己定义，正好验证「模型意图 → 真实 doAdd → 入库」 */

vm.createContext(sandbox);
const load = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
load('app.js');
load('schedule/manager.js');
load('dialog/input.js');
load('dialog/llm.js');

const App = sandbox.App;
App.Clock.init();
App.Manager.init();
const LLM = App.LLM;

/* 偷看模型给出的意图，同时让真实处理器照常执行。
   注意 opts 必须原样转发——漏掉的话 {confirm:true} 被吃掉，
   确认门就被静默绕过了，测试会「通过」一个根本不存在的直接入库行为 */
const captured = { intents: [] };
const realRoute = App.Controller.routeIntent.bind(App.Controller);
App.Controller.routeIntent = function (intent, opts) {
  captured.intents.push(intent);
  return realRoute(intent, opts);
};

/* ---------------- 断言 ---------------- */

let pass = 0, fail = 0, warn = 0;
const C = { red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m', reset: '\x1b[0m' };

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log(C.red + '  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '') + C.reset); }
}
/* 模型措辞类断言：失败只提醒，不让退出码变红 —— 同一句话换个说法不算 bug */
function soft(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { warn++; console.log(C.yellow + '  ⚠ ' + name + (extra !== undefined ? '  -> ' + extra : '') + C.reset); }
}
function skip(reason, hint) {
  console.log(C.yellow + '\n⊘ 跳过：' + reason + C.reset);
  if (hint) console.log('  ' + hint);
}
function ms(t0) { return ((Date.now() - t0) / 1000).toFixed(1) + 's'; }
const snip = s => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, 120);

/* ---------------- 探活（不走被测代码，先判断值不值得跑） ---------------- */

function preflight() {
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, 3000);
  return fetch(ENDPOINT + '/api/tags', { signal: ac.signal }).then(
    res => {
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      return res.json().then(d => ({
        ok: true,
        names: ((d && d.models) || []).map(m => String((m && (m.name || m.model)) || ''))
      }));
    },
    e => {
      clearTimeout(timer);
      return { ok: false, error: (e && e.name === 'AbortError') ? '超时（3s）' : String((e && e.message) || e) };
    }
  );
}

/* 走一次完整的用户通路：tryRoute → 队列 → 真实处理器 / 聊天 */
function say(text) {
  captured.intents.length = 0;
  log.pet.length = 0; log.system.length = 0; log.error.length = 0;
  log.stream.length = 0; log.temp.length = 0; log.bubble.length = 0;
  const t0 = Date.now();
  const took = LLM.tryRoute(text);
  return LLM.whenIdle().then(() => ({ took: took, ms: Date.now() - t0 }));
}

/* ---------------- 主流程 ---------------- */

(async function main() {
  console.log('本地模型实测：' + ENDPOINT + '  模型 ' + MODEL + '\n');

  const pf = await preflight();
  if (!pf.ok) {
    skip('连不上 Ollama —— ' + pf.error, '先启动 Ollama（桌面版托盘图标 / ollama serve），再确认地址：' + ENDPOINT);
    return finish();
  }
  console.log('  Ollama 在线，本地已有 ' + pf.names.length + ' 个模型');
  if (pf.names.indexOf(MODEL) < 0) {
    skip('没找到模型 ' + MODEL, '先 `ollama pull ' + MODEL + '`，或用 OLLAMA_MODEL=xxx 指定。已装：' + (pf.names.join(', ') || '（空）'));
    return finish();
  }

  /* ============ 1. 探活与配置 ============ */
  console.log('\n=== 1. 探活 ===');
  const t1 = Date.now();
  const r1 = await LLM.applyConfig({ enabled: true, endpoint: ENDPOINT, model: MODEL });
  check('状态 ok', LLM.status === 'ok', LLM.status + ' / ' + (r1 && r1.error));
  check('模型清单里有 ' + MODEL, LLM.models.indexOf(MODEL) >= 0, LLM.models.join(', '));
  console.log(C.gray + '  探活耗时 ' + ms(t1) + C.reset);
  if (LLM.status !== 'ok') { skip('探活没过，后面没法跑', '把上面的错误信息带上，先解决连通性'); return finish(); }

  /* ============ 2. 意图 → 确认门 → 真实入库 ============ */
  console.log('\n=== 2. 加日程：意图提取 + 确认门 + 真实 doAdd ===');
  const ADD = '帮我把明天下午三点到四点的项目评审会议记一下';
  let res = await say(ADD);
  console.log(C.gray + '  输入：' + ADD + '\n  意图：' + JSON.stringify(captured.intents[0] || null) + C.reset);
  check('走的是意图路径（没当成闲聊）', captured.intents.length === 1,
    captured.intents.length ? '' : '模型判成了闲聊，回复：' + snip(log.stream[0] && log.stream[0].text));
  check('闲聊渲染没被启动', log.stream.length === 0, String(log.stream.length));
  check('挂起待确认（模型的理解没直接落库）',
    !!App.Controller.pending && App.Controller.pending.type === 'confirm-intent',
    JSON.stringify(App.Controller.pending && App.Controller.pending.type));
  check('确认框复述了模型的理解',
    log.pet.some(p => /项目评审/.test(p.html) && /明天/.test(p.html)),
    JSON.stringify(log.pet.map(p => snip(p.html))));
  check('确认前一条日程都不写', App.Manager.tasksOfDate(TOMORROW).length === 0,
    String(App.Manager.tasksOfDate(TOMORROW).length));

  App.Controller.handle('确认');            // 走真实入口回确认
  const added = App.Manager.tasksOfDate(TOMORROW);
  check('落到明天的日程（只一条）', added.length === 1, JSON.stringify(added.map(x => x.title)));
  if (added[0]) {
    check('时间与标题都还原对了',
      added[0].startTime === '15:00' && added[0].endTime === '16:00' && added[0].title.indexOf('项目评审') === 0,
      [added[0].startTime, added[0].endTime, added[0].title].join(' '));
    check('分类按工作类关键词', added[0].category === 'working', added[0].category);
  }
  check('走了既有播报通路', log.pet.some(p => /已添加/.test(p.html)), JSON.stringify(log.pet.map(p => snip(p.html))));
  console.log(C.gray + '  这一步耗时 ' + (res.ms / 1000).toFixed(1) + 's（超 ' +
    (App.Config.llm.intentTimeoutMs / 1000) + 's 会被判超时）' + C.reset);
  soft('没贴到超时线上（< 20s）', res.ms < 20000, (res.ms / 1000).toFixed(1) + 's');

  /* ============ 3. 闲聊：流式 + 不泄漏 ============ */
  console.log('\n=== 3. 闲聊：先说名字 ===');
  const before = App.Manager.all().length;
  res = await say('我叫小明，你叫什么名字？');
  const reply1 = (log.stream[0] && log.stream[0].text) || '';
  console.log(C.gray + '  意图：' + JSON.stringify(captured.intents[0] || 'chat') +
    '\n  回复：' + snip(reply1) + '\n  耗时：' + (res.ms / 1000).toFixed(1) + 's' +
    '，首字 ' + (log.stream[0] && log.stream[0].firstAt ? ((log.stream[0].firstAt - log.stream[0].t0) / 1000).toFixed(1) + 's' : '—') + C.reset);
  check('走的是聊天路径', log.stream.length === 1, String(log.stream.length));
  check('有实际回复', reply1.trim().length > 0, snip(reply1));
  check('闲聊不建日程', App.Manager.all().length === before, before + ' → ' + App.Manager.all().length);
  check('talking 态开出又收掉',
    log.temp.some(t => t.type === 'talking' && t.opts && t.opts.loop) && log.temp.some(t => t.end === 'talking'),
    JSON.stringify(log.temp));
  check('回复后播 done', log.temp.some(t => t.type === 'done'), JSON.stringify(log.temp.map(t => t.type || t.end)));

  /* format 约束失效的典型症状：把 schema、思考过程当正文吐出来 */
  check('没有泄漏 JSON 骨架', reply1.indexOf('"reply"') < 0 && reply1.indexOf('{') < 0, snip(reply1));
  check('没有泄漏思考过程', !/<think|<\/think|思考过程|内心|系统提示|用户消息/i.test(reply1), snip(reply1));
  soft('回复长度合理（≤ 300 字）', reply1.length <= 300, reply1.length + ' 字');
  soft('首字够快（< 5s）', !!log.stream[0] && log.stream[0].firstAt &&
    (log.stream[0].firstAt - log.stream[0].t0) < 5000,
    log.stream[0] && log.stream[0].firstAt ? ((log.stream[0].firstAt - log.stream[0].t0) / 1000).toFixed(1) + 's' : '没有流式片段');

  /* ============ 4. 多轮记忆 ============ */
  console.log('\n=== 4. 多轮：还记得名字吗 ===');
  res = await say('我刚才说我叫什么？');
  const reply2 = (log.stream[0] && log.stream[0].text) || '';
  console.log(C.gray + '  回复：' + snip(reply2) + C.reset);
  check('把上文带进了请求（历史非空）', LLM.Chat.history.length >= 4, String(LLM.Chat.history.length));
  soft('答得出「小明」', reply2.indexOf('小明') >= 0, snip(reply2));

  /* ============ 5. 查询意图 → 真实 doQuery ============ */
  console.log('\n=== 5. 看日程：查询意图走真实 doQuery ===');
  res = await say('我今天还有什么安排？');
  const petHtml = log.pet.map(p => p.html).join('\n');
  console.log(C.gray + '  意图：' + JSON.stringify(captured.intents[0] || null) +
    '\n  播报：' + snip(petHtml.replace(/<[^>]+>/g, ' ')) + C.reset);
  check('识别成 query（不是什么都要建日程）',
    captured.intents.length === 1 && captured.intents[0].intent === 'query', JSON.stringify(captured.intents));
  soft('查的是「今天」', captured.intents[0] && captured.intents[0].date === TODAY,
    captured.intents[0] && captured.intents[0].date);
  check('没建新日程', App.Manager.all().length === before, before + ' → ' + App.Manager.all().length);
  check('走了既有 doQuery 播报', /项安排|没有.*安排/.test(petHtml), snip(petHtml));

  /* ============ 5b. 聊天通路里带没带日程上下文 ============ */
  console.log('\n=== 5b. 聊天上下文：模型答得用得上日程吗 ===');
  const sysPrompt = LLM.chatSystem();
  check('系统提示里列着明天那条会议', /项目评审/.test(sysPrompt), snip(sysPrompt));
  log.stream.length = 0;
  await LLM.Chat.send('我明天有什么要做的？');
  const reply4 = (log.stream[0] && log.stream[0].text) || '';
  console.log(C.gray + '  回复：' + snip(reply4) + C.reset);
  soft('答到了那条会议（上下文真被用上）', /评审|会议/.test(reply4), snip(reply4));

  /* ============ 6. 闲聊不落库 ============ */
  console.log('\n=== 6. 分类质量：明显闲聊不落库 ===');
  res = await say('给我讲个冷笑话吧');
  console.log(C.gray + '  意图：' + JSON.stringify(captured.intents[0] || 'chat') +
    '\n  回复：' + snip((log.stream[0] && log.stream[0].text) || '') + C.reset);
  check('当成聊天（没建日程）', captured.intents.length === 0 && App.Manager.all().length === before,
    JSON.stringify(captured.intents) + ' / ' + App.Manager.all().length + ' 条');

  /* ============ 7. 问事实：提示词不许答非所问 ============ */
  /* 这题真栽过：旧提示词只说「回答日程相关问题时以上面的安排为准」，
     日程上下文一长，qwen3:4b 把「现在几点」答成「你好呀！今天…进行中」。
     软断言不卡措辞（八点半 / 20:30 / 晚上8点30分都算对），只卡「答的是时间本身」 */
  console.log('\n=== 7. 问事实：现在几点 ===');
  res = await say('现在几点');
  const reply5 = (log.stream[0] && log.stream[0].text) || '';
  console.log(C.gray + '  回复：' + snip(reply5) + C.reset);
  check('走的是聊天路径', log.stream.length === 1, String(log.stream.length));
  soft('答的是时间本身（20:30 / 8:30 的各种写法，或八点半）',
    /(20|8)\s*[：:.点]\s*3?0|八点半/.test(reply5), snip(reply5));

  return finish();
})().catch(e => {
  console.log(C.red + '\n测试自身抛异常：' + (e && e.stack || e) + C.reset);
  fail++;
  finish();
});

function finish() {
  console.log('\n--- 结果：' + pass + ' 通过 / ' + fail + ' 失败' + (warn ? ' / ' + warn + ' 提醒' : '') + ' ---');
  if (!pass) console.log('（没跑起来，跳过不代表通过）');
  else if (!fail) console.log('（' + ENDPOINT + ' / ' + MODEL + '）');
  process.exitCode = fail ? 1 : 0;
}
