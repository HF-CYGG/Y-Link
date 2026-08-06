-- =============================================
-- 文件说明：backend/sql/007_o2o_preorder_cancel_reason.sql
-- 文件职责：为 O2O 预订单补充取消原因字段，区分人工撤回与超时取消。
-- 维护说明：若取消原因枚举扩展，请同步更新实体、服务层状态报告与本脚本注释。
-- =============================================

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'cancel_reason') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `cancel_reason` VARCHAR(16) NULL COMMENT ''取消原因'' AFTER `status`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
