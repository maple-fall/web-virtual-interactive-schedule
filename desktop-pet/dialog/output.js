/*
 * dialog/output.js — 底部聊天记录渲染（纯展示，所有用户/CSV 文本均转义）
 */
(function () {
  'use strict';
  var App = window.App;

  var Output = {
    el: null,
    MAX: 120,

    init: function (listEl) {
      this.el = listEl;
    },

    _push: function (cls, html) {
      if (!this.el) return null;
      var div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.innerHTML = html;
      this.el.appendChild(div);
      while (this.el.children.length > this.MAX) {
        this.el.removeChild(this.el.firstChild);
      }
      this.el.scrollTop = this.el.scrollHeight;
      return div;
    },

    /* 用户气泡：原文展示，按换行切段并转义 */
    user: function (text) {
      var html = String(text).split(/\n+/).map(function (line) {
        return '<p>' + App.util.escapeHtml(line) + '</p>';
      }).join('');
      return this._push('msg-user', html);
    },

    /* 角色回复：允许调用方传入受限 HTML（<ul>/<li>/<b>/<br>/<em>） */
    pet: function (html, opts) {
      var mood = (opts && opts.mood) || 'idle';
      var div = this._push('msg-pet', html);
      if (div) div.setAttribute('data-mood', mood);
      return div;
    },

    system: function (text) {
      return this._push('msg-system', App.util.escapeHtml(text));
    },

    error: function (html) {
      return this._push('msg-error', html);
    },

    /* 查询结果紧凑列表 */
    taskTable: function (tasks, opts) {
      opts = opts || {};
      var now = App.Clock.now();
      var rows = tasks.map(function (t) {
        var state = App.util.taskEndMs(t) <= now ? '已完成'
          : (App.util.taskStartMs(t) <= now ? '进行中' : '待完成');
        return '<li><span class="q-time">' + t.startTime + '–' + t.endTime + '</span>' +
          '<span class="q-title">' + App.util.escapeHtml(t.title) + '</span>' +
          '<span class="q-state q-' + state + '">' + state + '</span></li>';
      }).join('');
      var head = opts.title ? '<p>' + App.util.escapeHtml(opts.title) + '</p>' : '';
      return head + '<ul class="query-list">' + rows + '</ul>';
    },

    clear: function () {
      if (this.el) this.el.innerHTML = '';
    }
  };

  App.Output = Output;
})();
