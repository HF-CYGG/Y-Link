# Task1：全站卡片与弹窗高度异常盘点及根因清单

## 文件说明
- 本文档用于盘点 Y-Link 全站卡片、弹窗、抽屉在高度策略上的现状，区分“短内容自适应”与“长内容滚动”两类场景，并输出根因清单。
- 本文档作为 Task1 的交付物，面向前端、产品、测试共同对齐后续治理口径，避免继续通过零散魔法数字修补高度问题。
- 本文档不直接改代码，而是先建立统一判断标准，便于后续拆分为独立修复任务。
- 盘点口径来源：
  - `src/style.css`
  - `src/components/common/business-composite/BizCrudDialogShell.vue`
  - `src/components/common/business-composite/BizResponsiveDrawerShell.vue`
  - `src/components/common/business-composite/BizResponsiveDataCollectionShell.vue`
  - `src/components/common/page-shared/UnifiedScanDialog.vue`
  - `src/components/common/page-shared/PageToolbarCard.vue`
  - `src/components/common/page-shared/TabbedWorkbenchPage.vue`
  - `src/layout/components/AppHeader.vue`
  - `src/views/system/UserManageView.vue`
  - `src/views/order-list/OrderListView.vue`
  - `src/views/client/ClientProfileView.vue`
  - `src/views/client/ClientOrderDetailView.vue`
  - `src/views/o2o/O2oVerifyConsoleView.vue`
  - `src/views/o2o/O2oProductMallManageView.vue`
  - `src/views/dashboard/components/TopProductDrilldownDrawer.vue`
  - `src/views/inbound/SupplierHistoryView.vue`

## 1. 盘点结论总览

### 1.1 当前全站已经存在两套混合中的高度体系
- 第一套是“全局安全网”体系：`src/style.css` 统一把 `el-dialog` 变成纵向 `flex` 布局，并让 `el-dialog__body` 负责滚动，目标是解决长表单和低高度视口下的正文截断问题。
- 第二套是“页面局部覆写”体系：各业务页面再用 `max-height`、`height: calc(...)`、`overflow-auto`、`h-full`、`min-height` 等规则追加修正，导致同样的弹窗/卡片在不同页面呈现出不同高度行为。
- 这两套体系并未通过明确的“高度模式”字段进行区分，而是靠组件作者临时判断，因此短内容弹窗、长内容弹窗、工作台型卡片经常共用同一套默认规则。

### 1.2 当前最核心的问题不是单个数值不准，而是“高度职责边界不清”
- 有的弹窗把滚动交给 `el-dialog__body`。
- 有的弹窗又在正文内部再包一层 `max-height + overflow-auto`。
- 有的抽屉壳层已经是 `h-full overflow-y-auto`，业务内容又继续设固定高度。
- 有的卡片本应随内容自然生长，却被页面壳层的 `min-height` 或 `h-full` 拉成“空心大白块”。
- 结果就是短内容场景被拉空，长内容场景出现双滚动，极端视口下还会出现底部操作区被挤压或正文可视区过小。

### 1.3 Task1 的判断标准
- 短内容自适应：正文内容明显小于视口时，弹窗/卡片高度应贴合内容，不制造大段空白，不为了“统一风格”强行占满高度。
- 长内容滚动：正文内容超过可视区时，应只保留一个明确滚动容器，头部与底部操作区稳定可见，正文在安全高度内滚动。
- 工作台型卡片：允许为了页面骨架稳定设置最小高度，但必须仅用于“舞台容器”，不能扩散到普通信息卡、详情卡、编辑卡。

## 2. 全站样本盘点

### 2.1 通用层样本

