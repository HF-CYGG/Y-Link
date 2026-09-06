-- =============================================
-- 文件说明：backend/sql/026_o2o_discount_price_snapshot.sql
-- 文件职责：为 O2O 折扣定价补齐商品折扣字段、预订单明细价格快照和商城公告配置。
-- 维护说明：执行前建议先备份数据库；历史预订单会按商品当前原价和 10 折回填快照，避免后续商品改价影响旧订单金额。
-- =============================================

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND COLUMN_NAME = 'discount_rate') = 0,
  'ALTER TABLE `base_product` ADD COLUMN `discount_rate` DECIMAL(3,1) NOT NULL DEFAULT 10.0 COMMENT ''O2O 商品折扣'' AFTER `default_price`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'original_price') = 0,
  'ALTER TABLE `o2o_preorder_item` ADD COLUMN `original_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT ''下单原价快照'' AFTER `qty`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'discount_rate') = 0,
  'ALTER TABLE `o2o_preorder_item` ADD COLUMN `discount_rate` DECIMAL(3,1) NOT NULL DEFAULT 10.0 COMMENT ''下单折扣快照'' AFTER `original_price`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'unit_price') = 0,
  'ALTER TABLE `o2o_preorder_item` ADD COLUMN `unit_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT ''下单折后单价快照'' AFTER `discount_rate`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'line_amount') = 0,
  'ALTER TABLE `o2o_preorder_item` ADD COLUMN `line_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT ''下单行金额快照'' AFTER `unit_price`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `base_product`
SET `discount_rate` = 10.0
WHERE `discount_rate` IS NULL OR `discount_rate` < 1.0 OR `discount_rate` > 10.0;

UPDATE `o2o_preorder_item` item
JOIN `base_product` product ON product.`id` = item.`product_id`
SET
  item.`original_price` = product.`default_price`,
  item.`discount_rate` = 10.0,
  item.`unit_price` = product.`default_price`,
  item.`line_amount` = ROUND(item.`qty` * product.`default_price`, 2)
WHERE item.`original_price` IS NULL
   OR item.`original_price` <= 0
   OR item.`unit_price` IS NULL
   OR item.`unit_price` <= 0
   OR item.`line_amount` IS NULL
   OR item.`line_amount` <= 0;

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
VALUES ('o2o.mall_announcement_text', '库存实时刷新，请以下单结果为准', 'o2o', '客户端商城公告文案，留空时隐藏公告块')
ON DUPLICATE KEY UPDATE `config_value` = `config_value`;
