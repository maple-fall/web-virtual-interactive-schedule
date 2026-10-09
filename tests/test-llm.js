/*
 * 无头测试：dialog/llm.js（本地大模型接入层）与 settings.js 的 llm 持久化
 * 全部离线：fetch 是桩，不连任何服务
 * 运行： node tests/test-llm.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'desktop-pet');

/* 固定时钟：2026-10-09 是周五，20:30 —— 与真实探测时的上下文一致，
   后面所有日期断言的期望值都以这天为基准算 */
const TODAY = '2026-10-09';
const TOMORROW = '2026-10-10';

/* ---------------- 沙箱 ---------------- */

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.JSON = JSON; sandbox.Object = Object; sandbox.Array = Array;
sandbox.String = String; sandbox.Number = Number; sandbox.Math = Math;
sandbox.Date = Date; sandbox.RegExp = RegExp; sandbox.Set = Set;
sandbox.Promise = Promise; sandbox.Error = Error;
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.TextDecoder = TextDecoder;
sandbox.AbortController = AbortController;
sandbox.location = { search: '?time=20:30&date=' + TODAY + '&freeze=1' };
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

/* localStorage / Storage 桩 */
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

/* DOM 层桩：只记录被调用，不做真渲染 */
const log = { pet: [], system: [], error: [], stream: [], temp: [], bubble: [], routes: [], user: [] };
sandbox.window.App.Output = {
  pet: (html, opts) => { log.pet.push({ html: String(html), mood: opts && opts.mood }); },
  system: t => { log.system.push(String(t)); },
  error: h => { log.error.push(String(h)); },
  user: t => { log.user.push(String(t)); },
  stream: opts => {
    const h = { text: '', closed: false, errored: false, opts: opts };
    log.stream.push(h);
    return {
      append: c => { h.text += String(c); },
      end: t => { h.closed = true; if (t != null) h.text = String(t); },
      error: e => { h.errored = true; h.errorHtml = String(e); },
      /* 复读守卫重问前会清屏重来（对应 output.js 的真实 reset） */
      reset: () => { h.text = ''; h.closed = false; h.resetCount = (h.resetCount || 0) + 1; },
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
sandbox.window.App.Settings = null;   // 由 settings.js 填充；llm.js 里做了空值保护
/* 注意：App.Controller 不在这里打桩——app.js 自己会定义它，桩会被覆盖。
   这样正好能验证「模型意图 -> 真实 do* 处理器 -> Manager 入库」这条完整通路 */

/* fetch 桩 */
const net = { calls: [], script: [] };     // script: 依次弹出的响应工厂
function stubRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
  };
}
function stubStream(lines) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => Promise.resolve(i < lines.length
          ? { done: false, value: new Uint8Array(Buffer.from(lines[i++] + '\n', 'utf8')) }
          : { done: true, value: undefined })
      })
    },
    text: () => Promise.resolve(lines.join('\n'))
  };
}
sandbox.fetch = function (url, init) {
  net.calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
  const next = net.script.shift();
  if (!next) return Promise.reject(new Error('fetch stub 没排到响应: ' + url));
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
};

vm.createContext(sandbox);
const load = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
load('app.js');
load('schedule/manager.js');
load('dialog/input.js');
load('dialog/llm.js');
load('settings.js');

const App = sandbox.App;
App.Clock.init();
App.Manager.init();

const LLM = App.LLM;

/* ---------------- 断言 ---------------- */

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(name, got, want) {
  check(name, got === want, JSON.stringify(got) + '  ≠  ' + JSON.stringify(want));
}
function reset() { net.calls.length = 0; net.script.length = 0; log.routes.length = 0; log.temp.length = 0; log.stream.length = 0; log.system.length = 0; log.pet.length = 0; log.bubble.length = 0; log.user.length = 0; }

/* 让排出去的 Promise 链跑完（探活 -> setStatus -> emit） */
function aTick() { return new Promise(r => setTimeout(r, 0)); }

/* ============================================================ */

