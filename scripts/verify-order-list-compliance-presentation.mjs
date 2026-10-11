/**
 * 模块说明：出库详情合规状态受控展示契约。
 * 文件职责：约束异步详情组件只负责展示和发出编辑事件，权限、草稿与保存继续由列表页持有。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'

const readSfc = (path) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  return { source, descriptor: parse(source).descriptor }
}
const parent = readSfc('../src/views/order-list/OrderListView.vue')
const detail = readSfc('../src/views/order-list/components/OrderDetailDrawerContent.vue')
const parentTemplate = parent.descriptor.template?.content ?? ''
const detailTemplate = detail.descriptor.template?.content ?? ''
const detailScript = detail.descriptor.scriptSetup?.content ?? ''

assert.doesNotMatch(parentTemplate, /合规状态确认/, '高频列表壳层不得再编译详情合规模板')
assert.match(detailTemplate, /合规状态确认/, '异步详情应保留合规确认标题')
for (const phrase of ['仅部门单可编辑“是否有出库单”和“系统申请”。', '保存状态', '是否有出库单', '系统申请', '不适用', '已申请', '未申请']) {
  assert.ok(detailTemplate.includes(phrase), `合规状态必须保留原展示：${phrase}`)
}
for (const prop of [':can-edit-standalone-compliance-flags="canEditStandaloneComplianceFlags"', ':compliance-form="complianceForm"', ':compliance-saving="complianceSaving"']) {
  assert.ok(parentTemplate.includes(prop), `父层必须传入原权限/草稿/保存状态：${prop}`)
}
for (const event of [
  '@update:has-customer-order="complianceForm.hasCustomerOrder = $event"',
  '@update:is-system-applied="complianceForm.isSystemApplied = $event"',
  '@save-compliance="handleSaveComplianceFlags"',
]) {
  assert.ok(parentTemplate.includes(event), `子组件受控事件必须回写原父层链路：${event}`)
}
assert.match(detailTemplate, /v-if="canEditStandaloneComplianceFlags"[\s\S]*?@click="emit\('save-compliance'\)"/, '保存入口必须受父层权限 gate 控制')
assert.match(detailTemplate, /:model-value="complianceForm\.hasCustomerOrder"[\s\S]*?@update:model-value="emit\('update:hasCustomerOrder', \$event\)"/, '出库单状态编辑必须走受控事件')
assert.match(detailTemplate, /:model-value="complianceForm\.isSystemApplied"[\s\S]*?@update:model-value="emit\('update:isSystemApplied', \$event\)"/, '系统申请编辑必须走受控事件')
assert.match(detailTemplate, /order\.orderType === 'department' \? \(order\.hasCustomerOrder \? '是' : '否'\) : '不适用'/, '散客/只读须使用原出库单状态展示口径')
assert.match(detailTemplate, /order\.orderType === 'department' \? \(order\.isSystemApplied \? '已申请' : '未申请'\) : '不适用'/, '散客/只读须使用原系统申请展示口径')
assert.match(parent.source, /currentOrder\.value\.merge\.role === 'standalone'/, '合并单仍须由父层排除编辑权限')
assert.match(parent.source, /syncComplianceFormFromCurrentOrder/, '切单/关闭时草稿同步必须保留')
assert.match(parent.source, /const handleSaveComplianceFlags = async/, '保存 API 仍由父层持有')
assert.match(parent.source, /const OrderDetailDrawerLoadError = \(\) => h\('p'/, '详情模块失败须有独立可见占位')
assert.match(parent.source, /errorComponent: OrderDetailDrawerLoadError/, '详情异步失败须渲染恢复说明')
assert.match(parent.source, /timeoutMessage: '单据详情加载超时'/, '详情加载须有有界截止')
assert.match(parent.source, /详情加载失败，请刷新后重试/, '失败反馈须说明真实恢复方式')
assert.doesNotMatch(detailScript, /updateOrderComplianceFlags|ensurePermission|showCriticalErrorDialog\(.*合规/, '详情子组件不得写权限判断或持久化')

console.log('[verify:order-list-compliance-presentation] 受控合规展示契约通过')
