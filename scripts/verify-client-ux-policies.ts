/**
 * 模块说明：scripts/verify-client-ux-policies.ts
 * 文件职责：用内存存储与可控异步验证客户端 UX 恢复、草稿与目录选择策略。
 * 实现逻辑：不访问网络、真实账号、数据库或上传数据；无需浏览器。
 * 维护说明：由统一验收阶段运行，本次实现阶段仅编写，不自动接入共享脚本。
 */
import assert from 'node:assert/strict'
import type { O2oMallProduct } from '../src/api/modules/o2o'
import {
  buildClientPreorderSubmitIntentKey, createClientPreorderSubmitLock, readActiveClientPreorderSubmitLock,
  refreshClientPreorderSubmitLock, clearClientPreorderSubmitLock, redactClientPreorderSubmitLocks,
} from '../src/utils/client-preorder-submit-guard'
import { decideClientCheckoutSubmit, isClientCheckoutSubmitOutcomeUnknown } from '../src/views/client/client-checkout-submit-policy'
import { buildActiveSkuSearchText, resolveCatalogDetailSelection } from '../src/views/client/client-mall-catalog-policy'
import { snapshotOrderEditDraft, snapshotOrderReturnDraft } from '../src/views/client/client-order-draft-policy'
import { buildFeedbackCreatePayload, createEmptyFeedbackDraft } from '../src/views/client/client-feedback-create-policy'
import { resolveReplyDraftAfterSend, sendFeedbackReplyAndRefresh } from '../src/views/client/client-feedback-reply-policy'

for (const status of [undefined, 408, 500, 501, 502, 503, 504, 507, 599]) assert.equal(isClientCheckoutSubmitOutcomeUnknown(status), true, `${status}结果未知必须保留原提交`)
for (const status of [400, 401, 403, 404, 409, 422, 429]) assert.equal(isClientCheckoutSubmitOutcomeUnknown(status), false, `${status}为确定拒绝`)

const prefix = 'ylink:client:preorder:submit-lock:'
const storage = {} as Storage
let denyRead = false
let denyWrite = false
let ignoreWrite = false
Object.defineProperties(storage, {
  getItem: { value: (key: string) => { if (denyRead) throw new Error('读取被拒绝'); return Object.hasOwn(storage, key) ? storage[key] : null } },
  setItem: { value: (key: string, value: string) => { if (denyWrite) throw new Error('写入被拒绝'); if (!ignoreWrite) storage[key] = String(value) } },
  removeItem: { value: (key: string) => { delete storage[key] } },
  clear: { value: () => { for (const key of Object.keys(storage)) delete storage[key] } },
  key: { value: (index: number) => Object.keys(storage)[index] ?? null },
  length: { get: () => Object.keys(storage).length },
})
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const realNow = Date.now
let now = 1000000
Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: storage } })
Date.now = () => now

