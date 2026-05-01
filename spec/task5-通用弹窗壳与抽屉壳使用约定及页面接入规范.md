# Task5：通用弹窗壳与抽屉壳使用约定及页面接入规范

## 文件说明
- 本文档用于沉淀管理端通用弹窗壳 `BizCrudDialogShell` 与通用抽屉壳 `BizResponsiveDrawerShell` 的现行使用约定，统一后续页面接入口径。
- 文档重点覆盖三部分内容：共享壳能力边界、页面接入规范、当前已完成接入页面与剩余特殊场景台账。
- 本文档对应 Task5 交付物，默认基于当前仓库实际代码状态编写，而不是停留在 Task1 的问题盘点阶段。
- 盘点范围主要来自以下文件：
  - `src/components/common/business-composite/BizCrudDialogShell.vue`
  - `src/components/common/business-composite/BizResponsiveDrawerShell.vue`
  - `src/style.css`
  - `src/views/system/UserManageView.vue`
  - `src/views/system/ClientUserManageView.vue`
  - `src/views/base-data/components/ProductManager.vue`
  - `src/views/base-data/components/TagManager.vue`
  - `src/views/inbound/SupplierHistoryView.vue`
  - `src/views/order-list/OrderListView.vue`
  - `src/layout/components/AppHeader.vue`
  - `src/views/client/ClientProfileView.vue`
  - `src/views/client/ClientOrderDetailView.vue`
  - `src/views/o2o/O2oVerifyConsoleView.vue`
  - `src/views/o2o/O2oProductMallManageView.vue`
  - `src/views/dashboard/components/TopProductDrilldownDrawer.vue`
  - `src/views/dashboard/components/TopCustomerDrilldownDrawer.vue`
  - `src/views/order-entry/components/OrderEntryItemsEditor.vue`
  - `src/components/common/page-shared/UnifiedScanDialog.vue`

## 1. Task5 当前结论

### 1.1 共享层能力已经具备，后续重点转向“按规范接入”
- `BizCrudDialogShell` 已支持 `heightMode="auto" | "scroll"`，并通过 `ylink-dialog-height-mode--auto / scroll` 显式挂接到全局弹窗高度安全网。
- `BizResponsiveDrawerShell` 已支持 `heightMode="auto" | "scroll"`，并通过 `ylink-responsive-drawer-shell__body--auto / scroll` 把正文滚动职责收敛到共享壳。
- `src/style.css` 已配套提供统一规则：普通 `el-dialog` 默认继续走滚动型兜底，而通用壳通过显式类名切换短内容与长内容模式。
- 因此，当前阶段最重要的问题已经不是“共享壳有没有能力”，而是“业务页面有没有按场景正确接入共享壳”。

### 1.2 Task5 的目标不是替换所有弹层，而是先收敛标准场景
- 标准后台 CRUD 弹窗应优先接入 `BizCrudDialogShell`。
- 标准后台详情抽屉应优先接入 `BizResponsiveDrawerShell`。
- 具备强工作台属性、强视觉舞台属性或客户端独立交互语义的弹层，允许暂时保留原生 `el-dialog / el-drawer`，但必须记录为特殊场景，不再无差别复制到普通页面。

### 1.3 Task8 核验补充结论
- 当前仓库已完成“白色卡片本体真实收紧”复核，验收口径明确改为“弹窗本体高度变化”，不再接受“仅 footer 上移”的伪修复结果。
- 根因已经收敛到共享弹窗壳链路：`align-center` 触发的遮罩层 `flex` 对齐语义若未补齐，单改 `el-dialog__body` 只能让 footer 回位，无法让白色弹窗本体同步缩短。
- `src/style.css` 已通过 `ylink-crud-dialog-shell-overlay` 与 `ylink-dialog-height-mode--auto` 组合修复外层对齐与正文模式；`UserManageView`、`ClientUserManageView`、`TagManager`、`ProductManager` 的短弹窗也已显式接入 `height-mode="auto"`。
- 本次复核同时确认最近修改文件无新增 diagnostics，且前端 `npm run build` 构建通过，因此文档中的“已完成接入”现已提升为“已完成真实收紧核验通过”。

## 2. 共享壳能力边界

### 2.1 `BizCrudDialogShell` 负责什么
- 负责后台通用 CRUD 弹窗的统一宽度策略、关闭回传、底部按钮与高度模式表达。
- 适合简短表单、重置密码、少量字段编辑、批量录入面板等后台弹窗。
- 默认 `heightMode="scroll"`，因此如果页面是短表单，必须主动改为 `heightMode="auto"`，不能继续吃默认值。
- 若页面只需要自定义正文与少量宽度差异，应优先通过 `phoneWidth / tabletWidth / desktopWidth / dialogClass` 扩展，而不是退回原生 `el-dialog`。

