/*
 * dialog/llm.js — 本地大模型（Ollama）接入层
 *
 * 三条纪律，改这个文件之前先读：
 *   1. 开关默认关。llm.enabled 为 false 时不发任何请求，Controller 那条兜底分支的文案
 *      保持逐字不变——离线可用是产品承诺，模型只是锦上添花。
 *   2. 正则优先。只有 App.Input.parse 没接住（!intent.ok）的文本才会进到这里；识别出的
 *      日程意图一律交给 App.Controller.routeIntent，走既有的 do* 处理器——冲突检测、
 *      候选消歧、确认流程全部复用。本文件不直接调用 App.Manager 的写接口，
 *      模型因此不可能产生第二条写库路径。
 *   3. 提示词不出局域网。端点在 sanitizeConfig 里按回环/私网白名单校验，localStorage
 *      被篡改也发不出去。
 *
 * 与 Ollama 0.34 + qwen3:4b 实测下来的两条关键经验（别再踩）：
 *   - think:false 并不会关掉 qwen3 的思考，它只是把思考从 message.thinking 挪进
 *     message.content。真正让模型不啰嗦的是 format 语法约束：意图提取用 format:'json'，
 *     闲聊用 {"reply":"..."} 的 schema，两者都能把首字压到 1s 内；不加约束时同一句
 *     「我今天还有什么安排」要跑 35s，而且输出整段都是内心戏。
 *   - 闲聊因此不是「纯文本流」而是「JSON 字符串流」：replyReader() 边收边解
 *     {"reply":"…"} 里的转义字符串，解出多少就先渲染多少，视觉上仍是逐字回复。
 */
