/** 核验修订时间线的历史快照展示口径。 */
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import { revisionActor, revisionSummary, revisionTime } from '../src/views/order-list/order-revision.helpers'

const item = { productId: '1', productNameSnapshot: '商品', skuId: '1', skuCodeSnapshot: 'SKU', specTextSnapshot: '规格', qty: '1.00', unitPrice: '2.00', lineAmount: '2.00', remark: null }
const before = { businessNo: 'A', totalQty: '1.00', totalAmount: '2.00', items: [item], systemNo: 'SECRET_SYSTEM', showNo: 'SECRET_SHOW' }
const after = { ...before, businessNo: 'B', totalQty: 2, totalAmount: '4.00', items: [{ ...item, qty: 2, lineAmount: 4 }] }
const original = JSON.stringify({ before, after })
const lines = revisionSummary(before, after)
assert.ok(lines.includes('业务单号：A → B'))
assert.ok(lines.includes('总数量：1 → 2'))
assert.ok(lines.includes('合计金额：¥2.00 → ¥4.00'))
assert.ok(lines.includes('商品明细有调整'))
assert.equal(JSON.stringify({ before, after }), original)
assert.ok(!lines.join(' ').includes('SECRET_'))
assert.ok(revisionSummary(before, { ...before, items: [{ ...item, remark: '调整' }] }).includes('商品明细有调整'))
assert.ok(!revisionSummary(before, { ...before, totalQty: 1, totalAmount: 2, items: [{ ...item, qty: 1, unitPrice: 2, lineAmount: 2 }] }).includes('商品明细有调整'))
assert.match(revisionSummary(null, after).join(' '), /快照不完整/)
assert.match(revisionSummary({ ...before, totalQty: null }, after).join(' '), /快照不完整/)
assert.match(revisionSummary({ ...before, totalAmount: '错误' }, after).join(' '), /快照不完整/)
assert.match(revisionSummary({ ...before, items: null }, after).join(' '), /快照不完整/)
assert.ok(revisionSummary({ ...before, totalQty: 0 }, { ...before, totalQty: 1 }).includes('总数量：0 → 1'))
assert.equal(revisionActor('', ''), '未记录')
assert.equal(revisionActor(' '.repeat(3), '用户'), '用户')
assert.equal(revisionActor('长'.repeat(500), ''), '长'.repeat(500))
assert.equal(revisionTime('invalid'), '未记录时间')
assert.equal(revisionTime(''), '未记录时间')
for (const invalid of ['2026-02-30 12:00:00', '2026-13-01T12:00:00Z', '2025-02-29T12:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T12:60:00Z', '2026-01-01T12:00:60Z', '2026-01-01T12:00:00+24:00']) {
  assert.equal(revisionTime(invalid), '未记录时间', invalid)
}
for (const valid of ['2024-02-29 12:34:56', '2024-02-29T23:59:59Z', '2024-02-29T23:59:59+14:00', '2024-03-01T00:00:00-12:00']) {
  assert.equal(revisionTime(valid), dayjs(valid).format('YYYY-MM-DD HH:mm:ss'), valid)
}
console.log('订单修订展示口径验证通过')
