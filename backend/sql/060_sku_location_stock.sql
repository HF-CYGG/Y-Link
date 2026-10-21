-- 规格分库位库存与按库位盘点。
-- 背景：此前一个 SKU 只有一个默认库位（base_product_sku.location_id），无法表达“同一规格分放在多个库位”。
-- 结构：
--   1. 新增 inv_sku_location_stock：记录 SKU 在主库位以外的库位上存放的件数，一个 SKU 在同一库位至多一行；
--      主库位件数不落表，恒等于 base_product_sku.current_stock 减去本表该 SKU 各行之和，
--      因此存量数据无需回填——没有任何拆分行时等价于“全部件数都在主库位”；
--      sku_id 随 SKU 级联删除（商品永久删除时一并清理），location_id 以 RESTRICT 指向库位（库位只停用不删除）；
--   2. inv_stocktake_item 新增 location_scope_id（0 表示按规格总量盘点），按库位盘点时每行对应“规格 × 库位”；
--      唯一键由 (stocktake_id, sku_id) 扩展为 (stocktake_id, sku_id, location_scope_id)。
--      用 0 而不是 NULL 表示“不分库位”：唯一索引不约束 NULL，会放过同一规格在一张单里的重复行。
-- 幂等：建表用 CREATE TABLE IF NOT EXISTS；补列、建新唯一索引、删旧唯一索引均先探测 information_schema。
--       必须先建新唯一索引再删旧索引，否则 stocktake_id 外键可能短暂失去可用的前缀索引而拒绝删除。
-- 环境说明：本文件只面向 MySQL；SQLite 由 database-bootstrap.ts 的 SQLITE_REQUIRED_TABLES 建表，
--          盘点明细的补列与索引替换由 prepareSqliteStocktakeLocationScope 完成。

CREATE TABLE IF NOT EXISTS `inv_sku_location_stock` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sku_id` BIGINT UNSIGNED NOT NULL COMMENT 'SKU ID',
  `location_id` BIGINT UNSIGNED NOT NULL COMMENT '库位ID（主库位以外）',
  `qty` INT NOT NULL COMMENT '该库位存放件数（大于 0）',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_inv_sku_location_stock_sku_location` (`sku_id`, `location_id`),
  KEY `idx_inv_sku_location_stock_location_id` (`location_id`),
  CONSTRAINT `fk_inv_sku_location_stock_sku_id` FOREIGN KEY (`sku_id`) REFERENCES `base_product_sku` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_inv_sku_location_stock_location_id` FOREIGN KEY (`location_id`) REFERENCES `base_storage_location` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规格分库位库存（主库位以外）';

-- inv_stocktake_item.location_scope_id
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inv_stocktake_item' AND COLUMN_NAME = 'location_scope_id') = 0,
  'ALTER TABLE `inv_stocktake_item` ADD COLUMN `location_scope_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''盘点库位ID（0 表示按规格总量盘点）'' AFTER `sku_id`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 新唯一键：同一盘点单内“规格 × 库位”唯一。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inv_stocktake_item' AND INDEX_NAME = 'uk_inv_stocktake_item_sku_location') = 0,
  'ALTER TABLE `inv_stocktake_item` ADD UNIQUE KEY `uk_inv_stocktake_item_sku_location` (`stocktake_id`, `sku_id`, `location_scope_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 旧唯一键 (stocktake_id, sku_id) 会拦住按库位盘点时同一规格的多库位行，必须删除。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inv_stocktake_item' AND INDEX_NAME = 'uk_inv_stocktake_item_sku') > 0,
  'ALTER TABLE `inv_stocktake_item` DROP INDEX `uk_inv_stocktake_item_sku`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
