/*
 * settings.js — 应用设置：舞台背景 + 界面壁纸 + 本地大模型
 * 独立 localStorage 键，不掺进日程数据（desktop_pet_v2 在每次变更时整体重写）
 *
 * 三者作用范围不同，互不覆盖：
 *   bg        只作用于 #stage；必须是 CSS 属性而非子元素，因为 Animation.init 会覆盖 #stage innerHTML
 *   wallpaper 作用于 body，是整窗底层壁纸；has-wallpaper class 让面板转半透明透出纹理
 *   llm       本地模型开关与端点，运行期的唯一事实源是 App.LLM.cfg，这里只负责落盘与面板
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

  /* ---------------- 本地大模型配置 ----------------
     校验规则只写一份，在 llm.js（sanitizeConfig）；这里兜住「llm.js 没加载」的极端情况。
     llmCurrent 只用于落盘：运行期谁都可以改 App.LLM.cfg，落盘前一定先过 currentLlm() */

  var llmCurrent = { enabled: false, endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b' };

  function sanitizeLlm(v) {
    if (App.LLM && App.LLM.sanitizeConfig) return App.LLM.sanitizeConfig(v);
    var o = (v && typeof v === 'object') ? v : {};
    return {
      enabled: o.enabled === true,
      endpoint: 'http://127.0.0.1:11434',
      model: (typeof o.model === 'string' && o.model) ? o.model : 'qwen3:4b'
    };
  }

  function currentLlm() {
    return sanitizeLlm((App.LLM && App.LLM.cfg) ? App.LLM.cfg : llmCurrent);
  }

  /* 面板输入 + 当前开关状态 -> 一份完整配置（enabled 只认运行期状态，面板里没有这个控件） */
  function readLlmPanel() {
    var base = currentLlm();
    var ep = document.getElementById('llm-endpoint');
    var md = document.getElementById('llm-model');
    return {
      enabled: base.enabled,
      endpoint: (ep && ep.value.trim()) || base.endpoint,
      model: (md && md.value.trim()) || base.model
    };
  }

  function load() {
    var empty = { bg: null, wallpaper: null, llm: sanitizeLlm(null) };
    try {
      var raw = localStorage.getItem(App.Config.settingsKey);
      if (!raw) return empty;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return empty;
      return {
        bg: typeof data.bg === 'string' ? data.bg : null,
        wallpaper: sanitizeWallpaper(data.wallpaper),
        llm: sanitizeLlm(data.llm)     // 被篡改成公网地址时在这里回落到默认端点
      };
    } catch (e) {
      return empty;
    }
  }

  /* 整存状态：三个字段一起写，避免一处改动抹掉另一处。
     所以下面那些只传 {bg, wallpaper} 的老调用点不必改——llmCurrent 自动补上 */
  function save(state) {
    try {
      localStorage.setItem(App.Config.settingsKey, JSON.stringify({
        bg: state.bg, wallpaper: state.wallpaper,
        llm: state.llm !== undefined ? state.llm : llmCurrent
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
    llm: llmCurrent,

    init: function () {
      var s = load();
      this.bg = s.bg;
      this.wallpaper = s.wallpaper;
      this.llm = s.llm;
      llmCurrent = s.llm;
      this.buildPicker();
      this.applyToStage();
      this.applyWallpaper();
      this.bindUI();
      this.syncLlmUI();
    },

    /* ---- 本地大模型 ---- */

    /* 面板/开关的唯一落盘入口。over 用于覆盖单项（如顶部下拉换模型）。
       落盘后交给 App.LLM.applyConfig，由它决定要不要重新探活 */
    saveLlm: function (over) {
      var v = readLlmPanel();
      if (over) {
        for (var k in over) {
          if (over.hasOwnProperty(k)) v[k] = over[k];
        }
      }
      v = sanitizeLlm(v);
      llmCurrent = v;
      this.llm = v;
      if (!save({ bg: this.bg, wallpaper: this.wallpaper, llm: v })) {
        App.Output.error('本地模型设置保存失败，浏览器存储空间可能已满。');
      }
      if (App.LLM) App.LLM.applyConfig(v);
      this.syncLlmUI();
      return v;
    },

    /* 顶部开关：翻转 enabled。真正的落盘与探活都在 saveLlm/applyConfig 里，
       这里只负责文案与提示 */
    toggleLlm: function () {
      var on = !(App.LLM && App.LLM.isEnabled());
      if (App.LLM) App.LLM.setEnabled(on);        // 内部会回调 saveLlm -> applyConfig
      else this.saveLlm({ enabled: on });

      this.syncLlmUI();
      App.Output.system(on
        ? '本地模型已开启，正在检测连接…'
        : '本地模型已关闭，回到离线模式。');
      App.Bubble.say(on ? '本地模型开啦～' : '模型关掉了', { ms: 2500 });
    },

    recheckLlm: function () {
      if (!App.LLM) return;
      if (!App.LLM.isEnabled()) {
        App.Bubble.say('先打开「本地模型」开关哦', { ms: 3000 });
        return;
      }
      App.LLM.recheck();
    },

    /* 开关按钮 / 输入框 / 徽章与运行期状态对齐。任何入口改完配置都走这里 */
    syncLlmUI: function () {
      var cfg = currentLlm();

      var btn = document.getElementById('btn-llm');
      if (btn) {
        btn.textContent = cfg.enabled ? '本地模型：开' : '本地模型：关';
        btn.classList.toggle('on', cfg.enabled);
        btn.setAttribute('aria-pressed', cfg.enabled ? 'true' : 'false');
      }

      // 正在打字时不要回写，避免把用户输入的一半覆盖掉
      var ep = document.getElementById('llm-endpoint');
      if (ep && document.activeElement !== ep) ep.value = cfg.endpoint;

      var md = document.getElementById('llm-model');
      if (md && document.activeElement !== md) md.value = cfg.model;

      this.renderLlmStatus(App.LLM ? App.LLM.status : 'off',
        App.LLM && App.LLM.models ? App.LLM.models.length : 0,
        (App.LLM && App.LLM.models) || [], cfg.model);
    },

    /* models / model 用来查「服务器在线，但你填的模型它没有」——
       模型名现在完全靠手输，打错一个字母的话只看到绿色的「已连接」，
       直到每次提问都失败才发现，所以这个徽章必须说清楚 */
    renderLlmStatus: function (status, count, models, model) {
      var badge = document.getElementById('llm-status');
      if (!badge) return;
      var text, cls, tip = '';
      /* missing 是状态机自己判出来的（见 llm.js recheck）：端点通了但模型没装。
         不再靠这里现算 models 里有没有 model —— 那样状态还是 ok，
         canRoute 照样把消息发给不存在的模型 */
      if (status === 'missing') {
        text = '已连接，但没有 ' + model;
        cls = 'llm-status llm-status-bad';
        tip = '这个模型还没安装。在终端运行 ollama pull ' + model + '，再点「重新检测」。'
          + ((models && models.length) ? '当前已安装：' + models.join('、') + '。' : '');
      } else if (status === 'ok') {
        text = '已连接' + (count == null ? '（读不到模型列表）' : '（' + count + ' 个模型）');
        cls = 'llm-status llm-status-ok';
      } else if (status === 'checking') {
        text = '检测中…';
        cls = 'llm-status';
      } else if (status === 'unreachable') {
        text = '未连接';
        cls = 'llm-status llm-status-bad';
        tip = '连不上接口。确认 Ollama 已启动，然后点「重新检测」。';
      } else if (status === 'unknown') {
        text = '未检测';
        cls = 'llm-status llm-status-off';
      } else {
        text = '已关闭';
        cls = 'llm-status llm-status-off';
      }
      badge.className = cls;
      badge.textContent = text;

      var tipEl = document.getElementById('llm-status-tip');
      if (tipEl) {
        tipEl.textContent = tip;
        tipEl.hidden = !tip;
      }

      // 连上后把可用模型列表灌进 datalist，面板里换模型不用去命令行查
      var dl = document.getElementById('llm-models');
      if (dl && App.LLM && App.LLM.models && App.LLM.models.length) {
        dl.innerHTML = '';
        App.LLM.models.forEach(function (name) {
          var o = document.createElement('option');
          o.value = name;
          dl.appendChild(o);
        });
      }
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
      var lPicker = document.getElementById('llm-picker');
      var fileInput = document.getElementById('file-wallpaper');
      var btnBg = document.getElementById('btn-bg');
      var btnClear = document.getElementById('btn-bg-clear');
      var btnWp = document.getElementById('btn-wallpaper');
      var btnWpClear = document.getElementById('btn-wallpaper-clear');

      // 三个面板互斥：展开一个就收起其余（同为 flex-basis:100%，同时展开会挤成两行）
      function toggle(panel, others) {
        panel.hidden = !panel.hidden;
        if (panel.hidden) return;
        others.forEach(function (o) { if (o) o.hidden = true; });
      }
      if (btnBg && picker) {
        btnBg.addEventListener('click', function () { toggle(picker, [wPicker, lPicker]); });
      }
      if (btnWp && wPicker) {
        btnWp.addEventListener('click', function () { toggle(wPicker, [picker, lPicker]); });
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

      /* ---- 本地大模型 ---- */
      var btnLlm = document.getElementById('btn-llm');
      var btnLlmCfg = document.getElementById('btn-llm-config');
      var llmSave = document.getElementById('llm-save');
      var llmRecheck = document.getElementById('llm-recheck');

      if (btnLlm) {
        btnLlm.addEventListener('click', function () { self.toggleLlm(); });
      }
      if (btnLlmCfg && lPicker) {
        btnLlmCfg.addEventListener('click', function () {
          toggle(lPicker, [picker, wPicker]);
          if (!lPicker.hidden) self.syncLlmUI();     // 打开时回填端点/模型/徽章
        });
      }
      if (llmSave) {
        llmSave.addEventListener('click', function () {
          var v = self.saveLlm();
          App.Output.system('本地模型设置已保存（' + v.endpoint + '，' + v.model + '）。');
        });
      }
      if (llmRecheck) {
        llmRecheck.addEventListener('click', function () { self.recheckLlm(); });
      }

      // 状态徽章跟随探活结果：checking -> ok/unreachable/off
      if (App.bus && App.bus.on) {
        App.bus.on('llm:status', function () { self.syncLlmUI(); });
      }
    }
  };
})();
