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
  FROM information_schema.KEY_COLUMN_USAGE AS kcu
  INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
   AND rc.TABLE_NAME = kcu.TABLE_NAME
   AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'biz_outbound_order_item'
    AND kcu.COLUMN_NAME = 'sku_id'
    AND kcu.REFERENCED_TABLE_SCHEMA = DATABASE()
    AND kcu.REFERENCED_TABLE_NAME = 'base_product_sku'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
    AND rc.DELETE_RULE = 'SET NULL'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
