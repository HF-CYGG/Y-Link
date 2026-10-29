/** 直接由生产Node加载tsc产物，验证ExcelJS ESM/CJS默认桥接与真实XLSX往返。 */
import assert from 'node:assert/strict'
import { loadExcelJs } from '../dist/utils/exceljs-loader.js'
const first = loadExcelJs(), concurrent = loadExcelJs()
assert.equal(first, concurrent)
const ExcelJS = await first
assert.equal(await concurrent, ExcelJS)
const book = new ExcelJS.Workbook(), another = new ExcelJS.Workbook()
assert.notEqual(book, another)
book.addWorksheet('生产Node验证').addRow(['编译后真实工作簿', '000123'])
const bytes = Buffer.from(await book.xlsx.writeBuffer())
assert.equal(bytes.subarray(0, 2).toString(), 'PK')
await another.xlsx.load(bytes)
assert.equal(another.getWorksheet('生产Node验证').getCell('A1').value, '编译后真实工作簿')
assert.equal(another.getWorksheet('生产Node验证').getCell('B1').value, '000123')
console.log('生产Node直接加载编译后ExcelJS loader：模块并发共享、独立Workbook和真实XLSX往返通过')