| 类型 | 代表文件 | 当前高度策略 | 现状判断 |
|---|---|---|---|
| 全局普通弹窗 | `src/style.css` | `.el-dialog` 统一 `display:flex`、`max-height:min(94vh, calc(100dvh - 24px))`，`el-dialog__body` 统一滚动 | 对长内容友好，但把“所有弹窗”默认推向滚动型，不利于短内容自适应 |
| 通用 CRUD 弹窗壳 | `src/components/common/business-composite/BizCrudDialogShell.vue` | 统一宽度，正文本身不区分高度模式，完全依赖全局 `el-dialog` 规则 | 高度策略未显式分类，页面只能靠业务类名打补丁 |
| 通用抽屉壳 | `src/components/common/business-composite/BizResponsiveDrawerShell.vue` | 抽屉正文固定 `h-full min-w-0 overflow-y-auto` | 适合长内容，但若业务内部再设定高度，容易形成双滚动 |
| 通用数据集合壳 | `src/components/common/business-composite/BizResponsiveDataCollectionShell.vue` | 表格容器默认 `apple-card h-full ... overflow-hidden` | 依赖父级高度明确，若父级是内容高度，会出现“被强撑满”现象 |
| 通用扫码弹窗 | `src/components/common/page-shared/UnifiedScanDialog.vue` | 自建 `el-dialog` 高度安全网，正文滚动，内部舞台再用 `aspect-ratio + max-height` 控制 | 属于成熟的“长内容滚动 + 舞台稳定”实现，但与全局规则并行，未形成统一标准 |
| 通用页面标签工作区 | `src/components/common/page-shared/TabbedWorkbenchPage.vue` | `embedded-page` 设置 `min-height: 240px` | 适合工作台容器，但不适合扩散到普通内容卡片 |

### 2.2 管理端业务样本

| 类型 | 代表文件 | 当前高度策略 | 现状判断 |
|---|---|---|---|
| 用户短表单弹窗 | `src/views/system/UserManageView.vue` + `src/style.css` | 专门存在 `user-manage-edit-dialog` 全局例外，强制 `height:auto`、正文不滚动 | 说明全局弹窗默认策略已经无法自然兼容短内容，必须额外开后门 |
| 顶栏修改密码弹窗 | `src/layout/components/AppHeader.vue` | 直接使用原生 `el-dialog`，无单独高度模式 | 短内容场景仍依赖全局滚动型弹窗，行为与用户管理弹窗不一致 |
| 出库单预览弹窗 | `src/views/order-list/OrderListView.vue` | 外层弹窗受全局规则控制，内部预览区再设布局与局部滚动 | 属于典型“正文滚动 + 内部子区域再滚动”复合结构 |
| 供应历史详情抽屉 | `src/views/inbound/SupplierHistoryView.vue` | 抽屉内部面板写死 `height: calc(100vh - 132px)`，移动端改为 `calc(100vh - 104px)` | 对浏览器地址栏、顶部高度、`dvh` 变化不敏感，是明确的高度异常根因 |
| 仪表盘下钻抽屉 | `src/views/dashboard/components/TopProductDrilldownDrawer.vue` | 抽屉正文自然流，表格容器再加 `max-h-[55vh] overflow-auto` | 适合长表格，但与抽屉自身滚动策略叠加后存在双滚动风险 |
| O2O 商城商品编辑弹窗 | `src/views/o2o/O2oProductMallManageView.vue` | 表单自然增长，图片区域大量使用固定 `min-height/height` | 正文越长越依赖全局滚动安全网，短内容与长内容未做显式区分 |
| O2O 核销台现场改单/拒绝弹窗 | `src/views/o2o/O2oVerifyConsoleView.vue` | 大量列表块叠加，仍交给全局弹窗正文滚动 | 行为可用，但缺少“滚动容器唯一化”约束 |

### 2.3 客户端业务样本

| 类型 | 代表文件 | 当前高度策略 | 现状判断 |
|---|---|---|---|
| 个人中心短表单弹窗 | `src/views/client/ClientProfileView.vue` | 原生 `el-dialog` + `max-width`，无高度模式 | 与管理端短表单弹窗治理方式不同，短内容仍可能出现被全局结构拉伸的空白感 |
| 客户端改单弹窗 | `src/views/client/ClientOrderDetailView.vue` | 大量卡片块堆叠，完全依赖外层弹窗正文滚动 | 可承载长内容，但没有内部滚动层级规范 |
| 客户端退货弹窗 | `src/views/client/ClientOrderDetailView.vue` | 长表单场景，同样依赖全局弹窗正文滚动 | 与改单弹窗一致，缺少高度模式显式标识 |
| 客户端正式出库单预览弹窗 | `src/views/client/ClientOrderDetailView.vue` | 预览区本身 `max-height: 56vh; overflow:auto` | 与外层弹窗正文形成双滚动竞争 |

