/**
 * Issue #71 前端契约校验：防止订单合并接口、权限边界和客户端隐私展示在重构中被遗漏。
 * 这是静态契约检查，不替代真实 API 联调或浏览器端到端测试。
 */
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = process.cwd()
const requiredFiles = [
  'src/api/modules/order.ts',
  'src/api/modules/auth.ts',
  'src/views/order-list/OrderListView.vue',
  'src/views/order-list/components/OrderMergeDialog.vue',
  'src/views/order-list/components/OrderListMobileCard.vue',
  'src/views/order-list/order-list-mobile-card-loader.ts',
  'src/views/order-list/order-merge-state.ts',
  'src/views/order-list/components/OrderDetailDrawerContent.vue',
  'src/views/client/ClientOrdersView.vue',
  'src/views/client/ClientOrderDetailView.vue',
  'src/utils/client-order-storage.ts',
  'src/utils/client-order-summary.ts',
  'scripts/verify-order-list-mobile-card-loader.ts',
]

const failures = []
const source = new Map()
for (const file of requiredFiles) {
  const absolutePath = resolve(root, file)
  if (!existsSync(absolutePath)) {
    failures.push(`缺少必需文件：${file}`)
    continue
  }
  source.set(file, readFileSync(absolutePath, 'utf8'))
}

const expectText = (file, text, description) => {
  if (!source.get(file)?.includes(text)) failures.push(`${file} 未包含：${description}`)
}

expectText('src/api/modules/order.ts', "url: '/orders/merges/preview'", '合并预检接口')
expectText('src/api/modules/order.ts', "url: '/orders/merges'", '合并提交接口')
expectText('src/api/modules/auth.ts', "'orders:merge'", 'orders:merge 权限声明')
expectText('src/views/order-list/OrderListView.vue', 'OrderMergeDialog', '异步合并工作台')
expectText('src/views/order-list/OrderListView.vue', 'tree-props', '桌面树状列表')
expectText('src/views/order-list/OrderListView.vue', '已合并至父单', '子单合并状态提示')
expectText('src/views/order-list/OrderListView.vue', '...child,', '来源子单完整摘要覆盖父单树行字段')
expectText('src/views/order-list/OrderListView.vue', "import('./components/OrderListMobileCard.vue')", '移动端卡片异步分包')
expectText('src/views/order-list/OrderListView.vue', 'defineAsyncComponent({', '移动端卡片异步加载配置')
expectText('src/views/order-list/OrderListView.vue', 'delay: 0', '移动端卡片立即显示加载占位')
expectText('src/views/order-list/OrderListView.vue', 'loadingComponent: OrderListMobileCardLoading', '移动端卡片加载占位')
expectText('src/views/order-list/OrderListView.vue', 'errorComponent: OrderListMobileCardLoadError', '移动端卡片错误占位')
expectText('src/views/order-list/OrderListView.vue', 'loader: loadOrderListMobileCard', '移动端卡片受控异步加载器')
expectText('src/views/order-list/OrderListView.vue', 'mobileCardLoadAnnouncement', '页面级移动卡片加载播报')
expectText('src/views/order-list/OrderListView.vue', "aria-live=\"polite\"", '唯一页面级加载播报区域')
expectText('src/views/order-list/OrderListView.vue', 'createTimedAsyncLoader', '移动端卡片自清理超时加载器')
expectText('src/views/order-list/OrderListView.vue', 'timeoutMs: 15_000', '移动端卡片十五秒超时')
expectText('src/views/order-list/order-list-mobile-card-loader.ts', 'Promise.race', '移动端卡片超时竞速')
expectText('src/views/order-list/order-list-mobile-card-loader.ts', 'clearTimeout', '移动端卡片超时定时器清理')
const orderListViewSource = source.get('src/views/order-list/OrderListView.vue') || ''
const loadingFallbackSource = orderListViewSource.slice(
  orderListViewSource.indexOf('const OrderListMobileCardLoading'),
  orderListViewSource.indexOf('const OrderListMobileCardLoadError'),
)
const errorFallbackSource = orderListViewSource.slice(
  orderListViewSource.indexOf('const OrderListMobileCardLoadError'),
  orderListViewSource.indexOf('const OrderListMobileCard ='),
)
for (const [name, fallbackSource] of [['加载', loadingFallbackSource], ['错误', errorFallbackSource]]) {
  if (!fallbackSource.includes("'aria-hidden': 'true'")) {
    failures.push(`移动端卡片${name}占位必须从辅助技术树中排除`)
  }
  if (fallbackSource.includes('role:') || fallbackSource.includes("'aria-live'")) {
    failures.push(`移动端卡片${name}占位不得逐行声明 role 或 aria-live`)
  }
}
if ((orderListViewSource.match(/aria-live=/g) || []).length !== 1) {
  failures.push('OrderListView 必须只保留一个页面级 aria-live 播报区域')
}
expectText('src/views/order-list/components/OrderMergeDialog.vue', 'previewOrderMerge', '服务端预检')
expectText('src/views/order-list/components/OrderMergeDialog.vue', 'commitOrderMerge', '服务端提交')
expectText('src/views/order-list/components/OrderMergeDialog.vue', 'idempotencyKey', '幂等键')
expectText('src/views/order-list/components/OrderMergeDialog.vue', 'resolveOrderMergeConflictState(error', '统一异常冲突状态转换')
expectText('src/views/order-list/components/OrderMergeDialog.vue', '([visible], previousState) =>', '合并弹窗区分新打开会话与同次会话状态更新')
expectText('src/views/order-list/components/OrderMergeDialog.vue', 'const previousVisible = previousState?.[0]', '首次立即回调安全读取上一次可见状态')
expectText('src/views/order-list/components/OrderMergeDialog.vue', "if (!previousVisible) reason.value = ''", '新一次打开合并弹窗时清空上次的合并原因')
expectText('src/views/order-list/components/OrderMergeDialog.vue', 'invalidateOrderMergePreviewRequestState', '预检失效时释放旧请求 loading 所有权')
expectText('src/views/order-list/components/OrderMergeDialog.vue', 'settleOrderMergePreviewRequest', '预检完成时只释放自身 loading 所有权')
if (source.get('src/views/order-list/components/OrderMergeDialog.vue')?.includes('response?.status')) {
  failures.push('OrderMergeDialog 不得绕过统一错误层读取 error.response.status')
}
expectText('src/views/order-list/OrderListView.vue', 'const canEditStandaloneComplianceFlags', '合规状态编辑仅允许未合并普通主单')
expectText('src/views/order-list/OrderListView.vue', "currentOrder.value.merge.role === 'standalone'", '合并父单与来源单必须隐藏通用合规编辑')
expectText('src/views/order-list/OrderListView.vue', '(canAmendOrders || canMergeOrders) && !item.isDeleted && !isSourceOrder(item)', '仅合并权限的移动端选择入口与来源单排除')
expectText('src/views/order-list/components/OrderListMobileCard.vue', '选择单据', '移动端通用选择文案')
expectText('src/views/order-list/components/OrderListMobileCard.vue', '<style scoped>', '移动端卡片自有作用域样式')
expectText('src/views/order-list/components/OrderListMobileCard.vue', '.mobile-order-card__merge-child', '来源子卡自有样式')
expectText('src/views/order-list/components/OrderListMobileCard.vue', '.dark .mobile-order-card__business-no', '深色模式卡片业务单号样式')
expectText('src/views/order-list/components/OrderListMobileCard.vue', '@media (prefers-reduced-motion: reduce)', '卡片高亮动画降级')
for (const obsoleteParentStyle of ['.mobile-order-card__head', '.mobile-order-card__merge-child', '.dark .mobile-order-card__business-no']) {
  if (source.get('src/views/order-list/OrderListView.vue')?.includes(obsoleteParentStyle)) {
    failures.push(`OrderListView 不得保留已拆分移动卡片样式：${obsoleteParentStyle}`)
  }
}
expectText('src/views/order-list/components/OrderDetailDrawerContent.vue', "emit('navigate'", '父子详情跳转事件')
for (const file of ['src/views/client/ClientOrdersView.vue', 'src/views/client/ClientOrderDetailView.vue']) {
  expectText(file, 'originalCustomerOrderBusinessNo', '原始出库业务单号展示')
  expectText(file, '已合并', '合并提示')
}
expectText('src/utils/client-order-storage.ts', 'originalCustomerOrderBusinessNo', '离线缓存原始出库业务单号')
expectText('src/utils/client-order-summary.ts', 'originalCustomerOrderBusinessNo', '详情回写原始出库业务单号')

