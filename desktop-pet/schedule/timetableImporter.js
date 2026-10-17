/*
 * schedule/timetableImporter.js — 教务系统「星期×节次」网格课表识别与展开
 *
 * 支持两种教务导出样式：
 *
 * 1) 老版 90° 旋转网格：节次沿横向铺开（跨页成一列条带），星期一到日沿纵向排 7 行。
 *    每个格子里的文字是垂直书写的多行：
 *        软件测试与管理
 *        (3-4节)1-9周/校区:江门校区/场地:H4-413（江）/教师:张志威/…
 *
 * 2) 常规横向表格（WPS / Excel 导出）：星期一到日排在同一个表头行，节次从上往下排，
 *    每个格子的文字按列宽折行，元数据一般以「学分:X」收尾：
 *        软件测试与管理
 *        (1-2节)1-9周
 *        校区:江门校区
 *        场地:H4-413(江)/教师:张志威
 *        …
 *        总学时:18/学分:2.0
 *
 * 本模块把两种版面都还原成 [{title, weekday, startTime, endTime, weeks}]，
 * 再由 expand() 展开成五列 CSV 交给 App.Parser.parseCSV —— 校验、去重、错误报告全部复用。
 *
 * 输出与 parser 同构：{ fatal, rows, errors, warnings }
 */
