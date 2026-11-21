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
const compositeMigrationSource = read('backend/sql/065_performance_composite_indexes.sql')

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
  "@Index('idx_o2o_preorder_item_product_order_qty', ['productId', 'orderId', 'qty'])",
  '预订单明细应为商品销量聚合提供商品、订单、销量覆盖索引',
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
  "['idx_o2o_preorder_item_product_order_qty', ['product_id', 'order_id', 'qty']]",
  'SQLite 应在已就绪的存量库补齐商品、订单、销量覆盖索引',
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
  '历史 MySQL 030 应保留原有的商品、订单索引定义',
)
const coverageIndexSql = 'CREATE INDEX `idx_o2o_preorder_item_product_order_qty` ON `o2o_preorder_item` (`product_id`, `order_id`, `qty`)'
const obsoleteIndexSql = 'ALTER TABLE `o2o_preorder_item` DROP INDEX `idx_o2o_preorder_item_product_order`'
assertIncludes(compositeMigrationSource, coverageIndexSql, 'MySQL 065 应补齐商品、订单、销量覆盖索引')
assertIncludes(compositeMigrationSource, obsoleteIndexSql, 'MySQL 065 应清理被替代的双列索引')
assert.ok(compositeMigrationSource.indexOf(coverageIndexSql) < compositeMigrationSource.indexOf(obsoleteIndexSql),
  'MySQL 065 应先建立覆盖索引，再删除旧双列索引')

console.log('[verify:mall-catalog-performance] mall catalog performance guard passed')
