-- =============================================
-- 文件说明：backend/sql/002_task1_order_schema_and_system_configs.sql
-- 文件职责：为既有 MySQL 数据库补齐订单类型字段、软删除联合唯一索引与单双流水系统配置。
-- 维护说明：适用于增量升级场景；若调整单号配置键名或订单字段，请同步更新本脚本。
-- =============================================

ALTER TABLE `biz_outbound_order`
  ADD COLUMN IF NOT EXISTS `order_type` VARCHAR(32) NOT NULL DEFAULT 'walkin' COMMENT '订单类型',
  ADD COLUMN IF NOT EXISTS `has_customer_order` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有客户订单',
  ADD COLUMN IF NOT EXISTS `is_system_applied` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否系统申请',
  ADD COLUMN IF NOT EXISTS `issuer_name` VARCHAR(64) DEFAULT NULL COMMENT '出单人',
  ADD COLUMN IF NOT EXISTS `customer_department_name` VARCHAR(128) DEFAULT NULL COMMENT '客户部门名称';

CREATE TABLE IF NOT EXISTS `system_configs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '配置主键',
  `config_key` VARCHAR(128) NOT NULL COMMENT '配置键',
  `config_value` VARCHAR(255) NOT NULL COMMENT '配置值',
  `config_group` VARCHAR(64) NOT NULL DEFAULT 'general' COMMENT '配置分组',
  `remark` VARCHAR(255) DEFAULT NULL COMMENT '备注',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_system_configs_config_key` (`config_key`),
  KEY `idx_system_configs_group` (`config_group`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统配置表';

SET @has_show_no_unique := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'biz_outbound_order'
    AND index_name = 'uk_biz_outbound_show_no'
);
SET @drop_show_no_sql := IF(
  @has_show_no_unique > 0,
  'ALTER TABLE `biz_outbound_order` DROP INDEX `uk_biz_outbound_show_no`',
  'SELECT 1'
);
PREPARE stmt_drop_show_no FROM @drop_show_no_sql;
EXECUTE stmt_drop_show_no;
DEALLOCATE PREPARE stmt_drop_show_no;

SET @has_show_no_deleted_unique := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'biz_outbound_order'
    AND index_name = 'uk_biz_outbound_show_no_is_deleted'
);
SET @create_show_no_deleted_sql := IF(
  @has_show_no_deleted_unique = 0,
  'ALTER TABLE `biz_outbound_order` ADD UNIQUE INDEX `uk_biz_outbound_show_no_is_deleted` (`show_no`, `is_deleted`)',
  'SELECT 1'
);
PREPARE stmt_create_show_no_deleted FROM @create_show_no_deleted_sql;
EXECUTE stmt_create_show_no_deleted;
DEALLOCATE PREPARE stmt_create_show_no_deleted;

SET @has_order_type_idx := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'biz_outbound_order'
    AND index_name = 'idx_biz_outbound_order_type'
);
SET @create_order_type_idx_sql := IF(
  @has_order_type_idx = 0,
  'ALTER TABLE `biz_outbound_order` ADD INDEX `idx_biz_outbound_order_type` (`order_type`)',
  'SELECT 1'
);
PREPARE stmt_create_order_type_idx FROM @create_order_type_idx_sql;
EXECUTE stmt_create_order_type_idx;
DEALLOCATE PREPARE stmt_create_order_type_idx;

SET @has_order_type_created_idx := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'biz_outbound_order'
    AND index_name = 'idx_biz_outbound_order_type_created_at'
);
SET @create_order_type_created_idx_sql := IF(
  @has_order_type_created_idx = 0,
  'ALTER TABLE `biz_outbound_order` ADD INDEX `idx_biz_outbound_order_type_created_at` (`order_type`, `created_at`)',
  'SELECT 1'
);
PREPARE stmt_create_order_type_created_idx FROM @create_order_type_created_idx_sql;
EXECUTE stmt_create_order_type_created_idx;
DEALLOCATE PREPARE stmt_create_order_type_created_idx;

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
VALUES
  ('order.serial.department.start', '1', 'order_serial', '部门单号起始值'),
  ('order.serial.department.current', '0', 'order_serial', '部门单号当前值'),
  ('order.serial.department.width', '6', 'order_serial', '部门单号位宽'),
  ('order.serial.walkin.start', '1', 'order_serial', '散客单号起始值'),
  ('order.serial.walkin.current', '0', 'order_serial', '散客单号当前值'),
  ('order.serial.walkin.width', '6', 'order_serial', '散客单号位宽')
ON DUPLICATE KEY UPDATE
  `config_value` = VALUES(`config_value`),
  `config_group` = VALUES(`config_group`),
  `remark` = VALUES(`remark`);
