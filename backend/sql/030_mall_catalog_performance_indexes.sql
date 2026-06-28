-- Mall catalog read-path indexes for product card, SKU, and sold-quantity queries.

SET @idx_base_product_mall_list_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'base_product'
    AND INDEX_NAME = 'idx_base_product_mall_list'
);
SET @idx_base_product_mall_list_sql := IF(
  @idx_base_product_mall_list_exists = 0,
  'CREATE INDEX `idx_base_product_mall_list` ON `base_product` (`is_active`, `o2o_status`, `id`)',
  'SELECT 1'
);
PREPARE stmt FROM @idx_base_product_mall_list_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_base_product_sku_mall_list_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'base_product_sku'
    AND INDEX_NAME = 'idx_base_product_sku_mall_list'
);
SET @idx_base_product_sku_mall_list_sql := IF(
  @idx_base_product_sku_mall_list_exists = 0,
  'CREATE INDEX `idx_base_product_sku_mall_list` ON `base_product_sku` (`product_id`, `is_active`, `sort_order`, `id`)',
  'SELECT 1'
);
PREPARE stmt FROM @idx_base_product_sku_mall_list_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_o2o_preorder_item_product_order_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'o2o_preorder_item'
    AND INDEX_NAME = 'idx_o2o_preorder_item_product_order'
);
SET @idx_o2o_preorder_item_product_order_sql := IF(
  @idx_o2o_preorder_item_product_order_exists = 0,
  'CREATE INDEX `idx_o2o_preorder_item_product_order` ON `o2o_preorder_item` (`product_id`, `order_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @idx_o2o_preorder_item_product_order_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_o2o_preorder_item_sku_order_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'o2o_preorder_item'
    AND INDEX_NAME = 'idx_o2o_preorder_item_sku_order'
);
SET @idx_o2o_preorder_item_sku_order_sql := IF(
  @idx_o2o_preorder_item_sku_order_exists = 0,
  'CREATE INDEX `idx_o2o_preorder_item_sku_order` ON `o2o_preorder_item` (`sku_id`, `order_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @idx_o2o_preorder_item_sku_order_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
