# PATCHES — v3 补丁版说明

本包基于 visual-editor 原版，对 `assets/visual-editor.js` 打了 9 处补丁。
`SKILL.md`、`visual-editor.css`、`USAGE.md` 与原版一致，未修改。
HTML 入口的 loader 建议使用 `?v=18` 版本号以防缓存。

## 补丁清单

| # | 位置 | 改动 | 解决什么问题 |
|---|------|------|--------------|
| A | `mousemove` / `click` 监听器守卫 | 守卫选择器加 `.ve-handles` | 点删除按钮被 document 级捕获监听器拦截，按钮失效 |
| A-注 | `dblclick` 守卫 | **故意不加** `.ve-handles` | 选中元素后 move surface 覆盖其上，双击需穿透 overlay 才能进入文本编辑/钻入 |
| B | `positionHandles` | 不再给静态元素的 move surface 加 `is-off` | 静态元素（position:static）的拖拽 surface 被 pointer-events:none 禁用，永远拖不动 |
| C' | `click` 选择逻辑 | 叶子优先 + inline 上卷：`<em>/<strong>/<span>` 等内联元素向上爬到 text-leaf 块级父级 | 原版单击选最外层 group（难调单个元素）；直接选叶子又导致点 H1 选中 em |
| D | `keydown` | 新增 Delete/Backspace 删除选中元素 | 原版只有左上角小按钮，键盘删不掉 |
| E | `startMove` | 静态元素拖拽时自动 lift 为 `position:relative`，从 0 偏移起算；`up()` 时把 position 一并记入历史 | 原版 `if (static) return` 直接拒绝拖拽 |
| F | `startResize.up()` | 父级是 flex 布局时记录 `flex: 0 0 auto` | flex 子项的 width/height 被父级拉伸覆盖，resize 看似无效 |
| G | 方向键 nudge | 静态元素自动 lift 为 relative（记入历史）再 nudge | 原版静态元素方向键直接 return |
| H | `dblclick` 末尾分支 | 当前已是容器时钻入第一个可编辑子级 | 原版只 toast "Innermost element reached"，双击无法进组 |
| I | hop 按钮 | "↓ First child" 独立显示（有子级就有），不再与 "Next sibling ›" 互斥 | 原版只在独生子时显示 "↓ Into group"，有兄弟的组永远进不去 |

## 验证状态（Puppeteer 真鼠标实测）

- ✅ 单击 H1（含 `<em>`）选中 h1 而非 em
- ✅ 删除按钮点击 → display:none；⌘Z 撤销恢复
- ✅ 双击 H1 → 进入文本编辑（命中 em）
- ⚠️ 部分测试因测试脚本未滚动到视口外元素而未覆盖，建议人工过一遍菜单区

## 安装

与原版流程一致：复制 `assets/` 三件套到项目 `tools/`（USAGE.md 改名 README.md），
HTML 注入 VE-LOADER 块（见 SKILL.md），`?v=18`。

---

# v4–v9 追加改动（2026-08-26/27，基于 v3 继续演进）

## v4 新功能
- **Background 组 + 渐变结构化编辑**：单层 `linear-gradient()`/`radial-gradient()` 可编辑角度与每个色标（颜色/透明度/位置%），多层或 conic 降级为文本框；解析器经 8 用例往返单测
- **Replace image（替换图片）**：面板底部按钮，选中 `<img>` 时出现；文件写入 `assets/uploads/`，src 变更记为新的 `attr` 日志类型（可撤销/可静音/进历史），导出补丁列入 STRUCTURAL CHANGES
- **Ungroup（打散编组）**：面板底部按钮，容器元素可用；实现为 `display: contents` 覆盖（纯 CSS、可撤销、可导出），再点 Re-group 还原

