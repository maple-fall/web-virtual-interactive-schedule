# video/ — 桌宠视频素材处理工具

把 AI 生成的视频（豆包等）批量处理成角色目录可直接使用的
**VP9 + alpha 透明 WebM**：去水印 → 白底转透明 → 720×720 / 24fps 编码 → 校验 alpha。

产出的文件不用改任何代码，放进 `desktop-pet/videos/zhenzhu/`（或你在
`character/builtin.js` 里登记的角色目录）即可被
[`character/animation.js`](../../desktop-pet/character/animation.js) 加载。

## 目录内容

| 文件 | 用途 |
| --- | --- |
| `make_pet_videos.py` | 主脚本：去水印、抠背景、编码 VP9-alpha |
| `char_pack.py` | 形象包工具：把 `videos/` 打成 zip、把 zip 安装回目录、查看包内容 |
| `ffmpeg.exe` | Windows 版 ffmpeg（84MB，已加入 `.gitignore`，不随仓库提交） |
| `assets/doubao_watermark.npz` | 豆包「豆包AI生成」水印的 alpha 模板 |
| `README.md` | 本文档 |

## 依赖

Python 3.10+：

```bash
pip install numpy opencv-python-headless scipy
```

ffmpeg 按以下顺序自动查找，找一个就行：

1. `--ffmpeg <路径>`
2. 环境变量 `FFMPEG`
3. `tools/video/ffmpeg.exe`（Windows）
4. `PATH` 里的 `ffmpeg`
5. 已安装的 `imageio-ffmpeg` 包

需要支持 `libvpx-vp9` 的 ffmpeg（官方 gyan.dev / BtbN 构建都可以）。
本目录自带的 `ffmpeg.exe` 来自 `imageio-ffmpeg`，已验证可用。

## 快速开始

```bash
# 处理整个目录（文件名必须是七种状态名之一）
python tools/video/make_pet_videos.py new_video --out new_video/processed

# 只处理一个文件
python tools/video/make_pet_videos.py "new_video/studying .mp4" --out new_video/processed

# 输出直接写进内置形象目录（会覆盖同名素材；先跑 char_pack.py pack 备份）
python tools/video/make_pet_videos.py new_video --out desktop-pet/videos/zhenzhu
```

Windows 下如果终端中文乱码，运行前加 `PYTHONIOENCODING=utf-8`。

`new_video/processed/` 只是**临时输出目录**（已加入 `.gitignore`）：把里面的 webm
拷进 `desktop-pet/videos/zhenzhu/` 后就可以删掉，仓库不再保留这份与成品重复的副本。

### 输入命名

文件名（去掉扩展名、空格、大小写后）必须是：

`idle` / `studying` / `working` / `alert` / `done` / `refuse` / `talking`

例如 `studying .mp4`、`Alert.MP4` 都能识别；其它名字会跳过并提示。
输出统一命名为 `<状态>.webm`，与源文件扩展名无关。

输入目录只扫一层（不递归），接受 `.mp4` / `.webm` / `.mov` / `.mkv` / `.avi`。

### 输出规格

- WebM，VP9，`yuva420p`（透明通道）
- 720×720，24fps，无音轨
- 文件名即状态名
- 脚本结束时会打印每个文件的帧数、时长、体积、pix_fmt 和实际 alpha 分布；
  任一文件没有透明像素会给出警告

## 处理流程

1. **抽帧**：`ffmpeg -vf fps=24`，丢掉音频，保留 PNG 原始尺寸。
2. **去水印**：逐帧在右下方、左上方两个候选位置做匹配滤波。
   模板是带符号的 alpha（正值=白色笔画，负值=投影），得分高于
   `--watermark-high` 的帧确认为水印，再向两侧延展到低于
   `--watermark-low` 为止；按 alpha 足迹生成掩膜，用
   `cv2.inpaint(TELEA, radius=7)` 只修补笔画覆盖的像素。
