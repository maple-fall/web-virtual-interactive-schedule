/*
 * settings.js — 应用设置：舞台背景 + 界面壁纸 + 本地大模型 + 虚拟形象
 * 独立 localStorage 键，不掺进日程数据（desktop_pet_v2 在每次变更时整体重写）
 *
 * 各字段作用范围不同，互不覆盖：
 *   bg        只作用于 #stage；必须是 CSS 属性而非子元素，因为 Animation.init 会覆盖 #stage innerHTML
 *   wallpaper 作用于 body，是整窗底层壁纸；has-wallpaper class 让面板转半透明透出纹理
 *   llm       本地模型开关与端点，运行期的唯一事实源是 App.LLM.cfg，这里只负责落盘与面板
 *   character 当前形象：默认 videos/ 或 IndexedDB 里的形象包（含包列表的导入/导出/删除）
 *
 * 背景/壁纸图片不再只靠下面的硬编码清单：App.ImageLib（imageLib.js）会在
 * file:// 下用「授权 data 目录」、在 HTTP 下用本地服务器接口，自动扫描
 * data/backgrounds、data/wallpapers。下面的 PRESETS 只是随仓库分发的精选预设，
 * 动态扫描到的图片会追加到面板里。
 */
(function () {
  'use strict';
  var App = window.App;

  /* 随仓库分发的舞台背景精选。动态图片由 App.ImageLib 扫描得到，无需在这里追加 */
  var PRESETS = [
    { path: 'data/backgrounds/bg1.jpg', label: '紫色' }
  ];

  /* 界面壁纸精选。只收 data/wallpapers/ 下的图，别把 data/backgrounds/ 的舞台背景混进来——
     两者作用范围不同（见文件头注释），混放会让「换壁纸」面板里冒出背景图，用户分不清。
     用户自己放进 data/wallpapers/ 的图片会由图片库自动发现，不需要改这个数组。 */
  var WALLPAPER_PRESETS = [
    { path: 'data/wallpapers/wall1.jpg', label: '中山装·人生哲理' }
  ];

  // 压暗层：多层 background 中先列的绘制在上层，且元素背景永远绘制在自己的子元素之下
  var OVERLAY = 'linear-gradient(rgba(15,19,34,.32), rgba(15,19,34,.32)), ';
  // 壁纸比舞台铺得广，需要压暗才保证其上文字可读；但预设图本身已经很暗（亮度约 47/255），
  // 压太深就只剩一片深蓝。文字对比度主要由面板自身的 .8 不透明度兜底，这里可以给得浅一些
  var WALLPAPER_OVERLAY = 'linear-gradient(rgba(15,19,34,.35), rgba(15,19,34,.35)), ';

  var IMAGE_MAX_EDGE = 1920;                     // 导入图片最长边上限（超出等比缩小）
  var IMAGE_QUALITY = 0.8;                       // 重编码 JPEG 质量
  var MAX_DATA_URL_LEN = 6 * 1024 * 1024;        // data URL 字符数上限，防坏数据撑爆内存
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;       // 源文件大小上限，防解码爆内存
  var DATA_URL_RE = /^data:image\/(jpeg|png|webp|gif);base64,/;

  /* ---------------- 虚拟形象 ----------------
     形象包存 IndexedDB（file:// 下不能写 videos/ 目录），这里只管当前选择与面板。
     zip 解析/打包在 character/packZip.js，存储 CRUD 在 character/packStore.js */
  var MAX_CHAR_FILE_BYTES = 10 * 1024 * 1024;    // 单个状态视频上限
  var MAX_CHAR_TOTAL_BYTES = 50 * 1024 * 1024;   // 一个形象包解压后总大小上限
  var MAX_CHAR_ZIP_BYTES = 60 * 1024 * 1024;     // zip 本体上限
  var CHAR_STATES = ['idle', 'studying', 'working', 'alert', 'done', 'refuse', 'talking'];

  /* 首次打开（没有存过选择）时的形象：内置登记表里标了 isDefault 的那一项 */
  function defaultCharacter() {
    if (App.Builtin && App.Builtin.defaultEntry) {
      var entry = App.Builtin.defaultEntry();
      if (entry) return { mode: 'builtin', id: entry.id };
    }
    return { mode: 'default', id: null };
  }

  var charCurrent = defaultCharacter();

  /* 只验形状；pack 的 id 在 IndexedDB 里是否真的存在由 restoreCharacter 异步修复 */
  function sanitizeCharacter(v) {
    var o = (v && typeof v === 'object') ? v : {};
    if (o.mode === 'pack' && typeof o.id === 'string' && o.id) {
      return { mode: 'pack', id: o.id };
    }
    if (o.mode === 'default') return { mode: 'default', id: null };
    if (o.mode === 'builtin' && typeof o.id === 'string' && o.id &&
        App.Builtin && App.Builtin.byId && App.Builtin.byId(o.id)) {
      return { mode: 'builtin', id: o.id };
    }
    return defaultCharacter();
  }

  function formatCharSize(bytes) {
    if (!bytes) return '0 KB';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  /* 校验背景/壁纸值：预设路径、图片库扫描到的动态路径，或位图 data URL。
     动态路径由 imageLib.js 的 isImagePath 校验（目录、扩展名、防穿越），
     folder 参数保证背景/壁纸不会串目录；模块没加载时自动退回预设白名单。
     不在允许范围的一律视为未设置 */
  function sanitizeImageChoice(v, presets, folder) {
    if (typeof v !== 'string' || !v) return null;
    if (v.indexOf('data:image/') === 0) {
      if (!DATA_URL_RE.test(v) || v.length > MAX_DATA_URL_LEN) return null;
      return v;
    }
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].path === v) return v;
    }
    if (App.ImageLib && App.ImageLib.isImagePath && App.ImageLib.isImagePath(v, folder)) {
      return v;
    }
    return null;
  }

  function sanitizeBg(v) {
    return sanitizeImageChoice(v, PRESETS, 'backgrounds');
  }

  function sanitizeWallpaper(v) {
    return sanitizeImageChoice(v, WALLPAPER_PRESETS, 'wallpapers');
  }

  /* 设置里存原始路径；写进 CSS 前才逐段编码，避免中文/空格/# 把 url() 截断 */
  function imageCssUrl(v) {
    if (!v) return '';
    if (v.indexOf('data:image/') === 0) return v;
    if (App.ImageLib && App.ImageLib.encodePath) return App.ImageLib.encodePath(v);
    return v;
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
    var empty = {
      bg: null, wallpaper: null, llm: sanitizeLlm(null),
      character: sanitizeCharacter(null)
    };
    try {
      var raw = localStorage.getItem(App.Config.settingsKey);
      if (!raw) return empty;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return empty;
      return {
        bg: sanitizeBg(data.bg),
        wallpaper: sanitizeWallpaper(data.wallpaper),
        llm: sanitizeLlm(data.llm),     // 被篡改成公网地址时在这里回落到默认端点
        character: sanitizeCharacter(data.character)
      };
    } catch (e) {
      return empty;
    }
  }

  /* 整存状态：各字段一起写，避免一处改动抹掉另一处。
     所以下面那些只传 {bg, wallpaper} 的老调用点不必改——llmCurrent / charCurrent 自动补上 */
  function save(state) {
    try {
      localStorage.setItem(App.Config.settingsKey, JSON.stringify({
        bg: state.bg, wallpaper: state.wallpaper,
        llm: state.llm !== undefined ? state.llm : llmCurrent,
        character: state.character !== undefined ? sanitizeCharacter(state.character) : charCurrent
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
    character: charCurrent,
    _charSwitchSeq: 0,

    init: function () {
      var s = load();
      this.bg = s.bg;
      this.wallpaper = s.wallpaper;
      this.llm = s.llm;
      llmCurrent = s.llm;
      this.character = s.character;
      charCurrent = s.character;
      this.buildPicker();
      this.applyToStage();
      this.applyWallpaper();
      this.bindUI();
      this.syncLlmUI();
      // 图片库异步探测：服务器 / 目录授权 / 不可用。不阻塞启动
      this.initImageLib();
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
        stage.style.backgroundImage = OVERLAY + 'url("' + imageCssUrl(this.bg) + '")';
        stage.classList.add('has-bg');
      } else {
        stage.style.backgroundImage = '';
        stage.classList.remove('has-bg');
      }

      var clearBtn = document.getElementById('btn-bg-clear');
      if (clearBtn) clearBtn.hidden = !this.bg;

      // 重建而不仅是同步选中态：导入的 data URL 缩略图只在面板展开时按需生成
      this.buildPicker();
      // 画中画开着时不用额外通知：搬过去的正是 #stage 本身，inline 背景就地生效
    },

    /* 壁纸铺满整窗：cover + 居中 + fixed（滚动时钉在视口上，同桌面壁纸） */
    applyWallpaper: function () {
      var body = document.body;
      if (!body) return;
      var st = body.style;

      if (this.wallpaper) {
        body.classList.add('has-wallpaper');
        st.backgroundImage = WALLPAPER_OVERLAY + 'url("' + imageCssUrl(this.wallpaper) + '")';
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
      // 预设和图片库扫描到的动态路径都允许；越界/跨目录路径会被 sanitizeBg 拒绝
      if (sanitizeBg(path) !== path) return;
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

    /* 导入本地图片的统一流程：读成 data URL → 等比缩到最长边 ≤IMAGE_MAX_EDGE → JPEG。
       用 data URL 作画源不会被判跨源，canvas 不会被污染（本地文件路径则会）。
       onReady(dataUrl, fail)：调用方负责保存与应用；保存失败时调 fail(标题, 气泡文案) */
    _importImageFile: function (file, onReady) {
      if (!file) return;                                   // 用户取消选择

      function fail(msg, tip) {
        App.Output.error(msg);
        App.Bubble.say(tip, { ms: 3500 });
      }

      if (file.type && file.type.indexOf('image/') !== 0) {
        fail('这个文件不是图片。', '要选图片文件哦');
        return;
      }
      if (file.size > MAX_IMPORT_BYTES) {
        fail('图片太大了（超过 ' + (MAX_IMPORT_BYTES / 1024 / 1024) + 'MB），换一张吧。',
          '图片太大，换一张试试');
        return;
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

          var scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h));   // 只缩不放
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
            dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
          } catch (e) { /* 理论不可达：data URL 图源不污染画布 */ }
          if (!dataUrl || dataUrl.indexOf('data:image/jpeg') !== 0 ||
              dataUrl.length > MAX_DATA_URL_LEN) {
            fail('图片处理失败，换一张小一点的试试。', '这张图没处理成功，换张试试');
            return;
          }
          onReady(dataUrl, fail);
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    },

    importBg: function (file) {
      var self = this;
      this._importImageFile(file, function (dataUrl, fail) {
        self._storeImportedImage('backgrounds', 'bg', dataUrl, file, fail);
      });
    },

    importWallpaper: function (file) {
      var self = this;
      this._importImageFile(file, function (dataUrl, fail) {
        self._storeImportedImage('wallpapers', 'wallpaper', dataUrl, file, fail);
      });
    },

    /* 导入结果落盘：图片库可写就写进对应文件夹，否则退回浏览器存储。
       两条路都保留「已压缩到最长边」的反馈，让用户知道原图没动。 */
    _storeImportedImage: function (folder, key, dataUrl, file, fail) {
      var self = this;
      var isBg = key === 'bg';
      var label = isBg ? '舞台背景' : '界面壁纸';
      var short = isBg ? '背景' : '壁纸';
      var bubble = isBg ? '背景换好啦～' : '壁纸换好啦～';

      function applyValue(value) {
        // save() 是整存接口：只传一个键会把另一个键写成 undefined
        var patch = isBg
          ? { bg: value, wallpaper: self.wallpaper }
          : { bg: self.bg, wallpaper: value };
        if (!save(patch)) {
          fail(label + '保存失败，浏览器存储空间可能已满。', short + '存不上，换张小图试试');
          return false;
        }
        self[key] = value;
        if (isBg) self.applyToStage(); else self.applyWallpaper();
        return true;
      }

      function fallback(prefix) {
        if (!applyValue(dataUrl)) return;
        App.Output.system(label + '已更新（已压缩到最长边 ' + IMAGE_MAX_EDGE + 'px 内）。' +
          (prefix ? ' ' + prefix : ''));
        if (prefix) {
          App.Output.system('提示：图片目前只存在浏览器里；授权 data 目录后会自动迁移到文件夹。');
        }
        App.Bubble.say(bubble, { ms: 2500 });
      }

      var status = (App.ImageLib && App.ImageLib.getStatus) ? App.ImageLib.getStatus() : null;
      if (!status || !status.canWrite || !App.ImageLib.save) {
        var hint = '';
        if (status && status.mode === 'none') {
          hint = '当前打开方式不能写文件夹，可点面板里的「授权 data 目录」或运行 npm run serve。';
        } else if (status && status.mode === 'fsa') {
          hint = '目录还没授权：点面板里的「授权 data 目录」后再导入，就能直接写入文件夹。';
        } else if (status && status.mode === 'server') {
          hint = '图片服务暂时不可用：确认 npm run serve 还在运行。';
        }
        fallback(hint);
        return;
      }

      App.ImageLib.save(folder, dataUrl, { name: file && file.name }).then(function (res) {
        if (!res || !res.ok) {
          fallback('写入文件夹失败：' + ((res && res.error) || '未知错误'));
          return;
        }
        if (!applyValue(res.path)) return;
        self.buildPicker();
        self.buildWallpaperPicker();
        App.Output.system(label + '已更新并保存到 ' + res.path +
          '（已压缩到最长边 ' + IMAGE_MAX_EDGE + 'px 内）。');
        App.Bubble.say(bubble, { ms: 2500 });
      }, function (e) {
        fallback('写入文件夹失败：' + (e && e.message ? e.message : e));
      });
    },

    /* 两个面板结构一致：提示 → 无 → 精选预设 → 图片库动态图片 → 当前自定义 → 导入按钮 */
    _buildImagePicker: function (picker, folder, tipText, presets, current) {
      if (!picker) return;

      var frag = document.createDocumentFragment();
      var tip = document.createElement('span');
      tip.className = 'bg-picker-tip';
      tip.textContent = tipText;
      frag.appendChild(tip);

      var none = document.createElement('button');
      none.type = 'button';
      none.className = 'bg-none';
      none.dataset.path = '';
      none.textContent = '无';
      frag.appendChild(none);

      var seen = Object.create(null);

      function addThumb(path, label) {
        if (!path || seen[path]) return;
        seen[path] = true;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bg-thumb';
        btn.dataset.path = path;
        btn.title = label || path;
        btn.style.backgroundImage = 'url("' + imageCssUrl(path) + '")';
        frag.appendChild(btn);
      }

      var dynamic = (App.ImageLib && App.ImageLib.list) ? App.ImageLib.list(folder) : [];
      var dynamicPaths = Object.create(null);
      dynamic.forEach(function (it) { dynamicPaths[it.path] = true; });

      // 扫描成功时以目录为准：预设文件如果不在授权目录里就不显示，避免破图
      var scanReady = !!(App.ImageLib && App.ImageLib.getStatus &&
        App.ImageLib.getStatus().state === 'ready');
      presets.forEach(function (p) {
        if (scanReady && !dynamicPaths[p.path]) return;
        addThumb(p.path, p.label || p.path);
      });

      dynamic.forEach(function (it) {
        addThumb(it.path, it.label || it.name);
      });

      // 当前选择不在预设/扫描结果里（例如目录权限尚未恢复）：仍给一个可点的缩略图
      if (current && current.indexOf('data:image/') !== 0 && !seen[current]) {
        var name = current.split('/').pop();
        var label = (App.ImageLib && App.ImageLib.labelOf)
          ? App.ImageLib.labelOf(name)
          : name;
        addThumb(current, '当前选择：' + label);
      }

      // 当前是导入的 data URL：只读缩略图。刻意不给 data-path：
      // 委托查找会跳过它，也避免把巨长的 base64 写进 DOM 属性
      if (current && current.indexOf('data:image/') === 0) {
        var cur = document.createElement('span');
        cur.className = 'bg-thumb selected';
        cur.title = folder === 'backgrounds' ? '当前自定义背景' : '当前自定义壁纸';
        cur.style.backgroundImage = 'url("' + current + '")';
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
      // 状态行是第二个子节点：没有加载 imageLib.js 时完全不生成，保持旧结构
      this._appendImageLibStatus(picker, folder);
      if (folder === 'backgrounds') this.syncPickerSelection(picker);
      else this.syncWallpaperPickerSelection(picker);
    },

    /* 图片库状态 + 授权/刷新按钮。只在 App.ImageLib 存在时生成 */
    _appendImageLibStatus: function (picker, folder) {
      if (!App.ImageLib || !App.ImageLib.getStatus) return;
      var st = App.ImageLib.getStatus(folder);
      var row = document.createElement('div');
      row.className = 'image-lib-status';

      var msg = document.createElement('span');
      msg.className = 'image-lib-msg' +
        (st.tone === 'ok' ? ' lib-ok' : (st.tone === 'bad' ? ' lib-bad' : ''));
      msg.textContent = st.message;
      row.appendChild(msg);

      if (st.canAuthorize) {
        var auth = document.createElement('button');
        auth.type = 'button';
        auth.className = 'image-lib-btn';
        auth.dataset.libAction = 'authorize';
        auth.textContent = st.mode === 'server' ? '重试'
          : (st.state === 'needs-authorize' ? '授权 data 目录…' : '重新授权');
        row.appendChild(auth);
      }
      if (st.canRefresh) {
        var ref = document.createElement('button');
        ref.type = 'button';
        ref.className = 'image-lib-btn';
        ref.dataset.libAction = 'refresh';
        ref.textContent = '刷新';
        ref.title = '重新扫描图片文件夹';
        row.appendChild(ref);
      }
      picker.appendChild(row);
    },

    buildPicker: function () {
      this._buildImagePicker(document.getElementById('bg-picker'),
        'backgrounds', '选择舞台背景：', PRESETS, this.bg);
    },

    syncPickerSelection: function (picker) {
      var current = this.bg || '';
      var btns = picker.querySelectorAll('[data-path]');
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].dataset.path === current;
        btns[i].classList.toggle('selected', on);
      }
    },

    buildWallpaperPicker: function () {
      this._buildImagePicker(document.getElementById('wallpaper-picker'),
        'wallpapers', '选择界面壁纸：', WALLPAPER_PRESETS, this.wallpaper);
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

    /* ---------------- 图片库（App.ImageLib，见 imageLib.js） ---------------- */

    /* 启动时异步探测：服务器 / 目录授权 / 不可用。不阻塞首屏，也不主动弹授权框 */
    initImageLib: function () {
      var self = this;
      if (!App.ImageLib || this._imageLibBound) return;
      this._imageLibBound = true;

      if (App.bus && App.bus.on) {
        App.bus.on('imagelib:changed', function () {
          self.buildPicker();
          self.buildWallpaperPicker();
        });
      }

      App.ImageLib.init().then(function () {
        self.reconcileImageSelections();
        self.buildPicker();
        self.buildWallpaperPicker();
        self._migrateLegacyImages();
      }).catch(function (e) {
        console.warn('[Settings] 图片库初始化失败', e);
      });
    },

    /* 面板里「授权 / 重新授权 / 刷新」按钮的统一入口 */
    handleImageLibAction: function (action) {
      var self = this;
      if (!App.ImageLib) return;

      if (action === 'authorize') {
        App.Output.system('正在申请图片目录权限；如果弹出选择框，请选 desktop-pet/data 文件夹。');
        App.ImageLib.authorize().then(function (ok) {
          if (ok) {
            App.Output.system('图片目录授权成功，正在同步…');
            self.reconcileImageSelections();
            self.buildPicker();
            self.buildWallpaperPicker();
            self._migrateLegacyImages();
          } else {
            var st = App.ImageLib.getStatus();
            App.Output.error('目录授权没有完成：' + (st.lastError || '已取消'));
            self.buildPicker();
            self.buildWallpaperPicker();
          }
        });
        return;
      }

      if (action === 'refresh') {
        App.ImageLib.refresh().then(function (r) {
          self.reconcileImageSelections();
          self.buildPicker();
          self.buildWallpaperPicker();
          if (r && r.ok) {
            App.Output.system('图片目录已刷新。');
            return;
          }
          var why = (r && r.error) || '未知错误';
          if (why === 'needs-permission' || why === 'prompt') {
            why = '目录授权已过期，请点「重新授权」';
          } else if (why === 'needs-authorize') {
            why = '还没有授权 data 目录';
          } else if (why === 'unsupported') {
            why = '当前打开方式不支持图片目录';
          }
          App.Output.error('刷新图片目录失败：' + why);
        });
      }
    },

    /* 展开面板时顺便重扫一次，手动拖进文件夹的图不用重启应用 */
    refreshImageLibOnOpen: function () {
      var self = this;
      if (!App.ImageLib || !App.ImageLib.getStatus) return;
      var st = App.ImageLib.getStatus();
      if (!st.canRefresh) return;
      App.ImageLib.refresh().then(function () {
        self.reconcileImageSelections();
        self.buildPicker();
        self.buildWallpaperPicker();
      });
    },

    /* 授权成功/扫描成功后，清掉已经不在目录里的选择；扫描失败时绝不清理 */
    reconcileImageSelections: function () {
      if (!App.ImageLib || !App.ImageLib.getStatus) return;
      var st = App.ImageLib.getStatus();
      if (st.mode === 'none' || st.state !== 'ready') return;

      var changed = false;
      var self = this;

      function check(folder, value) {
        if (!value || value.indexOf('data:image/') === 0) return value;
        if (!App.ImageLib.isImagePath(value, folder)) return value;   // 精选预设/未知值不在这里处理
        var exists = App.ImageLib.list(folder).some(function (it) {
          return it.path === value;
        });
        if (exists) return value;
        changed = true;
        return null;
      }

      var bg = check('backgrounds', this.bg);
      var wp = check('wallpapers', this.wallpaper);
      if (!changed) return;
      if (!save({ bg: bg, wallpaper: wp })) return;

      this.bg = bg;
      this.wallpaper = wp;
      this.applyToStage();
      this.applyWallpaper();
      App.Output.system('原来选择的图片文件已不存在，已恢复为无背景/无壁纸。');
    },

    /* 目录可写后，把历史上存成 data URL 的背景/壁纸迁移成文件夹里的文件 */
    _migrateLegacyImages: function () {
      if (!App.ImageLib || !App.ImageLib.getStatus || !App.ImageLib.save) return;
      var st = App.ImageLib.getStatus();
      if (!st.canWrite) return;
      var self = this;

      function migrate(folder, key, value) {
        if (!value || value.indexOf('data:image/') !== 0) return;
        if (self['_migrating_' + key]) return;
        self['_migrating_' + key] = true;

        App.ImageLib.save(folder, value, {
          name: key === 'bg' ? 'background.jpg' : 'wallpaper.jpg'
        }).then(function (res) {
          // 迁移期间用户可能又换了图，别覆盖新选择
          if (!res || !res.ok || self[key] !== value) return;
          var patch = key === 'bg'
            ? { bg: res.path, wallpaper: self.wallpaper }
            : { bg: self.bg, wallpaper: res.path };
          if (!save(patch)) return;
          self[key] = res.path;
          if (key === 'bg') self.applyToStage(); else self.applyWallpaper();
          self.buildPicker();
          self.buildWallpaperPicker();
          App.Output.system('已把当前自定义' + (key === 'bg' ? '背景' : '壁纸') +
            '保存到 ' + res.path + '。');
        }).catch(function () {
          // 迁移失败不打扰用户，保留 data URL
        }).then(function () {
          self['_migrating_' + key] = false;
        });
      }

      migrate('backgrounds', 'bg', this.bg);
      migrate('wallpapers', 'wallpaper', this.wallpaper);
    },

    /* ---------------- 虚拟形象 ---------------- */

    /* 启动时恢复上次选择的形象。内置形象直接读 videos/ 目录，形象包异步读 IndexedDB */
    restoreCharacter: function () {
      var self = this;
      var cur = this.character;
      if (!cur) return;

      if (cur.mode === 'builtin') {
        var entry = App.Builtin && App.Builtin.byId ? App.Builtin.byId(cur.id) : null;
        if (!entry) {
          // 内置形象被从登记表移除：修盘回落到默认形象
          console.info('[Settings] 内置形象已不存在，回落到默认形象');
          self._fallbackCharacter();
          return;
        }
        if (App.Animation) App.Animation.setCharacter(App.Builtin.toPack(entry));
        self.syncCharacterUI();
        if (App.bus && App.bus.emit) App.bus.emit('character:changed', cur);
        return;
      }

      // 旧记录里的 mode:'default'（videos/ 根目录）统一迁到内置默认形象
      if (cur.mode === 'default') {
        var d = defaultCharacter();
        if (d.mode === 'builtin') self._fallbackCharacter();
        return;
      }

      if (!cur.id || !App.PackStore) return;
      App.PackStore.get(cur.id).then(function (pack) {
        if (!pack) {
          // 记录还在但包没了（清过站点数据/被其它标签页删掉）：修盘回落到默认形象
          console.info('[Settings] 上次的形象包已不存在，回落到默认形象');
          self._fallbackCharacter();
          return;
        }
        if (App.Animation) App.Animation.setCharacter(pack);
        self.syncCharacterUI();
        if (App.bus && App.bus.emit) App.bus.emit('character:changed', cur);
      }).catch(function (e) {
        console.warn('[Settings] 恢复形象包失败', e);
      });
    },

    /* 形象包丢失/删除后的统一回落：优先内置默认形象，其次 videos/ 根目录 */
    _fallbackCharacter: function () {
      var v = defaultCharacter();
      this.saveCharacter(v);
      if (App.Animation) {
        if (v.mode === 'builtin' && App.Builtin && App.Builtin.byId) {
          var entry = App.Builtin.byId(v.id);
          App.Animation.setCharacter(entry ? App.Builtin.toPack(entry) : null);
        } else {
          App.Animation.setCharacter(null);
        }
      }
      return v;
    },

    /* 形象选择的唯一落盘入口 */
    saveCharacter: function (choice) {
      var v = sanitizeCharacter(choice);
      charCurrent = v;
      this.character = v;
      if (!save({ bg: this.bg, wallpaper: this.wallpaper, llm: currentLlm(), character: v })) {
        App.Output.error('形象设置保存失败，浏览器存储空间可能已满。');
      }
      this.syncCharacterUI();
      return v;
    },

    syncCharacterUI: function () {
      var picker = document.getElementById('char-picker');
      if (!picker) return;
      var cur = this.character || charCurrent;
      var rows = picker.querySelectorAll('.char-row');
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i].dataset.char || '';
        var kind = rows[i].dataset.kind || '';
        var on;
        if (!id) on = cur.mode === 'default';
        else if (kind === 'builtin') on = cur.mode === 'builtin' && cur.id === id;
        else on = cur.mode === 'pack' && cur.id === id;
        var item = rows[i].querySelector('.char-item');
        if (item) item.classList.toggle('selected', on);
      }
      var exp = picker.querySelector('[data-action="export"]');
      if (exp) {
        var can = cur.mode === 'pack' && !!cur.id;
        exp.disabled = !can;
        exp.title = can ? ''
          : (cur.mode === 'builtin'
            ? '内置形象已随 videos/ 提供，无需导出；导入的 zip 形象可以导出'
            : '默认形象在 videos/ 目录里，请用 tools/video/char_pack.py pack 打包导出');
      }
    },

    /* 全 DOM 构建，不拼 HTML；列表内容异步填充 */
    buildCharacterPicker: function () {
      var picker = document.getElementById('char-picker');
      if (!picker) return;

      var frag = document.createDocumentFragment();
      var tip = document.createElement('span');
      tip.className = 'bg-picker-tip';
      tip.textContent = '选择形象：';
      frag.appendChild(tip);

      var list = document.createElement('div');
      list.className = 'char-list';
      frag.appendChild(list);

      var actions = document.createElement('div');
      actions.className = 'char-actions';
      var imp = document.createElement('button');
      imp.type = 'button';
      imp.className = 'bg-import';
      imp.dataset.action = 'import';
      imp.textContent = '导入形象包（.zip）…';
      actions.appendChild(imp);

      var exp = document.createElement('button');
      exp.type = 'button';
      exp.className = 'bg-import';
      exp.dataset.action = 'export';
      exp.textContent = '导出当前形象';
      actions.appendChild(exp);
      frag.appendChild(actions);

      var note = document.createElement('div');
      note.className = 'llm-note';
      note.textContent = '内置形象直接读 videos/ 下的目录；导入的 zip 存在浏览器本地' +
        '（IndexedDB），不会写入 videos/ 目录。';
      frag.appendChild(note);

      picker.innerHTML = '';
      picker.appendChild(frag);
      this._fillCharacterList(list);
    },

    _fillCharacterList: function (list) {
      var self = this;
      var cur = this.character || charCurrent;

      // 内置形象（videos/ 下的目录，无需导入）
      var builtins = (App.Builtin && App.Builtin.list) || [];
      for (var b = 0; b < builtins.length; b++) {
        list.appendChild(this._charRowBuiltin(builtins[b], cur));
      }

      if (!App.PackStore) {
        var note = document.createElement('div');
        note.className = 'llm-note';
        note.textContent = '当前浏览器不支持 IndexedDB，无法保存形象包。';
        list.appendChild(note);
        this.syncCharacterUI();
        return;
      }

      App.PackStore.getAll().then(function (packs) {
        packs.forEach(function (pack) {
          list.appendChild(self._charRow(pack, cur));
        });
        // 记录里的包已被删（其它标签页/清站点数据）：就地修复
        if (cur.mode === 'pack' && !packs.some(function (p) { return p.id === cur.id; })) {
          self._fallbackCharacter();
        }
        self.syncCharacterUI();
      }).catch(function (e) {
        App.Output.error('读取形象包失败：' + (e && e.message ? e.message : e));
      });
    },

    /* 内置形象行：不能删除，导出按钮也不适用（文件本来就在 videos/） */
    _charRowBuiltin: function (entry, cur) {
      var row = document.createElement('div');
      row.className = 'char-row';
      row.dataset.kind = 'builtin';
      row.dataset.char = entry.id;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'char-item';
      btn.dataset.action = 'switch';
      btn.dataset.kind = 'builtin';
      btn.dataset.char = entry.id;

      var name = document.createElement('span');
      name.className = 'char-name';
      name.textContent = entry.name;
      btn.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'char-meta';
      meta.textContent = '内置形象 · ' + entry.dir;
      btn.appendChild(meta);

      if (cur.mode === 'builtin' && cur.id === entry.id) btn.classList.add('selected');
      row.appendChild(btn);
      return row;
    },

    _charRow: function (pack, cur) {
      var row = document.createElement('div');
      row.className = 'char-row';
      row.dataset.char = pack ? pack.id : '';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'char-item';
      btn.dataset.action = 'switch';
      btn.dataset.char = pack ? pack.id : '';

      var name = document.createElement('span');
      name.className = 'char-name';
      name.textContent = pack ? pack.name : '默认素材（videos/ 根目录）';
      btn.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'char-meta';
      if (pack) {
        var have = 0;
        var missing = [];
        for (var i = 0; i < CHAR_STATES.length; i++) {
          if (pack.files && pack.files[CHAR_STATES[i]]) have++;
          else missing.push(CHAR_STATES[i]);
        }
        var bits = [have + '/' + CHAR_STATES.length + ' 状态'];
        if (pack.totalBytes) bits.push(formatCharSize(pack.totalBytes));
        if (pack.author) bits.push(pack.author);
        meta.textContent = bits.join(' · ');
        if (missing.length) {
          meta.textContent += ' · 缺 ' + missing.join('/');
          meta.title = '缺少的状态会用 idle 顶替';
        }
      } else {
        meta.textContent = '内置素材 · 可用 char_pack.py 打包';
      }
      btn.appendChild(meta);

      if ((pack && cur.mode === 'pack' && cur.id === pack.id) ||
          (!pack && cur.mode === 'default')) {
        btn.classList.add('selected');
      }
      row.appendChild(btn);

      if (pack) {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'char-del';
        del.dataset.action = 'delete';
        del.dataset.char = pack.id;
        del.dataset.name = pack.name || '';
        del.title = '删除这个形象包';
        del.textContent = '✕';
        row.appendChild(del);
      }
      return row;
    },

    switchCharacter: function (choice) {
      var self = this;
      var v = sanitizeCharacter(choice);

      if (v.mode === 'builtin') {
        this._charSwitchSeq++;          // 丢弃可能在途的形象包异步切换
        var entry = App.Builtin && App.Builtin.byId ? App.Builtin.byId(v.id) : null;
        if (!entry) {
          this._fallbackCharacter();
          return;
        }
        this.saveCharacter(v);
        if (App.Animation) App.Animation.setCharacter(App.Builtin.toPack(entry));
        App.Output.system('已切换到内置形象「' + entry.name + '」。');
        return;
      }

      if (v.mode !== 'pack') {
        this._charSwitchSeq++;
        this._fallbackCharacter();
        return;
      }
      if (!App.PackStore || !v.id) return;

      var seq = ++this._charSwitchSeq;   // 连点多个包时只认最后一次
      App.PackStore.get(v.id).then(function (pack) {
        if (seq !== self._charSwitchSeq) return;
        if (!pack) {
          console.info('[Settings] 要切换的形象包不存在，回落到默认形象');
          self._fallbackCharacter();
          self.buildCharacterPicker();
          return;
        }
        self.saveCharacter(v);
        if (App.Animation) App.Animation.setCharacter(pack);
        self.syncCharacterUI();
        App.Output.system('已切换到形象「' + pack.name + '」。');
      }).catch(function (e) {
        App.Output.error('切换形象失败：' + (e && e.message ? e.message : e));
      });
    },

    /* 读 zip -> 宽松校验 -> 视频探针预检 -> 入库 -> 自动切换 */
    importCharacterPack: function (file) {
      var self = this;
      if (!file) return;

      function fail(msg, tip) {
        App.Output.error(msg);
        if (App.Bubble) App.Bubble.say(tip || '形象包没导入成功', { ms: 3500 });
      }

      if (!App.PackZip || !App.PackStore) {
        fail('形象包功能未加载（缺少 packZip.js / packStore.js）。');
        return;
      }
      if (!/\.zip$/i.test(file.name || '')) {
        fail('请选择 .zip 形象包。', '要选 .zip 文件哦');
        return;
      }
      if (file.size > MAX_CHAR_ZIP_BYTES) {
        fail('zip 太大了（超过 ' + (MAX_CHAR_ZIP_BYTES / 1024 / 1024) + 'MB）。');
        return;
      }
      App.Output.system('正在读取形象包…');

      var reader = new FileReader();
      reader.onerror = function () { fail('形象包读取失败，文件可能无法访问。'); };
      reader.onload = function () {
        App.PackZip.packFromZip(reader.result, {
          zipName: file.name,
          maxFileBytes: MAX_CHAR_FILE_BYTES,
          maxTotalBytes: MAX_CHAR_TOTAL_BYTES,
          maxZipBytes: MAX_CHAR_ZIP_BYTES
        }).then(function (res) {
          if (!res || !res.ok) {
            ((res && res.warnings) || []).forEach(function (w) {
              App.Output.system('形象包：' + w);
            });
            fail('导入失败：' + ((res && res.message) || '未知错误'));
            return;
          }
          var warnings = res.warnings || [];
          warnings.forEach(function (w) { App.Output.system('形象包：' + w); });

          self._probePackVideos(res.pack).then(function (alive) {
            if (!alive) {
              fail('形象包里的视频都无法播放，请确认是 WebM/MP4（建议 VP9-alpha WebM）。');
              return;
            }
            App.PackStore.put(res.pack).then(function () {
              self.saveCharacter({ mode: 'pack', id: res.pack.id });
              if (App.Animation) App.Animation.setCharacter(res.pack);
              self.buildCharacterPicker();
              App.Output.system('已导入并切换到「' + res.pack.name + '」' +
                (warnings.length ? '（' + warnings.length + ' 条提示）' : '') + '。');
              if (App.Bubble) App.Bubble.say('新形象上线啦～', { ms: 2500 });
            }).catch(function (e) {
              if (e && e.name === 'QuotaExceededError') {
                fail('浏览器存储空间不足，先删掉旧形象包再试。');
              } else {
                fail('形象包保存失败：' + (e && e.message ? e.message : e));
              }
            });
          });
        }).catch(function (e) {
          fail('导入失败：' + (e && e.message ? e.message : e));
        });
      };
      reader.readAsArrayBuffer(file);
    },

    /* 并行探针；播不出来的状态直接丢弃，全挂才拒收 */
    _probePackVideos: function (pack) {
      var self = this;
      var states = [];
      for (var state in pack.files) {
        if (Object.prototype.hasOwnProperty.call(pack.files, state)) states.push(state);
      }
      return Promise.all(states.map(function (state) {
        return self._probeVideoBlob(pack.files[state].blob).then(function (ok) {
          if (!ok) {
            App.Output.system('形象包：' + state + ' 视频无法播放，已丢弃');
            delete pack.files[state];
          }
          return ok;
        });
      })).then(function (results) {
        var any = false;
        for (var i = 0; i < results.length; i++) {
          if (results[i]) any = true;
        }
        if (any && App.PackStore) pack.totalBytes = App.PackStore.totalBytes(pack);
        return any;
      });
    },

    _probeVideoBlob: function (blob) {
      return new Promise(function (resolve) {
        var url;
        try { url = URL.createObjectURL(blob); } catch (e) { resolve(false); return; }
        var video = document.createElement('video');
        var done = false;
        var timer = setTimeout(function () { finish(false); }, 4000);

        function finish(ok) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { video.removeAttribute('src'); } catch (e) {}
          try { URL.revokeObjectURL(url); } catch (e2) {}
          resolve(ok);
        }

        video.muted = true;
        video.preload = 'metadata';
        video.addEventListener('loadedmetadata', function () { finish(true); });
        video.addEventListener('error', function () { finish(false); });
        try { video.src = url; } catch (e) { finish(false); }
      });
    },

    exportCharacter: function () {
      var self = this;
      var cur = this.character;
      if (!App.PackZip || !App.PackStore) return;
      if (!cur || cur.mode !== 'pack' || !cur.id) {
        App.Output.system('默认形象在 videos/ 目录里，请用 tools/video/char_pack.py pack 打包导出。');
        return;
      }

      var packRef = null;
      App.PackStore.get(cur.id).then(function (pack) {
        if (!pack) { App.Output.error('形象包记录不存在，无法导出。'); return null; }
        packRef = pack;
        return App.PackZip.buildZip(pack.files, {
          name: pack.name,
          author: pack.author || '',
          version: pack.version || '1.0',
          note: pack.note || '',
          created: (App.Clock && App.Clock.today) ? App.Clock.today() : ''
        });
      }).then(function (blob) {
        if (!blob || !packRef) return;
        var safe = String(packRef.name || '形象包').replace(/[\\/:*?"<>|]/g, '_').replace(/^\s+|\s+$/g, '');
        App.util.downloadBlob(blob, (safe || '形象包') + '.zip');
        App.Output.system('已导出形象包「' + packRef.name + '」。');
      }).catch(function (e) {
        App.Output.error('导出形象包失败：' + (e && e.message ? e.message : e));
      });
    },

    deleteCharacter: function (id, name) {
      var self = this;
      if (!App.PackStore || !id) return;
      if (typeof window.confirm === 'function' &&
          !window.confirm('删除形象包「' + (name || '') + '」？此操作不可撤销。')) {
        return;
      }
      App.PackStore.remove(id).then(function () {
        if (self.character && self.character.mode === 'pack' && self.character.id === id) {
          self._fallbackCharacter();
          App.Output.system('当前形象包已删除，已切回默认形象。');
        } else {
          App.Output.system('形象包已删除。');
        }
        self.buildCharacterPicker();
      }).catch(function (e) {
        App.Output.error('删除形象包失败：' + (e && e.message ? e.message : e));
      });
    },

    bindUI: function () {
      if (this._uiBound) return;
      this._uiBound = true;
      var self = this;

      var picker = document.getElementById('bg-picker');
      var wPicker = document.getElementById('wallpaper-picker');
      var lPicker = document.getElementById('llm-picker');
      var cPicker = document.getElementById('char-picker');
      var fileBg = document.getElementById('file-bg');
      var fileInput = document.getElementById('file-wallpaper');
      var fileChar = document.getElementById('file-character');
      var btnBg = document.getElementById('btn-bg');
      var btnClear = document.getElementById('btn-bg-clear');
      var btnWp = document.getElementById('btn-wallpaper');
      var btnWpClear = document.getElementById('btn-wallpaper-clear');
      var btnChar = document.getElementById('btn-char');

      // 面板互斥：展开一个就收起其余（同为 flex-basis:100%，同时展开会挤成两行）
      function toggle(panel, others) {
        panel.hidden = !panel.hidden;
        if (panel.hidden) return;
        others.forEach(function (o) { if (o) o.hidden = true; });
      }
      if (btnBg && picker) {
        btnBg.addEventListener('click', function () {
          var willOpen = picker.hidden;
          toggle(picker, [wPicker, lPicker, cPicker]);
          if (willOpen) self.refreshImageLibOnOpen();
        });
      }
      if (btnWp && wPicker) {
        btnWp.addEventListener('click', function () {
          var willOpen = wPicker.hidden;
          toggle(wPicker, [picker, lPicker, cPicker]);
          if (willOpen) self.refreshImageLibOnOpen();
        });
      }
      if (btnChar && cPicker) {
        btnChar.addEventListener('click', function () {
          var willOpen = cPicker.hidden;
          toggle(cPicker, [picker, wPicker, lPicker]);
          if (willOpen) self.buildCharacterPicker();
        });
      }

      // 事件委托：从点击目标向上找带 data-action / data-path / data-lib-action 的按钮
      if (picker) {
        picker.addEventListener('click', function (e) {
          var t = e.target;
          while (t && t !== picker && !(t.dataset &&
                 (typeof t.dataset.action === 'string' || typeof t.dataset.path === 'string' ||
                  typeof t.dataset.libAction === 'string'))) {
            t = t.parentNode;
          }
          if (!t || t === picker || !t.dataset) return;
          if (t.dataset.libAction) {
            self.handleImageLibAction(t.dataset.libAction);
            return;
          }
          if (t.dataset.action === 'import') {
            if (fileBg) fileBg.click();
            return;
          }
          var path = t.dataset.path;
          if (path) self.select(path);
          else self.clearBg();
        });
      }

      if (fileBg) {
        fileBg.addEventListener('change', function (e) {
          var f = e.target && e.target.files && e.target.files[0];
          if (f) self.importBg(f);
          // 置空，同一张图才能再次被选中；File 已被 readAsDataURL 同步持有，不受影响
          e.target.value = '';
        });
      }

      // 壁纸面板：先认 data-lib-action（授权/刷新），再认 data-action（导入），最后 data-path
      if (wPicker) {
        wPicker.addEventListener('click', function (e) {
          var t = e.target;
          while (t && t !== wPicker && !(t.dataset &&
                 (typeof t.dataset.action === 'string' || typeof t.dataset.path === 'string' ||
                  typeof t.dataset.libAction === 'string'))) {
            t = t.parentNode;
          }
          if (!t || t === wPicker || !t.dataset) return;
          if (t.dataset.libAction) {
            self.handleImageLibAction(t.dataset.libAction);
            return;
          }
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

      /* ---- 虚拟形象：切换 / 删除 / 导入 / 导出 ---- */
      if (cPicker) {
        cPicker.addEventListener('click', function (e) {
          var t = e.target;
          while (t && t !== cPicker && !(t.dataset && typeof t.dataset.action === 'string')) {
            t = t.parentNode;
          }
          if (!t || t === cPicker || !t.dataset) return;
          var action = t.dataset.action;
          var id = t.dataset.char || '';
          var kind = t.dataset.kind || '';
          if (action === 'switch') {
            if (!id) self.switchCharacter({ mode: 'default', id: null });
            else if (kind === 'builtin') self.switchCharacter({ mode: 'builtin', id: id });
            else self.switchCharacter({ mode: 'pack', id: id });
          } else if (action === 'delete') {
            self.deleteCharacter(id, t.dataset.name);
          } else if (action === 'import') {
            if (fileChar) fileChar.click();
          } else if (action === 'export') {
            self.exportCharacter();
          }
        });
      }
      if (fileChar) {
        fileChar.addEventListener('change', function (e) {
          var f = e.target && e.target.files && e.target.files[0];
          if (f) self.importCharacterPack(f);
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
          toggle(lPicker, [picker, wPicker, cPicker]);
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
