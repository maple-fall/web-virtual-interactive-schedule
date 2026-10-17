/*
 * character/animation.js — 角色动画：形象包（IndexedDB 里的 blob）优先，
 * 其次 videos/<state>.webm（VP9 透明通道），依次回退 .mp4 -> 内置 SVG 小猫
 * 对外：init(stageEl) / preload(forceSvg) / setCharacter(pack|null) /
 *       play(baseState) / playTemp(state, ms, opts) -> Promise
 */
(function () {
  'use strict';
  var App = window.App;

  var STATES = ['idle', 'studying', 'working', 'alert', 'done', 'refuse', 'talking'];
  /* 提醒类临时态的视觉别名：applyState 会把未知状态钳回 idle，故映射到已有素材 */
  var TEMP_VISUALS = { warnStart: 'alert', warnEnd: 'done' };
  /* 浏览器实测：HEVC(H.265) 的 mp4 在 Chrome/Edge 无法播放，故 webm(VP9-alpha) 优先 */
  var EXTS = ['.webm', '.mp4'];
  /* 探测超时。冷启动读盘 + 杀软扫描可能明显慢于热缓存，给足余量；
     真正的「文件不存在」走 error 事件，不受这个值影响 */
  var PROBE_MS = 5000;

  /* 内置 SVG 小猫：头/耳/眼/身/手/尾 + 书/键盘道具 + 感叹号/✕/星光 */
  function svgMarkup() {
    return [
      '<div class="pet-shadow"></div>',
      '<svg class="pet" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">',
      '<defs>',
      '<linearGradient id="furG" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0%" stop-color="#f7b267"/><stop offset="100%" stop-color="#e08b3e"/>',
      '</linearGradient>',
      '<linearGradient id="bellyG" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0%" stop-color="#fff4e2"/><stop offset="100%" stop-color="#ffe3bd"/>',
      '</linearGradient>',
      '</defs>',

      '<g class="pet-all">',

      /* 尾巴（在身后） */
      '<g class="g-tail">',
      '<path d="M138 148 q30 -6 30 -34 q0 -12 -10 -14" fill="none" stroke="#e08b3e"',
      ' stroke-width="10" stroke-linecap="round"/>',
      '</g>',

      /* 身体 */
      '<g class="g-body">',
      '<ellipse cx="100" cy="152" rx="44" ry="36" fill="url(#furG)"/>',
      '<ellipse cx="100" cy="158" rx="30" ry="26" fill="url(#bellyG)"/>',
      '<ellipse cx="72" cy="184" rx="14" ry="8" fill="#f7b267"/>',
      '<ellipse cx="128" cy="184" rx="14" ry="8" fill="#f7b267"/>',
      '</g>',

      /* 道具：书本 / 键盘 */
      '<g class="prop-book">',
      '<rect x="60" y="150" width="80" height="13" rx="3" fill="#5b8cff"/>',
      '<rect x="60" y="150" width="80" height="5" rx="2" fill="#8fb4ff"/>',
      '<rect x="96" y="148" width="4" height="17" fill="#3c63cc"/>',
      '</g>',
      '<g class="prop-keyboard">',
      '<rect x="58" y="158" width="84" height="20" rx="4" fill="#3a4470"/>',
      '<rect x="64" y="163" width="72" height="3" rx="1.5" fill="#7b88c4"/>',
      '<rect x="64" y="169" width="54" height="3" rx="1.5" fill="#7b88c4"/>',
      '</g>',

      /* 手臂 */
      '<g class="g-arm arm-l">',
      '<ellipse cx="62" cy="140" rx="11" ry="15" fill="#efa55c"/>',
      '</g>',
      '<g class="g-arm arm-r">',
      '<ellipse cx="138" cy="140" rx="11" ry="15" fill="#efa55c"/>',
      '</g>',

      /* 头 */
      '<g class="g-head">',
      '<path class="ear ear-l" d="M66 74 l4 -30 l26 16 z" fill="#e08b3e"/>',
      '<path class="ear ear-r" d="M134 74 l-4 -30 l-26 16 z" fill="#e08b3e"/>',
      '<path d="M69 72 l3 -20 l17 11 z" fill="#ffc48f"/>',
      '<path d="M131 72 l-3 -20 l-17 11 z" fill="#ffc48f"/>',
      '<circle cx="100" cy="92" r="44" fill="url(#furG)"/>',
      '<ellipse cx="100" cy="106" rx="26" ry="18" fill="#fff4e2"/>',
      /* 眼 */
      '<g class="eye eye-l">',
      '<ellipse cx="84" cy="86" rx="8" ry="10" fill="#241c14"/>',
      '<circle cx="86.5" cy="82" r="2.8" fill="#fff"/>',
      '</g>',
      '<g class="eye eye-r">',
      '<ellipse cx="116" cy="86" rx="8" ry="10" fill="#241c14"/>',
      '<circle cx="118.5" cy="82" r="2.8" fill="#fff"/>',
      '</g>',
      /* 鼻嘴 */
      '<path d="M96 100 h8 l-4 5 z" fill="#e0708c"/>',
      '<path d="M100 105 v4 M100 109 q-7 6 -13 0 M100 109 q7 6 13 0"',
      ' fill="none" stroke="#c9803c" stroke-width="2" stroke-linecap="round"/>',
      /* 胡须 */
      '<path d="M62 98 h14 M62 106 h13 M138 98 h-14 M138 106 h-13"',
      ' stroke="#e8d8c4" stroke-width="1.6" stroke-linecap="round"/>',
      '</g>',

      /* 符号：感叹号 / ✕ / 星光 */
      '<g class="sign sign-exclam" transform="translate(150 44)">',
      '<circle cx="0" cy="0" r="17" fill="#ffd166"/>',
      '<rect x="-3" y="-10" width="6" height="13" rx="3" fill="#5a3d00"/>',
      '<circle cx="0" cy="8" r="3.4" fill="#5a3d00"/>',
      '</g>',
      '<g class="sign sign-cross" transform="translate(150 46)">',
      '<circle cx="0" cy="0" r="17" fill="#ff6b8a"/>',
      '<path d="M-7 -7 L7 7 M7 -7 L-7 7" stroke="#4a0d1c" stroke-width="4"',
      ' stroke-linecap="round"/>',
      '</g>',
      '<g class="sparkle s1" transform="translate(44 62)">',
      '<path d="M0 -9 L2.5 -2.5 L9 0 L2.5 2.5 L0 9 L-2.5 2.5 L-9 0 L-2.5 -2.5 Z" fill="#ffd166"/>',
      '</g>',
      '<g class="sparkle s2" transform="translate(160 74)">',
      '<path d="M0 -7 L2 -2 L7 0 L2 2 L0 7 L-2 2 L-7 0 L-2 -2 Z" fill="#7cf0a8"/>',
      '</g>',
      '<g class="sparkle s3" transform="translate(150 116)">',
      '<path d="M0 -6 L1.7 -1.7 L6 0 L1.7 1.7 L0 6 L-1.7 1.7 L-6 0 L-1.7 -1.7 Z" fill="#6ea8ff"/>',
      '</g>',

      '</g>',
      '</svg>'
    ].join('');
  }

  var Animation = {
    stage: null,
    video: null,
    svgBox: null,
    mode: 'svg',          // 'video' | 'svg'
    forced: false,        // ?novideo=1
    current: 'idle',
    ext: null,            // 实际可用的扩展名 '.webm' / '.mp4'
    _tempTimer: null,
    _tempResolve: null,
    _videoOk: false,
    _missing: {},         // 素材缺失的状态 -> 用 idle 素材顶替
    pack: null,           // 当前激活的形象包（null = 默认 videos/ 素材）
    _packUrls: {},        // state -> blob URL（当前形象包）
    _staleUrls: [],       // 上一批 blob URL，等下一次切换再撤销
    _probeEl: null,
    _probeTimer: null,
    _probeSeq: 0,
    _pageHideBound: false,

    init: function (stageEl) {
      this.stage = stageEl;
      stageEl.innerHTML =
        '<video class="pet-video" playsinline muted preload="auto" hidden></video>' +
        '<div class="pet-svg">' + svgMarkup() + '</div>';
      this.video = stageEl.querySelector('.pet-video');
      this.svgBox = stageEl.querySelector('.pet-svg');

      var self = this;
      this.video.addEventListener('error', function () { self.onVideoError(); });
      this.video.addEventListener('loadeddata', function () { self._videoOk = true; });
      // 运行中播放失败也立即降级
      this.video.addEventListener('stalled', function () {
        if (!self._videoOk) self.fallbackToSvg();
      });

      // 页面关闭/刷新时统一释放 blob URL
      if (!this._pageHideBound) {
        this._pageHideBound = true;
        window.addEventListener('pagehide', function () { self._revokeAll(); });
      }

      this.applyState('idle');
    },

    /* 该状态的素材地址；缺失的状态退用 idle 素材。
       形象包激活时优先用包内 blob：包内该状态 -> 包内 idle -> 磁盘 idle -> null */
    _srcFor: function (state) {
      var use = (state !== 'idle' && this._missing[state]) ? 'idle' : state;
      if (this.pack) {
        if (this._packUrls[use]) return this._packUrls[use];
        if (this._packUrls.idle) return this._packUrls.idle;
        return this.ext ? 'videos/idle' + this.ext : null;
      }
      return this.ext ? 'videos/' + use + this.ext : null;
    },

    /* 播放某状态素材失败：先用 idle 素材顶上，idle 也失败才切 SVG。
       形象包里的 blob 坏了：丢掉 URL，有磁盘素材就退回磁盘 idle，否则 SVG */
    onVideoError: function () {
      if (this.pack) {
        var bad = this._packUrls[this.current] || this._packUrls.idle;
        if (bad) {
          this._revokeUrl(bad);
          for (var k in this._packUrls) {
            if (Object.prototype.hasOwnProperty.call(this._packUrls, k) &&
                this._packUrls[k] === bad) {
              this._packUrls[k] = null;
            }
          }
        }
        this.pack = null;
        this._missing = {};
        if (this.ext !== null) {
          console.info('[Animation] 形象包素材无法播放，已退回 videos/idle' + this.ext);
          this._setSrc('videos/idle' + this.ext);
        } else {
          this.fallbackToSvg();
        }
        return;
      }
      if (this.ext === null) return;                     // 还在探测阶段，交给 preload
      var st = this.current;
      if (st !== 'idle' && !this._missing[st]) {
        this._missing[st] = true;
        console.info('[Animation] 缺少 videos/' + st + this.ext + '，暂用 idle 素材代替');
        this._setSrc(this._srcFor(st));
        return;
      }
      this.fallbackToSvg();
    },

    _setSrc: function (src) {
      var v = this.video;
      v.hidden = false;
      if (v.getAttribute('src') !== src) v.setAttribute('src', src);
      else { try { v.load(); } catch (e) {} }
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    },

    /* 依次探测 idle.webm / idle.mp4；都不可用则切 SVG */
    preload: function (forceSvg) {
      this.forced = !!forceSvg;
      if (forceSvg) { this.fallbackToSvg(); return; }
      this._probe(0);
    },

    _probe: function (idx) {
      var self = this;
      var token = ++this._probeSeq;
      if (idx >= EXTS.length) { this.fallbackToSvg(); return; }

      var ext = EXTS[idx];
      var probe = document.createElement('video');
      var timer = null;
      var finished = false;      // 已经成功切到视频

      function ok() {
        if (finished || token !== self._probeSeq) return;
        finished = true;
        clearTimeout(timer);
        self._probeTimer = null;
        if (self._probeEl === probe) self._probeEl = null;
        self.ext = ext;
        self.useVideo();
      }
      function fail() {
        if (finished || token !== self._probeSeq) return;
        finished = true;
        clearTimeout(timer);
        self._probeTimer = null;
        if (self._probeEl === probe) self._probeEl = null;
        probe.removeAttribute('src');
        self._probe(idx + 1);
      }

      probe.addEventListener('loadedmetadata', ok);
      probe.addEventListener('loadeddata', ok);
      probe.addEventListener('canplay', ok);
      probe.addEventListener('canplaythrough', ok);
      probe.addEventListener('error', fail);

      // 超时只说明「这次读得慢」（冷启动读盘、杀软扫描），不代表文件不存在。
      // 先降级到 SVG 保证页面可用，但监听器故意保留：文件真读出来时 ok 仍会触发，
      // 自动切回视频。真正的「文件不存在」会走 error，fail() 立刻换下一个格式。
      timer = setTimeout(function () {
        if (finished || token !== self._probeSeq) return;
        self._probeTimer = null;
        probe.__slow = true;
        console.info('[Animation] videos/idle' + ext + ' 加载偏慢，先用内置 SVG 顶上；' +
          '加载完成后会自动切换');
        self.fallbackToSvg();
      }, PROBE_MS);

      this._probeTimer = timer;
      this._probeEl = probe;
      probe.muted = true;
      probe.preload = 'auto';
      probe.src = 'videos/idle' + ext;
    },

    _probeStop: function () {
      this._probeSeq++;
      if (this._probeTimer) {
        clearTimeout(this._probeTimer);
        this._probeTimer = null;
      }
      if (this._probeEl) {
        try { this._probeEl.removeAttribute('src'); } catch (e) {}
        this._probeEl = null;
      }
    },

    /* 探针成功：从 SVG（或尚未初始化）切到视频。
       即使已经在视频模式也要重播：ext 刚确定，之前可能还是形象包的 blob
       或未探测时的空 src，必须按新的磁盘地址重算一遍 */
    useVideo: function () {
      var wasVideo = this.mode === 'video' && this.video && !this.video.hidden;
      this.mode = 'video';
      this._videoOk = true;
      this.stage.dataset.mode = 'video';
      this.svgBox.hidden = true;
      this.video.hidden = false;
      if (!wasVideo) console.info('[Animation] 已启用视频素材 videos/*' + this.ext);
      this._replayCurrent();
    },

    fallbackToSvg: function () {
      if (this.mode === 'svg' && this.svgBox) return;
      this._missing = {};
      this.mode = 'svg';
      this._videoOk = false;
      if (this.stage) this.stage.dataset.mode = 'svg';
      if (this.video) { this.video.hidden = true; try { this.video.pause(); } catch (e) {} }
      if (this.svgBox) this.svgBox.hidden = false;
      if (this.stage) this.applyState(this.current);
      console.info('[Animation] 未找到可用视频素材，已启用内置 SVG 角色动画');
    },

    isVideoMode: function () { return this.mode === 'video'; },

    /* 徽章是舞台的兄弟节点，舞台被搬进画中画窗口后会离开主文档，
       所以从舞台所在的父节点里找，别用主文档的 getElementById */
    _badge: function () {
      var wrap = this.stage && this.stage.parentNode;
      var el = (wrap && wrap.querySelector) ? wrap.querySelector('.state-badge') : null;
      return el || document.getElementById('state-badge');
    },

    applyState: function (state) {
      if (STATES.indexOf(state) < 0) state = 'idle';
      this.current = state;
      this.stage.dataset.state = state;
      var badge = this._badge();
      if (badge) badge.textContent = App.Config.stateLabel[state] || state;
    },

    /* 基础态：循环播放 */
    play: function (state) {
      if (STATES.indexOf(state) < 0) state = 'idle';
      this.clearTempTimer();
      this.applyState(state);
      if (this.mode === 'video') {
        var src = this._srcFor(state);
        if (!src) { this.fallbackToSvg(); return; }
        this.video.loop = true;
        if (this.video.getAttribute('src') !== src) this._setSrc(src);
        else {
          try { this.video.currentTime = 0; } catch (e) {}
          var p = this.video.play();
          if (p && p.catch) p.catch(function () {});
        }
      }
    },

    /* 临时态：返回 Promise，播完一轮或到时（取先），至少展示 1.8s
       opts.loop = true 时不理会「播完一轮」，一直循环到到时或被 cancelTemp() 提前结束
       （大模型「交流中」用：回复要几秒就说几秒，时长由调用方控制） */
    playTemp: function (state, ms, opts) {
      var self = this;
      var loop = !!(opts && opts.loop);
      var visual = TEMP_VISUALS[state] || state;   // 提醒态复用已有素材
      this.clearTempTimer();
      this.applyState(visual);
      if (TEMP_VISUALS[state]) {
        var badge = this._badge();
        if (badge) badge.textContent = App.Config.stateLabel[state] || '提醒';
      }

      var wait = Math.max(1800, ms || App.Config.tempMs[state] || 3000);

      return new Promise(function (resolve) {
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          self.clearTempTimer();
          resolve();
        }
        self._tempResolve = finish;

        if (self.mode === 'video') {
          var src = self._srcFor(visual);
          if (!src) {
            self.fallbackToSvg();
          } else {
            self.video.loop = loop;
            if (self.video.getAttribute('src') !== src) self._setSrc(src);
            else {
              try { self.video.currentTime = 0; } catch (e) {}
              var p = self.video.play();
              if (p && p.catch) p.catch(function () {});
            }
            // 循环播放时 ended 不会触发（浏览器自己回到开头），不必挂监听
            if (!loop) self.video.addEventListener('ended', finish, { once: true });
          }
        }
        self._tempTimer = setTimeout(finish, wait);
      });
    },

    /* 切换形象包；pack=null 表示回到 videos/ 默认素材。
       旧 blob URL 先进 _staleUrls，下一次切换才撤销（正在播的帧不会立刻黑掉） */
    setCharacter: function (pack) {
      this._revokeStale();

      var old = this._packUrls;
      for (var k in old) {
        if (Object.prototype.hasOwnProperty.call(old, k) && old[k]) {
          this._staleUrls.push(old[k]);
        }
      }
      this._packUrls = {};
      this.pack = pack || null;
      this._missing = {};

      if (this.pack && this.pack.files) {
        for (var state in this.pack.files) {
          if (!Object.prototype.hasOwnProperty.call(this.pack.files, state)) continue;
          var f = this.pack.files[state];
          if (f && f.blob) {
            try { this._packUrls[state] = URL.createObjectURL(f.blob); } catch (e) {}
          } else if (f && f.url) {
            // 内置形象：直接引用 videos/ 下的文件，不需要 blob URL
            this._packUrls[state] = f.url;
          }
        }
      }

      var canVideo = (this._packUrls.idle || this.ext !== null) && !this.forced;
      if (canVideo) {
        this.mode = 'video';
        this._videoOk = true;
        if (this.stage) this.stage.dataset.mode = 'video';
        if (this.svgBox) this.svgBox.hidden = true;
        if (this.video) this.video.hidden = false;
        console.info(this.pack
          ? (this.pack.builtin
            ? '[Animation] 已切换到内置形象「' + this.pack.name + '」'
            : '[Animation] 已切换到形象包「' + this.pack.name + '」')
          : '[Animation] 已切回默认形象 videos/*');
      }

      // 包内有 idle 就不必再探测磁盘素材；回默认形象则停掉旧探测
      if (this._packUrls.idle || !this.pack) this._probeStop();

      // 回默认形象但磁盘格式还没探过：先探测，成功后再由 useVideo 重播。
      // 此时不能立刻 _replayCurrent()——this.ext 为 null 会拼出 videos/idlenull
      if (!this.forced && !this.pack && this.ext === null) {
        this.preload();
        return;
      }
      // 当前包缺 idle 且磁盘格式未知：靠 preload 确定 ext 兜底
      if (!this.forced && this.ext === null && !this._packUrls.idle) {
        this.preload();
      }

      this._replayCurrent();
    },

    /* 切换后重播当前状态：临时态正在计时就只换 src，不打断计时 */
    _replayCurrent: function () {
      if (this.mode !== 'video') return;
      if (this._tempResolve) {
        var src = this._srcFor(this.current);
        if (src) this._setSrc(src);
        return;
      }
      this.play(this.current);
    },

    /* 只撤销 blob URL；内置形象用的是普通相对路径，revokeObjectURL 对它无意义 */
    _revokeUrl: function (url) {
      if (typeof url === 'string' && url.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(url); } catch (e) {}
      }
    },

    _revokeStale: function () {
      var list = this._staleUrls;
      this._staleUrls = [];
      for (var i = 0; i < list.length; i++) {
        this._revokeUrl(list[i]);
      }
    },

    _revokeAll: function () {
      var urls = this._packUrls;
      this._packUrls = {};
      this._revokeStale();
      for (var k in urls) {
        if (Object.prototype.hasOwnProperty.call(urls, k) && urls[k]) {
          this._revokeUrl(urls[k]);
        }
      }
    },

    /* 提前结束当前临时态（任务被删/改走时用），Promise 会立即 resolve */
    cancelTemp: function () {
      var r = this._tempResolve;
      this.clearTempTimer();
      if (r) r();
    },

    clearTempTimer: function () {
      if (this._tempTimer) { clearTimeout(this._tempTimer); this._tempTimer = null; }
      this._tempResolve = null;
    },

    destroy: function () {
      this.clearTempTimer();
      this._probeStop();
      this._revokeAll();
    }
  };

  App.Animation = Animation;
})();