### 2.4 卡片型容器样本

| 类型 | 代表文件 | 当前高度策略 | 现状判断 |
|---|---|---|---|
| 工具栏卡片 | `src/components/common/page-shared/PageToolbarCard.vue` | 纯内容驱动，无强制高度 | 符合短内容自适应预期 |
| 数据列表承载卡片 | `src/components/common/business-composite/BizResponsiveDataCollectionShell.vue` | 默认 `h-full` | 当父级是工作台布局时合理，当父级是普通流式内容时容易拉高 |
| 系统配置舞台容器 | `src/views/system/SystemConfigView.vue` | `min-height: 420px` | 更像页面舞台，不应被当作普通信息卡复制 |
| 标签页工作台容器 | `src/components/common/page-shared/TabbedWorkbenchPage.vue` | `min-height: 240px` | 同样属于工作台骨架容器，不适合作为通用卡片范式 |

## 3. 短内容自适应与长内容滚动的正确分型

### 3.1 短内容自适应场景

#### 适用对象
- 修改密码
- 简短资料编辑
- 单段确认说明
- 少量字段 CRUD 表单
- 单图预览弹窗

#### 预期行为
- 弹窗主体高度由内容自然撑开。
- 仅保留视口级 `max-height` 兜底，不主动把正文区拉成可滚动大容器。
- `footer` 与 `body` 不应为了预留滚动区而制造大块空白。
- 若内容在一屏内可以完整展示，则不应该出现内部滚动条。

#### 当前主要偏差
- 全局 `el-dialog` 默认把所有弹窗都导向“纵向弹性 + 正文滚动”模式。
- 只有少数页面通过专门类名例外处理短内容弹窗，其它短表单弹窗仍然和长表单共用同一结构。
- 这导致全站不存在统一的“短内容弹窗模式”，而是局部文件谁遇到问题谁单独修。

### 3.2 长内容滚动场景

#### 适用对象
- 大表单编辑
- 多商品明细改单
- 订单预览/打印工作台
- 扫码舞台
- 长表格抽屉

#### 预期行为
- 滚动容器只能有一个主责任区。
- 头部和底部操作区应固定在弹层内部，不随正文滚动消失。
- 正文滚动区需要具备 `min-height: 0`，防止在 `flex` 容器中撑破父级。
- 若内部存在预览舞台、表格区、图片区，必须明确谁负责滚动，谁只负责占位。

#### 当前主要偏差
- 部分页面让 `el-dialog__body` 滚动，同时又让内部预览区、表格区再滚动。
- 部分抽屉壳层本身已经可滚动，但业务内容再叠加固定高度和滚动。
- `100vh` 与 `100dvh` 混用，导致同一组件在移动端浏览器地址栏显隐时高度跳动。

### 3.3 工作台卡片场景

#### 适用对象
- 页面骨架区
- 列表舞台区
- 标签切换工作区
- 扫码操作台

#### 预期行为
- 允许使用 `min-height` 保持页面骨架稳定。
- 只允许用在“舞台容器”，不应波及普通详情卡、说明卡、编辑卡。
- 如果子区域还要滚动，父容器必须明确是“定高舞台”而不是“内容卡片”。

#### 当前主要偏差
- `h-full` 与 `min-height` 在工作台型卡片和普通信息卡片之间边界不清。
- 同一个 `apple-card` 既被当成内容卡，又被当成充满父级的工作区，造成同名样式语义过宽。

## 4. 根因清单

