-- =============================================
-- 文件说明：backend/sql/027_o2o_recommended_products.sql
-- 文件职责：为 O2O 商城商品增加手动推荐标记，供客户端推荐排序使用。
-- 维护说明：该字段只影响商城展示排序，不改变库存、价格、下单或核销口径。
-- =============================================

ALTER TABLE `base_product`
  ADD COLUMN IF NOT EXISTS `o2o_recommended` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否手动推荐到 O2O 商城' AFTER `o2o_status`;

UPDATE `base_product`
SET `o2o_recommended` = 0
WHERE `o2o_recommended` IS NULL;

SET @idx_o2o_recommended_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'base_product'
    AND index_name = 'idx_base_product_o2o_recommended'
);

SET @idx_o2o_recommended_sql := IF(
  @idx_o2o_recommended_exists = 0,
  'CREATE INDEX `idx_base_product_o2o_recommended` ON `base_product` (`o2o_recommended`)',
  'SELECT 1'
);

PREPARE stmt FROM @idx_o2o_recommended_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
