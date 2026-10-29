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
import { PassThrough } from 'node:stream'
import ts from 'typescript'

const task = path.resolve('../.tmp-restock-implementation/performance-convergence')
const runtimeDir = path.join(task, 'exceljs-runtime', `${Date.now()}-${randomBytes(4).toString('hex')}`)
fs.mkdirSync(runtimeDir, { recursive: true })
const password = `Excel_${randomBytes(12).toString('hex')}_Aa7!`
Object.assign(process.env, { DB_TYPE: 'sqlite', DB_SYNC: 'true', DB_AUTO_MIGRATE: 'false', SQLITE_DB_PATH: path.join(runtimeDir, 'exceljs.sqlite'),
  Y_LINK_DATA_DIR: runtimeDir, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', APP_PROFILE: 'performance-exceljs-verify', INIT_ADMIN_PASSWORD: password })
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
await import('../src/app.js')
assert.equal(excelLoaded(), false, '真实应用/全部五服务导入不得预载ExcelJS')
prepareDatabaseRuntime(); await db.initialize(); await initializeDatabaseSchemaIfNeeded(db)
const operations: string[] = []
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
    fs.writeFileSync(path.join(task, 'exceljs-lazy-results.json'), JSON.stringify({ status: 'passed', operations, independentInstances: validOperationInstances, invalidArchiveRejectedBeforeWorkbook: true, realWorkbook: true, eagerModuleLoaded: false, concurrentModulePromiseShared: true, failedModulePromiseReset: true }, null, 2))
    console.log('ExcelJS真实8操作、启动加载边界、并发独立实例与失败重试通过')
  } finally {
    Object.defineProperty(ExcelJS, 'Workbook', descriptor)
    Object.defineProperty(ExcelJS.stream.xlsx, 'WorkbookWriter', writerDescriptor)
  }
} finally { if (db.isInitialized) await db.destroy() }
