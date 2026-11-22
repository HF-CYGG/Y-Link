/**
 * 文件职责：在本批独立SQLite验证ExcelJS不参与启动导入、模块并发/失败重试与8个真实文件操作。
 * 维护说明：使用真实ExcelJS读写与流式Writer，不返回假工作簿；只包装真实构造器记录实例，不连接业务库。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { createServer, get as getHttp } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import ts from 'typescript'

const task = path.resolve('../.tmp-restock-implementation/performance-convergence')
const runtimeDir = path.join(task, 'exceljs-runtime', `${Date.now()}-${randomBytes(4).toString('hex')}`)
fs.mkdirSync(runtimeDir, { recursive: true })
const password = `Excel_${randomBytes(12).toString('hex')}_Aa7!`
Object.assign(process.env, { DB_TYPE: 'sqlite', DB_SYNC: 'true', DB_AUTO_MIGRATE: 'false', SQLITE_DB_PATH: path.join(runtimeDir, 'exceljs.sqlite'),
  Y_LINK_DATA_DIR: runtimeDir, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', APP_PROFILE: 'performance-exceljs-verify', INIT_ADMIN_PASSWORD: password,
  Y_LINK_MAX_CONCURRENT_EXPORTS: '2' })
const require = createRequire(import.meta.url)
const excelLoaded = () => Object.keys(require.cache).some((file) => /[\\/]exceljs[\\/]/.test(file))
assert.equal(excelLoaded(), false)
const { AppDataSource: db } = await import('../src/config/data-source.js')
const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { authService } = await import('../src/services/auth.service.js')
const { productService } = await import('../src/services/product.service.js')
const { productExcelService } = await import('../src/services/product-excel.service.js')
const { productImportYzService } = await import('../src/services/product-import-yz.service.js')
const { clientStaffDirectoryService } = await import('../src/services/client-staff-directory.service.js')
const { inventoryQueryService } = await import('../src/services/inventory-query.service.js')
const { reportService } = await import('../src/services/report.service.js')
const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { dataExportLeasePool } = await import('../src/utils/export-lease-pool.js')
const { bufferXlsxExport, writeStreamingXlsx } = await import('../src/utils/xlsx-export.js')
const { createApp } = await import('../src/app.js')
assert.equal(excelLoaded(), false, '真实应用/全部五服务导入不得预载ExcelJS')
prepareDatabaseRuntime(); await db.initialize(); await initializeDatabaseSchemaIfNeeded(db)
const operations: string[] = []

async function within<T>(work: Promise<T>, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Excel 验证等待超时：${step}`)), 10_000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function blockDownload() {
  const chunks: Buffer[] = []
  let releaseWrite: (() => void) | undefined
  let resolveStarted!: () => void
  let paused = true
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk)
      if (paused) releaseWrite = callback
      else callback()
      resolveStarted()
    },
  })
  return {
    output,
    started,
    bytes: () => Buffer.concat(chunks),
    resume() {
      paused = false
      releaseWrite?.()
    },
  }
}

try {
  await authService.ensureDefaultAdmin()
  const login = await authService.login({ username: 'admin', password })
  assert.ok(!login.mfaRequired)
  const actor = await authService.resolveAuthUserByToken(login.token)
  const product = await productService.create({ productName: '性能收敛导出商品', defaultPrice: 12, currentStock: 5, isActive: true, o2oStatus: 'listed' }, actor)
  assert.equal(excelLoaded(), false, '真实初始化/账号/商品操作完成后仍不需ExcelJS')
  const { loadExcelJs } = await import('../src/utils/exceljs-loader.js')
  const first = loadExcelJs(), second = loadExcelJs()
  assert.equal(first, second, '并发首次加载共享同一Promise')
  const ExcelJS = await first
  assert.equal(await second, ExcelJS)
  assert.ok(excelLoaded())

  // 只对真实loader源做受控首次加载异常；第二次返回真实ExcelJS，验证应用Promise重置而非假工作簿。
  const loaderSource = fs.readFileSync(path.resolve('src/utils/exceljs-loader.ts'), 'utf8')
  const compiled = ts.transpileModule(loaderSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const exported: any = {}; let imports = 0
  vm.runInNewContext(compiled, { exports: exported, require: (name: string) => {
    assert.equal(name, 'exceljs'); imports += 1
    if (imports === 1) throw new Error('受控首次模块加载失败')
    return { __esModule: true, default: ExcelJS }
  } })
  const failed = exported.loadExcelJs()
  assert.equal(failed, exported.loadExcelJs())
  await assert.rejects(failed, /受控首次模块加载失败/)
  const recovered = exported.loadExcelJs()
  assert.notEqual(recovered, failed)
  assert.equal(await recovered, ExcelJS)
  assert.equal(imports, 2)

  const Workbook = ExcelJS.Workbook, Writer = ExcelJS.stream.xlsx.WorkbookWriter
  const instances: unknown[] = []
  const descriptor = Object.getOwnPropertyDescriptor(ExcelJS, 'Workbook')!
  const writerDescriptor = Object.getOwnPropertyDescriptor(ExcelJS.stream.xlsx, 'WorkbookWriter')!
  Object.defineProperty(ExcelJS, 'Workbook', { ...descriptor, value: new Proxy(Workbook, { construct(Target, args) { const instance = Reflect.construct(Target, args); instances.push(instance); return instance } }) })
  Object.defineProperty(ExcelJS.stream.xlsx, 'WorkbookWriter', { ...writerDescriptor, value: new Proxy(Writer, { construct(Target, args) { const instance = Reflect.construct(Target, args); instances.push(instance); return instance } }) })
  const readBook = async (buffer: Buffer) => { assert.equal(buffer.subarray(0, 2).toString(), 'PK'); const book = new Workbook(); await book.xlsx.load(buffer as never); return book }
  try {
    const template = await productExcelService.buildTemplate()
    const templateBook = await readBook(template)
    assert.equal(templateBook.worksheets[0]!.getCell('A1').value, '商品名称*')
    assert.equal(templateBook.worksheets[0]!.getColumn(4).numFmt, '@')
    operations.push('product.buildTemplate')
    const productRows = await productExcelService.parseWorkbook(template)
    assert.ok(productRows.some((row) => row.productName === '星空贴纸'))
    operations.push('product.parseWorkbook')
    const exportedProducts = await productExcelService.exportProductsWithSummary()
    const productBook = await readBook(exportedProducts.buffer)
    assert.ok(exportedProducts.rowCount > 0)
    assert.ok(JSON.stringify(productBook.worksheets[0]!.getSheetValues()).includes('性能收敛导出商品'))
    operations.push('product.exportProductsWithSummary')
    const yzTemplate = await productImportYzService.buildTemplate()
    const yzBook = await readBook(yzTemplate)
    assert.equal(yzBook.worksheets[0]!.getCell('A7').value, '大汶口', '合并单元格与格式保持真实模板')
    operations.push('yz.buildTemplate')
    const yzRows = await (productImportYzService as any).parseWorkbook(yzTemplate)
    assert.ok(yzRows.some((row: any) => row.productName === '联名冰箱贴'))
    operations.push('yz.parseWorkbook')
    const staffInput = new Workbook(), sheet = staffInput.addWorksheet('名单')
    sheet.addRow(['姓名', '工号', '部门']); sheet.addRow(['性能员工', '000123', '测试部门'])
    const staffRows = await (clientStaffDirectoryService as any).parseWorkbookRows(Buffer.from(await staffInput.xlsx.writeBuffer()))
    assert.equal(staffRows.length, 1); assert.equal(staffRows[0].realName, '性能员工'); assert.equal(staffRows[0].staffNo, '000123')
    operations.push('staff.parseWorkbookRows')
    const sku = await db.getRepository(BaseProductSku).findOneByOrFail({ productId: product.id, isCurrent: true })
    await db.getRepository(InventoryLog).save({ productId: product.id, skuId: sku.id, changeType: 'inbound', changeQty: 5, beforeCurrentStock: 0, afterCurrentStock: 5,
      beforePreorderedStock: 0, afterPreorderedStock: 0, beforeSkuCurrentStock: 0, afterSkuCurrentStock: 5, operatorType: 'system', remark: '性能文件导出夹具' })
    const inventoryExport = await inventoryQueryService.exportLogsWithSummary({ productId: String(product.id) })
    assert.ok(inventoryExport.rowCount > 0)
    const inventoryBook = await readBook(inventoryExport.buffer)
    assert.ok(JSON.stringify(inventoryBook.worksheets[0]!.getSheetValues()).includes('性能收敛导出商品'))
    operations.push('inventory.exportLogsWithSummary')
    const stream = new PassThrough(), chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    const ended = new Promise<void>((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject) })
    let ready = false
    const report = await reportService.exportExcel('inventory', {}, stream, () => { ready = true }, actor.userId)
    await ended
    assert.equal(ready, true); assert.ok(report.rowCount > 0)
    const reportBook = await readBook(Buffer.concat(chunks))
    assert.ok(JSON.stringify(reportBook.worksheets[0]!.getSheetValues()).includes('性能收敛导出商品'))
    operations.push('report.exportExcel')
    assert.equal(operations.length, 8)
    const [againA, againB] = await Promise.all([productExcelService.buildTemplate(), productExcelService.buildTemplate()])
    assert.ok(againA.length > 0 && againB.length > 0)
    assert.equal(new Set(instances).size, 10, '八个真实操作与两个并发模板各自创建独立Workbook/Writer')
    assert.equal(instances.length, 10)
    const validOperationInstances = instances.length
    await assert.rejects(productExcelService.parseWorkbook(Buffer.from('not-a-zip')), /Excel|文件|格式|XLSX|压缩/i)
    assert.equal(instances.length, validOperationInstances, '非法ZIP在现有安全预检处拒绝，不进入Workbook建模')

    // 第一页有一个大规格矩阵，多个 SKU 的 sortOrder 相同，后续还有足够商品跨越商品主键页。
    await db.query(
      `INSERT INTO base_product_sku (product_id, sku_code, is_current, sort_order, is_active, cost_price)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 506)
       SELECT ?, 'XL-SKU-' || n, n < 506, n % 3, n % 2, 3.25 FROM seq`,
      [product.id],
    )
    await db.query(
      `INSERT INTO base_product (product_code, product_name, is_active)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 42)
       SELECT 'XL-PAGE-' || n, '导出跨页商品 ' || n, 1 FROM seq`,
    )
    await db.query(
      `INSERT INTO base_product_sku (product_id, sku_code)
       SELECT id, product_code || '-SKU' FROM base_product WHERE product_code LIKE 'XL-PAGE-%'`,
    )
    // SQL 整数字面量绕过 JS Number，确保两个相邻 ID 实际落在 SQLite 64 位精度范围。
    await db.query(
      `INSERT INTO base_product_sku (id, product_id, sku_code, sort_order)
       VALUES (9007199254740992, ?, 'XL-SKU-64A', 10), (9007199254740993, ?, 'XL-SKU-64B', 10)`,
      [product.id, product.id],
    )
    const expectedSkus: { skuCode: string }[] = await db.query(
      'SELECT sku_code AS skuCode FROM base_product_sku WHERE is_current = 1 ORDER BY product_id, sort_order, id',
    )
    const productDownload = blockDownload()
    const streamedProductsPromise = productExcelService.exportProductsToStream({ includeCostPrice: false }, productDownload.output)
    void streamedProductsPromise.catch(() => undefined)
    try {
      await within(productDownload.started, '商品导出开始并阻塞输出')
      await db.query('UPDATE base_product_sku SET sort_order = 100000 WHERE sku_code = ?', [expectedSkus[0]!.skuCode])
      await db.query("INSERT INTO base_product (product_code, product_name, is_active) VALUES ('XL-LATE', '下载中新建商品', 1)")
      await db.query("INSERT INTO base_product_sku (product_id, sku_code) SELECT id, 'XL-LATE-SKU' FROM base_product WHERE product_code = 'XL-LATE'")
      productDownload.resume()
      const streamedProducts = await within(streamedProductsPromise, '商品导出恢复')
      assert.equal(streamedProducts.rowCount, expectedSkus.length)
    } finally {
      productDownload.output.destroy()
    }
    const productSheet = (await readBook(productDownload.bytes())).getWorksheet('商品SKU')!
    assert.equal(productSheet.getCell('I1').value, '售价', '无成本权限时完整移除成本价列')
    assert.equal(productSheet.getCell('A1').font.bold, true)
    assert.ok(expectedSkus.some((row) => row.skuCode === 'XL-SKU-64A') && expectedSkus.some((row) => row.skuCode === 'XL-SKU-64B'))
    assert.deepEqual(expectedSkus.map((row) => row.skuCode), expectedSkus.map((_, index) => productSheet.getCell(`F${index + 2}`).value))

    await db.query(
      `INSERT INTO inventory_log (id, product_id, sku_id, change_type, change_qty, before_sku_current_stock, after_sku_current_stock, ref_type, ref_id, remark, created_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 505)
       SELECT 9007199254740987 + n, ?, 9007199254740993, 'inbound', n, 3, 8, 'verify-xlsx', n, '=1+1', '2024-03-02 14:12:13' FROM seq`,
      [product.id],
    )
    const inventoryBoundary: { id: string }[] = await db.query("SELECT CAST(id AS TEXT) AS id FROM inventory_log WHERE ref_type = 'verify-xlsx' AND change_qty = 6")
    assert.equal(inventoryBoundary[0]?.id, '9007199254740993', '第 500 行需要使用大于安全整数的精确跨批游标')
    const streamedLogs = await bufferXlsxExport((output) => inventoryQueryService.exportLogsToStream({ refType: 'verify-xlsx' }, output))
    const inventorySheet = (await readBook(streamedLogs.buffer)).getWorksheet('库存流水')!
    assert.equal(streamedLogs.rowCount, 505)
    for (let i = 0; i < 505; i += 1) {
      const row = inventorySheet.getRow(i + 2)
      assert.equal(row.getCell(1).value, new Date('2024-03-02T14:12:13Z').toLocaleString('zh-CN', { hour12: false }))
      assert.equal(row.getCell(3).value, 'XL-SKU-64B')
      assert.equal(row.getCell(6).value, 5, '继续以 SKU 前后快照计算变动量')
      assert.equal(row.getCell(7).value, 505 - i, '跨批行须按主键倒序完整导出')
      assert.equal(row.getCell(12).value, '=1+1', '等号开头的备注在 XLSX 中保持纯文本')
      assert.equal(row.getCell(12).type, ExcelJS.ValueType.String)
    }

    await db.query(
      `INSERT INTO inventory_log (product_id, change_type, change_qty, ref_type)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20001)
       SELECT ?, 'inbound', 1, 'verify-xlsx-cap' FROM seq`,
      [product.id],
    )
    const unstarted = new PassThrough()
    let declared = false
    const beforeError = instances.length
    await assert.rejects(inventoryQueryService.exportLogsToStream({ refType: 'verify-xlsx-cap' }, unstarted, () => { declared = true }), /20001.*20000/)
    assert.equal(declared, false, '拒绝超限必须早于声明下载')
    assert.equal(instances.length, beforeError, '拒绝超限必须早于构造工作簿')
    unstarted.destroy()

    const slow = blockDownload()
    let emitted = 0
    const slowExport = writeStreamingXlsx(slow.output, undefined, async (workbook, waitForRows) => {
      const worksheet = workbook.addWorksheet('慢速下载')
      for (let batch = 0; batch < 20; batch += 1) {
        for (let row = 0; row < 50; row += 1) {
          worksheet.addRow([randomBytes(1024).toString('hex')]).commit()
          emitted += 1
        }
        await waitForRows()
      }
      worksheet.commit()
    })
    void slowExport.catch(() => undefined)
    try {
      await within(slow.started, '慢速下载开始')
      await nextTurn()
      assert.ok(emitted < 1000, '响应阻塞必须逆向暂停 XML 生产')
      slow.resume()
      await within(slowExport, '慢速下载恢复')
      assert.equal((await readBook(slow.bytes())).worksheets[0]!.rowCount, 1000)
    } finally {
      slow.output.destroy()
    }

    const writeFailure = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('受控 XLSX 写出故障'))
      },
    })
    await within(assert.rejects(writeStreamingXlsx(writeFailure, undefined, async (workbook) => {
      const worksheet = workbook.addWorksheet('写失败')
      worksheet.addRow(['数据']).commit()
      worksheet.commit()
    }), /受控 XLSX 写出故障/), '响应写入故障')
    assert.equal(writeFailure.destroyed, true)

    // 真实报表流在 ZIP 写入期间断连，须结束提交等待并返还共享租约。
    const disconnected = blockDownload()
    const dataLease = dataExportLeasePool.acquire('持有数据导出名额')
    const reportExport = reportService.exportExcel('inventory', {}, disconnected.output, undefined, actor.userId)
    void reportExport.catch(() => undefined)
    try {
      await within(disconnected.started, '报表 ZIP 开始写入')
      assert.equal(dataExportLeasePool.activeExports, 2)
      assert.throws(() => dataExportLeasePool.acquire('其他数据导出账号'), /任务较多/)
      disconnected.output.destroy()
      await within(assert.rejects(reportExport, /close|关闭|中断/i), '报表断连后返回')
      assert.equal(dataExportLeasePool.activeExports, 1, '断连应归还报表占用的共享租约')
    } finally {
      disconnected.output.destroy()
      dataLease.release()
    }
    assert.equal(dataExportLeasePool.activeExports, 0)
    // 允许生产流异步清理。未处理的压缩错误会由 Node 使进程失败。
    await nextTurn()

    // 让真实 HTTP 连接成功收到 ZIP 前缀，然后阻止余下 body，以可复现方式制造中断。
    const app = createApp()
    const server = createServer((request, response) => {
      if (request.headers['x-test-xlsx-disconnect'] === '1') {
        const write = response.write.bind(response)
        response.write = ((...args: Parameters<typeof response.write>) => {
          if (!response.headersSent) write(...args)
          return false
        }) as typeof response.write
      }
      app(request, response)
    })
    try {
      await within(new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      }), 'HTTP 审计回归监听')
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const authorization = `Bearer ${login.token}`
      const auditRepo = db.getRepository(SysAuditLog)
      const cappedResponse = await fetch(`${baseUrl}/api/inventory/logs/export?refType=verify-xlsx-cap`, { headers: { authorization } })
      assert.equal(cappedResponse.status, 400)
      assert.match(await cappedResponse.text(), /20001.*20000/)
      assert.equal(await auditRepo.countBy({ actionType: 'data_export.inventory_logs' }), 0, '下载前拒绝不产生导出事件')

      const verifyHttpAudit = async (url: string, actionType: string, completedRows: number) => {
        const response = await fetch(url, { headers: { authorization } })
        assert.equal(response.status, 200)
        await readBook(Buffer.from(await response.arrayBuffer()))
        await within(new Promise<void>((resolve, reject) => {
          const request = getHttp(url, { headers: { authorization, 'x-test-xlsx-disconnect': '1' } }, (response) => {
            response.once('data', (bytes) => {
              response.destroy()
              try {
                assert.equal(response.statusCode, 200)
                assert.match(String(response.headers['content-type']), /spreadsheetml/)
                assert.equal(bytes.subarray(0, 2).toString(), 'PK')
                resolve()
              } catch (error) {
                reject(error)
              }
            })
            response.once('error', reject)
          })
          request.once('error', reject)
        }), '客户端接收 XLSX 后断连')

        let rows: InstanceType<typeof SysAuditLog>[] = []
        for (let attempt = 0; attempt < 100; attempt += 1) {
          rows = await auditRepo.find({ where: { actionType }, order: { id: 'ASC' } })
          if (rows.length >= 2) break
          await delay(20)
        }
        assert.equal(rows.length, 2, '一次完成和一次中断各留一条导出审计')
        const [completed, interrupted] = rows.map((row) => JSON.parse(row.detailJson ?? '{}'))
        assert.equal(completed.rowCount, completedRows)
        assert.equal(completed.filters.transferStatus, undefined)
        assert.equal(interrupted.rowCount, null)
        assert.deepEqual(interrupted.filters, { ...completed.filters, transferStatus: 'incomplete' })
        assert.equal(dataExportLeasePool.activeExports, 0)
      }
      await verifyHttpAudit(`${baseUrl}/api/products/export`, 'data_export.products', expectedSkus.length + 1)
      await verifyHttpAudit(`${baseUrl}/api/inventory/logs/export?refType=verify-xlsx`, 'data_export.inventory_logs', 505)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    fs.writeFileSync(path.join(task, 'exceljs-lazy-results.json'), JSON.stringify({ status: 'passed', operations, independentInstances: validOperationInstances, invalidArchiveRejectedBeforeWorkbook: true, realWorkbook: true, eagerModuleLoaded: false, concurrentModulePromiseShared: true, failedModulePromiseReset: true, multiBatchExports: true, queryLimitBeforeDownload: true, xlsxOutputBackpressure: true, disconnectReleasedLease: true, partialDownloadAudited: true }, null, 2))
    console.log('ExcelJS真实8操作、启动加载边界、并发独立实例与失败重试通过')
    console.log('商品与库存 XLSX 分批、行数上限、慢写入背压及报表断连释放通过')
  } finally {
    Object.defineProperty(ExcelJS, 'Workbook', descriptor)
    Object.defineProperty(ExcelJS.stream.xlsx, 'WorkbookWriter', writerDescriptor)
  }
} finally { if (db.isInitialized) await db.destroy() }
