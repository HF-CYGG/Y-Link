/** 隔离回归：成功退货申请按 pending 口径回写，不请求后端、不接触真实订单。 */
import assert from 'node:assert/strict'
import { applyConfirmedReturnRequest } from '../src/utils/client-order-return'
import type { O2oPreorderDetailItem, O2oReturnRequestDetail } from '../src/api/modules/o2o'

const item = (productId: string, skuId: string | null, qty: number) => ({
  id: productId + ':' + skuId, productId, skuId, qty, returnedQty: 0, availableReturnQty: qty,
} as O2oPreorderDetailItem)
const request = (id: string, status: O2oReturnRequestDetail['status'], productId: string, skuId: string | null, qty: number) => ({
  id, status, items: [{ productId, skuId, qty }],
} as O2oReturnRequestDetail)
const original = { items: [item('p1', 's1', 2), item('p1', 's2', 3), item('p2', null, 4)], returnRequests: [] as O2oReturnRequestDetail[], marker: '保留订单上下文' }
const confirmed = request('r1', 'pending', 'p1', 's1', 1)
const first = applyConfirmedReturnRequest(original, confirmed)
assert.deepEqual(first.items.map(x => [x.returnedQty, x.availableReturnQty]), [[1, 1], [0, 3], [0, 4]])
assert.equal(first.marker, original.marker)
assert.equal(original.items[0].returnedQty, 0, '不修改原详情快照')
assert.equal(original.returnRequests.length, 0)
const repeated = applyConfirmedReturnRequest(first, confirmed)
assert.equal(repeated.returnRequests.length, 1, '响应与后台回读相同申请去重')
assert.equal(repeated.items[0].returnedQty, 1)
const second = applyConfirmedReturnRequest(repeated, request('r2', 'pending', 'p1', 's1', 1))
assert.deepEqual([second.items[0].returnedQty, second.items[0].availableReturnQty], [2, 0])
const otherSku = applyConfirmedReturnRequest(second, request('r3', 'pending', 'p1', 's2', 1))
assert.deepEqual(otherSku.items.map(x => x.returnedQty), [2, 1, 0], '同商品不同SKU分别累计')
const noSku = applyConfirmedReturnRequest(otherSku, request('r4', 'pending', 'p2', null, 7))
assert.deepEqual([noSku.items[2].returnedQty, noSku.items[2].availableReturnQty], [4, 0], '无SKU及上限')
const verified = applyConfirmedReturnRequest(noSku, request('r1', 'verified', 'p1', 's1', 1))
assert.equal(verified.items[0].returnedQty, 1, '非pending申请不占可退数量')
const rejected = applyConfirmedReturnRequest(verified, request('r2', 'rejected', 'p1', 's1', 1))
assert.deepEqual([rejected.items[0].returnedQty, rejected.items[0].availableReturnQty], [0, 2])
console.log('通过：退货成功即时1/1、重复响应去重、多申请/多SKU/空SKU、数量上限、仅pending、原快照不变')
