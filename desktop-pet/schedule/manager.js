/*
 * schedule/manager.js — 日程唯一数据源：增删改查、周期物化、状态补标、重叠检测
 * 所有变更都经此模块并自动持久化，同时发出 schedule:changed 事件。
 */
(function () {
  'use strict';
  var App = window.App;
  var util = App.util;

  var Manager = {
    tasks: null,
    meta: null,

    init: function () {
      var data = App.Storage.load();
      this.tasks = data.tasks;
      this.meta = data.meta;
      this.materializeRules();
      this.catchup(App.Clock.now());
      this.persist();
    },

    persist: function () {
      App.Storage.save(this.tasks, this.meta);
    },

    changed: function () {
      this.persist();
      App.bus.emit('schedule:changed', {});
    },

    all: function () { return this.tasks; },

    get: function (id) {
      for (var i = 0; i < this.tasks.length; i++)
        if (this.tasks[i].id === id) return this.tasks[i];
      return null;
    },

    tasksOfDate: function (dateStr) {
      return this.tasks.filter(function (t) { return t.date === dateStr; });
    },

    byDateSorted: function (dateStr) {
      return this.tasksOfDate(dateStr).sort(function (a, b) {
        return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
      });
    },

    remainingToday: function () {
      var now = App.Clock.now();
      return this.tasksOfDate(App.Clock.today()).filter(function (t) {
        return util.taskEndMs(t) > now;
      });
    },

    /* 此刻正在进行的任务；重叠时确定性选主：开始最早 -> 创建最早 */
    activeAt: function (nowMs) {
      var actives = this.tasks.filter(function (t) {
        return util.taskStartMs(t) <= nowMs && nowMs < util.taskEndMs(t);
      });
      if (!actives.length) return null;
      actives.sort(function (a, b) {
        var sa = util.taskStartMs(a), sb = util.taskStartMs(b);
        if (sa !== sb) return sa - sb;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      return actives[0];
    },

    /* 同日内的重叠任务（端点相接不算重叠）；只看待完成的 */
    overlaps: function (dateStr, startMin, endMin, ignoreId) {
      return this.tasksOfDate(dateStr).filter(function (t) {
        if (t.id === ignoreId || t.status === 'done') return false;
        var s = util.hmToMin(t.startTime);
        var e = util.hmToMin(t.endTime) + (t.endOffset || 0) * 1440;
        return startMin < e && s < endMin;
      });
    },

    /* 删/改时的候选定位：日期内按标题片段或开始时间匹配 */
    findCandidates: function (q) {
      var pool = q.date ? this.tasksOfDate(q.date) : this.tasks.slice();
      return pool.filter(function (t) {
        var hitTitle = !q.titleFrag ||
          t.title.indexOf(q.titleFrag) >= 0 || q.titleFrag.indexOf(t.title) >= 0;
        var hitTime = !q.startTime || t.startTime === q.startTime;
        return hitTitle && hitTime;
      }).sort(function (a, b) {
        return (a.date + a.startTime) < (b.date + b.startTime) ? -1 : 1;
      });
    },

    /* ---- 新增：partial {date,startTime,endTime?,title,category?} ---- */
    add: function (partial) {
      var startMin = util.hmToMin(partial.startTime);
      var endTime = partial.endTime;
      var endOffset = partial.endOffset || 0;
      if (endTime) {
        var endMin = util.hmToMin(endTime);
        // 对话新增时若结束钟点小于开始钟点，自动视为跨天
        if (!endOffset && endMin <= startMin) endOffset = 1;
      } else {
        endTime = util.minToHm(startMin + App.Config.defaultDurationMin);
      }

      var now = App.Clock.now();
      var task = {
        id: util.uid(),
        date: partial.date,
        startTime: util.minToHm(startMin),
        endTime: endTime,
        endOffset: endOffset,
        title: String(partial.title).trim(),
        category: partial.category || util.guessCategory(partial.title),
        status: 'pending',
        dateRule: partial.dateRule || null,
        ruleId: partial.ruleId || null,
        createdAt: now,
        updatedAt: now
      };
      if (util.taskEndMs(task) <= now) task.status = 'done';

      this.tasks.push(task);
      this.resetSummary(task.date);
      this.changed();
      return { task: task, warning: task.status === 'done' ? 'past' : null };
    },

    /* ---- 修改：patches {date?, startTime?}；改开始时间则保持原时长平移 ---- */
    update: function (id, patches) {
      var t = this.get(id);
      if (!t) return null;
      var oldDate = t.date;

      if (patches.date && util.parseDateStr(patches.date)) {
        t.date = patches.date;
      }
      if (patches.startTime) {
        var newStart = util.hmToMin(patches.startTime);
        var oldStart = util.hmToMin(t.startTime);
        var oldEnd = util.hmToMin(t.endTime) + (t.endOffset || 0) * 1440;
        var duration = Math.max(15, oldEnd - oldStart);
        var newEnd = newStart + duration;
        t.startTime = util.minToHm(newStart);
        t.endTime = util.minToHm(newEnd);
        t.endOffset = newEnd >= 1440 ? 1 : 0;
      }
      if (patches.title) t.title = String(patches.title).trim();
      if (patches.category) t.category = patches.category;

      t.updatedAt = App.Clock.now();
      t.status = util.taskEndMs(t) <= t.updatedAt ? 'done' : 'pending';

      this.resetSummary(oldDate);
      this.resetSummary(t.date);
      this.changed();
      return t;
    },

    remove: function (id) {
      var idx = -1;
      for (var i = 0; i < this.tasks.length; i++)
        if (this.tasks[i].id === id) { idx = i; break; }
      if (idx < 0) return null;
      var t = this.tasks[idx];

      if (t.ruleId) {
        var key = t.ruleId + '@' + t.date;
        if (this.meta.suppressed.indexOf(key) < 0) this.meta.suppressed.push(key);
      }
      this.tasks.splice(idx, 1);
      this.resetSummary(t.date);
      this.changed();
      return t;
    },

    markDone: function (id, opts) {
      var t = this.get(id);
      if (!t || t.status === 'done') return t;
      t.status = 'done';
      t.updatedAt = App.Clock.now();
      if (opts && opts.silent) {
        this.persist();
      } else {
        this.changed();
      }
      return t;
    },

    /* ---- 周期规则物化：把保留的规则续展到未来窗口，ruleId@date 去重 ---- */
    materializeRules: function () {
      var now = App.Clock.nowDate();
      var todayStr = util.dateStr(now);
      var horizon = util.addDaysStr(todayStr, App.Config.materializeDays);

      var rules = Object.create(null);
      this.tasks.forEach(function (t) {
        if (t.ruleId && !rules[t.ruleId]) {
          rules[t.ruleId] = t;
        }
      });

      var changed = false;
      Object.keys(rules).forEach(function (ruleId) {
        var sample = rules[ruleId];
        for (var d = 0; d <= App.Config.materializeDays; d++) {
          var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          date.setDate(date.getDate() + d);
          var ds = util.dateStr(date);
          var key = ruleId + '@' + ds;
          var exists = this.tasks.some(function (t) {
            return t.ruleId === ruleId && t.date === ds;
          });
          if (exists || this.meta.suppressed.indexOf(key) >= 0) continue;

          // 规则匹配判断（与 Parser 保持同一套语义）
          var wd = date.getDay();
          var r = sample.dateRule;
          var map = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0, '周天': 0 };
          var ok = r === '每天' ? true :
            r === '工作日' ? (wd >= 1 && wd <= 5) :
            r === '周末' ? (wd === 0 || wd === 6) :
            wd === map[r];
          if (!ok) continue;

          this.tasks.push({
            id: util.uid(),
            date: ds,
            startTime: sample.startTime,
            endTime: sample.endTime,
            endOffset: sample.endOffset || 0,
            title: sample.title,
            category: sample.category,
            status: 'pending',
            dateRule: sample.dateRule,
            ruleId: ruleId,
            createdAt: App.Clock.now(),
            updatedAt: App.Clock.now()
          });
          changed = true;
        }
      }, this);

      return changed;
    },

    /* 静默补标：所有结束时刻已过的 pending 任务置 done */
    catchup: function (nowMs) {
      var changed = false;
      this.tasks.forEach(function (t) {
        if (t.status === 'pending' && util.taskEndMs(t) <= nowMs) {
          t.status = 'done';
          changed = true;
        }
      });
      return changed;
    },

    /* ---- CSV 行入库：mode = merge（跳过重复）| replace ---- */
    mergeFromRows: function (rows, mode) {
      if (mode === 'replace') {
        this.tasks = [];
        this.meta.suppressed = [];
      }
      var added = 0, skipped = 0;
      var existing = {};
      this.tasks.forEach(function (t) { existing[this.dedupKey(t)] = true; }, this);

      var now = App.Clock.now();
      rows.forEach(function (r) {
        var key = this.dedupKey(r);
        if (existing[key] || this.meta.suppressed.indexOf(r.ruleId + '@' + r.date) >= 0) {
          skipped++;
          return;
        }
        existing[key] = true;
        var task = {
          id: util.uid(),
          date: r.date,
          startTime: r.startTime,
          endTime: r.endTime,
          endOffset: r.endOffset || 0,
          title: r.title,
          category: r.category,
          status: util.dayStartMs(r.date) +
            (util.hmToMin(r.endTime) + (r.endOffset || 0) * 1440) * 60000 <= now ? 'done' : 'pending',
          dateRule: r.dateRule || null,
          ruleId: r.ruleId || null,
          createdAt: now,
          updatedAt: now
        };
        this.tasks.push(task);
        added++;
      }, this);

      this.changed();
      return { added: added, skipped: skipped };
    },

    dedupKey: function (t) {
      return t.ruleId
        ? t.ruleId + '@' + t.date
        : 'h@' + util.hash([t.date, t.startTime, t.title].join('|'));
    },

    /* ---- 整日复制：把 copies（源日任务）复制一份到 dstDate ----
       mode = 'keep' ：冲突的旧任务原地不动，副本原样加进去
       mode = 'merge'：冲突的旧任务并进新任务 —— 标题逗号串起来，
                       时间段取并集（先开始的头 ~ 最后结束的尾）
       pairs = [{from: 源日任务, to: 目标日已有任务}]，只在检测到时间冲突时才有
       批量 push 后单次 changed()，不走逐条 add/remove（否则 N 次重渲染） */
    copyDay: function (copies, dstDate, mode, pairs) {
      var self = this;
      var now = App.Clock.now();
      var oldsByOwner = {};    // 源任务 id -> 被它并掉的旧任务
      var absorbedOld = {};    // 旧任务 id -> true（有归属、待删）
      var removedIds = {};     // 真的从 tasks 里删掉的旧任务 id

      // 排序键：开始早 -> 结束早 -> 创建早 -> id。用于「旧任务并进哪条新任务」的唯一裁决
      function copyOrder(a, b) {
        if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
        if (a.endTime !== b.endTime) return a.endTime < b.endTime ? -1 : 1;
        var ca = a.createdAt || 0, cb = b.createdAt || 0;
        if (ca !== cb) return ca - cb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }

      function mkCopy(src, title, startTime, endTime, endOffset) {
        var task = {
          id: util.uid(),
          date: dstDate,
          startTime: startTime,
          endTime: endTime,
          endOffset: endOffset,
          title: title,
          category: src.category,
          status: 'pending',
          // 切断周期规则：留着 ruleId 会被 materializeRules 的 ruleId@date 去重跳过，
          // 也可能反过来在目标日重复展开。复制出来的是独立的一次安排
          dateRule: null,
          ruleId: null,
          createdAt: now,
          updatedAt: now
        };
        if (util.taskEndMs(task) <= now) task.status = 'done';
        return task;
      }

      if (mode === 'merge' && pairs && pairs.length) {
        // 1. 聚合：先按「旧任务」归拢撞上它的新任务，再给每条旧任务定唯一归属
        var hits = {};
        pairs.forEach(function (p) {
          if (!p || !p.to || !p.from) return;
          var rec = hits[p.to.id];
          if (!rec) rec = hits[p.to.id] = { old: p.to, froms: [] };
          for (var i = 0; i < rec.froms.length; i++) {
            if (rec.froms[i].id === p.from.id) return;   // 同一对可能被跨天两段各命中一次
          }
          rec.froms.push(p.from);
        });
        Object.keys(hits).forEach(function (oldId) {
          var owner = hits[oldId].froms.slice().sort(copyOrder)[0];
          (oldsByOwner[owner.id] || (oldsByOwner[owner.id] = [])).push(hits[oldId].old);
          absorbedOld[oldId] = true;
        });
      }

      // 2. 删除被合并的旧任务（沿用 remove() 的 suppressed 语义，别让周期规则把它复活）
      var touched = {};
      touched[dstDate] = true;
      var removed = 0;
      var kept = [];
      this.tasks.forEach(function (t) {
        if (!absorbedOld[t.id]) {
          kept.push(t);
          return;
        }
        if (t.ruleId) {
          var key = t.ruleId + '@' + t.date;
          if (self.meta.suppressed.indexOf(key) < 0) self.meta.suppressed.push(key);
        }
        removedIds[t.id] = true;
        touched[t.date] = true;
        removed++;
      });
      this.tasks = kept;

      // 3. 加副本
      var added = 0, past = 0;
      copies.forEach(function (src) {
        // 只并「确实被删掉」的旧任务：万一中途已被别处删了，不能把它的名字留成幽灵标题
        var olds = (oldsByOwner[src.id] || []).filter(function (o) { return removedIds[o.id]; });
        var task;
        if (olds.length) {
          var titles = [src.title];
          var sMin = util.hmToMin(src.startTime);
          var eMin = util.hmToMin(src.endTime) + (src.endOffset || 0) * 1440;
          olds.forEach(function (o) {
            titles.push(o.title);
            sMin = Math.min(sMin, util.hmToMin(o.startTime));
            eMin = Math.max(eMin, util.hmToMin(o.endTime) + (o.endOffset || 0) * 1440);
          });
          var endOffset = eMin >= 1440 ? 1 : 0;
          if (endOffset) eMin -= 1440;
          task = mkCopy(src, titles.join(','), util.minToHm(sMin), util.minToHm(eMin), endOffset);
        } else {
          task = mkCopy(src, src.title, src.startTime, src.endTime, src.endOffset || 0);
        }
        self.tasks.push(task);
        if (task.status === 'done') past++;
        added++;
      });

      Object.keys(touched).forEach(function (d) { self.resetSummary(d); });
      this.changed();
      return { added: added, removed: removed, past: past };
    },

    /* ---- 当日总结标记（去重） ---- */
    isSummaryDone: function (d) { return !!this.meta.summaryDates[d]; },
    setSummaryDone: function (d) { this.meta.summaryDates[d] = App.Clock.now(); this.persist(); },
    resetSummary: function (d) {
      if (this.meta.summaryDates[d]) {
        delete this.meta.summaryDates[d];
      }
    },

    serialize: function () {
      return { version: App.Config.schemaVersion, tasks: this.tasks, meta: this.meta };
    }
  };

  App.Manager = Manager;
})();
