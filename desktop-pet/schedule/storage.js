/*
 * schedule/storage.js — LocalStorage 读写：版本迁移、损坏兜底、备份导出/恢复
 * 只负责数据形态 {version, tasks, meta}，不懂任务语义。
 */
(function () {
  'use strict';
  var App = window.App;
  var KEY = function () { return App.Config.storageKey; };

  function freshMeta() {
    return { summaryDates: {}, suppressed: [] };
  }

  function migrate(data) {
    // v1（V1.0 简单任务表）或无版本号 -> v2：补齐字段，旧任务保留但视为具体日期任务
    if (!data.version || data.version < 2) {
      data.version = 2;
      data.tasks = (data.tasks || []).map(function (t) {
        var now = App.Clock.now();
        return {
          id: t.id || App.util.uid(),
          date: t.date || App.Clock.today(),
          startTime: t.startTime || t.start || '09:00',
          endTime: t.endTime || t.end || App.util.minToHm(
            App.util.hmToMin(t.startTime || t.start || '09:00') + App.Config.defaultDurationMin),
          endOffset: t.endOffset || 0,
          title: t.title || t.name || '未命名任务',
          category: ['studying', 'working', 'general'].indexOf(t.category) >= 0
            ? t.category : App.util.guessCategory(t.title || t.name || ''),
          status: t.status === 'done' ? 'done' : 'pending',
          dateRule: null,
          ruleId: null,
          createdAt: t.createdAt || now,
          updatedAt: now
        };
      });
      if (!data.meta) data.meta = freshMeta();
      if (!data.meta.summaryDates) data.meta.summaryDates = {};
      if (!data.meta.suppressed) data.meta.suppressed = [];
    }
    return data;
  }

  App.Storage = {
    /* -> {tasks:[], meta:{}}，永不抛异常（损坏/高版本均有兜底） */
    load: function () {
      var key = KEY();
      var raw = null;
      try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
      if (!raw) return { tasks: [], meta: freshMeta() };

      var data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        // 损坏：原样备份后重置，避免白屏
        try {
          localStorage.setItem(key + '_broken_' + Date.now(), raw.slice(0, 50000));
          localStorage.removeItem(key);
        } catch (e2) {}
        console.warn('[Storage] 数据损坏，已备份并重置');
        return { tasks: [], meta: freshMeta() };
      }

      if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) {
        return { tasks: [], meta: freshMeta() };
      }

      // 更高版本：备份后空启动，避免被低版本覆写
      if ((data.version || 1) > App.Config.schemaVersion) {
        try {
          localStorage.setItem(key + '_future_' + Date.now(), raw);
          localStorage.removeItem(key);
        } catch (e) {}
        console.warn('[Storage] 发现更高版本数据，已备份并以空数据启动');
        App.Storage.futureFlag = true;
        return { tasks: [], meta: freshMeta() };
      }

      data = migrate(data);
      if (!data.meta) data.meta = freshMeta();
      data.meta.summaryDates = data.meta.summaryDates || {};
      data.meta.suppressed = data.meta.suppressed || [];
      return data;
    },

    save: function (tasks, meta) {
      try {
        localStorage.setItem(KEY(), JSON.stringify({
          version: App.Config.schemaVersion,
          tasks: tasks,
          meta: meta
        }));
        return true;
      } catch (e) {
        console.error('[Storage] 保存失败', e);
        return false;
      }
    },

    reset: function () {
      try { localStorage.removeItem(KEY()); } catch (e) {}
    },

    /* 导出 JSON 备份；返回 false 表示下载被浏览器拦截 */
    exportBackup: function (data) {
      var json = JSON.stringify(data, null, 2);
      var name = 'desktop-pet-backup-' + App.Clock.today().replace(/-/g, '') + '.json';
      try {
        var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        return true;
      } catch (e) {
        var w = window.open('', '_blank');
        if (w) {
          w.document.write('<pre>' + App.util.escapeHtml(json) + '</pre>');
          w.document.title = name;
          return true;
        }
        return false;
      }
    },

    /* 校验备份文本并入库；-> {ok, message} */
    restoreFromText: function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) {
        return { ok: false, message: '不是有效的 JSON' };
      }
      if (!data || !Array.isArray(data.tasks)) {
        return { ok: false, message: '缺少 tasks 数组' };
      }
      data = migrate(data);
      try {
        App.Storage.save(data.tasks, data.meta || freshMeta());
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    }
  };
})();