### 根因 1：全局弹窗安全网没有区分“短内容模式”和“长内容模式”
- 证据：`src/style.css` 把全局 `.el-dialog` 统一改为纵向 `flex`，正文统一滚动。
- 影响：短表单、确认弹窗、本应随内容收缩的弹窗也会落入滚动型结构。
- 体现：`src/views/system/UserManageView.vue` 之外的短内容弹窗没有统一自适应方案，`src/layout/components/AppHeader.vue`、`src/views/client/ClientProfileView.vue` 仍处于同一全局策略之下。

### 根因 2：通用弹窗壳曾经只统一宽度，没有统一高度语义
- 历史证据：Task1 盘点时，`src/components/common/business-composite/BizCrudDialogShell.vue` 仍只提供宽度与底部按钮封装，没有 `heightMode`、`scrollBody`、`autoBody` 之类的显式参数。
- 历史影响：页面作者只能依赖全局默认规则，或自行追加 class 名修补。
- 当前进展：截至当前代码状态，共享壳已经补齐 `heightMode="auto" | "scroll"`，但仍有部分页面尚未接入，因此问题已经从“共享层缺能力”转为“页面接入未完全收口”。

### 根因 3：滚动责任经常发生“双重归属”
- 证据：
  - `src/views/order-list/OrderListView.vue` 的正式出库单弹窗内部存在预览工作区。
  - `src/views/client/ClientOrderDetailView.vue` 的正式出库单预览区直接设置 `max-height: 56vh; overflow:auto`。
  - `src/views/dashboard/components/TopProductDrilldownDrawer.vue` 的抽屉内部又给表格区域加 `max-h-[55vh] overflow-auto`。
- 影响：外层弹窗/抽屉能滚，内层面板也能滚，导致滚动链混乱、底部按钮偶发被遮挡、鼠标滚轮和触摸滑动手感不稳定。

### 根因 4：抽屉与弹窗内部仍存在硬编码视口差值
- 证据：`src/views/inbound/SupplierHistoryView.vue` 直接使用 `height: calc(100vh - 132px)` 与 `height: calc(100vh - 104px)`。
- 影响：无法正确适配移动端地址栏收缩、系统安全区变化、抽屉头部高度调整。
- 结论：这一类写法属于“经验值定高”，不是结构级解决方案。

### 根因 5：`100vh` 与 `100dvh` 混用，导致多端可视高度基线不一致
- 证据：
  - 全局弹窗安全网使用了 `100dvh`。
  - 局部抽屉/页面仍然出现 `100vh`、`calc(100vh - xxx)`。
- 影响：在移动端浏览器地址栏显隐时，局部组件和全局弹层对“可视高度”的理解不同，容易出现一边铺满、一边超高或少高一截的问题。

### 根因 6：`h-full` 被大量用于数据卡片容器，但父链条并不总是显式定高
- 证据：`src/components/common/business-composite/BizResponsiveDataCollectionShell.vue` 默认表格容器使用 `h-full`。
- 影响：当父级并不是严格的定高工作区，而只是普通流式布局时，卡片会被拉成“空白高盒子”。
- 延伸：这类问题本质不是卡片自身高度错，而是“内容卡”和“舞台卡”没有分型。

### 根因 7：工作台型最小高度被当成了通用卡片经验
- 证据：
  - `src/components/common/page-shared/TabbedWorkbenchPage.vue` 使用 `min-height: 240px`。
  - `src/views/system/SystemConfigView.vue` 使用 `min-height: 420px`。
- 影响：原本用于稳定页面骨架的最小高度，容易被误抄到普通信息卡，造成短内容场景视觉上“高度异常”。

### 根因 8：Teleport 弹层难以被页面级 scoped 样式稳定命中，最终逼出全局特例
- 证据：`src/style.css` 中已经出现 `user-manage-edit-dialog` 这类全局特例兜底。
- 影响：弹层样式治理越来越集中到全局文件，后续页面若继续出现短内容异常，会继续堆新的例外类。
- 风险：规则会逐步从“结构化能力”退化成“类名白名单”。

