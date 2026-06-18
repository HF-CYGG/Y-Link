-- =============================================
-- 文件说明：backend/sql/025_o2o_preorder_client_visibility_delete.sql
-- 文件职责：为 O2O 预订单补齐客户端可见性删除字段。
-- 实现逻辑：
-- 1) 管理端删除关联出库单时，仅隐藏客户端可见性，不物理删除预订单；
-- 2) 出库单恢复时可恢复客户端可见性；
-- 3) 订单池永久删除仍走原有物理删除链路。
-- =============================================

ALTER TABLE `o2o_preorder`
  ADD COLUMN IF NOT EXISTS `is_deleted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '客户端可见性删除标记' AFTER `verified_by`,
  ADD COLUMN IF NOT EXISTS `deleted_at` DATETIME(3) NULL COMMENT '客户端可见性删除时间' AFTER `is_deleted`,
  ADD COLUMN IF NOT EXISTS `deleted_by_user_id` BIGINT UNSIGNED NULL COMMENT '客户端可见性删除操作人ID' AFTER `deleted_at`,
  ADD COLUMN IF NOT EXISTS `deleted_by_username` VARCHAR(64) NULL COMMENT '客户端可见性删除操作账号' AFTER `deleted_by_user_id`,
  ADD COLUMN IF NOT EXISTS `deleted_by_display_name` VARCHAR(64) NULL COMMENT '客户端可见性删除操作人名称' AFTER `deleted_by_username`;

SET @idx_o2o_preorder_is_deleted_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'o2o_preorder'
    AND index_name = 'idx_o2o_preorder_is_deleted'
);

SET @idx_o2o_preorder_is_deleted_sql := IF(
  @idx_o2o_preorder_is_deleted_exists = 0,
  'ALTER TABLE `o2o_preorder` ADD INDEX `idx_o2o_preorder_is_deleted` (`is_deleted`)',
  'SELECT 1'
);

PREPARE stmt FROM @idx_o2o_preorder_is_deleted_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
