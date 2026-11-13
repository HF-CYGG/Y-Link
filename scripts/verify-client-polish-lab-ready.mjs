/** 仅诊断隔离服务与真实 Vue 浏览器挂载，不执行本批 UX 验收。产物保留在独立 temp。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createClientPolishLab } from './client-polish-lab-fixture.mjs'
import { createLabEvidenceDir, startClientPolishServer } from './client-polish-lab-server.mjs'

const output = createLabEvidenceDir('ylink-polish-ready-')
console.log('诊断证据目录：' + output)
const source = fs.readFileSync('scripts/verify-login-theme-transition.mjs', 'utf8')
const CdpPage = new Function(source.slice(source.indexOf('class CdpPage'), source.indexOf('async function waitFor')) + ';return CdpPage')()
const lab = createClientPolishLab()
let service, chrome, page, spawnError
const report = { scope: '仅启动阻塞诊断', output, status: 'running', realBackend: false }
const until = async (check, label, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100) }
  throw Error('诊断超时：' + label)
}
try {
  service = await startClientPolishServer({ output, plugins: [lab.plugin, lab.qrPlugin] })
  console.log('HTTP 探针通过：' + service.origin)
  Object.assign(report, { origin: service.origin, readiness: service.readiness, isolation: service.config })
  const profile = path.join(output, 'chrome-profile')
  fs.mkdirSync(profile)
  chrome = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  chrome.once('error', error => { spawnError = error })
  const port = await until(() => {
    if (spawnError) throw spawnError
    if (chrome.exitCode !== null) throw Error('Chrome 提前退出：' + chrome.exitCode)
    try { return Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { return false }
  }, 'Chrome 调试端口', 10000)
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(3000) })).json()
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  page = new CdpPage(socket)
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable')
  await page.send('Page.navigate', { url: service.origin + '/client/mall' })
  await until(() => page.evaluate(`!!document.querySelector('.client-card-stepper__plus')`), '真实 Vue 商城挂载')
  report.browser = await page.evaluate(`({url:location.href,title:document.title,readyState:document.readyState,productPresent:document.body.textContent.includes('单规格体验商品')})`)
  assert.equal(report.browser.productPresent, true)
  assert.equal(page.runtimeErrors.length, 0, JSON.stringify(page.runtimeErrors))
  report.runtimeErrors = page.runtimeErrors
  report.unexpected = lab.state().unexpected
  assert.equal(report.unexpected.length, 0, 'fixture 不得遗漏页面启动 API')
  const screenshot = await page.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(output, 'mounted.png'), Buffer.from(screenshot.data, 'base64'))
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1 }
finally {
  report.requests = service?.requests
  report.runtimeErrors = page?.runtimeErrors
  report.networkFailures = page?.networkFailures
  fs.writeFileSync(path.join(output, 'readiness.json'), JSON.stringify(report, null, 2))
  page?.close(); if (chrome?.pid && chrome.exitCode === null) chrome.kill()
  lab.close()
  let timer
  await Promise.race([service?.close(), new Promise(resolve => { timer = setTimeout(() => { report.cleanup = '关闭超时'; process.exitCode = 1; resolve() }, 5000) })])
  clearTimeout(timer)
  fs.writeFileSync(path.join(output, 'readiness.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
