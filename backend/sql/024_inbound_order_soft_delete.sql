-- =============================================
-- 文件说明：backend/sql/024_inbound_order_soft_delete.sql
-- 文件职责：为入库送货单补齐软删除字段，支持供货方历史单据隐藏、恢复与永久删除。
-- 实现逻辑：
-- 1) 软删除只标记入库主单，不直接影响库存；
-- 2) 已核销入库单据由服务层禁止删除，保留为库存流水凭证；
-- 3) 幂等补列，兼容已部署数据库重复执行。
-- =============================================

ALTER TABLE `biz_inbound_order`
  ADD COLUMN IF NOT EXISTS `is_deleted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已删除（软删除）' AFTER `verified_by_display_name`,
  ADD COLUMN IF NOT EXISTS `deleted_at` DATETIME(3) NULL COMMENT '删除时间' AFTER `is_deleted`,
  ADD COLUMN IF NOT EXISTS `deleted_by_user_id` BIGINT UNSIGNED NULL COMMENT '删除操作人ID' AFTER `deleted_at`,
  ADD COLUMN IF NOT EXISTS `deleted_by_username` VARCHAR(64) NULL COMMENT '删除操作账号快照' AFTER `deleted_by_user_id`,
  ADD COLUMN IF NOT EXISTS `deleted_by_display_name` VARCHAR(128) NULL COMMENT '删除操作姓名快照' AFTER `deleted_by_username`;

SET @idx_biz_inbound_is_deleted_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'biz_inbound_order'
    AND index_name = 'idx_biz_inbound_is_deleted'
);

SET @idx_biz_inbound_is_deleted_sql := IF(
  @idx_biz_inbound_is_deleted_exists = 0,
  'ALTER TABLE `biz_inbound_order` ADD INDEX `idx_biz_inbound_is_deleted` (`is_deleted`)',
  'SELECT 1'
);

PREPARE stmt FROM @idx_biz_inbound_is_deleted_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