### 2.2 `BizResponsiveDrawerShell` 负责什么
- 负责后台详情抽屉在手机、平板、桌面三端的方向与尺寸切换。
- 负责把正文滚动策略统一收敛为 `auto / scroll` 两种模式，减少页面重复写 `h-full`、`overflow-y-auto`、`calc(100vh - xxx)`。
- 默认 `heightMode="scroll"`，适合详情、长列表、长说明等需要稳定滚动区域的场景。
- 若页面只是轻量说明抽屉或少量确认内容，可改为 `heightMode="auto"`，避免正文被强制撑满。

### 2.3 共享壳不负责什么
- 不负责客户端独立品牌化弹层样式，例如客户端个人中心、客户端订单详情的移动端卡片式弹窗。
- 不负责打印预览、扫码舞台这类带有复杂视觉舞台和内部双栏布局的专用弹层。
- 不负责组件内部私有的微型编辑抽屉，例如明细编辑组件内部只服务于单一页面的局部抽屉。
- 以上场景允许保留原生实现，但后续若出现同类需求反复复制，仍应评估是否继续抽象到共享层。

## 3. 页面接入决策规范

### 3.1 什么时候必须优先接入通用弹窗壳
- 页面位于管理端，且弹层用途属于“新建 / 编辑 / 重置 / 确认提交”一类标准 CRUD 交互。
- 页面不需要复杂的专属视觉舞台，只是常规表单、说明块、基础按钮区组合。
- 页面过去为了修短内容高度，已经出现单独类名或全局白名单倾向时，应优先收口到 `BizCrudDialogShell`。

### 3.2 什么时候必须优先接入通用抽屉壳
- 页面位于管理端，且弹层本质是“查看详情”“长列表详情”“明细下钻”等右侧或底部展开内容。
- 页面需要响应式方向切换，尤其是手机端不能继续硬编码桌面尺寸时。
- 页面已经出现 `calc(100vh - xxx)`、`h-full + overflow-auto`、多层滚动容器叠加时，应优先改为 `BizResponsiveDrawerShell`。

### 3.3 什么时候允许保留原生弹层
- 页面为客户端场景，弹层外观与交互强依赖当前移动端视觉语言，直接替换共享壳会引入较大样式回归风险。
- 页面是打印、预览、扫码、工作台式编辑器，内部存在独立舞台区、预览区、表单区或设备容器，需要自行精细控制布局。
- 弹层只在单一复合组件内部使用，且该交互不会在其它页面复用，此时优先保持局部封装而不是过早共享。
- 即便保留原生弹层，也必须遵守统一的高度与滚动规范，不能重新引入 Task1 中已经明确禁止的硬编码模式。

## 4. `heightMode` 使用约定

### 4.1 `heightMode="auto"` 的适用规则
- 适用于短内容表单、简短确认说明、重置密码、基础资料单卡编辑等一屏内可读完的内容。
- 预期结果是弹窗或抽屉高度随内容自然增长，仅保留视口最大高度兜底，不主动制造正文滚动区。
- 页面内部不再额外包一层“占满剩余空间”的大容器，也不要再手动补 `min-h-0`、`overflow-auto` 试图制造滚动。
- 典型页面：
  - `src/views/system/UserManageView.vue`
  - `src/views/system/ClientUserManageView.vue`
  - `src/views/base-data/components/TagManager.vue`
  - `src/views/base-data/components/ProductManager.vue` 的单条编辑弹窗

### 4.2 `heightMode="scroll"` 的适用规则
- 适用于长表单、批量录入、长详情、明细抽屉、复杂编辑舞台等正文可能超过一屏的内容。
- 预期结果是共享壳内部只保留一个主滚动责任区，头部与底部操作区稳定可见，正文在安全高度内滚动。
- 页面内部允许存在局部辅助滚动区，但必须明确谁是唯一主滚动容器，不能让外层正文和内层主体同时承担主滚动。
- 典型页面：
  - `src/views/base-data/components/ProductManager.vue` 的批量新增产品弹窗
  - `src/views/inbound/SupplierHistoryView.vue`
  - `src/views/order-list/OrderListView.vue`

### 4.3 使用 `heightMode` 时的禁止事项
- 禁止短内容弹窗继续依赖默认 `scroll` 模式，否则会把本应自然收缩的弹窗重新拉成滚动型结构。
- 禁止在 `scroll` 模式下再给主内容区域追加大面积 `height: calc(...)` 或第二层全局滚动容器。
- 禁止把 `heightMode` 当成视觉开关；它表达的是结构语义，不是简单的样式偏好。

## 5. 页面接入实现规范