if (existsSync(resolve(root, 'src/views/order-list/order-merge-conflict.mjs')) || existsSync(resolve(root, 'src/views/order-list/order-merge-conflict.d.mts'))) {
  failures.push('不得保留未声明的 order-merge-conflict.mjs 旁路')
}

if (source.has('src/views/order-list/order-merge-state.ts')) {
  const probe = spawnSync(
    process.execPath,
    [
      resolve(root, 'backend/node_modules/tsx/dist/cli.mjs'),
      '--tsconfig',
      resolve(root, 'tsconfig.app.json'),
      resolve(root, 'scripts/verify-order-merge-state.ts'),
    ],
    { cwd: root, encoding: 'utf8' },
  )
  if (probe.status !== 0) failures.push(`真实 AppRequestError 冲突状态机失败：${probe.stderr || probe.stdout}`)
}

if (source.has('src/views/order-list/order-list-mobile-card-loader.ts')) {
  const probe = spawnSync(
    process.execPath,
    [
      resolve(root, 'backend/node_modules/tsx/dist/cli.mjs'),
      '--tsconfig',
      resolve(root, 'tsconfig.app.json'),
      resolve(root, 'scripts/verify-order-list-mobile-card-loader.ts'),
    ],
    { cwd: root, encoding: 'utf8' },
  )
  if (probe.status !== 0) failures.push(`移动端卡片超时状态机失败：${probe.stderr || probe.stdout}`)
}

if (failures.length) {
  console.error('Issue #71 前端订单合并契约校验失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Issue #71 前端订单合并契约校验通过。')
}
