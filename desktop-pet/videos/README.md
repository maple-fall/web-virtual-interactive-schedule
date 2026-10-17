# videos/ — 角色动画素材

> **本文档负责**：要放哪些文件、每个文件什么用途、素材必须满足什么规格、页面里不生效时查哪条日志。
> **制作流程**在 [使用说明第十七节](../../plans/desktop-pet-使用说明.md#十七虚拟形象自定义)：
> 「从一张网图到形象包」（豆包生成 → tools 处理 → zip 导入）。
> 工具的处理步骤、参数和排错见 [tools/video/README.md](../../tools/video/README.md)。

本目录放着两套可直接使用的角色动画（透明背景，720×720 / 24fps，单段 4–10 秒）：

| 路径 | 用途 |
| --- | --- |
| `zhenzhu/` | 应用内置的默认形象 zhenzhu（7 个 WebM） |
| `zhenzhu.zip` | zhenzhu 的 zip 版，可在顶部「更换形象」里重新导入 |
| `_backup_20261017.zip` | 旧版紫发少女素材的 zip 版，可作为第二个形象导入 |

内置形象直接按路径读取，不需要导入；想换成自己的素材，替换 `zhenzhu/` 下的文件即可，
**不需要改任何代码**。也可以另建一个目录，在 `character/builtin.js` 里登记成新的内置形象。

文件不存在时项目也不会报错：`character/animation.js` 探测失败后会自动降级到
内置的 SVG 卡通小猫 + CSS 动画，七种状态一样能正常切换。

## 需要的文件

| 文件名 | 状态 | 触发场景 | 当前素材内容 |
| --- | --- | --- | --- |
| `idle.webm` | 空闲 | 无任务安排的时段 | 托腮侧卧、轻微呼吸摆动（带小气流） |
| `studying.webm` | 学习中 | 学习类任务时段 | 坐在书桌前用笔写字（场景素材） |
| `working.webm` | 工作中 | 工作类 / 通用类任务时段 | 端着茶杯喝茶 |
| `alert.webm` | 提醒 | 任务开始播报（临时态） | 举手挥动 + 感叹号 |
| `done.webm` | 完成 | 任务结束播报（临时态） | 闭眼笑、双手合拢 |
| `refuse.webm` | 拒绝 | 任务时段内提出娱乐请求 | 皱眉生气、握拳，配合 CSS 抖动与红色氛围 |
| `talking.webm` | 交流中 | 本地模型正在组织回复（临时态） | 说话/讲解手势，循环播放到回复结束 |

## 素材要求

- **首选格式：WebM（VP9 + alpha 通道，`-pix_fmt yuva420p`）**，透明背景
- 也支持 `.mp4`，但必须是 **H.264**。实测 HEVC（H.265 / `hvc1`）在 Chrome / Edge
  无法解码（`MEDIA_ERR_SRC_NOT_SUPPORTED`），放进去只会触发降级
- 加载顺序：`<状态>.webm` → `<状态>.mp4` → 内置 SVG，逐级回退
- 单个文件建议 < 3MB，避免本地加载卡顿
- 命名区分大小写，必须与上表完全一致
- 基础态（idle / studying / working）会被循环播放，首尾帧需能自然衔接
- 临时态（alert / done / refuse）播完一轮即结束，同时受 `App.Config.tempMs` 上限约束
  （alert 5s / done 3.5s / refuse 2.5s，可在 `app.js` 的 Config 里调整）
- `talking.webm` 是唯一的**循环**临时态：本地模型回复要几秒就循环几秒，由回复返回时
  主动收尾，`tempMs.talking`（90s）只是兜底上限，所以首尾帧要能自然衔接

## 制作素材

推荐流程是「网图 → 豆包生成七段状态视频 → `tools/video/make_pet_videos.py` 去水印 / 抠背景 / 编码 →
`char_pack.py` 打包 → 应用内导入」，见
[使用说明第十七节](../../plans/desktop-pet-使用说明.md#十七虚拟形象自定义)。

工具内部的五步（抽帧 → 去水印 → 白底转透明 → 编码 → 验证 alpha）、每个参数的含义
和常见故障排查见 [tools/video/README.md](../../tools/video/README.md)；产出的素材规格与上表一致。

只强调一条最容易踩的：编码那步 **`-auto-alt-ref 0` 不能省**，
否则 VP9 的 alpha 通道不生效，透明背景会变成纯黑。

打包成 zip 后也可以直接在应用顶部「更换形象」里导入/切换，不必覆盖内置目录：
`python tools/video/char_pack.py pack` 默认把 `videos/zhenzhu/` 打成
`videos/默认形象-紫发少女.zip`（加 `--name zhenzhu` 可改回 `zhenzhu.zip`）。
详见 [使用说明第十七节](../../plans/desktop-pet-使用说明.md#十七虚拟形象自定义) 和
[`tools/video/README.md`](../../tools/video/README.md)。

## 调试

- `index.html?novideo=1` — 强制使用 SVG 降级动画，便于对比排查
- 控制台出现 `[Animation] 未找到可用视频素材，已启用内置 SVG 角色动画`
  说明视频全部未能加载，检查文件名与路径
- 控制台出现 `[Animation] 缺少 videos/xxx.webm，暂用 idle 素材代替`
  说明只有个别状态素材缺失，该状态会退用 idle 的画面
