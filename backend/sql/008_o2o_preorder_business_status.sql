-- =============================================
-- 文件说明：backend/sql/008_o2o_preorder_business_status.sql
-- 文件职责：为 O2O 预订单补充商家业务状态字段，支持后台展示更细粒度履约进度。
-- 维护说明：若商家状态枚举调整，请同步更新实体、服务层校验与客户端展示文案。
-- =============================================

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'business_status') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `business_status` VARCHAR(32) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
