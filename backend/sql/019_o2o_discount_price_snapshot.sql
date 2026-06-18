-- =============================================
-- 文件说明：backend/sql/019_o2o_discount_price_snapshot.sql
-- 文件职责：为 O2O 商品折扣与预订单明细价格快照补齐存量 MySQL 结构。
-- 实现逻辑：
-- 1) 商品表新增 discount_rate，默认 10 折保持历史价格不变；
-- 2) 预订单明细新增原价、折扣、折后单价和行金额快照字段；
-- 3) 历史明细按当前商品默认价回填为 10 折，保证历史订单可继续展示金额。
-- 维护说明：执行前请先备份数据库；若生产库 MySQL 版本不支持 ADD COLUMN IF NOT EXISTS，需要人工按列存在性拆分执行。
-- =============================================

ALTER TABLE `base_product`
  ADD COLUMN IF NOT EXISTS `discount_rate` DECIMAL(4,2) NOT NULL DEFAULT 10.00 COMMENT '商品折扣（几折）' AFTER `default_price`;

ALTER TABLE `o2o_preorder_item`
  ADD COLUMN IF NOT EXISTS `original_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '下单时原价快照' AFTER `qty`,
  ADD COLUMN IF NOT EXISTS `discount_rate` DECIMAL(4,2) NOT NULL DEFAULT 10.00 COMMENT '下单时折扣快照（几折）' AFTER `original_price`,
  ADD COLUMN IF NOT EXISTS `unit_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '下单时折后单价快照' AFTER `discount_rate`,
  ADD COLUMN IF NOT EXISTS `line_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '明细行折后金额快照' AFTER `unit_price`;

UPDATE `base_product`
SET `discount_rate` = 10.00
WHERE `discount_rate` IS NULL
   OR `discount_rate` <= 0
   OR `discount_rate` > 10;

UPDATE `o2o_preorder_item` AS item
LEFT JOIN `base_product` AS product ON product.`id` = item.`product_id`
SET
  item.`original_price` = COALESCE(NULLIF(item.`original_price`, 0), product.`default_price`, 0.00),
  item.`discount_rate` = CASE
    WHEN item.`discount_rate` > 0 AND item.`discount_rate` <= 10 THEN item.`discount_rate`
    ELSE 10.00
  END,
  item.`unit_price` = COALESCE(NULLIF(item.`unit_price`, 0), product.`default_price`, 0.00),
  item.`line_amount` = ROUND(item.`qty` * COALESCE(NULLIF(item.`unit_price`, 0), product.`default_price`, 0.00), 2)
WHERE item.`original_price` = 0
   OR item.`unit_price` = 0
   OR item.`line_amount` = 0
   OR item.`discount_rate` <= 0
   OR item.`discount_rate` > 10;