### 根因 9：当前卡片/弹窗缺少统一命名语义，无法从类名判断高度意图
- 证据：`apple-card` 同时承担普通信息卡、表格舞台卡、工作区卡多种角色。
- 影响：只看类名无法知道该卡片应当“内容自适应”还是“占满工作区”。
- 结果：开发者只能在局部继续叠加 `min-height`、`h-full`、`overflow-hidden` 试错。

## 5. 落地规范建议

### 5.1 弹窗必须显式区分两种高度模式
- 模式一：`auto`
- 适用：短内容表单、确认弹窗、图片预览
- 规则：弹窗主体以内容高度为主，仅保留视口最大高度兜底，正文不主动承担滚动

- 模式二：`scroll`
- 适用：长表单、复杂预览、长列表、扫码工作台
- 规则：弹窗主体受视口上限约束，正文区唯一滚动，头尾固定

### 5.2 抽屉必须遵守“单一滚动容器”规则
- 若抽屉壳层已经 `overflow-y-auto`，业务内部就不要再用大面积 `height: calc(...)` 或额外主滚动层。
- 若业务必须存在局部滚动区，例如长表格预览，则要把外层正文设为非滚动，让内部区域成为唯一滚动责任人。

### 5.3 工作台卡片与内容卡片必须拆语义
- 内容卡片：由内容自然撑高，禁止默认 `h-full`。
- 工作台卡片：允许 `min-height` 或 `h-full`，但必须只出现在明确的页面舞台上下文中。
- 建议后续为两者建立不同类名，而不是继续共用 `apple-card` 后再用业务类补差异。

### 5.4 全站视口单位统一为 `dvh` 系列
- 弹层、抽屉、移动端工作区统一优先使用 `100dvh` 或 `calc(100dvh - xxx)`。
- 禁止在新代码中继续引入 `calc(100vh - xxx)` 作为移动端主高度方案。

### 5.5 所有滚动型弹层都必须检查 `min-height: 0`
- 任何 `flex` 场景下的正文滚动区都必须具备 `min-height: 0`。
- 任何 `h-full` 子节点都必须确认父链条已经是定高结构，否则直接改回内容自适应。

### 5.6 Teleport 弹层的业务差异要通过通用壳参数表达，不再新增全局白名单特例
- 短内容与长内容差异优先收敛到通用弹窗壳和通用抽屉壳。
- `src/style.css` 只保留基础安全网，不继续承担“每个业务弹窗的个案记忆”。

## 6. 后续治理优先级建议

### P0：先治理会直接影响可用性的弹层
- `src/components/common/business-composite/BizCrudDialogShell.vue`
- `src/components/common/business-composite/BizResponsiveDrawerShell.vue`
- `src/style.css`
- `src/views/inbound/SupplierHistoryView.vue`

### P1：再治理双滚动最明显的复杂工作台弹窗
- `src/views/order-list/OrderListView.vue`
- `src/views/client/ClientOrderDetailView.vue`
- `src/views/dashboard/components/TopProductDrilldownDrawer.vue`
- `src/views/o2o/O2oVerifyConsoleView.vue`

### P2：最后收口卡片语义与工作区最小高度
- `src/components/common/business-composite/BizResponsiveDataCollectionShell.vue`
- `src/components/common/page-shared/TabbedWorkbenchPage.vue`
- `src/views/system/SystemConfigView.vue`

## 7. Task1 最终结论
- 结论 1：Task1 盘点时，全站已具备“长内容滚动”的基础安全网，但缺少与之配套的“短内容自适应”正式模式；截至当前代码状态，共享层已开始补齐该能力。
- 结论 2：高度异常的主因不是单一页面写错，而是全局弹层规则、业务局部覆写、卡片语义混用三者叠加造成的结构性问题。
- 结论 3：后续修复不能继续只调个别 `max-height` 或 `height` 数值，而应优先把弹窗、抽屉、工作台卡片的高度模式显式化；当前共享弹窗壳与共享抽屉壳已进入这一阶段。
- 结论 4：`SupplierHistoryView` 这类 `100vh` 硬编码抽屉已经纳入修复样板；正式出库单预览这类双滚动工作台，仍然是下一阶段最优先治理对象。

