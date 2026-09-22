/**
 * Issue #110 前端编号语义契约校验。
 *
 * 这是静态回归检查：订单页面主展示必须使用业务单号，O2O 页面必须使用预订单号；
 * showNo 仅允许存在于兼容 normalizer、废弃别名和本地缓存升级边界。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const files = [
  'src/api/modules/order.ts',
  'src/api/modules/o2o.ts',
  'packages/shared-types/src/orders.ts',
  'src/api/modules/system-config.ts',
  'src/views/order-entry/composables/useOrderEntryForm.ts',
  'src/views/dashboard/DashboardView.vue',
  'src/api/modules/dashboard.ts',
  'src/views/dashboard/components/TopProductDrilldownDrawer.vue',
  'src/views/dashboard/components/TopCustomerDrilldownDrawer.vue',
  'src/views/order-list/composables/useOrderListView.ts',
  'src/views/order-list/components/OrderAmendmentDialog.vue',
  'src/views/order-list/OrderListView.vue',
  'src/views/o2o/O2oVerifyConsoleView.vue',
  'src/views/o2o/O2oOrderQueryView.vue',
  'src/views/client/ClientOrdersView.vue',
  'src/views/client/ClientOrderDetailView.vue',
  'src/utils/client-order-storage.ts',
  'src/utils/client-order-summary.ts',
  'src/views/system/components/SystemConfigSerialSection.vue',
  'src/views/reports/ReportCenterView.vue',
  'src/views/system/CustomerServiceWorkbenchView.vue',
]

const failures = []
const source = new Map()
for (const file of files) {
  const path = resolve(root, file)
  if (!existsSync(path)) {
    failures.push(`缺少必需文件：${file}`)
    continue
  }
  source.set(file, readFileSync(path, 'utf8'))
}

const expects = (file, text, description) => {
  if (!source.get(file)?.includes(text)) failures.push(`${file} 缺少：${description}`)
}

const rejects = (file, text, description) => {
  if (source.get(file)?.includes(text)) failures.push(`${file} 不得继续包含：${description}`)
}

expects('src/api/modules/order.ts', 'systemNo:', '正式单 canonical systemNo')
expects('src/api/modules/order.ts', 'confirmBusinessNo:', '正式单删除确认业务单号字段')
expects('src/api/modules/order.ts', 'getOrderDetailBySystemNo', '正式单系统编号查询入口')
expects('src/api/modules/o2o.ts', 'preorderNo:', 'O2O canonical preorderNo')
expects('src/api/modules/o2o.ts', 'confirmPreorderNo:', 'O2O 删除确认预订单号字段')
expects('src/api/modules/o2o.ts', 'getO2oVerifyDetailByPreorderNo', '预订单号查询入口')
expects('src/api/modules/o2o.ts', 'O2oConsolePreorderSummary', '管理员 O2O 系统号扩展类型')
expects('src/api/modules/o2o.ts', "preorderNo: String(raw.preorderNo ?? '').trim()", '客户端 O2O normalizer 不从 showNo 回退')
expects('src/api/modules/system-config.ts', "'/system-configs/order-identifiers'", '三类订单编号配置接口')
expects('src/views/order-entry/composables/useOrderEntryForm.ts', 'focusOrderSystemNo', '正式单系统编号路由定位')
expects('src/views/dashboard/DashboardView.vue', 'focusOrderId: activity.orderId', '工作台仅按订单主键定位')
expects('src/api/modules/dashboard.ts', 'businessNo:', '工作台近期动态业务单号契约')
expects('src/api/modules/dashboard.ts', "businessNo: String(activity.businessNo ?? '').trim()", '工作台近期动态只规范业务单号')
expects('src/api/modules/dashboard.ts', 'systemNo?: string | null', '工作台下钻系统号仅为管理员可选追溯字段')
expects('src/views/dashboard/components/TopProductDrilldownDrawer.vue', 'prop="businessNo"', '商品下钻主展示业务单号')
expects('src/views/dashboard/components/TopCustomerDrilldownDrawer.vue', 'prop="businessNo"', '客户下钻主展示业务单号')
expects('src/views/order-list/composables/useOrderListView.ts', 'confirmBusinessNo', '正式单永久删除业务单号确认')
expects('src/views/order-list/components/OrderAmendmentDialog.vue', '出库系统编号（不可修改，仅用于系统追溯）', '管理员技术追溯只读文案')
expects('src/views/order-list/OrderListView.vue', "row.matchedIdentifierType !== 'systemNo' || isAdmin", '正式单系统号命中仅管理员展示')
expects('src/views/o2o/O2oVerifyConsoleView.vue', '预订单号', '核销台预订单号文案')
expects('src/views/o2o/O2oOrderQueryView.vue', 'confirmPreorderNo', 'O2O 永久删除预订单号确认')
expects('src/views/o2o/O2oOrderQueryView.vue', "order.matchedIdentifierType !== 'systemNo' || isAdmin", 'O2O 系统号命中仅管理员展示')
expects('src/views/client/ClientOrdersView.vue', 'preorderNo', '客户端订单列表预订单号')
expects('src/views/client/ClientOrderDetailView.vue', 'preorderNo', '客户端订单详情预订单号')
expects('src/utils/client-order-storage.ts', 'preorderNo', '客户端缓存 canonical preorderNo')
expects('src/views/system/components/SystemConfigSerialSection.vue', '正式出库系统编号', '系统配置正式单分区')
expects('src/views/system/components/SystemConfigSerialSection.vue', '出库业务单号', '系统配置业务单号分区')
expects('src/views/system/components/SystemConfigSerialSection.vue', 'O2O 预订单号', '系统配置预订单分区')
expects('src/views/system/CustomerServiceWorkbenchView.vue', '关联编号', '客服编号中性文案')
rejects('src/api/modules/order.ts', 'normalizeTextField(record.businessNo, normalizeTextField(record.showNo))', '业务单号回退系统号')
rejects('src/views/order-entry/composables/useOrderEntryForm.ts', 'focusOrderShowNo:', '正式单旧路由写入')
rejects('src/views/dashboard/DashboardView.vue', 'focusOrderShowNo:', '工作台正式单旧路由写入')
rejects('src/views/dashboard/DashboardView.vue', 'focusOrderSystemNo:', '工作台不得把技术号写入路由')
rejects('src/views/dashboard/DashboardView.vue', 'activity.systemNo', '工作台普通导航不得依赖系统号')
rejects('src/api/modules/dashboard.ts', 'systemNo: String(activity.systemNo ?? activity.showNo ?? \'\').trim()', '近期动态不得由 showNo 推导系统号')
rejects('src/api/modules/dashboard.ts', 'showNo?: string\n  businessNo: string', '近期动态 DTO 不得暴露旧 showNo')
for (const file of [
  'src/views/dashboard/components/TopProductDrilldownDrawer.vue',
  'src/views/dashboard/components/TopCustomerDrilldownDrawer.vue',
]) {
  rejects(file, 'prop="systemNo"', '工作台普通下钻不得主展示系统号')
  rejects(file, 'prop="showNo"', '工作台普通下钻不得主展示旧 showNo')
}
rejects('src/views/o2o/O2oVerifyConsoleView.vue', 'preorderDetail.value.order.showNo', '核销台直接展示旧 showNo')
for (const file of [
  'src/views/client/ClientOrdersView.vue',
  'src/views/client/ClientOrderDetailView.vue',
  'src/utils/client-order-storage.ts',
  'src/utils/client-order-summary.ts',
]) {
  rejects(file, 'customerOrderSystemNo', '客户端不得持有正式出库系统号')
  rejects(file, 'originalCustomerOrderSystemNo', '客户端不得持有原始正式出库系统号')
  rejects(file, 'customerOrderShowNo', '客户端不得保留旧正式系统号别名')
  rejects(file, 'originalCustomerOrderShowNo', '客户端不得保留旧原始系统号别名')
}
expects('src/utils/client-order-storage.ts', 'isLegacyPreorderShowNo', '缓存 showNo 迁移格式门禁')
rejects('src/utils/client-order-storage.ts', 'customerOrderSystemNo:', '缓存不得持久化正式系统号')
rejects('src/utils/client-order-summary.ts', 'customerOrderSystemNo ||', '客户端本地搜索不得匹配正式系统号')
for (const text of ['customerOrderSystemNo', 'originalCustomerOrderSystemNo', 'customerOrderShowNo', 'originalCustomerOrderShowNo']) {
  rejects('packages/shared-types/src/orders.ts', text, '客户端共享 O2O DTO 不得声明正式系统号或旧别名')
}
const clientO2oNormalizerSource = (source.get('src/api/modules/o2o.ts') || '').slice(
  (source.get('src/api/modules/o2o.ts') || '').indexOf('const normalizeClientO2oOrderIdentifiers'),
  (source.get('src/api/modules/o2o.ts') || '').indexOf('const normalizeConsoleO2oOrderIdentifiers'),
)
if (clientO2oNormalizerSource.includes('raw.showNo')) {
  failures.push('src/api/modules/o2o.ts 客户端 O2O normalizer 不得从 showNo 回退')
}

if (failures.length) {
  console.error('Issue #110 订单编号语义契约校验失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Issue #110 订单编号语义契约校验通过。')
}
