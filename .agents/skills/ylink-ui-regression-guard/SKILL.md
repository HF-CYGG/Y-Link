---
name: "ylink-ui-regression-guard"
description: "Fixes Y-Link UI, layout, dark-mode, dialog/drawer shell, print/PDF, and mobile viewport regressions by frontend structure. Invoke when admin or client layouts flicker, overlap, double-scroll, leak dark styles, misalign buttons/fixed columns, or become unusable on phone and desktop."
---

# Y-Link 前端界面与布局回归防护指南

## 目标

- 面向 `Y-Link` 管理端、客户端、共享弹窗/抽屉壳层、明暗主题及打印/PDF 模板做结构化 UI 根因修复。
- 彻底杜绝“魔法数字硬压、双层主滚动条、暗色样式全站泄漏、Element Plus 按钮间距错位、固定列透字、移动端视口/悬浮遮挡失衡”等高频 UI 回归。

## 必读上下文导航（三步读取）

动手修改任何 UI 布局、样式、弹层壳、动效或组件前，必须遵守“三步读取”：

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **总览页**：`docs/project-context/10-前端平台层与共享机制.md`
3. **按主题下钻文档**：
   - 路由舞台、`KeepAlive`、`viewKey` 与主壳层：`11-路由、壳层与预热机制.md`
   - 共享弹窗/抽屉壳层、明暗主题规则、CSS 选择器禁忌：`12-Store、共享组件与请求编排.md`
   - 出库凭证打印/PDF 与表格固定操作列：`21-工作台、报表与出库链路.md`
   - 客服工作台三栏响应式断点与属性栏复用：`24-系统管理、用户中心与客服工作台.md`
   - 条码标签打印纸张/密度估算与扫码聚焦：`25-库存管理、条码与盘点.md`
   - 商城悬浮购物车遮挡、`98px` 虚拟行高、步进器列宽、图片预览与动效降级：`31-客户端鉴权、商城、购物车与结算.md`
   - 硬性开发规范：`docs/前端页面与共享层接入规范.md`、`AGENTS.md`（第 2 章 Vue 头部注释规范、第 3 章 Element Plus 使用规范）

## 何时使用

- 页面出现以下任一界面或布局异常：
  - 页面/标签切换闪烁、重影、错位或底部导航瞬间下移
  - 弹窗或抽屉出现双层滚动条、内容溢出白色卡片或按钮区裁切
  - 暗色模式下出现白块、蓝调卡片边框（`slate-*`）、全局样式泄漏（裸 `.dark`）或文字发灰/对比度不足
  - Element Plus 按钮换行缩进/纵向错位、桌面表格右侧 `fixed` 操作列横向滚动透字
  - 手机端商城列表被悬浮购物车遮挡、639px 以下分类与正文挤压、扫码框异常或打印/PDF 版面偏移

## 前端结构覆盖地图

### 1. 管理端布局与共享壳层
- 主壳层：`src/layout/AppLayout.vue`、`src/layout/components/{AppHeader,AppSidebar,QuoteBanner,ThemeToggle}.vue`
- 共享壳：`src/components/common/page-container/PageContainer.vue`、`src/components/common/page-shared/{PageToolbarCard,PagePaginationBar,TabbedWorkbenchPage,UnifiedScanDialog,PassiveNumberInput,PassivePreviewImage,PassiveSegmentedTabs}.vue`、`src/components/common/business-composite/{BizCrudDialogShell,BizResponsiveDrawerShell,BizResponsiveDataCollectionShell,BizO2oItemSpecText}.vue`

### 2. 客户端布局与视觉舞台
- 壳层与视图：`src/views/client/components/{ClientMainLayout,ClientShell,ClientCardCartStepper,ClientMultiSkuSelector,ClientQtyInput,ClientImagePreviewer}.vue`、`src/views/client/*.vue`
- 视口与动效工具：`src/views/client/{client-mall-viewport,client-image-preview}.helpers.ts`、`src/utils/client-motion.ts`

### 3. 业务工作台与打印/PDF 模板
- 业务页：`src/views/{dashboard,order-entry,order-list,inbound,inventory,o2o,base-data,product-center,reports,system}/**`
- 纸面打印模板：`src/views/order-list/components/OrderVoucherTemplate.vue`、`src/views/inbound/components/InboundDeliverySheetTemplate.vue`、`src/views/inventory/components/{BarcodeLabelPrintDialog,BarcodeLabelCard}.vue`

### 4. 全局样式与设备交互
- 全局样式与变量：`src/style.css`、`src/theme-init.js`
- 交互组合逻辑：`src/composables/{useDevice,useCameraQrScanner,useBarcodeScanInput}.ts`

## 六大 UI 防回归红线（必须严格遵守）

1. **弹层共享壳层与双滚动禁令**：
   - 弹窗优先走 `BizCrudDialogShell`（短表单 `height-mode="auto"`，长表单 `height-mode="scroll"`）；详情与移动端编辑优先走 `BizResponsiveDrawerShell`。
   - `height-mode="auto"` 模式**严禁**将正文改回 `flex: 0 0 auto + overflow: visible`（会导致分组卡片与底部按钮溢出白色面板）。
   - 已接入共享壳后，业务页内部**严禁**再套 `max-h-[55vh] overflow-auto` 等主滚动容器制造双层滚动；禁止新增散点原生 `el-dialog / el-drawer`。
