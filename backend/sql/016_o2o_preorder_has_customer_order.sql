-- =============================================
-- 文件说明：backend/sql/016_o2o_preorder_has_customer_order.sql
-- 文件职责：为 O2O 预订单补充“是否已触发正式出库单打印/导出”快照字段。
-- 维护说明：该字段由客户端打印/导出动作触发写入，核销生成后台出库单时用于填充 hasCustomerOrder。
-- =============================================

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'has_customer_order') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `has_customer_order` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否已触发正式出库单打印/导出（客户端快照）'' AFTER `is_system_applied`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