console.log('\n=== 1. sanitizeConfig：端点白名单 + 模型名校验 ===');
const D = LLM.DEFAULTS;
eq('null -> 默认值（开关默认关）', JSON.stringify(LLM.sanitizeConfig(null)), JSON.stringify(D));
eq('enabled 只认显式 true', LLM.sanitizeConfig({ enabled: 'yes' }).enabled, false);
eq('相对路径端点回落', LLM.sanitizeConfig({ endpoint: '/api' }).endpoint, D.endpoint);
eq('公网地址被拒', LLM.sanitizeConfig({ endpoint: 'https://evil.com:11434' }).endpoint, D.endpoint);
eq('凭据被剔除', LLM.sanitizeConfig({ endpoint: 'http://u:p@127.0.0.1:11434' }).endpoint, 'http://127.0.0.1:11434');
eq('path/query 被剔除', LLM.sanitizeConfig({ endpoint: 'http://127.0.0.1:11434/x?y=1#z' }).endpoint, 'http://127.0.0.1:11434');
eq('非 http(s) 协议被拒', LLM.sanitizeConfig({ endpoint: 'ftp://127.0.0.1' }).endpoint, D.endpoint);
eq('localhost 放行', LLM.sanitizeConfig({ endpoint: 'http://localhost:11434' }).endpoint, 'http://localhost:11434');
eq('192.168.* 放行', LLM.sanitizeConfig({ endpoint: 'http://192.168.1.7:11434' }).endpoint, 'http://192.168.1.7:11434');
eq('172.16 放行', LLM.sanitizeConfig({ endpoint: 'http://172.16.0.9:11434' }).endpoint, 'http://172.16.0.9:11434');
eq('172.31 放行', LLM.sanitizeConfig({ endpoint: 'http://172.31.255.1:11434' }).endpoint, 'http://172.31.255.1:11434');
eq('172.15 拒绝', LLM.sanitizeConfig({ endpoint: 'http://172.15.0.9:11434' }).endpoint, D.endpoint);
eq('172.32 拒绝', LLM.sanitizeConfig({ endpoint: 'http://172.32.0.9:11434' }).endpoint, D.endpoint);
eq('10.* 放行', LLM.sanitizeConfig({ endpoint: 'http://10.0.0.2:11434' }).endpoint, 'http://10.0.0.2:11434');
eq('模型名带路径穿越被拒', LLM.sanitizeConfig({ model: '../x' }).model, D.model);
eq('模型名带空格被拒', LLM.sanitizeConfig({ model: 'a b' }).model, D.model);
eq('模型名首字符须是字母数字', LLM.sanitizeConfig({ model: ':4b' }).model, D.model);
eq('合法模型名保留', LLM.sanitizeConfig({ model: ' qwen3:4b ' }).model, 'qwen3:4b');

console.log('\n=== 2. mdToHtml：先转义后转换 ===');
check('script 标签被转义', LLM.mdToHtml('<script>alert(1)</script>').indexOf('<script>') < 0);
check('onerror 属性被转义',
  LLM.mdToHtml('<img src=x onerror=alert(1)>').indexOf('<img') < 0 &&
  LLM.mdToHtml('<img src=x onerror=alert(1)>').indexOf('&lt;img') >= 0);