2. **Element Plus 规范与按钮组间距陷阱**：
   - 可交互控件优先使用 Element Plus 原生组件（遵循当前 API，避免废弃的 `label act as value`、`small`）；除打印/PDF 纸面模板外不回退原生 `button/input/select/dialog`。
   - Element Plus 默认给 `.el-button + .el-button` 加 `margin-left: 12px`，与 `gap` 叠加会引起换行缩进、纵排右偏或 grid 偏移：Tailwind `flex/grid + gap-*` 已由 `src/style.css` 全局清零；使用自定义类 + CSS `gap` 的按钮容器必须在组件内补 `.容器 > :deep(.el-button + .el-button) { margin-left: 0; }`。
3. **暗色模式（Dark Mode）与固定列透字红线**：
   - **严禁**写 `:global(.dark) .x`（会被编译为裸 `.dark` 作用到 `html` 污染全站！构建后 `dist/assets/*.css` 中绝不允许出现裸 `}.dark{`）和 `.dark :deep(.x)`（作用域属性落在 `html` 上永不生效）。
   - 组件内暗色正确写法：`.dark .本组件类 { }` 或 `.dark .本组件类 :deep(.el-xxx)`；传送到 `body` 的浮层用 `:global(.dark .浮层专属类 ...)`。
   - **严禁**在暗色底色/边框中使用蓝调 slate 系（`dark:bg-slate-700~950`、`dark:border-slate-600/700` 或对应 rgba）：卡片底用 `dark:bg-[#141415]`，浅灰块用 `dark:bg-white/5~10`，加深块用 `dark:bg-black/N`，边框用 `dark:border-white/10`，亮色 `bg-slate-900` 选中态在暗色补 `dark:bg-brand`。
   - `scoped` 中的 `background: linear-gradient(浅色)` 是背景图，`dark:bg-*` 盖不住，必须在暗色规则中重写 `background`。
   - 桌面表格（如出库列表、用户管理表）右侧 `fixed` 操作列在普通、斑马纹、hover、选中与高亮状态下必须使用**不透明合成底色**，防止横向滚动时底层文字透出。
4. **客户端视口、悬浮遮挡与动效降级**：
   - 商城尾部留白、分类栏高度与 `scroll-padding-bottom` 统一由 `--mall-floating-occlusion`（`client-mall-viewport.helpers.ts`）驱动，确保列表滚到底时末项完整停在悬浮购物车上方；`100dvh` 前必须保留 `100vh` 回退；639px 以下分类移至商品上方横向滚动。
   - 卡片步进器操作列固定最小宽度（桌面 `5.1rem`、手机 `4.9rem`），虚拟列表 `itemHeight: 98` 不变；卡片 hover 抬起仅在 `(hover: hover) and (pointer: fine)` 下生效；所有动画必须遵守 `prefers-reduced-motion` 降级。
   - `ClientImagePreviewer.vue` 滚轮缩放必须使用 `{ passive: true }` 监听（`verify:passive-wheel` 校验），遮罩不使用 `inset` 简写。
5. **打印、PDF 与扫码舞台稳定性**：
   - 打印模板、凭证纸面与二维码区域必须始终白底黑字（`style.css` 已在 `@media print` 强制亮色，严禁给纸面或二维码容器加 `dark:` 背景）。
   - 出库凭证 PDF 捕获期间仅临时恢复 html2canvas 隐藏字体测量图片行内布局并等待字体就绪，事后释放；条码标签打印以手动宽高（20–120mm）为真源，确保 Code128 两侧 10X 静区与 A4 194×281mm 净区。
   - 扫码弹窗确保视觉舞台、识别框与说明区协同排版；切页动画让过渡视图脱离正常文档流，建立稳定舞台容器。
6. **Vue 组件头部中文注释规范**：
   - 新增或重构核心页面、工作台、弹窗或抽屉时，必须在文件顶部按 `AGENTS.md` 第 2 章结构编写 `模块说明 / 文件职责 / 实现逻辑 / 维护说明` 中文注释。

## 分层验证命令矩阵

- **基础与编码必跑**：
  - `npm run verify:text-encoding`
  - `npm run build`
- **布局、交互与浏览器专项**：
  - `npm run verify:passive-wheel`
  - `npm run verify:product-sku-layout`
  - `npm run verify:client-detail-layout`
  - `npm run verify:client-mall-floating-layout`
  - `npm run verify:order-merge-frontend`
  - `node scripts/verify-client-purchase-ui.mjs`
  - 若涉及核心页面或共享壳重构：`npm run verify:performance`
- **构建产物暗色自检**：
  - 若改动样式，检查构建后的 `dist/assets/*.css` 不得存在裸 `}.dark{` 全站污染规则，并分别验证亮色与暗色、桌面端与窄屏移动端显示（若未在真实浏览器实测目测，必须明确标明未验证）。

## 输出要求

- 先给出根本布局/CSS 原因，不以调魔法数字充当根因。
- 明确说明改动了哪个共享壳层、样式选择器、过渡逻辑或移动端视口约束，以及受影响的管理端/客户端页面。
- 如实报告实际运行的构建与专项脚本结果，以及亮色/暗色或真机浏览器是否已完成实测。

## 示例

- “客户端底部导航在路由过渡时瞬间下移或商城滚到底被悬浮购物车遮挡”
- “暗色模式下卡片边框出现异常蓝色调或 `dist/assets/*.css` 泄漏裸 `.dark` 规则”
- “出库列表桌面端固定操作列在横向滚动与斑马纹状态下透出底层日期文字”
- “长表单在 `BizCrudDialogShell` 内双层滚动或移动端底部操作按钮溢出裁切”
