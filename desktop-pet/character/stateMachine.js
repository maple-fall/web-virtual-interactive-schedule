/*
 * character/stateMachine.js — 角色状态机
 *   基础态（持久循环）：idle / studying / working
 *   临时态（短暂覆盖）：alert / done / refuse，单一锁 + 队列，结束后回到基础态
 * 状态不是被事件推出来的，而是由「当前时间 + 日程表」派生出来的：
 * 每秒 tick 比较一次即可，漏拍、切后台、调时钟都能自愈。
 */
(function () {
  'use strict';
  var App = window.App;
  var util = App.util;

  var StateMachine = {
    base: 'idle',
    temp: null,
    queue: [],
    prevActiveId: null,
    firedAlertIds: {},
    firedStartWarnIds: {},   // 开始前提醒：已播报过的任务 id
    firedEndWarnIds: {},     // 结束前打气：已播报过的任务 id
    refuseCount: 0,
    lastDateStr: null,
    _lastRefuseAt: 0,
    _timer: null,

    /* 由 moment 决定此刻应有的基础态 */
    baseFor: function (task) {
      if (!task) return 'idle';
      return App.Config.stateByCategory[task.category] || 'working';
    },

    /* 当前是否有正在进行的任务（拒绝机制的前置条件） */
    isBusy: function () {
      return !!App.Manager.activeAt(App.Clock.now());
    },

    currentTask: function () {
      return App.Manager.activeAt(App.Clock.now());
    },

    /* ---- 初始化：静默追赶，不补任何播报 ---- */
    init: function (now) {
      var self = this;
      this.lastDateStr = App.Clock.today();

      var active = App.Manager.activeAt(now);
      this.prevActiveId = active ? active.id : null;
      this.base = this.baseFor(active);
      App.Animation.play(this.base);
      App.bus.emit('state:change', { to: this.base, task: active });

      // 打开页面时今日任务已全部结束：直接置位总结标记，避免一开页就弹总结
      var todays = App.Manager.tasksOfDate(this.lastDateStr);
      if (todays.length && !active && todays.every(function (t) { return t.status === 'done'; })) {
        App.Manager.setSummaryDone(this.lastDateStr);
      }

      // 日程变动：重算基础态，撤掉指向已失效任务的临时态
      App.bus.on('schedule:changed', function () {
        self.pruneFiredWarnIds();
        self.dropStaleTemp();
        self.recomputeBase();
      });
    },

    destroy: function () {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },

    snapshot: function () {
      return {
        base: this.base, temp: this.temp && this.temp.type,
        queue: this.queue.map(function (q) { return q.type; }),
        active: (this.currentTask() || {}).title || null,
        refuseCount: this.refuseCount, date: this.lastDateStr
      };
    },

    /* ---- 每秒一拍 ---- */
    tick: function (now) {
      var today = util.dateStr(new Date(now));
      if (today !== this.lastDateStr) this.rollover(today);

      var active = App.Manager.activeAt(now);
      var activeId = active ? active.id : null;

      if (activeId !== this.prevActiveId) {
        this.onActiveChanged(this.prevActiveId, active, now);
      }

      this.batchSilentComplete(now);
      this.checkSummary(now);
      this.checkStartWarns(now);
      this.checkEndWarns(now);
      this.prevActiveId = activeId;
    },

    /* ---- 活动任务发生变化 ---- */
    onActiveChanged: function (prevId, nextTask, now) {
      var prev = prevId ? App.Manager.get(prevId) : null;
      var next = nextTask;

      if (prev) {
        var nextIsAdjacent = !!next;   // 背靠背：旧的刚结束新的立刻开始
        if (nextIsAdjacent) {
          // 不播 done，避免与 alert 连发；静默置为已完成
          App.Manager.markDone(prev.id, { silent: true });
        } else {
          App.Manager.markDone(prev.id, { silent: true });
          App.bus.emit('task:end', { task: prev });
          this.enqueueTemp('done', prev.id, App.Config.tempMs.done);
        }
      }

      if (next) {
        var startedAgo = now - util.taskStartMs(next);
        var onTime = startedAgo >= -1000 && startedAgo <= App.Config.startWindowSec * 1000;
        if (onTime && !this.firedAlertIds[next.id]) {
          this.firedAlertIds[next.id] = true;
          App.bus.emit('task:start', { task: next });
          this.enqueueTemp('alert', next.id, App.Config.tempMs.alert);
        } else {
          this.recomputeBase();
        }
      } else if (!prev) {
        this.recomputeBase();
      }
    },

    /* ---- 其它到点任务静默完成（重叠没被选主的也会正确变已完成） ---- */
    batchSilentComplete: function (now) {
      var changed = false;
      App.Manager.all().forEach(function (t) {
        if (t.status === 'pending' && util.taskEndMs(t) <= now) {
          t.status = 'done';
          changed = true;
        }
      });
      if (changed) App.Manager.changed();
    },

    /* ---- 当日总结：只播一次 ---- */
    checkSummary: function (now) {
      var today = util.dateStr(new Date(now));
      if (App.Manager.isSummaryDone(today)) return;

      var todays = App.Manager.tasksOfDate(today);
      if (!todays.length) return;
      if (App.Manager.activeAt(now)) return;

      var allDone = todays.every(function (t) { return t.status === 'done'; });
      if (!allDone) return;

      App.Manager.setSummaryDone(today);
      App.bus.emit('day:summary', { count: todays.length, date: today });
    },

    /* ---- 开始前 N 分钟提醒：绝对毫秒比较，跨零点、开页补报都能自然覆盖 ---- */
    checkStartWarns: function (now) {
      var span = App.Config.warnStartMin * 60000;
      App.Manager.all().forEach(function (t) {
        if (t.status !== 'pending') return;
        if (this.firedStartWarnIds[t.id]) return;
        var diff = util.taskStartMs(t) - now;
        if (diff <= 0 || diff > span) return;

        this.firedStartWarnIds[t.id] = true;
        App.bus.emit('task:warn-start', {
          task: t,
          minutes: Math.max(1, Math.ceil(diff / 60000))   // 开页补报时可能已不足 5 分钟
        });
        this.enqueueTemp('warnStart', t.id, App.Config.tempMs.warnStart);
      }, this);
    },

    /* ---- 结束前 N 分钟打气：只针对当前活动任务，避免重叠任务连环播报 ---- */
    checkEndWarns: function (now) {
      var active = App.Manager.activeAt(now);
      if (!active || this.firedEndWarnIds[active.id]) return;

      var diff = util.taskEndMs(active) - now;   // activeAt 保证 diff > 0
      if (diff > App.Config.warnEndMin * 60000) return;

      this.firedEndWarnIds[active.id] = true;
      App.bus.emit('task:warn-end', {
        task: active,
        minutes: Math.max(1, Math.ceil(diff / 60000))
      });
      this.enqueueTemp('warnEnd', active.id, App.Config.tempMs.warnEnd);
    },

    /* 只清掉已失效任务的提醒标记：整体重置会在跨零点时让临门提醒重复播报 */
    pruneFiredWarnIds: function () {
      var now = App.Clock.now();
      var start = {}, end = {};
      Object.keys(this.firedStartWarnIds).forEach(function (id) {
        var t = App.Manager.get(id);
        if (t && t.status === 'pending' && util.taskStartMs(t) > now) start[id] = true;
      });
      Object.keys(this.firedEndWarnIds).forEach(function (id) {
        var t = App.Manager.get(id);
        if (t && t.status === 'pending' && util.taskEndMs(t) > now) end[id] = true;
      });
      this.firedStartWarnIds = start;
      this.firedEndWarnIds = end;
    },

    /* ---- 跨零点 ---- */
    rollover: function (today) {
      this.lastDateStr = today;
      this.prevActiveId = null;
      this.firedAlertIds = {};
      this.refuseCount = 0;
      this.queue = [];
      this.pruneFiredWarnIds();   // 提醒标记不整体重置，只清理已失效条目
      App.Manager.materializeRules();
      App.Manager.changed();
      App.bus.emit('day:changed', { to: today });
      this.recomputeBase();
    },

    /* ---- 跨状态请求：拒绝娱乐 ---- */
    requestRefuse: function () {
      var active = this.currentTask();
      if (!active) return false;                       // 只在任务时段受理
      if (this.temp && this.temp.type !== 'refuse') return false;

      var stamp = Date.now();
      if (stamp - this._lastRefuseAt < 800) return false;   // 防抖
      this._lastRefuseAt = stamp;

      this.refuseCount++;
      var idx = this.refuseCount >= 2 ? 1 : 0;
      var label = App.Config.categoryLabel[active.category] || '任务';
      var phrase = App.Config.refusePhrases[idx]
        .replace(/\{category\}/g, label)
        .replace(/\{title\}/g, active.title);

      App.bus.emit('refuse', { level: idx + 1, phrase: phrase, task: active });
      this.enqueueTemp('refuse', active.id, App.Config.tempMs.refuse);
      return true;
    },

    /* ---- 临时态队列 ---- */
    enqueueTemp: function (type, taskId, ms) {
      var key = type + ':' + (taskId || '');
      var dup = this.queue.some(function (q) { return q.key === key; });
      if (dup && type !== 'refuse') return;

      if (this.queue.length >= 3) this.queue.shift();
      this.queue.push({ type: type, taskId: taskId, ms: ms, key: key });
      this.pump();
    },

    pump: function () {
      if (this.temp || !this.queue.length) return;
      var self = this;
      var item = this.queue.shift();
      this.temp = item;

      App.bus.emit('temp:start', { type: item.type, taskId: item.taskId });
      App.Animation.playTemp(item.type, item.ms).then(function () {
        App.bus.emit('temp:end', { type: item.type, taskId: item.taskId });
        self.temp = null;
        if (self.queue.length) self.pump();
        else self.recomputeBase();
      });
    },

    /* 任务被删/改走时，撤掉指向它的临时态 */
    dropStaleTemp: function () {
      var active = this.currentTask();
      var activeId = active ? active.id : null;

      // warnStart 指向尚未开始的任务，不能按「是否活动任务」判断
      function isStale(q) {
        if (!q.taskId) return false;
        if (q.type === 'warnStart') {
          var t = App.Manager.get(q.taskId);
          return !(t && t.status === 'pending');
        }
        return q.taskId !== activeId;
      }

      this.queue = this.queue.filter(function (q) { return !isStale(q); });

      if (this.temp && this.temp.taskId && isStale(this.temp)) {
        App.Animation.cancelTemp();
      }
      if (!active) this.refuseCount = 0;
    },

    /* ---- 基础态重算 ---- */
    recomputeBase: function () {
      if (this.temp) return;
      var active = this.currentTask();
      var from = this.base;
      this.base = this.baseFor(active);

      App.Animation.play(this.base);
      App.bus.emit('state:change', { from: from, to: this.base, task: active });
      if (this.base === 'idle') this.refuseCount = 0;
    }
  };

  App.StateMachine = StateMachine;
})();
