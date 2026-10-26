# Y-Link Store、共享组件与请求编排

## 适用范围

- 适用于改动 Pinia Store、共享页面壳、弹窗/抽屉容器、稳定请求和权限动作时。
- 适用于定位“请求乱序、缓存串号、共享组件双滚动、弹层失控”等问题。

## 最后核对来源

- `src/store/modules/auth.ts`
- `src/store/modules/client-auth.ts`
- `src/store/modules/client-cart.ts`
- `src/store/modules/client-catalog.ts`
- `src/store/modules/client-order.ts`
- `src/composables/useStableRequest.ts`
- `src/composables/usePermissionAction.ts`
- `src/components/common/*`
- `src/store/modules/theme.ts`
- `src/layout/components/ThemeToggle.vue`
- `src/theme-init.js`
- `src/style.css`
- `docs/前端页面与共享层接入规范.md`

## 真实入口

- 管理端鉴权真源：`src/store/modules/auth.ts`
- 客户端鉴权真源：`src/store/modules/client-auth.ts`
- 客户端购物车真源：`src/store/modules/client-cart.ts`
- 请求稳定器：`src/composables/useStableRequest.ts`
- 权限动作收口：`src/composables/usePermissionAction.ts`
- 明暗主题真源：`src/store/modules/theme.ts`；首帧主题：`src/theme-init.js`；切换开关：`src/layout/components/ThemeToggle.vue`

## 前端链路

- 管理端 `auth.ts` 只维护用户快照、权限集、初始化状态和登录过渡态，不保存真实 token。
- 客户端 `client-auth.ts` 负责登录、注册、找回密码、会话恢复，并在退出或账号切换时清理购物车、目录和订单缓存。
- `client-cart.ts` 以“现有库存 + 单人限购”为统一约束，并在目录刷新后尽量重映射商品和 SKU，而不是直接清空。
- `useStableRequest.ts` 通过“只保留最后一次请求结果 + 自动中止旧请求”解决高频筛选和详情切换的竞态问题。
- 基础数据变更刷新：管理端 31 个路由开启 KeepAlive，缓存页只在首次挂载时加载的下拉选项会过期。`src/utils/data-change-signal.ts` 由 `http.ts` 响应拦截器在写请求成功（`code === 0`）后按 URL 前缀递增数据域版本：`products`（`/products`、`/tags`、`/inventory/categories|locations|docs|stocktakes`）、`departments`（`/system-configs/client-departments`、`/client-users/department-accounts`），预览/查询类 POST 不计。页面用 `useDataChangeRefresh(domains, refresh)` 订阅：停用期间的变更在激活时静默刷新，激活期间收到的变更立即静默刷新（信号不带来源，其他页面的慢写请求可能在切回后才返回，不能当作本页自身操作跳过）；刷新严格串行，完成后若期间又出现新版本就继续补刷，避免并发刷新的旧响应覆盖新数据；只有刷新成功（不抛错且不返回 `false`）才推进已同步版本，失败时停止补刷，后续变更或下次激活继续重试。已接入出库开单（商品、部门）、订单池与客户端用户管理（部门）、线上展示与报表中心（标签）、库存查询与库存主数据（分类、库位）、入库扫码、供方送货、O2O 入库（商品）。仅当前标签页内生效，不跨浏览器标签页。新增共享基础数据写接口或新的缓存页选项时，同步核对规则与接入点。
- `usePermissionAction.ts` 统一处理显隐、点击前权限拦截和越权提示。
- 共享页面结构组件主要分三类：
  - 页面容器：`PageContainer`、`PageToolbarCard`、`PagePaginationBar`
  - 业务壳层：`BizResponsiveDataCollectionShell`、`BizResponsiveDrawerShell`、`BizCrudDialogShell`
  - 基础展示：`BaseRequestState`、`BaseRouteErrorState`、`BaseEmptyState`
- 明暗主题：
  - 存储键 `y-link-theme-preference` 只记录用户显式选择；未选择时跟随系统 `prefers-color-scheme` 并实时响应；旧键 `y-link-theme-mode`（主题锁定期间写入的默认亮色）在初始化时清理；
  - `src/theme-init.js` 以同源经典同步脚本在首帧前给 html 挂 `dark`/`light` 类（页面 CSP 为 `script-src 'self'`，不能改成内联脚本；`type="module"` 会延后执行），与 Store 判定口径必须一致；
  - 构建时由 `vite.config.ts` 的 `themeInitScriptPlugin` 输出为 `assets/theme-init-<内容哈希>.js` 并改写 HTML 引用。Nginx 对 `.js` 一律一年 `immutable` 长缓存，不能移回 `public/` 用固定文件名；预算脚本把它计入首屏 JS，并拒绝 `dist/assets` 之外的经典脚本；
  - `ThemeToggle` 用 `el-switch`（滑块内嵌太阳/月亮），`before-change` 返回 false、由 Store 执行切换并保留点击点圆形揭幕；放置于管理端顶栏（异步拆包，不进首屏）、管理端登录页、客户端主壳层、客户端登录页与找回密码页；
  - 品牌主色色阶在 `style.css` 中以 `html:not(.dark)` / `html.dark` 两组声明，禁止再用内联样式写到 html 上（会压过暗色）；Tailwind `brand` 色由 `--ylink-brand-rgb` 驱动；
  - `--ylink-color-*` / `--ylink-shadow-*` 业务变量已有暗色值，新代码优先引用变量。

