-- 为手工出库明细补充可空 SKU 关联与历史快照；不回填历史行，也不改变库存数据。
SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order_item` ADD COLUMN `sku_id` BIGINT UNSIGNED NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND COLUMN_NAME = 'sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order_item` ADD COLUMN `sku_code_snapshot` VARCHAR(96) NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND COLUMN_NAME = 'sku_code_snapshot'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order_item` ADD COLUMN `spec_text_snapshot` VARCHAR(255) NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND COLUMN_NAME = 'spec_text_snapshot'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `idx_biz_outbound_item_sku_id` ON `biz_outbound_order_item` (`sku_id`)',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND INDEX_NAME = 'idx_biz_outbound_item_sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order_item` ADD CONSTRAINT `fk_biz_outbound_item_sku_id` FOREIGN KEY (`sku_id`) REFERENCES `base_product_sku` (`id`) ON DELETE SET NULL',
    'SELECT 1'
  )
  FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND CONSTRAINT_NAME = 'fk_biz_outbound_item_sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