(function () {
  'use strict';
  var App = window.App;

  var DAY_CHARS = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
  var DAY_TOL = 52;      // 星期行 y 容差（行距约 104pt，取半）
  var RUN_GAP = 14;      // 同一视觉行内相邻文本块的 x 间距上限（行距 12pt，块间 12~13.5pt）
  var STRIP_PAD = 8;     // 条带左边界余量：x 小于「最小节次标签 x - 此值」视为跨页续接区
  var TITLE_MAX = 40;    // 与 parser 的标题长度上限一致
  var LINE_TOL = 2.5;    // 横向表格同一视觉行的 y 容差（同一行的文本块常有 0.1pt 抖动）
  var HEADER_PAD = 5;    // 表头行以上（y 更大）一律不算课程内容
  var COL_SEARCH = 45;   // 列左边界搜索范围：星期标签左侧多少 pt 内找文本起始 x
  var COL_MIN_HITS = 3;  // 列左边界至少出现几次，避免把折行碎片当成列起点
  var META_ANY_RE = /\((\d+)-(\d+)节\)\s*(\d+)-(\d+)周(?:[\(（]([单双])[\)）])?/g;
  var CREDIT_RE = /学分\s*[:：]\s*\d+(?:\.\d+)?/g;

  function fatal(msg) {
    return { fatal: msg, entries: [], errors: [], warnings: [] };
  }

  function txt(it) { return String(it.str).trim(); }
  function xOf(it) { return it.transform[4]; }
  function yOf(it) { return it.transform[5]; }

  /* ---- 1. 星期行的 y 中心（标签通常只在第 1 页） ---- */
  function dayBands(pages) {
    var bands = [];
    pages.forEach(function (items) {
      items.forEach(function (it) {
        var m = /^星期([一二三四五六日天])$/.exec(txt(it));
        if (!m) return;
        var day = DAY_CHARS[m[1]];
        for (var i = 0; i < bands.length; i++) {
          if (bands[i].day === day && Math.abs(bands[i].y - yOf(it)) < DAY_TOL) return;
        }
        bands.push({ day: day, y: yOf(it) });
      });
    });
    return bands;
  }

  // y 落在哪一条星期带上；都不沾返回 null（标题、学号、页脚等）
  function bandOf(bands, y) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < bands.length; i++) {
      var d = Math.abs(bands[i].y - y);
      if (d < bestD) { bestD = d; best = bands[i]; }
    }
    return bestD <= DAY_TOL ? best : null;
  }

  /* ---- 2. 节次表：数字标签 + 其右侧的两个时间 ---- */
  function slotTable(pages) {
    var slots = {};
    pages.forEach(function (items, pi) {
      var page = pi + 1;
      var nums = items.filter(function (it) { return /^\d{1,2}$/.test(txt(it)); });
      var times = items.filter(function (it) { return /^\d{2}:\d{2}$/.test(txt(it)); });
      nums.forEach(function (n) {
        var nx = xOf(n);
        var find = function (dx) {
          var hit = null;
          times.forEach(function (t) {
            if (Math.abs(xOf(t) - (nx + dx)) < 6) hit = t;
          });
          return hit;
        };
        var t1 = find(12), t2 = find(24);
        if (!t1 || !t2) return;
        slots[+txt(n)] = { x: nx, page: page, start: txt(t1), end: txt(t2) };
      });
    });
    return slots;
  }

  /* ---- 3. 视觉行：空文本块是行结束标记；块间 x 跨度小则同行 ---- */
  /* getTextContent 按内容流顺序返回，这里的扫描顺序就是绘制顺序，
     所以「空 item = 上一个格子写完了」这个信号是可靠的 —— 同一 y 上并排的多个格子
     靠它分开（不能只按 y 聚类，否则左右相邻的两个格子会并成一行）。 */
  function visualLines(pages, bands, slots) {
    var stripLeft = {};    // page -> 该页条带左边界（最小节次标签 x）
    Object.keys(slots).forEach(function (k) {
      var s = slots[k];
      if (stripLeft[s.page] === undefined || s.x < stripLeft[s.page]) stripLeft[s.page] = s.x;
    });

    var lines = [];
    pages.forEach(function (items, pi) {
      var page = pi + 1;
      var cur = null, prevX = 0;
      items.forEach(function (it) {
        var s = txt(it);
        if (!s) { cur = null; prevX = 0; return; }                       // 格子结束
        if (/^\d{1,2}$/.test(s) || /^\d{2}:\d{2}$/.test(s)) { cur = null; return; }  // 节次表头
        if (/^星期[一二三四五六日天]$/.test(s)) { cur = null; return; }   // 星期标签
        var band = bandOf(bands, yOf(it));
        if (!band) { cur = null; return; }                               // 表外的标题/学号/页脚
        if (!cur || Math.abs(xOf(it) - prevX) > RUN_GAP) {
          cur = { page: page, day: band.day, x: xOf(it), y: yOf(it), text: s };
          lines.push(cur);
        } else {
          cur.text += s;
        }
        prevX = xOf(it);
      });
    });
    lines.forEach(function (l) { l.left = stripLeft[l.page]; });
    return lines;
  }

  /* ---- 3b. 横向表格：星期一~日排在同一个表头行，节次从上往下 ---- */

  // 找横向表头：同一页上 >=4 个星期标签、y 基本一致、x 分散。找不到返回 null
  function horizontalLabels(pages) {
    var best = null;
    pages.forEach(function (items) {
      var labels = [], seen = {};
      items.forEach(function (it) {
        var m = /^星期([一二三四五六日天])$/.exec(txt(it));
        if (!m) return;
        var day = DAY_CHARS[m[1]];
        if (seen[day]) return;
        seen[day] = 1;
        labels.push({ day: day, x: xOf(it), y: yOf(it) });
      });
      if (labels.length < 4) return;
      var minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      labels.forEach(function (l) {
        if (l.y < minY) minY = l.y;
        if (l.y > maxY) maxY = l.y;
        if (l.x < minX) minX = l.x;
        if (l.x > maxX) maxX = l.x;
      });
      if (maxY - minY > 4 || maxX - minX < 40) return;
      labels.sort(function (a, b) { return a.x - b.x; });
      if (!best || labels.length > best.length) best = labels;
    });
    return best;
  }

  // 该页表头行（星期标签）的 y；续页没有表头则返回 null
  function pageHeaderY(items) {
    var y = null;
    items.forEach(function (it) {
      if (!/^星期[一二三四五六日天]$/.test(txt(it))) return;
      if (y === null || yOf(it) > y) y = yOf(it);
    });
    return y;
  }

  // 横向表格的节次表：数字标签 + 同一行右侧的「HH:MM-HH:MM」
  // 有的教务导出把「节次」列删成只剩时间段（没有 1/2/3 数字），
  // 这时按页码 + 从上到下把时间段依次当成第 1..N 节。
  function horizontalSlotTable(pages) {
    var slots = {}, loose = [];
    pages.forEach(function (items, pi) {
      items.forEach(function (it) {
        var m = /^(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})$/.exec(txt(it));
        if (!m) return;
        var y = yOf(it);
        loose.push({ start: m[1], end: m[2], page: pi + 1, y: y });
        var nums = items.filter(function (n) {
          return /^\d{1,2}$/.test(txt(n)) && Math.abs(yOf(n) - y) <= 2 && xOf(n) < xOf(it);
        });
        if (!nums.length) return;
        nums.sort(function (a, b) { return xOf(b) - xOf(a); });
        var num = +txt(nums[0]);
        if (num >= 1 && num <= 30) slots[num] = { start: m[1], end: m[2], page: pi + 1 };
      });
    });
    if (Object.keys(slots).length) return slots;

    loose.sort(function (a, b) { return a.page - b.page || b.y - a.y; });
    loose.forEach(function (s, i) {
      slots[i + 1] = { start: s.start, end: s.end, page: s.page };
    });
    return slots;
  }

  /* 列左边界：课程文字每个视觉行都从列左边界开始，所以该 x 的出现次数会明显高于
     折行碎片。周末没课时找不到峰值，用其他列的中位缩进补。 */
  function columnLefts(content, labels) {
    var hist = {};
    content.forEach(function (it) {
      var k = it.x.toFixed(1);
      hist[k] = (hist[k] || 0) + 1;
    });
    var peaks = labels.map(function (l) {
      var best = null, bestN = COL_MIN_HITS;
      Object.keys(hist).map(parseFloat).sort(function (a, b) { return a - b; }).forEach(function (x) {
        if (x < l.x - COL_SEARCH || x > l.x - 2) return;
        if (hist[x.toFixed(1)] < bestN) return;
        if (best === null || hist[x.toFixed(1)] > bestN) {
          best = x;
          bestN = hist[x.toFixed(1)];
        }
      });
      return best;
    });
    var pads = [];
    peaks.forEach(function (p, i) { if (p !== null) pads.push(labels[i].x - p); });
    pads.sort(function (a, b) { return a - b; });
    var pad = pads.length ? pads[Math.floor(pads.length / 2)] : 22;
    var lefts = peaks.map(function (p, i) { return p === null ? labels[i].x - pad : p; });
    for (var i = 1; i < lefts.length; i++) {
      if (lefts[i] <= lefts[i - 1]) lefts[i] = labels[i].x - pad;
    }
    return lefts;
  }

  /* 把页面上的文本块按列、按视觉行还原：
     先按列左边界分列，再在每列内按 page + y 聚行，行内按 x 拼接。 */
  function horizontalLines(pages, labels) {
    var content = [];
    pages.forEach(function (items, pi) {
      var hy = pageHeaderY(items);
      items.forEach(function (it) {
        var s = txt(it);
        if (!s) return;
        if (/^星期[一二三四五六日天]$/.test(s)) return;
        if (hy !== null && yOf(it) > hy - HEADER_PAD) return;   // 表头、课表标题、学号
        content.push({ page: pi + 1, x: xOf(it), y: yOf(it), s: s });
      });
    });

    var lefts = columnLefts(content, labels);
    var cols = labels.map(function () { return []; });
    content.forEach(function (it) {
      for (var i = 0; i < lefts.length; i++) {
        if (it.x >= lefts[i] - 3 && (i === lefts.length - 1 || it.x < lefts[i + 1] - 3)) {
          cols[i].push(it);
          return;
        }
      }
    });

    return cols.map(function (items, ci) {
      var groups = [];
      items.forEach(function (it) {
        var g = null;
        for (var i = 0; i < groups.length; i++) {
          if (groups[i].page === it.page && Math.abs(groups[i].y - it.y) <= LINE_TOL) {
            g = groups[i];
            break;
          }
        }
        if (!g) { g = { page: it.page, y: it.y, items: [] }; groups.push(g); }
        g.items.push(it);
      });
      groups.sort(function (a, b) { return a.page - b.page || b.y - a.y; });
      var text = groups.map(function (g) {
        g.items.sort(function (a, b) { return a.x - b.x; });
        return g.items.map(function (i) { return i.s; }).join('');
      }).join('');
      return { day: labels[ci].day, text: text };
    });
  }

  // 缺「学分」结尾时，标题前可能还粘着上一门课的元数据；从最后一个字段标签后切
  function cleanTitle(s) {
    var re = /(?:校区|场地|教师|教学班组成|教学班|考核|理论|实践|周学时|总学时|学时)\s*[:：]/g;
    var m, last = null;
    while ((m = re.exec(s)) !== null) last = m;
    if (last) s = s.slice(last.index + last[0].length);
    return s.replace(/^星期[一二三四五六日天]/, '').trim();
  }

  /* 横向表格的格子以「学分:X」收尾，因此上一门课最后一个学分之后、本门课
     (N-M节) 之前的文字就是标题。周次标记可能被折行拆开，拼接后再匹配。 */
  function horizontalEntries(cols) {
    var raw = [];
    cols.forEach(function (col) {
      var text = col.text;
      var markers = [];
      var m;
      META_ANY_RE.lastIndex = 0;
      while ((m = META_ANY_RE.exec(text)) !== null) {
        markers.push({ index: m.index });
      }
      markers.forEach(function (mk, i) {
        var start = 0, cm;
        CREDIT_RE.lastIndex = 0;
        while ((cm = CREDIT_RE.exec(text)) !== null) {
          if (cm.index >= mk.index) break;
          start = cm.index + cm[0].length;
        }
        var end = text.length;
        CREDIT_RE.lastIndex = mk.index;
        if ((cm = CREDIT_RE.exec(text)) !== null) end = cm.index + cm[0].length;
        if (markers[i + 1] && markers[i + 1].index < end) end = markers[i + 1].index;
        var title = cleanTitle(text.slice(start, mk.index));
        if (!title) return;
        raw.push({ title: title, meta: text.slice(mk.index, end), day: col.day });
      });
    });
    return raw;
  }

  /* ---- 4. 切分课程条目 ---- */
  // 元数据行的特征：以分隔符开头，或直接就是「(N-M节)」开头的周次行
  function isMetaStart(s) {
    return /^[\/:(（]/.test(s) || /^\(\d+-\d+节\)/.test(s);
  }

  function cutEntries(lines, bands) {
    var entries = [];
    bands.forEach(function (band) {
      var ls = lines.filter(function (l) { return l.day === band.day; })
        .sort(function (a, b) { return a.page - b.page || a.x - b.x; });
      var cur = null;
      ls.forEach(function (l) {
        var inStrip = l.left === undefined || l.x >= l.left - STRIP_PAD;
        var meta = isMetaStart(l.text);
        if (meta) {
          if (cur) cur.meta += l.text;
          else { cur = { title: '', meta: l.text, day: band.day }; entries.push(cur); }
          return;
        }
        // 标题行：条带内必然是新课（左右并排的格子）；条带左侧的跨页续接区
        // 里出现标题行，说明同一格子有第二门课（如单周/双周各一门）
        if (inStrip || !cur || cur.meta) {
          cur = { title: l.text, meta: '', day: band.day };
          entries.push(cur);
        } else {
          cur.title += l.text;          // 折行的课程名，接回上一行
        }
      });
    });
    return entries;
  }

  /* ---- 5. 解析周次/节次，组装 title ---- */
  var META_RE = /^\((\d+)-(\d+)节\)\s*(\d+)-(\d+)周(?:[\(（]([单双])[\)）])?/;

  function parseMeta(meta) {
    var m = META_RE.exec(meta);
    if (!m) return null;
    var weeks = [];
    for (var w = +m[3]; w <= +m[4]; w++) {
      if (m[5] === '单' && w % 2 === 0) continue;
      if (m[5] === '双' && w % 2 === 1) continue;
      weeks.push(w);
    }
    return { s1: +m[1], s2: +m[2], weeks: weeks };
  }

  // 场地：H4-413（江） -> H4-413，尾部括号里的校区简写去掉
  function roomOf(meta) {
    var m = /场地\s*[:：]\s*([^\/]*)/.exec(meta);
    if (!m) return '';
    return m[1].trim().replace(/[\(（][^)）]*[\)）]\s*$/, '').trim();
  }

  function buildEntries(rawEntries, slots) {
    var out = [];
    var errors = [];
    rawEntries.forEach(function (e) {
      if (!e.title || !e.meta) return;             // 表外噪声（课表标题、学号、打印时间）
      var pm = parseMeta(e.meta);
      if (!pm) {
        errors.push({ message: '课程「' + e.title + '」的周次信息无法识别，已跳过' });
        return;
      }
      var s1 = slots[pm.s1], s2 = slots[pm.s2];
      if (!s1 || !s2) {
        errors.push({ message: '课程「' + e.title + '」的节次 ' + pm.s1 + '-' + pm.s2 + ' 不在课表节次表内，已跳过' });
        return;
      }
      if (!pm.weeks.length) return;
      var room = roomOf(e.meta);
      var title = e.title + (room ? ' ' + room : '');
      if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX);
      out.push({
        title: title, weekday: e.day,
        startTime: s1.start, endTime: s2.end, weeks: pm.weeks
      });
    });
    return { entries: out, errors: errors };
  }

  /* ---- 6. 学期第 1 周周一：优先用记住的值，其次「打印时间」，再看学年学期表头 ---- */
  var TERM_KEY = 'desktop-pet.termMonday';

  function printedDate(pages) {
    var found = null;
    pages.forEach(function (items) {
      items.forEach(function (it) {
        var m = /打印时间\s*[:：]\s*(\d{4})-(\d{2})-(\d{2})/.exec(txt(it));
        if (m) found = new Date(+m[1], +m[2] - 1, +m[3]);
      });
    });
    return found;
  }

  // 打印日期所在周的周一往前推两周 —— 多数学校在第 3 周前后导出课表
  function mondayOf(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var back = (x.getDay() + 6) % 7;             // 周一 = 0
    x.setDate(x.getDate() - back);
    return x;
  }

  function rememberedTerm() {
    try {
      var s = localStorage.getItem(TERM_KEY);
      return s && App.util.parseDateStr(s) ? s : null;
    } catch (e) { return null; }
  }

  function rememberTerm(s) {
    try { localStorage.setItem(TERM_KEY, s); } catch (e) { /* 隐私模式等，忽略 */ }
  }

  // 新式课表没有「打印时间」，从「2026-2027 学年第 1 学期」估算：
  // 第 1 学期按 9 月 1 日、第 2 学期按次年 3 月 1 日所在周的周一。
  function termFromHeader(pages) {
    var all = '';
    pages.forEach(function (items) {
      items.forEach(function (it) { all += txt(it); });
    });
    var m = /(\d{4})\s*[-–—]\s*(\d{4})\s*学年\s*第\s*([12])\s*学期/.exec(all);
    if (!m) return null;
    var base = +m[3] === 1 ? new Date(+m[1], 8, 1) : new Date(+m[2], 2, 1);
    return mondayOf(base);
  }

  function guessTermMonday(pages, nowMs) {
    var saved = rememberedTerm();
    if (saved) return { date: saved, source: 'saved' };
    var printed = printedDate(pages);
    if (printed) {
      // 打印日期所在周的周一往前推两周 —— 多数学校在第 3 周前后导出课表
      var mon = mondayOf(printed);
      mon.setDate(mon.getDate() - 14);
      return { date: App.util.dateStr(mon), source: 'guess' };
    }
    var fromHeader = termFromHeader(pages);
    if (fromHeader) return { date: App.util.dateStr(fromHeader), source: 'guess' };
    var fallback = mondayOf(new Date(nowMs || App.Clock.now()));
    fallback.setDate(fallback.getDate() - 14);
    return { date: App.util.dateStr(fallback), source: 'guess' };
  }

  /* ---- 7. 展开成五列 CSV，交给 parser ---- */
  function expand(entries, termMondayStr, nowMs) {
    var monday = App.util.parseDateStr(termMondayStr);
    if (!monday) return fatal('学期起始日期格式不正确，应为 YYYY-MM-DD');

    var today = App.util.dateStr(new Date(nowMs || App.Clock.now()));
    var rows = [];
    var warnings = [];
    var skipped = 0;

    entries.forEach(function (e) {
      // 第 1 周周一 + (周次-1)*7 + 星期偏移（周一=0 … 周日=6）
      var offset = (e.weekday + 6) % 7;
      e.weeks.forEach(function (w) {
        var d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
        d.setDate(d.getDate() + (w - 1) * 7 + offset);
        var ds = App.util.dateStr(d);
        if (ds < today) { skipped++; return; }
        rows.push({
          date: ds, startTime: e.startTime, endTime: e.endTime,
          endOffset: 0, title: e.title, category: 'studying',
          dateRule: null, ruleId: null
        });
      });
    });

    if (skipped) warnings.push({ message: '已跳过 ' + skipped + ' 次已经过去的课' });
    if (!rows.length) {
      return {
        fatal: '课表里的课程都已经过去了（按学期第 1 周周一 = ' + termMondayStr +
          ' 计算）。如果这个日期不对，请回复正确的第 1 周周一日期。',
        rows: [], errors: [], warnings: warnings
      };
    }
    return { fatal: null, rows: rows, errors: [], warnings: warnings };
  }

  App.TimetableImporter = {
    /* pages -> { fatal, entries, errors, warnings, termMonday, termSource }
       。识别不出来时 fatal 非空，调用方据此回退到「不是课表」的提示 */
    parse: function (pages, nowMs) {
      var built;
      var labels = horizontalLabels(pages);
      if (labels) {
        built = buildEntries(horizontalEntries(horizontalLines(pages, labels)),
          horizontalSlotTable(pages));
      } else {
        var bands = dayBands(pages);
        var slots = slotTable(pages);
        var lines = visualLines(pages, bands, slots);
        built = buildEntries(cutEntries(lines, bands), slots);
        if (bands.length < 4) return fatal('未识别出星期×节次的课表网格');
      }
      if (!built.entries.length) {
        return fatal('看起来是课表，但没解析出任何课程' +
          (built.errors.length ? '：' + built.errors[0].message : ''));
      }
      var term = guessTermMonday(pages, nowMs);
      return {
        fatal: null, entries: built.entries, errors: built.errors, warnings: [],
        termMonday: term.date, termSource: term.source
      };
    },

    expand: expand,
    rememberTerm: rememberTerm,
    // 测试用导出
    _internals: {
      dayBands: dayBands, slotTable: slotTable, visualLines: visualLines,
      cutEntries: cutEntries, horizontalLabels: horizontalLabels,
      horizontalSlotTable: horizontalSlotTable, horizontalLines: horizontalLines,
      horizontalEntries: horizontalEntries, parseMeta: parseMeta, roomOf: roomOf,
      guessTermMonday: guessTermMonday, termFromHeader: termFromHeader, mondayOf: mondayOf
    }
  };
})();
