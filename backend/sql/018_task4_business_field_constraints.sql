-- =============================================
-- File: backend/sql/018_task4_business_field_constraints.sql
-- Purpose:
--   Add MySQL CHECK constraints for core business numeric fields.
--   This script is idempotent: each constraint is added only when missing.
--
-- Pre-deploy cleanup checks:
--   SELECT COUNT(*) FROM base_product
--     WHERE default_price < 0 OR limit_per_user < 1 OR current_stock < 0
--        OR pre_ordered_stock < 0 OR pre_ordered_stock > current_stock;
--   SELECT COUNT(*) FROM biz_outbound_order
--     WHERE total_qty < 0 OR total_amount < 0
--        OR CHAR_LENGTH(TRIM(COALESCE(idempotency_key, ''))) = 0;
--   SELECT COUNT(*) FROM biz_outbound_order_item
--     WHERE line_no < 1 OR qty <= 0 OR unit_price <= 0 OR line_amount < 0;
-- =============================================

SET @constraint_exists = (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'base_product'
    AND constraint_name = 'ck_base_product_non_negative'
    AND constraint_type = 'CHECK'
);
SET @sql = IF(
  @constraint_exists = 0,
  'ALTER TABLE `base_product` ADD CONSTRAINT `ck_base_product_non_negative` CHECK (`default_price` >= 0 AND `discount_rate` > 0 AND `discount_rate` <= 10 AND `limit_per_user` >= 1 AND `current_stock` >= 0 AND `pre_ordered_stock` >= 0 AND `pre_ordered_stock` <= `current_stock`)',
  'SELECT ''ck_base_product_non_negative already exists'' AS migration_notice'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @constraint_exists = (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'biz_outbound_order'
    AND constraint_name = 'ck_biz_outbound_order_amounts'
    AND constraint_type = 'CHECK'
);
SET @sql = IF(
  @constraint_exists = 0,
  'ALTER TABLE `biz_outbound_order` ADD CONSTRAINT `ck_biz_outbound_order_amounts` CHECK (`total_qty` >= 0 AND `total_amount` >= 0 AND CHAR_LENGTH(TRIM(`idempotency_key`)) > 0)',
  'SELECT ''ck_biz_outbound_order_amounts already exists'' AS migration_notice'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @constraint_exists = (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'biz_outbound_order_item'
    AND constraint_name = 'ck_biz_outbound_order_item_positive'
    AND constraint_type = 'CHECK'
);
SET @sql = IF(
  @constraint_exists = 0,
  'ALTER TABLE `biz_outbound_order_item` ADD CONSTRAINT `ck_biz_outbound_order_item_positive` CHECK (`line_no` >= 1 AND `qty` > 0 AND `unit_price` > 0 AND `line_amount` >= 0)',
  'SELECT ''ck_biz_outbound_order_item_positive already exists'' AS migration_notice'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