3. **白底转透明**：亮度 `>= 255 - --tol` 且**与画面四边连通**的区域判为背景；
   角色内部的白色（眼睛高光、衣服）不会被抠掉。边缘做 1px 腐蚀 + 0.8px 羽化。
4. **编码**：`libvpx-vp9`，`-crf 34 -b:v 0 -auto-alt-ref 0 -cpu-used 2`。
   `-auto-alt-ref 0` 不能省，否则 VP9 的 alpha 不生效、透明区域会变黑。
5. **校验**：用 `libvpx-vp9` 解码器重新读文件，确认 `yuva420p`，
   并解一帧统计 alpha 的最小/最大值和透明像素占比。

中间帧默认放在输出目录下的临时目录里，处理完自动删除；加 `--keep-frames`
可保留，便于排查。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `input` | 必填 | 输入目录或单个视频文件 |
| `--out` | 必填 | 输出目录 |
| `--ffmpeg` | 自动 | 指定 ffmpeg 路径 |
| `--fps` | `24` | 抽帧/编码帧率 |
| `--crf` | `34` | VP9 质量，越大体积越小、越糊；体积超 3MB 可调到 36–38 |
| `--tol` | `32` | 白底容差；背景没抠干净调大，角色白色被吃掉调小 |
| `--feather` | `0.8` | 边缘羽化（像素） |
| `--watermark` | `assets/doubao_watermark.npz` | 水印模板 |
| `--watermark-high` | `0.05` | 水印命中阈值；漏删调低，误伤调高 |
| `--watermark-low` | `0.02` | 淡入淡出延展阈值 |
| `--no-watermark` | 关 | 跳过去水印 |
| `--no-bg` | 关 | 跳过抠背景（只转码） |
| `--keep-frames` | 关 | 保留中间帧 |

## 水印模板说明

`assets/doubao_watermark.npz` 按 **720×720 豆包「豆包AI生成」水印**标定，
只覆盖实测出现的两个位置：

- 右下角：笔画左上角约 `(590, 668)`
- 左上角：笔画左上角约 `(22, 15)`

模板内容：

| 键 | 形状 | 含义 |
| --- | --- | --- |
| `alpha` | `(38, 122)` float32 | 带符号 alpha，正值白色笔画，负值阴影 |
| `box` | `[x0, y0, x1, y1]` | 标定帧里水印的绝对包围盒 |
| `ref_glyph` | `[x, y]` | 标定帧里笔画左上角坐标 |

脚本只用 `alpha`，以及 `offset = box[:2] - ref_glyph`（当前为 `(-6, -6)`）。
遇到别的水印（工具不同、字号不同、位置不同）时：

- 换工具/尺寸：需要重新标定模板，或加 `--no-watermark` 后手动处理；
- 同款水印但位置略有偏移：脚本会在候选窗口内自动搜索，通常不用改。

## 装进项目

```bash
cp new_video/processed/*.webm desktop-pet/videos/zhenzhu/
```

刷新页面即可（`Ctrl+F5`）。如果素材没生效：

- 控制台出现 `[Animation] 已启用视频素材 videos/*.webm` 说明加载成功；
- 出现 `未找到可用视频素材` 检查文件名、路径和文件大小；
- 单个文件建议 < 3MB，临时态还有时长上限：alert 5s / done 3.5s / refuse 2.5s，
  超出部分不会播放。基础态（idle/studying/working）循环播放，首尾帧尽量接近。

## 形象包（char_pack.py）