## v5 按设计师反馈调整
- Background 组改名「填充色」并始终可见；无填充色的元素显示"填充色在父级 X 上"跳转按钮
- Replace image 扩展到 **CSS 背景图**（url() 层原位替换，保留渐变蒙层与 cover 尺寸，纯 CSS 可导出）
- 图标按钮不再显示 Typography（hasOwnText 去掉标签名兜底，无真实文字即为容器）
- Alt+点击改为**层叠轮换**（elementsFromPoint 栈循环，可选中被人物压住的背景层）；修复 move surface 拦截 Alt 点击
- 修复 inset:0 元素拖拽变拉伸：移动前释放远边（right/bottom:auto）并固定宽高，同一历史条目
- 修复渐变编辑器不出现：authoredRaw 不看优先级，被基类 `background-image: initial` 欺骗；非渐变的 authored 值时改用 computed
- 底部按钮配色：Ungroup 黄（ve-btn-gold）/ Replace image 绿（ve-btn-green），独占整行

## v7–v8 界面中文化
- 全部 UI 文案中文化（约 150 处：组名/字段/按钮/toast/历史面板/导出弹窗/确认框），保留 CSS 属性名、单位、选择器等技术值不译；「下一个兄弟」→「下一个同级」，类型标签 box/text/image → 容器/文字/图片

## v9 严重 bug 修复
- **拖动瞬间元素突然放大**：v5 防拉伸补丁用 getBoundingClientRect 取尺寸写回 CSS，但页面用 `transform: scale()` 缩放手机框（可 >1），rect 是缩放后的视觉像素。改用 offsetWidth/Height（布局单位，免疫祖先 transform）+ box-sizing 校正（layoutCssSize）。CDP 模拟拖拽实测尺寸不变

## 验证方式
- node --check 语法校验；headless Chrome（--no-sandbox --remote-allow-origins='*'）+ CDP 真实点击/拖拽测试（合成事件需 dispatch 到 elementFromPoint 命中的元素，document 无 closest 方法）

## v10（2026-08-27）
- **模式按钮图标改为"动作语义"**：编辑模式显示鼠标（点击去浏览），浏览模式显示笔（点击回编辑）——原来显示的是当前状态，与直觉相反
- 模式切换的 tooltip/toast 中文化补漏
- **SKILL.md 增加 DELIVERY RULE**：安装完成后第一条回复必须直接给出带 `?edit=1` 的链接、禁止询问确认、禁止只给普通链接、先 curl 校验端口上跑的是正确项目；安装步骤精简为 3 步并明确"无其他步骤"

## v11 选中 bug 修复（2026-08-27，晚于 v10 zip）
- **被 CSS 块级化的 `<span>` 无法选中**：C' 补丁的 inline 上卷只看 `tagName`，不看实际布局。于是任何 `display` 被 CSS 改成 block / flex / grid / inline-block 的 `<span>`——徽章、chip、标签、pill 这类极常见写法——都会被误判为"内联装饰"而上卷到父容器，永远选不中自己。
  - 现象：同一个 class、同一个 `display:block`，写成 `<div>` 能选中，写成 `<span>` 就跳到父级。连带导致 Delete 键删错元素（删掉整个容器）。
  - 修复：上卷条件加一道 computed display 闸门，只有真正参与内联流的（`inline` / `ruby*`）才上卷；块级化的 span 视为独立盒子，正常选中。
  - 回归验证：`<em>`/`<strong>` 等真内联仍正确上卷到标题（点斜体词选中 h1，不选 em）；双击 `<em>` 仍进入文字编辑。

### CDP 测试两个坑（验证方式补充）
- `--user-data-dir` 复用会带上一次的 localStorage 编辑状态（元素还是 display:none），导致 rect 全 0、点击落到 nav 上——每轮测试必须换新 profile 或清 localStorage
- VE 面板/工具条固定在视口右上，会遮住页面右侧元素，合成点击打到 `.ve-panel` 上——先用 `elementFromPoint` 确认没被 chrome 遮挡，或把面板临时移到视口外再点

## v12 改版：网页风格 + 全英文 + logo 化（2026-08-29）

设计师反馈：原来的深色 `#14181d` 玻璃面板「非常 web-coding-AI 的感觉」。改为与页面同一套
瑞士编辑风格的浅色 chrome。