## 后端链路

- Store 不应擅自重算后端业务状态，只能缓存快照和本地交互状态。
- 权限显隐如果与后端权限码不一致，会表现为“前端可点但接口 403”，因此 Store 与 `usePermissionAction` 只是前端兜底，不是最终授权源。

## 关键状态/字段/快照

- 管理端 `auth` 快照包含：当前用户、权限集、初始化态、登录过渡态。
- 客户端 `client-auth` 快照包含：当前用户、过期时间、初始化态。
- 购物车快照除了数量，还会持久化价格、库存、限购和选择态，保证刷新后仍能恢复局部视图。
- 稳定请求内部通过 `AbortController + latestRequestId` 只允许最后一次结果回写。
- 主题状态：`themePreference`（用户选择或 null）+ `systemPrefersDark` 合成 `themeMode` / `isDark`；DOM 只由 Store 的同步 watcher 写入 html/body 的 `dark`/`light` 类与 `color-scheme`。

## 权限与安全边界

- 页面层禁止手写分散的 `showPermissionDenied()` 分支，统一走 `usePermissionAction`。
- 管理端和客户端本地缓存都不能成为真实授权依据，真实授权只能看服务端返回和后端路由权限。
- 账号切换时必须清理用户绑定缓存，避免把前一个账号的购物车或订单带到下一个账号。

## 常见异常与排查顺序

1. 高频筛选结果乱序：查页面是否接入 `useStableRequest.ts`。
2. 客户端换号后购物车串号：查 `client-auth.ts` 的 `clearClientScopedStores()` 和 `client-cart.ts` 初始化逻辑。
3. 弹层双滚动或高度异常：查页面是否绕过共享壳层自己再包一层主滚动容器。
4. 按钮显示/禁用异常：查 `usePermissionAction.ts`、Store 权限集和页面 computed。
5. 新增商品、部门、标签后其他页面不刷新：查写接口 URL 是否被 `data-change-signal.ts` 规则命中、消费页是否接入 `useDataChangeRefresh` 且 refresh 拉取的正是该选项。
5. 刷新后局部状态丢失：查对应 Store 是否做了持久化快照。
6. 暗色下某处仍是白块或深色字：
   - Tailwind 浅色类要配 `dark:` 变体（白底 `dark:bg-[#141415]`、浅灰底 `dark:bg-white/5`、边框 `dark:border-white/10`、正文 `dark:text-slate-100/300`）；
   - scoped 样式写 `.dark .本组件类 { }`（编译为 `.dark .x[data-v]`）；需要命中子组件内部时写 `.dark .本组件类 :deep(.el-xxx)`；
   - **禁止** `:global(.dark) .x`（会被编译成裸 `.dark` 规则作用到 html 并泄漏全站）和 `.dark :deep(.x)`（作用域属性落在 html 上永不生效）；传送到 body 的浮层用 `:global(.dark .浮层专属类 ...)`；
   - scoped 中 `background: linear-gradient(浅色)` 是背景图，`dark:bg-*` 只改背景色盖不住，必须在暗色选择器里整体重写 `background`；
   - 亮色规则若带 `is-checked`、`:hover` 等更高优先级选择器，暗色规则也要写到同等优先级。
   - 暗色底色与边框禁止使用 slate 系（`dark:bg-slate-700~950`、`dark:border-slate-600/700`，以及 scoped 里的 `rgba(15, 23, 42 / 30, 41, 59 / 148, 163, 184, …)`）：slate 带蓝色调，叠在 `#141415` 卡片之间会显成蓝色卡片边框。卡片底用 `dark:bg-[#141415]`（半透明保留 `/95`），浅灰块用 `dark:bg-white/5~10`，加深块用 `dark:bg-black/N`，边框用 `dark:border-white/10`；亮色只写 `bg-slate-900` 一类深色选中态时也要补暗色变体（选中态用 `dark:bg-brand`）。
7. 打印出来文字发灰：打印模板、凭证纸面、二维码区域必须保持白底黑字，`style.css` 已在 `@media print` 下把 html.dark 强制恢复亮色；不要给纸面或二维码容器加 `dark:` 背景。

## 验证与回归关注点

- 改 Store 时至少回归：刷新恢复、账号切换、退出登录、并发请求、弱网下请求中止。
- 改共享组件时回归：桌面和移动端布局、弹窗滚动、抽屉滚动、列表分页、空态和错误态。
- 改权限动作时回归：按钮显隐、点击拦截、越权提示文本和后端实际权限结果。
- 改样式或新增页面时回归：亮色与暗色各截一次；构建后 `dist/assets/*.css` 中不得出现裸 `}.dark{` 规则；首次访问（清空存储）在系统亮/暗下分别跟随系统，手动切换后刷新仍保持选择且无闪白。