try {
  const original = {
    isSystemApplied: true, kingdeeVoucherNo: '  KD-AbC  ', pickupContact: '原领取人',
    pickupAt: '2026-11-06T04:00:00.000Z', remark: '  首行  \n 第二行\t结尾  ',
    items: [{ productId: 'p1', skuId: 's1', qty: 3 }],
  }
  const originalCopy = JSON.parse(JSON.stringify(original))
  const intent = buildClientPreorderSubmitIntentKey({ ...original, clientUserId: 'A', clientOrderType: 'department' })
  const key = createClientPreorderSubmitLock('A', intent, original)
  original.items[0]!.qty = 99
  const restored = readActiveClientPreorderSubmitLock('A')!
  assert.equal(restored.version, 2)
  assert.equal(restored.owner, 'A')
  assert.deepEqual(restored.payload, { ...originalCopy, clientRequestId: key }, '刷新必须恢复首次原始载荷，空白、姓名、时间和金蝶编号不能经指纹重造')
  assert.equal(restored.expiresAt - restored.createdAt, 30 * 60 * 1000)
  assert.equal(readActiveClientPreorderSubmitLock('B'), null, '不同账号不能读取原提交')
  assert.throws(() => createClientPreorderSubmitLock('A', 'changed', original), /未确认/)
  now += 30000
  refreshClientPreorderSubmitLock('A', intent, key)
  assert.equal(readActiveClientPreorderSubmitLock('A')!.expiresAt, restored.expiresAt, '重试不能延长原期限')
  const retry = decideClientCheckoutSubmit({
    refreshSucceeded: false, requestedItems: [{ productId: 'other', skuId: null, qty: 8 }],
    requestedIntentKey: intent, activeSubmitLock: restored, selectedConflictCount: 9, freshItems: null, freshIntentKey: null,
  })
  assert.equal(retry.type, 'retry_pending', '库存刷新失败不能改变已冻结的原提交确认')
  if (retry.type === 'retry_pending') {
    assert.deepEqual(retry.payload, restored.payload)
    assert.deepEqual(retry.items, originalCopy.items)
    assert.equal(retry.requestKey, key)
  }
  const legacyDecision = decideClientCheckoutSubmit({ refreshSucceeded: true, requestedItems: [], requestedIntentKey: intent,
    activeSubmitLock: { intentKey: intent, requestKey: key }, selectedConflictCount: 0, freshItems: [], freshIntentKey: intent })
  assert.deepEqual(legacyDecision, { type: 'blocked', reason: 'pending_unrecoverable' })
  clearClientPreorderSubmitLock('A', 'wrong-key')
  assert.ok(readActiveClientPreorderSubmitLock('A'))
  redactClientPreorderSubmitLocks()
  const redacted = storage.getItem(prefix + 'A')!
  assert.equal(redacted.includes('原领取人'), false)
  assert.equal(redacted.includes('KD-AbC'), false)
  assert.equal(redacted.includes('intentKey'), false, '退出必须清除含业务明文的旧意图指纹')
  assert.equal(readActiveClientPreorderSubmitLock('A')!.payload, null)
  assert.equal(readActiveClientPreorderSubmitLock('A')!.expiresAt, restored.expiresAt)
  assert.throws(() => createClientPreorderSubmitLock('A', 'new', original), /未确认/, '重登不能绕过原 pending 标记')

  storage.setItem(prefix + 'legacy', JSON.stringify({ createdAt: now, requestKey: 'legacy-key', intentKey: intent }))
  assert.equal(readActiveClientPreorderSubmitLock('legacy')!.payload, null)
  assert.equal(storage.getItem(prefix + 'legacy')!.includes('intentKey'), false)
  storage.setItem(prefix + 'bad', '{broken-json')
  const malformed = readActiveClientPreorderSubmitLock('bad')!
  assert.equal(malformed.payload, null)
  now += 100
  assert.equal(readActiveClientPreorderSubmitLock('bad')!.expiresAt, malformed.expiresAt, '损坏记录的保守期限必须固定，不能每读一次重新计时')
  assert.throws(() => createClientPreorderSubmitLock('bad', 'new', original), /未确认/)
  storage.setItem(prefix + 'empty', '')
  assert.equal(readActiveClientPreorderSubmitLock('empty')!.payload, null, '空字符串也是损坏记录，不能解锁')
  storage.setItem(prefix + 'invalid-time', JSON.stringify({ ...restored, owner: 'invalid-time', createdAt: 'bad' }))
  assert.equal(readActiveClientPreorderSubmitLock('invalid-time')!.payload, null, '不完整信封不能恢复载荷')
  storage.setItem(prefix + 'wrong-owner', JSON.stringify({ ...restored, owner: 'someone-else' }))
  assert.equal(readActiveClientPreorderSubmitLock('wrong-owner')!.payload, null)
  now = restored.expiresAt
  const expired = readActiveClientPreorderSubmitLock('A')!
  assert.equal(expired.expired, true)
  assert.equal(expired.payload, null)
  assert.throws(() => createClientPreorderSubmitLock('A', 'new', original), /未确认/, '到期不能自动创建新请求')
  clearClientPreorderSubmitLock('A', key)
  assert.equal(readActiveClientPreorderSubmitLock('A'), null)

  denyRead = true
  assert.throws(() => readActiveClientPreorderSubmitLock('read-error'), /读取被拒绝/)
  assert.throws(() => createClientPreorderSubmitLock('read-error', intent, original), /读取被拒绝/)
  denyRead = false
  denyWrite = true
  assert.throws(() => createClientPreorderSubmitLock('write-error', intent, original), /写入被拒绝/)
  denyWrite = false
  ignoreWrite = true
  assert.throws(() => createClientPreorderSubmitLock('discarded-write', intent, original), /保存失败/)
  ignoreWrite = false

  const product = { id: 'p1', skus: [
    { id: 's1', skuCode: 'ACTIVE-CODE', specText: '蓝色 大号', specValues: { 容量: '特别容量' }, isActive: true, isCurrent: true },
    { id: 'old', skuCode: 'REMOVED-CODE', specText: '旧规格', specValues: {}, isActive: true, isCurrent: false },
    { id: 'disabled', skuCode: 'DISABLED-CODE', specText: '禁用规格', specValues: {}, isActive: false, isCurrent: true },
  ] } as O2oMallProduct
  const text = buildActiveSkuSearchText(product)
  for (const keyword of ['active-code', '蓝色', '特别容量']) assert.ok(text.includes(keyword))
  for (const keyword of ['removed-code', 'disabled-code', '旧规格']) assert.equal(text.includes(keyword), false)
  const replacement = { ...product, skus: product.skus.map((sku) => ({ ...sku, availableStock: 2, discountedPrice: '42' })) }
  const selection = resolveCatalogDetailSelection([replacement], 'p1', 's1')
  assert.equal(selection.product, replacement)
  assert.equal(selection.sku, replacement.skus[0], '详情必须关联新 SKU 对象')
  assert.equal(resolveCatalogDetailSelection([replacement], 'p1', 'old').unavailable, true)
  assert.equal(resolveCatalogDetailSelection([], 'p1', 's1').unavailable, true)
  assert.equal(resolveCatalogDetailSelection([replacement], 'p1', 'missing').sku, null, '失效规格不能自动替换成首项')

  const editBaseline = snapshotOrderEditDraft('原备注', '', [{ itemKey: 's1', qty: 2 }])
  assert.notEqual(snapshotOrderEditDraft('新备注', '', [{ itemKey: 's1', qty: 2 }]), editBaseline)
  assert.notEqual(snapshotOrderEditDraft('原备注', '', [{ itemKey: 's1', qty: 3 }]), editBaseline)
  assert.notEqual(snapshotOrderEditDraft('原备注', '待添加商品', [{ itemKey: 's1', qty: 2 }]), editBaseline)
  assert.equal(snapshotOrderReturnDraft('', { s1: 0 }), snapshotOrderReturnDraft('', {}))
  assert.notEqual(snapshotOrderReturnDraft('退货原因', {}), snapshotOrderReturnDraft('', {}))
  assert.notEqual(snapshotOrderReturnDraft('', { s1: 1 }), snapshotOrderReturnDraft('', {}))

  const draft = { ...createEmptyFeedbackDraft(), title: '标题', summary: '内容', orderRef: '隐藏订单', expectedResult: '期望', actualResult: '实际', contactPreference: '隐藏联系', tagText: '甲，甲,乙' }
  const suggestion = buildFeedbackCreatePayload('suggestion', draft, [])
  for (const field of ['orderRef', 'expectedResult', 'actualResult', 'reproductionSteps', 'contactPreference', 'tags']) {
    assert.equal(Object.hasOwn(suggestion, field), false, '普通建议不能泄漏隐藏字段 ' + field)
  }
  const bug = buildFeedbackCreatePayload('bug', draft, [])
  assert.equal(bug.orderRef, '隐藏订单')
  assert.deepEqual(bug.tags, ['甲', '乙'])
  assert.throws(() => buildFeedbackCreatePayload('restock', draft, []), /补货表单/)

  assert.equal(resolveReplyDraftAfterSend('原文', 1, 1), '')
  assert.equal(resolveReplyDraftAfterSend('发送期间新写内容', 2, 1), '发送期间新写内容')
  let sent = 0
  let refreshWarning = 0
  const result = await sendFeedbackReplyAndRefresh({
    post: async () => {}, refresh: async () => { throw new Error('GET断网') }, isCurrent: () => true,
    onSent: () => { sent += 1 }, onRefreshFailed: () => { refreshWarning += 1 },
  })
  assert.equal(result, 'sent_refresh_failed')
  assert.equal(sent, 1)
  assert.equal(refreshWarning, 1, 'POST成功/GET失败只产生刷新警告')
  await assert.rejects(sendFeedbackReplyAndRefresh({
    post: async () => { throw new Error('POST失败') }, refresh: async () => { assert.fail('POST失败不应回读') }, isCurrent: () => true,
    onSent: () => assert.fail('POST失败不应清草稿'), onRefreshFailed: () => assert.fail('POST失败不属于刷新失败'),
  }), /POST失败/)
  assert.equal(await sendFeedbackReplyAndRefresh({
    post: async () => {}, refresh: async () => assert.fail('过期操作不应回读'), isCurrent: () => false,
    onSent: () => assert.fail('旧账号/旧会话操作不得回写'), onRefreshFailed: () => assert.fail('旧会话不得告警'),
  }), 'stale')
  console.log('客户端 UX policy 验证通过')
} finally {
  Date.now = realNow
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
}