### 视觉重做（`visual-editor.css` 整体重写，类名与结构规则全部保留）
- 配色反转为纸面：`--ve-bg #f5f4f1` / 面板纯白 / 发丝线 `#dddbd5` / 墨色文字 `#0b0b0b`
- 强调色换成页面同款三硬色：blue `#1b4dff`（accent）、red `#ff3b14`、lime `#ddf14a`
- **所有圆角归零**（`border-radius: 0`），边框改 1px 墨线；柔和大阴影 → 单一硬阴影
  `3px 3px 0`（`--ve-lift` / `--ve-lift-lg`），杜绝发光感
- 分组标题、按钮、单位选择器、提示文字统一 mono + 大字距 + 大写小字号
- 缩放手柄从蓝色圆点改为方形白底墨边，hover 变荧光绿
- 语义按钮保留身份但扁平化：blue=回退 / red=破坏性 / green=替换图片 / lime=打散编组

### 文案全英文
- `visual-editor.js` 约 170 处中文 UI 文案全部改回英文（组名/字段/按钮/toast/历史/导出弹窗/
  确认框/tooltip），CSS 属性名、单位、选择器等技术值不动。CSS 与 JS 现均 0 处中文
- 新增 `plural(n, word)` 辅助函数，修掉 `1 changes` 这类英文单复数错误（历史计数、
  保存 tooltip、重置元素 toast 三处）

### logo 取代眼睛与抓手
- 新增 `LOGO_SVG` 常量（蓝圆 + 荧光绿菱形 + 墨心圆），与演示页 `assets/art/mark.svg` 同款
- 工具条尾部的**眼睛按钮**和最右侧的**点阵拖动抓手**一并删除，改为单个 `.ve-logo-btn`：
  **点一下 = 收起/展开，按住拖 = 移动整条工具条**
- `makeDraggable` 增加第 5 个参数 `onTap`：位移小于 `DRAG_SLOP`（4px）判定为点击并触发
  `onTap`，超过才算拖动（加 `is-dragging`、落位时写 localStorage）。没传 `onTap` 的
  handle（如面板头部）行为完全不变
- 收起态**不再降透明度**——收起后 logo 是屏幕上唯一残留物，`.ve-bar` 的 0.78 与
  `.ve-logo` 的 0.55 相乘会让它看起来像坏了。收起状态靠外壳从 432px 缩到 40px 表达
- 面板左上角也放同一枚 logo（`.ve-panel-logo`），右边紧跟编辑目标名（`h2.nest-title`）
  与类型标签（text/box/image/svg）

### 验证
CDP 实测：logo 单击收起→展开、logo 拖动移动工具条且不误触收起、旧 eye/grip 已彻底移除、
面板 logo + 目标名、渐变编辑器、7 元素范围警告（All 7 / Only this）、历史面板、
收起徽章计数、chrome 内 0 处中文、无 JS 异常。

## v13 两处像素级修正（2026-08-29）

- **收起时 logo 右移 2px**：`.ve-bar.is-collapsed` 原来把 `padding` 从 8px 改成 6px。
  工具条是**按右边缘锚定**的（`right` 定位 + `anchor: "right"`），右 padding 少 2px，
  logo 就整体右移 2px。而 logo 恰恰是用户瞄准点击的固定靶点，不能动。
  修法：收起态**只收 `gap`，不动 padding**。实测展开→收起→再展开 `dx=0 dy=0`，
  完全回到同一像素。
  > 教训：任何右锚定容器，收起/展开时改 `padding-right`、`border-right-width`
  > 都会让内部元素横向漂移；要保持锚点不动就只能收 gap 或改左侧属性。
- **撤销/重做图标偏小**：这两个用的是文字符号 `↶ ↷`（12px 字号），而同排 mode、
  upload 图标都是 15px SVG——文字字形由 font metrics 决定实际墨迹远小于 15px，
  所以视觉上明显轻。改成真正的 SVG 箭头（`viewBox 0 0 16 16`、`stroke-width 1.6`），
  按钮加 `ve-icon-only` 走 28px 方形footprint。现四个图标实测均 15×15、按钮均 28px。
  顺带删掉已无引用的 `.ve-bar-glyph` 规则。

