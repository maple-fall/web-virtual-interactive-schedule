/*
 * settings.js — 应用设置：舞台背景 + 界面壁纸
 * 独立 localStorage 键，不掺进日程数据（desktop_pet_v2 在每次变更时整体重写）
 *
 * 两者作用范围不同，互不覆盖：
 *   bg        只作用于 #stage；必须是 CSS 属性而非子元素，因为 Animation.init 会覆盖 #stage innerHTML
 *   wallpaper 作用于 body，是整窗底层壁纸；has-wallpaper class 让面板转半透明透出纹理
 */
(function () {
  'use strict';
  var App = window.App;

  // file:// 下无法枚举目录，预设清单硬编码；新增图片时同法追加
  var PRESETS = [
    { path: 'data/backgrounds/bg1.jpg', label: '紫色' }
  ];

  /* 界面壁纸预设。只收 data/wallpapers/ 下的图，别把 data/backgrounds/ 的舞台背景混进来——
     两者作用范围不同（见文件头注释），混放会让「换壁纸」面板里冒出背景图，用户分不清。
     扩展流程：图片处理（裁剪，压缩到最长边 ≤1920，JPEG 质量约 0.8）后放
     data/wallpapers/wallN.jpg → 在此追加一条。
     注意：已保存的设置里若存的是路径，改名/删文件后 load() 因路径不在清单而自动回退为无壁纸 */
  var WALLPAPER_PRESETS = [
    { path: 'data/wallpapers/wall1.jpg', label: '中山装·人生哲理' }
  ];

  // 压暗层：多层 background 中先列的绘制在上层，且元素背景永远绘制在自己的子元素之下
  var OVERLAY = 'linear-gradient(rgba(15,19,34,.32), rgba(15,19,34,.32)), ';
  // 壁纸比舞台铺得广，需要压暗才保证其上文字可读；但预设图本身已经很暗（亮度约 47/255），
  // 压太深就只剩一片深蓝。文字对比度主要由面板自身的 .8 不透明度兜底，这里可以给得浅一些
  var WALLPAPER_OVERLAY = 'linear-gradient(rgba(15,19,34,.35), rgba(15,19,34,.35)), ';

  var WALLPAPER_MAX_EDGE = 1920;                 // 导入图片最长边上限（超出等比缩小）
  var WALLPAPER_QUALITY = 0.8;                   // 重编码 JPEG 质量
  var WALLPAPER_MAX_LEN = 6 * 1024 * 1024;       // data URL 字符数上限，防坏数据撑爆内存
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;       // 源文件大小上限，防解码爆内存
  var DATA_URL_RE = /^data:image\/(jpeg|png|webp|gif);base64,/;

  /* 校验壁纸值：预设路径（白名单）或位图 data URL（拒绝 svg 等可执行格式） */
  function sanitizeWallpaper(v) {
    if (typeof v !== 'string' || !v) return null;
    if (v.indexOf('data:image/') === 0) {
      if (!DATA_URL_RE.test(v) || v.length > WALLPAPER_MAX_LEN) return null;
      return v;
    }
    for (var i = 0; i < WALLPAPER_PRESETS.length; i++) {
      if (WALLPAPER_PRESETS[i].path === v) return v;
    }
    return null;   // 不在白名单，视为无壁纸
  }

  function load() {
    var empty = { bg: null, wallpaper: null };
    try {
      var raw = localStorage.getItem(App.Config.settingsKey);
      if (!raw) return empty;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return empty;
      return {
        bg: typeof data.bg === 'string' ? data.bg : null,
        wallpaper: sanitizeWallpaper(data.wallpaper)
      };
    } catch (e) {
      return empty;
    }
  }

  /* 整存状态：两个字段一起写，避免一处改动抹掉另一处 */
  function save(state) {
    try {
      localStorage.setItem(App.Config.settingsKey, JSON.stringify({
        bg: state.bg, wallpaper: state.wallpaper
      }));
      return true;
    } catch (e) {
      console.error('[Settings] 设置保存失败', e);
      return false;
    }
  }

  App.Settings = {
    bg: null,
    wallpaper: null,

    init: function () {
      var s = load();
      this.bg = s.bg;
      this.wallpaper = s.wallpaper;
      this.buildPicker();
      this.applyToStage();
      this.applyWallpaper();
      this.bindUI();
    },

    /* 有背景：压暗层 + 图片；无背景：清空 inline style，交回样式表 */
    applyToStage: function () {
      // 舞台可能正被搬进画中画窗口，主文档 getElementById 会找不到；优先用 Animation 缓存的引用
      var stage = (App.Animation && App.Animation.stage) || document.getElementById('stage');
      if (!stage) return;

      if (this.bg) {
        stage.style.backgroundImage = OVERLAY + 'url("' + this.bg + '")';
        stage.classList.add('has-bg');
      } else {
        stage.style.backgroundImage = '';
        stage.classList.remove('has-bg');
      }

      var clearBtn = document.getElementById('btn-bg-clear');
      if (clearBtn) clearBtn.hidden = !this.bg;

      var picker = document.getElementById('bg-picker');
      if (picker) this.syncPickerSelection(picker);
      // 画中画开着时不用额外通知：搬过去的正是 #stage 本身，inline 背景就地生效
    },

    /* 壁纸铺满整窗：cover + 居中 + fixed（滚动时钉在视口上，同桌面壁纸） */
    applyWallpaper: function () {
      var body = document.body;
      if (!body) return;
      var st = body.style;

      if (this.wallpaper) {
        body.classList.add('has-wallpaper');
        st.backgroundImage = WALLPAPER_OVERLAY + 'url("' + this.wallpaper + '")';
        st.backgroundSize = 'cover';
        st.backgroundPosition = 'center';
        st.backgroundRepeat = 'no-repeat';
        st.backgroundAttachment = 'fixed';
      } else {
        body.classList.remove('has-wallpaper');
        st.backgroundImage = '';
        st.backgroundSize = '';
        st.backgroundPosition = '';
        st.backgroundRepeat = '';
        st.backgroundAttachment = '';
      }

      var clearBtn = document.getElementById('btn-wallpaper-clear');
      if (clearBtn) clearBtn.hidden = !this.wallpaper;

      this.buildWallpaperPicker();
    },

    select: function (path) {
      if (PRESETS.every(function (p) { return p.path !== path; })) return;
      if (!save({ bg: path, wallpaper: this.wallpaper })) {
        App.Output.error('背景设置保存失败，浏览器存储空间可能已满。');
        App.Bubble.say('背景没保存上，稍后再试试', { ms: 3500 });
        return;
      }
      this.bg = path;
      this.applyToStage();
      App.Output.system('舞台背景已更新。');
      App.Bubble.say('背景换好啦～', { ms: 2500 });
    },

    clearBg: function () {
      save({ bg: null, wallpaper: this.wallpaper });
      this.bg = null;
      this.applyToStage();
      App.Output.system('舞台背景已清除。');
      App.Bubble.say('背景已清除', { ms: 2500 });
    },

    selectWallpaper: function (path) {
      if (sanitizeWallpaper(path) !== path) return;
      if (!save({ bg: this.bg, wallpaper: path })) {
        App.Output.error('壁纸保存失败，浏览器存储空间可能已满。');
        App.Bubble.say('壁纸没保存上，稍后再试试', { ms: 3500 });
        return;
      }
      this.wallpaper = path;
      this.applyWallpaper();
      App.Output.system('界面壁纸已更新。');
      App.Bubble.say('壁纸换好啦～', { ms: 2500 });
    },

    clearWallpaper: function () {
      save({ bg: this.bg, wallpaper: null });
      this.wallpaper = null;
      this.applyWallpaper();
      App.Output.system('界面壁纸已清除。');
      App.Bubble.say('壁纸已清除', { ms: 2500 });
    },

    /* 导入本地图片：读成 data URL → 等比缩到最长边 ≤1920 → JPEG → 存进设置
       用 data URL 作画源不会被判跨源，canvas 不会被污染（本地文件路径则会） */
    importWallpaper: function (file) {
      var self = this;
      if (!file) return;                                   // 用户取消选择
      if (file.type && file.type.indexOf('image/') !== 0) {
        App.Output.error('这个文件不是图片。');
        App.Bubble.say('要选图片文件哦', { ms: 3000 });
        return;
      }
      if (file.size > MAX_IMPORT_BYTES) {
        App.Output.error('图片太大了（超过 ' + (MAX_IMPORT_BYTES / 1024 / 1024) + 'MB），换一张吧。');
        return;
      }

      function fail(msg, tip) {
        App.Output.error(msg);
        App.Bubble.say(tip, { ms: 3500 });
      }

      var reader = new FileReader();
      reader.onerror = function () {
        fail('图片读取失败，文件可能无法访问。', '图片读不出来，换一张试试');
      };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () {
          fail('图片解码失败，文件可能已损坏或格式不支持。', '这张图打不开，换一张试试');
        };
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { img.onerror(); return; }         // SVG 无固有尺寸等场景

          var scale = Math.min(1, WALLPAPER_MAX_EDGE / Math.max(w, h));   // 只缩不放
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));

          var canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          var ctx = canvas.getContext('2d');
          if (!ctx) { img.onerror(); return; }
          ctx.fillStyle = '#171d33';                       // 透明 PNG 转 JPEG 前铺底色
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);

          var dataUrl = null;
          try {
            dataUrl = canvas.toDataURL('image/jpeg', WALLPAPER_QUALITY);
          } catch (e) { /* 理论不可达：data URL 图源不污染画布 */ }
          if (!dataUrl || dataUrl.indexOf('data:image/jpeg') !== 0 ||
              dataUrl.length > WALLPAPER_MAX_LEN) {
            fail('图片处理失败，换一张小一点的试试。', '壁纸没换成，换张图试试');
            return;
          }
          if (!save({ bg: self.bg, wallpaper: dataUrl })) {
            fail('壁纸保存失败，浏览器存储空间可能已满。', '壁纸存不上，换张小图试试');
            return;
          }
          self.wallpaper = dataUrl;
          self.applyWallpaper();
          App.Output.system('界面壁纸已更新（已压缩到最长边 ' + WALLPAPER_MAX_EDGE + 'px 内）。');
          App.Bubble.say('壁纸换好啦～', { ms: 2500 });
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    },

    /* 按 PRESETS 生成舞台背景缩略图 */
    buildPicker: function () {
      var picker = document.getElementById('bg-picker');
      if (!picker) return;

      var frag = document.createDocumentFragment();
      var tip = document.createElement('span');
      tip.className = 'bg-picker-tip';
      tip.textContent = '选择舞台背景：';
      frag.appendChild(tip);

      var none = document.createElement('button');
      none.type = 'button';
      none.className = 'bg-none';
      none.dataset.path = '';
      none.textContent = '无';
      frag.appendChild(none);

      PRESETS.forEach(function (p) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bg-thumb';
        btn.dataset.path = p.path;
        btn.title = p.label || p.path;
        btn.style.backgroundImage = 'url("' + p.path + '")';
        frag.appendChild(btn);
      });

      picker.innerHTML = '';
      picker.appendChild(frag);
      this.syncPickerSelection(picker);
    },

    syncPickerSelection: function (picker) {
      var current = this.bg || '';
      var btns = picker.querySelectorAll('[data-path]');
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].dataset.path === current;
        btns[i].classList.toggle('selected', on);
      }
    },

    /* 按 WALLPAPER_PRESETS 生成壁纸缩略图，外加导入按钮 */
    buildWallpaperPicker: function () {
      var picker = document.getElementById('wallpaper-picker');
      if (!picker) return;

      var frag = document.createDocumentFragment();
      var tip = document.createElement('span');
      tip.className = 'bg-picker-tip';
      tip.textContent = '选择界面壁纸：';
      frag.appendChild(tip);

      var none = document.createElement('button');
      none.type = 'button';
      none.className = 'bg-none';
      none.dataset.path = '';
      none.textContent = '无';
      frag.appendChild(none);

      WALLPAPER_PRESETS.forEach(function (p) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bg-thumb';
        btn.dataset.path = p.path;
        btn.title = p.label || p.path;
        btn.style.backgroundImage = 'url("' + p.path + '")';
        frag.appendChild(btn);
      });

      // 当前壁纸若是导入的 data URL，用一个只读缩略图展示现状。
      // 刻意不给 data-path：委托查找会跳过它，也避免把巨长的 base64 写进 DOM 属性
      if (this.wallpaper && this.wallpaper.indexOf('data:image/') === 0) {
        var cur = document.createElement('span');
        cur.className = 'bg-thumb selected';
        cur.title = '当前自定义壁纸';
        cur.style.backgroundImage = 'url("' + this.wallpaper + '")';
        frag.appendChild(cur);
      }

      var imp = document.createElement('button');
      imp.type = 'button';
      imp.className = 'bg-import';
      imp.dataset.action = 'import';
      imp.textContent = '本地图片…';
      frag.appendChild(imp);

      picker.innerHTML = '';
      picker.appendChild(frag);
      this.syncWallpaperPickerSelection(picker);
    },

    syncWallpaperPickerSelection: function (picker) {
      var current = this.wallpaper || '';
      var btns = picker.querySelectorAll('[data-path]');
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].dataset.path === current;
        btns[i].classList.toggle('selected', on);
      }
      // 导入的 data URL 不落在任何 data-path 上，「无」保持未选中；自定义缩略图自带 selected
    },

    bindUI: function () {
      if (this._uiBound) return;
      this._uiBound = true;
      var self = this;

      var picker = document.getElementById('bg-picker');
      var wPicker = document.getElementById('wallpaper-picker');
      var fileInput = document.getElementById('file-wallpaper');
      var btnBg = document.getElementById('btn-bg');
      var btnClear = document.getElementById('btn-bg-clear');
      var btnWp = document.getElementById('btn-wallpaper');
      var btnWpClear = document.getElementById('btn-wallpaper-clear');

      // 两个面板互斥：展开一个就收起另一个（同为 flex-basis:100%，同时展开会挤成两行）
      function toggle(panel, other) {
        panel.hidden = !panel.hidden;
        if (!panel.hidden && other) other.hidden = true;
      }
      if (btnBg && picker) {
        btnBg.addEventListener('click', function () { toggle(picker, wPicker); });
      }
      if (btnWp && wPicker) {
        btnWp.addEventListener('click', function () { toggle(wPicker, picker); });
      }

      // 事件委托：从点击目标向上找带 data-path 的按钮（不依赖 closest）
      if (picker) {
        picker.addEventListener('click', function (e) {
          var t = e.target;
          while (t && t !== picker && !(t.dataset && typeof t.dataset.path === 'string')) {
            t = t.parentNode;
          }
          if (!t || t === picker || !t.dataset) return;
          var path = t.dataset.path;
          if (path) self.select(path);
          else self.clearBg();
        });
      }

      // 壁纸面板：先认 data-action（导入按钮），再认 data-path（预设 / 无）
      if (wPicker) {
        wPicker.addEventListener('click', function (e) {
          var t = e.target;
          while (t && t !== wPicker && !(t.dataset &&
                 (typeof t.dataset.action === 'string' || typeof t.dataset.path === 'string'))) {
            t = t.parentNode;
          }
          if (!t || t === wPicker || !t.dataset) return;
          if (t.dataset.action === 'import') {
            if (fileInput) fileInput.click();
            return;
          }
          if (typeof t.dataset.path === 'string') {
            var path = t.dataset.path;
            if (path) self.selectWallpaper(path);
            else self.clearWallpaper();
          }
        });
      }

      if (fileInput) {
        fileInput.addEventListener('change', function (e) {
          var f = e.target && e.target.files && e.target.files[0];
          if (f) self.importWallpaper(f);
          // 置空，同一张图才能再次被选中；File 已被 readAsDataURL 同步持有，不受影响
          e.target.value = '';
        });
      }

      if (btnClear) btnClear.addEventListener('click', function () { self.clearBg(); });
      if (btnWpClear) btnWpClear.addEventListener('click', function () { self.clearWallpaper(); });
    }
  };
})();
