/*
 * dialog/input.js — 自然语言指令解析（纯函数，不依赖 DOM）
 * parse(text, {now}) -> intent 对象
 *   { ok, intent:'add'|'delete'|'update'|'query'|'copy', date, startTime, endTime,
 *     title, category, target, targetDate, patches, query, defaultsUsed }
 *   失败 -> { ok:false, reason, reasonText, examples }
 */
(function () {
  'use strict';
  var App = window.App;
  var util = App.util;

  /* ---------------- 中文数字 ---------------- */

  var CN = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
             '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  function cnToNum(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (/^\d+$/.test(s)) return +s;
    if (s.indexOf('十') >= 0) {
      var parts = s.split('十');
      var tens = parts[0] === '' ? 1 : (CN[parts[0]] != null ? CN[parts[0]] : null);
      var ones = parts[1] === '' ? 0 : (CN[parts[1]] != null ? CN[parts[1]] : null);
      if (tens == null || ones == null) return null;
      return tens * 10 + ones;
    }
    return (s.length === 1 && CN[s] != null) ? CN[s] : null;
  }

  // 数字片段：阿拉伯数字 / 中文单字 / 十X
  var NUM = '(?:\\d{1,2}|[零〇一二两三四五六七八九]|十[一二]?)';
  // 分钟片段：半/一刻/三刻/XX分/紧跟的裸数字
  var MIN = '(?:半|一刻|两刻|二刻|三刻|\\d{1,2}\\s*分|[零〇一二两三四五六七八九]{1,3}\\s*分|\\d{1,2})';

  // 「晚」单字也算：口语里「晚8点」不带「上」字。它只在后面紧跟数字+点/时才可能命中，
  // 所以「晚会」「晚餐」这类词不会被误吃。
  // 「今晚/明晚/后晚」列在「晚」前面：这三个词同时带日期，让整体一起被吃掉，
  // 否则 findDate 只吃掉「今晚」、findTime 从「晚」开始，两个 span 会错位
  var PERIOD = '(上午|早上|早晨|清晨|中午|下午|晚上|傍晚|夜里|夜晚|凌晨|今晚|明晚|后晚|晚)';

  function timeRe() {
    return new RegExp(PERIOD + '?\\s*(' + NUM + ')\\s*[点时:：]\\s*(' + MIN + ')?', 'g');
  }

  /* 时段前缀 -> 24 小时制；返回 {h, nextDay} 或 null */
  function applyPeriod(h, period) {
    if (h == null || h > 24) return null;
    if (h === 24) h = 0;
    switch (period) {
      case '上午': case '早上': case '早晨': case '清晨':
        if (h === 12) h = 0;
        break;
      case '凌晨':
        if (h === 12) h = 0;
        break;
      case '中午':
        if (h < 6) h += 12;          // 中午一点 -> 13
        break;
      case '下午': case '傍晚':
        if (h === 12) h = 12;        // 下午十二点 -> 12
        else if (h < 12) h += 12;
        break;
      case '晚上': case '夜里': case '夜晚': case '晚':
      case '今晚': case '明晚': case '后晚':
        if (h === 12) return { h: 0, nextDay: true };   // 晚上十二点 -> 次日 00:00
        if (h < 12) h += 12;
        break;
    }
    return { h: h, nextDay: false };
  }

  function parseMinToken(tok) {
    if (!tok) return 0;
    tok = String(tok).trim();
    if (tok === '半') return 30;
    if (tok === '一刻') return 15;
    if (tok === '两刻' || tok === '二刻') return 30;
    if (tok === '三刻') return 45;
    var m = /^(.+?)\s*分$/.exec(tok);
    if (m) {
      var n = cnToNum(m[1]);
      return n != null && n >= 0 && n < 60 ? n : null;
    }
    var d = cnToNum(tok);
    return d != null && d >= 0 && d < 60 ? d : null;
  }

  /* 在 text 中找时间；返回 {h,m,start,end,period} 或 null */
  function findTime(text, from) {
    var re = timeRe();
    re.lastIndex = from || 0;
    var m = re.exec(text);
    if (!m) return null;

    var period = m[1] || null;
    var hour = cnToNum(m[2]);
    var min = parseMinToken(m[3]);
    if (hour == null || min == null) return null;

    var applied = applyPeriod(hour, period);
    if (!applied) return null;

    return {
      h: applied.h, m: min, nextDay: applied.nextDay, period: period,
      start: m.index, end: m.index + m[0].length
    };
  }

  /* ---------------- 日期 ---------------- */

  var WD = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };

  /* 在 text 中找日期；返回 {date, start, end} 或 null */
  function findDate(text, today) {
    var m;

    // 相对日
    m = /(大后天|后天|明天|明日|今天|今日|今儿|今晚|明晚|后晚)/.exec(text);
    if (m) {
      var delta = { '大后天': 3, '后天': 2, '明天': 1, '明日': 1,
                    '今天': 0, '今日': 0, '今儿': 0,
                    '今晚': 0, '明晚': 1, '后晚': 2 }[m[1]];
      return { date: util.addDaysStr(today, delta), start: m.index, end: m.index + m[1].length };
    }

    // 星期
    m = /(下个|下|这|本)?(?:星期|礼拜|周)([一二三四五六日天])/.exec(text);
    if (m) {
      var target = WD[m[2]];
      var cur = util.parseDateStr(today).getDay();
      var diff;
      if (m[1] === '下' || m[1] === '下个') {
        // 下周X：本周同一 weekday 再 +7（今天恰好是 X 则为 7 天后）
        diff = (target - cur) + 7;
      } else {
        // 这周X / 无前缀：本周内最近一次；今天即今天，已过则落到下周
        diff = ((target - cur) + 7) % 7;
      }
      return {
        date: util.addDaysStr(today, diff),
        start: m.index, end: m.index + m[0].length
      };
    }

    // 具体日期 YYYY-MM-DD
    m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
    if (m) {
      var ds = m[1] + '-' + util.pad2(m[2]) + '-' + util.pad2(m[3]);
      if (util.parseDateStr(ds)) {
        return { date: ds, start: m.index, end: m.index + m[0].length };
      }
    }

    // M月D号/日
    m = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日]/.exec(text);
    if (m) {
      var mo = cnToNum(m[1]), day = cnToNum(m[2]);
      if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
        var year = util.parseDateStr(today).getFullYear();
        var cand = year + '-' + util.pad2(mo) + '-' + util.pad2(day);
        if (cand < today) cand = (year + 1) + '-' + util.pad2(mo) + '-' + util.pad2(day);
        return { date: cand, start: m.index, end: m.index + m[0].length };
      }
    }

    return null;
  }

  /* ---------------- 时长 ---------------- */

  function findDuration(text) {
    var m, n;
    m = /(?:一个半|1个半|一|1)\s*个?\s*半\s*小时/.exec(text);
    if (m) return { min: 90, start: m.index, end: m.index + m[0].length };

    m = /(?:半\s*个?\s*小时)/.exec(text);
    if (m) return { min: 30, start: m.index, end: m.index + m[0].length };

    m = /(\d{1,2}|[一二三四五六七八九]|十[一二]?)\s*个?\s*小时/.exec(text);
    if (m) {
      n = cnToNum(m[1]);
      if (n) return { min: n * 60, start: m.index, end: m.index + m[0].length };
    }
    m = /(\d{1,3})\s*分钟/.exec(text);
    if (m) return { min: +m[1], start: m.index, end: m.index + m[0].length };

    return null;
  }

  /* ---------------- 分类 ---------------- */

  function classify(text) {
    var ent = util.findEntertainment(text);
    if (ent) return { category: 'entertainment', keyword: ent };
    return { category: util.guessCategory(text), keyword: null };
  }

  /* ---------------- 标题清洗 ---------------- */

  // 按 span 列表删除片段，再清理残留的意图词/量词/语气词
  function stripSpans(text, spans) {
    spans = spans.filter(Boolean).sort(function (a, b) { return a.start - b.start; });
    var out = '', cursor = 0;
    spans.forEach(function (s) {
      // 两个 span 重叠（如「今晚8点」的日期 span 和时段 span）时并起来，
      // 直接 return 会把后一个 span 的尾部留在标题里
      if (s.start < cursor) { cursor = Math.max(cursor, s.end); return; }
      out += text.slice(cursor, s.start);
      cursor = s.end;
    });
    out += text.slice(cursor);
    return out;
  }

  var NOISE = [
    /^(?:帮我|给我|请|麻烦|麻烦你|能不能|可不可以|我想|我要|我想要|我打算|我准备)+/,
    /(?:提醒我|提示我|记得|别忘了)/g,
    /(?:添加|新增|新建|安排|加|预约|订|建立|创建|记一下|记录)/g,
    /(?:一个|一场|一次|一件|一条|个|场|次|件|条)/g,
    /^(?:有个|有场|有|来|去|上|做|参加|开始|进行)+/,
    /(?:有没有|有木有|还有什么|有什么|有哪些)/g,
    /(?:改成|改到|改为|换成|换到|挪到|调整到|调整成|调整|改|挪|换|删除|删掉|删|取消|去掉|移除|不要了|不要|把|将)/g,
    /[，,。.！!？?、；;：:"'“”‘’（）()\[\]【】]/g,
    /\s+/g
  ];

  // 首尾残留的虚词：的/了/地/得 在句首，语气词与介词在句尾
  var EDGE_RE = /^(?:的|了|地|得)+|(?:的|了|吧|呢|啊|哦|呀|嘛|哈|一下|在|于|和|与|跟|给|对)+$/;

  function cleanTitle(raw) {
    var t = String(raw || '');
    NOISE.forEach(function (re) { t = t.replace(re, ''); });
    // 反复剥离首尾虚词，直到稳定（如「的阅读在」-> 「阅读」）
    var prev;
    do {
      prev = t;
      t = t.replace(EDGE_RE, '');
    } while (t !== prev);
    return t.trim();
  }

  /* ---------------- 意图识别 ---------------- */

  var DELETE_RE = /(取消|删掉|删除|删了|去掉|移除|不要了|别再|不用了)/;
  var QUERY_RE = /(还有什么|有什么安排|什么安排|有什么|有哪些|有哪些安排|日程列表|安排表|列表|安排是|^看看|查一下|看一下|今天安排|明天安排)/;
  var UPDATE_SPLIT_RE = /(改成|改到|改为|换成|换到|挪到|调整到|调整成|调整|改成)/;
  var UPDATE_RE = /(改|挪|调整|换)/;
  var ADD_RE = /(加|添加|新增|新建|安排|提醒我|要上|有个|预约|订|记一下|记录)/;
  /* 复制整天：粗判词与切分点分开。
     不收裸「抄」（免得「抄作业」被判成复制），也不收「搬到」——「搬」是移动语义，
     本功能源日保留，想移动请用「挪到」。 */
  var COPY_WORD_RE = /(复制|拷贝|抄到)/;
  var COPY_SPLIT_RE = /(复制到|拷贝到|抄到|复制至|拷贝至)/;

  var EX = {
    add: ['明天下午两点半上英语课', '晚上七点有个会议', '后天9点到11点数学复习'],
    delete: ['取消明天的英语课', '把三点的会议删掉'],
    update: ['把下午三点的会议改成四点', '英语课挪到周五'],
    query: ['今天还有什么安排', '明天有什么'],
    copy: ['把明天的安排复制到周五', '把9月20日的安排复制到9月25日'],
    idle: ['我想玩游戏', '明天下午两点半上英语课', '今天还有什么安排']
  };

  function fail(reason, examples) {
    var reasonText = {
      no_intent: '没太听懂你想做什么～可以说「添加」「删除」「修改」「查询」「复制」相关的话。',
      no_time: '要安排在几点呢？',
      no_title: '这件事叫什么名字呢？',
      ambiguous_date: '没听清是哪一天，可以说明「今天」「明天」或具体日期。',
      copy_no_target: '要复制到哪一天呢？说「把明天的安排复制到周五」这样就行。',
      copy_day_only: '复制整天是把那一天的全部安排都搬过去，名字和时间不用写哦～'
    }[reason] || '没太听懂。';
    return {
      ok: false, reason: reason, reasonText: reasonText,
      examples: examples || EX.add || []
    };
  }

  /* ---------------- 主解析 ---------------- */

  function preprocess(text) {
    return String(text || '')
      .replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);   // 全角数字
      })
      .replace(/[Ａ-Ｚａ-ｚ]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);   // 全角字母
      })
      .replace(/：/g, ':')
      .replace(/－|–|—|～/g, '-')
      .replace(/[　 ]/g, ' ')
      .trim();
  }

  function parseWhen(text, today) {
    // 日期
    var d = findDate(text, today);
    var date = d ? d.date : today;

    // 时间
    var t1 = findTime(text);
    var result = {
      date: date,
      startTime: null, endTime: null, durationMin: null,
      spans: [d, t1], defaultsUsed: []
    };
    if (!t1) return result;

    // 跨天：晚上十二点 -> 次日
    if (t1.nextDay && !d) date = util.addDaysStr(date, 1);

    // 区间：起点 到 终点
    var tail = text.slice(t1.end);
    var sep = /^\s*(?:到|至|~|-|—)\s*/.exec(tail);
    var t2 = null;
    if (sep) {
      t2 = findTime(text, t1.end + sep[0].length);
      if (t2) {
        result.spans.push({ start: t1.end, end: t2.start });
        result.spans.push(t2);
      }
    }

    result.date = date;
    result.startTime = util.minToHm(t1.h * 60 + t1.m);

    if (t2) {
      // 「下午2点到4点」：终点没写时段时继承起点的时段，否则 4 点会被当成凌晨，
      // 被判成跨天到次日 04:00。只在继承后晚于起点时才采纳，
      // 这样「晚上10点到2点」这种真想跨夜的说法不受影响。
      var endH = t2.h;
      if (!t2.period && t1.period) {
        var inh = applyPeriod(t2.h, t1.period);
        if (inh && inh.h * 60 + t2.m > t1.h * 60 + t1.m) endH = inh.h;
      }
      // 结束早于开始由 Manager.add 自动判定为跨天（endOffset=1）
      result.endTime = util.minToHm(endH * 60 + t2.m);
    } else {
      var dur = findDuration(text);
      if (dur) {
        result.durationMin = dur.min;
        result.endTime = util.minToHm(t1.h * 60 + t1.m + dur.min);
        result.spans.push({ start: dur.start, end: dur.end });
      } else {
        result.durationMin = App.Config.defaultDurationMin;
        result.endTime = util.minToHm(t1.h * 60 + t1.m + App.Config.defaultDurationMin);
        result.defaultsUsed.push('endTime');
      }
    }
    return result;
  }

  App.Input = {
    parse: function (raw, ctx) {
      var today = util.dateStr(new Date((ctx && ctx.now) || App.Clock.now()));
      var text = preprocess(raw);
      if (!text) return fail('no_intent');

      /* --- 0. 复制整天：把 X 的安排复制到 Y ---
         必须压在其余意图前面：「安排」在 ADD_RE 里、「挪到」在 UPDATE_SPLIT_RE 里，
         一旦落到后面就会被 add/update 抢走。
         字段惯例沿用 update：date=目标日（搬到哪），targetDate=源日（从哪搬）。
         左边不写日期就是今天；右边必须有日期，否则不知道往哪复制。 */
      if (COPY_WORD_RE.test(text)) {
        var cos = COPY_SPLIT_RE.exec(text);
        if (!cos) return fail('copy_no_target', EX.copy);

        var csLeft = text.slice(0, cos.index);
        var csRight = text.slice(cos.index + cos[0].length);

        var csSrc = findDate(csLeft, today);
        var csDst = findDate(csRight, today);
        if (!csDst) return fail('copy_no_target', EX.copy);

        // 只做整天复制：左边写了名字或时间（「把明天下午三点的会议复制到周五」）
        // 就拦下来给例句，绝不静默地把一整天都搬过去
        if (cleanTitle(stripSpans(csLeft, [csSrc, findTime(csLeft)]))) {
          return fail('copy_day_only', EX.copy);
        }

        return {
          ok: true, intent: 'copy',
          date: csDst.date,
          targetDate: csSrc ? csSrc.date : today,
          startTime: null, endTime: null, title: null,
          category: null, target: null, patches: null, query: null,
          defaultsUsed: []
        };
      }

      /* --- 1. 修改句：把 X 改成 Y（「把」可省略） --- */
      var split = UPDATE_SPLIT_RE.exec(text);
      if (split) {
        var left = text.slice(0, split.index);
        var right = text.slice(split.index + split[0].length);

        var tDate = findDate(left, today);
        var tTime = findTime(left);
        var tTitle = cleanTitle(stripSpans(left, [tDate, tTime]));

        var pDate = findDate(right, today);
        var pTime = findTime(right);
        var dur = findDuration(right);

        // 「把下午三点的会议改成四点」：新时间没带时段前缀时，继承原时间的时段（16:00 而非 04:00）
        var patchMin = null;
        if (pTime) {
          var ph = pTime.h;
          if (!pTime.period && tTime && tTime.period) {
            var shifted = applyPeriod(pTime.h, tTime.period);
            if (shifted) ph = shifted.h;
          }
          patchMin = ph * 60 + pTime.m;
        }

        var patches = {};
        if (pDate) patches.date = pDate.date;
        if (patchMin != null) patches.startTime = util.minToHm(patchMin);
        if (dur) patches.durationMin = dur.min;

        if (patches.date || patches.startTime) {
          return {
            ok: true, intent: 'update',
            date: pDate ? pDate.date : (tDate ? tDate.date : today),
            targetDate: tDate ? tDate.date : today,
            startTime: patchMin != null ? util.minToHm(patchMin) : null,
            endTime: null,
            title: tTitle || null,
            category: classify(tTitle || text).category,
            target: {
              titleFrag: tTitle || null,
              startTime: tTime ? util.minToHm(tTime.h * 60 + tTime.m) : null
            },
            patches: patches,
            query: null,
            defaultsUsed: []
          };
        }
      }

      /* --- 2. 删除 --- */
      if (DELETE_RE.test(text)) {
        var dDate = findDate(text, today);
        var dTime = findTime(text);
        var dTitle = cleanTitle(stripSpans(text, [dDate, dTime]));
        if (!dTitle && !dTime) return fail('no_title');
        return {
          ok: true, intent: 'delete',
          date: dDate ? dDate.date : today,
          targetDate: dDate ? dDate.date : today,
          startTime: dTime ? util.minToHm(dTime.h * 60 + dTime.m) : null,
          endTime: null,
          title: dTitle || null,
          category: classify(dTitle || text).category,
          target: {
            titleFrag: dTitle || null,
            startTime: dTime ? util.minToHm(dTime.h * 60 + dTime.m) : null
          },
          patches: null, query: null, defaultsUsed: []
        };
      }

      /* --- 3. 查询 --- */
      if (QUERY_RE.test(text)) {
        var qDate = findDate(text, today);
        return {
          ok: true, intent: 'query',
          date: qDate ? qDate.date : today,
          targetDate: qDate ? qDate.date : today,
          startTime: null, endTime: null, title: null,
          category: null, target: null, patches: null,
          query: { scope: qDate ? 'date' : 'today', remainingOnly: true },
          defaultsUsed: []
        };
      }

      /* --- 4. 修改（无「把」）：英语课挪到周五 --- */
      if (UPDATE_RE.test(text) && !ADD_RE.test(text)) {
        var uDate = findDate(text, today);
        var uTime = findTime(text);
        var uTitle = cleanTitle(stripSpans(text, [uDate, uTime]));
        if (uTitle || uTime) {
          return {
            ok: true, intent: 'update',
            date: uDate ? uDate.date : today,
            targetDate: today,
            startTime: uTime ? util.minToHm(uTime.h * 60 + uTime.m) : null,
            endTime: null,
            title: uTitle || null,
            category: classify(uTitle || text).category,
            target: {
              titleFrag: uTitle || null,
              startTime: uTime ? util.minToHm(uTime.h * 60 + uTime.m) : null
            },
            patches: uDate ? { date: uDate.date } : (uTime ? { startTime: util.minToHm(uTime.h * 60 + uTime.m) } : {}),
            query: null, defaultsUsed: []
          };
        }
      }

      /* --- 5. 新增 --- */
      var when = parseWhen(text, today);
      var hasTime = !!when.startTime;
      var aTitle = cleanTitle(stripSpans(text, when.spans));
      var explicitAdd = ADD_RE.test(text);

      if (explicitAdd || hasTime) {
        if (!hasTime) {
          if (ADD_RE.test(text) && aTitle) return fail('no_time');
          return fail('no_intent');
        }
        if (!aTitle) return fail('no_title');
        var cls = classify(aTitle);
        return {
          ok: true, intent: 'add',
          date: when.date,
          targetDate: when.date,
          startTime: when.startTime,
          endTime: when.endTime,
          durationMin: when.durationMin,
          title: aTitle,
          category: cls.category,
          target: null, patches: null, query: null,
          defaultsUsed: when.defaultsUsed
        };
      }

      /* --- 6. 无时间的娱乐请求：交给 Controller 判断是否在任务时段拦截 --- */
      var entWord = util.findEntertainment(text);
      if (entWord) {
        return {
          ok: true, intent: 'add',
          date: today, targetDate: today,
          startTime: null, endTime: null, durationMin: null,
          title: entWord, category: 'entertainment',
          target: null, patches: null, query: null,
          defaultsUsed: []
        };
      }

      return fail('no_intent');
    },

    fail: fail,
    cleanTitle: cleanTitle,
    cnToNum: cnToNum
  };
})();
