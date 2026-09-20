# AI Passport 玩法发布材料

## ✅ 已提交（2026-09-20 17:14）— 状态：`pending`（审核中，**尚未公开**）

| 项 | 值 |
|---|---|
| projectId / revisionId | **566** / **1164** |
| slug | `ai-growth` |
| 审核状态 | **pending**（已提交社区审核，不等于已发布） |
| 分类 | `productivity` |
| 标题 | 中文 `AI Growth 今日任务卡` / 英文 `AI Growth: Today's Task Card` |
| 固件 | 合并镜像 2,268,848 字节 · `sha256 a0ebd7a903cc71e94571a26815e1b7eb80e6416be54c2495a5331e65bd7798f7` |
| 封面 | `release/cover-1152x1536.png`（1152×1536，精确 3:4；源文件 `release/cover-source.html`） |
| 使用方法 | `release/instructions-zh.txt` / `release/instructions-en.txt`（独立字段提交，未混进简介） |
| 更新日志 | 首次发布留空 |
| 源码地址 | 未填（**当前没有可公开的个人 Git 仓库**，官方规则里这一项是可选的） |

> ⚠ 该固件**包含发布前最后一个关键修复**：之前"电池供电开机纯白屏"的根因是
> —— 无 USB 主机时安装了 USB-Serial-JTAG 控制台驱动，导致后续日志写入永久阻塞，
> 启动卡死在"画第一张卡"之前。修复后电池/USB 两种供电都正常（已实测）。
> 提交前务必确认你上传的就是这个 sha256，不要用更早的产物。

### ✅ 分发渠道问题已解决（2026-09-20 17:43）

**`ai-growth@1.1.0` 已发布到 npm** —— 之前"审核方与用户装不上电脑端程序"的缺口已经没有了。
用户现在一条命令即可：

```bash
npm install -g ai-growth
```

实测验证（干净目录按用户方式安装，非只看 registry 元数据）：

| 检查 | 结果 |
|---|---|
| `npm view ai-growth version` | `1.1.0` ✓ |
| 干净目录 `npm i ai-growth` + 跑 CLI | ✓（含原生模块预编译，无需编译工具链） |
| `help --json` 输出契约 | ✓ `{ok,data}` + 产品规则齐全 |
| README 三个徽章端点 | 全部 HTTP 200 ✓ |

> ⚠️ **待办（等这次审核出结果后做）**：本玩法提交时的"使用方法"第一步写的是
> 「电脑上启动 AI Growth：执行 `ai-growth serve`」，但没写**怎么装**。
> 现在宿主已在 npm 上，下次更新时应补上 `npm install -g ai-growth` 这一行 ——
> 这是"用户能否真的跑起来"的最后一环。
> （发布规则要求：**存在 pending 修订时不得再提交新修订**，所以必须等审核结果，不能现在就改。）

| 问题 | 现状 |
|---|---|
| ~~宿主程序没有分发渠道~~ | ✅ **已解决**：`ai-growth@1.1.0` 在 npm 上，`npm i -g ai-growth` 可用 |
| **没有公开源码仓库** | ⏳ 仍未建：npm 页面的 Repository/Homepage 现在指向 `github.com/lairey-ai/ai-growth`，**仓库还不存在 → 这两个链接目前是死的**。建议尽快建仓并推一次 |

以下为原始准备材料（封面提示词、文案草稿、规范摘录），保留备查。

---

> 这份文件里的每一项都直接对应官方发布 CLI 的参数（`--category` / `--title-zh` / `--description-zh`
> / `--instructions-zh` / `--cover` / `--source-url`）。发布规范来自官方 publisher skill：
> 封面**必须精确 3:4 竖版**、优先 1152×1536、≤10 MiB、JPEG/PNG/WebP；标题与简介**不得出现
> 硬件/芯片/框架名**；另需中英文"首次上手操作说明"；固件为 ≤8 MiB 的合并且从 0x0 写入的镜像。

---

## 1. 分类

`productivity`

（官方分类可选 games / productivity / information / learning / media / social / developer。
这是"把想做的事拆成今天的一件"的执行工具 —— 不是游戏，也不该放进 developer。）

## 2. 标题

