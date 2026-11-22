/** 生产核销页真实 setup 和事件处理：验证核销目标竞态及现场改单候选。 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { host, mountConsole, preorder, result, search, flush } from './o2o-verify-console-behavior-runtime.mjs'
import { withBrowser, deferred, unmountAll } from './vue-behavior-test-runtime.mjs'
afterEach(() => { unmountAll(); host.auth?.$dispose?.() })
const network = () => {
  const queries = [], refreshes = [], verifications = []
  host.api = {
    getO2oVerifyDetail: (code) => { const waiting = deferred(); queries.push({ code, ...waiting }); return waiting.promise },
    getO2oConsoleOrderDetail: (id, options) => { const waiting = deferred(); refreshes.push({ id, options, ...waiting }); return waiting.promise },
    verifyO2oPreorder: async (code) => { verifications.push(code); return result(code.slice(5)) },
  }
  return { queries, refreshes, verifications }
}
const load = async (state, calls, id, version = 1) => {
  const pending = search(state, id); calls.queries.at(-1).resolve(result(id, version)); await pending
  assert.equal(state.currentVerifyCode.value, `code-${id}`)
}
const verify = async (state, calls, id) => {
  assert.equal(state.currentVerifyCode.value, `code-${id}`)
  await state.handleVerify(); assert.deepEqual(calls.verifications, [`code-${id}`])
}

test('A刷新→查询B→B先回A后回，实际核销仍提交B', async () => withBrowser(async () => {
  const calls = network(), { state } = await mountConsole(); await load(state, calls, 'A')
  const old = state.refreshKingdeeDetail(); await load(state, calls, 'B')
  assert.equal(calls.refreshes[0].options.signal.aborted, true)
  calls.refreshes[0].resolve(preorder('A', 2)); await old
  assert.equal(state.verifyResult.value.detail.order.id, 'B'); await verify(state, calls, 'B')
}))

test('B查询未完成时A刷新返回，不能取消B latest或清掉其loading', async () => withBrowser(async () => {
  const calls = network(), { state } = await mountConsole(); await load(state, calls, 'A')
  const old = state.refreshKingdeeDetail(), next = search(state, 'B')
  calls.refreshes[0].resolve(preorder('A', 2)); await old
  assert.equal(state.loading.value, true); assert.equal(state.preorderDetail.value.order.kingdeeVersion, 1)
  calls.queries.at(-1).resolve(result('B')); await next; await verify(state, calls, 'B')
}))

test('清空目标后旧刷新不能恢复单据或核销码', async () => withBrowser(async () => {
  const calls = network(), { state } = await mountConsole(); await load(state, calls, 'A')
  const old = state.refreshKingdeeDetail(); state.verifyCode.value = ''
  calls.refreshes[0].resolve(preorder('A', 2)); await old; await flush()
  assert.equal(state.verifyResult.value, null); assert.equal(state.currentVerifyCode.value, '')
  await state.handleVerify(); assert.deepEqual(calls.verifications, [])
}))

test('直接再次查询同一A时也在请求开始失效旧刷新，不依赖ID watcher', async () => withBrowser(async () => {
  const calls = network(), { state } = await mountConsole(); await load(state, calls, 'A')
  const old = state.refreshKingdeeDetail(), next = search(state, 'A')
  calls.refreshes[0].resolve(preorder('A', 2)); await old
  assert.equal(state.loading.value, true); assert.equal(state.preorderDetail.value.order.kingdeeVersion, 1)
  calls.queries.at(-1).resolve(result('A', 7)); await next
  assert.equal(state.preorderDetail.value.order.kingdeeVersion, 7); await verify(state, calls, 'A')
}))

test('A→B→A相同ID的新查询代次不能被第一轮A刷新回退', async () => withBrowser(async () => {
  const calls = network(), { state } = await mountConsole(); await load(state, calls, 'A')
  const old = state.refreshKingdeeDetail(); await load(state, calls, 'B'); await load(state, calls, 'A', 7)
  calls.refreshes[0].resolve(preorder('A', 2)); await old
  assert.equal(state.preorderDetail.value.order.kingdeeVersion, 7); await verify(state, calls, 'A')
}))

test('当前A连续两次登记刷新逆序，只采纳最后一次，正常刷新可核销', async () => withBrowser(async () => {
  const calls = network(), { state } = await mountConsole(); await load(state, calls, 'A')
  const first = state.refreshKingdeeDetail(), second = state.refreshKingdeeDetail()
  calls.refreshes[1].resolve(preorder('A', 7)); await second
  calls.refreshes[0].resolve(preorder('A', 2)); await first
  assert.equal(calls.refreshes[0].options.signal.aborted, true)
  assert.equal(state.preorderDetail.value.order.kingdeeVersion, 7); await verify(state, calls, 'A')
}))

test('卸载后刷新迟到不能回写；失效请求失败不提示，当前刷新失败仍提示', async () => withBrowser(async () => {
  const calls = network(), mounted = await mountConsole(), { state } = mounted
  await load(state, calls, 'A')
  const current = state.refreshKingdeeDetail(); calls.refreshes[0].reject(new Error('当前刷新失败')); await current
  assert.deepEqual(host.errors, ['当前刷新失败']); host.errors.length = 0
  const stale = state.refreshKingdeeDetail(); await load(state, calls, 'B')
  calls.refreshes[1].reject(new Error('旧目标失败')); await stale; assert.deepEqual(host.errors, [])
  const late = state.refreshKingdeeDetail(); mounted.unmount()
  calls.refreshes[2].resolve(preorder('B', 9)); await late
  assert.equal(calls.refreshes[2].options.signal.aborted, true)
  assert.equal(state.preorderDetail.value.order.kingdeeVersion, 1); assert.deepEqual(calls.verifications, [])
}))

test('现场改单只显示上架候选，快照到期或切换管理会话时重新查询', async (context) => withBrowser(async () => {
  const calls = network(), { state } = await mountConsole()
  await load(state, calls, 'A')
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const requestedBy = []
  host.api.getProductList = async (query, { signal }) => {
    assert.deepEqual(query, { isActive: true })
    assert.ok(signal instanceof AbortSignal && !signal.aborted)
    const userId = host.auth.currentUser.id
    requestedBy.push(userId)
    return [
      { id: userId, productName: `可选商品 ${userId}`, o2oStatus: 'listed' },
      { id: 'hidden', productName: '下架商品', o2oStatus: 'unlisted' },
    ]
  }

  await state.openOnsiteAdjustDialog()
  assert.equal(state.onsiteAdjustDialogVisible.value, true)
  assert.deepEqual(state.onsiteEditableProductOptions.value, [{ value: '185', label: '可选商品 185' }])
  now += 19_999
  await state.openOnsiteAdjustDialog()
  assert.deepEqual(requestedBy, ['185'])
  now += 1
  await state.openOnsiteAdjustDialog()
  assert.deepEqual(requestedBy, ['185', '185'])

  host.auth.setAuthState({ user: { ...host.auth.currentUser, id: '186' } })
  await state.openOnsiteAdjustDialog()
  assert.deepEqual(requestedBy, ['185', '185', '186'])
  assert.deepEqual(state.onsiteEditableProductOptions.value, [{ value: '186', label: '可选商品 186' }])
  assert.deepEqual(host.errors, [])
}))
