-- 文件说明：为商品 SKU 增加 O2O 推荐标记，支持指定规格推荐展示。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND COLUMN_NAME = 'o2o_recommended') = 0,
  'ALTER TABLE `base_product_sku` ADD COLUMN `o2o_recommended` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否推荐该 SKU 到 O2O 商城'' AFTER `is_active`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
UPDATE `base_product_sku`
SET `o2o_recommended` = 0
WHERE `o2o_recommended` IS NULL;
