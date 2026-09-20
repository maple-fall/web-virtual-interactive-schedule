/*
 * dialog/bubble.js — 角色头顶对话气泡：短时播报，自动消失
 */
(function () {
  'use strict';
  var App = window.App;

  var Bubble = {
    el: null,
    textEl: null,
    _timer: null,

    init: function (el) {
      this.el = el;
      this.textEl = el ? el.querySelector('.bubble-text') : null;
    },

    /* say(text, {ms, mood}) */
    say: function (text, opts) {
      if (!this.el) return;
      opts = opts || {};
      var ms = opts.ms || 5000;

      if (this.textEl) this.textEl.textContent = String(text);
      this.el.setAttribute('data-mood', opts.mood || 'idle');
      this.el.hidden = false;

      // 重放入场动画
      this.el.style.animation = 'none';
      /* eslint-disable no-unused-expressions */
      this.el.offsetHeight;
      this.el.style.animation = '';

      var self = this;
      clearTimeout(this._timer);
      this._timer = setTimeout(function () { self.clear(); }, ms);
    },

    clear: function () {
      clearTimeout(this._timer);
      this._timer = null;
      if (this.el) this.el.hidden = true;
    }
  };

  App.Bubble = Bubble;
})();
