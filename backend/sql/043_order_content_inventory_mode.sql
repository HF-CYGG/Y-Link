-- Issue #73：订单内容编辑库存模式与 SKU 级可逆库存流水。
-- 历史手工单不追溯库存；由 O2O 核销生成的正式出库单标记为已预扣。

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order` ADD COLUMN `inventory_mode` VARCHAR(24) NULL AFTER `edit_version`',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'inventory_mode'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `biz_outbound_order`
SET `inventory_mode` = CASE
  WHEN `idempotency_key` LIKE 'o2o-preorder-verify:%' THEN 'o2o_preapplied'
  ELSE 'legacy_none'
END
WHERE `inventory_mode` IS NULL
   OR `inventory_mode` NOT IN ('legacy_none', 'manual_applied', 'o2o_preapplied')
   OR (`inventory_mode` = 'legacy_none' AND `idempotency_key` LIKE 'o2o-preorder-verify:%');

SET @ddl = (
  SELECT IF(
    COUNT(*) = 1,
    'ALTER TABLE `biz_outbound_order` MODIFY COLUMN `inventory_mode` VARCHAR(24) NOT NULL DEFAULT ''legacy_none'' COMMENT ''订单库存处理模式''',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order'
    AND COLUMN_NAME = 'inventory_mode'
    AND (IS_NULLABLE = 'YES' OR COLUMN_DEFAULT IS NULL OR COLUMN_DEFAULT <> 'legacy_none')
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order` ADD CONSTRAINT `ck_biz_outbound_inventory_mode` CHECK (`inventory_mode` IN (''legacy_none'', ''manual_applied'', ''o2o_preapplied''))',
    'SELECT 1'
  )
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order'
    AND CONSTRAINT_NAME = 'ck_biz_outbound_inventory_mode' AND CONSTRAINT_TYPE = 'CHECK'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `inventory_log` ADD COLUMN `sku_id` BIGINT UNSIGNED NULL AFTER `product_id`', 'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND COLUMN_NAME = 'sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `inventory_log` ADD COLUMN `before_sku_current_stock` INT NULL AFTER `after_preordered_stock`', 'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND COLUMN_NAME = 'before_sku_current_stock'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `inventory_log` ADD COLUMN `after_sku_current_stock` INT NULL AFTER `before_sku_current_stock`', 'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND COLUMN_NAME = 'after_sku_current_stock'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `inventory_log` ADD COLUMN `before_sku_preordered_stock` INT NULL AFTER `after_sku_current_stock`', 'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND COLUMN_NAME = 'before_sku_preordered_stock'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `inventory_log` ADD COLUMN `after_sku_preordered_stock` INT NULL AFTER `before_sku_preordered_stock`', 'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND COLUMN_NAME = 'after_sku_preordered_stock'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'CREATE INDEX `idx_inventory_log_sku_id` ON `inventory_log` (`sku_id`)', 'SELECT 1')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND INDEX_NAME = 'idx_inventory_log_sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `inventory_log` ADD CONSTRAINT `fk_inventory_log_sku_id` FOREIGN KEY (`sku_id`) REFERENCES `base_product_sku` (`id`) ON DELETE SET NULL',
    'SELECT 1'
  )
  FROM information_schema.KEY_COLUMN_USAGE AS kcu
  INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
   AND rc.TABLE_NAME = kcu.TABLE_NAME
   AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'inventory_log'
    AND kcu.COLUMN_NAME = 'sku_id'
    AND kcu.REFERENCED_TABLE_SCHEMA = DATABASE()
    AND kcu.REFERENCED_TABLE_NAME = 'base_product_sku'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
    AND rc.DELETE_RULE = 'SET NULL'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