| 语言 | 值 |
|---|---|
| 中文 | `AI Growth 今日任务卡` |
| English | `AI Growth: Today's Task Card` |

## 3. 简介

**中文**

> 你只需要面对今天这一张卡。
>
> 把想做成的事告诉电脑上的 AI，它负责拆成阶段、排出今天该做的那两三件事，只把**今天**推到
> 这块小屏上：一个阶段轨道告诉你走到哪了，几条待办告诉你现在做什么。做完一件按一下确定，
> 卡片立刻变成完成状态。第二天早上，昨天没做完的会自动过期，**不会累积成债务** ——
> 所以卡片永远只装今天。

**English**

> You only ever face today's card.
>
> Tell the AI on your computer what you want to accomplish. It breaks it into stages and puts
> only **today's** two or three actions on the small screen: a stage track shows how far you
> have come, a short list shows what to do right now. Press once when something is done and
> the card turns complete immediately. Next morning, anything unfinished simply expires
> instead of piling up — so the card always holds today, and nothing else.

## 4. 操作说明（给第一次上手的人）

**中文**

```
准备
1. 电脑上装好 AI Growth 并启动：ai-growth serve
2. 用官方刷机工具刷入本玩法的合并固件（从 0x0 写入）

连接电脑（只需一次）
3. 电脑上执行一条命令：
     ai-growth device setup --ssid "你的Wi-Fi名" --pass "Wi-Fi密码"
   它会自己确认设备已经取到卡。之后设备每次开机都会自动连上并显示今天的卡。

按键
- 上 / 下 短按：翻看今天的所有卡
- 确定 短按：完成当前卡上的这件事
- 确定 长按：回到设备自带的演示菜单

说明
- 完成动作会上报到电脑；设备本身不保存进度，所有状态都在电脑上
- 连不上电脑时屏幕会给出离线提示，网络恢复后按一下确定即可重新取卡
- 屏幕 1 分钟无操作会自动熄屏，按任意键立刻亮回
```

**English**

```
Preparation
1. Install AI Growth on your computer and start it: ai-growth serve
2. Flash this play's merged firmware with the official web flasher (write from 0x0)

Pair with your computer (once)
3. Run one command on the computer:
     ai-growth device setup --ssid "your-wifi" --pass "your-password"
   It confirms by itself that the device has fetched a card. After that the device
   connects and shows today's card automatically on every boot.

Controls
- UP / DOWN short press: browse today's cards
- OK short press: mark the current card's action as done
- OK long press: return to the device's built-in demo menu

Notes
- Completions are reported to the computer; the device itself keeps no progress
- If it cannot reach the computer the screen says so — press OK to retry once back online
- The screen switches off after 1 minute idle; any key turns it back on
```

## 5. 封面（必须）

### 设计意图（先说清楚为什么这么画）

封面要**玩法优先**：官方规范明确说"设备不必出现，且不得为了宣传硬件而硬塞进去"。
这个玩法的核心交互是**一张躺在桌面上的、只写着今天三件事的卡，做完的瞬间它会变成完成态**。
所以画面主体用「悬浮的任务卡 + 阶段节点轨道 + 一条已打勾的待办」来表达玩法本身，
背景用清晨书桌来传达"每天开始"的情绪，冷暖对比（深蓝卡面 vs 暖色晨光）。

⚠ 这里不出现设备照片：一来规范不建议，二来手机/平板的出镜会把"这是个应用"的观感
变成"这是个硬件广告"。

### 正向提示词（中文，直接粘）

```
竖版 3:4 插画，极简与温暖手作感结合。画面主体：一张悬浮在木桌上的深蓝色圆角卡片，
卡片边缘有柔和描边光。卡片上的"文字"用抽象的浅色短横线表示（不要画任何可读字母或汉字），
上方是一条由四个圆角小方块组成的横向节点轨道：第二个方块亮着暖黄色光晕，其余是暗青色描边；
下方三条更细的浅色横线代表今日待办，其中最上面一条左侧有一个绿色对勾标记。
背景：清晨的木质书桌，虚化的笔记本、一杯冒着热气的咖啡、窗帘斜射进来的晨光，
暖色与深蓝形成冷暖对比。画面安静、有秩序感、留白充足。
光线从左上方斜射，卡片有柔和投影，质感细腻，商业插画风格，居中构图，浅景深，8k。
```

