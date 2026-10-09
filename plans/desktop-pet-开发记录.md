# 桌面宠物 — 开发记录

> 这是**开发侧的历史存档**，记每次改动的原因、做法和当时的验证数据。
> **想知道怎么用，看 [desktop-pet-使用说明.md](desktop-pet-使用说明.md)。**
>
> 文中的代码行号、测试通过数都是**当时**的快照，不保证现在还对得上——现状以代码为准。
> 各篇按时间顺序排列。第六篇里那份「当前状态」同样是**当时**的快照，
> 想知道现在是什么样，看 [desktop-pet-使用说明.md](desktop-pet-使用说明.md) 和代码。

## 时间线

| # | 阶段 | 做完之后 |
| --- | --- | --- |
| [一](#一界面壁纸桌面壁纸效果) | 界面壁纸（桌面壁纸效果） | 整窗壁纸 + 本地图片导入，设置存 `desktop_pet_settings` |
| [二](#二时间区间终点省略时段前缀的解析修复) | 时间区间终点省略时段前缀 | 「下午2点到4点」不再跨天到凌晨 4 点 |
| [三](#三晚字缺失娱乐词宽松匹配壁纸背景分家) | 「晚」字缺失、娱乐词宽松匹配、壁纸背景分家 | 「晚8点」认了，口语娱乐词认了，壁纸面板不再混进背景图 |
| [四](#四使用说明拆分为三份文档) | 使用说明拆成三份 | 文档从 1 篇变 3 篇 |
| [五](#五文档审计与项目精简) | 文档审计、项目精简 | 修 4 个错、补 6 处漏，删重复图与临时 profile |
| [六](#六文档整合与测试精简) | 文档整合 + 测试精简 | 文档从 8 篇合并成 2 篇；删掉 3 个真机 e2e |
| [七](#七导入安排表改走-pdf) | 导入安排表改走 PDF | 导入支持 PDF（内部还原成 CSV）；下载模板改成 PDF |
| [八](#八教务系统网格课表导入) | 教务系统网格课表导入 | 课表 PDF 直接导入；内置 CMap 让中文 PDF 提得出文字 |
| [九](#九下载模板失效file-下的跨源-download) | 「下载模板」失效 | 改成按钮 + 内置字节 + Blob 下载 |
| [十](#十清理与文档收口) | 清理与文档收口 | `plans/` 从 4 篇收敛到 2 篇；腾出 30M |
| [十一](#十一整日安排复制) | 整日安排复制 | 「把某天的安排复制到另一天」，撞上的成对询问重叠/更换 |
| [十二](#十二再次收口设计稿折进本篇) | 再次收口 | 设计稿折进开发记录，`plans/` 回到 2 篇 |
| [十三](#十三本地大模型接入ollama) | 本地大模型接入 | 接 Ollama（默认 `qwen3:4b`）：开关默认关，正则优先、模型兜底；`talking.webm` 只在连着模型说话时播 |
| [十四](#十四目录重组测试与工具分家) | 目录重组 | `_scratch/` 拆成 `tests/` + `tools/`，依赖提到根目录；新增 `npm test` 一条命令跑完全部离线断言 |

---

## 一、界面壁纸（桌面壁纸效果）

舞台背景功能完成后，界面整体仍是深色纯色，用户觉得单调，想要「像电脑壁纸一样」的效果：
整窗底层铺壁纸图，界面浮在上面，且能自己导入本地图片。

**关键设计**：壁纸存进 `desktop_pet_settings`（与舞台背景同一键、互不覆盖）；body 上写 inline 背景
（cover/center/fixed + 压暗层）；`body.has-wallpaper` 时 4 个 CSS 变量转半透明（.8 alpha）让壁纸透遍面板，
`.day-head` 吸顶头保持纯色；本地导入走 FileReader → Image → canvas 等比缩到最长边 ≤1920 → JPEG q0.8 的
data URL（**data URL 图源不污染画布**，`file://` 下安全，已实测）。

### 素材

原图字节复制为 `desktop-pet/data/wallpapers/wall1.jpg`（ASCII 文件名；放进应用目录保证
`desktop-pet` 自包含、整体搬走不丢壁纸）。md5 `e51ed3265677310a55c7b37cfa074e89`，
428269 字节，1920×1080。

> 后来发现这个原图和 `picture/` 里的源文件字节完全相同，留着只是重复占 428KB，
> `picture/` 已删除（见[第五节](#五文档审计与项目精简)）。要换壁纸直接把新图放进
> `data/wallpapers/` 即可，不再需要中转目录。

### settings.js（主要改动，ES5 风格不变）

**新增常量**

- `WALLPAPER_PRESETS` 白名单，附注释写清扩展流程（图片处理成 `data/wallpapers/wallN.jpg` → 追加条目；
  路径不在白名单时 `load()` 自动回退为无壁纸）
- `WALLPAPER_OVERLAY = 'linear-gradient(rgba(15,19,34,.35), rgba(15,19,34,.35)), '`
  （**初版是 50%，实际看下来太暗，改成 35%**；预设图本身亮度只有 47/255，压太深只剩一片深蓝）
- `WALLPAPER_MAX_EDGE = 1920`、`WALLPAPER_QUALITY = 0.8`、`WALLPAPER_MAX_LEN = 6MB`（data URL 字符上限）、
  `MAX_IMPORT_BYTES = 20MB`（源文件上限）

**存储升级**

- `sanitizeWallpaper(v)`：非字符串→null；`data:image/` 开头必须匹配
  `/^data:image\/(jpeg|png|webp|gif);base64,/` 且长度 ≤ MAX_LEN（拒绝 svg 等可执行格式）；
  其余按 `WALLPAPER_PRESETS` 白名单匹配，不在清单→null
- `load()` 返回 `{ bg, wallpaper }`（旧数据只有 bg → wallpaper 为 null，向后兼容）
- `save(state)` 改为整存对象 `JSON.stringify({bg, wallpaper})`，返回成功与否（setItem 抛
  QuotaExceeded 时 false）
- **两个既有调用点同步改**：`select()` → `save({ bg: path, wallpaper: this.wallpaper })`；
  `clearBg()` → `save({ bg: null, wallpaper: this.wallpaper })`

**新增方法**（挂在 `App.Settings` 上）

- `applyWallpaper()`：有壁纸 → `body.classList` 加 `has-wallpaper` + 写 5 个 inline 长属性
  （backgroundImage = 压暗层 + url、Size cover、Position center、Repeat no-repeat、Attachment fixed）；
  无 → 移除 class + 5 个属性清空。**不用 `style.background` 简写**（避免与样式表
  `html,body{background:var(--bg)}` 踩踏）。同步 `#btn-wallpaper-clear` 显隐 + 重建壁纸面板
- `selectWallpaper(path)`：白名单校验 → `save({bg: this.bg, wallpaper: path})` → 失败走
  `Output.error` + `Bubble`（同 `select` 模式）→ 成功应用 + 反馈
- `clearWallpaper()`：`save({bg: this.bg, wallpaper: null})` → 应用 + 反馈
- `importWallpaper(file)`：见下方管线
- `buildWallpaperPicker()` / `syncWallpaperPickerSelection()`：面板结构 = 提示语 + 「无」(`data-path=''`) +
  预设缩略图(`data-path`) + **自定义缩略图**（仅当当前壁纸是 data URL 时，用无 `data-path` 的 span 展示，
  防止大数据塞 DOM 属性）+ 「本地图片…」按钮(`data-action='import'`)。复用 `.bg-picker` 样式类
- `bindUI()` 扩展（保留 `_uiBound` 一次性守卫）：`btn-wallpaper` 展开/收起 `#wallpaper-picker`
  （与舞台面板互斥：展开一个收起另一个）；壁纸面板事件委托先查 `data-action`（`'import'` →
  `file-wallpaper.click()`），再查 `data-path`（`''` → `clearWallpaper`，否则 `selectWallpaper`）；
  `file-wallpaper` change → `importWallpaper(files[0])` 后**立即 `e.target.value = ''`**
  （`readAsDataURL` 已同步捕获 File，重置保证同图可再次选择）
- `init()`：`var s = load()` 一次取两值 → 依次 `buildPicker`、`applyToStage`、`applyWallpaper`、`bindUI`

**importWallpaper(file) 管线**（全异步回调，ES5）

1. 无 file（取消选择）静默返回；`file.type` 非 `image/*` → 提示；`file.size > 20MB` → 早退
2. `FileReader.readAsDataURL` → onerror 提示「图片读不出来」
3. `new Image()`，src = `reader.result`（data URL）；onerror 提示「解码失败」；
   onload 里 `naturalWidth/Height` 为 0（SVG 无固有尺寸等）同样走失败
4. 等比缩到最长边 ≤1920（`scale = Math.min(1, MAX_EDGE / max(w,h))`，**只缩不放**）；
   canvas 先铺 `#171d33` 底色再 `drawImage`（透明 PNG 转 JPEG 不产生黑底）
5. `toDataURL('image/jpeg', 0.8)`，try/catch 兜底；结果超 MAX_LEN → 提示太大
6. `save(...)` 失败 → 提示存储满，**不改内存态和 DOM**；成功 → 更新 `this.wallpaper` +
   `applyWallpaper` + 反馈

### index.html / style.css

`#btn-bg-clear` 后加两个按钮和一个 file input（`#file-wallpaper` 放 topbar，别放进面板），
`#bg-picker` 后加 `<div id="wallpaper-picker" class="bg-picker" hidden></div>`。

```css
/* 壁纸透出：4 个变量转 .8 alpha（原十六进制值转 rgba） */
body.has-wallpaper {
  --bg-pane: rgba(23, 29, 51, .8);
  --bg-card: rgba(30, 38, 66, .8);
  --bg-card-2: rgba(35, 44, 77, .8);
  --pet-bubble: rgba(35, 44, 77, .8);
}
/* 例外：sticky 吸顶头必须纯色，否则滚动时任务行从半透明头部下透出 */
body.has-wallpaper .day-head { background: #171d33; }
```

导入按钮复用 `.bg-none` 造型：选择器改为 `.bg-none, .bg-import { ... }`、hover 同理。
`app.js` 不动——`boot()` 已按序 init，`document.body` 在 DOMContentLoaded 后必然存在。

### 已知取舍

- PiP 窗口不受影响：`_copyStyles` 只复制样式表，PiP 文档 body 无 `has-wallpaper` class 也无 inline 样式，
  PIP_CSS 的 `var(--bg-pane, #171d33)` 取 `:root` 不透明值
- 半透明连锁：`.msg-pet`（0.8 气泡叠 0.8 面板）等效 0.64 透光，下有压暗层，对比度可接受；
  文字对比度靠压暗层兜底，日后若要再降透明度需先加深压暗层
- 舞台背景与壁纸双层叠：舞台区域 = 壁纸透 20% + 舞台背景不透明，符合预期
- 舞台面板与壁纸面板互斥展开；壁纸面板在 `applyWallpaper` 里重建（与舞台面板 `buildPicker` 同构，
  监听器全挂在持久容器上，重建安全）
- 多层背景的 computed 值是逗号分隔的（`"cover, cover"`），写测试/调试时别只看第一段就下结论

### 实测中踩到的坑（写测试时注意）

- **canvas 在 `img.onload` 内部才创建**：想定制导出结果不能在调用导入前改「当前 canvas」，
  要用一个 `nextCanvasDataUrl` 变量在 `createElement('canvas')` 时消费
- **computed 多层背景是逗号分隔**：`backgroundSize` 为 `"cover, cover"`、`backgroundPosition` 为
  `"50% 50%, 50% 50%"`；`center` 会被解析成 `50% 50%`，断言别写死 `'center'`
- **`backgroundImage` 的 computed 值含绝对 `file://` URL** 且很长，截断到 40~60 字符看不到第二层 url
- **清空壁纸后高亮落在「无」上**（与舞台背景面板行为一致），不是「无高亮」

---

## 二、时间区间终点省略时段前缀的解析修复

### 现象

用户输入「明天下午2点到4点开会」，落库成 **14:00 – 次日 04:00**，正确应为 14:00 – 16:00。

### 根因

`dialog/input.js` 的 `parseWhen()` 里，区间「起点 到 终点」是这样解析的：

```js
var tail = text.slice(t1.end);
var sep = /^\s*(?:到|至|~|-|—)\s*/.exec(tail);
if (sep) t2 = findTime(text, t1.end + sep[0].length);
```

`t1` = 「下午2点」→ `{h:14, period:'下午'}`。
`t2` = 从「到」之后扫到的「4点」→ `{h:4, period:null}`（「下午」这个前缀只被 t1 吃掉）。

时段前缀只在 `findTime` 内部经 `applyPeriod` 生效，**t2 没有前缀就按 24 小时制直读**，
于是 `endTime = '04:00'`。`Manager.add` 看到结束早于开始，按既有规则判为跨天 `endOffset=1`
→ 次日 04:00。

修改句分支（「把下午三点的会议改成四点」）早就有同样的继承逻辑，`parseWhen` 的区间分支漏了
——**这个不对称才是 bug 的本质**。

### 修复

`dialog/input.js`，`parseWhen()` 里 t2 存在时：

```js
var endH = t2.h;
if (!t2.period && t1.period) {
  var inh = applyPeriod(t2.h, t1.period);
  if (inh && inh.h * 60 + t2.m > t1.h * 60 + t1.m) endH = inh.h;
}
result.endTime = util.minToHm(endH * 60 + t2.m);
```

**关键在第二个条件**：只在「继承后终点晚于起点」时才采纳。否则「晚上10点到2点」这类真想跨夜的说法
会被改成 22:00–14:00。分不清时宁可保持原样交给 Manager 判跨天——跨天是既有能力，
误改同日才是新引入的错误。

### 行为对照

| 输入 | 修复前 | 修复后 |
|---|---|---|
| 明天下午2点到4点开会 | 14:00–次日04:00 | 14:00–16:00 |
| 明天上午9点到11点数学复习 | 09:00–11:00 | 09:00–11:00（本来就对） |
| 明天晚上7点到9点看电影 | 19:00–次日09:00 | 19:00–21:00 |
| 明天中午12点到1点吃饭 | 12:00–次日01:00 | 12:00–13:00 |
| 明天下午2点到下午4点开会 | 14:00–16:00 | 14:00–16:00（自带前缀，不继承） |
| 明天晚上10点到2点值班 | 22:00–次日02:00 | 22:00–次日02:00（继承后 14:00 < 22:00，不采纳） |
| 明天9点到11点数学复习 | 09:00–11:00 | 09:00–11:00（起点无前缀，不继承） |

### 写测试时踩到的坑

- **`App.Config.storageKey` 才是日程的 localStorage 键**（`schedule/storage.js` 里通过
  `App.Config.storageKey` 取），不要用 `desktop_pet_v2` 字面量
- **修改句要先有对得上的目标**：`doUpdate` 用 `intent.target.titleFrag` 匹配，
  建「开会」去改「会议」匹配不到；而且 `bounds` 里同一句跑两遍时 `by()` 取的是第一遍的结果

---

## 三、「晚」字缺失、娱乐词宽松匹配、壁纸背景分家

用户提了四条（第一条是清理杂项）：

1. 想删掉项目里没用的文件
2. 界面壁纸与舞台背景的图片**混在一起**了——`wallpapers/` 明明只有一张图，换壁纸面板里却有两张
3. 输入「晚上8点到九点学习英语」被当成早上 8 点
4. `refuse` 不该要求输入精确关键词，应该在长句里扫关键词，例如「我想玩游戏」

排查结论：第 3、4 条**用户原话的写法本来就能正确工作**（用 vm 沙箱 + CDP 真机两路验证过），
但顺着扫同类说法，各抓出一个**真实存在的缺陷**。

### 3.1 `晚` 单字与 `今晚/明晚/后晚` 不认（对应用户第 3 条）

| 输入 | 修复前 | 修复后 |
| --- | --- | --- |
| `晚上8点到九点学习英语` | 20:00-21:00 ✅（本来就对） | 20:00-21:00 |
| `晚8点到9点学习英语` | **08:00-09:00 ❌** | 20:00-21:00 |
| `今晚8点到9点学习英语` | **08:00-09:00 ❌** | 今天 20:00-21:00 |
| `明晚8点到9点学习英语` | **明天 08:00-09:00，标题残留「明」❌** | 明天 20:00-21:00《学习英语》 |
| `后晚8点到9点…` | **08:00 ❌** | 后天 20:00-21:00 |

**根因**：`dialog/input.js` 的 `PERIOD` 词表只有 `晚上`，没有口语里更常见的单字 `晚`，
也没有 `今晚/明晚/后晚` 这三个自带日期的词。

**改动：**

**1. `PERIOD` 词表加 `晚`（放最后）+ `今晚|明晚|后晚`（放 `晚` 前面）**

```js
var PERIOD = '(上午|早上|早晨|清晨|中午|下午|晚上|傍晚|夜里|夜晚|凌晨|今晚|明晚|后晚|晚)';
```

单字 `晚` 是安全的：正则要求时段词后面紧跟 `数字 + 点/时/:`，所以「晚会」「晚餐」这类词不会被吃掉。

`今晚/明晚/后晚` 必须列在 `晚` 前面并**整体**匹配——否则 `findDate` 只吃掉「今晚」、
`findTime` 从「晚」开始，两个 span 错位。

**2. `applyPeriod` 补 case**：`今晚` / `明晚` / `后晚` 与 `晚上` 同样处理（`h < 12` 时 +12）。

**3. `findDate` 相对日正则补三个词**，并加进 delta 表：`今晚:0 明晚:1 后晚:2`。

**4. `stripSpans` 重叠处理修正**

```js
// 以前
if (s.start < cursor) return;              // 后一个 span 被整个丢掉，尾巴留在标题里
// 现在
if (s.start < cursor) { cursor = Math.max(cursor, s.end); return; }
```

`今晚8点` 的日期 span `[0,2)` 与时段 span `[0,5)` 重叠，旧代码丢掉后者，
于是 `8点` 留在了标题里——这是「明晚…」标题出现「明」字的连带原因。

### 3.2 娱乐词被修饰语隔开就匹配不上（对应用户第 4 条）

`refuse` 的判定**本来就是整句子串扫描**，不是要求精确输入关键词：

```
App.Config.keywords.entertainment.indexOf(...)  →  text.indexOf(kw) >= 0
```

「我想玩游戏」能命中。真正的漏洞是动词和宾语被隔开的说法：

| 输入 | 修复前 | 修复后 |
| --- | --- | --- |
| `我想玩一会儿游戏` | ✗ 不认 | ✅ entertainment |
| `我想看个视频` | ✗ 不认 | ✅ entertainment |
| `想刷会儿手机` | ✗ 不认 | ✅ entertainment |

**改动**：`app.js` 的 `App.Config` 新增一组宽松正则，
`util.findEntertainment` 在精确子串之后再过一遍：

```js
entertainmentPatterns: [
  { re: /玩.{0,4}?游戏/, name: '玩游戏' },
  { re: /打.{0,4}?游戏/, name: '打游戏' },
  { re: /看.{0,4}?视频/, name: '看视频' },
  { re: /看.{0,4}?电影/, name: '看电影' },
  { re: /看.{0,4}?动漫/, name: '看动漫' },
  { re: /刷.{0,4}?手机/, name: '刷手机' },
  { re: /刷.{0,4}?视频/, name: '刷短视频' }
]
```

- `.{0,4}?`：动词与宾语之间最多隔 4 个字
- `name` 是命中后回填的规范词。无时间的娱乐请求会**拿命中词当标题**，
  不加 `name` 的话标题会变成「玩一会儿游戏」这种带修饰语的怪东西
- 只收娱乐词，且**故意不加 `看…剧`**——`看剧本` 是正经事，不是追剧

**另一个容易被误判成 bug 的行为（未改动）**：拒绝只在任务进行中触发
（`App.StateMachine.isBusy()`）。空闲时说「我想玩游戏」走的是安抚分支，
回复「现在是空闲时间，想放松就玩一会儿吧～」，不是没识别出来。

### 3.3 壁纸预设混进了舞台背景图（对应用户第 2 条）

`settings.js` 的 `WALLPAPER_PRESETS` 原本是两条：

```js
{ path: 'data/wallpapers/wall1.jpg', label: '中山装·人生哲理' },
{ path: 'data/backgrounds/bg1.jpg',  label: '紫色' }        // ← 舞台背景，串味了
```

`wallpapers/` 目录下只有一张图，面板里却显示两张缩略图，就是这个第二条造成的。

**改动**：删掉 `data/backgrounds/bg1.jpg` 那一条，并在注释里写明
「壁纸预设只收 `data/wallpapers/`，别把舞台背景混进来」。

**连带影响**：`sanitizeWallpaper()` 用这个清单做白名单校验，删掉后
「把舞台背景路径当壁纸设置」会被弹回（以前能设进去）。已把这个行为固化成测试用例。

### 3.4 杂项清理（对应用户第 1 条）

源码层面**没有**无用文件：`desktop-pet/` 下 13 个源文件（1 html + 1 css + 11 js）+ 素材全部在用。
真正需要清的只有 `tests/` 里的临时产物（Edge 临时 profile、诊断脚本）。

### 验证

| 测试 | 结果 |
| --- | --- |
| `test-parse-time.js` | 27 通过 / 0 失败（新增 4 条「晚」用例） |
| `parse-e2e.js` | 22 通过 / 0 失败（新增「明晚」真机用例 + 娱乐拦截时间线） |
| `test-wallpaper.js` | 60 通过 / 0 失败（新增「预设不含背景图」「背景图当壁纸被拒」） |
| `wallpaper-e2e.js` | 47 通过 / 0 失败（预设数 3→2，persist 改用 wall1.jpg） |
| `test-pip.js` | 33 通过 / 0 失败 |
| `test-stage-background.js` | 31 通过 / 0 失败 |
| `test-warn-reminders.js` | 29 通过 / 0 失败 |

**娱乐拦截的真机验证方法（值得记下来）**

直接断言「handle 之后聊天记录最后一条是拒绝话术」会**误判**：新建任务会立刻播准点提醒
（`alert` 占住临时态 5 秒），这段时间内的 refuse 请求按设计被丢弃（`stateMachine.js:227`）。
所以探针要：

1. 先 `App.Manager.add` 一条当前时段的任务
2. 轮询等 `App.StateMachine.temp` 连续 1.5 秒为空，还原「任务进行中、宠物闲着」的现场
3. 再 handle 娱乐请求，此时才能稳定拿到 `state === 'refuse'`
4. 用 `MutationObserver` 挂聊天记录，输出带时间戳的时间线，确认话术真的播了

实测时间线：`518ms alert 准点播报` → `5672ms 用户「我想玩游戏」` → `5672ms refuse 拒绝话术`。

**已知未修的小问题**：`明晚8点到9点学习英语1小时`——区间和时长同时写时，区间优先是对的，
但「1小时」的字样不会被从标题里剥掉（`stripSpans` 只在没有区间时才 push 时长 span）。
属于冗余输入，未处理。

---

## 四、使用说明拆分为三份文档

原 `plans/desktop-pet-使用说明.md`（346 行）是单一文档，且**落后于已上线功能**：
完全没提到更换背景、界面壁纸、画中画、开始前/结束前提醒。

拆成三份：`使用说明`（重写，保留文件名）+ 新建 `虚拟形象自定义`、`移动端使用`。
同时删除两个已过时的文档（`画中画显示舞台背景.md`、`自定义背景与时间提醒.md`）。

> 这三份**后来又在[第六节](#六文档整合与测试精简)合并回一篇**了。
> 拆分的理由是「各自主题清晰」，合并的理由是「找东西不用来回跳」——最终选了三篇合一的 17 节长文。

---

## 五、文档审计与项目精简

用户要求：删掉项目里没用的文件；通读 `plans/` 下的文档，看说明有没有遗漏；保持整体简洁。

做法：先做文件引用链审计，再把 `plans/` 各文档里**每一条可验证的声明**拿到代码里逐条核对
——文件路径、代码行号、配置取值、数量声明、行为描述都要打开原文件确认。

### 文件清理

**审计结论：源码层面没有无用文件。** `desktop-pet/` 下 13 个源文件（1 html + 1 css + 11 js，
加素材共 23 个文件）全部在引用链上（`index.html` 的 `<script>` 标签 + 彼此调用）；
`App.*` 命名空间成员全部有引用；没有 TODO / FIXME 残留。

> 这一节的**两个数字当时都写错了**，在[第六节](#六文档整合与测试精简)整合文档时才验算出来：
> 源文件是 **13** 个不是 17 个；`App.*` 成员也不是「全部有引用」——
> `App.Events` 是个从未被引用的死导出，已删除。
> 教训：**数量声明也要真的数一遍**，哪怕它看起来只是句无关紧要的形容。

实际删掉的：

| 对象 | 大小 | 理由 |
| --- | --- | --- |
| `picture/【哲风壁纸】中山装-人生哲理.jpg` | 428KB | 与 `desktop-pet/data/wallpapers/wall1.jpg` md5 完全相同（`e51ed326…`），字节级重复 |
| `tests/_edge_parse/`、`_edge_wallpaper/`、`_edge_pip/` | ~42MB | 跑 e2e 时 Edge 生成的临时用户目录 |

`.gitignore` 补了 `tests/_edge_*/`——这三个目录**跑一次 e2e 就会重新生成**（约 40MB），
不排除的话会被误提交。

### 文档审计：4 个实质错误

| # | 位置 | 错在哪 | 改成 |
| --- | --- | --- | --- |
| 1 | 使用说明 §七 娱乐判定表 | 例句「我想整理一下游戏攻略」实际**不会**被判成娱乐（真实 parser 跑过，返回 `no_intent`） | 换成实测会误伤的「帮我整理追剧片单」，并补一条正面例子 |
| 2 | 虚拟形象 §四 | 说 `App.Config`「约 129-161 行」，实际是 133-179 行 | 改为「约 133-179 行」 |
| 3 | 使用说明 §二 | 说计划表显示「**所有**日程」，实际 `app.js:263` 的 `if (t.date < today) return;` 把过去的日期整组隐藏了 | 改写，并说明历史日程没被删、按日期查询仍查得到 |
| 4 | 使用说明 §十三 | `freeze=1` 单列一行，实际它写在 `if (hm && …)` 块内部（`app.js:199`），单独用不生效 | 注明必须与 `time` 搭配 |

**顺带修的小误差：**

- **周期日程窗口**：文档说「未来 14 天」，代码是 `for d = 0..materializeDays`
  （今天 + 往后 14 天，共 15 个日期）。已改成「今天起往后数 14 天（今天是第 0 天）」
- **CSV 示例与模板不一致**：文档里「睡前复盘」「英语精读」写了 `studying`，真实模板这两行的
  category 是空的
- **确认词表漏了「对」**：代码正则里有（`app.js:586`）
- **SVG 选择器不存在**：文档写 `.stage[data-state="studying"] .g-arm`，代码里没有这个选择器——
  实际是 `.arm-l` / `.arm-r`，已换成 `page-flip` 那段真实 CSS

### 文档审计：6 处遗漏（代码里有、文档没写）

按重要性排：

1. **CSV 导入有「替换」模式**——回复「替换」会清空现有日程再导入。文档只写了「确认」。
   这是**破坏性操作**，不写清楚容易误用，已补表格 + 警示
2. **计划表每行右侧的 ✕ 删除按钮**（`app.js:306`）——最省事的删除方式，
   之前所有文档都只教了用对话删除
3. **控制台 `App.debug` 钩子**（`app.js:753`）——`set` / `tick` / `state` / `refuse` / `seed`
   五个方法，比 URL 参数灵活且不用刷新，已补一节表格
4. **带时间的娱乐安排入库时会被归成「通用」**（`app.js:462`）——文档只说「照常入库」，
   没说类别会变、宠物显示的是工作状态
5. **尊重系统「减少动态效果」**（`prefers-reduced-motion`，`style.css:702`）——打开后所有动画停止。
   这是「宠物突然不动了」最容易被误判成故障的原因
6. **细节**：非空数据时的「欢迎回来～今天还有 N 项安排」；数据版本比程序新时备份到
   `desktop_pet_v2_future_<时间戳>`；CSV 标题超 40 字拒绝；过去的日期行跳过；
   「每日」是「每天」的等价写法

### 消除重复

`虚拟形象自定义` 的「从白底视频生成透明素材」一节，和 `desktop-pet/videos/README.md`
里的 ffmpeg 命令是**逐字重复**。两份都要维护，迟早漂移。

改法：**`videos/README.md` 定为素材的权威说明**（它和素材放在一起，换素材的人自然会打开它），
文档只留思路 + 最容易踩的坑（`-auto-alt-ref 0`），其余指向 README。

---

## 六、文档整合与测试精简

用户要求：测试确认没问题后删掉不用的测试文件；把 `plans/` 的 markdown 整合成尽量少的文件数，
同时仍能详细说明项目各个方面。

### 测试：跑完 8 个套件后精简

整合前先把所有套件跑了一遍确认全绿，然后：

| 保留（`tests/`，5 个） | 删掉 |
| --- | --- |
| `test-parse-time.js`（27 项） | `parse-e2e.js` |
| `test-pip.js`（33 项） | `wallpaper-e2e.js` |
| `test-stage-background.js`（31 项） | `pip-e2e.js` |
| `test-wallpaper.js`（60 项） | |
| `test-warn-reminders.js`（29 项） | |

**删 e2e 的理由**：需要硬编码路径的 headless Edge，且每跑一次就生成约 40MB 的临时 profile；
其中 `pip-e2e.js` 根本没有断言，只是打印一坨 JSON 给人肉眼看。留下的 5 个是纯 Node
vm 沙箱测试，秒级跑完、有明确断言，**才是真正的回归网**。

> 代价：真机链路（真实 localStorage、`Page.reload` 持久化、真实 File 导入管线）以后不再自动验证。
> 这几条当初确实抓到过 vm 测不出的问题——需要时按第三节记的探针写法重搭。

### 文档：8 篇 → 2 篇

| 合并前 | 合并后 |
| --- | --- |
| `使用说明` + `移动端使用` + `虚拟形象自定义` | **`desktop-pet-使用说明.md`**（17 节，带目录） |
| `界面壁纸` + `时间区间解析修复` + `时间与拒绝修复` + `文档重组` + `文档审计与精简` | **`desktop-pet-开发记录.md`**（本篇） |

合并时做了去重：

- 原`虚拟形象自定义`第一节「角色是怎么工作的」与使用说明第六节重复 →
  合并成第六节的「两套形象，自动选」+ 状态表新增「素材文件」列
- 原`虚拟形象自定义`第四节 Config 表与使用说明第十二节重复 →
  **第十二节定为唯一的完整配置表**，第十七节只列形象相关的四项并指回去
- 原两篇都有「为什么是橙色小猫」→ 完整排查表留在第十二节（FAQ 中枢，
  第一节就引用它），第十七节末尾只留个指针
- 两条相对链接 `../desktop-pet/videos/README.md`、`../desktop-pet/pip.js#L38` 保留，
  脱离 `plans/` 语境仍然指得对

顺带**验算文档里的数量声明时抓出两个错，都已改正**：

1. 第五节写「`desktop-pet/` 下 17 个源文件」——实际是 **13** 个（1 html + 1 css + 11 js）
2. 第五节写「`App.*` 命名空间成员全部有引用，没有孤儿模块」——**不成立**。
   `app.js:35` 的 `App.Events = { create: createBus }` 是个死导出，全项目（源码、测试、文档）
   零引用，实际都走 `App.bus`。该行已删除，17 个成员全部在用

两处都是上一轮做引用链审计时**没实际数就写下的**。当时用「看起来对」的说法代替了验算，
而文档审计的全部价值就在于不这么做。

### 当前状态（截至本次）

**测试**：5 个套件，180 条断言，全绿。

| 套件 | 结果 |
| --- | --- |
| `test-parse-time.js` | 27 / 0 |
| `test-pip.js` | 33 / 0 |
| `test-stage-background.js` | 31 / 0 |
| `test-wallpaper.js` | 60 / 0 |
| `test-warn-reminders.js` | 29 / 0 |

**仓库结构**：

```
AIcompete/
├── .gitignore              含 tests/_edge_*/ 排除
├── desktop-pet/            13 个源文件 + 素材（共 23 文件），全部在被引用
├── plans/                  2 篇：使用说明 + 开发记录
└── tests/               5 个 vm 测试脚本
```

无用的东西已经清干净：删掉 `picture/`（字节重复）和全部 Edge 临时 profile 后，
仓库比最初少了约 42MB。

### 这轮跑测试时的完整输出

整合前 8 个套件全跑过一遍，除上表 5 个外还有：

| 套件 | 结果 |
| --- | --- |
| `parse-e2e.js` | 22 / 0（含娱乐拦截时间线：`6219ms 用户「我想玩游戏」` → 拒绝话术） |
| `wallpaper-e2e.js` | 47 / 0（含「拿舞台背景图当壁纸设置 → 被拒」） |
| `pip-e2e.js` | 非断言套件，打印 JSON 探针。关键字段全部正常：`pipOpened` / `stageInPip` / `bubbleInPip` / `badgeInPip` 均 true，`pipStyleSheets: 2`，`video.playing: true`、`readyState: 4`、`err: null`，关闭后 `backInMain: true`、`videoResumed: true` |

跑完生成的三个 Edge profile 已清理。

---

## 七、导入安排表改走 PDF

用户要求：**导入安排表改成导入 PDF 文件，内部给他改成 CSV；下载模板也一样，下载成 PDF 形式。**

确认过的前提：PDF 就是模板那种固定五列表格、是文字型（有文字层，不是扫描件）、CSV 导入能力保留。

### 选型：vendored pdf.js 3.11.174 legacy

- **为什么是 3.x**：v4 起只发 ESM 构建，`file://` 下 module script 会被 CORS 拦掉，直接破坏
  「双击 index.html 就能跑」这条底线。3.11.174 是最后一个提供 UMD 构建的版本，普通
  `<script>` 标签加载即用，挂 `window.pdfjsLib`。
- **为什么 vendored 而不是 CDN**：本项目要么离线双击运行、要么拷给别人用，不能依赖网络。
  取 `pdfjs-dist` npm 包 `legacy/build/` 下的 `pdf.min.js`（377KB）+ `pdf.worker.min.js`（1.1MB）
  放进 `desktop-pet/lib/pdfjs/`，连 LICENSE 一起带上。
- **`file://` 下 worker 怎么办**：不处理。Chrome 禁止 `file://` 页面创建 Worker，pdf.js 自己
  把 `new Worker()` 包在 try/catch 里，失败后**自动回退主线程 fake worker**（用普通 `<script>`
  动态加载 worker 脚本，这条路在 `file://` 下是通的）。实测控制台就一条
  `Warning: Setting up fake worker.`，功能完全正常。几页表格主线程解析 <100ms，无感知。
- 必须传 `getDocument({ data: arrayBuffer })`：`file://` 下 `{url}` 走 fetch，会被浏览器拦掉。

### PDF → CSV：按坐标还原表格

新增 `schedule/pdfImporter.js`（`App.PdfImporter.import(arrayBuffer, nowMs)`），只负责
「PDF 表格 → CSV 文本」，拿到 CSV 后**直接调 `App.Parser.parseCSV`**——字段校验、规则词展开、
逐行错误报告全部复用，`app.js` 那边只有入口分流是新的：

1. `getTextContent()` 的 items 是内容流顺序，先重排：按 y 降序聚成行（容差 2.5pt）、行内按 x 升序
   （PDF 坐标 y 向上递增，所以视觉上的第一行 y 最大）
2. 表头行（拼起来等于 `datestartendtitlecategory`）用来定列：按 x 间距分组取每组中心，分组数
   不是 5 就明确报错，不静默丢行
3. 每个文本项按**最近的列中心**归属（容差 40pt）。不用固定列区间——单元格内容溢出列宽时更稳
4. 非表格行丢弃：以 `#` 开头的整行（模板说明区）、只落在 1 个列上的杂行；只落在 title 列的
   当作上一行标题的换行续行接回去
5. 重建 CSV 时单元格含逗号/换行就加引号（与 parser 的 splitCSV 兼容），硬编码标准表头保证表头校验必过

**踩到的坑**：pdf.js 会在文本段之间插入「合成空格」项——`str` 是空格、**宽等于整段间隙、高为 0**。
它把列与列之间的真实间距抹平了，导致表头 9 个 item 的间距全部 ≤15pt，被当成 1 个列组，
直接报「表头列识别失败」。修法是收集 item 时滤掉纯空白项（格内间距改由拼接时的间距阈值负责）。

### 模板：一次性离线生成

`desktop-pet/data/schedule_template.pdf`（30KB）是**生成产物、提交进仓库**，与原来下载静态 CSV
是同一个思路，不改运行时逻辑。生成脚本 `tools/gen-schedule-pdf/gen.js`（Node + pdfkit）：

- 中文字体按 `simhei.ttf → simkai.ttf → simfang.ttf → Deng.ttf → msyh.ttc` 顺序取第一个存在的。
  **优先单文件 TTF**：`.ttc` 是字体集合，fontkit 打开时取哪一面不稳定
- 每格 `doc.text(cell, x, y, { lineBreak: false })`——**单行不换行是回导解析可靠性的关键**
- 示例日期改成按生成日推算（+7 / +12 / +13 天）。原来 CSV 里写死 `2026-09-21`，模板放几个月后
  导入会整片报「日期已过去」，等于示例全废
- 同一份行数据同时写出 PDF 和 CSV，**两份内容由脚本保证一致**，回环测试依赖这一点

中文回读：pdfkit 经 fontkit 做子集化嵌入时会写 `/ToUnicode`，pdf.js 优先用它还原 Unicode，
所以提取回来是正确中文——没有靠信任，由回环测试逐字断言。

### 验证

| 套件 | 结果 |
| --- | --- |
| `test-pdf-import.js`（新增，无头） | 15 / 0 |
| `e2e-pdf-import.js`（新增，真 Edge + CDP） | 22 / 0 |
| 既有 5 个 vm 套件回归 | 27 / 29 / 31 / 33 / 60，全 0 失败 |

- **无头回环测试**跑的是「模板 PDF → 重构 → 解析」与「直接读同一份 CSV → 解析」的**逐条等价**，
  62 条日程两边完全一致，证明 PDF 这条链路没有信息损失。断言里带中文保真
  （`英语听力训练` / `晨读背诵`）、含逗号标题按列边界切分、跨天 `23:00 → 00:30(+1)`、
  `每天` 规则词展开 15 条。
- **真机 e2e** 用 Node 内置 WebSocket 直接连 Edge 的 CDP，走完整链路：构造 `File` → 派发 `change`
  事件 → `FileReader.readAsArrayBuffer` → `importPDF` → 回复「确认」入库 → 再导一次验证去重
  → CSV 路径回归 → 拿 CSV 字节冒充 PDF 验证失败提示。这一步是**唯一**能覆盖 vendored
  `pdf.min.js` 在 `file://` 下能否加载、worker 回退是否真的生效的手段。
- **换了产家也不依赖**：e2e 第 6 组另造一份「浏览器打印导出」的 PDF（Skia/PDFium 排版 +
  系统雅黑，与 pdfkit + 黑体是完全无关的两条链路），连同表格外的 `<p>` 说明文字一起打印。
  结果 18 条全部解析（3 条单次 + `每天` 展开 15 条）、0 错误、中文与「含逗号+全角括号」的标题
  逐字保真、说明文字没被当成任务。说明重构逻辑认的是**坐标与表头文字**，不是 pdfkit 的产物特征
  ——这正是原计划风险表里「用户拿自己的表格另存成 PDF」那一项的兜底验证（顺带说明为什么
  `e2e` 脚本里会多一个临时的 HTML fixture：它是打印的输入，不是应用的一部分）。
- 排版用 `preview-template.js` 把生成的 PDF 渲染成 PNG 目视检查过：表头底色、表格线、中文、
  说明区灰色小字都正常。顺手把 date 列从 110pt 收到 90pt（原来明显偏宽），title 列补到 220pt。

> 第六节刚以「需要硬编码 Edge 路径、没断言、每次生成 40MB profile」为由删掉了 3 个 e2e，
> 这次又加回一个，区别是：断言明确、浏览器路径按候选列表自动找（可用 `BROWSER` 环境变量覆盖）、
> profile 跑完即删且已被 `.gitignore` 覆盖，且它验证的是 vm 沙箱**测不了**的东西（真实
> `file://` 安全策略、真实的 Worker 构造失败、真实的 FileReader 管线）。

### 已知边界

- **只支持文字型 PDF**，扫描件/图片型提不出内容，会明确报「PDF 解析失败」。
  已验证的产家：pdfkit 生成（模板本体）、浏览器打印导出。**WPS / Adobe 另存再导回尚未实测**
  ——第 6 组的打印导出之所以能代表这一类，是因为它同样走「别的排版引擎 + 系统字体子集化」，
  但它毕竟还是 Chromium；真拿 WPS 改过一版导出验证会更稳
- 用户把标题写太长在 PDF 里折了行：只有落在 title 列的续行会被接回上一行，跨列的折行接不了
- 用户改动了列的位置（不是改内容，而是挪列）：表头分组数变了就报「表头列识别失败」，
  不猜、不静默丢数据
- `tests/` 下多了 `package.json` / `node_modules`（pdfkit + pdfjs-dist，都是 dev-only），
  `node_modules` 已进 `.gitignore`；**应用本体仍然零依赖**

---

## 八、教务系统网格课表导入

用户拿来一份真的课表 `data/梁浩贤(2026-2027-1)课表.pdf`，要求「改成可用的方式」，
并指定了两条：**不要问答步骤**（自己转）、**title 用课程名 + 教室地点**。

### 两个独立的坎，先分开看

拿到文件后先用 pdf.js 探了一遍，发现它同时踩了两个坑，任何一个单独出现都会让导入失败：

**坑一：文字层提不出来**。文件用 `STSong-Light` + `STSong-Light-UniGB-UCS2-H` 标准字体，
**没有内嵌 ToUnicode**，字形到 Unicode 的对照表在外部 CMap 文件里。pdf.js 默认不去取
（`cMapUrl` 没配），于是 `getTextContent()` 返回 **0 个文字项**——PDF 看着正常、能选中复制，
程序却一个字都读不到。控制台只有一行不起眼的
`loadFont - translateFont failed: The CMap "baseUrl" parameter must be specified`。

**坑二：版面根本不是表格**。`page.rotate = 90`，整个课表转了 90°：节次 1-16 沿视觉横向铺开
（每页一条带：页 1 是节 1-6、页 2 是节 7-14、页 3 是节 15-16），星期一到日沿纵向排 7 行
（行距 103.9pt，标签只出现在页 1），每个格子里的文字是**竖着写的多行**：

```
软件测试与管理
(3-4节)1-9周/校区:江门校区/场地:H4-413（江）/教师:张志威/教学班:…
```

### 坑一：内置 CMap

pdf.js 支持 `getDocument({ CMapReaderFactory })`，自定义工厂的 `fetch({name})` 返回
`{cMapData, compressionType}` 就行。**关键细节**（都验过源码）：

- 传的是**构造函数**，`getDocument` 内部自己 `new`（`pdf.js:3507`）。第一版写成传实例，
  报 `CMapReaderFactory is not a constructor`
- `compressionType: 1` = `CMapCompressionType.BINARY`，bcmap 是二进制格式
- **不要同时传 `cMapUrl`**。worker 侧的逻辑是 `if (options.cMapUrl !== null) fetch(url) else
  handler.sendWithPromise('FetchBuiltInCMap')`——给了 URL 它就去 worker 里 fetch，
  file:// 下必挂。只给工厂，`useWorkerFetch` 自动为 false，走消息通道到主线程的工厂
- 真 worker 和 fake worker（file:// 回退）走的是同一套消息通道，两种模式都成立

`tools/gen-schedule-pdf/gen-cmaps.js` 把 pdfjs-dist 的 **GB 系 33 个 CMap**（GB/GBK/GBT/
EUC/UniGB/Adobe-GB1）打包成 `lib/pdfjs/cmaps.js`（285KB 原始 → 382KB base64，惰性解码 + 缓存）。
繁体 CNS / 日文 JIS / 韩文 KOR 没打包 —— 用到了会报「缺少内置 CMap：（该 PDF 用了未打包的编码）」，
需要时改生成器的 `WANTED` 正则重跑。

**顺带把五列模板路径也升级了**：模板 PDF 经 WPS 编辑后若字体没有 ToUnicode，现在同样读得出来。

### 坑二：坐标重构

跑原型时踩了一个**静默出错**的坑，值得记下来：

第一版按 y 聚类视觉行（沿用五列模板那套），结果全乱。原因是**同一个 y 上有多个并排的视觉行**
（每个格子的第 N 行文字 y 坐标相同），聚类会把不同格子串成一行。真正的分割信号是 **`str === ''`
的空文本项**——它是内容流里的「本格写完了」标记。所以扫描必须按**内容流顺序**走，遇空项就
结束当前行、遇非空项且与上一项 x 差 ≤ 14pt 就并入当前行。修正后安静下来：

- 23 门课全部识别，展开 275 条日程，与手算一致
- 跨页续接：页 3 的 `:10/周学时:2/总学时:10/学分:0.5`（x < 该页条带左边界）要接回上一页
  那门课的 meta，不是新课
- 同一格子两门课：数字孪生技术实战 单周/双周各一条，靠「条带左侧出现标题行」区分

**title 组装**（用户指定）：课程名 + 教室。`场地:H4-413（江）` 取出来去掉尾部校区括号
→ `软件测试与管理 H4-413`。其余元数据（教师、教学班、学分）读完但不进标题，避免撞 40 字上限。

### 学期日期：推断而不是问

课表 PDF 里**没有**学期第 1 周周一这个锚点（只有「2026-2027学年第1学期」字样），而日期必须
有锚。用户明确要求不要问答步骤，所以做成：**按课表里的「打印时间:2026-09-19」往回推**
（所在周周一 − 14 天 = 2026-08-31），推断方式和结果**写进待确认报告**，回复一个日期就当场
重算并写进 localStorage，之后导入同校其它课表直接复用。日期只会整体平移，课程和时间不受影响。

> 实测推断值 2026-08-31 与实际开学日一致（用它对出来的星期二第 1 周 = 2026-09-01，
> 与课表「1-9 周」的排布自洽）。

### 改动

新增：`schedule/timetableImporter.js`（识别 + 展开）、`lib/pdfjs/cmaps.js`（生成产物）、
`tools/gen-schedule-pdf/gen-cmaps.js`、`tests/test-timetable-import.js`
修改：`schedule/pdfImporter.js`（接 CMap + 分发：五列表格优先，失败再试课表）、
`app.js`（`expandTimetable` + confirm-import 分支加日期修正）、`index.html`（2 个 script）、
`package.json`（`gen:cmaps` / `test:timetable`）

### 验证

| 套件 | 结果 |
| --- | --- |
| `test-timetable-import.js`（新增，无头） | 35 / 0 |
| `e2e-pdf-import.js`（真 Edge + CDP，第 7 组新增 11 条） | 33 / 0 |
| `test-pdf-import.js` | 15 / 0 |
| 既有 5 个 vm 套件回归 | 27 / 29 / 31 / 33 / 60，全 0 失败 |

无头套件里值得一提的断言：展开数 **275**（手算核对）、单双周各 9 次、
「学期中导入时 剩余行数 + 跳过数 = 275」（不凭空多也不丢）、
「回复 2026-09-07 后所有日期整体后移且没有早于它的」、以及**模板 PDF 不走课表分支**（62 条）。

`e2e` 第 7 组是唯一能验证 **vendored `cmaps.js` 在 file:// 下真的生效**的手段——
vm 里用的是同一份产物没错，但 vm 没有 file:// 安全策略，也没法证明双击打开时它能加载。
实测控制台仍只有那条 `Warning: Setting up fake worker.`，没有 CMap 相关报错。

### 已知边界

- **只认「星期 × 节次」这种网格课表**。识别条件是「星期标签 ≥ 4 且节次表 ≥ 4 且能切出课程」，
  不满足就保持原来的 fatal，不会硬套
- **学期第 1 周周一是推断值**，不是从文件读的（文件里没有）。推断规则「打印日期所在周周一 − 14 天」
  基于「多数学校在第 3 周前后导出课表」，换个时间导出就会整体平移两周 —— 所以报告里明示，
  回复日期即可修正
- 只内置了 GB 系 CMap。繁体/日文/韩文编码的 PDF 会报「缺少内置 CMap」，需要时改生成器重跑
- 元数据行粘连（视觉行切分失败）会 fail loud：进 `errors` 报「周次信息无法识别」，
  不产生时间错误的日程
- 一个格子放两门以上课（三连排）没实测过，样本里最多是两门

---

## 九、下载模板失效：file:// 下的跨源 download

第八篇上线后用户报「下载模板那怎么无法下载文件了」。看着像回归，实际是**第七篇把模板从
CSV 换成 PDF 时埋下的**——只是当时看不出来。

### 根因

「下载模板」原本是 `<a class="btn" href="data/schedule_template.pdf" download>`。
HTML 规范里 **`download` 属性只在同源 URL 上生效，跨源一律忽略、退化成普通导航**。
而 `file://` 协议下**每个本地文件都是独立的 opaque origin**（`origin` 是 `null`），
`index.html` 指向 `data/` 下的 PDF 就属于跨源 —— 属性被忽略，浏览器直接跳过去。

平时浏览器跳到 PDF 也就是打开看一下，坏就坏在 **Edge 有内置 PDF 阅读器**：
它把 PDF 渲染在当前标签页里，于是页面被顶掉、一个文件都不落盘，用户看到的就是「点了没反应，
下载不了」。用 CDP 抓的现场：

```
点击后 href: file:///D:/AIcompete/desktop-pet/data/schedule_template.pdf
浏览器目标:  page | file:///D:/AIcompete/desktop-pet/data/schedule_template.pdf
下载事件数: 0
```

**那为什么 CSV 时代是好的？** 因为浏览器没法内联渲染 CSV，遇到它只能下载 ——
于是**恰好**绕过了这个 bug。换成 PDF 之后这个巧合没了，问题才露出来。
换句话说这不是回归，是「一直错的代码靠对方特性掩盖着」，属于迟早要还的债。

### 试出来的可行路径

写了个探针在真 Edge + `file://` 页面里逐个点，看哪个真能落盘：

| 方式 | 结果 |
| --- | --- |
| `<a href="data/schedule_template.pdf" download>`（file:// 链接） | ✗ 0 个下载事件，页面被导航走 |
| `<a href="data:application/pdf;base64,..." download>` | ✓ 落盘 |
| `Blob` + `URL.createObjectURL` + `download` | ✓ 落盘 |
| `fetch('data/...')` 读本地文件 | ✗ CORS：`Cross origin requests are only supported for protocol schemes: ...` |
| `XMLHttpRequest` 读本地文件 | ✗ 同上（`status=0`） |

`blob:` 会继承创建它的文档的源，所以在 `file://` 页面上 `download` 是生效的。
但**读不到本地文件**（fetch/XHR 都被 CORS 挡死），所以模板字节没法在运行时取 ——
只能像 `lib/pdfjs/cmaps.js` 那样**随脚本一起加载进内存**。

### 改动

- `tools/gen-schedule-pdf/gen.js`：出 PDF 之后把字节读回来 base64 一份，
  写出 `desktop-pet/schedule/scheduleTemplate.js`（`App.ScheduleTemplate`，
  含 `fileName` / `mime` / `base64` / 惰性解码并缓存 `blob()`）。
  **三份产物（pdf / csv / js）同一次生成写出**，避免漂移
- `desktop-pet/index.html`：`<a href download>` 换成 `<button id="btn-template">`；
  加一个 script 标签
- `desktop-pet/app.js`：`App.util.downloadBlob(blob, name)`（blob + createObjectURL +
  临时 `<a download>` + `revokeObjectURL`），`#btn-template` 点击时调它
- `desktop-pet/style.css`：`.btn` 补 `font-family: inherit`
  （`<button>` 默认不继承 body 字体，不补会和旁边按钮字体不一致）

### 验证

| 套件 | 结果 |
| --- | --- |
| `e2e-pdf-import.js`（真 Edge + CDP，第 1 组新增 5 条断言） | 37 / 0 |
| `test-pdf-import.js` | 15 / 0 |
| `test-timetable-import.js` | 35 / 0 |
| 其余 5 个 vm 套件回归 | 27 / 33 / 31 / 60 / 29，全 0 失败 |

e2e 第 1 组新断言里最要紧的两条：**「点击后没有导航走」**（旧 bug 的表现就是跳去看 PDF）
和**「落盘字节与 `data/schedule_template.pdf` 逐字节一致」**（不是只下了个同名文件）。
CDP 侧配了 `Browser.setDownloadBehavior`，下载目录设在 `tests/_shot/e2e-downloads/`。

### 顺带：样本缺失时不再抛栈

跑回归时 `test:timetable` 报了 `ENOENT` —— 那会儿 `data/梁浩贤(2026-2027-1)课表.pdf`
恰好不在 `data/` 里（后来又放回去了，两次跑分别得到 4/0 和 35/0）。**问题不在文件在不在，
而在测试的反应**：一个可选样本缺失就抛一坨 require 栈，看不出到底哪组没跑。

所以两处都改成**样本缺失就跳过依赖它的组、并明确打印跳过了什么**：

- `test-timetable-import.js`：跳过 1-6 组，第 7（模板不走课表分支）、8（异常输入）组照跑
- `e2e-pdf-import.js`：第 7 组整体跳过

这是纯安全网：样本在时行为与从前完全一致（35/0、37/0）。留着是因为那毕竟是**带姓名学号的
个人课表**，将来要不要跟着仓库走是用户说了算，测试不该因为它的去留变得不可用。

### 已知边界

- 「下载模板」现在**依赖 `schedule/scheduleTemplate.js` 被加载**。该文件缺失时按钮会明确报
  「模板数据没加载出来（…），可以直接打开 `data/schedule_template.pdf` 另存」，不会静默失败
- 模板 PDF 由 30KB 变成**磁盘上 30KB + 脚本里 40KB base64（约 1.33 倍）**，这点冗余换的是
  `file://` 下能真的下载，值得；但以后改模板**必须重跑 `npm run gen:pdf`**，
  只换 `data/` 下的 PDF 会导致下载的还是旧的
- 备份导出（`App.Storage.exportBackup`）走的是同一套 blob 逻辑，**一直是对的**，
  这次没动它 —— 它只需要序列化内存里的 JSON，不用读磁盘文件，天然躲开了 CORS 那一关

---

## 十、清理与文档收口

用户要求：删掉多余无用的文件、把 `plans/` 的 markdown 整合、清掉 C 盘 `.claude` 里没用的东西。
删文件是红线操作，所以先把三处勘察清楚、列清单、逐项确认，再动手。

### `plans/` 从 4 篇收敛到 2 篇

多出来的两篇是两次 plan mode 留下来的设计稿（`pdf-csv-pdf-radiant-bonbon.md`、
`desktop-pet-课表PDF导入.md`），对应的正是第七、八篇那段工作。它们的问题是**双重过期**：

1. **内容**已被开发记录完整覆盖，且记录里多了验证数据、踩坑过程和已知边界
2. **行号引用全部失效** —— 设计稿写的是「`app.js` 改动（bindUI 650-655、importCSV 686-718）」，
   而第七篇之后 app.js 又改过好几轮。本文档开头那句「行号都是当时的快照」是给历史存档的免责声明，
   设计稿这种**以行号为施工依据**的文体套上它就没意义了

删之前确认过两件事：全仓库没有任何地方引用它们；且使用说明和开发记录里本来就写着
「`plans/` 两篇文档」—— **删掉之后文档反而变准了**。

### 项目内

删 `_shot/`（e2e 与 preview-template 的产物：打印导出的样本 PDF、模板渲染图、
下载验证目录）。`.gitignore` 里早就排除了它，测试跑一次就重建，实测 7 个 vm 套件都不会重建，
只有真跑 e2e 才会。（当时两者共用一个目录；现在随脚本分家，分别是 `tests/_shot/` 和 `tools/_shot/`。）

按用户判断保留了 `claude_DesktopNotepad/`（Claude Code 配置样例，与应用无关），
顺手把它和 `.gitignore` 补进了使用说明的目录树 —— 那棵树写着「整个仓库长这样」，
漏项就是错。

### C 盘 `.claude`：50M → 20M

| 删除项 | 大小 | 理由 |
| --- | --- | --- |
| 旧会话记录 `.jsonl` ×3 + 同名子目录 | 约 28M | 已完成的两轮会话，内容已沉淀进本记录 |
| `telemetry/` | 396K | 全是 `1p_failed_events.*.json`，上传失败的残留 |
| `file-history/` 4 个旧会话目录 | 约 1.5M | `/rewind` 的编辑历史，对应会话已删 |
| `backups/` | 44K | `.claude.json` 的旧备份 |
| `~/.claude/plans/` | 12K | 已复制进项目 `plans/`，那份设计稿本身也在本轮被删 |
| 对应 `session-env/` ×3 | — | 随会话一起变成孤儿目录 |

**明确保留**：`CLAUDE.md`（用户的全局指令）、`settings.json`、`projects/d--AIcompete/memory/`
（跨会话记忆）、**当前会话的记录与 `file-history`**（删了这段上下文和今天的撤销历史就没了）、
`plugins/marketplaces/`、其它项目目录。

保留当前会话的 `file-history` 是刻意的：用户选的是「删旧留当前」，
同一原则套到 `file-history` 上就是只删旧会话那几份。

### 验证

清理后 7 个 vm 套件全跑一遍，仍是 27 / 33 / 31 / 60 / 29 / 15 / 35，全 0 失败。
关键文件逐个确认过：记忆两篇完好、`CLAUDE.md` 可读、`settings.json` 仍是合法 JSON、
当前会话记录仍在正常写入。

---

## 十一、整日安排复制

用户要求：「添加语句中增加可以将某一天的全部安排添加到指定天数中的安排，重合的时间安排
询问用户是否要重叠或是更换掉」。规划期间补了三条口径：

1. 目标**单天**，源日**保留**（是复制不是移动）
2. 源日可以是「今天」这类相对说法，也可以是一个具体日期
3. **「更换」＝ 把撞上的两条并成一条，名字用逗号连起来**；且
   **时间段取并集** —— 先开始那个的头时间，到最后一个结束那个的尾时间

第 3 条是用户在两轮澄清里逐步收紧的：先说「重合的将两个安排的名字放在同一个框」，
再澄清「放同一个框的意思是把两个任务名称拼成一个 title，用逗号隔开」，
最后补上并集时间段的规则。批准时的设计稿本轮已折进本篇删掉（见第十二篇），
它的逐文件改动清单如今看代码更准。

### 解析层：新分支必须压在所有意图前面

`dialog/input.js` 新增 `COPY_WORD_RE = /(复制|拷贝|抄到)/` 和切分点
`COPY_SPLIT_RE = /(复制到|拷贝到|抄到|复制至|拷贝至)/`，在任何意图判断**之前**插入 copy 分支。

顺序是硬约束，不是风格问题：「安排」在 `ADD_RE` 里、「挪到」在 `UPDATE_SPLIT_RE` 里，
这个分支只要晚一步，`把明天的安排复制到周五` 就会被 add/update 抢走。

字段沿用 update 的惯例：`date` = 目标日、`targetDate` = 源日。

几个刻意的取舍：

- **不收「搬到」** —— 「搬」是移动语义，本功能源日保留，想移动请走既有的 `挪到`
- **不收裸「抄」** —— 否则 `晚上8点抄作业` 会被判成复制
- **不收「添加到」** —— 输入框虽然叫「添加语句」，但 `添加一个会议到周五` 是既有 add 路径的
  正经说法，让它掉进复制的 `copy_day_only` 报错是老功能的净损失
- 左边洗掉日期后**若还残留标题就拦下来**（`copy_day_only`）：`把明天下午三点的会议复制到周五`
  只说了单条，绝不能静默把一整天都搬过去

`fail()` 加了可选的第二参 `examples`，这样新增的两种失败原因是给复制例句而不是 add 例句；
`App.Input.fail('no_time')` 那个既有调用点不受影响。

### 冲突展示：「同一个框」

`doCopy` 逐条源任务问 `Manager.overlaps(dst, sMin, eMin)`，收成 `{from, to}` 对的数组，
去重后一次问完（不逐对问）。`app.js` 里渲染成
`<li class="conflict-pair">要复制 <b>新名</b> 时间 ／ 已有 <b>旧名</b> 时间</li>`。

CSS 上有个坑：既有的 `.query-list li { display: flex }` 特异性是 (0,1,1)，
单独写 `.conflict-pair { display: block }` 是 (0,1,0)，**会被压掉**，虚线框出不来。
所以选择器写成 `.query-list li.conflict-pair`。

聊天区不做 HTML 净化（`Output._push` 直接 `innerHTML = html`），所以新 class 能透传；
但也因此名字一律过 `escapeHtml`。

### 合并：名字逗号相连 + 时间段并集

`Manager.copyDay(copies, dstDate, mode, pairs)` 是新增的数据层入口，仿 `mergeFromRows` 的做法
**批量 push 后只调一次 `changed()`** —— 逐条走 add/remove 会触发 N 次重渲染。

合并的归属规则（`copyDay` 里最绕的一段）：

1. 先按**旧任务**归拢撞上它的新任务，再给每条旧任务选出**唯一**归属：
   撞它的新任务里排序键最小的那条（键 = `startTime | endTime | createdAt | id`）
2. 一条新撞多条旧 → 几条旧都并进这条新；多条新撞同一条旧 → 只并进开始最早那条
3. 并集按分钟算：`sMin = min(全部 startTime)`、`eMin = max(全部 endTime + endOffset×1440)`；
   `eMin >= 1440` 时减 1440 并把 `endOffset` 置 1（跨天并集）
4. 删旧任务时沿用 `remove()` 的 `suppressed` 语义；副本一律 `dateRule = null, ruleId = null`

第 4 条是必须的：副本若带着 `ruleId`，`materializeRules` 的 `ruleId@date` 去重会把它跳过，
或者反过来在目标日重复展开。复制出来的是**独立的一次安排**，不是规则的新实例。

### 相对设计稿的两处偏差

**一、砍掉了跨天探测。** 原设计写的是「跨天源任务再补一次 `overlaps(dst, 0, eMin-1440)`
测次日半段」，我按这个写完测试才发现它是**假阳性**：它把「次日 00:00–01:00」这半段
按**目标日当天**的分钟数去比，于是会和目标日当天 00:30 的安排判成撞车 ——
可那两条在真实时间轴上差着将近一整天。

改对的话要额外引入「旧任务在次日、分钟数得 +1440」的换算，复杂度上一个台阶。
而 `overlaps` 本来就是同日语义，`doAdd` 的既有检测也是这个范围（它甚至没算 `endOffset`）。
**决定收敛到只比目标日当天**，与既有行为一致，边界写进使用说明。

**二、最终播报补了跳过条数。** 设计稿里「另有 K 项已完成」只出现在冲突询问那一句，
可无冲突时压根不出询问 —— 用户会以为全复制过去了，其实少了几条。改成提交后
在结果里补一句「（另有 K 项已完成，没复制）」。

### 话术与回复词

字符串都写在 `app.js` 里，这里留一份清单便于回头核对措辞（改文案时两处一起改）：

| 时机 | 说的话 |
| --- | --- |
| 撞上了（询问） | `把{源}的 N 项安排复制到{目标}（另有 K 项已完成，不复制），其中 M 对时间撞上了：<ul>…</ul>回复「重叠」…回复「更换」…回复「取消」…` |
| 回复「重叠」 | `好的，N 项安排已复制到{目标}，冲突的也都留下啦。` |
| 回复「更换」 | `好的，R 项撞上的旧安排已合并进新安排（名字用逗号连起来），N 项安排复制到{目标} 啦。` |
| 回复「取消」 | `好的，已取消复制，原来的安排都没动哦。` |
| 没撞上（直达） | `好的，N 项安排已复制到{目标}。` |
| 源日无安排 | `{源}没有安排，没什么可复制的哦。` |
| 源日全 done | `{源}的安排都已经完成了，没有可复制的，就不折腾啦～` |
| 源＝目标 | `{标签}就是它自己呀，不用复制啦～` |
| 提交时源已变 done | `要复制的安排都已经完成了，就不折腾啦～` |
| 目标日已过去（尾注） | `（N 项已经过了时间，先记为已完成）` |
| 待确认时听不懂 | 气泡 `回复「重叠」「更换」或「取消」哦` |

`confirm-copy` 的回复词（第二层 `handlePending` 包装里）：

- 取消：`/^(取消|算了|不要|否|n|no|不用)$/i` —— 原 `handlePending` 的取消分支在类型分发**之前**，
  这里被整段截胡了，所以必须自己认一遍
- 重叠：`/(重叠|都留|都保留|保留|留着)/`
- 更换：`/(更换|替换|换掉|合并|并成)/`
- 其余：气泡提示，`pending` 保留

### 验证

- `test-parse-time.js` 追加第 10/10b/11 组（+18 条）：正例 6 条（含跨月、源日缺省今天）、
  反例 3 条、以及「挪到/改到仍是 update、删掉仍是 delete、抄作业不被误判」的回归。
  结果 **43 / 0**
- 新建 `test-copy-day.js`（48 条）：覆盖无冲突直达、冲突成对展示、
  重叠/更换两种收尾、用户点名的部分重叠并集、一条新撞两条旧、一条旧被两条新撞、
  跨天并集、周期旧任务不复活、源日为空/全 done/源=目标、部分已完成、待确认期间时钟溜走、
  取消与无效回复、提交前重查。其中断言了 `schedule:changed` **恰 1 次**、源日**一条不少**、
  副本 `dateRule/ruleId` **均为 null**。结果 **48 / 0**
- 8 个 vm 套件全绿：43 / 48 / 29 / 33 / 31 / 60 / 15 / 35，全 0 失败
- `e2e-pdf-import.js` 真机跑一遍 **37 / 0**（改动动了 app.js 主流程，值得回归一次浏览器）

### 已知边界

- **撞车只比目标日当天**（见上）。跨天任务落过去时，次日凌晨那半段不和次日的安排比对
- **重复复制会产生重复任务**：复制是生成新副本，不引入去重；第二次复制时冲突询问会兜住
- **合并标题含逗号**：用户明确要求的格式，代价是名称本身含逗号时难辨认
- **只支持整天**：单条复制被 `copy_day_only` 拦住并给例句，将来要支持可从那里扩展
- 一条旧任务被多条新任务撞上时只并进开始最早的那条，其余新任务照原样复制 ——
  这是设计选择（避免一条旧安排被复制成好几份），不是遗漏

---

## 十二、再次收口：设计稿折进本篇

用户要求：整洁项目、删掉不必要的文件、把 `plans/` 的文件整合。与第十篇同一诉求的续集 ——
这次只产生了两项待清理的东西。

### 勘察结论：项目本体是干净的

扫过一遍，没发现任何临时/备份文件（`*.bak` / `*.tmp` / `*~` / `*.orig` / `*.log` / `Thumbs.db`），
也没有上次 e2e 残留的 `tests/_edge_*/` 浏览器目录（`.gitignore` 里那条约 40MB 的规则
这次没被触发）。`claude_DesktopNotepad/` 按第十篇的判断继续保留。

唯一的大件是 `node_modules/`（**51M**）。列进了候选清单，但用户选择保留 ——
删了它 `test-pdf-import.js` 就得先 `npm install`，为了省 51M 让一个回归套件默认跑不了，不划算。
它是 gitignore 覆盖的 dev-only 依赖，不进仓库，留着不影响「项目整洁」。

### `plans/` 从 3 篇回到 2 篇

第三篇 `desktop-pet-整日安排复制.md` 是第十一篇那次 plan mode 留下的设计稿，
用户当时要求「生成的计划 markdown 文档放 plans 中」，所以它落地在这里。
本轮它已经完成了使命，于是折进本篇删掉。理由和第十篇删掉那两篇设计稿**完全一样**：

1. **内容已被第十一篇完整覆盖** —— 需求、三条澄清口径、解析层为什么必须压在意图之前、
   冲突成对展示、合并的归属规则与并集算法、两处实施偏差、验证数据、已知边界，一件不落
2. **它的逐文件改动清单已被代码取代**，且以行号为施工依据的文体天然会随代码改动过期

折叠时补进了第十一篇唯一缺的一块：**话术与回复词清单**（含 `confirm-copy` 的四条回复正则，
以及「原 `handlePending` 的取消分支在类型分发之前、这里被整段截胡所以必须自己认一遍」这个坑）。

顺带修好一个**文档自己已经在说谎**的地方：`使用说明`「项目文件结构」那节和本篇第六篇
都写着「`plans/` 两篇文档」，而实际有 3 个文件 —— 删掉之后这句话自己就准了，
和第十篇结尾那句「删掉之后文档反而变准了」是同一个现象。

### 删除项

| 删除项 | 大小 | 理由 |
| --- | --- | --- |
| `plans/desktop-pet-整日安排复制.md` | 10K | 见上，已折进本篇第十一篇 |
| `_shot/`（当时） | 104K | e2e 与 preview 的产物（打印导出的样本 PDF、下载验证目录）。`.gitignore` 已排除，跑一次 e2e 就重建。现分为 `tests/_shot/` 与 `tools/_shot/` |

第十篇删掉 `_shot/` 之后它又自己长回来了，这正好说明它**确实是纯产物**、删了没有信息损失。

### 验证

8 个 vm 套件重跑一遍确认删除没碰到运行时代码：43 / 48 / 29 / 33 / 31 / 60 / 15 / 35，全 0 失败。
本轮只动文档和产物目录，**没有改任何项目代码**。

---

## 十三、本地大模型接入（Ollama）

用户要求：给这个纯前端的日程助手接一个**本地**模型（Ollama，默认 `qwen3:4b`），做到
① 宠物对话 / 陪伴聊天 ② 自然语言建日程 ③ 结合日程回答用户问题；另外把 `vdio/` 里那段
视频处理成 `videos/talking.webm`，**只在连着模型说话时**播放。

四项决策由用户明确给出：

1. 默认模型 `qwen3:4b`，测试与验证**只针对 4b**
2. **显式开关，默认关闭** —— 关着时按原样运行，行为逐字不变
3. 与用户交流时播放角色视频作为视觉反馈
4. `App.Config` 只做增量追加；日程 / 背景 / 壁纸逻辑零改动

本轮 plan mode 留下的设计稿 `Claude'sPlan.md` 已折进本篇删掉，理由同第十、十二篇：
内容已被本篇覆盖，且逐文件改动清单以行号为施工依据，天然会随代码过期。

### 为什么这个代码库接得进

- 所有用户文本只有 `App.Controller.handle` 一个入口，未识别文本有明确的兜底分支
- 已有意图契约（`dialog/input.js`）和纯函数解析器 `App.Input.parse`，天然是「离线第一道」
- `App.Manager` 的 add / update / remove / query / copyDay 全部带校验，是现成的工具调用面
- `StateMachine.enqueueTemp` 是单锁队列，tick 不覆盖临时态 → 新增一个临时态类型无副作用
- 已有 Promise 异步路径（PDF 导入）、vm 沙箱测试基建、设置持久化白名单写法

### 三条纪律

写在 `dialog/llm.js` 文件头，改这个文件之前先读：

1. **开关默认关。** `enabled=false` 时不发任何请求，Controller 兜底分支的文案保持逐字不变
   —— 离线可用是产品承诺，模型只是锦上添花
2. **正则优先。** 只有 `Input.parse` 没接住的文本才进 `llm.js`；识别出来的日程意图一律交回
   `Controller.routeIntent`，走既有 `do*` 处理器。**`llm.js` 不直接调用 `App.Manager` 的写接口**
   —— 模型因此不可能产生第二条写库路径，冲突检测、候选消歧、确认流程全部复用
3. **提示词不出局域网。** 端点在 `sanitizeConfig` 里按回环 / 私网白名单校验
   （`localhost` / `127.*` / `::1` / `10.*` / `192.168.*` / `172.16-31.*`），
   经 `u.origin` 去掉凭据与路径，localStorage 被篡改也发不出去

### 路由决策树

```
Controller.handle(text)
├─ empty / pending / 常规流程均不变
├─ intent = Input.parse(text, {now})           离线正则，即时
│  ├─ ok → routeIntent(intent)                 新方法 = 原娱乐拦截 + switch 原样搬入
│  └─ !ok → App.LLM.tryRoute(text)
│            │  同步返回 true 表示已接管（异步干活）
│            ├─ 开关关 / ?nollm=1 / 没连上 → 同步 false，零提示
│            ├─ 提取出合法日程意图 → Controller.routeIntent(归一化后, {confirm:true})
│            │      ├─ 写操作（添加/修改/删除/复制）→ 复述挂起，等「确认」才进 do*
│            │      └─ 查询只读 → 不拦，直接进 doQuery
│            ├─ 判成闲聊 → Chat.send(text)      流式回复，只读
│            └─ 提取失败（超时 / 连不上 / 解析不出）
│                 ├─ 网络类错误 → 状态降级 + 每会话一条提示
│                 └─ 原话退回 replyUnparsed     ← 见「十几秒的等待必须给反馈」
└─ tryRoute 返回 false → 原样输出「没太听懂」文案 + maybeHint()
```

`routeIntent` 是从 `handle` 里**原样抽出来**的（娱乐拦截块 + switch），行为零变化。
掏出来是因为模型路径也要走同一套分发，不能有第二份。

### 模型解析出的写操作，先复述再执行

**需求**：功能操作（建日程那类）要先让模型把理解的结果交用户确认，再返回给程序执行；
日常聊天和问答直接答。

**做法**：`routeIntent(intent, opts)` 加了第二参数，模型通路传 `{confirm:true}`。
进来的写操作（add / update / delete / copy）不执行，而是挂成
`pending = {type:'confirm-intent'}`，用 `describeIntent()` 把意图字段拼成一句人话复述出来：

```
我理解你要添加 明天 15:00–16:00「项目评审会议」，对吗？（回复「确认」或「取消」）
```

- **复述文案由字段拼装，不让模型自己措辞** —— 这个确认框本身就是防它理解错的，
  再让它来写这句话就白防了
- **query 不拦**：只读，答错了顶多白看一眼；闲聊同理
- **add 缺时间不拦**：`doAdd` 自己会问「要安排在几点呢？」，再拦一层是废话
- **回复既不是确认也不是取消**（用户多半在纠正理解）→ 撤掉待确认，
  把这句话当新指令重放一遍。为此时 `handle(text, {echo:false})` 加了静音选项，
  否则纠正的那句话会在聊天记录里出现两次
- 确认后走 `routeIntent(intent)`（不带 opts），重叠询问、候选消歧这些既有的二次确认照常触发

`pending` 是**唯一会话位**，与重叠确认、消歧、导入确认共用。因为 `handle` 开头
`if (this.pending)` 就把消息截走，模型不可能在待确认期间又插一条进来。

**验证**：`test-llm.js` 第 9 组加 13 条断言（挂起不落库 / 复述含日期与标题 / 确认后入库 /
取消后不动 / 纠正重放且只上屏一次 / query 不拦 / 标题尖括号转义）；`test-llm-live.js` 第 2 组改成
真模型下的完整确认流程（挂起 → 复述 → 回「确认」→ 入库）。
**注意 `test-llm-live.js` 包装 `routeIntent` 时必须原样转发 `opts`**——
第一版包装函数只收一个参数，`{confirm:true}` 被吃掉，确认门被静默绕过，
测试会「通过」一个根本不存在的直接入库行为。

### 实测：think:false 没用，format 才有用

（qwen3:4b / Ollama 0.34.4 / 纯 CPU）

- **`think:false` 并不会关掉 qwen3 的思考** —— 它只是把思考从 `message.thinking` 搬进
  `message.content`，`/no_think` 软开关同样无效。不加约束的闲聊实测 35 秒全程内心独白
- 真正管住它的是 **`format` 结构约束**：
  - 意图提取用 `format:'json'` → 1~5 秒，输出干净
  - 闲聊用 `{type:'object',properties:{reply:{type:'string'}},required:['reply']}`
    → 首字 0.3~3 秒，零泄漏
- 加了约束之后，**聊天就不再是纯文本流，而是 JSON 字符串流**：要边收边解 `{"reply":"…"}`
  里的转义字符串。`replyReader()` 就是干这个的 —— 逐字符状态机，处理
  `\n \t \r \b \f \" \\ \/ \uXXXX`，能应对转义序列正好被切在 chunk 边界的情况；
  解出多少先渲染多少，视觉上仍是逐字回复
- Markdown 渲染**先 `escapeHtml` 全量转义、再做行内替换**，所以模型原文里任何 `< > &`
  都不可能以标签形式进 DOM（`Output._push` 是直接 `innerHTML`，这里是唯一的防线）。
  引用类边界用了 `一-龥` 字符类做词边界，否则 `3*4=12 还没写完 **` 里的单星号
  会被当成强调符吃掉半句话

### 提示词重点：日程上下文越长，模型越想「汇报日程」

**现象**：用户连上模型后问「现在几点」，得到的是「你好呀！今天体能训练进行中，马上要结束啦」。

**根因在提示词，不在路由**（实测确认「现在几点」走的是闲聊通路，路由没错）。
旧版 `chatSystem()` 只有一句「回答**日程相关**问题时以上面的安排为准」——等于没规定
非日程问题怎么答；加上开头整段人设（桌面宠物、温和、口语化）和一大段日程上下文，
qwen3:4b 就顺着最显眼的「正在进行」那行往下编。复现过程：日程从 2 条加到 10 条后，
空历史问「你好呀」，回复变成「你好呀！今天体能训练进行中，要记得 21 点前结束哦～」，
与用户报的一字不差；同一条提示词下「现在几点」在 temp 0.7 采样里时对时错，
用户抽中的就是错的那个分支。

**改法**：把「直接回答用户问的那件事」挪到提示词最前面，点名失败场景
（「尤其不要把『现在几点』这类问题答成日程汇报」），人设退到第二位，
再补一句「用户没问日程时不用主动汇报正在进行的任务」。没有加 few-shot——
示例里写死的时刻会被 4B 模型照抄进答案，比没有示例更糟。

**验证**（真实模型，temp 0.7）：空历史「现在几点」3/3、带两轮历史 6/6，
全部只答时间、不再夹带日程；对照组「我明天有什么要做的」仍能列全 5 条安排。
`test-llm-live.js` 新增第 7 组把这个场景钉住（软断言：回复里必须出现时间本身）。

### 十几秒的等待必须给反馈

**瓶颈是 prompt eval，不是模型加载。** 意图提示词 643 token，实测
`prompt_eval 9.5s + eval 3.2s ≈ 13s`，而 `load_duration` 近乎 0。GPU 上快一个量级。

第一次跑联网测试就被这条打脸了：原计划 `intentTimeoutMs: 15000`，实测 **15014ms 撞线**，
用户那句话被静默丢弃。三处修复：

1. `intentTimeoutMs` 15s → **30s**。卡 15s 会让这功能在没独显的机器上直接不可用
2. 提取期间也切 `talking` 循环态 + 「让我想想…」气泡，消掉那十几秒的静默。
   `enqueueTemp` 按 `type + taskId` 去重，`Chat.send` 随后再开一次是空操作，交界处不会闪断
3. 提取失败时**把原话退回离线通路** —— `Controller` 里原本内联的兜底文案抽成
   `replyUnparsed(intent)`，两条路复用同一套话术。没有这一步，用户等了十几秒
   连一句「没太听懂」都收不到

第 3 条同时兜住了超时、连不上、输出解析不出三种失败，以及 `tryRoute` 内部抛异常。

### 徽章、竞态与降级

- **探活序号 `checkSeq`**：慢探活在用户已经关掉开关之后才 resolve，会把状态设成 `ok`，
  而 `renderLlmStatus` 原本不看 `enabled` 就画「已连接」。加序号后过期结果直接丢弃，
  `settle` 前再复查一次 `enabled`
- **「已连接，但没有 xxx」**：模型名是手输的，打错一个字母时服务器仍然是通的，
  只显示绿色的「已连接（N 个模型）」会骗人。名字不在 `/api/tags` 返回的清单里就单独报
- **`relaxLocator`（幻觉缓解）**：模型给的定位条件（日期 + 标题 + 时间）查不到时，
  逐级放宽——先丢时间、再全池按标题查，避免「明明有这条却说要新建」
- **`maybeHint`**：连不上时每会话最多一条系统提示，靠 `_noted` 去重，
  离线兜底路径和模型路径都调它，不会重复刷屏

### 设置里那个 `llm` 键不能丢

`desktop_pet_settings` 这一个键里现在装着三样东西：`bg` / `wallpaper` / `llm`。
麻烦在于既有的 `selectBg` / `clearBg` / `selectWallpaper` 等调用点**只传 `{bg, wallpaper}`** ——
`save()` 要是照参数原样序列化，用户换个壁纸就会把 llm 开关和端点一起抹掉。

做法是模块级留一个 `llmCurrent`，`save()` 落盘时无脑带上 `llm: llmCurrent`。
这样所有既有调用点一行都不用改，换壁纸天然不会碰 llm 配置。
`load()` 返回值里也加了 `llm`，`sanitizeLlmSettings` 兜非法值（`enabled` 只认显式 `true`）。

顺带一提，这个改动让两个存储类测试套件红了：它们原先拿**整串 JSON** 跟期望值比对，
多一个键就不等。改成只比对关心的字段（`test-wallpaper` 60、`test-stage-background` 31）。
这是预期后果不是回归 —— 每个设置多键共存，将来再加设置项不用再改一遍期望值。

### talking.webm 怎么来的

用户提供了一段 mp4（`vdio/`，本轮已删）。处理后与现有素材同规格：
**720×720 / 24fps / 6.04s / VP9-alpha / 1.04MB**。

判 alpha 是否真的在，**看 ffprobe 的 tag 而不是 `pix_fmt`**：VP9-alpha 会被报成
`pix_fmt=yuv420p`，真正的判据是 `alpha_mode=1`（与 idle / done 等既有素材一致）。
编码那步 `-auto-alt-ref 0` 不能省，否则 alpha 失效、透明背景变纯黑。
完整制作流程在使用说明第十七节，素材规格清单在 `videos/README.md`。

`talking` 是**唯一循环播放的临时态**：回复要几秒就循环几秒，由 `endTemp('talking')`
主动收尾，`tempMs.talking`（90s）只是兜底上限。原设计稿是 `TEMP_VISUALS` 里加一行
`talking: 'alert'` 复用举手素材，有了真素材就不需要了。

### 与设计稿的偏差

| 设计稿 | 实际 | 原因 |
| --- | --- | --- |
| `TEMP_VISUALS` 追加 `talking: 'alert'` | 不做，注册独立状态 + 真实素材 | 用户提供了专门的对话视频；`STATES` 加一项、`playTemp` 支持 `opts.loop` 即可 |
| `tempMs.talking = 2500` | **90000** | 它是循环临时态，由回复返回时主动收尾，这个值只是兜底上限，取 `chatTimeoutMs` |
| `intentTimeoutMs: 15000` | **30000** | 见上，15s 在纯 CPU 上直接撞线 |
| Controller 兜底分支内联文案 | 抽成 `replyUnparsed(intent)` | 模型失败要把原话退回同一条通路，两处复用 |
| 顶部工具栏放预设模型下拉 | **删除**，模型名在 ⚙ 面板手输（输入框自带 datalist 补全） | 预设只有三个、且只有 `qwen3:4b` 实测过，摆在下拉里等于暗示另两个等价；手输反而能对接任意本地模型 |

### 验证

- 新建 `tests/test-llm.js`（**169 条**）：fetch 全打桩，毫秒级，管逻辑与契约。
  覆盖 `sanitizeConfig`（恶意 URL / 带凭据 / 非法模型名回落）、`mdToHtml` 的 XSS 与长度上限、
  `replyReader` 的分块与转义边界、`parseNdjsonChunk` 的半行与垃圾行、
  意图提取的重试与拒绝路径、Controller 兜底流（开关关 → 原文案且零请求）、
  `?nollm=1` 调试开关，以及**开关按钮 → 落盘 → 探活**这条用户真正走的路
- 新建 `tests/test-llm-live.js`（**32 条**）：真连 Ollama 跑完整链路 —— 意图确认门 /
  流式闲聊（首字延迟、不泄漏 JSON 骨架与思考过程）/ 多轮记忆 / 查询意图走真实 `doQuery` /
  聊天上下文带上日程 / 明显闲聊不落库 / 问事实不答非所问（见上「提示词重点」）。
  连不上或没 pull 模型 → 打印原因、**退出码 0**、不拖累离线回归
- 全量回归 10 个套件全绿：43 / 48 / 60 / 31 / 169 / 33 / 29 / 15 / 35 / 37（e2e 真 Edge），
  外加联网的 32。**532 项断言**
- 修掉一处**时间炸弹**：`test-pdf-import` / `test-timetable-import` / `e2e-pdf-import` 三个套件
  一直在用 `Date.now()` 跑，而 `data/schedule_template.csv` 里那三条写死的单次日程
  （2026-09-27 / 10-02 / 10-03）到 2026-10-09 全部变成「已过去」被跳过，导入条数 62 → 60，
  三个套件一起变红。**与本次改动无关，是夹具日期腐烂。** 三处时钟已钉在模板基准日
  `2026-09-20`（e2e 走 URL `?time=09:00&date=2026-09-20&freeze=1`；注意 `Clock.init`
  只认带 `time` 的 `date`，光给 `date` 不生效）。**改模板日期时这三处基准日要同步改**
- 顺带修：`test-wallpaper` / `test-stage-background` 的存储断言过期（见上「设置里那个 `llm` 键不能丢」）

### 已知边界

- **联网测试有抖动**：6 次实跑里 5 次全绿，1 次挂 1 条。4B 模型即使 `temperature=0.1`
  也会偶尔改判意图，这是模型行为不是代码回归。为此所有分类断言失败时都会打印模型
  实际返回的意图对象，便于下次一眼分辨
- **DOM 层没有机器验证**：按钮变绿、面板展开、`talking.webm` 真的循环播起来 ——
  这些只有 vm 沙箱外的真实浏览器能看到，需要人眼过一遍
- **纯 CPU 上慢**：一次加日程约 13 秒。功能可用，但谈不上快，这是本地小模型的固有成本
- **只实测了 `qwen3:4b`**：换其他模型不承诺同等效果，提示词和 `format` 约束都是针对 4b 调的
- **`file://` 打开需要 `OLLAMA_ORIGINS=*`，且设完必须重启 Ollama 进程**：
  页面 Origin 为 `null`，Ollama 默认拒绝（实测 403）。环境变量只在进程启动时读一次，
  托盘里那个跑了很久的 Ollama 不会自己更新——这是「设置明明生效了却还连不上」的常见原因
- **4B 模型多轮下会复读**：实测 4 次带历史对话里，有 1 次把上一轮的答案原样搬给下一个问题
  （temp 0.7 采样抖动，非代码回归）。答非所问的提示词级修复挡住了主要场景，
  但复读这种采样噪声只能靠调低 temperature 或换更大的模型
- **「现在几点 / 今天几号」仍走模型**：答案在 App 时钟里是确定的，做成离线正则快路
  （快、永远对、断网可用）会更稳，但那要给意图体系加新成员，本轮没做
- 输入框 120 字上限未动（指令够用，聊天回复不受限）

---

## 十四、目录重组：测试与工具分家

### 起因：一个名字在说谎

`_scratch/` 是项目起步时起的名字，那会儿里面确实只有临时探针。但到这一轮，它装着
11 个回归脚本（532 条断言）、两个素材生成器和一份 npm 依赖清单 —— 全是**长期资产**，
没有一样是「草稿」。名字和内容对不上，看仓库的人会低估这套测试的分量。

于是按职责拆开：`tests/` 放测试，`tools/` 放生成器。

### 绕不开的约束：`node_modules` 只能落在根目录

拆之前先把各脚本的 `require` 列了一遍：

| 脚本 | 外部依赖 |
| --- | --- |
| `test-pdf-import.js`、`test-timetable-import.js` | `pdfjs-dist`（解析 PDF，验证导入回环） |
| `gen-schedule-pdf/gen.js` | `pdfkit`（渲染模板 PDF） |
| 其余 9 个 | 只有 Node 内置模块 |

Node 找包是**从脚本所在目录逐级向上**找 `node_modules`。`tests/` 与 `tools/` 是平行的兄弟目录，
依赖留在 `tools/` 里，`tests/` 那两个 PDF 测试就找不到 `pdfjs-dist`。唯一的共同祖先是仓库根目录，
所以 `package.json` / `package-lock.json` / `node_modules` 一起提上来。

这不是我原本想选的布局（根目录多个 `package.json`，容易让人以为应用要装东西），
所以 `description` 里写死了「desktop-pet/ 本体零依赖，跑应用不需要这个文件」。

### 动生成产物时，改一处不够

`desktop-pet/schedule/scheduleTemplate.js` 和 `desktop-pet/lib/pdfjs/cmaps.js` 都是**生成产物**，
头部注释写着生成器路径。这两处必须改**两遍**：一遍改产物本身（让当前文件是对的），
一遍改生成器里的模板串（让下次重新生成不会退回去）。只改前者，跑一次 `npm run gen:pdf`
旧路径就写回来了。

同理，`gen-cmaps.js` 里 `path.join(ROOT, '_scratch', 'node_modules', ...)` 是**代码不是注释**，
漏掉它生成器直接跑不起来 —— 这类只在「搬目录」时才会暴露的引用，注释和代码得分开数。

### 新增：一条命令跑全套

原来要验回归，得从文档里复制 10 行命令。新增 `tests/run.js`：起子进程跑完 9 个离线套件、
汇总成一张表，任一失败即以退出码 1 结束；失败时还会把该套件里的 `✗ / 失败 / Error` 行摘出来，
省得再手跑一遍才知道是崩了还是断言挂了。

`npm test` 只跑离线的 9 个（463 条，几秒出结果）。要真浏览器 / 真模型的各自单独跑：
`npm run test:e2e`、`npm run test:live`，或 `npm run test:all` 一起。

两个 PDF 测试原本是裸 `require('pdfjs-dist/...')`，`node_modules` 不在时会甩一坨
`MODULE_NOT_FOUND` 堆栈。既然现在 `npm test` 会连它们一起跑，加了 try/catch 换成一句人话。

### 删除项

| 删除项 | 大小 | 理由 |
| --- | --- | --- |
| `_scratch/_shot/` | 104K | e2e 与 preview 的产物。`.gitignore` 已排除，跑一次就重建 |

审计过的其余候选，用户选择保留：

- `claude_DesktopNotepad/`（540B）——与应用无关，但使用说明的目录树里本来就登记着它，删了要同步改文档
- `_scratch/node_modules/`（51M）——删了不污染仓库（本来就 gitignore），但重新生成模板 PDF 前必须联网重装

### 顺带发现：两个素材是同一份文件

`videos/studying.webm` 与 `videos/working.webm` 的 **md5 完全相同**（`0af309c6...`，各 638KB）。
`working` 是真实状态（工作类与通用类任务都走它），**不能删** —— 删了会掉到 SVG 兜底。
所以只记录、不动。真想要两套独立动画，换掉 `working.webm` 即可。

### 验证

移动后全量重跑，**没有一处因为换目录而挂**：

| 套件 | 结果 |
| --- | --- |
| 9 个离线套件（`npm test`） | 463 / 0 |
| `e2e-pdf-import.js` | 37 / 0 |
| `test-llm-live.js`（真 Ollama） | 32 / 0 |

路径深度是这次敢直接搬的关键：`tests/` 与 `tools/gen-schedule-pdf/` 跟原来的
`_scratch/` 和 `_scratch/gen-schedule-pdf/` **同层**，脚本里那句
`path.join(__dirname, '..', 'desktop-pet')` 一个字都不用改 —— 事前逐条核对过才动的手。

`.gitignore` 的临时产物规则跟着换位（`tests/_edge_*/`、`tests/_shot/`、`tools/_shot/`），
用真实目录验证过三条规则都生效（空路径字符串测不出来，`check-ignore` 对不存在的目录会漏判）。

### 文档处理：路径改，叙述不改

本篇此前所有条目里的 `_scratch/...` 路径**已统一改写为新路径**，否则读者按图索骥会找不到文件。
但**叙述内容没有动**：第六篇那份「5 个 vm 测试脚本」「共 23 文件」是当时的实情，
改了就是伪造记录 —— 这正是开头那句「文中的测试通过数是当时快照」的意思。
第十篇提到的 `_edge_parse/` 等三个目录同理，是当时确实存在过、后来被删掉的东西。
