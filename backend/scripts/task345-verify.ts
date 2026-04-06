import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppDataSource } from '../src/config/data-source.js'
import { env } from '../src/config/env.js'
import { orderService } from '../src/services/order.service.js'
import { productService } from '../src/services/product.service.js'
import type { AuthUserContext } from '../src/types/auth.js'

function pass(title: string) {
  console.log(`✅ ${title}`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const frontendRoot = path.resolve(backendRoot, '..')
const orderEntryFile = path.resolve(frontendRoot, 'src/views/order-entry/composables/useOrderEntryForm.ts')
const productManagerFile = path.resolve(frontendRoot, 'src/views/base-data/components/ProductManager.vue')
const productRouteFile = path.resolve(backendRoot, 'src/routes/product.routes.ts')

const mockActor: AuthUserContext = {
  userId: '9001',
  username: 'task345',
  displayName: 'Task345验证用户',
  role: 'admin',
  status: 'enabled',
  sessionToken: 'task345-verify-session',
  permissions: [],
}

function resetVerifyDatabase() {
  if (env.DB_TYPE !== 'sqlite') {
    return
  }

  const verifyDatabasePath = path.resolve(backendRoot, env.SQLITE_DB_PATH)
  fs.mkdirSync(path.dirname(verifyDatabasePath), { recursive: true })
  if (fs.existsSync(verifyDatabasePath)) {
    fs.rmSync(verifyDatabasePath, { force: true })
  }
}

function verifyFrontendSources() {
  const orderEntrySource = fs.readFileSync(orderEntryFile, 'utf8')
  const productManagerSource = fs.readFileSync(productManagerFile, 'utf8')
  const productRouteSource = fs.readFileSync(productRouteFile, 'utf8')

  assert.doesNotMatch(orderEntrySource, /AUTO-\$\{/)
  assert.doesNotMatch(orderEntrySource, /createAutoProductCode/)
  assert.match(orderEntrySource, /productApi\.createProduct\(\{/)
  assert.doesNotMatch(orderEntrySource, /productCode:\s*/)

  assert.match(productManagerSource, /getProductDetail\(row\.id\)/)
  assert.match(productManagerSource, /batchUpdateProducts/)
  assert.match(productManagerSource, /留空则自动生成统一编码/)
  assert.match(productRouteSource, /productRouter\.post\(\s*'\/batch'/)
  pass('前端已接入统一编码生成、编辑详情回填与批量改状态入口')
}

async function main() {
  resetVerifyDatabase()
  verifyFrontendSources()

  await AppDataSource.initialize()

  try {
    const firstProduct = await productService.create({
      productName: '自动编码产品一号',
      defaultPrice: 10,
      isActive: true,
    })
    const secondProduct = await productService.create({
      productName: '自动编码产品二号',
      defaultPrice: 12,
      isActive: true,
    })

    assert.match(firstProduct.productCode, /^P-\d{6}-0001$/)
    assert.match(secondProduct.productCode, /^P-\d{6}-0002$/)
    assert.notEqual(firstProduct.productCode, secondProduct.productCode)
    pass('新增产品留空编码时会按统一规则生成简洁且唯一的产品编码')

    const batchUpdatedProducts = await productService.batchUpdate({
      ids: [firstProduct.id, secondProduct.id],
      isActive: false,
    })
    assert.equal(batchUpdatedProducts.length, 2)
    assert.equal(batchUpdatedProducts.every((item) => item.isActive === false), true)
    assert.equal((await productService.detail(firstProduct.id)).isActive, false)
    pass('批量改状态可同时回写产品真实启停状态')

    await productService.update(firstProduct.id, {
      isActive: true,
      defaultPrice: 10,
    })

    const submitResult = await orderService.submit(
      {
        idempotencyKey: `task345-${Date.now()}`,
        customerName: 'Task345客户',
        remark: '验证默认售价回写',
        items: [
          {
            productId: firstProduct.id,
            qty: 2,
            unitPrice: 18.8,
            remark: '成交价回写测试',
          },
        ],
      },
      mockActor,
    )

    const productAfterSubmit = await productService.detail(firstProduct.id)
    const orderDetail = await orderService.detailById(submitResult.order.id)
    assert.equal(productAfterSubmit.defaultPrice, '18.80')
    assert.equal(orderDetail.items[0]?.unitPrice, '18.80')
    pass('出库单提交后会将成交单价回写为产品默认售价')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

try {
  await main()
  console.log('\nTask3/4/5 自动化验证全部通过。')
} catch (error) {
  console.error('\nTask3/4/5 自动化验证失败：', error)
  process.exit(1)
}