应用顶部「更换形象」支持直接导入 zip 形象包（存浏览器 IndexedDB，点选即时切换，
详见 [使用说明第十七节](../../plans/desktop-pet-使用说明.md#十七虚拟形象自定义)）。
`char_pack.py` 负责磁盘侧，只用标准库，不需要 numpy/opencv：

```bash
# 默认把 desktop-pet/videos/zhenzhu/ 打包成 desktop-pet/videos/默认形象-紫发少女.zip
python tools/video/char_pack.py pack
# 指定形象名（同时作为 zip 文件名）
python tools/video/char_pack.py pack --name "我的角色" --videos 某目录 --out desktop-pet/videos

# 查看包里的 manifest 与状态视频
python tools/video/char_pack.py list desktop-pet/videos/zhenzhu.zip

# 把 zip 固化进 videos/zhenzhu/（覆盖前自动备份到 videos/_backup_<日期>/）
python tools/video/char_pack.py install 我的角色.zip
```

| 子命令 | 关键参数 | 说明 |
| --- | --- | --- |
| `pack` | `--name`（默认「默认形象-紫发少女」）、`--author`、`--version`、`--note`、`--out`、`--method stored\|deflated`、`--videos` | 按状态顺序收集 `.webm`（优先）或 `.mp4`，写 `manifest.json`；`--videos` 默认 `desktop-pet/videos/zhenzhu/`，`--out` 默认 `desktop-pet/videos/` |
| `install` | `zip 路径`、`--videos` | 归一识别状态（first wins），只写 basename 防路径穿越；`--videos` 默认 `desktop-pet/videos/zhenzhu/` |
| `list` | `zip 路径` | 打印 manifest + 每个条目识别出的状态与大小 |

- `pack` 只扫素材目录**顶层**，文件名必须是精确的 `<状态>.webm` / `<状态>.mp4`；
  不做空格/连字符归一化（应用内导入和 `install` 才会归一化）。
- **默认 STORED**：视频本身已经压缩过，deflate 收益很小；STORED 不依赖浏览器的
  `DecompressionStream`，兼容性最好。确实要压就用 `--method deflated`。
- `pack` 的素材来源默认是 `desktop-pet/videos/zhenzhu/`，产物默认落在
  `desktop-pet/videos/`；可用 `--videos` / `--out` 改。
- `install` 默认安装到 `desktop-pet/videos/zhenzhu/`，只覆盖 zip 里出现的状态，
  其余素材保持不动；旧文件先复制到 `videos/_backup_<YYYYMMDD>[_HHMMSS]/`。
- Windows 终端中文乱码时，运行前加 `PYTHONIOENCODING=utf-8`。
- 应用内导入的校验是宽松的：允许任意状态子集、允许一层包裹目录；缺 `idle` 会给警告，
  缺其它状态用包内 `idle` 顶替。单个视频 ≤10MB、合计 ≤50MB、zip ≤60MB。

## 常见问题

**ffmpeg 探测显示 `yuv420p`，是不是 alpha 丢了？**
不是。ffmpeg 内置的 `vp9` 解码器不读 alpha，直接 `ffmpeg -i x.webm` 会误报。
要这样查：

```bash
tools/video/ffmpeg.exe -c:v libvpx-vp9 -i desktop-pet/videos/zhenzhu/idle.webm
```

看到 `yuva420p` 才准。脚本内部已经按这个方式校验，并额外解帧检查 alpha 分布。

**背景还留着一圈白边 / 灰底没抠掉**
白边：把 `--tol` 调大 4–8。灰底：本工具只处理接近纯白的背景，
灰色背景需要换抠图方案（见 `plans/desktop-pet-使用说明.md` 第十七节）。

**角色的白色部分被抠没了**
`--tol` 调小（如 24），或检查背景是不是被 AI 生成了浅灰渐变。

**水印有残留**
把 `--watermark-high` / `--watermark-low` 调低（如 0.04 / 0.015）。
如果残留在淡入淡出帧，优先调低 `--watermark-low`。

**水印压在头发上，修补后有一块模糊**
水印不透明时底层纹理已经丢失，只能靠周围像素补，近看会有轻微涂抹感；
1× 播放尺寸下通常不明显。可以把 `--watermark-high` 调低确保不漏删，
或换更高质量的源视频。

**体积超过 3MB**
调高 `--crf`（36–38），或先裁掉临时态用不到的部分（如 refuse 只保留前 2.5s）。

## 相关文档

- 素材规格与调试：[desktop-pet/videos/README.md](../../desktop-pet/videos/README.md)
- 完整制作流程与抠图脚本：[plans/desktop-pet-使用说明.md](../../plans/desktop-pet-使用说明.md)