## v14 对齐大扫除（2026-08-29）

设计师逐个点出"某个 icon 偏一点"，全部实测复现并修掉。**通用教训：把 <svg> 元素居中
不等于图标看起来居中——真正决定观感的是路径墨迹在 viewBox 里的位置。**用 `getBBox()`
量 ink bbox 中心与 viewBox 中心的差值，才能定量。

### 1) 图标墨迹未居中（用 getBBox 实测）
修前偏移：undo/redo `dy +2.15`（明显偏下）、mode-cursor `dx −0.4`（偏左）、
mode-pen `dx +0.61 dy −0.61`、upload `dy +0.25`。逐个重画路径，现全部 `|d| ≤ 0.01`。
注意 `stroke-linecap="round"` 会让端点外扩半个线宽，箭头这类不对称形状要把这部分算进去
（undo/redo 的 dx±0.4 就是它造成的）。

### 2) 工具条按钮高度不一致
文字按钮由 font metrics 定高（10px × 1.3 = 13px + padding = 25px），图标按钮由 15px
图标定高（27px）。flex 居中让它们**中线相同但上下边框差 2px**，看起来就是"History 偏上"。
改成所有 `.ve-bar-btn` 统一 `height: 28px` + `inline-flex` 居中，实测 top/bottom/height
三项全部一致。

### 3) Save 徽章被 "Save as" 压住
`.ve-save-wrap` 与 `.ve-menu-wrap` 都是 `position:relative; z-index:auto`，DOM 里
menu-wrap 在后面所以后来者覆盖。给 save-wrap `z-index:3`，徽章改 `transform:
translate(45%,-45%)` 完全移出按钮外并加 1px 纸色描边与两侧按钮分离。

### 4) 收起后徽章位置漂移 + 随 hover 移动
两个原因：①`.ve-logo-btn` 是 `position:relative`，徽章以 logo 为锚，收起时 logo 位置变
徽章就跟着变——改成 logo **不设 position**，徽章直接锚到 `position:fixed` 的
`.ve-bar` 上，开合都是同一个角偏移；②hover 用了 `transform: scale(1.06)`，会连带缩放
并位移内部徽章——改成只变 `opacity`（唯一不改变几何的反馈方式；ring/outline 会和收起态
的红色 dirty 边框打架）。

### 5) 面板 +/× 与 caret 排不齐
它们是文字字符 `×` `+` `▸` `▾`——不同字形的 side bearing 与光学中心都不同，一列排下来
必然参差。全部换成对称绘制的 SVG（`CROSS_SVG` / `PLUS_SVG` / `CARET_*_SVG`）。
另外 `.ve-group-action` 是 17px 固定宽却带 `padding: 1px 6px`，内容盒只剩 3px——
改 18px 方形 + `padding: 0`。现所有 caret 同一列、所有 +/× 同一列，dy 全为 0。

### 6) 面板可以左右拖动（不该）
面板是右侧栏，横向漂移会破坏它与工具条的右边缘对齐。`makeDraggable` / `restorePos` /
`keepOnScreen` 新增 `"vertical"` 锚点模式：Y 自由、**X 完全锁死**（不写 left/right，
不从 localStorage 恢复 X，不被 keepOnScreen 修正 X）。同时 slop 判定改为只看 dy，
否则纯横向拖动会像手柄失灵。实测 dx=0 / dy=28 / 右边缘仍与工具条对齐。

### 6b) 面板右边缘与工具条差 4px
面板锁死横向后，它就是一条固定的右侧栏，右边缘必须和工具条严丝合缝。原来
`.ve-panel { right: 20px }` 而 `.ve-bar { right: 16px }`——可自由拖动时看不出来，锁死后
就是一道明显的错位。统一为 16px。**这两个值必须同步改。**

### 7) 顺带修：Colour 行溢出面板右边界 28px
`.ve-num-mini { width:46px }` 只有一个 class，输给了 `.ve-field input[type="text"]
{ width:100% }`（class+属性特异性更高），于是被拉伸到 202px 撑破面板。改用
`.ve-field input.ve-num-mini` 提高特异性 + `flex: 0 0 46px`。`.ve-row` 的 `1fr` 也
改成 `minmax(0, 1fr)`——裸 `1fr` 不会小于 min-content，同样会顶破容器。

