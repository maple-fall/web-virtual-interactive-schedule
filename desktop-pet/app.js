/*
 * app.js — 应用核心：命名空间 / 事件总线 / 工具 / 配置 / 时钟 / 调试钩子
 *          + 计划表视图 PlanView + 对话编排 Controller + 启动引导
 * 本文件最先加载，只定义对象；各模块在后续脚本的 IIFE 中挂载到 window.App。
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};

  /* ---------------- 事件总线 ---------------- */

  function createBus() {
    var map = Object.create(null);
    return {
      on: function (evt, fn) {
        (map[evt] = map[evt] || []).push(fn);
        return fn;
      },
      off: function (evt, fn) {
        var list = map[evt];
        if (!list) return;
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      },
      emit: function (evt, payload) {
        var list = map[evt];
        if (!list) return;
        list.slice().forEach(function (fn) {
          try { fn(payload); } catch (e) { console.error('[bus:' + evt + ']', e); }
        });
      }
    };
  }
  App.bus = createBus();

  /* ---------------- 工具函数 ---------------- */

  function uid(prefix) {
    return (prefix || 'e') + '_' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
  }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  // 'HH:MM' 或 'HH:MM(+1)' -> {h,m,offset}；非法返回 null
  function parseHM(s) {
    if (s == null) return null;
    var m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?:\(\+(\d+)\))?$/);
    if (!m) return null;
    var h = +m[1], mm = +m[2];
    if (h > 23 || mm > 59) return null;
    return { h: h, m: mm, offset: m[3] ? +m[3] : 0 };
  }
  function hmToMin(s) { var p = parseHM(s); return p ? p.h * 60 + p.m : null; }
  function minToHm(min) {
    min = ((Math.round(min) % 1440) + 1440) % 1440;
    return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
  }
  function parseDateStr(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function dateStr(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addDaysStr(s, n) {
    var d = parseDateStr(s);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }
  // djb2，32 位正整数；file:// 下不用 crypto.subtle
  function hash(str) {
    var h = 5381;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // 任务起止时刻（绝对毫秒）。endOffset：结束在第 N 天
  function dayStartMs(d) { return parseDateStr(d).getTime(); }
  function taskStartMs(t) { return dayStartMs(t.date) + hmToMin(t.startTime) * 60000; }
  function taskEndMs(t) {
    return dayStartMs(t.date) +
      (hmToMin(t.endTime) + (t.endOffset || 0) * 1440) * 60000;
  }

  // 根据标题关键词猜类别
  function guessCategory(title) {
    var k = App.Config.keywords;
    for (var i = 0; i < k.studying.length; i++)
      if (title.indexOf(k.studying[i]) >= 0) return 'studying';
    for (var j = 0; j < k.working.length; j++)
      if (title.indexOf(k.working[j]) >= 0) return 'working';
    return 'general';
  }
  function findEntertainment(text) {
    var k = App.Config.keywords.entertainment;
    for (var i = 0; i < k.length; i++)
      if (text.indexOf(k[i]) >= 0) return k[i];
    // 长句里动词和宾语常被修饰语隔开，精确子串会漏，再过一遍宽松正则
    var ps = App.Config.entertainmentPatterns;
    for (var j = 0; j < ps.length; j++)
      if (ps[j].re.test(text)) return ps[j].name;
  }

  /* 触发浏览器下载。
     别用 <a href="本地文件" download>：file:// 下每个文件都是独立的 opaque origin，
     指向 data/ 下文件属于跨源，download 属性会被规范性地忽略、退化成普通导航
     （Edge 有内置 PDF 阅读器，会直接把 PDF 渲染在当前标签页里，一个文件都不落盘）。
     走 Blob + createObjectURL 就没这个问题：blob: 继承本文档的源，download 生效。 */
  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  App.util = {
    uid: uid, pad2: pad2, parseHM: parseHM, hmToMin: hmToMin, minToHm: minToHm,
    parseDateStr: parseDateStr, dateStr: dateStr, addDaysStr: addDaysStr,
    hash: hash, escapeHtml: escapeHtml, clamp: clamp, debounce: debounce,
    dayStartMs: dayStartMs, taskStartMs: taskStartMs, taskEndMs: taskEndMs,
    guessCategory: guessCategory, findEntertainment: findEntertainment,
    downloadBlob: downloadBlob
  };

  /* ---------------- 全局配置 ---------------- */

  App.Config = {
    storageKey: 'desktop_pet_v2',
    settingsKey: 'desktop_pet_settings',   // 应用设置（舞台背景等），与日程数据分开存
    schemaVersion: 2,
    defaultDurationMin: 60,
    tickMs: 1000,
    /* talking 是「本地模型交流中」的临时态，循环播放直到回复结束；
       这个值只是兜底上限（等于 llm.chatTimeoutMs），正常路径由 LLM 主动收尾 */
    tempMs: { alert: 5000, done: 3500, refuse: 2500, warnStart: 5000, warnEnd: 4000, talking: 90000 },
    startWindowSec: 90,          // 任务开始后多少秒内算“准点播报”
    warnStartMin: 5,             // 开始前多少分钟提醒
    warnEndMin: 10,              // 结束前多少分钟打气提醒
    warnStartPhrase: '「{title}」还有 {min} 分钟就要开始了，准备一下哦～',
    warnEndPhrase: '「{title}」还有 {min} 分钟就结束啦，坚持住，胜利在望～',
    materializeDays: 14,         // 周期日程向未来物化的窗口
    /* 本地大模型（Ollama）接入参数。开关关闭时这些值不会产生任何请求 */
    llm: {
      healthTimeoutMs: 2500,     // /api/tags 探活超时
      /* 意图提取。看着宽，其实纯 CPU 推理就这么慢：system prompt 643 token，
         实测 prompt eval 9.5s + 生成 3.2s ≈ 13s（GPU 上快一个量级）。
         卡 15s 会让功能在没独显的机器上直接不可用，改 30s 留余量 */
      intentTimeoutMs: 30000,
      chatTimeoutMs: 90000,      // 闲聊回复（本地小模型可能很慢）
      intentMaxTokens: 256,
      chatMaxTokens: 512,
      historyTurns: 12,          // 只在内存里保留的对话轮数
      contextTaskDays: 2,        // 系统提示里带几天的安排（今天+明天）
      contextMaxTasks: 30        // 系统提示里最多列几条任务
    },
    keywords: {
      studying: ['学习', '英语', '数学', '语文', '看书', '阅读', '复习', '预习',
        '上课', '课程', '写作业', '背书', '背单词', '刷题', '考试', '讲座', '论文'],
      working: ['工作', '会议', '开会', '上班', '汇报', '写代码', '编程', '加班', '对接',
        '需求', '面试', '项目', '日报', '答辩', '实验'],
      entertainment: ['玩游戏', '打游戏', '看视频', '刷短视频', '刷手机', '追剧',
        '刷剧', '看电影', '看动漫', '睡觉', '躺会', '摸鱼', '打盹']
    },
    /* 上面的关键词是精确子串，命中「我想玩游戏」这种整句包含的情况。
       但口语里动词和宾语常被隔开（「玩一会儿游戏」「看个视频」），子串就断了，
       所以再补一组「动词 + 最多 4 字修饰 + 宾语」的宽松匹配。
       只收娱乐，且不加「看…剧」这类会和正经事撞车的宾语（看剧本 ≠ 追剧）。
       name 是命中后回填的规范词，用作无时间请求时的标题，避免标题带上修饰语 */
    entertainmentPatterns: [
      { re: /玩.{0,4}?游戏/, name: '玩游戏' },
      { re: /打.{0,4}?游戏/, name: '打游戏' },
      { re: /看.{0,4}?视频/, name: '看视频' },
      { re: /看.{0,4}?电影/, name: '看电影' },
      { re: /看.{0,4}?动漫/, name: '看动漫' },
      { re: /刷.{0,4}?手机/, name: '刷手机' },
      { re: /刷.{0,4}?视频/, name: '刷短视频' }
    ],
    refusePhrases: [
      '现在是{category}时间哦，专心完成任务再玩吧～',
      '不行哦！{title}还没结束呢，娱乐的事等完成了再说！'
    ],
    stateByCategory: { studying: 'studying', working: 'working', general: 'working' },
    categoryLabel: { studying: '学习', working: '工作', general: '通用' },
    stateLabel: {
      idle: '空闲中', studying: '学习中', working: '工作中',
      alert: '提醒', done: '任务完成', refuse: '温馨提醒',
      warnStart: '提醒', warnEnd: '加油', talking: '交流中'
    }
  };

  /* ---------------- 时钟（支持 URL 模拟） ---------------- */

  var params = new URLSearchParams(location.search);

  App.Clock = {
    simBase: null, realBase: 0, frozen: false,

    init: function () {
      var hm = params.get('time');
      var d = params.get('date');
      if (hm && /^\d{1,2}:\d{2}$/.test(hm)) {
        var parts = hm.split(':');
        var anchor = d && parseDateStr(d) ? parseDateStr(d) : new Date();
        this.simBase = new Date(
          anchor.getFullYear(), anchor.getMonth(), anchor.getDate(),
          +parts[0], +parts[1], 0
        ).getTime();
        this.realBase = Date.now();
        this.frozen = params.get('freeze') === '1';
      }
    },
    now: function () {
      if (this.simBase == null) return Date.now();
      if (this.frozen) return this.simBase;
      return this.simBase + (Date.now() - this.realBase);
    },
    nowDate: function () { return new Date(this.now()); },
    today: function () { return dateStr(this.nowDate()); },
    setTime: function (hm, dateStrVal) {
      var parts = hm.split(':');
      var anchor = dateStrVal && parseDateStr(dateStrVal)
        ? parseDateStr(dateStrVal) : this.nowDate();
      this.simBase = new Date(
        anchor.getFullYear(), anchor.getMonth(), anchor.getDate(),
        +parts[0], +parts[1], 0
      ).getTime();
      this.realBase = Date.now();
    },
    isMock: function () { return this.simBase != null; }
  };

  /* ---------------- 计划表侧边视图 PlanView ---------------- */

  App.PlanView = {
    el: null, activeId: null,

    init: function (el) {
      this.el = el;
      var self = this;
      App.bus.on('schedule:changed', function () { self.render(); });
      App.bus.on('state:change', function (p) {
        self.activeId = p.task ? p.task.id : null;
        self.markActive();
      });
      App.bus.on('query:highlight', function (p) { self.highlight(p.ids); });
      el.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button.del') : null;
        if (!btn) return;
        var id = btn.getAttribute('data-id');
        var task = App.Manager.get(id);
        App.Manager.remove(id);
        if (task) {
          App.Bubble.say('已删除「' + task.title + '」', { ms: 3000 });
        }
      });
      this.render();
    },

    dayLabel: function (d) {
      var today = App.Clock.today();
      var diff = Math.round((dayStartMs(d) - dayStartMs(today)) / 86400000);
      var date = parseDateStr(d);
      var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
      var md = pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
      var prefix = ['今天', '明天', '后天'][diff];
      return (prefix || wd) + ' ' + md;
    },

    render: function () {
      var today = App.Clock.today();
      var groups = {};
      App.Manager.all().forEach(function (t) {
        if (t.date < today) return;   // 历史任务不展示
        (groups[t.date] = groups[t.date] || []).push(t);
      });
      var dates = Object.keys(groups).sort();

      if (!dates.length) {
        this.el.innerHTML =
          '<div class="plan-empty">还没有日程。<br>点上方「导入安排表」，' +
          '或直接在下方对话框告诉我，例如：<br>' +
          '<em>明天下午两点半上英语课</em></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < dates.length; i++) {
        var d = dates[i];
        var list = groups[d].slice().sort(function (a, b) {
          return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
        });
        html += '<section class="day-group" data-date="' + d + '">';
        html += '<header class="day-head">' + this.dayLabel(d) +
          '<span class="day-count">' + list.length + ' 项</span></header><ul class="task-list">';
        for (var j = 0; j < list.length; j++) {
          html += this.rowHtml(list[j]);
        }
        html += '</ul></section>';
      }
      this.el.innerHTML = html;
      this.markActive();
    },

    rowHtml: function (t) {
      var endLabel = (t.endOffset ? '次日 ' : '') + t.endTime;
      var cat = App.Config.categoryLabel[t.category] || '通用';
      var done = t.status === 'done';
      return '<li class="task-row' + (done ? ' is-done' : '') + '" id="row-' + t.id + '">' +
        '<div class="row-time">' + t.startTime + '<span class="row-sep">–</span>' + endLabel + '</div>' +
        '<div class="row-main">' +
          '<span class="row-title">' + escapeHtml(t.title) + '</span>' +
          '<span class="chip cat-' + t.category + '">' + cat + '</span>' +
          '<span class="chip status-' + (done ? 'done' : 'pending') + '">' +
            (done ? '已完成' : '待完成') + '</span>' +
        '</div>' +
        '<button class="del" data-id="' + t.id + '" title="删除">✕</button>' +
        '</li>';
    },

    markActive: function () {
      var rows = this.el.querySelectorAll('.task-row');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var id = row.id.slice(4);
        var chip = row.querySelector('.chip.status-done,.chip.status-pending');
        if (id === this.activeId) {
          row.classList.add('is-active');
          if (chip) { chip.className = 'chip status-active'; chip.textContent = '进行中'; }
        } else {
          row.classList.remove('is-active');
          var t = App.Manager.get(id);
          if (t && chip && !row.classList.contains('is-done')) {
            chip.className = 'chip status-pending';
            chip.textContent = '待完成';
          }
        }
      }
    },

    highlight: function (ids) {
      if (!ids || !ids.length) return;
      var first = null;
      ids.forEach(function (id) {
        var row = document.getElementById('row-' + id);
        if (!row) return;
        if (!first) first = row;
        row.classList.add('is-highlight');
        setTimeout(function () { row.classList.remove('is-highlight'); }, 3000);
      });
      if (first && first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  /* ---------------- 对话编排 Controller ---------------- */

  App.Controller = {
    pending: null,   // 唯一的待确认/消歧会话

    bindEvents: function () {
      var self = this;
      App.bus.on('task:start', function (p) {
        self.announce('到时间' + p.task.title + '了，我们开始吧！', {
          mood: 'alert', ms: 5000
        });
      });
      App.bus.on('task:end', function (p) {
        self.announce('「' + p.task.title + '」完成啦，休息一下吧～', {
          mood: 'done', ms: 4500
        });
      });
      App.bus.on('task:warn-start', function (p) {
        self.announce(App.Config.warnStartPhrase
          .replace(/\{title\}/g, p.task.title)
          .replace(/\{min\}/g, String(p.minutes)), { mood: 'alert', ms: 5000 });
      });
      App.bus.on('task:warn-end', function (p) {
        self.announce(App.Config.warnEndPhrase
          .replace(/\{title\}/g, p.task.title)
          .replace(/\{min\}/g, String(p.minutes)), { mood: 'done', ms: 4500 });
      });
      App.bus.on('day:summary', function (p) {
        self.announce('今天的 ' + p.count + ' 项安排都完成啦，辛苦了！', {
          mood: 'done', ms: 5500, delay: App.Config.tempMs.done + 300
        });
      });
      App.bus.on('refuse', function (p) {
        self.announce(p.phrase, { mood: 'refuse', ms: 3800 });
      });
      App.bus.on('schedule:imported', function (p) {
        self.announce(p.message, { mood: 'idle', ms: 5000 });
      });
    },

    // 同时写聊天记录（留痕）与气泡（短播，可延迟）
    announce: function (text, opts) {
      opts = opts || {};
      App.Output.pet(text, { mood: opts.mood });
      if (opts.delay) {
        setTimeout(function () { App.Bubble.say(text, { ms: opts.ms, mood: opts.mood }); }, opts.delay);
      } else {
        App.Bubble.say(text, { ms: opts.ms, mood: opts.mood });
      }
    },

    handle: function (raw, opts) {
      var text = String(raw || '').trim();
      if (!text) return;
      // 纠正重放（待确认时用户说了别的）不再重复上屏，见 handlePending
      if (!opts || opts.echo !== false) App.Output.user(text);

      if (this.pending) {
        this.handlePending(text);
        return;
      }

      var intent = App.Input.parse(text, { now: App.Clock.now() });
      if (!intent.ok) {
        // 离线正则没接住：本地模型开关打开且已连接时交给它（同步返回是否已接管）
        if (App.LLM && App.LLM.tryRoute(text)) return;
        this.replyUnparsed(intent);
        return;
      }

      this.routeIntent(intent);
    },

    /* 两条路都没接住时的兜底话术。单独抽出来是给 llm.js 用：
       模型超时 / 连不上时它会把原话退回来走同一套回复，
       否则用户等了十几秒，连一句「没太听懂」都收不到 */
    replyUnparsed: function (intent) {
      var msg = (intent && intent.reasonText) || '没太听懂，可以换个说法。';
      if (intent && intent.examples && intent.examples.length) {
        msg += '<br>你可以这样说：<br>· ' + intent.examples.join('<br>· ');
      }
      App.Output.pet(msg, { mood: 'idle' });
      App.Bubble.say('没太听懂，再说一次吧～', { ms: 3000 });
      if (App.LLM) App.LLM.maybeHint();
    },

    /* 意图对象 -> 既有 do* 处理器。正则路径与本地模型路径共走这一条数据通路，
       冲突检测、候选消歧、确认流程复用同一套逻辑，模型不会产生第二条写库路径。
       opts.confirm = true 时，写操作先挂起等用户确认（模型通路专用，见 needsConfirm） */
    routeIntent: function (intent, opts) {
      // 跨状态娱乐请求拦截：仅「任务进行中 + 娱乐意图」触发拒绝
      if (intent.intent === 'add' && intent.category === 'entertainment') {
        if (App.StateMachine.isBusy()) {
          App.StateMachine.requestRefuse();
          return;
        }
        if (!intent.startTime) {
          // 空闲时的当下请求：不排日程，只回应
          this.announce('现在是空闲时间，想放松就玩一会儿吧～不过到了任务时间我会提醒你的。',
            { mood: 'idle', ms: 4500 });
          return;
        }
        // 带具体时间的娱乐安排（如「周五晚上八点看电影」）按普通日程入库
      }

      /* 模型解析出来的写操作先复述再执行。
         正则通路只在自己有把握时才接住，解析完直接执行没问题；
         模型通路不一样——4B 会理解错，而删错、改错一条日程的代价
         比多问一句大得多。查询是只读的，不拦。 */
      if (opts && opts.confirm && this.needsConfirm(intent)) {
        this.pending = { type: 'confirm-intent', intent: intent };
        this.announce('我理解你要' + this.describeIntent(intent) +
          '，对吗？（回复「确认」或「取消」）', { mood: 'alert', ms: 6000 });
        return;
      }

      switch (intent.intent) {
        case 'add': this.doAdd(intent); break;
        case 'copy': this.doCopy(intent); break;
        case 'delete': this.doDelete(intent); break;
        case 'update': this.doUpdate(intent); break;
        case 'query': this.doQuery(intent); break;
      }
    },

    /* 哪些模型意图要先确认：写操作全部；query 只读不拦。
       add 缺时间也不拦 —— doAdd 自己会问「要安排在几点呢？」 */
    needsConfirm: function (intent) {
      if (intent.intent === 'add') return !!intent.startTime;
      return intent.intent === 'update' || intent.intent === 'delete' || intent.intent === 'copy';
    },

    /* 把模型解析出的意图翻译成一句人话，用于执行前复述。
       全部由字段拼装，不让模型自己措辞 —— 这个确认框本身就是防它理解错的，
       再让它来写这句话就白防了 */
    describeIntent: function (intent) {
      /* 标题来自模型输出，而 Output.pet 走 innerHTML —— 拼进去之前必须转义。
         日期和时间不用管：normalizeIntent 已把它们归一成 MM-DD / HH:MM */
      var esc = App.util.escapeHtml;
      var t = intent.target || {};
      var who = t.titleFrag || intent.title;
      who = who ? '「' + esc(who) + '」' : '';

      if (intent.intent === 'add') {
        return '添加 ' + this.dateLabel(intent.date) + ' ' + intent.startTime + '–' +
          intent.endTime + ' 「' + esc(intent.title) + '」';
      }
      if (intent.intent === 'copy') {
        return '把 ' + this.dateLabel(intent.targetDate) + ' 的安排复制到 ' +
          this.dateLabel(intent.date);
      }
      if (intent.intent === 'delete') {
        return '删除 ' + this.dateLabel(intent.targetDate || intent.date) +
          (who ? ' 的 ' + who : '') + (t.startTime ? '（' + t.startTime + ' 开始）' : '');
      }
      if (intent.intent === 'update') {
        var p = intent.patches || {};
        var to = [];
        if (p.date) to.push('日期改到 ' + this.dateLabel(p.date));
        if (p.startTime) to.push('开始时间改成 ' + p.startTime);
        if (p.durationMin) to.push('时长改成 ' + p.durationMin + ' 分钟');
        if (p.title) to.push('标题改成「' + esc(p.title) + '」');
        return '把 ' + this.dateLabel(intent.date) + (who ? ' 的 ' + who : '') + ' ' +
          (to.length ? to.join('、') : '（没听清要改成什么）');
      }
      return '';
    },

    /* ---- 新增 ---- */
    doAdd: function (intent) {
      if (!intent.startTime) {
        var fail = App.Input.fail('no_time');
        App.Output.pet(fail.reasonText + '<br>· ' + fail.examples.join('<br>· '));
        App.Bubble.say('要安排在几点呢？', { ms: 3000 });
        return;
      }

      var overlaps = App.Manager.overlaps(intent.date,
        App.util.hmToMin(intent.startTime), App.util.hmToMin(intent.endTime));
      if (overlaps.length) {
        this.pending = { type: 'confirm-add', intent: intent };
        var list = overlaps.map(function (t) {
          return t.startTime + '–' + t.endTime + ' ' + t.title;
        }).join('、');
        this.announce('这个时间和「' + list + '」重叠了，确定要添加吗？（回复「确认」或「取消」）',
          { mood: 'alert', ms: 5000 });
        return;
      }
      this.commitAdd(intent);
    },

    commitAdd: function (intent) {
      // 娱乐安排入库时归为通用类（角色状态走 working，不单独占一种动画）
      var category = intent.category === 'entertainment' ? 'general' : intent.category;
      var res = App.Manager.add({
        date: intent.date,
        startTime: intent.startTime,
        endTime: intent.endTime,
        title: intent.title,
        category: category
      });
      var when = this.dateLabel(intent.date) + ' ' + intent.startTime + '–' + intent.endTime;
      var msg = '好的，已添加 ' + when + ' ' + intent.title +
        '（' + App.Config.categoryLabel[category] + '）。';
      if (intent.defaultsUsed.indexOf('endTime') >= 0) {
        msg += '未指定结束时间，默认安排 ' + App.Config.defaultDurationMin + ' 分钟。';
      }
      if (res.warning === 'past') {
        msg = '这个时间已经过了哦，已帮你记录为历史安排。';
      }
      this.announce(msg, { mood: 'happy', ms: 5000 });
    },

    /* ---- 整日复制：把某天的全部安排复制一份到另一天 ---- */
    doCopy: function (intent) {
      var src = intent.targetDate;
      var dst = intent.date;

      if (src === dst) {
        this.announce(this.dateLabel(src) + '就是它自己呀，不用复制啦～', { mood: 'idle', ms: 3500 });
        return;
      }

      var all = App.Manager.tasksOfDate(src);
      if (!all.length) {
        this.announce(this.dateLabel(src) + '没有安排，没什么可复制的哦。', { mood: 'idle', ms: 3500 });
        return;
      }
      var copies = all.filter(function (t) { return t.status !== 'done'; });
      var skipped = all.length - copies.length;
      if (!copies.length) {
        this.announce(this.dateLabel(src) + '的安排都已经完成了，没有可复制的，就不折腾啦～',
          { mood: 'idle', ms: 4000 });
        return;
      }

      // 冲突检测：直接问 Manager.overlaps（单日任务量小，不另建检测方法）。
      // 只比目标日当天：overlaps 本来就是同日语义，源的跨天尾段不会额外去比次日
      // （否则次日 00:30 会和「源任务次日 00:00-01:00」误判成撞车，其实差着一整天；
      //   doAdd 的既有检测也是这个范围，保持一致）
      var pairs = [], seen = {};
      copies.forEach(function (f) {
        var sMin = App.util.hmToMin(f.startTime);
        var eMin = App.util.hmToMin(f.endTime) + (f.endOffset || 0) * 1440;
        App.Manager.overlaps(dst, sMin, eMin).forEach(function (to) {
          var key = f.id + '|' + to.id;
          if (seen[key]) return;
          seen[key] = true;
          pairs.push({ from: f, to: to });
        });
      });

      var pend = { type: 'confirm-copy', intent: intent, pairs: pairs,
                   copies: copies, skipped: skipped };
      if (!pairs.length) {
        this.commitCopy(pend, 'keep');
        return;
      }

      this.pending = pend;
      var list = pairs.slice(0, 8).map(function (p) {
        return '<li class="conflict-pair">要复制 <b>' + App.util.escapeHtml(p.from.title) +
          '</b> ' + this.timeRange(p.from) + ' ／ 已有 <b>' + App.util.escapeHtml(p.to.title) +
          '</b> ' + this.timeRange(p.to) + '</li>';
      }, this).join('');
      if (pairs.length > 8) list += '<li>……还有 ' + (pairs.length - 8) + ' 对</li>';

      this.announce('把' + this.dateLabel(src) + '的 ' + copies.length + ' 项安排复制到' +
        this.dateLabel(dst) + (skipped ? '（另有 ' + skipped + ' 项已完成，不复制）' : '') +
        '，其中 ' + pairs.length + ' 对时间撞上了：<ul class="query-list">' + list + '</ul>' +
        '回复「重叠」撞上的两条都留下，回复「更换」把撞上的合并成一条' +
        '（名字用逗号连起来，如「英语课,晨读」），回复「取消」放弃。',
        { mood: 'alert', ms: 8000 });
    },

    commitCopy: function (pend, mode) {
      this.pending = null;
      // pending 期间 catchup 可能把这些任务标成 done、或别处已经删掉，提交前再过一遍
      var copies = pend.copies.filter(function (t) {
        return App.Manager.get(t.id) && t.status !== 'done';
      });
      var dst = pend.intent.date;
      if (!copies.length) {
        this.announce('要复制的安排都已经完成了，就不折腾啦～', { mood: 'idle', ms: 3500 });
        return;
      }

      var res = App.Manager.copyDay(copies, dst, mode, pend.pairs);
      var msg;
      if (mode === 'merge' && res.removed) {
        msg = '好的，' + res.removed + ' 项撞上的旧安排已合并进新安排（名字用逗号连起来），' +
          res.added + ' 项安排复制到' + this.dateLabel(dst) + ' 啦。';
      } else {
        msg = '好的，' + res.added + ' 项安排已复制到' + this.dateLabel(dst) +
          (pend.pairs.length ? '，冲突的也都留下啦。' : '。');
      }
      if (pend.skipped) msg += '（另有 ' + pend.skipped + ' 项已完成，没复制）';
      if (res.past) msg += '（' + res.past + ' 项已经过了时间，先记为已完成）';
      this.announce(msg, { mood: 'happy', ms: 5000 });
    },

    timeRange: function (t) {
      return t.startTime + '–' + t.endTime + (t.endOffset ? ' 次日' : '');
    },

    /* ---- 删除 ---- */
    doDelete: function (intent) {
      var candidates = App.Manager.findCandidates({
        date: intent.date,
        titleFrag: intent.target ? intent.target.titleFrag : null,
        startTime: intent.target ? intent.target.startTime : null
      });
      if (!candidates.length) {
        this.announce(this.dateLabel(intent.date) + '没有找到对应的安排哦。',
          { mood: 'idle', ms: 3500 });
        return;
      }
      if (candidates.length === 1) {
        var t = candidates[0];
        App.Manager.remove(t.id);
        this.announce('已删除「' + t.title + '」。', { mood: 'idle', ms: 3500 });
        return;
      }
      this.pending = { type: 'disambiguate', action: 'delete', candidates: candidates };
      this.listCandidates(candidates, '找到多条安排，回复序号告诉我删除哪一个：');
    },

    /* ---- 修改 ---- */
    doUpdate: function (intent) {
      var candidates = App.Manager.findCandidates({
        date: intent.targetDate || intent.date,
        titleFrag: intent.target ? intent.target.titleFrag : null,
        startTime: intent.target ? intent.target.startTime : null
      });
      if (!candidates.length) {
        this.announce('没有找到要修改的安排哦。', { mood: 'idle', ms: 3500 });
        return;
      }
      if (candidates.length > 1) {
        this.pending = { type: 'disambiguate', action: 'update', intent: intent, candidates: candidates };
        this.listCandidates(candidates, '找到多条安排，回复序号告诉我修改哪一个：');
        return;
      }
      this.commitUpdate(candidates[0].id, intent);
    },

    commitUpdate: function (id, intent) {
      var t = App.Manager.get(id);
      App.Manager.update(id, intent.patches || {});
      var parts = [];
      var p = intent.patches || {};
      if (p.date) parts.push('日期改到 ' + this.dateLabel(p.date));
      if (p.startTime) parts.push('时间改成 ' + p.startTime);
      this.announce('好的，「' + t.title + '」' + (parts.join('，') || '已更新') + '。',
        { mood: 'happy', ms: 4500 });
    },

    /* ---- 查询 ---- */
    doQuery: function (intent) {
      var d = intent.date;
      var now = App.Clock.now();
      var tasks = App.Manager.tasksOfDate(d).filter(function (t) {
        return !(intent.query.remainingOnly) || App.util.taskEndMs(t) > now;
      }).sort(function (a, b) {
        return a.startTime < b.startTime ? -1 : 1;
      });

      var label = this.dateLabel(d);
      if (!tasks.length) {
        this.announce(label + (intent.query.remainingOnly ? '没有剩余安排了，好好休息吧～' : '没有安排。'),
          { mood: 'idle', ms: 4000 });
        return;
      }
      var rows = tasks.map(function (t) {
        var state = App.util.taskEndMs(t) <= now ? '已完成' :
          (App.util.taskStartMs(t) <= now ? '进行中' : '待完成');
        return '<li><span class="q-time">' + t.startTime + '–' + t.endTime + '</span>' +
          '<span class="q-title">' + App.util.escapeHtml(t.title) + '</span>' +
          '<span class="q-state q-' + state + '">' + state + '</span></li>';
      }).join('');
      App.Output.pet(label + '有 ' + tasks.length + ' 项安排：<ul class="query-list">' + rows + '</ul>',
        { mood: 'idle' });
      App.Bubble.say(label + '有 ' + tasks.length + ' 项安排，看右边计划表哦', { ms: 4000 });
      App.bus.emit('query:highlight', { ids: tasks.map(function (t) { return t.id; }), date: d });
    },

    listCandidates: function (candidates, lead) {
      var rows = candidates.map(function (t, i) {
        return '<li><b>' + (i + 1) + '.</b> ' + t.startTime + '–' + t.endTime +
          ' ' + App.util.escapeHtml(t.title) + '</li>';
      }).join('');
      App.Output.pet(lead + '<ul class="query-list">' + rows + '</ul>', { mood: 'alert' });
      App.Bubble.say('找到 ' + candidates.length + ' 条，回复序号选择', { ms: 4000 });
    },

    /* ---- 待确认会话 ---- */
    handlePending: function (text) {
      var pend = this.pending;
      var index = this.parseIndex(text, pend.candidates ? pend.candidates.length : 0);

      if (/^(取消|算了|不要|否|n|no|不用)$/i.test(text)) {
        this.pending = null;
        this.announce('好的，已取消。', { mood: 'idle', ms: 2500 });
        return;
      }

      /* 模型意图的确认门 */
      if (pend.type === 'confirm-intent') {
        if (/^(确认|确定|是|对|好|好的|嗯|y|yes|继续|执行|可以|ok)$/i.test(text)) {
          this.pending = null;
          this.routeIntent(pend.intent);   // 用户点过头了，这一遍不再拦
          return;
        }
        /* 既不是确认也不是取消（取消在上面统一处理）：多半是在纠正理解。
           撤掉待确认，把这句话当新指令重放一遍，省得用户照着原话再打一次。
           echo:false 因为这条消息已经上过屏了 */
        this.pending = null;
        this.handle(text, { echo: false });
        return;
      }

      if (pend.type === 'confirm-add') {
        if (/^(确认|确定|是|对|好|好的|嗯|y|yes|继续|添加)$/i.test(text)) {
          this.pending = null;
          this.commitAdd(pend.intent);
        } else {
          App.Bubble.say('回复「确认」或「取消」哦', { ms: 2500 });
        }
        return;
      }

      if (pend.type === 'disambiguate' && index != null) {
        var chosen = pend.candidates[index];
        this.pending = null;
        if (pend.action === 'delete') {
          App.Manager.remove(chosen.id);
          this.announce('已删除「' + chosen.title + '」。', { mood: 'idle', ms: 3500 });
        } else {
          this.commitUpdate(chosen.id, pend.intent);
        }
        return;
      }

      App.Bubble.say('请回复序号，或「取消」', { ms: 2500 });
    },

    parseIndex: function (text, max) {
      var m = /^第?([0-9]+)[条个项]?$/.exec(text);
      if (m) {
        var n = +m[1] - 1;
        if (n >= 0 && n < max) return n;
        return null;
      }
      var cn = ['一', '二', '两', '三', '四', '五'];
      for (var i = 0; i < cn.length; i++) {
        if (text === cn[i] || text === '第' + cn[i] + '个') {
          var idx = cn[i] === '两' ? 1 : i;
          if (idx < max) return idx;
        }
      }
      return null;
    },

    dateLabel: function (d) {
      var today = App.Clock.today();
      if (d === today) return '今天';
      if (d === App.util.addDaysStr(today, 1)) return '明天';
      if (d === App.util.addDaysStr(today, 2)) return '后天';
      var date = App.util.parseDateStr(d);
      return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()] +
        ' ' + App.util.pad2(date.getMonth() + 1) + '-' + App.util.pad2(date.getDate());
    },

    /* ---- 安排表 / 备份 按钮 ---- */
    bindUI: function () {
      var self = this;

      function readFile(file, cb) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () { cb(String(reader.result || ''), file); };
        reader.readAsText(file, 'utf-8');
      }

      // 取文件后立刻清空 input，同一文件才能重复选中
      function pickFile(e) {
        var input = e.target;
        var file = input.files && input.files[0];
        input.value = '';
        return file || null;
      }

      document.getElementById('btn-import').addEventListener('click', function () {
        document.getElementById('file-csv').click();
      });

      document.getElementById('btn-template').addEventListener('click', function () {
        if (!App.ScheduleTemplate) {
          App.Output.error('模板数据没加载出来（schedule/scheduleTemplate.js 缺失或损坏），' +
            '可以直接打开 data/schedule_template.pdf 另存。');
          return;
        }
        try {
          App.util.downloadBlob(App.ScheduleTemplate.blob(), App.ScheduleTemplate.fileName);
          App.Output.system('已下载模板 ' + App.ScheduleTemplate.fileName +
            '，填好后用「导入安排表」选中它。');
        } catch (e) {
          App.Output.error('下载模板失败：' + e.message);
        }
      });
      document.getElementById('file-csv').addEventListener('change', function (e) {
        var file = pickFile(e);
        if (!file) return;
        if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
          var reader = new FileReader();
          reader.onload = function () { self.importPDF(reader.result); };
          reader.onerror = function () {
            App.Output.error('读取 PDF 文件失败。');
            App.Bubble.say('PDF 读取失败', { ms: 3500 });
          };
          reader.readAsArrayBuffer(file);
        } else {
          readFile(file, function (text) { self.importCSV(text); });
        }
      });

      document.getElementById('btn-export').addEventListener('click', function () {
        var ok = App.Storage.exportBackup(App.Manager.serialize());
        if (!ok) App.Output.system('浏览器拦截了下载，已在新窗口展示备份内容，请手动另存。');
      });

      document.getElementById('btn-import-backup').addEventListener('click', function () {
        document.getElementById('file-backup').click();
      });
      document.getElementById('file-backup').addEventListener('change', function (e) {
        readFile(pickFile(e), function (text) {
          var res = App.Storage.restoreFromText(text);
          if (res.ok) {
            App.Output.system('备份已恢复。');
            location.reload();
          } else {
            App.Output.error('备份文件无法识别：' + res.message);
          }
        });
      });

      document.getElementById('chat-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('chat-text');
        self.handle(input.value);
        input.value = '';
        input.focus();
      });
    },

    importCSV: function (text) {
      var result = App.Parser.parseCSV(text, App.Clock.now());
      if (result.fatal) {
        App.Output.error('导入失败：' + result.fatal +
          '<br>正确表头应为：<code>date,start,end,title,category</code>');
        App.Bubble.say('CSV 格式不对，导入失败', { ms: 3500 });
        return;
      }
      this.confirmImport(result);
    },

    // PDF 走 App.PdfImporter：五列模板直接出结果，网格课表再多一步「展开成日程」
    importPDF: function (arrayBuffer) {
      var self = this;
      App.PdfImporter.import(arrayBuffer, App.Clock.now()).then(function (result) {
        if (result.fatal) {
          App.Output.error('导入失败：' + result.fatal +
            '<br>请下载模板填好后导入（模板内的说明文字会被自动忽略）。');
          App.Bubble.say('PDF 解析失败', { ms: 3500 });
          return;
        }
        if (result.timetable) {
          self.expandTimetable(result.timetable, result.termMonday, result.termSource);
          return;
        }
        self.confirmImport(result);
      });
    },

    /* 网格课表：按推断出的「第 1 周周一」展开成具体日程。
       日期推断值直接写进待确认报告，用户回复一个日期就能重算 —— 不需要额外的问答回合 */
    expandTimetable: function (timetable, termMonday, termSource) {
      var result = App.TimetableImporter.expand(timetable, termMonday, App.Clock.now());
      var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
        App.util.parseDateStr(termMonday).getDay()];
      var note = '识别为课表：' + timetable.length + ' 门课。' +
        '学期第 1 周按 <b>' + termMonday + '</b>（' + week + '，' +
        (termSource === 'saved' ? '上次用过的值' : '按课表打印日期推断') +
        '）计算；如果不对，直接回复正确的第 1 周周一日期（YYYY-MM-DD），我会重新算。';

      if (result.fatal) {
        App.Output.error('导入失败：' + result.fatal);
        App.Bubble.say('课表日期需要确认', { ms: 4000 });
        // 仍进待确认态：用户回一个日期就能继续，不用重新选文件
        this.pending = {
          type: 'confirm-import', rows: [], termInfo: { timetable: timetable },
          report: note + '<br>' + App.util.escapeHtml(result.fatal)
        };
        App.Output.pet(this.pending.report, { mood: 'alert' });
        return;
      }
      result.termNote = note;
      this.confirmImport(result, { timetable: timetable, termMonday: termMonday });
    },

    // CSV 与 PDF 共用：错误汇总 -> 待确认 -> 等用户回复确认/替换/取消
    confirmImport: function (result, termInfo) {
      var errorText = '';
      if (result.errors.length) {
        errorText = '<br>错误 ' + result.errors.length + ' 条已跳过：<ul class="query-list">' +
          result.errors.map(function (e) {
            return '<li>' + (e.line ? '第 ' + e.line + ' 行：' : '') +
              App.util.escapeHtml(e.message) + '</li>';
          }).join('') + '</ul>';
      }

      if (!result.rows.length) {
        App.Output.error('没有可导入的有效记录。' + errorText);
        App.Bubble.say('没有可导入的有效记录', { ms: 3500 });
        return;
      }

      this.pending = {
        type: 'confirm-import',
        rows: result.rows,
        termInfo: termInfo || null,
        report: (result.termNote ? result.termNote + '<br>' : '') +
          '解析完成：可导入 ' + result.rows.length + ' 条，错误 ' +
          result.errors.length + ' 条。回复「确认」合并导入（重复的自动跳过），' +
          '回复「替换」清空现有日程后导入，回复「取消」放弃。' + errorText
      };
      App.Output.pet(this.pending.report, { mood: 'alert' });
      App.Bubble.say('解析到 ' + result.rows.length + ' 条安排，确认导入吗？', { ms: 4500 });
    },

    handleImport: function (text) {
      var pend = this.pending;
      var mode = /替换/.test(text) ? 'replace' : 'merge';
      this.pending = null;
      var res = App.Manager.mergeFromRows(pend.rows, mode);
      var msg = '导入完成：新增 ' + res.added + ' 条，跳过重复 ' + res.skipped + ' 条。';
      App.bus.emit('schedule:imported', { message: msg });
    }
  };

  // 补充 pending 会话中导入确认的分发
  var originalHandlePending = App.Controller.handlePending;
  App.Controller.handlePending = function (text) {
    if (this.pending && this.pending.type === 'confirm-import') {
      // 课表导入期间回复日期 = 修正「第 1 周周一」，按新日期重算后继续等确认
      if (this.pending.termInfo && App.util.parseDateStr(text.trim())) {
        var term = text.trim();
        var result = App.TimetableImporter.expand(
          this.pending.termInfo.timetable, term, App.Clock.now());
        App.TimetableImporter.rememberTerm(term);
        if (result.fatal) {
          App.Output.error(result.fatal);
          App.Bubble.say('这个日期算下来没有课，换一个试试', { ms: 3500 });
          return;
        }
        result.termNote = '学期第 1 周已按 <b>' + term + '</b> 重新计算。';
        this.confirmImport(result, { timetable: this.pending.termInfo.timetable, termMonday: term });
        return;
      }
      if (/^(取消|算了|不要|否|n|no)$/i.test(text)) {
        this.pending = null;
        this.announce('好的，已取消导入。', { mood: 'idle', ms: 2500 });
        return;
      }
      if (/^(确认|确定|是|对|好|好的|嗯|y|yes|继续|导入|替换|merge|replace)$/i.test(text) ||
          /替换/.test(text)) {
        this.handleImport(text);
        return;
      }
      App.Bubble.say('回复「确认」「替换」或「取消」哦', { ms: 2500 });
      return;
    }
    originalHandlePending.call(this, text);
  };

  // 再补一层：整日复制的冲突确认（在导入确认之后包，所以先于它分发）
  var originalHandlePendingCopy = App.Controller.handlePending;
  App.Controller.handlePending = function (text) {
    if (this.pending && this.pending.type === 'confirm-copy') {
      var pend = this.pending;
      // 原 handlePending 的「取消」分支在类型分发之前，这里被整段截胡了，得自己认
      if (/^(取消|算了|不要|否|n|no|不用)$/i.test(text)) {
        this.pending = null;
        this.announce('好的，已取消复制，原来的安排都没动哦。', { mood: 'idle', ms: 3000 });
        return;
      }
      if (/(重叠|都留|都保留|保留|留着)/.test(text)) {
        this.commitCopy(pend, 'keep');
        return;
      }
      if (/(更换|替换|换掉|合并|并成)/.test(text)) {
        this.commitCopy(pend, 'merge');
        return;
      }
      App.Bubble.say('回复「重叠」「更换」或「取消」哦', { ms: 2500 });
      return;
    }
    originalHandlePendingCopy.call(this, text);
  };

  /* ---------------- 调试钩子 ---------------- */

  App.debug = {
    set: function (hm, d) {
      App.Clock.setTime(hm, d);
      App.StateMachine.tick(App.Clock.now());
      console.log('[debug] time ->', App.Clock.nowDate().toLocaleString());
    },
    tick: function () { App.StateMachine.tick(App.Clock.now()); },
    refuse: function () { App.StateMachine.requestRefuse(); },
    state: function () { return App.StateMachine.snapshot(); },
    seed: function () {
      var now = App.Clock.nowDate();
      var today = dateStr(now);
      var mins = now.getHours() * 60 + now.getMinutes();
      function t(start, title, cat, dayOffset) {
        var d = dayOffset ? addDaysStr(today, dayOffset) : today;
        App.Manager.add({
          date: d, startTime: minToHm(start), endTime: minToHm(start + 60),
          title: title, category: cat
        });
      }
      t(mins - 20, '当前进行的学习任务', 'studying');
      t(mins + 60, '一小时后的工作会议', 'working');
      t(mins + 180, '阅读时间', 'studying');
      t(9 * 60, '明天上午的数学复习', 'studying', 1);
      App.Output.pet('已灌入演示数据，右侧计划表可查看。', { mood: 'happy' });
    }
  };

  /* ---------------- 启动引导 ---------------- */

  function boot() {
    App.Clock.init();
    App.Manager.init();

    var stage = document.getElementById('stage');
    App.Animation.init(stage);
    App.Animation.preload(params.get('novideo') === '1');

    App.Bubble.init(document.getElementById('bubble'));
    App.Output.init(document.getElementById('chat-log'));
    App.PlanView.init(document.getElementById('plan-list'));

    App.Controller.bindEvents();
    App.Controller.bindUI();
    App.Settings.init();   // 需在 Bubble / Output 之后，提示信息才能正常显示
    // 本地模型：仅在开关打开时才会发探活请求，关闭时静默（见 dialog/llm.js）
    if (App.LLM) App.LLM.init(App.Settings.llm);
    App.Pip.init();        // 依赖 Settings.bg 与 Animation

    App.StateMachine.init(App.Clock.now());
    setInterval(function () {
      App.StateMachine.tick(App.Clock.now());
    }, App.Config.tickMs);

    if (params.get('demo') === '1') App.debug.seed();

    if (!App.Manager.all().length) {
      App.Output.pet('你好呀～我是你的桌面日程小助手。可以点上方「导入安排表」批量导入，' +
        '也可以直接跟我说，比如「明天下午两点半上英语课」。', { mood: 'idle' });
    } else {
      var remaining = App.Manager.remainingToday();
      App.Output.pet('欢迎回来～今天还有 ' + remaining.length + ' 项安排，我会按时提醒你的。',
        { mood: 'idle' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
