import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(path, 'utf8')

const clientMallSource = read('src/views/client/ClientMallView.vue')
const productEntitySource = read('backend/src/entities/base-product.entity.ts')
const skuEntitySource = read('backend/src/entities/base-product-sku.entity.ts')
const preorderItemEntitySource = read('backend/src/entities/o2o-preorder-item.entity.ts')
const bootstrapSource = read('backend/src/config/database-bootstrap.ts')
const migrationSource = read('backend/sql/030_mall_catalog_performance_indexes.sql')
const skuCurrentMigrationSource = read('backend/sql/031_base_product_sku_current_matrix.sql')

const assertIncludes = (source, needle, message) => {
  assert.ok(source.includes(needle), message)
}

assertIncludes(
  clientMallSource,
  'productCardDisplayMap',
  'client mall should precompute product card display data instead of recalculating price and thumbnail repeatedly',
)
assertIncludes(
  clientMallSource,
  'resolveProductCardDisplay(item).thumbnail',
  'image warmup should use the actual card thumbnail, including SKU preview thumbnails',
)
assertIncludes(
  clientMallSource,
  'normalizeProductCardSearchText',
  'client mall should keep product search text bounded to avoid rebuilding long detail content strings for every card',
)

assertIncludes(
  productEntitySource,
  "idx_base_product_mall_list",
  'base_product should have a composite mall-list index for active listed product scans',
)
assertIncludes(
  skuEntitySource,
  "idx_base_product_sku_mall_list",
  'base_product_sku should have a composite mall-list index for product SKU scans',
)
assertIncludes(
  skuEntitySource,
  "idx_base_product_sku_current_mall_list",
  'base_product_sku should have a current/active composite index for product SKU scans',
)
assertIncludes(
  preorderItemEntitySource,
  "idx_o2o_preorder_item_product_order",
  'o2o_preorder_item should have a composite product/order index for sold quantity aggregation',
)

assertIncludes(
  bootstrapSource,
  'ensureSqliteIndex',
  'SQLite bootstrap should create performance indexes for existing local databases',
)
assertIncludes(
  bootstrapSource,
  'idx_base_product_mall_list',
  'SQLite bootstrap should include the mall-list product index',
)
assertIncludes(
  bootstrapSource,
  'idx_base_product_sku_mall_list',
  'SQLite bootstrap should include the mall-list SKU index',
)
assertIncludes(
  bootstrapSource,
  'idx_base_product_sku_current_mall_list',
  'SQLite bootstrap should include the current/active SKU index',
)
assertIncludes(
  bootstrapSource,
  'idx_o2o_preorder_item_product_order',
  'SQLite bootstrap should include the preorder item product/order index',
)

assertIncludes(
  migrationSource,
  'idx_base_product_mall_list',
  'MySQL migration should create the mall-list product index',
)
assertIncludes(
  migrationSource,
  'idx_base_product_sku_mall_list',
  'MySQL migration should create the mall-list SKU index',
)
assertIncludes(
  skuCurrentMigrationSource,
  'idx_base_product_sku_current_mall_list',
  'MySQL migration should create the current/active SKU index',
)
assertIncludes(
  migrationSource,
  'idx_o2o_preorder_item_product_order',
  'MySQL migration should create the preorder item product/order index',
)

console.log('[verify:mall-catalog-performance] mall catalog performance guard passed')