### 负向提示词

```
文字, 字母, 汉字, 日语假名, 乱码字形, 水印, 签名, logo, 商标, 真实设备照片, 手机, 平板,
笔记本电脑, 数据线, USB, 电路板, 电子元件, 焊点, 人物特写, 脸部, 恐怖, 杂乱, 重叠物体,
过曝, 低分辨率, 主体模糊, 变形, 多余手指, 边框, 拼贴, 多张卡片
```

### 参数建议

| 项 | 建议 |
|---|---|
| 尺寸 | **1152 × 1536**（精确 3:4；官方推荐生成尺寸） |
| 底模 | SDXL 类（写实/插画混合，国内平台上的写实插画底模都行） |
| 采样器 / 步数 / CFG | DPM++ 2M Karras · 30 步 · CFG 6.5 |
| 生成数量 | 4 张里选 1 |
| 后处理 | 可开 Hires fix 1.5×；**导出时必须裁成精确 3:4**，不要留白边或改比例 |

### 交付前自查（官方会校验，别让它红）

- [ ] 精确 3:4 竖版（1152×1536 或同比例）
- [ ] JPEG / PNG / WebP，且 **≤ 10 MiB**
- [ ] 画面里没有任何可辨文字、水印、签名、平台 logo
- [ ] 没有出现"看起来像真实设备截屏"的东西（若放了插画，发布时要标注为插画而非实拍）
- [ ] 没有隐私信息（照片元数据、屏幕上的真实人名/账号）

### 英文备用提示词

```
vertical 3:4 illustration, minimal aesthetic with a warm handcrafted feel.
A floating deep-navy rounded card above a wooden desk, its edge softly outlined with light.
Any "text" on the card is abstract pale short lines (no legible letters or CJK glyphs).
Above: a row of four rounded-square progress nodes, the second glowing warm amber and the
rest outlined in dim teal. Below: three thinner pale lines for today's to-dos, the top one
marked with a small green check.
Background: quiet morning desk, blurred notebook, a steaming cup, slanted dawn light through
curtains; warm tones against deep navy. Calm, orderly, generous negative space.
Soft light from the upper left, gentle shadow under the card, fine texture, commercial
illustration, centered composition, shallow depth of field, 8k.
```

Negative:
```
text, letters, chinese characters, kana, garbled glyphs, watermark, signature, logo,
trademark, photo of a real device, phone, tablet, laptop, cables, usb, pcb, components,
portrait closeup, face, horror, clutter, overlapping objects, overexposed, lowres,
blurry subject, deformed, extra fingers, frame, collage, multiple cards
```

## 6. 发布前还缺什么（现状核对，2026-09-20）

发布流程要求两样本项目**当前还没有**的东西，属于硬门槛：

| 缺口 | 现状 | 怎么办 |
|---|---|---|
| **公开 HTTPS Git 仓库** | `git remote -v` 为空 —— 项目没配任何远端（`package.json` 里写的是 `github.com/lairey/ai-growth`，是占位符） | 建公开仓库并推上去；同时把 `package.json` 的 `repository` 与 `mcpName`、`server.json` 的 `name` 里的 `lairey` 换成真实用户名（三处必须一致） |
| **宿主程序的分发渠道** | `npm view ai-growth` 返回 **404**，即未发布到 npm | 社区用户拿不到宿主就没法用。两条路：① 发布到 npm（一次 `npm publish`，但要决定包名是否被占、是否愿意公开）；② README 里给出源码安装（`git clone` + `./scripts/install.sh`）作为唯一路径 |

另外两项（之前已列，仍未做）：

- **Windows**：`ai-growth device setup` 依赖系统的 `stty` 把串口设为 raw（Node 没有 termios），
  Windows 上没有 `stty` → 要么降级为"请用 macOS/Linux"，要么在 Node 里直接设串口参数。
- **离线卡文案**：现在只显示"暂时连不上电脑"，应加一句"在电脑上重跑 `ai-growth device setup`"，
  否则 Wi-Fi 变了/令牌换过之后用户不知道该做什么。
