-- =============================================
-- 文件说明：backend/sql/012_o2o_preorder_update_count.sql
-- 文件职责：为 O2O 预订单补充客户端改单次数字段，支持“单笔订单最多修改 3 次”的服务端硬限制。
-- 维护说明：若后续调整改单上限，请同步更新实体、服务层常量、客户端提示与文档口径。
-- =============================================

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'update_count') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `update_count` INT NOT NULL DEFAULT 0 COMMENT ''客户端修改次数'' AFTER `remark`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
