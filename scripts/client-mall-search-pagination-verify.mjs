/** 通过隔离 API fixture 和真实浏览器验证商城搜索分页，不连接真实业务数据。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const source = fs.readFileSync('scripts/verify-login-theme-transition.mjs', 'utf8')
const CdpPage = new Function(source.slice(source.indexOf('class CdpPage'), source.indexOf('async function waitFor')) + ';return CdpPage')()
const user = { id: 'fixture-1', username: '测试账号', account: '测试账号', realName: '测试账号', accountType: 'personal', status: 'enabled' }
const storefront = { businessHoursText: '10:00 - 22:00', mallAnnouncementText: '', pickupWindowHours: 24 }
const products = Array.from({ length: 55 }, (_, i) => ({ id: `p${i}`, productName: `测试商品${String(i).padStart(2, '0')}`, productCode: `P${i}`, defaultPrice: '12', originalPrice: '12', discountedPrice: '12', discountRate: '10', availableStock: 20, currentStock: 20, preOrderedStock: 0, soldQty: i, o2oRecommended: i === 54, limitPerUser: 0, tags: [], skus: [] }))
let fixtureProducts = [...products]
let catalogRequests = 0
const fixture = { name: 'catalog-fixture', configureServer(server) { server.middlewares.use((req, res, next) => {
  const url = req.url.split('?')[0]
  if (!url.startsWith('/api/')) return next()
  let data = null
  if (url === '/api/client-auth/me') data = user
  else if (url.endsWith('/mall/products')) { catalogRequests += 1; data = { list: fixtureProducts, storefront } }
  else if (url.endsWith('/mall/storefront')) data = storefront
  else if (url.includes('/restock-requests/active')) data = { restock: null }
  else if (url.endsWith('/capabilities')) data = { enabled: false, channels: {}, departmentOptions: [] }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 0, message: 'ok', data }))
}) } }
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-catalog-verify-'))
let vite, chrome, page
try {
  process.env.VITE_DEV_SERVER_HTTPS = 'false'
  vite = await createServer({ cacheDir: path.join(temp, 'vite'), plugins: [fixture], server: { host: '127.0.0.1', port: 0, open: false } })
  await vite.listen()
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  const profile = path.join(temp, 'chrome')
  chrome = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let spawnError
  chrome.once('error', error => { spawnError = error })
  let port
  for (let i = 0; i < 200 && !port; i++) {
    if (spawnError) throw spawnError
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch {}
    if (!port) await delay(100)
  }
  assert.ok(port, 'Chrome 调试端口就绪')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  page = new CdpPage(socket)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear();localStorage.setItem('y-link.client-auth.user',${JSON.stringify(JSON.stringify(user))});localStorage.setItem('y-link.client-auth.expiresAt','2099-01-01T00:00:00.000Z');document.cookie='y_link_client_csrf=fixture';` })
  const until = async (expression) => { for (let i = 0; i < 150; i++) { if (await page.evaluate(expression)) return; await delay(100) } throw Error(`等待超时：${expression}`) }
  const fill = async (value) => page.evaluate(`(()=>{const e=document.querySelector('.mall-search-inline-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const key = async (name) => {
    const code = name === 'Tab' ? 9 : 13
    // Enter 的默认按钮激活依赖字符事件；只有虚拟键码会缺少 keypress，也不会触发可信 click。
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
      ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
    })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  }
  // 通过页面已有刷新入口请求当前 fixture；DOM click 不转移测试中刻意保留的键盘焦点。
  const refresh = async () => {
    await until("!!document.querySelector('.mall-hero-card__refresh:not(:disabled)')")
    await page.evaluate("document.querySelector('.mall-hero-card__refresh').click()")
  }
  for (const width of [767, 768, 1199, 1200]) {
    fixtureProducts = [...products]
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await page.send('Page.navigate', { url: `${origin}/client/mall` })
    await until("!!document.querySelector('.mall-search-inline-input')")
    await fill('测试商品')
    await until("document.body.textContent.includes('搜索结果 55 条')")
    assert.equal(await page.evaluate("document.querySelectorAll('.mall-product-grid .client-product-card').length"), 24)
    const first = await page.evaluate("[...document.querySelectorAll('.mall-product-grid .client-product-card__name')].map(e=>e.textContent.trim())")
    await page.evaluate("(()=>{const card=[...document.querySelectorAll('.mall-product-grid .client-product-card')].at(-1);const controls=[...card.querySelectorAll('button:not([disabled]),a[href],input:not([disabled])')];controls.at(-1).focus()})()")
    for (let i = 0; i < 20 && !await page.evaluate("document.activeElement?.classList.contains('btn-next')"); i++) await key('Tab')
    assert.equal(await page.evaluate("document.activeElement?.classList.contains('btn-next')"), true, '真实 Tab 到达分页下一页')
    await page.evaluate(`(()=>{
      window.__mallPaginationEnter = {};
      const next = document.activeElement;
      next.addEventListener('keypress', event => { window.__mallPaginationEnter.keypress = {key:event.key, code:event.keyCode, char:event.charCode, trusted:event.isTrusted} }, {once:true});
      next.addEventListener('click', event => { window.__mallPaginationEnter.clickTrusted = event.isTrusted }, {once:true});
    })()`)
    await key('Enter')
    await until("document.querySelector('.el-pager .is-active')?.textContent.trim()==='2'")
    assert.deepEqual(await page.evaluate('window.__mallPaginationEnter'), {
      keypress: { key: 'Enter', code: 13, char: 13, trusted: true }, clickTrusted: true,
    }, '翻页必须由真实 Enter 字符事件触发默认按钮激活')
    assert.equal(await page.evaluate("document.activeElement?.classList.contains('btn-next')"), true, '翻页保留焦点')
    const second = await page.evaluate("[...document.querySelectorAll('.mall-product-grid .client-product-card__name')].map(e=>e.textContent.trim())")
    assert.equal(second.length, 24)
    assert.equal(second.some(name => first.includes(name)), false)
    await page.evaluate("document.querySelector('.mall-search-pagination .btn-next').click()")
    await until("document.querySelector('.el-pager .is-active')?.textContent.trim()==='3'")
    assert.equal(await page.evaluate("document.querySelectorAll('.mall-product-grid .client-product-card').length"), 7)
    fixtureProducts = products.slice(0, 30)
    await refresh()
    await until("document.body.textContent.includes('搜索结果 30 条') && document.querySelector('.el-pager .is-active')?.textContent.trim()==='2'")
    assert.equal(await page.evaluate("document.querySelectorAll('.mall-product-grid .client-product-card').length"), 6, '刷新后总数和页码同时收缩')
    const removedId = 'p29'
    await page.evaluate("(()=>{const cards=[...document.querySelectorAll('.mall-product-grid .client-product-card')];cards.at(-1).querySelector('button').focus()})()")
    assert.equal(await page.evaluate("document.activeElement?.closest('.client-product-card')?.textContent.includes('测试商品29')"), true)
    fixtureProducts = fixtureProducts.filter(product => product.id !== removedId)
    await refresh()
    await until("document.body.textContent.includes('搜索结果 29 条')")
    await until("document.activeElement?.textContent.includes('搜索结果 29 条')")
    assert.equal(await page.evaluate("document.activeElement?.getAttribute('tabindex')"), '-1', '被删除卡片的焦点转移到结果标题')
    // 手机断点的内联工具栏 display:none，必须先从公开入口打开实际可用的搜索输入框。
    const visibleSearchInput = "[...document.querySelectorAll('.mall-search-inline-input')].find(input=>input.getClientRects().length>0)"
    if (!await page.evaluate(`!!(${visibleSearchInput})`)) {
      assert.equal(await page.evaluate(`(()=>{
        const trigger=[...document.querySelectorAll('.mall-mobile-search-trigger')].find(button=>button.getClientRects().length>0);
        if(!trigger)return false;trigger.click();return true;
      })()`), true, '手机搜索入口必须可见且可打开')
      await until(`!!(${visibleSearchInput})`)
    }
    assert.equal(await page.evaluate(`(()=>{
      const input=${visibleSearchInput};
      window.__mallSearchInputBeforeRefresh=input;
      input.focus();return document.activeElement===input && input.isConnected;
    })()`), true, '后台刷新前必须真正聚焦可见搜索输入框')
    fixtureProducts = fixtureProducts.filter(product => product.id !== 'p28')
    const requestsBeforeBackgroundRefresh = catalogRequests
    assert.equal(await page.evaluate('document.visibilityState'), 'visible')
    // 跨过后台校验原有的 10 秒最小间隔，不等待真实时间，也不调用组件私有方法或刷新按钮。
    await page.evaluate(`(()=>{
      window.__mallFixtureDateNow=Date.now;
      Date.now=()=>window.__mallFixtureDateNow()+10_001;
      document.dispatchEvent(new Event('visibilitychange'));
    })()`)
    try {
      await until("document.body.textContent.includes('搜索结果 28 条')")
      assert.equal(catalogRequests, requestsBeforeBackgroundRefresh + 1, '前台可见事件必须触发真实目录请求')
      assert.equal(await page.evaluate(`document.activeElement === window.__mallSearchInputBeforeRefresh
        && window.__mallSearchInputBeforeRefresh.isConnected
        && window.__mallSearchInputBeforeRefresh.getClientRects().length>0`), true, '刷新不抢占搜索输入焦点')
    } finally {
      await page.evaluate('Date.now=window.__mallFixtureDateNow;delete window.__mallFixtureDateNow')
    }
    await page.evaluate("document.querySelector('.mall-mobile-search-sheet__close')?.click()")
    await page.evaluate("[...document.querySelectorAll('.mall-search-pagination button')].find(e=>e.textContent.includes('跳到搜索结果')).click()")
    assert.equal(await page.evaluate("document.activeElement?.textContent.includes('搜索结果 28 条')"), true)
    fixtureProducts = [...products]
    await refresh()
    await until("document.body.textContent.includes('搜索结果 55 条')")
    await page.evaluate("[...document.querySelectorAll('.mall-sort-control__button')].find(e=>e.textContent.trim()==='推荐').click()")
    await until("document.querySelector('.el-pager .is-active')?.textContent.trim()==='1'")
    assert.equal(await page.evaluate("document.querySelector('.mall-product-grid .client-product-card__name')?.textContent.trim()"), '测试商品54', '推荐排序保持完整结果顺序')
    await fill('不存在的商品')
    await until("document.body.textContent.includes('未找到相关商品')")
    assert.equal(await page.evaluate("document.querySelectorAll('.mall-product-grid .client-product-card').length"), 0)
  }
  console.log('搜索分页浏览器场景通过')
} finally {
  chrome?.kill()
  await vite?.close()
}
