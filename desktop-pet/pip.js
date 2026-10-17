/*
 * pip.js — 画中画：把整个舞台（.stage-wrap：背景 + 角色 + 气泡 + 状态徽章）
 * 搬进浏览器的「文档画中画」窗口显示，并在窗口底部附一条紧凑计划栏。
 *
 * 为什么不用 canvas 合成：file:// 下把本地图片/视频画进 canvas 会污染画布，
 * captureStream / getImageData / toDataURL 一律抛 SecurityError，合成路线在本地文件场景走不通。
 * 改成搬 DOM 后，背景就是普通的 CSS background，浏览器自己渲染，没有跨源问题。
 *
 * 依赖 Document Picture-in-Picture API：Chrome/Edge 116+、Firefox 151+；Safari 不支持。
 * 不支持时按钮保持 hidden，其余功能不受影响。
 */
(function () {
  'use strict';
  var App = window.App;

  var MIN_W = 240, MAX_W = 460;
  var MIN_H = 280, MAX_H = 620;
  /* 底部计划栏额外占的高度：开窗时给角色留出原来的空间 */
  var PLAN_H = 120;

  /* 注入画中画文档的兜底样式：舞台铺满窗口上半部分，计划面板贴底
     （主样式表随后加载，这里的选择器与它同权重但更靠后，正好覆盖 .stage 的 420px 上限） */
  var PIP_CSS = [
    'html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg-pane, #171d33); }',
    'body { display: flex; flex-direction: column; }',
    '.stage-wrap { flex: 1 1 auto; width: 100%; height: auto; min-height: 0; padding: 0; }',
    '.stage { width: 100%; max-width: none; min-height: 0; }',
    '.pip-plan { flex: 0 0 auto; max-height: 46%; }'
  ].join('\n');

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  App.Pip = {
    win: null,
    _wrap: null,
    _slot: null,
    _opening: false,
    /* 计划面板：只在画中画文档里存在，随 schedule:changed / state:change 刷新 */
    _plan: null,
    _planList: null,
    _planCount: null,
    _onSchedule: null,
    _onState: null,
    _planTimer: null,

    init: function () {
      var btn = document.getElementById('btn-pip');
      if (!btn) return;
      if (!this.supported()) return;      // 不支持就把按钮留在 hidden
      btn.hidden = false;
      btn.title = '角色和接下来的安排一起悬浮显示，可拖到桌面右上角';
      var self = this;
      btn.addEventListener('click', function () { self.toggle(); });
    },

    supported: function () {
      return !!(window.documentPictureInPicture &&
        typeof window.documentPictureInPicture.requestWindow === 'function');
    },

    active: function () {
      return !!(this.win && !this.win.closed);
    },

    toggle: function () {
      if (this.active()) this.close();
      else this.open();
    },

    /* 必须由用户手势同步触发，否则浏览器拒绝开窗 */
    open: function () {
      if (this.active() || this._opening) return;
      var wrap = document.querySelector('.stage-wrap');
      if (!wrap) return;

      var self = this;
      this._opening = true;
      window.documentPictureInPicture.requestWindow(this._sizeFor(wrap))
        .then(function (win) {
          self._opening = false;
          try { self._attach(win, wrap); }
          catch (e) {
            console.warn('[Pip] 舞台搬进画中画失败', e);
            try { win.close(); } catch (e2) { /* 窗口可能已经不在了 */ }
          }
        })
        .catch(function (e) {
          self._opening = false;
          console.warn('[Pip] 打开画中画失败', e);
          App.Bubble.say('画中画没能打开，可能是这个浏览器不支持', { ms: 3200 });
        });
    },

    close: function () {
      if (this.win && !this.win.closed) this.win.close();   // 触发 pagehide -> _detach
      else this._detach();
    },

    /* 按舞台现有比例开窗，再钳到舒适尺寸；比例只是尽量贴近，钳位优先
       （实际窗口宽度由浏览器定，用户还能手动拖，所以布局本身要能适应任意尺寸） */
    _sizeFor: function (wrap) {
      var r = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
      var rw = (r && r.width) ? r.width : 360;
      var rh = (r && r.height) ? r.height : 480;

      var w = clamp(Math.round(rw), MIN_W, MAX_W);
      var h = clamp(Math.round(w * (rh / rw)) + PLAN_H, MIN_H, MAX_H);
      return { width: w, height: h };
    },

    _attach: function (win, wrap) {
      this._copyStyles(win.document);

      // 原位留个占位，避免主界面塌陷
      var slot = document.createElement('div');
      slot.className = 'stage-slot';
      slot.textContent = '舞台正在画中画窗口里显示';
      wrap.parentNode.insertBefore(slot, wrap);

      this._wrap = wrap;
      this._slot = slot;
      this.win = win;

      // 搬的是同一个元素：事件绑定、data-state、inline 背景全部原样保留
      win.document.body.appendChild(wrap);

      var self = this;
      win.addEventListener('pagehide', function () { self._detach(); });

      this._syncBtn();
      this._buildPlan(win);
      this._bindPlan();
      this._renderPlan();
      this._resumeVideo();
    },

    _detach: function () {
      var wrap = this._wrap, slot = this._slot;
      if (!wrap) return;                                  // 没搬过，或已经搬回

      if (wrap && slot && slot.parentNode) {
        slot.parentNode.insertBefore(wrap, slot);         // 放回原位置
      } else if (wrap) {
        var pane = document.querySelector('.character-pane');
        if (pane) pane.appendChild(wrap);
      }
      if (slot && slot.parentNode) slot.parentNode.removeChild(slot);

      this._unbindPlan();
      this._wrap = null;
      this._slot = null;
      this.win = null;
      this._syncBtn();
      this._resumeVideo();
    },

    /* 主样式表按绝对地址复制过去；相对路径靠 <base> 兜底 */
    _copyStyles: function (doc) {
      var base = doc.createElement('base');
      base.href = document.baseURI;
      doc.head.appendChild(base);

      var i, node;
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (i = 0; i < links.length; i++) {
        node = doc.createElement('link');
        node.rel = 'stylesheet';
        node.href = links[i].href;                        // href 属性已是解析后的绝对地址
        doc.head.appendChild(node);
      }

      var styles = document.querySelectorAll('style');
      for (i = 0; i < styles.length; i++) {
        node = doc.createElement('style');
        node.textContent = styles[i].textContent;
        doc.head.appendChild(node);
      }

      node = doc.createElement('style');
      node.textContent = PIP_CSS;
      doc.head.appendChild(node);
    },

    /* 元素被搬到另一个文档后播放会中断，回到视频模式就续播 */
    _resumeVideo: function () {
      var A = App.Animation;
      if (!A || !A.video || !A.isVideoMode || !A.isVideoMode()) return;
      if (A.video.hidden) A.video.hidden = false;
      var p = A.video.play();
      if (p && p.catch) p.catch(function () {});
    },

    /* ---------------- 画中画计划面板 ----------------
       主窗口最小化后只剩画中画可见，所以把「接下来的安排」也搬一小份进来。
       只用 textContent 建 DOM：任务标题来自用户输入，拼 HTML 会有注入风险。 */

    _buildPlan: function (win) {
      var doc = win.document;

      var plan = doc.createElement('div');
      plan.className = 'pip-plan';

      var head = doc.createElement('div');
      head.className = 'pip-plan-head';
      var title = doc.createElement('span');
      title.className = 'pip-plan-title';
      title.textContent = '接下来';
      var count = doc.createElement('span');
      count.className = 'pip-plan-count';
      head.appendChild(title);
      head.appendChild(count);

      var list = doc.createElement('div');
      list.className = 'pip-plan-list';

      plan.appendChild(head);
      plan.appendChild(list);
      doc.body.appendChild(plan);

      this._plan = plan;
      this._planList = list;
      this._planCount = count;
    },

    /* 只取今起三天里还没结束的任务，按开始时间排序 */
    _planItems: function (now) {
      var util = App.util;
      var today = App.Clock.today();
      var horizon = {};
      for (var i = 0; i < 3; i++) horizon[util.addDaysStr(today, i)] = true;

      var items = [];
      var tasks = App.Manager.all();
      for (var j = 0; j < tasks.length; j++) {
        var t = tasks[j];
        if (!horizon[t.date]) continue;
        if (util.taskEndMs(t) <= now) continue;
        items.push(t);
      }
      items.sort(function (a, b) { return util.taskStartMs(a) - util.taskStartMs(b); });
      return items;
    },

    _renderPlan: function () {
      if (!this.active() || !this._planList) return;
      var doc = this.win.document;
      var util = App.util;
      var now = App.Clock.now();
      var today = App.Clock.today();
      var items = this._planItems(now);
      var list = this._planList;

      while (list.firstChild) list.removeChild(list.firstChild);

      var todayCount = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].date === today) todayCount++;
      }
      this._planCount.textContent = '今天 ' + todayCount + ' 项';

      if (!items.length) {
        var empty = doc.createElement('div');
        empty.className = 'pip-plan-empty';
        empty.textContent = '接下来没有安排，休息一下～';
        list.appendChild(empty);
        return;
      }

      var MAX_ROWS = 5;
      for (var j = 0; j < items.length && j < MAX_ROWS; j++) {
        var t = items[j];
        var row = doc.createElement('div');
        var active = util.taskStartMs(t) <= now && now < util.taskEndMs(t);
        row.className = active ? 'pip-plan-row is-active' : 'pip-plan-row';

        var when = doc.createElement('span');
        when.className = 'pip-plan-when';
        var prefix = '';
        if (t.date !== today) {
          var diff = Math.round((util.dayStartMs(t.date) - util.dayStartMs(today)) / 86400000);
          if (diff === 1) prefix = '明天 ';
          else if (diff === 2) prefix = '后天 ';
        }
        when.textContent = prefix + t.startTime;

        var name = doc.createElement('span');
        name.className = 'pip-plan-name';
        name.textContent = t.title;

        row.appendChild(when);
        row.appendChild(name);
        if (active) {
          var live = doc.createElement('span');
          live.className = 'pip-plan-live';
          live.textContent = '进行中';
          row.appendChild(live);
        }
        list.appendChild(row);
      }

      if (items.length > MAX_ROWS) {
        var more = doc.createElement('div');
        more.className = 'pip-plan-more';
        more.textContent = '还有 ' + (items.length - MAX_ROWS) + ' 项';
        list.appendChild(more);
      }
    },

    _bindPlan: function () {
      var self = this;
      this._onSchedule = function () { self._renderPlan(); };
      this._onState = function () { self._renderPlan(); };
      if (App.bus && App.bus.on) {
        App.bus.on('schedule:changed', this._onSchedule);
        App.bus.on('state:change', this._onState);
      }
      /* 主循环只在状态切换时发事件，时间流逝不会触发；半分钟刷一次让「进行中」和过期行跟上 */
      this._planTimer = setInterval(function () { self._renderPlan(); }, 30000);
    },

    _unbindPlan: function () {
      if (App.bus && App.bus.off) {
        if (this._onSchedule) App.bus.off('schedule:changed', this._onSchedule);
        if (this._onState) App.bus.off('state:change', this._onState);
      }
      this._onSchedule = null;
      this._onState = null;
      if (this._planTimer) {
        clearInterval(this._planTimer);
        this._planTimer = null;
      }
      if (this._plan && this._plan.parentNode) {
        this._plan.parentNode.removeChild(this._plan);
      }
      this._plan = null;
      this._planList = null;
      this._planCount = null;
    },

    _syncBtn: function () {
      var btn = document.getElementById('btn-pip');
      if (btn) btn.textContent = this.active() ? '关闭画中画' : '画中画';
    }
  };
})();