## 8. Task5 接入进展补充

### 8.1 共享层现状说明
- `BizCrudDialogShell` 已补齐 `heightMode="auto" | "scroll"`，共享弹窗不再只有宽度封装。
- `BizResponsiveDrawerShell` 已补齐正文模式类名与主滚动容器语义，抽屉壳不再默认逼业务页面继续手写 `h-full + overflow-y-auto`。
- `src/style.css` 已同步提供 `ylink-dialog-height-mode--auto / scroll` 与抽屉正文模式规则，开始从“全局白名单特例”转向“共享壳显式表达”。
- 因此，Task1 中“共享壳能力不足”的部分已经进入修复阶段，当前重点变为页面接入规范和剩余特殊场景治理。

### 8.2 已完成接入的页面
- `src/views/system/UserManageView.vue`：用户编辑、重置密码、修改本人密码已统一接入 `BizCrudDialogShell`，并通过“白色卡片本体真实收紧”核验。
- `src/views/system/ClientUserManageView.vue`：客户端用户编辑与密码修改已统一接入 `BizCrudDialogShell`，且短内容弹窗本体高度已完成真实收紧复核。
- `src/views/base-data/components/TagManager.vue`：标签编辑弹窗已接入 `BizCrudDialogShell`，并确认不是“仅 footer 上移”的伪修复。
- `src/views/base-data/components/ProductManager.vue`：单条产品编辑走 `height-mode="auto"` 且已通过本体高度收紧核验，批量新增产品继续走 `height-mode="scroll"` 长内容模式。
- `src/views/inbound/SupplierHistoryView.vue`：详情抽屉已改接 `BizResponsiveDrawerShell`，历史 `calc(100vh - xxx)` 方案已退出主链路。
- `src/views/order-list/OrderListView.vue`：单据详情抽屉已接入 `BizResponsiveDrawerShell`，后台详情抽屉治理已形成可复用样板。

### 8.3 剩余特殊场景
- 后台短内容弹窗仍有零星原生场景未收口，例如 `src/layout/components/AppHeader.vue` 的修改密码弹窗。
- 仪表盘下钻抽屉仍使用原生 `el-drawer`，对应 `src/views/dashboard/components/TopProductDrilldownDrawer.vue` 与 `src/views/dashboard/components/TopCustomerDrilldownDrawer.vue`，仍存在“抽屉自身 + 内部表格区”双滚动风险。
- 客户端与 O2O 侧仍保留多处原生 `el-dialog`，例如 `src/views/client/ClientProfileView.vue`、`src/views/client/ClientOrderDetailView.vue`、`src/views/o2o/O2oProductMallManageView.vue`、`src/views/o2o/O2oVerifyConsoleView.vue`；这些页面多为客户端视觉语言或复杂工作台场景，不能简单套用后台通用壳。
- `src/views/order-entry/components/OrderEntryItemsEditor.vue` 的移动端局部明细抽屉仍是组件私有实现，当前可保留，但若后续出现第二个同类模式，应重新评估共享化。
- `src/components/common/page-shared/UnifiedScanDialog.vue` 与正式出库单预览类弹窗属于专用工作台/专用舞台场景，应继续保留专用壳，但必须遵守单一主滚动、`dvh` 与头尾稳定规则。

### 8.4 与 Task5 文档的关系
- Task1 负责盘点问题与根因，不直接承担最终接入规则沉淀。
- 当前代码状态下的正式“使用约定、页面接入规范、已修复页面清单、剩余特殊场景台账”，统一以 `spec/task5-通用弹窗壳与抽屉壳使用约定及页面接入规范.md` 为准。
- 自 Task8 起，相关状态表述统一升级为“已完成本体高度真实收紧核验”，避免再次把“只移动 footer”的结果误记为已修复。
