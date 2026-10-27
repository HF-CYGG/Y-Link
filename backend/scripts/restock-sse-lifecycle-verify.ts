/**
 * 模块说明：补货UI闭环发现的共享SSE连接生命周期专项。
 * 实现逻辑：使用独立SQLite的真实服务与真实HTTP断连覆盖两个异步窗口；以可控响应精确覆盖close/error、头部/首写失败及背压。
 * 维护说明：不接UI库，不改变安全常量；三条健康连接和第四条429必须同时成立。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { createRestockTestRuntime } from './restock-test-runtime.js'

const runtime = await createRestockTestRuntime()
const { customerServiceRealtimeService: realtime } = await import('../src/services/customer-service-realtime.service.js')
const count = () => realtime.buildServiceSessionSnapshot().clientConnectionCount
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await pause(5)
  assert.ok(predicate(), message)
}
const barrier = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve }); return { promise, release } }
let sequence = 0
const owners: string[] = []
class TestResponse extends EventEmitter {
  destroyed = false
  closed = false
  writableEnded = false
  writableLength = 0
  socket = new EventEmitter() as EventEmitter & { destroyed?: boolean }
  writes: string[] = []
  headerClose = false
  writeMode: 'ok' | 'backpressure' | 'throw' = 'ok'
  status() { return this }
  setHeader() { return this }
  flushHeaders() { if (this.headerClose) this.emit('close') }
  write(value: string) { if (this.writeMode === 'throw') throw new Error('受控真实写失败'); this.writes.push(value); return this.writeMode !== 'backpressure' }
  end() { this.writableEnded = true; this.emit('finish'); return this }
}
const open = (response: TestResponse, owner = `lifecycle-${++sequence}`, token = `isolated-lifecycle-${sequence}`) => {
  owners.push(owner)
  realtime.openClientStream(owner, token, response as never, 5, realtime.captureOwnerGeneration('client', owner, token))
  return owner
}
const clearOwners = () => { for (const owner of owners.splice(0)) realtime.disconnectByOwner('client', owner) }
const pass = (scene: string) => console.log(`[通过] ${scene}`)

async function verifyHttpAbort(stage: 'config' | 'auth') {
  const entered = barrier(), release = barrier(), completed = barrier()
  const originalConfig = runtime.clientFeedbackService.getPortalConfigs
  const originalAuth = realtime.assertOwnerCanRegister
  let response: http.ServerResponse | undefined
  let failure: unknown
  if (stage === 'config') runtime.clientFeedbackService.getPortalConfigs = async function (...args) {
    entered.release(); await release.promise; return originalConfig.apply(this, args)
  }
  else realtime.assertOwnerCanRegister = async function (...args) {
    entered.release(); await release.promise; return originalAuth.apply(this, args)
  }
  const server = http.createServer((_request, res) => {
    response = res
    ;(res as any).status = (code: number) => { res.statusCode = code; return res }
    void runtime.clientFeedbackService.openClientRealtimeChannel(runtime.client.auth, res as never)
      .catch((error) => { failure = error }).finally(completed.release)
  })
  let request: http.ClientRequest | undefined
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    request = http.get({ host: '127.0.0.1', port: address.port, path: '/isolated-sse' })
    request.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'ECONNRESET') failure = error })
    await entered.promise
    request.destroy()
    await waitFor(() => response?.destroyed === true && response.socket?.destroyed !== false, `${stage}等待期间的真实Socket必须先断开`)
    release.release()
    await completed.promise
    assert.equal(failure, undefined)
    assert.equal(count(), 0, `${stage}异步校验结束后不能登记已断开响应`)
    assert.equal(response!.listenerCount('close'), 0, '放弃注册也应移除本服务清理监听')
  } finally {
    release.release()
    request?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runtime.clientFeedbackService.getPortalConfigs = originalConfig
    realtime.assertOwnerCanRegister = originalAuth
  }
}

try {
  await verifyHttpAbort('config')
  await verifyHttpAbort('auth')
  pass('真实HTTP在配置/持久会话校验两个await窗口中止，响应destroyed后不占订阅')
  for (const state of ['destroyed', 'closed', 'writableEnded', 'socket'] as const) {
    const response = new TestResponse()
    if (state === 'socket') response.socket.destroyed = true
    else response[state] = true
    open(response)
    assert.equal(count(), 0)
    assert.equal(response.writes.length, 0)
  }
  const headerClose = new TestResponse(); headerClose.headerClose = true
  open(headerClose)
  assert.equal(count(), 0, 'flushHeaders同步close必须在入Map前被监听')
  assert.equal(headerClose.writes.length, 0)
  pass('预先已结束/已关闭/Socket已销毁及headers阶段close不登记')
  for (const event of ['close', 'error', 'finish', 'socket-close']) {
    const response = new TestResponse(), owner = open(response)
    assert.equal(count(), 1)
    const subscriber = Array.from((realtime as any).subscribers.values())[0] as any
    if (event === 'socket-close') response.socket.emit('close')
    else response.emit(event, ...(event === 'error' ? [new Error('受控传输错误')] : []))
    assert.equal(count(), 0)
    assert.ok(subscriber.heartbeatTimer._destroyed && subscriber.revalidateTimer._destroyed, '断连必须释放心跳与授权复核计时器')
    assert.equal(response.listenerCount('close') + response.listenerCount('error') + response.listenerCount('finish') + response.socket.listenerCount('close'), 0)
    const replacement = new TestResponse(); open(replacement, owner, `replacement-${++sequence}`)
    assert.equal(count(), 1, '释放后应可立即重新登记')
    clearOwners()
  }
  const failedWrite = new TestResponse(); failedWrite.writeMode = 'throw'; const failedOwner = open(failedWrite)
  assert.equal(count(), 0, '真正write抛错必须移除订阅')
  open(new TestResponse(), failedOwner, `recovered-${++sequence}`)
  assert.equal(count(), 1)
  clearOwners()
  pass('close/error/finish/Socket断连、真正写失败均释放Map/计时器且允许重连')
  const pressure = new TestResponse(); pressure.writeMode = 'backpressure'; open(pressure)
  assert.equal(count(), 1, 'write(false)是正常背压，不能当作关闭')
  await pause(5100)
  assert.equal(count(), 1, '首个心跳不能提前踢掉等待drain的连接')
  pressure.writeMode = 'ok'; pressure.emit('drain')
  assert.equal(count(), 1)
  assert.equal(pressure.listenerCount('drain'), 0)
  clearOwners()
  assert.equal(pressure.listenerCount('drain'), 0)
  pass('write(false)保留连接与既有慢消费者机制，drain恢复；未提高任何上限')
  const owner = `healthy-${++sequence}`, token = `healthy-session-${sequence}`
  const healthy = [new TestResponse(), new TestResponse(), new TestResponse()]
  for (const response of healthy) open(response, owner, token)
  assert.equal(count(), 3)
  const denied = new TestResponse()
  assert.throws(() => open(denied, owner, token), (error: any) => error.statusCode === 429 && error.message === '当前会话已达到实时连接上限')
  assert.equal(count(), 3)
  assert.equal(denied.listenerCount('close') + denied.listenerCount('error'), 0)
  healthy[0]!.socket.destroyed = true // 未发close事件的确定死Socket，应由容量检查剔除。
  open(new TestResponse(), owner, token)
  assert.equal(count(), 3)
  assert.ok(!healthy[1]!.writableEnded && !healthy[2]!.writableEnded, '容量回收不得踢掉另外两条健康连接')
  assert.throws(() => open(new TestResponse(), owner, token), (error: any) => error.statusCode === 429)
  clearOwners()
  pass('三条健康连接保留/第四条429，容量仅剔除确定死连接，不踢健康连接')
} finally {
  clearOwners()
  realtime.disconnectByOwner('client', runtime.client.auth.userId)
  await runtime.close()
}
console.log('SSE生命周期专项全部通过；隔离SQLite及真实loopback HTTP')
