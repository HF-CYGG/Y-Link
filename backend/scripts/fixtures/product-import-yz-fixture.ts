/**
 * 文件说明：YZ 通用 SKU 编码体系「Excel 建库导入」验收脚本专用的脱敏测试夹具生成器（PR #109 第四轮
 *          评审 P2 修复）。
 * 背景：原验收脚本把 Excel 与基准 JSON 的路径写死在某台开发机的 Windows 临时目录，这两个文件并未提交
 *      进仓库，其他开发机与 CI 执行验收命令必然在用例开始前失败，导入链路实际上无法回归。
 * 文件职责：现场生成一份结构与真实业务 Excel 完全一致、但数据全部虚构的最小化建库导入表，供
 *          product-import-yz-verify.ts 在没有任何外部文件、没有设置任何环境变量的情况下独立跑通，
 *          结构对齐 product-import-yz.service.ts#buildTemplate 生成的真实模板。
 * 实现逻辑：覆盖评审要求的全部结构特征——
 *   - 合并单元格表达"沿用上一行"（品类/序号/商品三列，见 TA-2 测试文具乙）；
 *   - 真空白表达"沿用上一行"（不用合并单元格，直接留空续行，见 TA-3/TB-1/TB-2）；
 *   - 同序号多商品名（TB-1，触发 multi_product_name 待确认项）；
 *   - 款式/颜色列全是两位数字码数（TB-2，触发 axis_ambiguous 待确认项）；
 *   - 多变体 × 多尺码组合（TA-2，2 个一级变体 × 2 个尺码 = 4 条 SKU，验证两轴组合）；
 *   - 无变体无尺码（TA-1，验证 0 号编码）。
 * 维护重点：本文件与同目录 product-import-yz-baseline.json 是配套的一份手工核算结果——改动本文件
 *          任意一行数据、任意一处合并单元格范围，都必须同步重新按 product-code.service.ts 的编码
 *          算法手工核算并更新 baseline JSON 里对应的 productCode/variantCode/sizeCode/skuCode 字段，
 *          否则验收脚本的逐条比对会失败。所有商品名、系列名均为虚构测试数据，不得替换为真实商品名、
 *          真实系列名或真实价格。
 */

import ExcelJS from 'exceljs'

export interface YzImportFixtureTag {
  tagName: string
  seriesCode: string
}

/** 夹具用到的两个虚构系列标签：品类列的取值必须与这里的 tagName 完全一致。 */
export const FIXTURE_SERIES_TAGS: YzImportFixtureTag[] = [
  { tagName: '测试甲类', seriesCode: 'TA' },
  { tagName: '测试乙类', seriesCode: 'TB' },
]

const CATEGORY_A = FIXTURE_SERIES_TAGS[0].tagName
const CATEGORY_B = FIXTURE_SERIES_TAGS[1].tagName

/** 现场生成脱敏测试夹具（六列宽表），结构对齐真实业务表头「品类/序号/商品/款式/颜色/尺码/价格」。 */
export async function buildProductImportYzFixtureWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('YZ建库导入')
  sheet.columns = [
    { header: '品类', key: 'category', width: 12 },
    { header: '序号', key: 'seriesSeq', width: 8 },
    { header: '商品', key: 'productName', width: 22 },
    { header: '款式/颜色', key: 'variant', width: 14 },
    { header: '尺码', key: 'size', width: 10 },
    { header: '价格', key: 'price', width: 10 },
  ]
  sheet.getRow(1).font = { bold: true }

  // TA-1（第 2 行）：无变体无尺码，验证 0 号编码。
  sheet.addRow({ category: CATEGORY_A, seriesSeq: 1, productName: '测试摆件甲', variant: '', size: '', price: 12.5 })

  // TA-2（第 3-6 行）：合并单元格表达"沿用上一行"；2 个一级变体 × 2 个尺码 = 4 条 SKU，验证两轴组合。
  sheet.addRow({ category: CATEGORY_A, seriesSeq: 2, productName: '测试文具乙', variant: '红色', size: 'S', price: 39 })
  sheet.addRow({ category: CATEGORY_A, seriesSeq: 2, productName: '测试文具乙', variant: '红色', size: 'M', price: 39 })
  sheet.addRow({ category: CATEGORY_A, seriesSeq: 2, productName: '测试文具乙', variant: '蓝色', size: 'S', price: 39 })
  sheet.addRow({ category: CATEGORY_A, seriesSeq: 2, productName: '测试文具乙', variant: '蓝色', size: 'M', price: 39 })
  sheet.mergeCells('A3:A6')
  sheet.mergeCells('B3:B6')
  sheet.mergeCells('C3:C6')

  // TA-3（第 7-8 行）：真空白表达"沿用上一行"（不合并单元格），2 个一级变体、无尺码。
  sheet.addRow({ category: CATEGORY_A, seriesSeq: 3, productName: '测试书签丙', variant: '图案A', size: '', price: 15 })
  sheet.addRow({ category: '', seriesSeq: '', productName: '', variant: '图案B', size: '', price: 15 })

  // TB-1（第 9-10 行）：同序号多商品名，触发主商品名待确认项；品类/序号用真空白续行，商品名各自显式填写。
  sheet.addRow({ category: CATEGORY_B, seriesSeq: 1, productName: '测试乙款埃菲尔挂件', variant: '银色', size: '', price: 18 })
  sheet.addRow({ category: '', seriesSeq: '', productName: '测试乙款自由女神挂件', variant: '金色', size: '', price: 18 })

  // TB-2（第 11-12 行）：款式/颜色列全是两位数字码数，触发轴错位待确认项；商品名用真空白续行。
  sheet.addRow({ category: CATEGORY_B, seriesSeq: 2, productName: '测试鞋款丁', variant: '38', size: '', price: 99 })
  sheet.addRow({ category: '', seriesSeq: '', productName: '', variant: '39', size: '', price: 99 })

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
