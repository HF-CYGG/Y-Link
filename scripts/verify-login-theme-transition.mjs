/**
 * 登录页主题切换浏览器回归：只使用本机 Chrome、正式构建产物和只读 API 契约 fixture。
 * 不提交认证请求，不连接真实后端；运行结束后关闭本脚本启动的进程与服务。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const nodeMajorVersion = Number(process.versions.node.split('.')[0])
if (nodeMajorVersion < 22) {
  throw new Error(`登录页主题切换回归需要 Node.js 22 及以上（当前 ${process.version}）`)
}
if (typeof globalThis.WebSocket !== 'function') {
  throw new Error('登录页主题切换回归需要 Node.js 全局 WebSocket，请使用支持该能力的 Node.js 22 及以上版本')
}

const CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const profilePrefix = resolve(tmpdir(), 'ylink-login-theme-')
const profileDir = await mkdtemp(profilePrefix)
const apiRequests = new Map()
let chrome
let fixture
const distDir = resolve('dist')
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.woff2', 'font/woff2'], ['.ico', 'image/x-icon'],
])

const fixtureResponses = new Map([
  ['/health', [200, { status: 'UP', maintenance: { readOnly: false, phase: null, message: null } }]],
  ['/api/auth/me', [401, { code: 401, message: '未登录', data: null }]],
  ['/api/client-auth/me', [401, { code: 401, message: '未登录', data: null }]],
  ['/api/auth/webauthn/capabilities', [200, { code: 0, message: 'ok', data: { enabled: false, rpId: null, rpName: null, allowedOrigins: [] } }]],
  ['/api/client-auth/capabilities', [200, { code: 0, message: 'ok', data: {
    channels: { mobile: false, email: false },
    registerValidationModes: { mobile: 'captcha', email: 'captcha' },
    forgotPasswordEnabled: false,
    departmentTree: [], departmentRootOptions: [], departmentOptions: [],
  } }]],
])

class CdpPage {
  constructor(socket) {
    this.socket = socket
    this.pending = new Map()
    this.runtimeErrors = []
    this.networkFailures = []
    this.networkResponses = []
    this.nextId = 1
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.runtimeErrors.push(message.params?.exceptionDetails?.text || '未知页面异常')
      }
      if (message.method === 'Network.loadingFailed') this.networkFailures.push(message.params)
      if (message.method === 'Network.responseReceived') {
        const { url, status } = message.params.response
        if (url.startsWith('http://127.0.0.1:')) this.networkResponses.push({ url, status })
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, 30_000)
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error(`等待${label}超时`)
}

async function startChrome() {
  chrome = spawn(CHROME_PATH, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  let chromeStartError
  chrome.once('error', (error) => { chromeStartError = error })
  const portFile = join(profileDir, 'DevToolsActivePort')
  const port = await waitFor(async () => {
    if (chromeStartError) throw chromeStartError
    if (chrome.exitCode !== null) throw new Error(`Chrome 提前退出：${chrome.exitCode}`)
    try { return Number((await readFile(portFile, 'utf8')).split('\n')[0]) } catch { return 0 }
  }, 'Chrome 调试端口')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((item) => item.type === 'page')
  assert.ok(target?.webSocketDebuggerUrl, 'Chrome 页面调试目标应可用')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const page = new CdpPage(socket)
  await Promise.all([page.send('Page.enable'), page.send('Runtime.enable')])
  await page.send('Network.enable')
  return page
}

async function runScenario(page, origin, path, strategy, mobile) {
  const early = strategy === 'view-early'
  const viewTransition = strategy === 'view' || early
  const shellSelector = path === '/login' ? '.login-shell' : '.auth-shell'
  const inputSelector = path === '/login' ? '#admin-username' : 'input[placeholder="姓名 / 手机号 / 邮箱 / 工号"]'
  const scenario = `${path} ${strategy} ${mobile ? 'mobile' : 'desktop'}`
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: mobile ? 390 : 1280, height: mobile ? 844 : 800,
    deviceScaleFactor: 1, mobile,
  })
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: strategy === 'reduced' ? 'reduce' : 'no-preference' },
      { name: 'prefers-color-scheme', value: 'light' },
    ],
  })
  const capabilityPath = path === '/login' ? '/api/auth/webauthn/capabilities' : '/api/client-auth/capabilities'
  const capabilityCount = apiRequests.get(capabilityPath) || 0
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      localStorage.setItem('y-link-theme-preference', 'light')
      window.__ylinkEntryAnimations = []
      document.addEventListener('animationstart', (event) => {
        window.__ylinkEntryAnimations.push({ name: event.animationName, target: event.target.className, element: event.target })
      }, true)
      ${strategy === 'fallback' ? "Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined })" : ''}
    `,
  })
  const navigation = await page.send('Page.navigate', { url: `${origin}${path}` })
  try {
    await waitFor(() => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(shellSelector)}) && document.querySelector(${JSON.stringify(inputSelector)}))`), `${scenario} 页面渲染`)
  } catch (error) {
    console.error(JSON.stringify({ scenario, navigation, page: await page.evaluate(`({ url: location.href, readyState: document.readyState, html: document.documentElement.outerHTML.slice(0, 1200), resources: performance.getEntriesByType('resource').map(x => x.name).slice(0, 12) })`), runtimeErrors: page.runtimeErrors, networkFailures: page.networkFailures, apiRequests: Object.fromEntries(apiRequests) }))
    throw error
  }
  await waitFor(async () => {
    if ((apiRequests.get(capabilityPath) || 0) <= capabilityCount) return false
    return page.evaluate(`performance.getEntriesByType('resource').some((entry) => entry.name.endsWith(${JSON.stringify(capabilityPath)}) && entry.responseEnd > 0)`)
  }, `${scenario} 认证能力响应完成`)
  if (!early) await delay(1400)
  const beforeRequests = Object.fromEntries(apiRequests)
  const initial = await page.evaluate(`(async () => {
    const shell = document.querySelector(${JSON.stringify(shellSelector)})
    const input = document.querySelector(${JSON.stringify(inputSelector)})
    input.value = 'LOCAL_THEME_FIXTURE'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const style = document.createElement('style')
    style.textContent = '@keyframes ylink-test-loop { from { opacity: .4 } to { opacity: 1 } } .ylink-test-loop { animation: ylink-test-loop 10s linear infinite alternate } @media (prefers-reduced-motion: reduce) { .ylink-test-loop { animation: none !important } }'
    document.head.append(style)
    const loop = document.createElement('div')
    loop.className = 'ylink-test-loop'
    loop.style.cssText = 'position:fixed;left:-100px;top:-100px'
    const loopStarted = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          loop.removeEventListener('animationstart', onStart)
          reject(new Error('共享循环动画首次 animationstart 超时'))
        }, 2000)
        function onStart(event) {
          if (event.animationName !== 'ylink-test-loop') return
          clearTimeout(timer)
          loop.removeEventListener('animationstart', onStart)
          resolve()
        }
        loop.addEventListener('animationstart', onStart)
      })
    document.body.append(loop)
    await new Promise((resolve) => setTimeout(resolve, 120))
    await loopStarted
    const blob = document.querySelector('.geo-blob')
    const cssAnimation = (element) => element?.getAnimations().find((animation) => animation instanceof CSSAnimation)
    const events = []
    document.addEventListener('animationstart', (event) => {
      if (event.target === shell || shell.contains(event.target) || event.target === loop || event.target === blob) {
        events.push({ name: event.animationName, target: event.target.className })
      }
    }, true)
    const gates = []
    const observer = new MutationObserver(() => gates.push(document.documentElement.dataset.themeTransition || 'none'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-transition'] })
    window.__ylinkThemeProbe = {
      shell, input, loop, blob,
      loopAnimation: cssAnimation(loop), blobAnimation: cssAnimation(blob), shellAnimation: cssAnimation(shell),
      loopStart: cssAnimation(loop)?.currentTime, blobStart: cssAnimation(blob)?.currentTime,
      events, gates, observer,
    }
    return {
      input: input.value, mode: document.documentElement.dataset.themeMode,
      entryAnimations: window.__ylinkEntryAnimations.filter((event) => event.name.startsWith('card-entrance')).map(({ name, target }) => ({ name, target })),
      allEntryAnimations: window.__ylinkEntryAnimations.slice(0, 20).map(({ name, target }) => ({ name, target })),
      shellAnimationStyle: getComputedStyle(shell).animationName,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      blobAnimation: cssAnimation(blob)?.animationName,
      loopAnimation: cssAnimation(loop)?.animationName,
      shellAnimationTime: cssAnimation(shell)?.currentTime,
    }
  })()`)
  console.log(JSON.stringify({ scenario, preflight: initial }))
  assert.equal(initial.input, 'LOCAL_THEME_FIXTURE', `${scenario} 输入预置`)
  assert.equal(initial.mode, 'light', `${scenario} 初始亮色`)
  assert.equal(initial.entryAnimations.length, strategy === 'reduced' ? 0 : 1, `${scenario} 首次入场动画次数`)
  if (strategy !== 'reduced') {
    assert.ok(initial.blobAnimation?.startsWith('blob-float'), `${scenario} 页面循环背景动画存在`)
    assert.equal(initial.loopAnimation, 'ylink-test-loop', `${scenario} 共享循环动画存在`)
  }
  if (early) assert.ok(initial.shellAnimationTime >= 0 && initial.shellAnimationTime < 800, `${scenario} 应在首次入场动画进行中切换`)

  const phases = []
  for (let index = 0; index < 2; index++) {
    await page.evaluate(`document.querySelector('.theme-toggle .el-switch').click()`)
    if (strategy !== 'reduced') {
      const gate = await waitFor(() => page.evaluate(`document.documentElement.dataset.themeTransition || ''`), `${scenario} 第${index + 1}次主题切换开始`)
      if (viewTransition) {
        await waitFor(() => page.evaluate(`(() => {
          const probe = window.__ylinkThemeProbe
          return document.documentElement.dataset.themeTransition === 'view-transition'
            && [probe.blobAnimation, probe.loopAnimation].every((animation) => animation?.playState === 'paused' && !animation.pending)
        })()`), `${scenario} 动画暂停提交`, 350)
        await page.evaluate(`(async () => {
          const probe = window.__ylinkThemeProbe
          await Promise.all([probe.blobAnimation.ready, probe.loopAnimation.ready])
          await new Promise((resolve) => requestAnimationFrame(resolve))
        })()`)
      }
      const start = await page.evaluate(`({
        gate: document.documentElement.dataset.themeTransition,
        blobPending: window.__ylinkThemeProbe.blobAnimation?.pending,
        loopPending: window.__ylinkThemeProbe.loopAnimation?.pending,
        shellState: window.__ylinkThemeProbe.shellAnimation?.playState,
        shellTime: window.__ylinkThemeProbe.shellAnimation?.currentTime,
        blobState: window.__ylinkThemeProbe.blobAnimation?.playState,
        blobTime: window.__ylinkThemeProbe.blobAnimation?.currentTime,
        loopState: window.__ylinkThemeProbe.loopAnimation?.playState,
        loopTime: window.__ylinkThemeProbe.loopAnimation?.currentTime,
      })`)
      await delay(120)
      const later = await page.evaluate(`({
        gate: document.documentElement.dataset.themeTransition,
        shellState: window.__ylinkThemeProbe.shellAnimation?.playState,
        shellTime: window.__ylinkThemeProbe.shellAnimation?.currentTime,
        blobState: window.__ylinkThemeProbe.blobAnimation?.playState,
        blobTime: window.__ylinkThemeProbe.blobAnimation?.currentTime,
        loopState: window.__ylinkThemeProbe.loopAnimation?.playState,
        loopTime: window.__ylinkThemeProbe.loopAnimation?.currentTime,
      })`)
      phases.push({ gate, start, later })
    }
    await waitFor(() => page.evaluate(`!document.documentElement.dataset.themeTransition && document.documentElement.dataset.themeMode === ${JSON.stringify(index === 0 ? 'dark' : 'light')}`), `${scenario} 第${index + 1}次主题切换完成`)
    await delay(80)
    if (early && index === 0) {
      await waitFor(() => page.evaluate(`(() => {
        const animation = window.__ylinkThemeProbe.shellAnimation
        return animation?.playState === 'running' && !animation.pending
      })()`), `${scenario} 入场动画恢复`)
      await page.evaluate(`new Promise((resolve) => requestAnimationFrame(resolve))`)
      const resumed = await page.evaluate(`(() => {
        const probe = window.__ylinkThemeProbe
        return { same: probe.shell.getAnimations().find((animation) => animation instanceof CSSAnimation) === probe.shellAnimation,
          time: probe.shellAnimation?.currentTime, state: probe.shellAnimation?.playState }
      })()`)
      phases[0].resumed = resumed
    }
  }
  const actual = await page.evaluate(`(() => {
    const probe = window.__ylinkThemeProbe
    if (!probe) return { reloaded: true }
    const oneShotCounts = new Map()
    const oneShotRestarts = []
    for (const event of window.__ylinkEntryAnimations) {
      if (!['card-entrance', 'smoothFadeUp', 'geo-entrance'].some((name) => event.name.startsWith(name))) continue
      let byName = oneShotCounts.get(event.element)
      if (!byName) {
        byName = new Map()
        oneShotCounts.set(event.element, byName)
      }
      const count = (byName.get(event.name) || 0) + 1
      byName.set(event.name, count)
      if (count > 1) oneShotRestarts.push({ name: event.name, target: event.target, count })
    }
    return {
      reloaded: false,
      sameShell: document.querySelector(${JSON.stringify(shellSelector)}) === probe.shell,
      sameInput: document.querySelector(${JSON.stringify(inputSelector)}) === probe.input,
      inputValue: probe.input.value,
      oneShotRestarts,
      blobStarts: probe.events.filter((event) => event.name.startsWith('blob-float')).length,
      loopStarts: probe.events.filter((event) => event.name === 'ylink-test-loop').length,
      sameLoopAnimation: probe.loop.getAnimations().find((animation) => animation instanceof CSSAnimation) === probe.loopAnimation,
      sameBlobAnimation: probe.blob?.getAnimations().find((animation) => animation instanceof CSSAnimation) === probe.blobAnimation,
      loopStart: probe.loopStart, loopEnd: probe.loop.getAnimations().find((animation) => animation instanceof CSSAnimation)?.currentTime,
      blobStart: probe.blobStart, blobEnd: probe.blob?.getAnimations().find((animation) => animation instanceof CSSAnimation)?.currentTime,
      reducedAnimationNames: [probe.shell, probe.blob, probe.loop].map((element) => getComputedStyle(element).animationName),
      gates: probe.gates,
      gateCleared: !document.documentElement.dataset.themeTransition,
      finalMode: document.documentElement.dataset.themeMode,
    }
  })()`)
  const afterRequests = Object.fromEntries(apiRequests)
  const apiDelta = Object.fromEntries(Object.entries(afterRequests).map(([key, value]) => [key, value - (beforeRequests[key] || 0)]).filter(([, value]) => value > 0))
  const evidence = { scenario, initial, phases, actual, apiDelta }
  console.log(JSON.stringify(evidence))
  assert.equal(actual.reloaded, false, `${scenario} 页面不得重新导航`)
  assert.equal(actual.sameShell, true, `${scenario} 登录卡片 DOM 身份`)
  assert.equal(actual.sameInput, true, `${scenario} 输入框 DOM 身份`)
  assert.equal(actual.inputValue, 'LOCAL_THEME_FIXTURE', `${scenario} 输入值保持`)
  assert.equal(actual.oneShotRestarts.length, 0, `${scenario} 入场动画不得重播`)
  if (strategy !== 'reduced') {
    assert.equal(actual.blobStarts, 0, `${scenario} 页面循环背景动画不得重启`)
    assert.equal(actual.loopStarts, 0, `${scenario} 共享循环动画不得重启`)
    assert.equal(actual.sameBlobAnimation, true, `${scenario} 页面循环背景动画实例保持`)
    assert.equal(actual.sameLoopAnimation, true, `${scenario} 共享循环动画实例保持`)
    assert.ok(actual.blobEnd > actual.blobStart, `${scenario} 页面循环背景动画延续进度`)
    assert.ok(actual.loopEnd > actual.loopStart, `${scenario} 共享循环动画延续进度`)
  }
  if (strategy === 'reduced') assert.deepEqual(actual.reducedAnimationNames, ['none', 'none', 'none'], `${scenario} 应关闭非必要动画`)
  assert.equal(actual.gateCleared, true, `${scenario} 主题门控清理`)
  assert.equal(actual.finalMode, 'light', `${scenario} 亮暗切换恢复亮色`)
  assert.equal(apiDelta['/api/auth/webauthn/capabilities'] || 0, 0, `${scenario} 管理端认证能力不重取`)
  assert.equal(apiDelta['/api/client-auth/capabilities'] || 0, 0, `${scenario} 客户端认证能力不重取`)
  assert.equal(apiDelta['/api/auth/captcha'] || 0, 0, `${scenario} 管理端验证码不重取`)
  assert.equal(apiDelta['/api/client-auth/captcha'] || 0, 0, `${scenario} 客户端验证码不重取`)
  if (viewTransition) assert.ok(actual.gates.includes('view-transition'), `${scenario} 应执行圆形揭幕`)
  if (strategy === 'fallback') assert.ok(actual.gates.includes('fallback'), `${scenario} 应执行降级过渡`)
  if (strategy === 'reduced') assert.ok(!actual.gates.includes('view-transition') && !actual.gates.includes('fallback'), `${scenario} 应减少动态效果`)
  if (viewTransition) {
    for (const phase of phases) {
      assert.equal(phase.start.gate, 'view-transition', `${scenario} 暂停采样仍处于本次揭幕`)
      assert.equal(phase.later.gate, 'view-transition', `${scenario} 二次采样仍处于本次揭幕`)
      assert.equal(phase.start.blobPending, false, `${scenario} 页面背景暂停已提交`)
      assert.equal(phase.start.loopPending, false, `${scenario} 共享动画暂停已提交`)
      assert.equal(phase.start.blobState, 'paused', `${scenario} 页面背景在揭幕期间暂停`)
      assert.equal(phase.start.loopState, 'paused', `${scenario} 共享动画在揭幕期间暂停`)
      assert.ok(Math.abs(phase.later.blobTime - phase.start.blobTime) < 25, `${scenario} 页面背景在揭幕期间进度冻结`)
      assert.ok(Math.abs(phase.later.loopTime - phase.start.loopTime) < 25, `${scenario} 共享动画在揭幕期间进度冻结`)
    }
  }
  if (early) {
    assert.equal(phases[0].start.shellState, 'paused', `${scenario} 入场动画在揭幕期间暂停`)
    assert.ok(Math.abs(phases[0].later.shellTime - phases[0].start.shellTime) < 25, `${scenario} 入场动画在揭幕期间进度冻结`)
    assert.equal(phases[0].resumed.same, true, `${scenario} 入场动画恢复原实例`)
    assert.ok(phases[0].resumed.time > phases[0].start.shellTime, `${scenario} 入场动画继续前进`)
  }
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
}

async function diagnosePage(page, origin) {
  const navigation = await page.send('Page.navigate', { url: `${origin}/login` })
  await delay(12_000)
  const dom = await page.evaluate(`({
    url: location.href, readyState: document.readyState,
    rootClasses: document.documentElement.className,
    shell: !!document.querySelector('.login-shell'),
    username: !!document.querySelector('#admin-username'),
    inputs: [...document.querySelectorAll('input')].map(input => ({ id: input.id, placeholder: input.placeholder })).slice(0, 10),
    body: document.body?.innerText.slice(0, 450),
    resources: performance.getEntriesByType('resource').map(x => x.name).filter(x => x.startsWith(location.origin)).slice(0, 20)
  })`)
  const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = join(tmpdir(), 'ylink-login-theme-baseline.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  console.log(JSON.stringify({ navigation, dom, screenshotPath, responses: page.networkResponses.slice(0, 30), failures: page.networkFailures, runtimeErrors: page.runtimeErrors, apiRequests: Object.fromEntries(apiRequests) }))
}

try {
  fixture = createHttpServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (path === '/health' || path.startsWith('/api/')) {
      apiRequests.set(path, (apiRequests.get(path) || 0) + 1)
      if (request.method !== 'GET' || !fixtureResponses.has(path)) {
        response.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ code: 501, message: `fixture 未覆盖 ${request.method} ${path}`, data: null }))
        return
      }
      const [status, data] = fixtureResponses.get(path)
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
      return
    }
    const routeFile = extname(path) ? path.slice(1) : 'index.html'
    const filePath = resolve(distDir, routeFile)
    if (!filePath.startsWith(distDir + sep)) {
      response.writeHead(403)
      response.end()
      return
    }
    try {
      const content = await readFile(filePath)
      response.writeHead(200, { 'Content-Type': mimeTypes.get(extname(filePath)) || 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(content)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolvePromise) => fixture.listen(0, '127.0.0.1', resolvePromise))
  const origin = `http://127.0.0.1:${fixture.address().port}`
  const page = await startChrome()
  try {
    if (process.argv.includes('--diagnose')) {
      await diagnosePage(page, origin)
    } else {
      const scenarios = process.argv.includes('--admin-view')
        ? [['/login', 'view', false]]
        : process.argv.includes('--client-view')
          ? [['/client/login', 'view', false]]
          : ['/login', '/client/login'].flatMap((path) => [
              [path, 'view', false], [path, 'view', true],
              [path, 'fallback', false], [path, 'fallback', true],
              [path, 'reduced', false], [path, 'reduced', true],
              [path, 'view-early', false],
            ])
      for (const [path, strategy, mobile] of scenarios) {
          await runScenario(page, origin, path, strategy, mobile)
      }
    }
  } finally {
    try { await Promise.race([page.send('Browser.close'), delay(1000)]) } catch { /* 连接随浏览器关闭属于正常情况。 */ }
    page.close()
  }
} finally {
  if (chrome?.pid && chrome.exitCode === null) {
    chrome.kill()
    await Promise.race([
      new Promise((resolvePromise) => chrome.once('close', resolvePromise)),
      delay(3000),
    ])
  }
  if (fixture) await new Promise((resolvePromise) => fixture.close(resolvePromise))
  const safeProfile = resolve(profileDir)
  assert.ok(safeProfile.startsWith(profilePrefix) && safeProfile !== profilePrefix && safeProfile.startsWith(resolve(tmpdir()) + sep))
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(safeProfile, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt === 7 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error
      await delay(500)
    }
  }
}
