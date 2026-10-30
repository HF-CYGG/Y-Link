/**
 * 模块说明：金蝶与标签的隔离HTTP定向回归。
 * 文件职责：启动既有自建SQLite应用夹具，通过真实Cookie/CSRF验证登记、待办、本人边界及标签能力。
 * 维护说明：只用IPC接收引导路径，不输出凭据；测试结束等待自身子进程和临时库清理，不启动浏览器。
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export async function verifyIssuesHttpRegistration(verificationRoot: string) {
  const child = fork(fileURLToPath(new URL('./issues-177-178-ui-fixture.ts', import.meta.url)), [], {
    // 使用调用方已经自建的独占目录，不依赖CI或外部shell恰好设置了环境变量。
    cwd: process.cwd(), execArgv: ['--import', 'tsx'], env: { ...process.env, YLINK_ISSUES_VERIFY_ROOT: verificationRoot }, windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const ready = new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离HTTP应用未就绪')), 30_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('隔离HTTP应用提前退出')) })
    child.on('message', (message) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
        clearTimeout(timer); resolve(message)
      }
    })
  })
  try {
    const fixture = await ready
    const origin = `http://127.0.0.1:${fixture.port}`
    const bootstrap = async (kind: string, client = false) => {
      const response = await fetch(`${origin}${fixture.bootstrap}/${kind}`, { signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, 200); assert.equal(response.headers.has('x-powered-by'), false)
      const pairs = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!)
      const cookies = new Map(pairs.map((pair) => { const index = pair.indexOf('='); return [pair.slice(0, index), decodeURIComponent(pair.slice(index + 1))] }))
      const csrf = cookies.get(client ? 'y_link_client_csrf' : 'y_link_admin_csrf')
      assert.ok(csrf, '引导必须返回生产会话绑定CSRF值')
      return { cookie: pairs.join('; '), [client ? 'x-client-csrf-token' : 'x-csrf-token']: csrf }
    }
    const request = async (url: string, headers: Record<string, string>, method = 'GET', body?: unknown, status = 200) => {
      const response = await fetch(origin + url, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, status, '实际HTTP状态不符合接口契约')
      assert.equal(response.headers.has('x-powered-by'), false)
      const payload = await response.json() as { data: any; code: number }
      if (status === 200) assert.equal(payload.code, 0)
      return payload.data
    }
    const client = await bootstrap('client', true), admin = await bootstrap('admin')
    const base = '/api/o2o/mall/preorders'
    const detail = await request(`${base}/${fixture.preorderId}`, client)
    const todos = await request(`${base}/kingdee-todos?page=1&pageSize=50`, client)
    assert.ok(todos.list.some((row: { id: string }) => String(row.id) === String(fixture.preorderId)))
    const registered = await request(`${base}/${fixture.preorderId}/kingdee-registration`, client, 'PATCH', { kingdeeVoucherNo: 'HTTP-177', expectedKingdeeVersion: detail.order.kingdeeVersion })
    assert.equal(registered.order.kingdeeVoucherNo, 'HTTP-177'); assert.equal(registered.order.kingdeeStatus, 'registered')
    assert.equal(registered.order.totalQty, detail.order.totalQty)
    const after = await request(`${base}/kingdee-todos?page=1&pageSize=50`, client)
    assert.ok(!after.list.some((row: { id: string }) => String(row.id) === String(fixture.preorderId)))
    const cleared = await request(`/api/o2o/orders/${fixture.preorderId}/kingdee-registration`, admin, 'PATCH', { kingdeeVoucherNo: null, expectedKingdeeVersion: registered.order.kingdeeVersion })
    assert.equal(cleared.order.kingdeeStatus, 'applied_pending'); assert.equal(cleared.order.isSystemApplied, true)
    const restored = await request(`${base}/kingdee-todos?page=1&pageSize=50`, client)
    assert.ok(restored.list.some((row: { id: string }) => String(row.id) === String(fixture.preorderId)))
    const other = await bootstrap('other', true)
    await request(`${base}/${fixture.preorderId}`, other, 'GET', undefined, 404)
    await request(`${base}/${fixture.preorderId}/kingdee-registration`, client, 'PATCH', { kingdeeVoucherNo: '非法版本', expectedKingdeeVersion: -1 }, 400)
    const supplier = await bootstrap('supplier')
    await request(`/api/o2o/orders/${fixture.preorderId}/kingdee-registration`, supplier, 'PATCH', { kingdeeVoucherNo: '越权', expectedKingdeeVersion: cleared.order.kingdeeVersion }, 403)
    const full = await request('/api/products/labels', admin, 'POST', { skuIds: fixture.skuIds })
    assert.equal(full[0].printLocations.capability, 'full')
    assert.equal(full[0].printLocations.options.find((option: { isMain: boolean }) => option.isMain)?.qty, 0)
    const limited = await request('/api/products/labels', supplier, 'POST', { skuIds: fixture.skuIds })
    assert.equal(limited[0].printLocations.capability, 'main_only')
    assert.ok(!('distributionKey' in limited[0].printLocations)); assert.ok(!JSON.stringify(limited[0].printLocations).includes('qty'))
    console.log('通过：真实Cookie/CSRF登记、清空恢复待办、本人/权限边界、标签投影与无版本响应头')
  } finally {
    if (child.connected) child.send('stop')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('隔离HTTP应用清理超时')), 10_000) })])
      assert.equal(code, 0, '隔离HTTP应用必须正常结束并清理自建库')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }
}
