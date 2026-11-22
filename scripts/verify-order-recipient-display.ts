/** 管理端领取人展示规则回归，不连接数据库。 */
import assert from 'node:assert/strict'
import { formatOrderRecipient } from '../src/views/order-list/order-recipient-display'
import type { OrderRecord } from '../src/api/modules/order'
const order = {
  id: 'parent', orderType: 'department', inventoryMode: 'o2o_preapplied', sourceDocType: 'o2o_preorder',
  customerName: '账号名不能冒充领取人', customerDepartmentName: '保留独立部门',
  merge: { role: 'parent', parent: null, children: [
    { id: 'child-a', orderType: 'department', inventoryMode: 'o2o_preapplied', sourceDocType: 'o2o_preorder' },
    { id: 'child-b', orderType: 'department', inventoryMode: 'o2o_preapplied', sourceDocType: 'o2o_preorder' },
  ] },
  sourcePreorderPickupContacts: [
    { sourceOrderId: 'child-b', pickupContact: null },
    { sourceOrderId: 'child-a', pickupContact: '李老师' },
    { sourceOrderId: 'parent', pickupContact: '张老师' },
  ],
} as unknown as OrderRecord
assert.equal(formatOrderRecipient(order), '张老师、李老师、未记录', '领取顺序按来源单，不按接口数组或姓名排序')
assert.equal(formatOrderRecipient(order, order.merge.children[0]), '李老师', '子行只显示本人')
assert.equal(formatOrderRecipient(order, order.merge.children[1]), '未记录', '缺失子行不能继承父单')
assert.equal(formatOrderRecipient({ ...order, sourcePreorderPickupContacts: [] }), '未记录、未记录、未记录')
assert.equal(formatOrderRecipient({ ...order, sourcePreorderPickupContacts: order.sourcePreorderPickupContacts?.map((entry) => ({ ...entry, pickupContact: '同名教师' })) }), '同名教师、同名教师、同名教师', '同名仍是三个来源')
assert.equal(formatOrderRecipient({ ...order, sourcePreorderPickups: [{ sourceOrderId: 'parent', pickupContact: '详情领取人' }] } as Parameters<typeof formatOrderRecipient>[0]), '详情领取人、未记录、未记录', '详情取真实来源记录，不读列表旧投影')
assert.equal(formatOrderRecipient({ ...order, inventoryMode: 'manual_applied', sourceDocType: null }), '保留独立部门', '手工单保持原部门显示')
assert.equal(formatOrderRecipient({ ...order, inventoryMode: 'manual_applied', sourceDocType: null, orderType: 'walkin' }), '账号名不能冒充领取人', '手工散客保持原客户显示')
console.log('[verify:order-recipient-display] 领取人来源规则通过')
