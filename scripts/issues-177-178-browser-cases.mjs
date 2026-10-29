/**
 * 模块说明：#177/#178 九组真实浏览器验收场景。
 * 文件职责：实际页面、Cookie/CSRF、生产HTTP、打印PDF与独立ZXing解码；局部宿主竞态单独标识。
 * 维护说明：网络暂停只延后真实响应，失败只注入传输错误；禁止赋组件/Store内部状态或伪造成功数据。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const editorSelector = '[data-testid="kingdee-registration-editor"]'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
async function until(read, predicate, message, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await pause(100) }
  throw new Error(message)
}
export async function runIssueBrowserCases({ browser, origin, ready, evidence, root, PDFDocument, pdfjs, ExcelJS, scenario, recordArtifact }) {
  const contexts = []
  const makeContext = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true })
    // 唯一系统边界替身：统计真实生产handler到达window.print；后续用Chromium实际输出PDF。
    await context.addInitScript(() => { window.__issuePrintCalls = 0; window.print = () => { window.__issuePrintCalls += 1 } })
    contexts.push(context); return context
  }
  const clientContext = await makeContext(), adminContext = await makeContext()
  const client = await clientContext.newPage(), admin = await adminContext.newPage()
  const pageErrors = []
  for (const context of contexts) context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)))
  for (const page of [client, admin]) page.on('pageerror', (error) => pageErrors.push(error.message))
  const bootstrap = async (context, kind) => { const response = await context.request.get(origin + ready.bootstrap + '/' + kind); assert.equal(response.status(), 200); const me=await context.request.get(origin+(['client','other'].includes(kind)?'/api/client-auth/me':'/api/auth/me')); assert.equal(me.status(),200,'真实Cookie引导必须通过生产me会话确认') }
  const api = async (context, method, url, data, domain = 'admin') => {
    const cookie = (await context.cookies(origin)).find((item) => item.name === (domain === 'admin' ? 'y_link_admin_csrf' : 'y_link_client_csrf'))
    assert.ok(cookie, '必须使用真实会话绑定CSRF引导')
    const response = await context.request.fetch(origin + '/api' + url, { method, data, headers: { origin, referer: origin + '/', [domain === 'admin' ? 'x-csrf-token' : 'x-client-csrf-token']: decodeURIComponent(cookie.value) } })
    const body = await response.json()
    if (response.status() !== 200) recordArtifact({ type: 'http-failure', method, url, status: response.status(), code: body.code, message: body.message })
    assert.equal(response.status(), 200, `隔离实际API失败：${method} ${url}：${body.message}`)
    return body.data
  }
  const readClient = async (id) => (await clientContext.request.get(origin + '/api/o2o/mall/preorders/' + id)).json().then((body) => body.data)
  const reminder = (page) => page.getByRole('dialog', { name: '金蝶编号待办', exact: true })
  const closeReminder = async (page, required = true) => {
    if (required) await reminder(page).waitFor()
    if (await reminder(page).isVisible()) { await reminder(page).locator('.el-dialog__headerbtn').click(); await reminder(page).waitFor({ state: 'hidden' }) }
  }
  const visitClient = async (id) => {
    await client.bringToFront(); await bootstrap(clientContext, 'client'); await client.goto(origin + '/client/orders/' + id); await closeReminder(client)
  }
  const save = async (page, editor, no) => {
    await editor.getByRole('button', { name: '填写 / 更正金蝶编号' }).click()
    await editor.getByPlaceholder('金蝶单据编号，留空可清空').fill(no ?? '')
    const response = page.waitForResponse((item) => item.request().method() === 'PATCH' && item.url().endsWith('/kingdee-registration'))
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    const result = await response; const body=await result.json(); recordArtifact({type:'registration-http',url:new URL(result.url()).pathname,status:result.status(),code:body.code,message:body.message}); assert.equal(result.status(), 200, `真实登记响应：${body.message}`)
    await editor.getByRole('button', { name: '填写 / 更正金蝶编号' }).waitFor()
    const detail = body.data
    assert.equal(detail.order.kingdeeVoucherNo, no || null); assert.equal(detail.order.isSystemApplied, true)
    assert.ok((await editor.innerText()).includes(no || '已申请待补编号'))
    return detail.order
  }
  const patchAdmin = async (id, no) => {
    const detail = await api(adminContext, 'GET', '/o2o/orders/' + id)
    return api(adminContext, 'PATCH', '/o2o/orders/' + id + '/kingdee-registration', { kingdeeVoucherNo: no, expectedKingdeeVersion: detail.order.kingdeeVersion })
  }
  // 暂停真实HTTP响应；被关闭页面取消时允许协议级取消，其他错误仍使场景失败。
  const holdNext = async (page, pattern) => {
    const reached = deferred(), release = deferred(), done = deferred(); let routeError
    await page.route(pattern, async (route) => {
      try {
        const response = await route.fetch(); assert.equal(response.status(), 200)
        reached.resolve({ data: (await response.json()).data, request: route.request().postDataJSON() })
        await release.promise
        await route.fulfill({ response })
      } catch (error) {
        if (!/closed|Invalid Interception|Invalid interception|Request is already handled|intercepted|disposed|aborted/i.test(String(error))) routeError = error
        reached.resolve({ canceled: true })
      } finally { done.resolve() }
    }, { times: 1 })
    return { reached: reached.promise, async release() { release.resolve(); await done.promise; if (routeError) throw routeError } }
  }
  const labelRead = (page) => page.waitForResponse((response) => response.url().endsWith('/products/labels') && response.request().method() === 'POST')
  const printCalls = (page) => page.evaluate(() => window.__issuePrintCalls)
  const afterPrint = (page) => page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  const settlePage = async (page) => {
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity))
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const shot = async (page, name) => { await settlePage(page); const file=path.join(evidence,name+'.png'); await page.screenshot({path:file,fullPage:true}); recordArtifact({path:file,type:'screenshot',url:new URL(page.url()).pathname}) }
  const pdfText = async (bytes) => {
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
    try { const text = []; for (let index = 1; index <= document.numPages; index += 1) text.push((await (await document.getPage(index)).getTextContent()).items.map((item) => item.str ?? '').join('')); return text.join('').replace(/\s/g, '') }
    finally { await document.destroy() }
  }
  const voucherPdf = async (page, name, expected, forbidden = []) => {
    await page.getByRole('button', { name: '正式出库单', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '正式出库单', exact: true }); await dialog.waitFor()
    for (const no of expected) assert.ok((await dialog.innerText()).includes(no), `实际凭证预览必须包含${no}`)
    for (const no of forbidden) assert.ok(!(await dialog.innerText()).includes(no), '客户端不能暴露其他来源编号')
    assert.equal(await dialog.getByPlaceholder('请输入金蝶单据编号').count(), 0, 'O2O编号应为持久值只读')
    const button = dialog.getByRole('button', { name: '打印', exact: true })
    await until(() => button.isEnabled(), Boolean, '真实凭证分页未就绪')
    const before = await printCalls(page); await button.click(); await until(() => printCalls(page), (count) => count === before + 1, '凭证没有到达真实打印handler')
    const bytes = await page.pdf({ path: path.join(evidence, name + '-print.pdf'), preferCSSPageSize: true, printBackground: true })
    const document = await PDFDocument.load(bytes); assert.ok(document.getPageCount() > 0)
    const text = await pdfText(bytes)
    recordArtifact({path:path.join(evidence,name+'-print.pdf'),type:'voucher-print-pdf',pages:document.getPageCount(),sourceNumbers:expected,forbiddenNumbers:forbidden,textChecked:true})
    for (const no of expected) assert.ok(text.includes(no), `真实打印PDF必须包含持久编号${no}`)
    for (const no of forbidden) assert.ok(!text.includes(no), '客户端PDF不能暴露其他来源')
    await afterPrint(page); await shot(page, name)
    const download = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出PDF', exact: true }).click()
    const file = await download; const filePath = path.join(evidence, name + '-export.pdf'); await file.saveAs(filePath)
    const exportPages=(await PDFDocument.load(fs.readFileSync(filePath))).getPageCount(); assert.ok(exportPages > 0, '真实生产导出PDF必须可解析');recordArtifact({path:filePath,type:'voucher-export-pdf',pages:exportPages,sourceNumbers:expected})
    await dialog.locator('.el-dialog__headerbtn').click()
  }
  const dialogLabels = (page) => page.getByRole('dialog', { name: '打印条码标签', exact: true })
  const openSelect = async (control) => { await control.focus(); await control.press('ArrowDown') }
  const selectLocation = async (page, skuIndex, code) => {
    await openSelect(page.getByRole('combobox', { name: ready.skuCodes[skuIndex] + ' 本次打印库位' }))
    await page.getByRole('option').filter({ hasText: code }).click()
  }
  const showLocation = async (page, value) => {
    const checkbox = dialogLabels(page).getByRole('checkbox', { name: '库位', exact: true })
    if (await checkbox.isChecked() !== value) await dialogLabels(page).locator('.el-checkbox').filter({ hasText: /^库位$/ }).click()
    assert.equal(await checkbox.isChecked(), value)
  }
  const copies = async (page, count) => {
    const field = dialogLabels(page).locator('.el-form-item').filter({ has: page.locator('.el-form-item__label', { hasText: '每个份数' }) }).locator('input:not([aria-label="字体大小"])')
    await field.fill(String(count)); await field.blur()
  }
  const openInventory = async (page) => {
    await page.bringToFront(); await bootstrap(adminContext, 'admin'); await page.goto(origin + '/inventory/stocks')
    for (const code of ready.skuCodes) {
      const row = page.locator('.el-table__body .el-table__row').filter({ hasText: code }); await row.waitFor()
      await row.locator('.el-checkbox').click(); assert.equal(await row.locator('input[type="checkbox"]').isChecked(), true)
    }
    const response = labelRead(page); await page.getByRole('button', { name: /打印条码（2）/ }).click()
    const read = await response; assert.equal(read.status(), 200); await dialogLabels(page).waitFor()
    return (await read.json()).data
  }
  const openHarness = async (page, kind = 'admin') => {
    await page.bringToFront(); await bootstrap(adminContext, kind)
    const response = labelRead(page); await page.goto(origin + '/scripts/issues-177-178-ui.html')
    const read = await response; assert.equal(read.status(), 200); await dialogLabels(page).waitFor()
    return (await read.json()).data
  }
  const refreshAndConfirm = async (page) => {
    const response = labelRead(page); await page.getByRole('button', { name: '刷新打印数据', exact: true }).click(); assert.equal((await response).status(), 200)
    await page.getByRole('button', { name: '确认最新数据', exact: true }).click()
  }
  const decodeSvg = async (page, selector) => {
    await page.addScriptTag({ path: path.join(root, 'node_modules/html5-qrcode/third_party/zxing-js.umd.js') })
    return page.locator(selector).evaluateAll(async (nodes) => {
      const values = []
      for (const svg of nodes) {
        const image = new Image(); const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = source })
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(image.naturalWidth * 3); canvas.height = Math.ceil(image.naturalHeight * 3)
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)))
        const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_128]]])
        values.push(new ZXing.MultiFormatReader().decode(bitmap, hints).getText())
      }
      return values
    })
  }
  try {
    await bootstrap(adminContext, 'admin')
    await scenario('KD1', '真实商城→checkout：已申请必填、未申请红字可下单、编号持久保存', '整页/真实HTTP', async () => {
      await bootstrap(clientContext, 'client')
      for (const applied of [true, false]) {
        await client.goto(origin + '/client/mall'); await closeReminder(client)
        await client.locator('.client-product-card__body').filter({ hasText: ready.commerceProductName }).first().click()
        await client.locator('.client-detail-panel').getByRole('button', { name: '甲', exact: true }).click()
        await client.getByRole('button', { name: '加入购物车', exact: true }).click()
        await client.locator('.client-detail-panel').waitFor({state:'hidden'})
        await client.getByRole('button', { name: '去结算', exact: true }).click()
        await client.getByPlaceholder('请输入实际领取教师姓名').fill('隔离教师')
        await client.locator('.pickup-date-option').last().click()
        await openSelect(client.getByRole('combobox', { name: '到店时段', exact: true })); await client.getByRole('option').first().click()
        await client.getByRole('radio', { name: '已申请', exact: true }).check({ force: true })
        if (process.env.YLINK_ISSUES_KD1_VISUAL_ONLY === 'true') {
          if (!applied) await client.getByRole('radio', { name: '未申请', exact: true }).check({ force: true })
          const drawer=client.locator('.el-drawer:visible')
          const target=applied?drawer.getByPlaceholder('请输入金蝶单据编号'):drawer.getByText('请及时在金蝶申请并填写金蝶单据编号',{exact:true})
          await target.waitFor();await target.scrollIntoViewIfNeeded();await settlePage(client)
          const file=path.join(evidence,applied?'checkout-applied-before-post.png':'checkout-unapplied-before-post.png')
          await drawer.screenshot({path:file});recordArtifact({path:file,type:'checkout-before-post-screenshot',url:new URL(client.url()).pathname,applied,behaviorEvidenceReused:'attempt-05/KD1',postSent:false})
          continue
        }
        const button = client.getByRole('button', { name: '提交预订单', exact: true })
        let submits = 0; const count = (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/o2o/mall/preorders') submits += 1 }
        client.on('request', count)
        try {
          if (await button.isEnabled()) await button.click()
          assert.equal(submits, 0, '已申请空编号不能发送下单请求')
          if (applied) await client.getByPlaceholder('请输入金蝶单据编号').fill('KD-CHECKOUT-177')
          else {
            await client.getByRole('radio', { name: '未申请', exact: true }).check({ force: true })
            const warning = client.locator('.el-drawer:visible').getByText('请及时在金蝶申请并填写金蝶单据编号', { exact: true })
            await warning.waitFor(); assert.ok(await warning.isVisible())
            const color = await warning.evaluate((node) => getComputedStyle(node).color.match(/\d+/g).map(Number)); assert.ok(color[0] > color[1] && color[0] > color[2], '提示须为红色')
          }
          const saved = client.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/o2o/mall/preorders')
          await button.click(); const response = await saved; assert.equal(response.status(), 200)
          const detail = (await response.json()).data
          assert.equal(detail.order.kingdeeVoucherNo, applied ? 'KD-CHECKOUT-177' : null)
          assert.equal((await readClient(detail.order.id)).order.kingdeeVoucherNo, detail.order.kingdeeVoucherNo)
          await client.locator(editorSelector).waitFor(); await client.getByText(detail.order.preorderNo,{exact:true}).first().waitFor()
          await shot(client, applied ? 'checkout-applied' : 'checkout-unapplied')
        } finally { client.off('request', count) }
      }
    })
    await scenario('KD2', 'pending与跨天verified：登记、替换、清空及待办移除/恢复', '整页/真实HTTP', async () => {
      for (const [id, prefix] of [[ready.preorderId, 'KD-PENDING'], [ready.verifiedId, 'KD-VERIFIED']]) {
        await visitClient(id)
        const initial = await readClient(id)
        if (id === ready.verifiedId) { assert.equal(initial.order.status, 'verified'); assert.ok(new Date(initial.order.timeoutAt).getTime() < Date.now() - 12 * 60 * 60_000) }
        let previous = initial.order.kingdeeVersion
        for (const no of [prefix + '-A', prefix + '-B', null]) {
          const result = await save(client, client.locator(editorSelector), no)
          assert.equal(result.kingdeeVersion, previous + 1); previous = result.kingdeeVersion
          assert.equal(result.status, id === ready.verifiedId ? 'verified' : 'pending')
          const todos = await (await clientContext.request.get(origin + '/api/o2o/mall/preorders/kingdee-todos?pageSize=50')).json()
          assert.equal(todos.data.list.some((row) => row.id === id), !no)
        }
      }
      await shot(client, 'verified-cross-day-cleared')
    })
    await scenario('KD3', '提醒关闭/普通路由/新打开、失败重试与退出换号迟到请求', '整页/真实会话/传输边界', async () => {
      await visitClient(ready.preorderId)
      await client.locator('a[href="/client/orders"]').click(); assert.equal(await reminder(client).isVisible(), false, '普通路由不能重弹')
      await client.reload(); await reminder(client).waitFor(); assert.ok((await reminder(client).innerText()).includes(ready.verifiedNo), '已核销历史单应进入提醒')
      await closeReminder(client)
      await client.route('**/api/o2o/mall/preorders/kingdee-todos?*', (route) => route.abort('failed'), { times: 1 })
      await client.reload(); await reminder(client).getByRole('alert').waitFor()
      const retried = client.waitForResponse((response) => response.url().includes('/kingdee-todos'))
      await reminder(client).getByRole('button', { name: '重试', exact: true }).click(); assert.equal((await retried).status(), 200)
      await until(() => reminder(client).innerText(), (text) => text.includes(ready.verifiedNo) && !text.includes('读取失败'), '真实重试没有恢复待办')
      await closeReminder(client)
      const held = await holdNext(client, '**/api/o2o/mall/preorders/kingdee-todos?*')
      await client.reload(); await held.reached
      await client.getByRole('button', { name: '退出', exact: true }).click()
      await client.getByRole('dialog', { name: '退出登录', exact: true }).getByRole('button', { name: '退出', exact: true }).click()
      await client.waitForURL('**/client/login**')
      await bootstrap(clientContext, 'other'); await client.goto(origin + '/client/orders/' + ready.otherSourceId)
      await held.release()
      assert.ok(!(await client.locator('body').innerText()).includes(ready.preorderNo), '旧账号迟到待办不能串号')
      assert.equal((await clientContext.request.get(origin + '/api/o2o/mall/preorders/' + ready.preorderId)).status(), 404)
      await shot(client, 'reminder-account-isolation')
    })
    await scenario('KD4', '管理端O2O四字段摘要及正式单轮询：true不变时替换/清空、草稿与旧GET', '整页/真实HTTP/真实轮询', async () => {
      await patchAdmin(ready.preorderId,'KD-INITIAL-TRUE')
      await admin.bringToFront(); await admin.goto(origin + '/o2o-console/orders')
      await admin.getByPlaceholder('搜索订单号、核销码、用户名或商品').fill(ready.preorderNo)
      await admin.getByPlaceholder('搜索订单号、核销码、用户名或商品').press('Enter')
      const card = admin.locator(`[data-order-pool-card-id="${ready.preorderId}"]`); await card.getByRole('button').first().click()
      await admin.locator('.el-collapse-item__header').filter({hasText:'合规状态确认'}).click()
      const editor = admin.locator(editorSelector)
      for (const no of ['KD-ADMIN-A', 'KD-ADMIN-B', null]) {
        const order = await save(admin, editor, no)
        await until(() => card.getAttribute('data-kingdee-version'), (value) => value === String(order.kingdeeVersion), '详情未同步摘要独立版本')
        assert.equal(await card.getAttribute('data-kingdee-no'), no ?? '')
        assert.equal(await card.getAttribute('data-kingdee-status'), no ? 'registered' : 'applied_pending')
        assert.equal(await card.getAttribute('data-kingdee-editable'), 'true')
      }
      // 暂停生产轮询的旧GET；保存仍走CAS，随后迟到旧结果不得回退成功视图。
      const held = await holdNext(admin, `**/api/o2o/orders/${ready.preorderId}`)
      await editor.getByRole('button', { name: '填写 / 更正金蝶编号' }).click()
      await editor.getByPlaceholder('金蝶单据编号，留空可清空').fill('KD-DRAFT-KEEP')
      const oldRead = await held.reached; assert.ok(oldRead.data?.order, '须暂停真实旧详情而非合成响应')
      assert.equal(await editor.getByPlaceholder('金蝶单据编号，留空可清空').inputValue(), 'KD-DRAFT-KEEP')
      const saved = admin.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/kingdee-registration'))
      await editor.getByRole('button', { name: '保存', exact: true }).click(); const result = await saved; assert.equal(result.status(), 200)
      const latest = (await result.json()).data.order; await held.release()
      await until(() => editor.innerText(), (text) => text.includes('KD-DRAFT-KEEP'), '旧GET回退了登记视图')
      await until(() => card.getAttribute('data-kingdee-version'), (version) => version === String(latest.kingdeeVersion), '保存后摘要版本不能被迟到GET回退')
      await patchAdmin(ready.verifiedId, 'KD-POLL-A')
      await admin.goto(origin + '/order-list')
      await admin.getByPlaceholder('输入业务单号/客户/部门/出单人关键词').fill(ready.verifiedBusinessNo)
      await admin.getByRole('button', { name: '搜索', exact: true }).click()
      const row = admin.locator('.el-table__body .el-table__row').filter({ hasText: ready.verifiedBusinessNo }); await row.getByRole('button', { name: '详情', exact: true }).click()
      const drawer = admin.locator('.el-drawer:visible').filter({hasText:'单据详情'})
      await until(() => drawer.innerText(), (text) => text.includes('KD-POLL-A'), '正式单未展示来源登记')
      for (const no of ['KD-POLL-B', null]) {
        await patchAdmin(ready.verifiedId, no)
        await until(() => drawer.innerText(), (text) => no ? text.includes(no) : text.includes('已申请待补编号') && !text.includes('KD-POLL-B'), '正式单轮询未同步同布尔登记变更')
        assert.ok((await row.innerText()).includes(no ? '已登记' : '已申请待补编号'))
      }
      await shot(admin, 'admin-same-flag-poll')
    })
    await scenario('KD5', '合并逐来源本人隔离、管理端/客户端凭证与真实打印及导出PDF', '整页/真实HTTP/真实PDF', async () => {
      const parent = await api(adminContext, 'GET', '/orders/' + ready.mergeParentId)
      assert.deepEqual(new Set(parent.order.sourcePreorderRegistrations.map((source) => source.kingdeeVoucherNo)), new Set(['KD-SELF-177', 'KD-OTHER-178']))
      await visitClient(ready.ownSourceId)
      const own = await readClient(ready.ownSourceId); assert.ok(!JSON.stringify(own).includes('KD-OTHER-178')); assert.ok(!JSON.stringify(own).includes('systemNo'))
      assert.equal((await clientContext.request.get(origin + '/api/o2o/mall/preorders/' + ready.otherSourceId)).status(), 404)
      const forbiddenCookie = (await clientContext.cookies(origin)).find((item) => item.name === 'y_link_client_csrf')
      const denied = await clientContext.request.patch(origin + '/api/o2o/mall/preorders/' + ready.otherSourceId + '/kingdee-registration', { data: { kingdeeVoucherNo: '越权', expectedKingdeeVersion: 2 }, headers: { origin, 'x-client-csrf-token': decodeURIComponent(forbiddenCookie.value) } }); assert.equal(denied.status(), 404)
      await voucherPdf(client, 'voucher-client-self', ['KD-SELF-177'], ['KD-OTHER-178'])
      await admin.goto(origin + '/order-list')
      await admin.getByPlaceholder('输入业务单号/客户/部门/出单人关键词').fill(ready.mergeBusinessNo); await admin.getByRole('button', { name: '搜索', exact: true }).click()
      await admin.locator('.el-table__body .el-table__row').filter({ hasText: ready.mergeBusinessNo }).getByRole('button', { name: '详情', exact: true }).click()
      await voucherPdf(admin, 'voucher-admin-merged', ['KD-SELF-177', 'KD-OTHER-178'])
      // 报表默认勾选来自真实页面，查询/预览/导出必须一致；旧合法字段仍由服务专项覆盖。
      await admin.goto(origin + '/reports'); await openSelect(admin.getByRole('combobox', { name: '选择报表', exact: true }))
      const query = admin.waitForResponse((response) => new URL(response.url()).pathname === '/api/reports/kingdee')
      await admin.getByRole('option', { name: '金蝶汇总表', exact: true }).click()
      const response = await query; assert.equal(response.status(), 200)
      const report = (await response.json()).data; assert.ok(report.fields.some((field) => field.key === 'kingdeeVoucherNo')); assert.ok(report.fields.some((field) => field.key === 'kingdeeStatus')); assert.ok(!report.fields.some((field) => field.key === 'isSystemApplied'))
      assert.ok((await admin.locator('body').innerText()).includes('KD-SELF-177'))
      await admin.getByRole('button', { name: '导出 Excel', exact: true }).click()
      const preview = admin.getByRole('dialog', { name: '导出预览', exact: true }); assert.ok((await preview.innerText()).includes('金蝶单据编号'))
      const downloaded = admin.waitForEvent('download'); await preview.getByRole('button', { name: '确认导出 Excel', exact: true }).click()
      const file = await downloaded; const excelPath = path.join(evidence, 'kingdee-real-default.xlsx'); await file.saveAs(excelPath)
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(excelPath)
      const exportedText = JSON.stringify(workbook.worksheets[0].getSheetValues())
      for (const field of report.fields) assert.ok(exportedText.includes(field.label), '实际页面默认字段必须出现在导出表头')
      for (const no of ['KD-SELF-177', 'KD-OTHER-178']) assert.ok(exportedText.includes(no), '导出必须按明细来源使用真实登记值')
      assert.deepEqual(new URL(response.url()).searchParams.get('fields').split(','), report.fields.map((field) => field.key))
    })
    await scenario('PDF', 'E-PDF修复：真实客户端/管理端导出与打印两联，视觉渲染另行核验', '整页/真实PDF/导出测量样式清理', async () => {
      await visitClient(ready.ownSourceId)
      await voucherPdf(client, 'voucher-client-self', ['KD-SELF-177'], ['KD-OTHER-178'])
      await admin.goto(origin + '/order-list')
      await admin.getByPlaceholder('输入业务单号/客户/部门/出单人关键词').fill(ready.mergeBusinessNo); await admin.getByRole('button', { name: '搜索', exact: true }).click()
      await admin.locator('.el-table__body .el-table__row').filter({ hasText: ready.mergeBusinessNo }).getByRole('button', { name: '详情', exact: true }).click()
      await voucherPdf(admin, 'voucher-admin-merged', ['KD-SELF-177', 'KD-OTHER-178'])
      for (const page of [client, admin]) assert.equal(await page.locator('style[data-voucher-pdf-font-metrics]').count(), 0, '成功导出后必须清理临时字体测量样式')
    })
    await scenario('BC1', '真实库存入口整合：main0、停用过滤、逐SKU选择、份数/显示开关和新批次重置', '库存整页/真实labels API', async () => {
      const labels = await openInventory(admin)
      for (const label of labels) {
        assert.equal(label.printLocations.capability, 'full'); assert.equal(label.locationCode, 'UI-MAIN')
        assert.equal(label.printLocations.options.find((option) => option.isMain).qty, 0)
        assert.ok(!label.printLocations.options.some((option) => option.locationCode.includes('UI-OFF')))
      }
      await openSelect(admin.getByRole('combobox', { name: ready.skuCodes[0] + ' 本次打印库位' }))
      assert.ok(await admin.getByRole('option').filter({ hasText: '主库位 · UI-MAIN · 0 件' }).count() > 0)
      assert.equal(await admin.getByRole('option').filter({ hasText: 'UI-OFF' }).count(), 0)
      await admin.getByRole('option').filter({ hasText: 'UI-OTHER' }).click()
      assert.ok((await admin.getByRole('combobox', { name: ready.skuCodes[1] + ' 本次打印库位' }).evaluate((input) => input.closest('.el-select').textContent)).includes('UI-MAIN'))
      await copies(admin, 2); assert.ok((await dialogLabels(admin).innerText()).includes('打印 4 张标签'))
      await showLocation(admin, true)
      const preview = dialogLabels(admin).locator('.barcode-label--preview'); assert.ok((await preview.first().innerText()).includes('UI-OTHER'))
      await showLocation(admin, false); assert.ok(!(await preview.first().innerText()).includes('UI-OTHER'))
      await dialogLabels(admin).locator('.el-dialog__headerbtn').click()
      await openInventory(admin)
      for (const code of ready.skuCodes) assert.ok((await admin.getByRole('combobox', { name: code + ' 本次打印库位' }).evaluate((input) => input.closest('.el-select').textContent)).includes('UI-MAIN'))
      await shot(admin, 'inventory-labels-real-entry')
    })
    await scenario('BC2', '真实前检：过滤分布/库存/能力变化和失败均中止，main_only无泄漏且不比较完整分布', '实际API/传输失败/局部宿主', async () => {
      await openHarness(admin); await showLocation(admin, true)
      const mutationContext = await makeContext(); await bootstrap(mutationContext, 'admin')
      for (const change of ['filtered', 'stock', 'capability', 'failure']) {
        if (change === 'filtered') await api(mutationContext, 'PUT', '/inventory/locations/' + ready.disabledId, { locationCode: 'UI-OFF-RENAMED', isActive: false })
        if (change === 'stock') await api(mutationContext, 'POST', `/inventory/locations/${ready.mainId}/skus/${ready.skuIds[0]}/transfer`, { fromLocationId: String(ready.extraId), qty: 1, expectedFromQty: 15, expectedMainLocationId: String(ready.mainId) })
        if (change === 'capability') await bootstrap(adminContext, 'supplier')
        if (change === 'failure') await admin.route('**/api/products/labels', (route) => route.abort('failed'), { times: 1 })
        const before = await printCalls(admin); await dialogLabels(admin).getByRole('button', { name: '打印', exact: true }).click()
        await admin.getByRole('button', { name: '刷新打印数据', exact: true }).waitFor(); assert.equal(await printCalls(admin), before)
        await refreshAndConfirm(admin); assert.equal(await printCalls(admin), before, '刷新/确认不能自动续打')
      }
      const limited = await (await adminContext.request.post(origin + '/api/products/labels', { data: { skuIds: ready.skuIds }, headers: { origin, 'x-csrf-token': decodeURIComponent((await adminContext.cookies(origin)).find((cookie) => cookie.name === 'y_link_admin_csrf').value) } })).json()
      for (const label of limited.data) { assert.equal(label.printLocations.capability, 'main_only'); assert.ok(!('distributionKey' in label.printLocations)); for (const option of label.printLocations.options) { assert.ok(!('qty' in option)); assert.equal(option.isMain, true) } }
      // 保持真实主库位元数据和标签基础不变，只改变被过滤的其他库位元数据；main_only应允许。
      await api(mutationContext, 'PUT', '/inventory/locations/' + ready.disabledId, { locationCode: 'UI-OFF-MAIN-ONLY', isActive: false })
      const before = await printCalls(admin); await dialogLabels(admin).getByRole('button', { name: '打印', exact: true }).click()
      await until(() => printCalls(admin), (value) => value === before + 1, 'main_only不应因其他库位变化阻断')
      await afterPrint(admin)
      await admin.setViewportSize({ width: 390, height: 844 }); await shot(admin, 'labels-main-only-mobile'); await admin.setViewportSize({ width: 1440, height: 960 })
      await bootstrap(adminContext, 'admin')
      await api(mutationContext, 'POST', `/inventory/locations/${ready.extraId}/skus/${ready.skuIds[0]}/transfer`, { fromLocationId: String(ready.mainId), qty: 1, expectedFromQty: 1, expectedMainLocationId: String(ready.mainId) })
      await mutationContext.close()
    })
    await scenario('BC3', '重复点击/迟到响应/关闭/卸载/批次变化：禁止旧会话续打', '局部公开props宿主/真实API响应暂停', async () => {
      for (const action of ['duplicate', 'close', 'unmount', 'batch']) {
        await openHarness(admin)
        const held = await holdNext(admin, '**/api/products/labels')
        await dialogLabels(admin).getByRole('button', { name: '打印', exact: true }).click()
        await held.reached
        if (action === 'duplicate') {
          const disabled = await dialogLabels(admin).getByRole('button', { name: /打印/, exact: false }).last().isDisabled(); assert.equal(disabled, true)
          // 浏览器原生dblclick触发同一公开按钮，禁用期间不能第二次读取/打印。
          await dialogLabels(admin).getByRole('button', { name: /打印/, exact: false }).last().evaluate((button) => button.click())
        } else if (action === 'close') await dialogLabels(admin).locator('.el-dialog__headerbtn').click()
        else if (action === 'unmount') await admin.getByRole('button', { name: '卸载组件', exact: true }).evaluate((button) => button.click())
        else await admin.getByRole('button', { name: '新批次', exact: true }).evaluate((button) => button.click())
        await held.release()
        recordArtifact({ type: 'barcode-race', action, printCalls: await printCalls(admin) })
        if (action === 'duplicate') { await until(() => printCalls(admin), (value) => value === 1, '首次前检应只打印一次'); await afterPrint(admin) }
        else { await admin.waitForTimeout(500); assert.equal(await printCalls(admin), 0, `旧响应不能在${action}后打印`) }
      }
      // 初始加载迟到与新批次：真实旧API响应不能覆盖新批次默认主选择。
      const held = await holdNext(admin, '**/api/products/labels')
      await admin.goto(origin + '/scripts/issues-177-178-ui.html'); await held.reached
      const newBatch = labelRead(admin); await admin.getByRole('button', { name: '新批次', exact: true }).evaluate((button) => button.click()); assert.equal((await newBatch).status(), 200); await held.release()
      await admin.getByRole('combobox', { name: ready.skuCodes[1] + ' 本次打印库位' }).waitFor()
      assert.equal(await admin.getByRole('combobox', { name: ready.skuCodes[0] + ' 本次打印库位' }).count(), 0)
      assert.equal(await printCalls(admin), 0)
    })
    await scenario('BC4', '真实库存入口四模板：冻结设置/SVG/选择，Chromium打印PDF及独立Code128解码', '库存整页/真实PDF/ZXing像素解码', async () => {
      for (const template of ['thermal', 'a4', 'yz-full', 'yz-compact']) {
        const labels = await openInventory(admin)
        await admin.locator('.el-radio-button').filter({ has: admin.locator(`input[type="radio"][value="${template}"]`) }).click()
        await selectLocation(admin, 0, 'UI-OTHER'); await copies(admin, 2)
        await showLocation(admin, true)
        const response = labelRead(admin); await dialogLabels(admin).getByRole('button', { name: '打印', exact: true }).click(); assert.equal((await response).status(), 200)
        await until(() => printCalls(admin), (value) => value === 1, '真实打印前检未完成')
        const printRoot = admin.locator('.barcode-label-print-root'); const frozen = await printRoot.innerHTML()
        assert.equal(await printRoot.locator('svg').count(), ready.skuIds.length * 2)
        assert.ok((await printRoot.innerText()).includes('UI-OTHER')); assert.ok((await printRoot.innerText()).includes('UI-MAIN'))
        assert.equal(await dialogLabels(admin).getByRole('checkbox', { name: '库位', exact: true }).isDisabled(), true)
        assert.equal(await admin.getByRole('combobox', { name: ready.skuCodes[0] + ' 本次打印库位' }).isEnabled(), false)
        const values = await decodeSvg(admin, '.barcode-label-print-root svg')
        assert.deepEqual(new Set(values), new Set(labels.map((label) => ['yz-full', 'yz-compact'].includes(template) ? label.skuCode : label.barcode || label.skuCode)), '切换库位不能改变模板默认条码来源')
        assert.equal(await printRoot.innerHTML(), frozen, 'PDF准备前设置/选择/SVG快照必须保持一致')
        const bytes = await admin.pdf({ path: path.join(evidence, `labels-${template}.pdf`), preferCSSPageSize: true, printBackground: true })
        const document = await PDFDocument.load(bytes); assert.equal(document.getPageCount(), template === 'a4' ? 1 : ready.skuIds.length * 2)
        recordArtifact({path:path.join(evidence,`labels-${template}.pdf`),type:'barcode-pdf',template,pages:document.getPageCount(),labelCount:values.length,decodedCode128:values,locationSelection:['UI-OTHER','UI-MAIN']})
        // Chromium真实PDF输出会触发afterprint；此时应释放快照，不能再要求已释放DOM仍存在。
        await printRoot.waitFor({ state: 'detached' })
        recordArtifact({ type: 'barcode-freeze', template, unchangedBeforePdf: true, controlsDisabled: true, afterPrintCleared: true })
        await shot(admin, 'labels-' + template); await afterPrint(admin)
      }
    })
    assert.deepEqual(pageErrors, [], '真实页面不得存在未处理脚本异常')
  } catch(error) { for(const [index,context] of contexts.entries()) for(const [pageIndex,page] of context.pages().entries()) { if(!page.isClosed()) await page.screenshot({path:path.join(evidence,`failure-${index}-${pageIndex}.png`),fullPage:true}).catch(()=>{}) } throw error } finally { for (const context of contexts) await context.close() }
}
