/*
 * schedule/parser.js — CSV 日程表解析与校验
 * 周期规则（每天/工作日/周末/周X）在此展开为窗口内的具体日期行。
 * 输出：{ fatal, rows:[...任务草稿], errors:[{line,message}], warnings:[] }
 */
(function () {
  'use strict';
  var App = window.App;
  var util = App.util;

  var HEADER = ['date', 'start', 'end', 'title', 'category'];

  var WEEKDAY = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
    '日': 0, '天': 0
  };

  /* ---- 最小 RFC4180：返回行数组（每行是字段数组），支持引号内逗号/换行 ---- */
  function splitCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
    var rows = [];
    var field = '';
    var row = [];
    var inQuotes = false;

    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (c === '\r') {
        if (text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // date 单元格 -> 具体日期字符串 或 {rule}；非法返回 null
  function parseDateCell(cell) {
    cell = cell.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(cell) && util.parseDateStr(cell)) return { date: cell };
    if (cell === '每天' || cell === '每日') return { rule: '每天' };
    if (cell === '工作日') return { rule: '工作日' };
    if (cell === '周末') return { rule: '周末' };
    var m = /^(?:星期|礼拜|周)([一二三四五六日天])$/.exec(cell);
    if (m) return { rule: '周' + m[1] };
    return null;
  }

  function matchRule(rule, date) {
    var wd = date.getDay();
    if (rule === '每天') return true;
    if (rule === '工作日') return wd >= 1 && wd <= 5;
    if (rule === '周末') return wd === 0 || wd === 6;
    var m = /^周([一二三四五六日天])$/.exec(rule);
    if (m) return wd === WEEKDAY[m[1]];
    return false;
  }

  function normalizeCategory(cell, title) {
    cell = cell.trim().toLowerCase();
    if (cell === 'studying' || cell === '学习') return 'studying';
    if (cell === 'working' || cell === '工作') return 'working';
    if (cell === 'general' || cell === '通用') return 'general';
    return util.guessCategory(title);
  }

  // end 单元格 -> {time:'HH:MM', offset}；空 -> null（交由 manager 补默认）
  function parseEndCell(cell, startMin) {
    cell = cell.trim();
    if (!cell) return null;
    var p = util.parseHM(cell);
    if (!p) return { error: '结束时间格式不正确，应为 HH:MM，跨天写成 HH:MM(+1)' };
    var endMin = p.h * 60 + p.m;
    var offset = p.offset;
    if (!offset && endMin <= startMin) {
      return { error: '结束时间早于（或等于）开始时间，跨天请用 (+1) 标注' };
    }
    return { time: util.minToHm(endMin), offset: offset };
  }

  App.Parser = {
    parseCSV: function (text, nowMs) {
      var now = new Date(nowMs || App.Clock.now());
      var lines = splitCSV(String(text || ''));
      var errors = [];
      var rows = [];
      var seen = Object.create(null);

      // 跳过空行与注释行，定位表头
      var headerIdx = -1;
      for (var i = 0; i < lines.length; i++) {
        var joined = lines[i].join('').trim();
        if (!joined || joined.charAt(0) === '#') continue;
        headerIdx = i;
        break;
      }
      if (headerIdx < 0) {
        return { fatal: '文件内容为空', rows: [], errors: [], warnings: [] };
      }

      var header = lines[headerIdx].map(function (s) { return s.trim().toLowerCase(); });
      if (header.join(',') !== HEADER.join(',')) {
        return {
          fatal: '表头不匹配（当前：' + header.join(',') + '）',
          rows: [], errors: [], warnings: []
        };
      }

      var defaultEnd = App.Config.defaultDurationMin;
      var windowDays = App.Config.materializeDays;
      var todayStr = util.dateStr(now);

      function buildRow(lineNo, dateVal, startMin, endInfo, title, category, rule) {
        var endTime, endOffset = 0;
        if (endInfo) { endTime = endInfo.time; endOffset = endInfo.offset || 0; }
        else { endTime = util.minToHm(startMin + defaultEnd); }

        if (rule) {
          var ruleId = util.hash([rule, util.minToHm(startMin), endTime, endOffset, title, category].join('|'));
          for (var d = 0; d <= windowDays; d++) {
            var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            date.setDate(date.getDate() + d);
            if (!matchRule(rule, date)) continue;
            var ds = util.dateStr(date);
            var key = ruleId + '@' + ds;
            if (seen[key]) continue;
            seen[key] = true;
            rows.push({
              date: ds, startTime: util.minToHm(startMin), endTime: endTime,
              endOffset: endOffset, title: title, category: category,
              dateRule: rule, ruleId: ruleId
            });
          }
        } else {
          var k = 'h@' + util.hash([dateVal, util.minToHm(startMin), title].join('|'));
          if (seen[k]) {
            errors.push({ line: lineNo, message: '重复行，已跳过' });
            return;
          }
          seen[k] = true;
          rows.push({
            date: dateVal, startTime: util.minToHm(startMin), endTime: endTime,
            endOffset: endOffset, title: title, category: category,
            dateRule: null, ruleId: null
          });
        }
      }

      for (var ln = headerIdx + 1; ln < lines.length; ln++) {
        var cells = lines[ln];
        var content = cells.join('').trim();
        if (!content || content.charAt(0) === '#') continue;
        var lineNo = ln + 1;

        if (cells.length < 4) {
          errors.push({ line: lineNo, message: '字段数量不足，应为 5 列' });
          continue;
        }

        var dateCell = parseDateCell(cells[0]);
        if (!dateCell) {
          errors.push({ line: lineNo, message: '日期「' + cells[0].trim() +
            '」无法识别（YYYY-MM-DD 或 每天/工作日/周末/周X）' });
          continue;
        }

        var sp = util.parseHM(cells[1]);
        if (!sp) {
          errors.push({ line: lineNo, message: '开始时间「' + cells[1].trim() + '」格式不正确' });
          continue;
        }
        var startMin = sp.h * 60 + sp.m;

        var endInfo = parseEndCell(cells[2], startMin);
        if (endInfo && endInfo.error) {
          errors.push({ line: lineNo, message: endInfo.error });
          continue;
        }

        var title = cells[3].trim();
        if (!title) {
          errors.push({ line: lineNo, message: '标题必填' });
          continue;
        }
        if (title.length > 40) {
          errors.push({ line: lineNo, message: '标题过长（超过 40 字）' });
          continue;
        }

        var category = normalizeCategory(cells[4] || '', title);

        if (dateCell.rule) {
          buildRow(lineNo, null, startMin, endInfo, title, category, dateCell.rule);
        } else {
          if (dateCell.date < todayStr) {
            errors.push({ line: lineNo, message: '日期 ' + dateCell.date + ' 已过去，已跳过' });
            continue;
          }
          buildRow(lineNo, dateCell.date, startMin, endInfo, title, category, null);
        }
      }

      return { fatal: null, rows: rows, errors: errors, warnings: [] };
    }
  };
})();