### CDP 测试方法补充（这轮踩的坑）
- **`pointer-events: none` 的元素做不了 `elementFromPoint` 命中测试**：射线会穿透它命中
  下层，看起来像"被遮住"。判断这类元素是否可见要用像素法：截图后画到 canvas 上数它自己
  矩形内的特征色占比。
- **`Page.captureScreenshot` 带 `clip` 抓不到 `position: fixed` 的 chrome**：clip 是
  对滚动后的文档取区域，fixed 元素不在其中，裁出来是空白。要先整屏截图再裁。
- 异步表达式（返回 Promise）必须给 `Runtime.evaluate` 传 `awaitPromise: true`，否则拿到
  的是 `[object Object]`。

## v15 交互关系修正（2026-08-29）

v14 的三个后遗症，全部来自「过度修正」——上一轮为了解决对齐问题把交互锁得太死。

### 1) 面板恢复双轴自由拖动 + 磁吸对齐
v14 把面板锁成只能上下拖（`"vertical"` 锚点），用户的真实诉求其实是**对齐**而不是
**锁定**——既然右边缘对齐问题已经用 CSS 根治，锁就该撤掉。新增 `"free"` 锚点模式：
行为与 `"right"` 相同（双轴自由、按右边缘定位），但拖动过程中当右边缘 inset 进入
`16±28px` 范围时**当场吸附**到 16px（`SNAP_RIGHT`/`SNAP_DIST`，与样式表里
`.ve-bar`/`.ve-panel` 的 `right:16px` 保持同步）。既保留自由，又随时能停回对齐位，
不需要像素级手稳。注意吸附在**拖动过程中**生效而不是松手后才跳——用户能"感到"
那个吸力，而不是看着它事后归位。

### 2) 收起工具条不再销毁选中态
`setMinimised(true)` 原来会调 `deselect()`——点一下收起，正在编辑的选中、面板、
手柄全部销毁，展开后得重新选。**工具条和编辑面板是两个独立的东西**：收起是
"把 chrome 挪开一下"，不是"扔掉手上的活"。现在收起只关历史弹窗（它是挂在工具条
上的临时浮层，留着没意义），选中态完整保留；CSS 的 `[data-ve-minimised]` 规则本来
就用 display:none 藏面板和手柄，展开后原样恢复，只需重新 `positionHandles()`
测量手柄位置（收起期间页面可能滚动过）。

### 3) logo 的开合态有了尺寸语言
用户要：hover 时预演点击后的结果——展开态 hover 缩小（预告收起），收起态 hover
放大（预告展开），点击后停在那个尺寸。静止时两态也有可辨但不夸张的区别。
实现：`.ve-logo`（svg）上 `transition: transform .15s`，展开态 rest = scale(1) /
hover = scale(.82)；收起态 rest = scale(.82) / hover = scale(1)；拖动中冻结无预览。
**关键约束：transform 只能加在 `.ve-logo`（svg）上，绝不能加在 `.ve-logo-btn`
（按钮）上**——徽章是按钮的 DOM 子元素但相对 `.ve-bar` 定位，按钮一旦有了 transform
就会变成徽章的包含块，v14 修好的徽章定位会当场报废。svg 和徽章是兄弟节点，
缩放 svg 不会动徽章。

### CDP 测试教训（又添一条）
测"静止态"尺寸时**必须先把鼠标挪开再量**——上一轮脚本点完展开按钮直接量 logo
宽度，指针还停在 logo 上，:hover 生效中，量出来的"rest"其实是 hover 态，得出
"两态无区别"的假 FAIL。所有 hover/rest 对比测试都要先 park 指针到空地。

## v16 收起=只收工具条（2026-09-01）

