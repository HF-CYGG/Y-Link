-- Issue #72：为出库订单增加独立业务号、乐观版本、永久号码占用与永久修订历史。
-- 本脚本只做幂等结构升级与历史 show_no 回填，不修改既有 show_no 或 O2O 关联语义。

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order` ADD COLUMN `business_no` VARCHAR(32) NULL AFTER `show_no`',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'business_no'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `biz_outbound_order`
SET `business_no` = `show_no`
WHERE `business_no` IS NULL OR LENGTH(TRIM(`business_no`)) = 0;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 1,
    'ALTER TABLE `biz_outbound_order` MODIFY COLUMN `business_no` VARCHAR(32) NOT NULL COMMENT ''独立可修订业务单号''',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'biz_outbound_order'
    AND COLUMN_NAME = 'business_no'
    AND IS_NULLABLE = 'YES'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `biz_outbound_order` ADD COLUMN `edit_version` INT NOT NULL DEFAULT 1 AFTER `business_no`',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'edit_version'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `biz_outbound_order` SET `edit_version` = 1 WHERE `edit_version` IS NULL OR `edit_version` < 1;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE UNIQUE INDEX `uk_biz_outbound_business_no` ON `biz_outbound_order` (`business_no`)',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'uk_biz_outbound_business_no'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `order_business_no_occupancy` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_namespace` VARCHAR(16) NOT NULL COMMENT '业务号命名空间：hyyzjd/hyyz',
  `serial_value` BIGINT UNSIGNED NOT NULL COMMENT '命名空间内数值流水',
  `business_no` VARCHAR(32) NOT NULL COMMENT '永久占用的订单业务号',
  `order_uuid` CHAR(36) NOT NULL COMMENT '首次获得该号码的订单 UUID 快照',
  `assigned_reason` VARCHAR(128) NOT NULL COMMENT '分配来源',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_business_no_occupancy_business_no` (`business_no`),
  UNIQUE KEY `uk_order_business_no_occupancy_namespace_serial` (`business_namespace`, `serial_value`),
  KEY `idx_order_business_no_occupancy_order_uuid` (`order_uuid`),
  CONSTRAINT `ck_order_business_no_occupancy_namespace` CHECK (`business_namespace` IN ('hyyzjd', 'hyyz'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_revision` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id_snapshot` VARCHAR(64) NOT NULL COMMENT '订单主键快照',
  `order_uuid` CHAR(36) NOT NULL COMMENT '订单稳定 UUID 快照',
  `revision_no` INT NOT NULL COMMENT '修订后的 editVersion',
  `before_snapshot_json` LONGTEXT NOT NULL COMMENT '修订前业务字段 JSON',
  `after_snapshot_json` LONGTEXT NOT NULL COMMENT '修订后业务字段 JSON',
  `reason` VARCHAR(500) NULL COMMENT '修订原因',
  `actor_user_id` VARCHAR(64) NULL COMMENT '操作人 ID 快照',
  `actor_username` VARCHAR(64) NOT NULL COMMENT '操作人账号快照',
  `actor_display_name` VARCHAR(64) NOT NULL COMMENT '操作人姓名快照',
  `ip_address` VARCHAR(64) NULL COMMENT '来源 IP',
  `user_agent` VARCHAR(255) NULL COMMENT '客户端 UA',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_revision_uuid_version` (`order_uuid`, `revision_no`),
  KEY `idx_order_revision_order_id_snapshot` (`order_id_snapshot`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用具名 CHECK guard 把历史格式污染转换成明确迁移失败；MySQL 8 会在 invalid_count > 0 时
-- 报出 ck_042_history_business_no_format，禁止只迁移“看起来合法”的子集。
DROP TEMPORARY TABLE IF EXISTS `tmp_042_history_business_no_format_guard`;
CREATE TEMPORARY TABLE `tmp_042_history_business_no_format_guard` (
  `invalid_count` BIGINT UNSIGNED NOT NULL,
  CONSTRAINT `ck_042_history_business_no_format` CHECK (`invalid_count` = 0)
) ENGINE=InnoDB;

INSERT INTO `tmp_042_history_business_no_format_guard` (`invalid_count`)
SELECT COUNT(*)
FROM `biz_outbound_order` `order`
WHERE `order`.`business_no` IS NULL
   OR `order`.`order_type` NOT IN ('department', 'walkin')
   OR (
     `order`.`order_type` = 'department'
     AND (
       NOT REGEXP_LIKE(
         `order`.`business_no`,
         CONCAT(
           '^hyyzjd[0-9]{',
           CAST(COALESCE((
             SELECT `config_value` FROM `system_configs`
             WHERE `config_key` = 'order.serial.department.width' LIMIT 1
           ), '6') AS UNSIGNED),
           '}$'
         ),
         'c'
       )
       OR CAST(SUBSTRING(`order`.`business_no`, 7) AS UNSIGNED) < CAST(COALESCE((
         SELECT `config_value` FROM `system_configs`
         WHERE `config_key` = 'order.serial.department.start' LIMIT 1
       ), '1') AS UNSIGNED)
     )
   )
   OR (
     `order`.`order_type` = 'walkin'
     AND (
       NOT REGEXP_LIKE(
         `order`.`business_no`,
         CONCAT(
           '^hyyz[0-9]{',
           CAST(COALESCE((
             SELECT `config_value` FROM `system_configs`
             WHERE `config_key` = 'order.serial.walkin.width' LIMIT 1
           ), '6') AS UNSIGNED),
           '}$'
         ),
         'c'
       )
       OR CAST(SUBSTRING(`order`.`business_no`, 5) AS UNSIGNED) < CAST(COALESCE((
         SELECT `config_value` FROM `system_configs`
         WHERE `config_key` = 'order.serial.walkin.start' LIMIT 1
       ), '1') AS UNSIGNED)
     )
   );

DROP TEMPORARY TABLE `tmp_042_history_business_no_format_guard`;

-- 若上一次迁移只写入了部分占号，先同时按 business_no 与“命名空间 + serial”寻找冲突；
-- 任一现存记录与订单 UUID 或号码结构不一致都明确失败，不能靠 INSERT IGNORE 吞掉。
DROP TEMPORARY TABLE IF EXISTS `tmp_042_business_no_occupancy_precheck`;
CREATE TEMPORARY TABLE `tmp_042_business_no_occupancy_precheck` (
  `invalid_count` BIGINT UNSIGNED NOT NULL,
  CONSTRAINT `ck_042_business_no_occupancy_precheck` CHECK (`invalid_count` = 0)
) ENGINE=InnoDB;

INSERT INTO `tmp_042_business_no_occupancy_precheck` (`invalid_count`)
SELECT COUNT(*)
FROM `biz_outbound_order` `order`
INNER JOIN `order_business_no_occupancy` `occupancy`
  ON BINARY `occupancy`.`business_no` = BINARY `order`.`business_no`
  OR (
    BINARY `occupancy`.`business_namespace` = BINARY CASE
      WHEN `order`.`order_type` = 'department' THEN 'hyyzjd'
      ELSE 'hyyz'
    END
    AND `occupancy`.`serial_value` = CAST(SUBSTRING(
      `order`.`business_no`,
      CASE WHEN `order`.`order_type` = 'department' THEN 7 ELSE 5 END
    ) AS UNSIGNED)
  )
WHERE BINARY `occupancy`.`business_no` <> BINARY `order`.`business_no`
   OR BINARY `occupancy`.`business_namespace` <> BINARY CASE
        WHEN `order`.`order_type` = 'department' THEN 'hyyzjd'
        ELSE 'hyyz'
      END
   OR `occupancy`.`serial_value` <> CAST(SUBSTRING(
        `order`.`business_no`,
        CASE WHEN `order`.`order_type` = 'department' THEN 7 ELSE 5 END
      ) AS UNSIGNED)
   OR BINARY `occupancy`.`order_uuid` <> BINARY `order`.`order_uuid`;

DROP TEMPORARY TABLE `tmp_042_business_no_occupancy_precheck`;

INSERT INTO `order_business_no_occupancy` (
  `business_namespace`, `serial_value`, `business_no`, `order_uuid`, `assigned_reason`, `created_at`
)
SELECT
  CASE WHEN `order`.`order_type` = 'department' THEN 'hyyzjd' ELSE 'hyyz' END,
  CAST(SUBSTRING(`order`.`business_no`, CASE WHEN `order`.`order_type` = 'department' THEN 7 ELSE 5 END) AS UNSIGNED),
  `order`.`business_no`,
  `order`.`order_uuid`,
  'history_backfill',
  `order`.`created_at`
FROM `biz_outbound_order` `order`
LEFT JOIN `order_business_no_occupancy` `occupancy`
  ON BINARY `occupancy`.`business_no` = BINARY `order`.`business_no`
 AND BINARY `occupancy`.`business_namespace` = BINARY CASE
      WHEN `order`.`order_type` = 'department' THEN 'hyyzjd'
      ELSE 'hyyz'
    END
 AND `occupancy`.`serial_value` = CAST(SUBSTRING(
      `order`.`business_no`,
      CASE WHEN `order`.`order_type` = 'department' THEN 7 ELSE 5 END
    ) AS UNSIGNED)
 AND BINARY `occupancy`.`order_uuid` = BINARY `order`.`order_uuid`
WHERE `occupancy`.`id` IS NULL;

-- 插入后再做一次全量精确映射校验，防止部分执行、并发污染或结构异常留下缺口。
DROP TEMPORARY TABLE IF EXISTS `tmp_042_business_no_occupancy_postcheck`;
CREATE TEMPORARY TABLE `tmp_042_business_no_occupancy_postcheck` (
  `invalid_count` BIGINT UNSIGNED NOT NULL,
  CONSTRAINT `ck_042_business_no_occupancy_postcheck` CHECK (`invalid_count` = 0)
) ENGINE=InnoDB;

INSERT INTO `tmp_042_business_no_occupancy_postcheck` (`invalid_count`)
SELECT COUNT(*)
FROM `biz_outbound_order` `order`
LEFT JOIN `order_business_no_occupancy` `occupancy`
  ON BINARY `occupancy`.`business_no` = BINARY `order`.`business_no`
 AND BINARY `occupancy`.`business_namespace` = BINARY CASE
      WHEN `order`.`order_type` = 'department' THEN 'hyyzjd'
      ELSE 'hyyz'
    END
 AND `occupancy`.`serial_value` = CAST(SUBSTRING(
      `order`.`business_no`,
      CASE WHEN `order`.`order_type` = 'department' THEN 7 ELSE 5 END
    ) AS UNSIGNED)
 AND BINARY `occupancy`.`order_uuid` = BINARY `order`.`order_uuid`
WHERE `occupancy`.`id` IS NULL;

DROP TEMPORARY TABLE `tmp_042_business_no_occupancy_postcheck`;

INSERT INTO `business_sequence` (`sequence_key`, `current_value`, `created_at`, `updated_at`)
SELECT 'order.business.department',
       GREATEST(
         COALESCE(MAX(`serial_value`), 0),
         GREATEST(CAST(COALESCE((
           SELECT `config_value` FROM `system_configs`
           WHERE `config_key` = 'order.serial.department.start' LIMIT 1
         ), '1') AS SIGNED) - 1, 0)
       ),
       UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
FROM `order_business_no_occupancy`
WHERE `business_namespace` = 'hyyzjd'
ON DUPLICATE KEY UPDATE `sequence_key` = `sequence_key`;

INSERT INTO `business_sequence` (`sequence_key`, `current_value`, `created_at`, `updated_at`)
SELECT 'order.business.walkin',
       GREATEST(
         COALESCE(MAX(`serial_value`), 0),
         GREATEST(CAST(COALESCE((
           SELECT `config_value` FROM `system_configs`
           WHERE `config_key` = 'order.serial.walkin.start' LIMIT 1
         ), '1') AS SIGNED) - 1, 0)
       ),
       UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
FROM `order_business_no_occupancy`
WHERE `business_namespace` = 'hyyz'
ON DUPLICATE KEY UPDATE `sequence_key` = `sequence_key`;
