-- Issue #110：管理员回收并复用已永久删除订单业务号。
-- 语义：order_uuid / created_at 永久保存首次分配事实；last_assigned_* 与 reuse_count 描述最后一次分配，
--       每次转移另写 order_business_no_reuse_event，不建立订单外键，保证主单物理删除后链路仍可追溯。
-- 幂等：新增列先以可空形态创建并回填，再收紧 NOT NULL；索引和事件表均按 information_schema/IF NOT EXISTS 探测。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_business_no_occupancy' AND COLUMN_NAME = 'last_assigned_order_uuid') = 0,
  'ALTER TABLE `order_business_no_occupancy` ADD COLUMN `last_assigned_order_uuid` CHAR(36) NULL COMMENT ''最后一次获配该号码的订单 UUID 快照'' AFTER `created_at`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_business_no_occupancy' AND COLUMN_NAME = 'last_assigned_at') = 0,
  'ALTER TABLE `order_business_no_occupancy` ADD COLUMN `last_assigned_at` DATETIME(6) NULL COMMENT ''最后一次分配时间'' AFTER `last_assigned_order_uuid`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_business_no_occupancy' AND COLUMN_NAME = 'reuse_count') = 0,
  'ALTER TABLE `order_business_no_occupancy` ADD COLUMN `reuse_count` INT NOT NULL DEFAULT 0 COMMENT ''管理员回收复用次数'' AFTER `last_assigned_at`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `order_business_no_occupancy`
SET
  `last_assigned_order_uuid` = `order_uuid`,
  `last_assigned_at` = `created_at`,
  `reuse_count` = 0
WHERE `last_assigned_order_uuid` IS NULL
   OR `last_assigned_at` IS NULL
   OR `reuse_count` IS NULL;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_business_no_occupancy' AND COLUMN_NAME = 'last_assigned_order_uuid' AND IS_NULLABLE = 'YES') = 1,
  'ALTER TABLE `order_business_no_occupancy` MODIFY COLUMN `last_assigned_order_uuid` CHAR(36) NOT NULL COMMENT ''最后一次获配该号码的订单 UUID 快照''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_business_no_occupancy' AND COLUMN_NAME = 'last_assigned_at' AND IS_NULLABLE = 'YES') = 1,
  'ALTER TABLE `order_business_no_occupancy` MODIFY COLUMN `last_assigned_at` DATETIME(6) NOT NULL COMMENT ''最后一次分配时间''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_business_no_occupancy' AND COLUMN_NAME = 'reuse_count' AND IS_NULLABLE = 'YES') = 1,
  'ALTER TABLE `order_business_no_occupancy` MODIFY COLUMN `reuse_count` INT NOT NULL DEFAULT 0 COMMENT ''管理员回收复用次数''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_business_no_occupancy' AND INDEX_NAME = 'idx_order_business_no_occupancy_last_assigned_order_uuid') = 0,
  'CREATE INDEX `idx_order_business_no_occupancy_last_assigned_order_uuid` ON `order_business_no_occupancy` (`last_assigned_order_uuid`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `order_business_no_reuse_event` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_namespace` VARCHAR(16) NOT NULL COMMENT '业务号命名空间：hyyzjd/hyyz',
  `serial_value` BIGINT UNSIGNED NOT NULL COMMENT '命名空间内数值流水',
  `business_no` VARCHAR(32) NOT NULL COMMENT '被回收复用的业务号',
  `from_order_uuid` CHAR(36) NOT NULL COMMENT '上一次获配订单 UUID 快照',
  `to_order_uuid` CHAR(36) NOT NULL COMMENT '本次获配订单 UUID 快照',
  `target_order_id_snapshot` VARCHAR(64) NOT NULL COMMENT '目标订单主键快照',
  `target_show_no_snapshot` VARCHAR(64) NOT NULL COMMENT '目标订单不可变 showNo 快照',
  `reuse_count` INT NOT NULL COMMENT '本次完成后的累计复用次数',
  `reason` VARCHAR(500) NOT NULL COMMENT '本次回收原因',
  `actor_user_id` VARCHAR(64) NULL COMMENT '操作人 ID 快照',
  `actor_username` VARCHAR(64) NOT NULL COMMENT '操作人账号快照',
  `actor_display_name` VARCHAR(64) NOT NULL COMMENT '操作人姓名快照',
  `ip_address` VARCHAR(64) NULL COMMENT '来源 IP',
  `user_agent` VARCHAR(255) NULL COMMENT '客户端 UA',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_order_business_no_reuse_event_business_no` (`business_no`),
  KEY `idx_order_business_no_reuse_event_to_order_uuid` (`to_order_uuid`),
  CONSTRAINT `ck_order_business_no_reuse_event_namespace` CHECK (`business_namespace` IN ('hyyzjd', 'hyyz'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 复用事件只允许追加。MySQL 不支持 CREATE TRIGGER IF NOT EXISTS；迁移在 advisory lock 内执行，重建单语句触发器可安全重放。
DROP TRIGGER IF EXISTS `trg_order_business_no_reuse_event_no_update`;
CREATE TRIGGER `trg_order_business_no_reuse_event_no_update` BEFORE UPDATE ON `order_business_no_reuse_event` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_BUSINESS_NO_REUSE_EVENT_APPEND_ONLY';
DROP TRIGGER IF EXISTS `trg_order_business_no_reuse_event_no_delete`;
CREATE TRIGGER `trg_order_business_no_reuse_event_no_delete` BEFORE DELETE ON `order_business_no_reuse_event` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_BUSINESS_NO_REUSE_EVENT_APPEND_ONLY';
