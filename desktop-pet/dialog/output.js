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

    /* 流式回复：先占位再逐段填充，返回句柄 { append, end, error, text }
         opts.mood   —— 与 pet() 同义
         opts.render —— fn(原文) -> html，转义责任在调用方（llm.js 传 mdToHtml）
       逐字重排会抖，所以攒够 24 字或隔 80ms 才重绘一次；end 时做一次干净收尾 */
    stream: function (opts) {
      opts = opts || {};
      var self = this;
      var render = opts.render || function (t) { return App.util.escapeHtml(t); };
      var div = this._push('msg-pet', '');
      if (div) {
        div.setAttribute('data-mood', opts.mood || 'idle');
        div.classList.add('streaming');
      }

      var text = '', shownLen = -1, lastAt = 0, timer = null, closed = false;

      function scroll() {
        if (self.el) self.el.scrollTop = self.el.scrollHeight;
      }
      function paint(force) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!div || (closed && !force)) return;
        div.innerHTML = render(text);
        shownLen = text.length;
        lastAt = Date.now();
        scroll();
      }

      return {
        append: function (chunk) {
          if (closed || !chunk) return;
          text += String(chunk);
          if (text.length - shownLen >= 24 || Date.now() - lastAt >= 80) {
            paint();
            return;
          }
          if (!timer) {
            timer = setTimeout(function () { timer = null; paint(); }, 90);
          }
        },
        end: function (finalText) {
          if (closed) return;
          if (finalText != null) text = String(finalText);
          closed = true;
          paint(true);
          if (div) div.classList.remove('streaming');
        },
        /* 推翻已上屏的内容重来：llm.js 的复读守卫重问时要用。
           清空文字并回到可继续 append 的状态（closed 也一并复位） */
        reset: function () {
          if (timer) { clearTimeout(timer); timer = null; }
          text = '';
          shownLen = -1;
          closed = false;
          if (div) {
            div.classList.add('streaming');
            paint(true);
          }
        },
        error: function (html) {
          if (closed) return;
          closed = true;
          if (timer) { clearTimeout(timer); timer = null; }
          if (!div) return;
          div.className = 'msg msg-error';   // 去掉 streaming，光标随之消失
          div.innerHTML = html;
          scroll();
        },
        text: function () { return text; }
      };
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