eq('无序列表成组', LLM.mdToHtml('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>');
eq('有序列表成组', LLM.mdToHtml('1. 甲\n2. 乙'), '<ul><li>甲</li><li>乙</li></ul>');
eq('段落内换行成 <br>', LLM.mdToHtml('上一句\n下一句'), '<p>上一句<br>下一句</p>');
eq('空行分段', LLM.mdToHtml('甲\n\n乙'), '<p>甲</p><p>乙</p>');
eq('粗体', LLM.mdToHtml('这是**重点**哦'), '<p>这是<b>重点</b>哦</p>');
eq('行内代码', LLM.mdToHtml('试试 `ollama pull`'), '<p>试试 <code>ollama pull</code></p>');
eq('词内星号不吃成斜体（乘号）', LLM.mdToHtml('3*4=12 还没写完 **'), '<p>3*4=12 还没写完 **</p>');
eq('中文两侧的斜体照常生效', LLM.mdToHtml('这是*重点*哦'), '<p>这是<em>重点</em>哦</p>');
check('超长文本被截断', LLM.mdToHtml('啊'.repeat(5000)).length < 4500);

console.log('\n=== 3. 日期 / 时间归一化 ===');
const rd = t => LLM.resolveDateToken(t, TODAY);
eq('今天', rd('今天'), TODAY);
eq('明天', rd('明天'), TOMORROW);
eq('后天', rd('后天'), '2026-10-11');
eq('大后天', rd('大后天'), '2026-10-12');
eq('裸周五 = 本周五（今天）', rd('周五'), TODAY);
eq('周一 = 下周一（本周已过）', rd('周一'), '2026-10-12');
eq('下周（2026-10-09 是周五）', rd('下周三'), '2026-10-14');
eq('周日记作 0', rd('本周日'), '2026-10-11');
eq('ISO 日期', rd('2026-10-15'), '2026-10-15');
eq('ISO 带尾巴也能抠出来', rd('2026-10-15 下午'), '2026-10-15');
eq('超范围日期拒绝', rd('2030-01-01'), null);
eq('M月D号（未来）', rd('10月15日'), '2026-10-15');
eq('M月D号（已过 -> 明年）', rd('10月1日'), '2027-10-01');
eq('纯 garbage', rd('随便啦'), null);

eq('15:00', LLM.normalizeTime('15:00'), '15:00');
eq('全角冒号', LLM.normalizeTime('15：30'), '15:30');
eq('单数字分钟补零', LLM.normalizeTime('9:5'), '09:05');
eq('只有小时', LLM.normalizeTime('9'), '09:00');
eq('24:00 拒绝', LLM.normalizeTime('24:00'), null);
eq('25:00 拒绝', LLM.normalizeTime('25:00'), null);
eq('分钟 70 拒绝', LLM.normalizeTime('15:70'), null);
eq('非时间拒绝', LLM.normalizeTime('下午三点'), null);

console.log('\n=== 4. normalizeIntent：模型 schema -> input.js 契约 ===');
const N = (o, now) => LLM.normalizeIntent(o, now || Date.parse(TODAY + 'T20:30:00'));

let r = N({ intent: 'add', date: '明天', start: '15:00', end: '16:00', title: '项目评审会议' });
eq('add 全部字段', [r.intent, r.date, r.startTime, r.endTime, r.title, r.category].join('|'),
  ['add', TOMORROW, '15:00', '16:00', '项目评审会议', 'working'].join('|'));
eq('add 未给结束时间走默认时长', N({ intent: 'add', start: '15:00', title: '开会' }).endTime, '16:00');
eq('add 默认时长记入 defaultsUsed',
  JSON.stringify(N({ intent: 'add', start: '15:00', title: '开会' }).defaultsUsed), '["endTime"]');
eq('add 缺时间 -> null', N({ intent: 'add', date: '明天', title: '开会' }), null);
eq('add 缺标题 -> null', N({ intent: 'add', date: '明天', start: '15:00' }), null);
eq('add 时间非法 -> null', N({ intent: 'add', start: '25:00', title: '开会' }), null);
eq('add 娱乐标题归类 entertainment',
  N({ intent: 'add', start: '20:00', title: '玩游戏' }).category, 'entertainment');
eq('add 学习标题归类 studying', N({ intent: 'add', start: '09:00', title: '数学复习' }).category, 'studying');
eq('add 日期认不出 -> 今天', N({ intent: 'add', date: '某个时候', start: '09:00', title: '开会' }).date, TODAY);

r = N({ intent: 'update', targetDate: '今天', targetTitle: '英语课', patch: { start: '16:00' } });
eq('update 定位与补丁', [r.intent, r.targetDate, r.target.titleFrag, r.target.startTime, r.patches.startTime].join('|'),
  ['update', TODAY, '英语课', null, '16:00'].join('|'));
eq('update 无补丁 -> null', N({ intent: 'update', targetTitle: '英语课' }), null);
eq('update 无定位 -> null', N({ intent: 'update', patch: { start: '16:00' } }), null);
eq('update 补丁日期能改日',
  N({ intent: 'update', targetTitle: '英语课', patch: { date: '后天' } }).patches.date, '2026-10-11');

r = N({ intent: 'delete', date: '明天', title: '英语课' });
eq('delete 定位', [r.intent, r.date, r.target.titleFrag, r.startTime].join('|'),
  ['delete', TOMORROW, '英语课', null].join('|'));
eq('delete 什么都没说 -> null', N({ intent: 'delete' }), null);
eq('delete 只有时间也算定位', N({ intent: 'delete', date: '明天', start: '14:30' }).target.startTime, '14:30');

r = N({ intent: 'query', date: '今天' });
eq('query scope=date', r.query.scope, 'date');
eq('query 无日期 -> 今天/today', N({ intent: 'query' }).query.scope, 'today');

r = N({ intent: 'copy', from: '明天', to: '本周五' });
eq('copy from/to', [r.date, r.targetDate].join('|'), [TODAY, TOMORROW].join('|'));
eq('copy 缺 to -> null', N({ intent: 'copy', from: '明天' }), null);
eq('未知 intent -> null', N({ intent: 'sing', title: 'x' }), null);
eq('非对象 -> null', N('chat'), null);

console.log('\n=== 5. parseNdjson：分块/半行/垃圾行 ===');
let st = { buf: '' };
eq('半行留到下一块', LLM.parseNdjson(st, '{"message":{"content":"甲"}}').length, 0);
eq('补齐后两块一起出（先缓冲的那行不会丢）', LLM.parseNdjson(st, '\n{"message":{"content":"乙"}}\n').length, 2);
st = { buf: '' };
eq('多行一次给', LLM.parseNdjson(st, '{"a":1}\n{"a":2}\n').length, 2);
eq('垃圾行被丢', LLM.parseNdjson({ buf: '' }, 'not json\n{"a":1}\n').length, 1);
eq('空行被丢', LLM.parseNdjson({ buf: '' }, '\n\n{"a":1}\n').length, 1);
eq('error 事件透出', LLM.parseNdjson({ buf: '' }, '{"error":"model not found"}\n')[0].error, 'model not found');

console.log('\n=== 6. replyReader：{"reply": "…"} 增量解码 ===');
function feedAll(json, size) {
  const r = LLM.replyReader();
  for (let i = 0; i < json.length; i += size) r.feed(json.slice(i, i + size));
  return r;
}
eq('整段', feedAll('{"reply":"你好呀"}', 99).text(), '你好呀');
eq('逐字符喂', feedAll('{"reply":"你好呀"}', 1).text(), '你好呀');
eq('转义换行', feedAll('{"reply":"上句\\n下句"}', 1).text(), '上句\n下句');
eq('转义引号', feedAll('{"reply":"他说\\"好\\""}', 1).text(), '他说"好"');
eq('unicode 转义', feedAll('{"reply":"\\u4f60\\u597d"}', 1).text(), '你好');
eq('前面的空白/字段名不受影响', feedAll('{ "reply" : "嗯嗯" }', 1).text(), '嗯嗯');
eq('值没收完时给到一半', feedAll('{"reply":"半句话', 1).text(), '半句话');

console.log('\n=== 7. healthCheck：探活永不 throw ===');
(async () => {
  reset();
  net.script.push(stubRes(200, { models: [{ name: 'qwen3:4b' }, { name: 'qwen3:1.7b' }] }));
  let h = await LLM.applyConfig({ enabled: true, endpoint: D.endpoint, model: 'qwen3:4b' });   // 开开关即探活
  eq('探活成功', h.ok, true);
  eq('模型列表', LLM.models.join(','), 'qwen3:4b,qwen3:1.7b');
  eq('状态 ok', LLM.status, 'ok');
  eq('探活打的是 /api/tags', /\/api\/tags$/.test(net.calls[0].url), true);

  reset();
  net.script.push(stubRes(500, {}));
  h = await LLM.recheck();
  eq('HTTP 500 -> 未连接', LLM.status, 'unreachable');
  eq('HTTP 500 不抛', h.ok, false);

  reset();
  net.script.push(new Error('ECONNREFUSED'));
  h = await LLM.recheck();
  eq('网络异常 -> 未连接', LLM.status, 'unreachable');

  /* 端点通了但模型没装：必须判成独立状态，否则每条消息都白发给一个不存在的模型、
     每条都收 404，用户等半天只等到一句「没太听懂」 */
  reset();
  net.script.push(stubRes(200, { models: [{ name: 'qwen3:1.7b' }] }));
  h = await LLM.recheck();
  eq('端点通但没这个模型 -> missing', LLM.status, 'missing');
  eq('missing 时探活本身仍算成功', h.ok, true);
  eq('missing 时留着模型列表（面板要用来提示已装了哪些）', LLM.models.join(','), 'qwen3:1.7b');
  eq('missing 时不接管消息', LLM.canRoute(), false);
  eq('missing 时 isUsable 为假', LLM.isUsable(), false);
  eq('missing 时 ensureReady 为假（走离线文案）', await LLM.ensureReady(), false);
  eq('missing 时提示说清是没装模型、并给出可照做的命令',
    /还没安装/.test(LLM.hintText()) && /ollama pull/.test(LLM.hintText()) && /qwen3:4b/.test(LLM.hintText()), true);

  /* 一个模型都没装 */
  reset();
  net.script.push(stubRes(200, { models: [] }));
  await LLM.recheck();
  eq('一个模型都没装也算 missing', LLM.status, 'missing');

  /* 模型名改了要能自己恢复：missing 不是死状态 */
  reset();
  net.script.push(stubRes(200, { models: [{ name: 'qwen3:4b' }] }));
  h = await LLM.applyConfig({ enabled: true, model: 'qwen3:4b' });
  eq('换回已装的模型名 -> 恢复 ok', LLM.status, 'ok');
  eq('恢复后能接管消息', LLM.canRoute(), true);

  /* 非 Ollama 的兼容端点：有 /api/chat 没有 /api/tags，读到 404 不能当成连不上 */
  reset();
  net.script.push(stubRes(404, {}));
  h = await LLM.recheck();
  eq('tags 404 -> 仍算连上', LLM.status, 'ok');
  eq('tags 404 时探活成功', h.ok, true);
  eq('tags 404 时列表为空但不报错', LLM.models.length, 0);
  eq('tags 404 时读不到列表就跳过模型检查', LLM.canRoute(), true);

  console.log('\n=== 8. 开关关闭 = 零网络请求，且沿用原文案 ===');
  reset();
  LLM.applyConfig({ enabled: false });
  let took = LLM.tryRoute('帮我把下周的事情安排一下');
  eq('关开关时不接管', took, false);
  eq('关开关时零请求', net.calls.length, 0);
  eq('关开关时状态 off', LLM.status, 'off');

  console.log('\n=== 9. 路由：模型意图先确认再入库，闲聊走流式聊天 ===');
  reset();
  net.script.push(stubRes(200, { models: [{ name: 'qwen3:4b' }] }));          // 探活
  net.script.push(stubRes(200, { message: { content: '{"intent":"add","date":"明天","start":"15:00","end":"16:00","title":"项目评审会议"}' } }));
  await LLM.applyConfig({ enabled: true, model: 'qwen3:4b' });
  took = LLM.tryRoute('帮我把明天下午三点到四点的项目评审会议记一下');
  eq('接管返回 true（同步）', took, true);
  await LLM.whenIdle();
  eq('意图路径不写聊天记录', log.stream.length, 0);

  /* 确认门：模型说「加」，不等于真加 */
  eq('挂起待确认', App.Controller.pending && App.Controller.pending.type, 'confirm-intent');
  eq('复述了模型的理解（日期 + 标题）',
    log.pet.some(p => /明天/.test(p.html) && /项目评审会议/.test(p.html)), true);
  eq('没确认前一条日程都不加', App.Manager.tasksOfDate(TOMORROW).length, 0);

  App.Controller.handle('确认');                     // 用户走真实入口回确认
  const added = App.Manager.tasksOfDate(TOMORROW);
  eq('确认后落到真实日程（只有一条）', added.length, 1);
  if (added[0]) {
    eq('入库字段正确', [added[0].startTime, added[0].endTime, added[0].title, added[0].category].join('|'),
      ['15:00', '16:00', '项目评审会议', 'working'].join('|'));
  }
  eq('走了既有的播报通路', log.pet.some(p => /已添加/.test(p.html)), true);
  eq('提取期间开了「交流中」', log.temp.some(t => t.type === 'talking'), true);
  eq('提取返回后收掉（不留悬挂动画）', log.temp.some(t => t.end === 'talking'), true);

  /* 取消：什么都不该发生 */
  reset();
  net.script.push(stubRes(200, { message: { content: '{"intent":"delete","date":"明天","title":"项目评审会议"}' } }));
  LLM.tryRoute('把明天的项目评审会议删掉');
  await LLM.whenIdle();
  eq('删除意图同样先确认', App.Controller.pending && App.Controller.pending.type, 'confirm-intent');
  App.Controller.handle('取消');
  eq('取消后日程还在', App.Manager.tasksOfDate(TOMORROW).length, 1);
  eq('取消有回执', log.pet.some(p => /已取消/.test(p.html)), true);

  /* 纠正：回一句别的 = 撤掉待确认，把这句话当新指令重放（不重复上屏） */
  reset();
  net.script.push(stubRes(200, { message: { content: '{"intent":"delete","date":"明天","title":"项目评审会议"}' } }));
  LLM.tryRoute('把明天的项目评审会议删掉');
  await LLM.whenIdle();
  eq('又挂起待确认', App.Controller.pending && App.Controller.pending.type, 'confirm-intent');
  App.Controller.handle('后天上午十点开会');           // 离线正则会接住这句
  eq('待确认已撤', App.Controller.pending, null);
  eq('改口这句被当成新指令执行了', App.Manager.tasksOfDate('2026-10-11').length, 1);
  eq('改口只上屏一次',
    log.user.filter(t => t === '后天上午十点开会').length, 1);

  /* query 只读：不拦，直接答 */
  reset();
  net.script.push(stubRes(200, { message: { content: '{"intent":"query","date":"今天"}' } }));
  LLM.tryRoute('我今天还有什么安排');
  await LLM.whenIdle();
  eq('查询不挂确认', App.Controller.pending, null);
  eq('查询直接走了 doQuery 播报', log.pet.some(p => /项安排|没有.*安排/.test(p.html)), true);

  /* 标题里的尖括号：确认框是拼进 innerHTML 的（Output.pet），必须转义 */
  reset();
  net.script.push(stubRes(200, { message: { content: '{"intent":"add","date":"明天","start":"09:00","end":"10:00","title":"写 <报告> 提纲"}' } }));
  LLM.tryRoute('明天九点写报告提纲');
  await LLM.whenIdle();
  eq('确认框转义了标题里的尖括号',
    log.pet.some(p => p.html.indexOf('&lt;报告&gt;') >= 0), true);
  App.Controller.handle('取消');                       // 清场，别把待确认带进后面的用例

  reset();
  net.script.push(stubRes(200, { message: { content: '{"intent":"chat"}' } }));
  net.script.push(stubStream([
    '{"message":{"content":"{\\"reply\\":\\"我挺好的，你"}}',
    '{"message":{"content":"呢？\\"}"}}',
    '{"done":true}'
  ]));
  const before = App.Manager.all().length;   // 上一段确认门已经写进去几条，别写死数字
  took = LLM.tryRoute('你好呀，今天过得怎么样');
  await LLM.whenIdle();
  eq('闲聊开了流式渲染', log.stream.length, 1);
  eq('闲聊一条日程都不加', App.Manager.all().length, before);
  eq('闲聊回复渲染正确', log.stream[0] && log.stream[0].text, '我挺好的，你呢？');
  eq('闲聊后状态仍是已连接', LLM.status, 'ok');

  console.log('\n=== 10. 闲聊：JSON 字符串流边收边渲染 + 交流中动画 ===');
  reset();
  net.script.push(stubRes(200, { message: { content: '{"intent":"chat"}' } }));  // 提取 -> chat
  net.script.push(stubStream([
    '{"message":{"content":"{\\"reply\\":\\"今天还有"}}',
    '{"message":{"content":"一节背单词哦\\"}"}}',
    '{"done":true}'
  ]));
  LLM.tryRoute('我今天还有什么安排');
  await LLM.whenIdle();

  const tempStar = log.temp.filter(t => t.type === 'talking');
  /* 提取期一次、回复期一次。真实 StateMachine 按 type+taskId 去重，
     两次会合成为一段连贯的「交流中」，不会闪断 —— 这里桩不去重，所以看得到两次 */
  eq('开 talking 循环态（提取期 + 回复期各一次）', tempStar.length, 2);
  eq('每次开启都有对应收尾', log.temp.filter(t => t.end === 'talking').length, 2);
  eq('talking 循环播放', tempStar[0] && tempStar[0].opts && tempStar[0].opts.loop, true);
  eq('talking 用 taskId=null（不被 dropStaleTemp 误撤）', tempStar[0] && tempStar[0].taskId, null);
  eq('回复返回后收掉 talking', log.temp.some(t => t.end === 'talking'), true);
  eq('结束后播 done 庆祝', log.temp.some(t => t.type === 'done'), true);
  const s = log.stream[0];
  eq('流式文本拼装正确', s && s.text, '今天还有一节背单词哦');
  eq('流式句柄正常收尾', s && s.closed, true);
  eq('聊天历史一轮一记（含第 9 节那轮）', LLM.Chat.history.length, 4);
  /* 历史里 assistant 轮次必须是 JSON 形式，与 REPLY_SCHEMA 对齐。
     存纯文本会让 qwen3:4b 复读上一条（实测 33%），见开发记录第十四篇 */
  const lastAsst = LLM.Chat.history[LLM.Chat.history.length - 1].content;
  eq('历史里 assistant 轮次是 JSON 对象而非纯文本', /^\s*\{/.test(lastAsst), true);
  eq('JSON 能解回原话（schema 形式与 REPLY_SCHEMA 一致）',
    (function () { try { return JSON.parse(lastAsst).reply; } catch (e) { return '坏 JSON：' + lastAsst; } })(),
    '今天还有一节背单词哦');
  eq('聊天系统提示带上了日程上下文', /接下来两天的安排/.test(LLM.chatSystem()), true);
  eq('聊天走的是 schema 约束（format 字段在）',
    JSON.parse(net.calls[net.calls.length - 1].body).format.required[0], 'reply');

  console.log('\n=== 10b. 复读守卫：照抄上一条时丢掉历史重问一次 ===');
  /* 小模型带多轮历史时会逐字照抄上一条 assistant：走真实路径连问 6 个互不相关的
     问题是 80%，三变体对照里保留历史 13%、历史折进系统提示仍 13%，
     只有不带历史的形态是 0%。见开发记录第十六篇 */
  reset();
  net.script.push(stubRes(200, { models: [{ name: 'qwen3:4b' }] }));
  await LLM.recheck();                    // 用 recheck 保证这根桩一定被消费掉（applyConfig 无变化时会跳过探活）
  LLM.Chat.clear();

  /* 先垫一轮，让守卫有比对基准 */
  const SAY_HELLO = '{"message":{"content":"{\\"reply\\":\\"你好呀，我是小助手。\\"}"}}';
  net.script.push(stubStream([SAY_HELLO, '{"done":true}']));
  await LLM.Chat.send('你好');
  eq('第一轮正常上屏', log.stream[0] && log.stream[0].text, '你好呀，我是小助手。');

  /* 照抄 -> 应触发重问 */
  log.stream.length = 0;
  let n = net.calls.length;
  net.script.push(stubStream([SAY_HELLO, '{"done":true}']));                     // 第一次：逐字照抄
  net.script.push(stubStream([
    '{"message":{"content":"{\\"reply\\":\\"今天是周五，晚上八点半。\\"}"}}', '{"done":true}'
  ]));                                                                          // 重问：正常答
  await LLM.Chat.send('现在几点了');
  eq('照抄被拦下，上屏的是重问后的新回复', log.stream[0] && log.stream[0].text, '今天是周五，晚上八点半。');
  eq('重问前清过一次屏', log.stream[0] && log.stream[0].resetCount, 1);
  const retryBody = JSON.parse(net.calls[net.calls.length - 1].body);
  eq('重问请求不带历史（只有 system + user）', retryBody.messages.length, 2);
  eq('重问请求最后一条是用户原话', retryBody.messages[1].content, '现在几点了');
  eq('重问仍走同一套 schema 约束', retryBody.format.required[0], 'reply');
  eq('重问确实多打了一次请求', net.calls.length - n, 2);
  let hist = LLM.Chat.history;
  eq('历史记的是重问后的回答（不是照抄的那句）',
    JSON.parse(hist[hist.length - 1].content).reply, '今天是周五，晚上八点半。');

  /* 重问还是照抄 -> 认输，给提示而不是把照抄内容留在屏幕上 */
  log.stream.length = 0;
  const beforeGiveUp = LLM.Chat.history.length;
  const SAY_TIME = '{"message":{"content":"{\\"reply\\":\\"今天是周五，晚上八点半。\\"}"}}';
  net.script.push(stubStream([SAY_TIME, '{"done":true}']));
  net.script.push(stubStream([SAY_TIME, '{"done":true}']));
  await LLM.Chat.send('你喜欢什么颜色');
  eq('重问仍照抄 -> 给友好提示', log.stream[0] && log.stream[0].text, '这个问题我暂时答不上来～换个问法试试？');
  eq('答不上来时不走红色错误样式', log.stream[0] && log.stream[0].errored, false);
  eq('答不上来时这一轮不写历史', LLM.Chat.history.length, beforeGiveUp);

  /* 模型一个字都没吐 */
  log.stream.length = 0;
  const beforeEmpty = LLM.Chat.history.length;
  net.script.push(stubStream(['{"done":true}']));
  await LLM.Chat.send('随便说点什么');
  eq('模型没吐内容也给友好提示', log.stream[0] && log.stream[0].text, '这个问题我暂时答不上来～换个问法试试？');
  eq('空回复不写历史', LLM.Chat.history.length, beforeEmpty);

  /* 用户真又问了一遍同一句：模型答同一句是对的，别误伤 */
  reset();
  net.script.push(stubRes(200, { models: [{ name: 'qwen3:4b' }] }));
  await LLM.recheck();
  LLM.Chat.clear();
  const SAY_OK = '{"message":{"content":"{\\"reply\\":\\"好的。\\"}"}}';
  net.script.push(stubStream([SAY_OK, '{"done":true}']));
  await LLM.Chat.send('你好');
  log.stream.length = 0;
  net.script.push(stubStream([SAY_OK, '{"done":true}']));
  await LLM.Chat.send('你好');
  eq('用户重复问同一句时，同样的回答不算复读', log.stream[0] && log.stream[0].text, '好的。');
  eq('这种正常重复不触发重问', log.stream[0] && (log.stream[0].resetCount || 0), 0);

  console.log('\n=== 11. 兜底：模型输出坏 JSON 时重试一次 ===');
  reset();
  net.script.push(stubRes(200, { message: { content: '我觉得应该是一句话，不是 JSON' } }));
  net.script.push(stubRes(200, { message: { content: '{"intent":"query","date":"今天"}' } }));
  LLM.tryRoute('我今天还有什么安排来着');
  await LLM.whenIdle();
  eq('重试后仍拿到意图（走了 query 处理器）',
    log.pet.some(p => /没有剩余安排|项安排/.test(p.html)), true);
  eq('重试带上了更正提示',
    /只输出一个合法的 JSON/.test(JSON.parse(net.calls[1].body).messages.slice(-1)[0].content), true);

  console.log('\n=== 12. 网络错误：降级 + 会话一次提示 ===');
  reset();
  net.script.push(stubRes(200, { models: [] }));
  await LLM.applyConfig({ enabled: true });      // 探活通过
  net.script.push(new Error('ECONNREFUSED'));         // 提取失败
  LLM._noted = false;
  const before12 = App.Manager.all().length;
  LLM.tryRoute('帮我安排一下');
  await LLM.whenIdle();
  eq('失败时一条日程都不写', App.Manager.all().length, before12);
  eq('状态降级为未连接', LLM.status, 'unreachable');
  eq('给了一条系统提示', log.system.length, 1);
  /* 用户等了十几秒，不能什么交代都没有：原话退回离线兜底话术。
     但要说是「模型用不了」，不能说「没太听懂」—— 问题不在用户措辞 */
  eq('退回落离线兜底话术', log.pet.some(p => /答不上来/.test(p.html)), true);
  eq('不把责任推给用户措辞', log.pet.every(p => !/没太听懂/.test(p.html)), true);
  check('兜底也给了气泡（先「让我想想」后「答不上来」）',
    log.bubble.length === 2 && /答不上来/.test(log.bubble[1]), log.bubble.join(' → '));
  eq('等待动画被收掉', log.temp.some(t => t.end === 'talking'), true);

  reset();
  LLM._noted = false;
  LLM.applyConfig({ enabled: true });                 // 端点没变、状态 unreachable -> 直接判不可用
  net.script.push(stubRes(200, { models: [] }));
  LLM.tryRoute('再来一次');
  await LLM.whenIdle();
  eq('未连接时不接管（回到原文案）', net.calls.length, 0);

  /* 开关整个关着时没有模型可怪，「没太听懂」才是对的：用户确实没说出能识别的日程话术 */
  reset();
  LLM.applyConfig({ enabled: false });
  App.Controller.replyUnparsed(App.Input.parse('随便聊两句', { now: App.Clock.now() }));
  eq('开关关着时仍用原文案', log.pet.some(p => /没太听懂/.test(p.html)), true);

  console.log('\n=== 12b. 设置面板：徽章与提示文案 ===');
  /* document 桩平时 getElementById 一律返回 null，renderLlmStatus 直接早退。
     这里临时塞几个记账元素，专门验文案与显示/隐藏 */
  (function () {
    const els = {};
    const mk = () => ({ textContent: '', className: '', hidden: false, innerHTML: '', kids: [],
                        appendChild(c) { this.kids.push(c); } });
    ['llm-status', 'llm-status-tip', 'llm-models'].forEach(id => { els[id] = mk(); });
    const orig = sandbox.document.getElementById;
    sandbox.document.getElementById = id => els[id] || null;
    try {
      const R = App.Settings.renderLlmStatus;

      R('missing', 1, ['qwen3:4b'], 'llama3:70b');
      eq('missing 徽章点名缺哪个模型', els['llm-status'].textContent, '已连接，但没有 llama3:70b');
      eq('missing 徽章是告警色', /llm-status-bad/.test(els['llm-status'].className), true);
      eq('missing 提示给了 pull 命令', /ollama pull llama3:70b/.test(els['llm-status-tip'].textContent), true);
      eq('missing 提示列出已装的模型', /qwen3:4b/.test(els['llm-status-tip'].textContent), true);
      eq('missing 时提示可见', els['llm-status-tip'].hidden, false);

      R('unreachable', 0, [], 'qwen3:4b');
      eq('unreachable 徽章', els['llm-status'].textContent, '未连接');
      eq('unreachable 提示指了「重新检测」', /重新检测/.test(els['llm-status-tip'].textContent), true);
      eq('unreachable 提示可见', els['llm-status-tip'].hidden, false);

      R('ok', 2, ['qwen3:4b', 'qwen3:1.7b'], 'qwen3:4b');
      eq('ok 徽章报数量', els['llm-status'].textContent, '已连接（2 个模型）');
      eq('ok 时提示收起', els['llm-status-tip'].hidden, true);

      R('ok', null, [], 'qwen3:4b');
      eq('读不到模型列表时不谎报 0 个', els['llm-status'].textContent, '已连接（读不到模型列表）');

      R('off', 0, [], 'qwen3:4b');
      eq('关闭时徽章', els['llm-status'].textContent, '已关闭');
      eq('关闭时提示收起', els['llm-status-tip'].hidden, true);
    } finally {
      sandbox.document.getElementById = orig;
    }
  })();

  console.log('\n=== 13. relaxLocator：丢掉模型编出来的定位时间 ===');
  App.Manager.tasks = [
    { id: 'a', date: TOMORROW, startTime: '14:30', endTime: '15:30', title: '英语课', category: 'studying', status: 'pending' },
    { id: 'b', date: TOMORROW, startTime: '09:00', endTime: '11:00', title: '数学复习', category: 'studying', status: 'pending' }
  ];
  // 实测复现：模型把「明天的英语课」的定位日期写成今天、时间编成 14:30
  let it = N({ intent: 'update', targetDate: '今天', targetTitle: '英语课', targetStart: '14:30', patch: { date: '后天', start: '10:00' } });
  eq('严格查询确实落空',
    App.Manager.findCandidates({ date: it.targetDate, titleFrag: '英语课', startTime: '14:30' }).length, 0);
  LLM.relaxLocator(it);
  eq('放宽后定位时间被丢掉', it.target.startTime, null);
  eq('放宽后能定位到唯一那条', App.Manager.findCandidates({ date: it.targetDate, titleFrag: '英语课' }).length, 1);
  eq('补丁不受影响', it.patches.date, '2026-10-11');

  it = N({ intent: 'delete', date: TOMORROW, title: '英语课' });
  LLM.relaxLocator(it);
  eq('本来就精确命中的不动它', it.target.startTime, null);

  console.log('\n=== 14. settings.js：llm 配置与壁纸互不覆盖 ===');
  App.Settings.init();
  eq('默认读出来是关', App.Settings.llm.enabled, false);
  eq('默认端点', App.Settings.llm.endpoint, D.endpoint);

  App.LLM.applyConfig({ enabled: true, model: 'qwen3:8b' });
  App.Settings.saveLlm();
  let saved = JSON.parse(store['desktop_pet_settings']);
  eq('llm 已落盘', saved.llm.model, 'qwen3:8b');
  eq('开关状态一起落盘', saved.llm.enabled, true);

  App.Settings.selectWallpaper('data/wallpapers/wall1.jpg');
  saved = JSON.parse(store['desktop_pet_settings']);
  eq('换壁纸后 llm 仍在', saved.llm.model, 'qwen3:8b');
  eq('壁纸确实换了', saved.wallpaper, 'data/wallpapers/wall1.jpg');
  App.Settings.clearWallpaper();
  saved = JSON.parse(store['desktop_pet_settings']);
  eq('清壁纸后 llm 仍在', saved.llm.enabled, true);

  store['desktop_pet_settings'] = JSON.stringify({
    bg: null, wallpaper: null,
    llm: { enabled: true, endpoint: 'https://evil.com:11434', model: 'qwen3:4b' }
  });
  App.Settings.init();
  eq('重载后被篡改的端点回落默认', App.Settings.llm.endpoint, D.endpoint);
  eq('重载后开关状态保留', App.Settings.llm.enabled, true);

  console.log('\n=== 15. ?nollm=1 调试开关 ===');
  {
    const s2 = Object.assign({}, sandbox);
    s2.location = { search: '?nollm=1' };
    s2.window = s2;
    /* 原型链继承：读得到 Config/Clock，但 llm.js 往 App.LLM 写的是子对象自己的属性，
       不会把主沙箱的 App.LLM 换掉（换成同一个引用的话，后面几节就在测另一个实例了） */
    s2.window.App = Object.create(sandbox.window.App);
    vm.createContext(s2);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'dialog/llm.js'), 'utf8'), s2, { filename: 'llm.js' });
    const L2 = s2.window.App.LLM;
    eq('nollm 被识别', L2.isNollm(), true);
    L2.applyConfig({ enabled: true });
    eq('nollm 下不探活', L2.recheck() && true, true);
    eq('nollm 下不接管', L2.tryRoute('你好'), false);
  }

  console.log('\n=== 16. 开关按钮 -> 落盘 -> 生效（用户真正走的那条路）===');
  /* 面板 DOM 不在时 readLlmPanel 必须回落到运行期配置，不能把端点/模型清空 */
  store['desktop_pet_settings'] = JSON.stringify({ bg: null, wallpaper: null, llm: null });
  App.Settings.init();
  LLM.applyConfig(App.Settings.llm);            // 与 boot 同一顺序：先读设置再灌进运行期
  await aTick();
  eq('起始是关的', LLM.isEnabled(), false);

  net.script.push(stubRes(200, { models: [{ name: 'qwen3:4b' }] }));
  App.Settings.toggleLlm();                     // 返回值是 undefined，看运行期状态
  await aTick();
  eq('按钮切到开', LLM.isEnabled(), true);
  eq('状态探到 ok', LLM.status, 'ok');
  saved = JSON.parse(store['desktop_pet_settings']);
  eq('开关落盘', saved.llm.enabled, true);
  eq('端点在落盘时没被面板清空', saved.llm.endpoint, D.endpoint);
  eq('模型名同理', saved.llm.model, D.model);
  eq('给了开启提示', log.system.some(t => /已开启/.test(t)), true);

  App.Settings.toggleLlm();
  await aTick();
  eq('再点一次关掉', LLM.isEnabled(), false);
  eq('关闭落盘', JSON.parse(store['desktop_pet_settings']).llm.enabled, false);
  eq('关闭后状态回到 off', LLM.status, 'off');
  eq('给了关闭提示', log.system.some(t => /已关闭/.test(t)), true);

  console.log('\n' + (fail ? '✗ ' : '✓ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail ? 1 : 0);
})();
