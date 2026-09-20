/*
 * schedule/pdfImporter.js — PDF 安排表导入（PDF → 重建 CSV → 复用 parser）
 * 用 pdf.js 提取文字层，按坐标把文本项还原成 date/start/end/title/category
 * 五列表格，重建 CSV 后交给 App.Parser.parseCSV 解析：字段校验、周期规则展开、
 * 逐行错误报告全部复用现有逻辑，本模块只负责「PDF 表格 → CSV 文本」这一步。
 * 仅支持文字型 PDF（扫描图片型没有文字层，提不出内容）。
 * 输出与 parser 同构：{ fatal, rows, errors, warnings }
 */
(function () {
  'use strict';
  var App = window.App;
  var lib = window.pdfjsLib;

  var HEADER = 'date,start,end,title,category';
  var HEADER_KEY = HEADER.replace(/,/g, '');
  var Y_TOL = 2.5;      // 同一行的 y 容差（pt）：模板里同一行文本绘制基线一致
  var COL_GAP = 15;     // 表头分列：相邻单元格 x 间距超过此值即算新的一列
  var COL_TOL = 40;     // 文本项归属某列的最大横向距离（pt）
  var MIN_CELLS = 2;    // 数据行至少落在 2 个列上；说明文字行只落在第 1 列

  // worker 在 file:// 下创建会失败，pdf.js 自带回退：改用主线程 fake worker
  // （动态 script 标签加载 worker 脚本），功能不受影响，控制台会有一条警告。
  if (lib) lib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';

  function xOf(it) { return it.transform[4]; }
  function yOf(it) { return it.transform[5]; }
  function wOf(it) { return it.width || 0; }
  function cells5() { return [null, null, null, null, null]; }

  function fatal(msg) {
    return { fatal: msg, rows: [], errors: [], warnings: [] };
  }

  /* 文本项按 y 降序聚成行（PDF 坐标 y 向上递增，视觉从上到下 = y 由大到小），
     行内按 x 升序。getTextContent 返回的是内容流顺序，必须重排才能还原表格 */
  function clusterRows(items) {
    var sorted = items.slice().sort(function (a, b) { return yOf(b) - yOf(a); });
    var rows = [];
    sorted.forEach(function (it) {
      var last = rows[rows.length - 1];
      if (last && Math.abs(last.y - yOf(it)) <= Y_TOL) last.items.push(it);
      else rows.push({ y: yOf(it), items: [it] });
    });
    rows.forEach(function (r) {
      r.items.sort(function (a, b) { return xOf(a) - xOf(b); });
    });
    return rows;
  }

  function isHeaderRow(row) {
    var s = row.items.map(function (it) { return it.str; }).join('')
      .replace(/\s+/g, '').toLowerCase();
    return s === HEADER_KEY;
  }

  // 表头行的各个单元格按 x 间距分组，取每组中心作为列中心；分组数不为 5 则失败
  function headerCenters(row) {
    var groups = [];
    row.items.forEach(function (it) {
      var g = groups[groups.length - 1];
      if (g && xOf(it) - g.right <= COL_GAP) {
        g.items.push(it);
        g.right = xOf(it) + wOf(it);
      } else {
        groups.push({ items: [it], right: xOf(it) + wOf(it) });
      }
    });
    if (groups.length !== 5) return null;
    return groups.map(function (g) { return (xOf(g.items[0]) + g.right) / 2; });
  }

  // 同一单元格内的文本项拼接；相邻项间距过大时补一个空格，避免两个词粘在一起
  function joinItems(items) {
    var s = '';
    items.forEach(function (it, i) {
      if (i) {
        var prev = items[i - 1];
        if (xOf(it) - (xOf(prev) + wOf(prev)) > Math.max(1, wOf(prev) * 0.25)) s += ' ';
      }
      s += it.str;
    });
    return s.replace(/\s+/g, ' ').trim();
  }

  // 文本项按最近的列中心归属（不用固定列区间：超长单元格溢出列宽时更稳）
  function assign(row, centers) {
    var cells = cells5();
    row.items.forEach(function (it) {
      var best = -1, bestD = Infinity;
      for (var i = 0; i < centers.length; i++) {
        var d = Math.abs(centers[i] - xOf(it));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0 && bestD <= COL_TOL) (cells[best] = cells[best] || []).push(it);
    });
    return cells;
  }

  function textOf(cell) { return cell ? joinItems(cell) : ''; }

  function countFilled(cells) {
    var n = 0;
    for (var i = 0; i < cells.length; i++) if (textOf(cells[i])) n++;
    return n;
  }

  // 只有标题列有内容
  function onlyTitle(cells) {
    for (var i = 0; i < cells.length; i++) {
      if (i === 3) continue;
      if (textOf(cells[i])) return false;
    }
    return !!textOf(cells[3]);
  }

  function escapeCell(s) {
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* 行序列 → 重建 CSV → 交给 parser。表头行只用来定列，不进入重建结果
     （重建时硬编码标准表头，保证 parser 的表头校验必过） */
  function rebuild(rows, nowMs) {
    var centers = null;
    var out = [];          // 每项是 5 个单元格文本（未转义）
    var ignored = 0;
    var fatalMsg = '';

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      if (isHeaderRow(row)) {
        var c = headerCenters(row);
        if (c) centers = c;
        else if (!centers) {
          fatalMsg = '表头列识别失败，请使用应用内下载的模板 PDF';
          break;
        }
        continue;
      }

      if (!centers) continue;   // 表头之前的内容（顶部说明区）不作数

      var cells = assign(row, centers);
      var filled = countFilled(cells);
      if (filled === 0) continue;

      // 以 # 开头的整行是说明文字（模板注释区），不是数据行
      var first = textOf(cells[0]);
      if (filled === 1 && first.charAt(0) === '#') { ignored++; continue; }

      if (filled < MIN_CELLS) {
        // 只有标题列有内容：多半是上一行标题换行折下来的续行，接回上一行
        if (onlyTitle(cells) && out.length) {
          out[out.length - 1][3] += textOf(cells[3]);
          continue;
        }
        ignored++;
        continue;
      }

      out.push([textOf(cells[0]), textOf(cells[1]), textOf(cells[2]),
        textOf(cells[3]), textOf(cells[4])]);
    }

    if (fatalMsg) return fatal(fatalMsg);
    if (!centers) {
      return fatal('未找到表头行：需要 date,start,end,title,category 五列表头' +
        '（当前文件可能不是本应用的模板 PDF）');
    }
    if (!out.length) {
      return fatal('PDF 中未找到表格数据（需要 date,start,end,title,category 五列表格）');
    }

    var csv = HEADER + '\n' + out.map(function (cells) {
      return cells.map(escapeCell).join(',');
    }).join('\n');

    var result = App.Parser.parseCSV(csv, nowMs);
    if (ignored) {
      result.warnings.push({ message: '已忽略 ' + ignored + ' 行说明文字' });
    }
    return result;
  }

  App.PdfImporter = {
    /* arrayBuffer -> Promise<{fatal, rows, errors, warnings}>
       两条路径：
       - 五列模板（date/start/end/title/category）→ 重建 CSV 交给 parser，返回 parser 结果
       - 教务系统网格课表 → 交给 App.TimetableImporter，返回 {timetable, termMonday}，
         由调用方问一句学期起始日期后再展开（展开也复用 parser 的校验） */
    import: function (arrayBuffer, nowMs) {
      if (!lib) return Promise.resolve(fatal('PDF 组件未加载（缺少 lib/pdfjs/pdf.min.js）'));

      var task;
      try {
        // 必须传 data：file:// 下 getDocument({url}) 走 fetch 会被浏览器拦掉。
        // CMapReaderFactory：不少中文 PDF 用未内嵌的标准 CJK 字体，字形→Unicode 的映射
        // 放在外部 CMap 里，不提供就提取不到任何文字（详见 lib/pdfjs/cmaps.js）
        var opts = { data: arrayBuffer };
        if (App.PdfCMaps) opts.CMapReaderFactory = App.PdfCMaps.CMapReaderFactory;
        task = lib.getDocument(opts);
      } catch (e) {
        return Promise.resolve(fatal('无法打开 PDF：' + ((e && e.message) || e)));
      }

      return task.promise.then(function (pdf) {
        var jobs = [];
        for (var i = 1; i <= pdf.numPages; i++) {
          jobs.push(pdf.getPage(i).then(function (page) { return page.getTextContent(); }));
        }
        return Promise.all(jobs).then(function (contents) {
          var pages = contents.map(function (tc) { return tc.items; });

          var rows = [];
          pages.forEach(function (items) {
            // pdf.js 会在文本段之间插入「合成空格」项（宽等于整段间隙、高为 0），
            // 会把列与列之间的间距抹平，必须先滤掉；格内间距由 joinItems 负责
            rows = rows.concat(clusterRows(items.filter(function (it) {
              return String(it.str).trim() !== '';
            })));
          });

          var res = rebuild(rows, nowMs);
          // 不像五列表格：试试是不是教务系统的「星期×节次」网格课表
          if (res.fatal && App.TimetableImporter) {
            var tt = App.TimetableImporter.parse(pages, nowMs);
            if (!tt.fatal) {
              res = {
                fatal: null, rows: [], errors: tt.errors, warnings: tt.warnings,
                timetable: tt.entries, termMonday: tt.termMonday, termSource: tt.termSource
              };
            }
          }
          try { pdf.destroy(); } catch (e) { /* 销毁失败不影响解析结果 */ }
          return res;
        });
      }).catch(function (e) {
        if (e && e.name === 'PasswordException') {
          return fatal('PDF 已加密，请先解除密码保护再导入');
        }
        return fatal('PDF 解析失败：' + ((e && e.message) || e));
      });
    }
  };
})();