v15 改了 JS（去掉 deselect）却漏了 CSS 与守卫——`[data-ve-minimised]` 仍在
display:none 藏掉面板和手柄，mousemove/mousedown/dblclick/keydown 四处守卫仍在
拦 `state.minimised`。用户实测：点收起后编辑窗口照样消失，再点别的组件也没反应。

### 彻底解耦
- 删掉 CSS 的 `[data-ve-minimised]` 隐藏块（面板/手柄/选中框全部不再隐藏）
- 五处守卫里的 `state.minimised` 条件全部移除（hover 追踪/单击/双击/键盘/select 里
  的 `!state.minimised`），只保留 browse 模式守卫
- `setMinimised` 简化为：只切 `.is-collapsed`、关历史弹窗、keepOnScreen。收起后
  可以继续选中别的元素、编辑、Delete——**收起只是"把工具条挪开"，编辑器本身一直在工作**

### logo 视觉：两态同尺寸 + hover 变大 + 收起变色
v15 把尺寸语义做反了（展开大/收缩小）。用户要的是：
- **展开态与收起态静止尺寸相同**（都是 26px，shell 的缩放已经足以表达开合）
- **hover 时两态都稍微变大**（scale 1.15）——纯「这里可以点」的 affordance
- **收起态变色区分**：LOGO_SVG 的 disc/gem 加了 class（`.ve-logo-disc`/`.ve-logo-gem`），
  收起时 disc 由蓝 `#1b4dff` 变红 `#ff3b14`（CSS fill transition 平滑过渡）

## v17 层级导航按钮加深（2026-09-01）

Parent / First child / Next sibling 原来是浅底灰字（`--ve-bg` + `--ve-text-dim`），
用户反馈存在感太弱。这是面板的**主导航**，不是次要操作——改为常驻反转：
墨底 `#0b0b0b` + 纸字、墨边框；hover 变红 `#ff3b14` + 白字。disabled（比如
没有父级时）回落为浅底虚字，让可用按钮跳出来。

## v18 层级导航重做：三等分单行 + 同源图标（2026-09-01）

v17 只加深了颜色，结构问题没解决。设计师指出三点，全部是对的：

### 1) 换行 + 有优先级之分 → 三等分栅格，恒定三个
原来是 `flex-wrap` + 按需渲染：有 child 才出 Child 按钮、有兄弟才出 Next。结果
①三个同时出现时宽度不一、挤到第二行；②按钮会凭空出现/消失，导致每次选中都在
重排。改为 `grid-template-columns: repeat(3, minmax(0,1fr))`，**恒定渲染三个**，
不可用的 `disabled` 就地置灰（浅底虚字），不再消失。
文案压缩：`↑ Parent / ↓ First child / Next sibling ›` → `Parent / Child / Next`，
9px mono 大写，实测 306px 面板内三个各 92px、零溢出。

### 2) 图标语言不统一 → 一套同源图标
原来是文字箭头字符，而且 Parent/Child 的箭头在文字左边、Next 的在右边。改成
一套 SVG：**箭头 + 一条固定边界线**，同一个结构画三个方向（上=出到父级、
下=进入子级、右=沿着走到兄弟），图标统一在 label 左侧。
**几何要点**：边界线在 3.5、箭头尖端在 12.5，跨度 3.5..12.5 的中点正好是 8，
墨迹 bbox 精确居中于 16×16 viewBox（首版把线画在 4.5/11.5，三个图标各偏 0.5，
被 getBBox 实测抓出来）。

### 3) 计数器游离在按钮外 → 收进按钮内
`2 / 4` 原来是 `.ve-hop-count` 一个独立 span，跟在按钮旁边像块无主的文字。它
描述的是 Next 这个按钮自身的位置，所以现在是 `.ve-hop-n`，渲染在 NEXT 按钮内部、
label 右侧、opacity 0.6。顺带删掉已无引用的 `.ve-hop-count` 规则，并修正 SVG
提示文案里对旧按钮名「↓ First child」的引用。

### 验证
三种选中场景（深层子元素 / 无父级的屏根 / 无子元素但有 7 个兄弟）实测均为
`rows:1, widths:[92]`、无溢出、禁用态正确；三个图标 dx=dy=0.00。