### 5.1 通用弹窗壳接入规则
- 必须使用 `v-model` 与页面可见状态单一绑定，不再额外维护平行的内部显隐状态。
- 短内容页面必须显式声明 `height-mode="auto"`；长内容页面必须显式声明 `height-mode="scroll"`，不要依赖读者猜测默认值。
- 若需要更窄或更宽的阅读宽度，优先配置 `phone-width / tablet-width / desktop-width`，不要直接回退到原生 `width + style="max-width: ..."`。
- 若页面有少量业务样式差异，使用 `dialog-class` 补充视觉类名；禁止为了高度问题再去新增全局白名单类。
- 若需要在动画关闭后清理表单、重置校验或恢复局部状态，统一监听 `closed` 事件处理。

### 5.2 通用抽屉壳接入规则
- 必须优先把页面级详情、下钻、明细查看类交互接到 `BizResponsiveDrawerShell`，由壳层统一计算三端方向与尺寸。
- 默认使用 `height-mode="scroll"`；只有内容明显很短时才改为 `auto`。
- 若页面需要覆盖正文额外留白或右侧间距，优先通过 `body-class` 微调，而不是重新定义主滚动结构。
- 若页面需要业务标识类名，使用 `drawer-class`；但该类名只允许承担视觉定制，不允许再次接管高度策略。
- 抽屉正文中的列表、详情块要以“自然流 + 单一滚动容器”为主，不再使用 `calc(100vh - xxx)` 兜底高度。

### 5.3 滚动责任规范
- 外层弹层已经是主滚动容器时，内部内容区域原则上只允许自然流排版。
- 若必须存在局部滚动区，例如打印预览、明细大表格、扫码视频舞台，则必须明确外层正文不再承担同级主滚动。
- 所有 `flex` 正文容器都要具备 `min-height: 0` 语义；共享壳已经处理的场景，页面层不要重复补同类修复。
- 新增页面不得继续引入 `calc(100vh - xxx)` 作为主高度方案，统一改用共享壳或 `dvh` 基线。

### 5.4 特殊页面备案规则
- 原生弹层若因为业务复杂度暂不迁移，必须在文档中说明“为什么不迁移”和“当前主要风险”。
- 特殊场景不等于永久例外；当同类模式出现第二个页面时，应重新评估是否抽到共享层。
- 对于已经具备共享化潜力的特殊页面，应明确其下一步治理方向，避免长期停留在“先这样用着”。

## 6. 已完成接入页面清单

| 页面/组件 | 当前接入方式 | 高度模式 | 接入结论 |
|---|---|---|---|
| `src/views/system/UserManageView.vue` | `BizCrudDialogShell` | `auto` | 用户编辑、重置密码、修改本人密码均已通过“本体高度真实收紧”核验 |
| `src/views/system/ClientUserManageView.vue` | `BizCrudDialogShell` | `auto` | 客户端用户编辑与密码修改已通过短内容白卡本体收紧核验 |
| `src/views/base-data/components/TagManager.vue` | `BizCrudDialogShell` | `auto` | 基础短表单已通过“本体高度变化”验收，不再是仅按钮上移 |
| `src/views/base-data/components/ProductManager.vue` | `BizCrudDialogShell` | `auto / scroll` | 单产品编辑已通过本体真实收紧核验，批量新增继续保持 `scroll` 长内容模式 |
| `src/views/inbound/SupplierHistoryView.vue` | `BizResponsiveDrawerShell` | `scroll` | 已移除历史 `100vh` 差值写法，由共享抽屉壳承接主滚动 |
| `src/views/order-list/OrderListView.vue` | `BizResponsiveDrawerShell` | `scroll` | 单据详情抽屉已接入共享壳，详情主滚动职责已收口 |

## 7. 剩余特殊场景台账

### 7.1 暂未接入通用弹窗壳的原生弹窗

