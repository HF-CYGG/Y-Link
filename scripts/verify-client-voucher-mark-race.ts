/** 文件职责：以可控异步回包验证客户端正式出库单上报不会覆盖已切换或卸载的订单详情。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const vue = readFileSync(new URL('../src/views/client/ClientOrderDetailView.vue', import.meta.url), 'utf8')
const script = vue.split('<script setup lang="ts">')[1]?.split('</script>')[0]
assert.ok(script, '应能读取客户端订单详情脚本')
const source = ts.createSourceFile('ClientOrderDetailView.ts', script, ts.ScriptTarget.Latest, true)
const declaration = source.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .find((item) => item.name.getText(source) === 'markCustomerOrderPrintedIfNeeded')
assert.ok(declaration?.initializer, '应保留正式出库单状态上报入口')
const implementation = declaration.initializer.getText(source)

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Detail = { order: { id: string; clientOrderType: string; hasCustomerOrder: boolean } }
const makeDetail = (id: string, printed = false): Detail => ({ order: { id, clientOrderType: 'department', hasCustomerOrder: printed } })

const scenario = () => {
  const pending = deferred<Detail>()
  const detail = { value: makeDetail('order-a') }
  const route = { params: { id: 'order-a' } }
  const requests: string[] = []
  const storeUpdates: string[] = []
  const notifications: string[] = []
  const warnings: string[] = []
  const make = new Function(
    'detail', 'route', 'markMyO2oPreorderCustomerOrderPrinted', 'syncOrderStoreFromDetail',
    'notifyClientOrderRefresh', 'clientOrderRefreshSourceId', 'normalizeRequestError', 'showAppWarning',
    `let voucherDetailUnmounted = false; return {
      run: (${implementation}),
      unmount: () => { voucherDetailUnmounted = true },
    }`,
  ) as (...values: unknown[]) => { run: () => Promise<void>; unmount: () => void }
  const subject = make(
    detail, route,
    (id: string) => { requests.push(id); return pending.promise },
    (next: Detail) => storeUpdates.push(next.order.id),
    (event: { orderId: string }) => notifications.push(event.orderId),
    'fixture-source',
    (error: Error) => ({ message: error.message }),
    (message: string) => warnings.push(message),
  )
  return { ...subject, pending, detail, route, requests, storeUpdates, notifications, warnings }
}

const same = scenario()
const sameRun = same.run()
same.pending.resolve(makeDetail('order-a', true))
await sameRun
assert.equal(same.detail.value.order.hasCustomerOrder, true, '当前订单正常收到新详情')
assert.deepEqual(same.requests, ['order-a'])
assert.deepEqual(same.storeUpdates, ['order-a'])
assert.deepEqual(same.notifications, ['order-a'])

const switched = scenario()
const switchedRun = switched.run()
switched.route.params.id = 'order-b'
switched.detail.value = makeDetail('order-b')
switched.pending.resolve(makeDetail('order-a', true))
await switchedRun
assert.equal(switched.detail.value.order.id, 'order-b', '旧单回包不能覆盖切换后的新单详情')
assert.deepEqual(switched.storeUpdates, ['order-a'], '旧单状态仍更新 Store')
assert.deepEqual(switched.notifications, ['order-a'], '旧单状态仍广播刷新')

const routeSwitchedOnly = scenario()
const routeOnlyRun = routeSwitchedOnly.run()
routeSwitchedOnly.route.params.id = 'order-b'
routeSwitchedOnly.pending.resolve(makeDetail('order-a', true))
await routeOnlyRun
assert.equal(routeSwitchedOnly.detail.value.order.hasCustomerOrder, false, '路由已切换时不得回写仍残留的旧详情')

const detailSwitchedOnly = scenario()
const detailOnlyRun = detailSwitchedOnly.run()
detailSwitchedOnly.detail.value = makeDetail('order-b')
detailSwitchedOnly.pending.resolve(makeDetail('order-a', true))
await detailOnlyRun
assert.equal(detailSwitchedOnly.detail.value.order.id, 'order-b', '详情已切换时不得回写旧单')

const unmounted = scenario()
const unmountedRun = unmounted.run()
unmounted.unmount()
unmounted.pending.resolve(makeDetail('order-a', true))
await unmountedRun
assert.equal(unmounted.detail.value.order.hasCustomerOrder, false, '卸载后的回包不能回写页面详情')
assert.deepEqual(unmounted.storeUpdates, ['order-a'])
assert.deepEqual(unmounted.notifications, ['order-a'])

const failedAfterSwitch = scenario()
const failedRun = failedAfterSwitch.run()
failedAfterSwitch.route.params.id = 'order-b'
failedAfterSwitch.detail.value = makeDetail('order-b')
failedAfterSwitch.pending.reject(new Error('旧单上报失败'))
await failedRun
assert.deepEqual(failedAfterSwitch.warnings, [], '新单页面不应显示旧单请求失败')

const failedAfterUnmount = scenario()
const failedUnmountRun = failedAfterUnmount.run()
failedAfterUnmount.unmount()
failedAfterUnmount.pending.reject(new Error('卸载后上报失败'))
await failedUnmountRun
assert.deepEqual(failedAfterUnmount.warnings, [], '卸载后不应显示旧页面错误')

const failedCurrent = scenario()
const failedCurrentRun = failedCurrent.run()
failedCurrent.pending.reject(new Error('当前订单上报失败'))
await failedCurrentRun
assert.deepEqual(failedCurrent.warnings, ['当前订单上报失败'], '当前订单上报失败仍应提示')

assert.match(vue, /onBeforeUnmount\(\(\) => \{\s*voucherDetailUnmounted = true/, '卸载钩子应标记当前详情失效')
console.log('客户端正式出库单状态上报竞态验证通过')
