/** 对真实预检 helper 执行能力/数量边界；UI 会话场景由条码 SFC 套件覆盖。 */
import assert from 'node:assert/strict'
import { initialPrintLocations, preservePrintLocations, validateLabelPreflight, withPrintLocation } from '../src/views/inventory/components/barcode-label-preflight.ts'
import type { ProductLabelRecord } from '../src/api/modules/inventory.ts'
const base: ProductLabelRecord = { skuId: '1', productId: '2', skuCode: 'WC02001', barcode: 'WC02001', factoryBarcode: null, productName: '标签验证', specText: '默认规格', price: '1.00', categoryName: null, locationCode: 'A', variantCode: null, sizeCode: null, seriesName: null, codeScheme: 'legacy', printLocations: { capability: 'full', mainLocationId: '10', mainLocationCode: 'A', mainLocationStatus: 'valid', options: [{ locationId: '10', locationCode: 'A', isMain: true, qty: 0 }, { locationId: '11', locationCode: 'B', isMain: false, qty: 5 }], distributionKey: 'v1' } }
const before = [base]
assert.deepEqual(initialPrintLocations(before), { '1': '10' })
assert.equal(withPrintLocation(base, '11').locationCode, 'B')
assert.equal(base.locationCode, 'A', '选择不得修改真实主库位字段')
assert.equal(validateLabelPreflight(before, structuredClone(before), { '1': '11' }, new Set(['1']), true), '')
const changed = structuredClone(before)
if (changed[0]!.printLocations.capability === 'full') changed[0]!.printLocations.distributionKey = 'filtered-disabled-change'
assert.match(validateLabelPreflight(before, changed, { '1': '11' }, new Set(['1']), true), /分布已变化/)
assert.match(validateLabelPreflight(before, before, { '1': '99' }, new Set(['1']), true), /失效/)
assert.deepEqual(preservePrintLocations(before, { '1': '99' }), { '1': null })
const limited: ProductLabelRecord = { ...base, printLocations: { capability: 'main_only', mainLocationId: '10', mainLocationCode: 'A', mainLocationStatus: 'valid', options: [{ locationId: '10', locationCode: 'A', isMain: true }] } }
assert.match(validateLabelPreflight(before, [limited], { '1': '10' }, new Set(['1']), true), /权限已变化/)
assert.equal(validateLabelPreflight([limited], structuredClone([limited]), { '1': '10' }, new Set(['1']), true), '')
console.log('通过：真实预检 helper 场景')

// 下单提交意图必须仅在有效非空编号时新增键，兼容旧请求键形状。
const { buildClientPreorderSubmitIntentKey } = await import('../src/utils/client-preorder-submit-guard.ts')
const intent = { clientUserId: 'client-1', clientOrderType: 'department' as const, isSystemApplied: true, pickupContact: '验证教师', pickupAt: '2026-10-30T10:00:00.000Z', items: [{ productId: '1', skuId: '2', qty: 1 }] }
const legacyIntent = buildClientPreorderSubmitIntentKey(intent)
assert.equal(buildClientPreorderSubmitIntentKey({ ...intent, kingdeeVoucherNo: null }), legacyIntent)
assert.equal(buildClientPreorderSubmitIntentKey({ ...intent, kingdeeVoucherNo: '   ' }), legacyIntent)
assert.equal(buildClientPreorderSubmitIntentKey({ ...intent, kingdeeVoucherNo: '  001-AbC  ' }), buildClientPreorderSubmitIntentKey({ ...intent, kingdeeVoucherNo: '001-AbC' }))
assert.notEqual(buildClientPreorderSubmitIntentKey({ ...intent, kingdeeVoucherNo: '001-AbC' }), legacyIntent)
assert.notEqual(buildClientPreorderSubmitIntentKey({ ...intent, kingdeeVoucherNo: '001-AbC' }), buildClientPreorderSubmitIntentKey({ ...intent, kingdeeVoucherNo: '001-abc' }))