(function () {
  'use strict';
  var App = window.App;

  /* ---------------- 常量 ---------------- */

  var DEFAULTS = { enabled: false, endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b' };
  var MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,63}$/;
  var MD_MAX = 4000;                    // 渲染硬上限，兜住模型的长篇大论
  var TITLE_MAX = 40;
  var KEEP_ALIVE = '10m';               // 让模型留在显存里，省掉几分钟一次冷加载
  var REPLY_KEY = /"reply"\s*:\s*"/;
  var REPLY_SCHEMA = {
    type: 'object',
    properties: { reply: { type: 'string' } },
    required: ['reply']
  };

  /* ---------------- 环境（一律先查 window 再查全局，便于 vm 沙箱里注入桩） ---------------- */

  function env() { return (typeof window !== 'undefined' && window) || {}; }

  function pick(name) {
    var w = env();
    if (typeof w[name] === 'function') return w[name];
    return (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function')
      ? globalThis[name] : null;
  }

  function doFetch(url, init) {
    var w = env();
    if (typeof w.fetch === 'function') return w.fetch(url, init);
    if (typeof fetch === 'function') return fetch(url, init);
    return null;
  }

  /* ---------------- 小工具 ---------------- */

  /* 剥 ```json 围栏，再从第一个 { 到最后一个 } 截一段出来解析 */
  function parseJsonLoose(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return null;
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      var d = JSON.parse(t.slice(a, b + 1));
      return (d && typeof d === 'object' && !(d instanceof Array)) ? d : null;
    } catch (e) {
      return null;
    }
  }

  function trimTitle(v) {
    var s = String(v == null ? '' : v).trim()
      .replace(/^[「『"'“”‘’]+|[」』"'“”‘’]+$/g, '')
      .replace(/\s+/g, ' ');
    return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX) : s;
  }

  /* 分类一律本地重算：模型给的 category 只当参考，挡不住它把「会议」判成学习 */
  function classifyLocal(text) {
    var ent = App.util.findEntertainment(text);
    if (ent) return 'entertainment';
    return App.util.guessCategory(text);
  }

  function weekLabel(dateStr) {
    var d = App.util.parseDateStr(dateStr);
    return d ? '周' + '日一二三四五六'.charAt(d.getDay()) : '';
  }

  /* ---------------- Markdown -> 受限 HTML ----------------
     转义在前、转换在后：模型原文里任何 < > & 都不可能以标签形式进 DOM。 */

  /* 斜体两侧要求词边界（空白/标点/中日韩），否则「3*4=12 还没写完 **」里的
     单星号会被当成强调符，把半句话吃成 <em>。字母数字不算边界（词内星号多是乘号） */
  var MD_BOUND = '[\\s，。！？、；：（）「」“”‘’"\'.,!?;:()\\u4e00-\\u9fa5]';
  var MD_EM = new RegExp('(^|' + MD_BOUND + ')\\*([^*\\s][^*]*?)\\*(?=$|' + MD_BOUND + ')', 'g');

  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(MD_EM, '$1<em>$2</em>');
  }

  function mdToHtml(md) {
    var text = String(md == null ? '' : md);
    if (text.length > MD_MAX) text = text.slice(0, MD_MAX);
    var lines = App.util.escapeHtml(text).split(/\r?\n/);

    var out = '', para = [], list = null;

    function flushPara() {
      if (para.length) { out += '<p>' + para.join('<br>') + '</p>'; para = []; }
    }
    function flushList() {
      if (list) { out += '<ul>' + list.join('') + '</ul>'; list = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) { flushPara(); flushList(); continue; }

      var m = /^\s*(?:[-*·]|\d+[.)])\s+(.*)$/.exec(line);
      if (m) {
        flushPara();
        if (!list) list = [];
        list.push('<li>' + inlineMd(m[1]) + '</li>');
        continue;
      }
      flushList();
      para.push(inlineMd(line));
    }
    flushPara();
    flushList();
    return out;
  }

  /* ---------------- 配置校验 ----------------
     第 3 条纪律的落点：端点只允许回环/私网，凭据、路径、查询串一律丢掉 */

  function isPrivateHost(host) {
    var h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
    if (/^127\./.test(h)) return true;                       // 127.0.0.0/8 都是回环
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return false;
  }

  function sanitizeEndpoint(v) {
    if (typeof v !== 'string' || !v.trim()) return DEFAULTS.endpoint;
    try {
      var u = new URL(v.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULTS.endpoint;
      if (!isPrivateHost(u.hostname)) return DEFAULTS.endpoint;
      // origin 会自动剔掉凭据/path/query/hash
      return u.origin;
    } catch (e) {
      return DEFAULTS.endpoint;
    }
  }

  function sanitizeConfig(v) {
    var o = (v && typeof v === 'object') ? v : {};
    return {
      enabled: o.enabled === true,                    // 只认显式 true，默认关
      endpoint: sanitizeEndpoint(o.endpoint),
      model: (typeof o.model === 'string' && MODEL_RE.test(o.model.trim()))
        ? o.model.trim() : DEFAULTS.model
    };
  }

  /* ---------------- 日期 / 时间归一化 ----------------
     模型只输出相对词，日期算术全部在本地做 */

  var REL_DAY = {
    '今天': 0, '今日': 0, '今儿': 0, '今晚': 0,
    '明天': 1, '明日': 1, '明晚': 1,
    '后天': 2, '后晚': 2, '大后天': 3
  };
  var WD = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
  var DATE_IN_TEXT = /(大后天|后天|明天|明日|今天|今日|今儿|明晚|后晚|今晚|下个?(?:周|星期|礼拜)[一二三四五六日天]|[这本]?(?:周|星期|礼拜)[一二三四五六日天]|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}[号日])/;

  /* 日期词 -> 'YYYY-MM-DD'；认不出来返回 null（认不出来就当今天，由调用方决定） */
  function resolveDateToken(tok, today) {
    if (tok == null) return null;
    var s = String(tok).trim().replace(/[（(][^）)]*[）)]/g, '').trim();
    if (!s) return null;

    if (REL_DAY[s] != null) return App.util.addDaysStr(today, REL_DAY[s]);

    var m = /^(下个|下|这|本)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(s);
    if (m) {
      var target = WD[m[2]];
      var cur = App.util.parseDateStr(today).getDay();
      var diff = (m[1] === '下' || m[1] === '下个')
        ? (target - cur) + 7                       // 下周X：本周同一 weekday 再 +7，与 input.js 同算法
        : ((target - cur) + 7) % 7;                // 这周X / 裸周X：本周内最近一次，今天即今天
      return App.util.addDaysStr(today, diff);
    }

    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) {
      var ds = m[1] + '-' + App.util.pad2(m[2]) + '-' + App.util.pad2(m[3]);
      var d = App.util.parseDateStr(ds);
      if (!d) return null;
      var gap = Math.abs((d.getTime() - App.util.parseDateStr(today).getTime()) / 86400000);
      return gap > 366 ? null : ds;                // 超出 ±366 天当成模型胡写
    }

    m = /^(\d{1,2})月(\d{1,2})[号日]$/.exec(s);
    if (m) {
      var mo = +m[1], day = +m[2];
      if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
      var year = App.util.parseDateStr(today).getFullYear();
      var cand = year + '-' + App.util.pad2(mo) + '-' + App.util.pad2(day);
      if (cand < today) cand = (year + 1) + '-' + App.util.pad2(mo) + '-' + App.util.pad2(day);
      return App.util.parseDateStr(cand) ? cand : null;
    }

    // 「明天下午」这类带尾巴的：抠出里面的日期词再试一次（带上限防死循环）
    m = DATE_IN_TEXT.exec(s);
    if (m && m[1] !== s) return resolveDateToken(m[1], today);

    return null;
  }

  /* 'HH:MM' -> 'HH:MM'（补零校验）；非法返回 null */
  function normalizeTime(v) {
    if (v == null) return null;
    var s = String(v).trim().replace(/[：.]/g, ':').replace(/\s+/g, '');
    if (!s) return null;
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
    if (!m) {
      m = /^(\d{1,2})$/.exec(s);
      if (!m) return null;
      var h0 = +m[1];
      return h0 <= 23 ? App.util.pad2(h0) + ':00' : null;
    }
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return App.util.pad2(h) + ':' + App.util.pad2(mi);
  }

  /* ---------------- 意图归一化 ----------------
     模型给的是一份「简单 schema」，这里把它映射成 input.js:1-7 的完整契约。
     任何缺字段/坏类型 -> null，调用方随即退化成只读聊天，绝不误写。 */

  function intentEmpty() {
    return { target: null, patches: null, query: null, defaultsUsed: [] };
  }

  function normalizeIntent(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    var today = App.util.dateStr(new Date(now));
    var kind = String(raw.intent || '').toLowerCase();
    var i;

    if (kind === 'add') {
      var aStart = normalizeTime(raw.start);
      var aTitle = trimTitle(raw.title);
      if (!aStart || !aTitle) return null;                 // add 的硬门槛：时间 + 标题
      var aDate = resolveDateToken(raw.date, today) || today;
      var aEnd = normalizeTime(raw.end);
      var aDur = null;
      if (!aEnd) {
        aEnd = App.util.minToHm(App.util.hmToMin(aStart) + App.Config.defaultDurationMin);
        aDur = App.Config.defaultDurationMin;
      }
      i = intentEmpty();
      return {
        ok: true, intent: 'add',
        date: aDate, targetDate: aDate,
        startTime: aStart, endTime: aEnd, durationMin: aDur,
        title: aTitle, category: classifyLocal(aTitle),
        target: null, patches: null, query: null,
        defaultsUsed: aDur ? ['endTime'] : []
      };
    }

    if (kind === 'delete') {
      var dFrag = trimTitle(raw.title != null ? raw.title : raw.targetTitle);
      var dTime = normalizeTime(raw.start != null ? raw.start : raw.targetStart);
      if (!dFrag && !dTime) return null;                   // 什么都没说就删，太危险
      var dDate = resolveDateToken(raw.date, today) || today;
      return {
        ok: true, intent: 'delete',
        date: dDate, targetDate: dDate,
        startTime: dTime, endTime: null,
        title: dFrag || null, category: classifyLocal(dFrag || ''),
        target: { titleFrag: dFrag || null, startTime: dTime },
        patches: null, query: null, defaultsUsed: []
      };
    }

    if (kind === 'update') {
      var patch = (raw.patch && typeof raw.patch === 'object') ? raw.patch : {};
      var pDate = resolveDateToken(patch.date, today);
      var pStart = normalizeTime(patch.start != null ? patch.start : patch.startTime);
      var pDur = patch.duration != null ? +patch.duration : null;

      var tFrag = trimTitle(raw.targetTitle != null ? raw.targetTitle : raw.title);
      var tTime = normalizeTime(raw.targetStart != null ? raw.targetStart : raw.target);
      if (!tFrag && !tTime) return null;                   // 不知道改哪一条
      if (!pDate && !pStart && !(pDur > 0)) return null;   // 也不知道改成什么

      var tDate = resolveDateToken(raw.targetDate, today) || today;
      var patches = {};
      if (pDate) patches.date = pDate;
      if (pStart) patches.startTime = pStart;
      if (pDur > 0) patches.durationMin = pDur;

      return {
        ok: true, intent: 'update',
        date: pDate || tDate,
        targetDate: tDate,
        startTime: pStart,
        endTime: null,
        title: tFrag || null,
        category: classifyLocal(tFrag || ''),
        target: { titleFrag: tFrag || null, startTime: tTime },
        patches: patches, query: null, defaultsUsed: []
      };
    }

    if (kind === 'query') {
      var qToken = (raw.date == null ? null : raw.date);
      var qDate = resolveDateToken(qToken, today) || today;
      return {
        ok: true, intent: 'query',
        date: qDate, targetDate: qDate,
        startTime: null, endTime: null, title: null,
        category: null, target: null, patches: null,
        query: { scope: resolveDateToken(qToken, today) ? 'date' : 'today', remainingOnly: true },
        defaultsUsed: []
      };
    }

    if (kind === 'copy') {
      var to = resolveDateToken(raw.to != null ? raw.to : raw.date, today);
      var from = resolveDateToken(raw.from != null ? raw.from : raw.targetDate, today) || today;
      if (!to) return null;
      return {
        ok: true, intent: 'copy',
        date: to, targetDate: from,
        startTime: null, endTime: null, title: null,
        category: null, target: null, patches: null, query: null,
        defaultsUsed: []
      };
    }

    return null;
  }

  /* 定位条件放宽：小模型偶尔会给定位时间编一个值。
     例「把明天的英语课改到后天上午十点」实测返回 targetDate:"今天" + targetStart:"14:30"，
     两个都是编的——严格查（日期+标题+时间）必然落空。降级顺序：
       日期+标题+时间 -> 日期+标题（丢时间）-> 全库+标题（命中唯一一条时采纳它的日期）
     只在「严格查询落空」时才放宽，命中多条或一条都没有就原样返回，
     交给既有的「没找到」/消歧流程处理，绝不猜。 */
  function relaxLocator(intent) {
    if (!intent || !intent.target) return intent;
    var loc = intent.target;
    var frag = loc.titleFrag;
    if (!frag) return intent;
    var date = intent.targetDate || intent.date;

    function find(d, time) {
      return App.Manager.findCandidates({ date: d, titleFrag: frag, startTime: time || null });
    }

    if (!find(date, loc.startTime).length) {
      if (find(date, null).length) {
        loc.startTime = null;
        if (intent.intent === 'delete') intent.startTime = null;
        return intent;
      }
      var all = find(null, null);
      if (all.length === 1) {
        loc.startTime = null;
        intent.targetDate = all[0].date;
        if (intent.intent === 'delete') { intent.date = all[0].date; intent.startTime = null; }
        if (intent.intent === 'update' && !intent.patches) intent.date = all[0].date;
      }
    }
    return intent;
  }

  /* ---------------- HTTP 层 ---------------- */

  function timeoutMs(kind) {
    var c = App.Config.llm;
    return kind === 'health' ? c.healthTimeoutMs
      : kind === 'intent' ? c.intentTimeoutMs : c.chatTimeoutMs;
  }

  function makeController() {
    var AC = pick('AbortController');
    if (!AC) return null;
    try { return new AC(); } catch (e) { return null; }
  }

  /* 单次 JSON 请求：永不 reject，失败信息放在 code 里 */
  function xjson(path, payload, ms) {
    return new Promise(function (resolve) {
      var cfg = App.LLM.cfg, ctrl = makeController(), timer = null, settled = false;
      function done(res) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(res);
      }
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }
        done({ ok: false, code: 'timeout' });
      }, ms);

      var init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };
      if (ctrl) init.signal = ctrl.signal;

      var p;
      try { p = doFetch(cfg.endpoint + path, init); } catch (e) { p = null; }
      if (!p) { done({ ok: false, code: 'unsupported' }); return; }

      p.then(function (res) {
        if (!res.ok) { done({ ok: false, code: 'http', status: res.status }); return; }
        res.json().then(function (d) { done({ ok: true, data: d, status: res.status }); },
          function () { done({ ok: false, code: 'badjson', status: res.status }); });
      }, function (e) {
        done({ ok: false, code: (e && e.name === 'AbortError') ? 'timeout' : 'network' });
      });
    });
  }

  /* GET /api/tags：探活，永不 throw */
  /* 探活序号：上一次还没回来就又探了一次（或用户把开关关了）时，
     旧结果直接丢掉 —— 否则会画出一个和开关不符的「已连接」徽章 */
  var checkSeq = 0;

  function healthCheck() {
    return new Promise(function (resolve) {
      var cfg = App.LLM.cfg, ctrl = makeController(), timer = null, settled = false;
      function done(res) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(res);
      }
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }
        done({ ok: false, error: 'timeout' });
      }, timeoutMs('health'));

      var init = { method: 'GET' };
      if (ctrl) init.signal = ctrl.signal;

      var p;
      try { p = doFetch(cfg.endpoint + '/api/tags', init); } catch (e) { p = null; }
      if (!p) { done({ ok: false, error: 'unsupported' }); return; }

      p.then(function (res) {
        /* 404/405 = 这个端点没有 /api/tags，但 /api/chat 可能是好的（非 Ollama 的
           兼容实现）。放行，只是模型列表读不到：跳过存在性检查，状态照样算连上 */
        if (res.status === 404 || res.status === 405) { done({ ok: true, count: null, models: [], tags: false }); return; }
        if (!res.ok) { done({ ok: false, error: 'http ' + res.status, status: res.status }); return; }
        res.json().then(function (d) {
          var models = (d && d.models) || [];
          var names = [];
          for (var i = 0; i < models.length; i++) {
            var n = models[i] && (models[i].name || models[i].model);
            if (n) names.push(String(n));
          }
          done({ ok: true, count: names.length, models: names });
        }, function () { done({ ok: false, error: 'badjson' }); });
      }, function (e) {
        done({ ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : 'network' });
      });
    });
  }

  /* NDJSON 增量解析（纯函数）：state.buf 缓存跨 chunk 的半行，容忍垃圾行 */
  function parseNdjson(state, chunk) {
    var evs = [];
    if (!state || typeof state !== 'object') state = { buf: '' };
    state.buf = (state.buf || '') + String(chunk == null ? '' : chunk);
    var parts = state.buf.split('\n');
    state.buf = parts.pop();                       // 最后一段可能是半行，留到下次
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i].trim();
      if (!line) continue;
      try {
        var ev = JSON.parse(line);
        if (ev && typeof ev === 'object') evs.push(ev);
      } catch (e) { /* 半行/垃圾行：直接丢 */ }
    }
    return evs;
  }

  /* 流式聊天。onToken 收到的是模型原文片段（JSON 字符串流）；永不 reject */
  function chatStream(messages, opts, onToken) {
    var cfg = App.LLM.cfg;
    var payload = {
      model: cfg.model, stream: true, think: false, keep_alive: KEEP_ALIVE,
      messages: messages,
      options: { temperature: opts.temperature, num_predict: opts.numPredict }
    };
    if (opts.format) payload.format = opts.format;

    return new Promise(function (resolve) {
      var ctrl = makeController(), timer = null, settled = false;
      function done(res) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(res);
      }
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }
        done({ ok: false, code: 'timeout' });
      }, opts.timeoutMs);

      var init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };
      if (ctrl) init.signal = ctrl.signal;

      var p;
      try { p = doFetch(cfg.endpoint + '/api/chat', init); } catch (e) { p = null; }
      if (!p) { done({ ok: false, code: 'unsupported' }); return; }

      function feed(text) {
        var evs = parseNdjson(state, text);
        for (var i = 0; i < evs.length; i++) {
          if (evs[i].error) { done({ ok: false, code: 'http', msg: String(evs[i].error) }); return false; }
          var m = evs[i].message;
          if (m && m.content) onToken(String(m.content));
        }
        return true;
      }
      var state = { buf: '' };

      p.then(function (res) {
        if (!res.ok) { done({ ok: false, code: 'http', status: res.status }); return; }
        var body = res.body;
        var TD = pick('TextDecoder');

        // 没有流式能力（老浏览器）：退化成一次性读取，回调只被喂一大口
        if (!body || typeof body.getReader !== 'function' || !TD) {
          res.text().then(function (t) { feed(t); done({ ok: true }); },
            function () { done({ ok: false, code: 'network' }); });
          return;
        }

        var reader = body.getReader();
        var dec = new TD('utf-8');
        function pump() {
          reader.read().then(function (r) {
            if (r.done) { done({ ok: true }); return; }
            var alive = feed(dec.decode(r.value, { stream: true }));
            if (alive) pump();
          }, function (e) {
            done({ ok: false, code: (e && e.name === 'AbortError') ? 'timeout' : 'network' });
          });
        }
        pump();
      }, function (e) {
        done({ ok: false, code: (e && e.name === 'AbortError') ? 'timeout' : 'network' });
      });
    });
  }

  function chatRaw(messages, opts) {
    var cfg = App.LLM.cfg;
    var payload = {
      model: cfg.model, stream: false, think: false, keep_alive: KEEP_ALIVE,
      messages: messages,
      options: { temperature: opts.temperature, num_predict: opts.numPredict }
    };
    if (opts.format) payload.format = opts.format;
    return xjson('/api/chat', payload, opts.timeoutMs).then(function (r) {
      if (!r.ok) return r;
      var msg = (r.data && r.data.message) || {};
      return { ok: true, content: String(msg.content || ''), status: r.status };
    });
  }

  /* ---------------- 提示词 ----------------
     两套提示词都在 Ollama 0.34 + qwen3:4b 上逐条实测过（见提交说明）。
     改字前先想清楚：这里的措辞直接决定「会不会误写日程」。 */

  function intentSystem(now) {
    var today = App.util.dateStr(new Date(now));
    return '你是「桌面日程助手」的指令解析器。把用户这句话转成一个 JSON 对象，' +
      '只输出 JSON，不要输出任何解释、前后缀或 markdown 围栏。\n\n' +
      '今天是 ' + today + '，' + weekLabel(today) + '。\n\n' +
      '按下面这些形状输出（字段名固定）：\n\n' +
      '新增日程：{"intent":"add","date":"日期词","start":"HH:MM","end":"HH:MM","title":"事项名"}\n' +
      '修改日程：{"intent":"update","targetDate":"日期词","targetTitle":"要改哪一条",' +
      '"targetStart":"HH:MM","patch":{"date":"日期词","start":"HH:MM"}}\n' +
      '删除日程：{"intent":"delete","date":"日期词","title":"要删的事项","start":"HH:MM"}\n' +
      '查询日程：{"intent":"query","date":"日期词"}\n' +
      '复制整天：{"intent":"copy","from":"源日期词","to":"目标日期词"}\n' +
      '闲聊或与日程无关：{"intent":"chat"}\n\n' +
      '规则：\n' +
      '1. date 只能写「今天」「明天」「后天」「大后天」「本周五」「下周三」「' + today + '」这类词，' +
      '不要自己算日期、不要写别的格式。\n' +
      '2. start / end 用 24 小时制 HH:MM，如 15:00。\n' +
      '3. add 必须同时有 start 和 title；缺任何一个就输出 {"intent":"chat"}。\n' +
      '4. update 必须同时给出 patch（改成什么）和 targetTitle 或 targetStart（改哪一条）。\n' +
      '5. 打招呼、提问、感慨、与日程无关的话，一律输出 {"intent":"chat"}。\n\n' +
      '示例：\n' +
      '用户：明天下午两点半上英语课\n' +
      '输出：{"intent":"add","date":"明天","start":"14:30","end":"15:30","title":"英语课"}\n' +
      '用户：后天9点到11点数学复习\n' +
      '输出：{"intent":"add","date":"后天","start":"09:00","end":"11:00","title":"数学复习"}\n' +
      '用户：把下午三点的会议改成四点\n' +
      '输出：{"intent":"update","targetDate":"今天","targetTitle":"会议","targetStart":"15:00",' +
      '"patch":{"start":"16:00"}}\n' +
      '用户：英语课挪到周五\n' +
      '输出：{"intent":"update","targetDate":"今天","targetTitle":"英语课","patch":{"date":"本周五"}}\n' +
      '用户：取消明天的英语课\n' +
      '输出：{"intent":"delete","date":"明天","title":"英语课"}\n' +
      '用户：我今天忙不忙\n' +
      '输出：{"intent":"query","date":"今天"}\n' +
      '用户：把明天的安排复制到周五\n' +
      '输出：{"intent":"copy","from":"明天","to":"本周五"}\n' +
      '用户：你好呀\n' +
      '输出：{"intent":"chat"}';
  }

  /* 今/明两天的安排清单，宠物靠它回答「我今天还有什么安排」这类问题 */
  function scheduleContext() {
    var days = [], total = 0;
    var today = App.Clock.today();
    var max = App.Config.llm.contextMaxTasks;
    var active = App.Manager.activeAt(App.Clock.now());
    var activeId = active ? active.id : null;

    for (var i = 0; i < App.Config.llm.contextTaskDays; i++) {
      var d = App.util.addDaysStr(today, i);
      var list = App.Manager.byDateSorted(d);
      var parts = [];
      for (var j = 0; j < list.length && total < max; j++, total++) {
        var t = list[j];
        parts.push(t.startTime + '-' + t.endTime + ' ' + t.title +
          (t.id === activeId ? '（进行中）' : ''));
      }
      days.push('- ' + d + ' ' + weekLabel(d) + '：' + (parts.length ? parts.join('；') : '无安排'));
    }

    var head = '当前时间：' + App.Clock.today() + ' ' + weekLabel(App.Clock.today()) + ' ' +
      App.util.minToHm(new Date(App.Clock.now()).getHours() * 60 +
        new Date(App.Clock.now()).getMinutes()) + '。\n';
    if (active) {
      head += '正在进行：' + active.title + '（' + active.startTime + '-' + active.endTime + '）。\n';
    }
    return head + '接下来两天的安排：\n' + days.join('\n');
  }

  /* 闲聊的系统提示。事实全在 scheduleContext 里，模型只负责组织成人话。
     开头这句「直接回答用户问的那件事」是有来历的：日程上下文一长，
     qwen3:4b 会把「现在几点」答成「你好呀！今天体能训练进行中…」——
     原来的提示词只说「回答日程相关问题时以上面的安排为准」，
     等于没规定非日程问题怎么答，小模型就顺着最显眼的日程行往下编。 */
  function chatSystem() {
    return '你是一只桌面宠物日程助手，名字叫「小助手」。\n\n' +
      '第一条也是最重要的一条：直接回答用户问的那件事。' +
      '问时间 / 日期 / 星期，按下面「当前时间」如实回答；问日程，按下面的安排回答；' +
      '答不上来就说不知道，绝不编造。\n' +
      '不要答非所问，尤其不要把「现在几点」这类问题答成日程汇报。\n\n' +
      '说话简短、温和、口语化，一次最多 1-2 句，不要用标题、不要列清单、不要堆 emoji。' +
      '用户没问日程时，不用主动汇报「正在进行的任务」。\n\n' +
      scheduleContext() + '\n' +
      '只输出一个 JSON 对象，形如 {"reply": "你要说的话"}。' +
      'reply 里只放你直接说给用户听的内容，不要写你的思考过程。';
  }

  /* ---------------- 边流边解 {"reply": "…"} ----------------
     schema 约束下模型只会吐这么一个对象；这里把字符串值增量解出来，
     解到哪渲染到哪。整段收完后再用 JSON.parse 校一次（见 Chat.send）。 */

  var ESC_MAP = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

  function replyReader() {
    var raw = '', out = '', i = 0, open = false, doneFlag = false;

    return {
      feed: function (chunk) {
        if (doneFlag) return out;
        raw += String(chunk == null ? '' : chunk);
        if (!open) {
          var m = REPLY_KEY.exec(raw);
          if (!m) return out;
          open = true;
          i = m.index + m[0].length;
        }
        while (i < raw.length) {
          var ch = raw.charAt(i);
          if (ch === '\\') {
            if (i + 1 >= raw.length) break;                 // 转义序列劈成两半，等下一块
            var nx = raw.charAt(i + 1);
            if (nx === 'u') {
              if (i + 6 > raw.length) break;                // \uXXXX 还没收全
              var code = parseInt(raw.slice(i + 2, i + 6), 16);
              out += isNaN(code) ? '' : String.fromCharCode(code);
              i += 6;
              continue;
            }
            out += (ESC_MAP[nx] != null) ? ESC_MAP[nx] : nx;
            i += 2;
            continue;
          }
          if (ch === '"') { doneFlag = true; i++; break; }   // 值结束
          out += ch;
          i++;
        }
        return out;
      },
      raw: function () { return raw; },
      text: function () { return out; }
    };
  }

  /* 兜底：万一没有 schema 约束（老版本 Ollama 忽略 format），
     至少把  thinking…<｜end▁of▁thinking｜> 之类的思考块从纯文本里切掉 */
  function stripThink(s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/<think[\s\S]*?<\/think>/gi, '');
    t = t.replace(/^[\s\S]*?<\/think>/i, '');
    return t.trim();
  }

  /* ---------------- 意图提取 ---------------- */

  function interpret(d) {
    if (!d || typeof d !== 'object') return null;
    if (String(d.intent || '').toLowerCase() === 'chat') return { kind: 'chat' };
    var ni = normalizeIntent(d, App.Clock.now());
    return ni ? { kind: 'intent', intent: ni } : { kind: 'chat' };
  }

  function extractIntent(text) {
    var cfg = App.Config.llm;
    var msgs = [
      { role: 'system', content: intentSystem(App.Clock.now()) },
      { role: 'user', content: text }
    ];
    var o1 = { format: 'json', temperature: 0.1, numPredict: cfg.intentMaxTokens, timeoutMs: cfg.intentTimeoutMs };

    return chatRaw(msgs, o1).then(function (r) {
      if (!r.ok) return { kind: 'error', code: r.code, status: r.status };
      var d = parseJsonLoose(r.content);
      if (d) return interpret(d);

      // 解析失败：把模型原文当 assistant 回合还回去，追加一句更正再试一次
      msgs.push({ role: 'assistant', content: String(r.content || '').slice(0, 400) });
      msgs.push({ role: 'user', content: '只输出一个合法的 JSON 对象，不要任何解释、注释或 markdown 围栏。' });
      return chatRaw(msgs, o1).then(function (r2) {
        if (!r2.ok) return { kind: 'error', code: r2.code, status: r2.status };
        var d2 = parseJsonLoose(r2.content);
        return d2 ? interpret(d2) : { kind: 'chat' };
      });
    });
  }

  /* ---------------- 队列 ----------------
     所有 LLM 任务串行：流式回复还没结束就来了新消息时，第二次提取不会插进来把
     气泡/动画搅乱（顺序=用户输入的先后） */

  var chain = Promise.resolve();

  function enqueue(fn) {
    var p = chain.then(function () { return fn(); }, function () { return fn(); });
    chain = p.then(function () {}, function () {});        // 队列自身不被失败打断
    return p;
  }

  /* ---------------- 等待期反馈 ----------------
     CPU 推理时一次意图提取实测要 6~13s（大头是 system prompt 的 prompt eval，
     643 token 就要 9.5s），这段空白必须让宠物有反应：循环「交流中」+ 气泡。
     enqueueTemp 按 type+taskId 去重，Chat.send 随后再开一次是空操作，
     所以这里放心开，交界处不会闪断 */

  function waitStart() {
    App.StateMachine.enqueueTemp('talking', null, App.Config.tempMs.talking, { loop: true });
    App.Bubble.say('让我想想…', { ms: 8000 });
  }

  function waitEnd() {
    App.StateMachine.endTemp('talking');
  }

  /* 交给模型却什么都没解析出来时，把原话退回离线通路（同一条兜底话术）。
     没有这一步，用户等了十几秒会连「没太听懂」都收不到 */
  function offlineFallback(text) {
    if (App.Controller && App.Controller.replyUnparsed) {
      App.Controller.replyUnparsed(App.Input.parse(text, { now: App.Clock.now() }));
    }
  }

  /* ---------------- 聊天会话 ---------------- */

  var Chat = {
    history: [],                    // 只在内存里：[{role, content}]，不落盘

    /* 每条消息都重建系统提示：日程可能刚变过，模型得看到最新的 */
    messages: function (text) {
      var msgs = [{ role: 'system', content: chatSystem() }];
      var cap = App.Config.llm.historyTurns * 2;
      var h = this.history.length > cap ? this.history.slice(this.history.length - cap) : this.history;
      for (var i = 0; i < h.length; i++) msgs.push(h[i]);
      msgs.push({ role: 'user', content: text });
      return msgs;
    },

    /* 不带历史的请求体：复读守卫重问时用。实测这条形态复读率 0%，
       代价是丢掉多轮上下文 —— 所以只在已经确认照抄之后才走 */
    messagesBare: function (text) {
      return [{ role: 'system', content: chatSystem() }, { role: 'user', content: text }];
    },

    remember: function (role, content) {
      this.history.push({ role: role, content: String(content == null ? '' : content) });
      var cap = App.Config.llm.historyTurns * 2;
      while (this.history.length > cap) this.history.shift();
    },

    clear: function () { this.history = []; },

    /* 上一条 assistant 回复的纯文本；没有则 ''。复读守卫拿它当比对基准 */
    lastReply: function () {
      for (var i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].role !== 'assistant') continue;
        var c = String(this.history[i].content);
        var o = parseJsonLoose(c);
        return (o && typeof o.reply === 'string') ? o.reply.trim() : c.trim();
      }
      return '';
    },

    /* 用户上一句问的是什么。用户连着问同一句话时不算复读，别把正常的重复当 bug 修掉 */
    lastUser: function () {
      for (var i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].role === 'user') return String(this.history[i].content).trim();
      }
      return '';
    },

    /* 由 _route 在队列内调用：视频交互 + 流式渲染 + 收尾动画 */
    send: function (text) {
      var self = this;
      var LLM = App.LLM;
      var tempMs = App.Config.tempMs;
      var cfg = App.Config.llm;

      // 「交流中」：循环播放，一直举着手说话；回复回来时主动收掉（endTemp）
      App.StateMachine.enqueueTemp('talking', null, tempMs.talking, { loop: true });
      App.Bubble.say('让我想想…', { ms: 4000 });

      var handle = App.Output.stream({ mood: 'idle', render: mdToHtml });
      var prev = this.lastReply();      // 基准要在写历史之前取

      /* 发一次请求并流式上屏，收尾做 JSON 解析。返回 {ok:true,text} 或 {ok:false,r} */
      function ask(messages) {
        var reader = replyReader(), shown = 0;
        return chatStream(messages, {
          temperature: 0.7,
          numPredict: cfg.chatMaxTokens,
          timeoutMs: cfg.chatTimeoutMs,
          format: REPLY_SCHEMA
        }, function (piece) {
          var out = reader.feed(piece);
          if (out.length > shown) {
            handle.append(out.slice(shown));
            shown = out.length;
          }
        }).then(function (r) {
          if (!r.ok) return { ok: false, r: r };
          // 收全了以 JSON.parse 为准；解不出来就退回原文剥思考块
          var final = reader.text();
          var parsed = parseJsonLoose(reader.raw());
          if (parsed && typeof parsed.reply === 'string') final = parsed.reply;
          final = (final.trim() || stripThink(reader.raw())).trim();
          return { ok: true, text: final };
        });
      }

      /* 请求失败：说清原因并把端点打回正确状态 */
      function fail(r) {
        App.StateMachine.endTemp('talking');
        LLM.note(r.code, r.status);
        handle.error('本地模型没能回上话（' + errText(r) + '）。');
        if (r.code === 'network') LLM.degrade();
        else if (r.code === 'http' && (r.status === 404 || r.status === 405)) LLM.degrade('missing');
      }

      /* 答不上来：不把照抄的内容留在屏幕上，也不写进历史（它本来就没什么信息量） */
      function giveUp() {
        App.StateMachine.endTemp('talking');
        handle.reset();
        handle.end('这个问题我暂时答不上来～换个问法试试？');
        App.StateMachine.enqueueTemp('done', null, tempMs.done);
      }

      function finish(final) {
        App.StateMachine.endTemp('talking');
        handle.end(final);
        self.remember('user', text);
        /* 历史里的 assistant 轮次必须**保持 JSON 形式**，和 REPLY_SCHEMA 一致。
           存纯文本会诱发复读：实测 qwen3:4b 四问连问，复读率 33%（8 次跑每次都是 1/3），
           改成 JSON 后降到 4%。原因是系统提示要求「只输出一个 JSON 对象」，
           而纯文本的历史等于让模型看见自己上一条违反了格式约定，小模型就顺着照抄上一条。
           降 temperature 到 0.3、加「不要重复」指令都压不住（各自仍是 33% / 22%），
           说明这是结构问题不是采样抖动。详见开发记录第十四、十六篇。 */
        self.remember('assistant', JSON.stringify({ reply: final }));
        App.StateMachine.enqueueTemp('done', null, tempMs.done);
      }

      return ask(self.messages(text)).then(function (a) {
        if (!a.ok) { fail(a.r); return; }
        if (!a.text) { giveUp(); return; }

        /* 复读守卫。小模型（qwen3:4b）在带多轮历史时会逐字照抄上一条 assistant：
           走真实路径连问 6 个互不相关的问题，复读率 80%；三变体对照里保留历史 13%、
           把历史折进系统提示仍是 13%，只有完全不带历史的形态是 0%。
           既然改提示词压不住，就不跟模型较劲：发现逐字相同就丢掉历史重问一次
           （等价于那个 0% 的形态），仍然照抄才认输。 */
        if (prev && a.text === prev && text.trim() !== self.lastUser()) {
          handle.reset();
          return ask(self.messagesBare(text)).then(function (b) {
            if (!b.ok) { fail(b.r); return; }
            if (!b.text || b.text === prev) { giveUp(); return; }
            finish(b.text);
          });
        }
        finish(a.text);
      });
    }
  };

  function errText(r) {
    if (r.code === 'timeout') return '超时';
    if (r.code === 'network') return '连不上服务';
    if (r.code === 'http') return 'HTTP ' + r.status;
    if (r.code === 'unsupported') return '这个浏览器不支持 fetch';
    return r.code || '未知错误';
  }

  /* ---------------- 公共对象 ---------------- */

  var nollm = false;
  try {
    if (typeof location !== 'undefined' && location.search) {
      nollm = new URLSearchParams(location.search).get('nollm') === '1';
    }
  } catch (e) { /* 拿不到 search 就当没设置 */ }

  App.LLM = {
    DEFAULTS: DEFAULTS,
    status: 'off',              // off | unknown | checking | ok | unreachable
    models: [],
    cfg: sanitizeConfig(null),
    Chat: Chat,

    /* --- 纯函数，导出给测试与设置面板复用 --- */
    sanitizeConfig: sanitizeConfig,
    sanitizeEndpoint: sanitizeEndpoint,
    isPrivateHost: isPrivateHost,
    mdToHtml: mdToHtml,
    parseJsonLoose: parseJsonLoose,
    parseNdjson: parseNdjson,
    replyReader: replyReader,
    stripThink: stripThink,
    resolveDateToken: resolveDateToken,
    normalizeTime: normalizeTime,
    normalizeIntent: normalizeIntent,
    relaxLocator: relaxLocator,
    intentSystem: intentSystem,
    chatSystem: chatSystem,

    isNollm: function () { return nollm; },

    isEnabled: function () { return this.cfg.enabled === true; },

    /* 能不能真的干活：严格版，给 UI 与提示用 */
    isUsable: function () {
      return this.cfg.enabled === true && !nollm && this.status === 'ok';
    },

    /* 能不能接管这条消息：unknown/checking 也算（队列里会先补一次探活，
       连不上就在聊天里说明并降级，不会把用户的话吞掉）。
       missing 不算：模型没装，接管了也只会拿到 404 */
    canRoute: function () {
      if (!this.cfg.enabled || nollm) return false;
      return this.status !== 'off' && this.status !== 'unreachable' && this.status !== 'missing';
    },

    setStatus: function (s, extra) {
      if (this.status === s && !extra) return;
      /* 状态真的换了就重新武装提示：从「模型没装」变成「连不上」是另一个问题，
         用户该再看到一次说明；同一条消息连发时状态不变，所以不会刷屏 */
      if (this.status !== s) this._noted = false;
      this.status = s;
      var p = { status: s, count: 0, models: this.models.slice(), endpoint: this.cfg.endpoint };
      if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) p[k] = extra[k]; }
      if (App.bus && App.bus.emit) App.bus.emit('llm:status', p);
    },

    init: function (cfg) {
      return this.applyConfig(cfg);
    },

    /* 运行期配置入口。开了就立刻探活，关了不发任何请求。
       返回探活的 Promise（没触发探活时立即 resolve），方便调用方与测试等待 */
    applyConfig: function (v) {
      var next = sanitizeConfig(v);
      var endpointChanged = next.endpoint !== this.cfg.endpoint;
      var modelChanged = next.model !== this.cfg.model;
      var enableChanged = next.enabled !== this.cfg.enabled;
      this.cfg = next;

      if (!next.enabled || nollm) {
        this.setStatus('off');
        if (App.bus && App.bus.emit) App.bus.emit('llm:status', { status: 'off', endpoint: next.endpoint });
        return Promise.resolve({ ok: false, error: 'off' });
      }
      /* missing 也要重探：用户看到「没有这个模型」后多半会去 ollama pull，
         回来点「保存」得能看到结果，不能只有「重新检测」按钮管用 */
      if (endpointChanged || modelChanged || enableChanged ||
          this.status === 'off' || this.status === 'missing') {
        return this.recheck();
      }
      return Promise.resolve({ ok: this.status === 'ok' });
    },

    /* 开关切换：唯一事实源是 llm.enabled，落盘交给 Settings */
    setEnabled: function (on) {
      this.cfg.enabled = on === true;
      if (App.Settings && App.Settings.saveLlm) App.Settings.saveLlm();   // 内部会回调 applyConfig
      else this.applyConfig(this.cfg);
      return this.cfg.enabled;
    },

    recheck: function () {
      var self = this;
      if (!this.cfg.enabled || nollm) { this.setStatus('off'); return Promise.resolve({ ok: false }); }
      this.setStatus('checking');
      var stamp = ++checkSeq;                 // 探活期间又被点一次时，只认最新那次的结论
      function settle(r) {
        if (stamp !== checkSeq) return r;     // 已被更晚的一次探活/关闭取代，丢弃这次结果
        if (!self.cfg.enabled || nollm) { self.setStatus('off'); return r; }
        if (r.ok) {
          self.models = r.models || [];
          /* 端点通了不代表模型下载了。只探活不校验模型名的话，状态会停在 ok，
             于是每条消息都发给一个不存在的模型、每条都收 404 —— 用户等半天换来一句
             「没太听懂」。这里直接把「模型不在列表里」判成独立状态，canRoute 会拒绝接管，
             提示也能说清是没装模型而不是用户措辞有问题。
             tags:false（端点没有 /api/tags）时读不到列表，跳过这项检查。 */
          var missing = r.tags === false ? false : self.models.indexOf(self.cfg.model) < 0;
          self.setStatus(missing ? 'missing' : 'ok', { count: r.count });
        } else {
          self.models = [];
          self.setStatus('unreachable', { error: r.error });
        }
        return r;
      }
      return healthCheck().then(settle, function () {
        return settle({ ok: false, error: 'network' });
      });
    },

    /* 探活：unknown 时先补一次；从未连接过就返回 false，让调用方走离线文案 */
    ensureReady: function () {
      var self = this;
      if (this.status === 'ok') return Promise.resolve(true);
      if (this.status === 'unreachable' || this.status === 'off' || this.status === 'missing') {
        return Promise.resolve(false);
      }
      return this.recheck().then(function (r) { return !!r.ok && self.status === 'ok'; });
    },

    /* 端点被降级（发不出去 / 连不上）时把状态打回未连接。
       传 'missing' 用于「端点活着但说没有这个模型」（聊天/意图请求收 404）的情况 */
    degrade: function (to) {
      if (this.status === 'ok' || this.status === 'checking' || this.status === 'missing') {
        if (to === 'missing') this.setStatus('missing', { error: 'http 404' });
        else this.setStatus('unreachable', { error: 'network' });
      }
    },

    /* 会话内只提示一次：连不上时把「已回退离线模式」说清楚。
       文案不带端点 URL 和 HTTP 码 —— 那些在设置面板里，聊天窗里只说人话 */
    note: function (code, status) {
      if (this._noted || !this.cfg.enabled || nollm) return;
      this._noted = true;
      if (this.status === 'missing') { this.hintText(); return; }
      var why = code === 'http' ? '（HTTP ' + status + '）' : '';
      App.Output.system('本地模型暂时用不了' + why + '，这条先按离线模式处理。' +
        '可以在设置里点「重新检测」再试。');
    },

    /* Controller 兜底分支调用：开关开着却没接住时，说明为什么 */
    maybeHint: function () {
      if (this._noted || !this.cfg.enabled || nollm) return;
      this._noted = true;
      App.Output.system(this.hintText());
    },

    /* 按当前状态给一句能照做的提示（note / maybeHint 共用） */
    hintText: function () {
      if (this.status === 'missing') {
        return '本地模型还没安装「' + this.cfg.model + '」，这条先按离线模式处理。' +
          '在终端运行 ollama pull ' + this.cfg.model + '，再回设置里点「重新检测」。' +
          (this.models.length ? '当前已安装：' + this.models.join('、') + '。' : '');
      }
      return '本地模型连不上，已使用离线模式。' +
        '确认 Ollama 已启动后，在设置里点「重新检测」。';
    },

    /* 队列排空（测试用：tryRoute 是同步返回 + 异步干活，断言前要等它跑完） */
    whenIdle: function () { return chain; },

    /* --- 路由：同步返回是否接管，异步干活 --- */
    tryRoute: function (text) {
      var self = this;
      if (!this.canRoute()) return false;
      enqueue(function () {
        return self.ensureReady().then(function (ready) {
          if (!ready) { self.maybeHint(); return; }
          waitStart();
          return extractIntent(text).then(function (r) {
            waitEnd();
            if (r.kind === 'intent') {
              /* confirm:true —— 模型解析出的写操作不直接落库，
                 routeIntent 内部先复述给用户确认（query 只读，照常直接答） */
              App.Controller.routeIntent(relaxLocator(r.intent), { confirm: true });
              return;
            }
            if (r.kind === 'chat') return Chat.send(text);
            // 提取本身失败（超时 / 连不上 / 输出没法解析）：状态降级 + 一条提示，
            // 然后把这句话交回离线通路 —— 用户等了十几秒，不能什么交代都没有
            if (r.code === 'network') self.degrade();
            else if (r.code === 'http' && r.status === 404) self.degrade('missing');
            else if (r.code === 'http' && r.status === 405) self.degrade('missing');
            self.note(r.code, r.status);
            offlineFallback(text);
          });
        }).catch(function (e) {
          console.error('[LLM] 路由失败', e);
          waitEnd();
          self.note('internal');
          offlineFallback(text);
        });
      });
      return true;
    }
  };
})();
