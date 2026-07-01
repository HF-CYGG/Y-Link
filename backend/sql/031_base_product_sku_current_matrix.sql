-- Add an explicit current-matrix marker for SKU rows.
-- Historical SKU rows stay in the table for snapshots, but no longer participate in current stock or mall selection.

ALTER TABLE `base_product_sku`
  ADD COLUMN IF NOT EXISTS `is_current` TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether this SKU belongs to the current spec matrix' AFTER `is_active`;

UPDATE `base_product_sku`
SET `is_current` = 0,
    `o2o_recommended` = 0
WHERE `is_active` = 0;

SET @idx_base_product_sku_current_mall_list_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'base_product_sku'
    AND INDEX_NAME = 'idx_base_product_sku_current_mall_list'
);
SET @idx_base_product_sku_current_mall_list_sql := IF(
  @idx_base_product_sku_current_mall_list_exists = 0,
  'CREATE INDEX `idx_base_product_sku_current_mall_list` ON `base_product_sku` (`product_id`, `is_current`, `is_active`, `sort_order`, `id`)',
  'SELECT 1'
);
PREPARE stmt FROM @idx_base_product_sku_current_mall_list_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