| 页面/组件 | 当前实现 | 保留原生原因 | 当前风险或后续建议 |
|---|---|---|---|
| `src/layout/components/AppHeader.vue` | 原生 `el-dialog` 修改密码弹窗 | 位于布局头部，当前复用路径单一，迁移收益有限 | 仍属后台短内容弹窗，后续可直接切到 `BizCrudDialogShell + auto`，进一步统一管理端密码类弹窗 |
| `src/views/client/ClientProfileView.vue` | 原生 `el-dialog` 修改密码/编辑资料 | 客户端弹层视觉语言与后台不同，当前更偏移动端品牌化卡片体验 | 需继续关注短内容空白感；若客户端后续出现更多同类弹窗，可抽客户端专用壳而不是直接复用后台壳 |
| `src/views/o2o/O2oProductMallManageView.vue` | 原生 `el-dialog` 商品编辑/图片预览 | 编辑弹窗包含上传、预览图、状态区、详情文本，多块布局与客户端商城语义耦合较深 | 商品编辑弹窗具备共享潜力，后续可评估迁移到 `BizCrudDialogShell + scroll`；图片预览属于轻专用场景，可继续保留 |
| `src/views/o2o/O2oVerifyConsoleView.vue` | 原生 `el-dialog` 退货拒绝/现场改单 | 当前核销台弹窗与扫码、订单重算逻辑紧耦合 | 拒绝退货弹窗偏短内容，可先行迁移；现场改单属于复杂长内容，需先梳理主滚动责任再迁移 |
| `src/views/client/ClientOrderDetailView.vue` | 原生 `el-dialog` 修改订单/正式出库单/申请退货 | 客户端场景，且含工作台式预览与多块编辑内容 | `修改订单` 与 `申请退货` 可评估抽客户端专用壳；正式出库单预览继续作为专用工作台处理 |
| `src/views/order-list/OrderListView.vue` | 原生 `el-dialog` 正式出库单工作台 | 内部为典型“编辑区 + 预览区 + 打印导出”舞台式结构 | 不建议直接替换为通用弹窗壳，应在专用工作台规范下继续治理双滚动 |

### 7.2 暂未接入通用抽屉壳的原生抽屉

| 页面/组件 | 当前实现 | 保留原生原因 | 当前风险或后续建议 |
|---|---|---|---|
| `src/views/dashboard/components/TopProductDrilldownDrawer.vue` | 原生 `el-drawer` | 仪表盘下钻体量较小，历史实现简单 | 当前抽屉体与内部表格区都可能形成滚动，后续应优先迁移到 `BizResponsiveDrawerShell` |
| `src/views/dashboard/components/TopCustomerDrilldownDrawer.vue` | 原生 `el-drawer` | 与商品下钻抽屉同类，历史实现沿用同一模式 | 建议与商品下钻一起成对迁移，统一仪表盘下钻抽屉规范 |
| `src/views/order-entry/components/OrderEntryItemsEditor.vue` | 原生 `el-drawer` | 仅服务订单录入页移动端明细编辑，属于组件内局部私有抽屉 | 暂可保留，但若后续出现第二个同类“移动端局部明细编辑抽屉”，应抽成共享壳或共享模式 |

### 7.3 已备案但应继续保留专用壳的特殊场景

| 页面/组件 | 当前实现 | 保留原因 | 规范结论 |
|---|---|---|---|
| `src/components/common/page-shared/UnifiedScanDialog.vue` | 专用扫码弹窗壳 | 扫码舞台需要独立设备容器、引导框与桌面/移动双布局 | 继续保留专用壳，但需遵守 `dvh`、单一主滚动、头尾固定等共性规范 |
| `src/views/order-list/OrderListView.vue` 正式出库单 | 原生专用工作台弹窗 | 打印预览、导出 PDF、方向切换、编辑区与预览区并存 | 作为“工作台型弹窗”单独治理，不纳入普通 CRUD 弹窗壳 |
| `src/views/client/ClientOrderDetailView.vue` 正式出库单 | 原生专用工作台弹窗 | 与管理端同类，且在客户端语义下展示 | 保留专用实现，后续重点检查双滚动与移动端阅读体验 |

## 8. Task5 后续接入优先级

### P0：低成本统一后台短内容弹窗
- `src/layout/components/AppHeader.vue`
- `src/views/o2o/O2oVerifyConsoleView.vue` 的“拒绝退货申请”弹窗

### P1：统一仪表盘下钻抽屉
- `src/views/dashboard/components/TopProductDrilldownDrawer.vue`
- `src/views/dashboard/components/TopCustomerDrilldownDrawer.vue`

### P2：收口复杂长内容场景
- `src/views/o2o/O2oProductMallManageView.vue`
- `src/views/o2o/O2oVerifyConsoleView.vue` 的“现场改单”弹窗
- `src/views/client/ClientOrderDetailView.vue` 的长内容客户端弹窗

### P3：整理专用工作台弹窗规范
- `src/views/order-list/OrderListView.vue` 正式出库单
- `src/views/client/ClientOrderDetailView.vue` 正式出库单
- `src/components/common/page-shared/UnifiedScanDialog.vue`

## 9. 最终执行口径
- 新增管理端标准 CRUD 弹窗，默认先选 `BizCrudDialogShell`，再决定 `auto` 或 `scroll`。
- 新增管理端详情抽屉，默认先选 `BizResponsiveDrawerShell`，避免重新发明尺寸和滚动策略。
- 只有在明确属于客户端专用交互、扫码舞台、打印预览工作台、组件私有抽屉时，才允许保留原生弹层。
- 已备案的特殊场景可以暂时存在，但不得再把其实现方式扩散为新的普通页面范式。
