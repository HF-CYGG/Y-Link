-- Issue #71：出库订单不可撤销合并治理。
-- 迁移仅补结构；正式数据迁移由部署流程执行，业务合并只能通过受权限与事务保护的 API 完成。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'status') = 0,
  'ALTER TABLE `biz_outbound_order` ADD COLUMN `status` VARCHAR(16) NULL DEFAULT ''active'' AFTER `edit_version`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `biz_outbound_order`
SET `status` = 'active'
WHERE `status` IS NULL OR `status` NOT IN ('active', 'merged');

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'status' AND (IS_NULLABLE = 'YES' OR COLUMN_DEFAULT IS NULL)) > 0,
  'ALTER TABLE `biz_outbound_order` MODIFY COLUMN `status` VARCHAR(16) NOT NULL DEFAULT ''active'' COMMENT ''订单合并治理状态''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND CONSTRAINT_NAME = 'ck_biz_outbound_status' AND CONSTRAINT_TYPE = 'CHECK') = 0,
  'ALTER TABLE `biz_outbound_order` ADD CONSTRAINT `ck_biz_outbound_status` CHECK (`status` IN (''active'', ''merged''))',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_status') = 0, 'CREATE INDEX `idx_biz_outbound_status` ON `biz_outbound_order` (`status`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND COLUMN_NAME = 'source_order_id') = 0, 'ALTER TABLE `biz_outbound_order_item` ADD COLUMN `source_order_id` BIGINT UNSIGNED NULL AFTER `remark`', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND COLUMN_NAME = 'source_order_uuid') = 0, 'ALTER TABLE `biz_outbound_order_item` ADD COLUMN `source_order_uuid` CHAR(36) NULL AFTER `source_order_id`', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND COLUMN_NAME = 'source_order_item_id') = 0, 'ALTER TABLE `biz_outbound_order_item` ADD COLUMN `source_order_item_id` BIGINT UNSIGNED NULL AFTER `source_order_uuid`', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND INDEX_NAME = 'idx_biz_outbound_item_source_order_id') = 0, 'CREATE INDEX `idx_biz_outbound_item_source_order_id` ON `biz_outbound_order_item` (`source_order_id`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order_item' AND INDEX_NAME = 'idx_biz_outbound_item_source_item_id') = 0, 'CREATE INDEX `idx_biz_outbound_item_source_item_id` ON `biz_outbound_order_item` (`source_order_item_id`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `order_merge_operation` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `operation_uuid` CHAR(36) NOT NULL,
  `idempotency_key` VARCHAR(128) NOT NULL,
  `request_hash` VARCHAR(64) NOT NULL,
  `target_order_id` BIGINT UNSIGNED NOT NULL,
  `target_order_uuid` CHAR(36) NOT NULL,
  `target_edit_version` INT NOT NULL,
  `merged_source_order_ids_json` LONGTEXT NOT NULL,
  `result_json` LONGTEXT NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `actor_user_id` VARCHAR(64) NULL,
  `actor_username` VARCHAR(64) NOT NULL,
  `actor_display_name` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_merge_operation_uuid` (`operation_uuid`),
  UNIQUE KEY `uk_order_merge_operation_idempotency_key` (`idempotency_key`),
  KEY `idx_order_merge_operation_target_order_id` (`target_order_id`),
  CONSTRAINT `fk_order_merge_operation_target_order` FOREIGN KEY (`target_order_id`) REFERENCES `biz_outbound_order` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='出库订单合并操作';

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_merge_operation' AND COLUMN_NAME = 'result_json') = 0,
  'ALTER TABLE `order_merge_operation` ADD COLUMN `result_json` LONGTEXT NULL AFTER `merged_source_order_ids_json`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `order_merge_operation`
SET `result_json` = '{}'
WHERE `result_json` IS NULL OR LENGTH(TRIM(`result_json`)) = 0;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_merge_operation' AND COLUMN_NAME = 'result_json' AND IS_NULLABLE = 'YES') > 0,
  'ALTER TABLE `order_merge_operation` MODIFY COLUMN `result_json` LONGTEXT NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `order_merge_relation` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `operation_id` BIGINT UNSIGNED NOT NULL,
  `parent_order_id` BIGINT UNSIGNED NOT NULL,
  `parent_order_uuid` CHAR(36) NOT NULL,
  `parent_business_no_snapshot` VARCHAR(32) NOT NULL,
  `source_order_id` BIGINT UNSIGNED NOT NULL,
  `source_order_uuid` CHAR(36) NOT NULL,
  `source_business_no_snapshot` VARCHAR(32) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_merge_relation_source_order_id` (`source_order_id`),
  UNIQUE KEY `uk_order_merge_relation_parent_source` (`parent_order_id`, `source_order_id`),
  KEY `idx_order_merge_relation_operation_id` (`operation_id`),
  KEY `idx_order_merge_relation_parent_order_id` (`parent_order_id`),
  CONSTRAINT `ck_order_merge_relation_distinct_orders` CHECK (`parent_order_id` <> `source_order_id`),
  CONSTRAINT `fk_order_merge_relation_operation` FOREIGN KEY (`operation_id`) REFERENCES `order_merge_operation` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_order_merge_relation_parent_order` FOREIGN KEY (`parent_order_id`) REFERENCES `biz_outbound_order` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_order_merge_relation_source_order` FOREIGN KEY (`source_order_id`) REFERENCES `biz_outbound_order` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='出库订单一层父子合并关系';

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'order_merge_relation' AND CONSTRAINT_NAME = 'ck_order_merge_relation_distinct_orders' AND CONSTRAINT_TYPE = 'CHECK') = 0,
  'ALTER TABLE `order_merge_relation` ADD CONSTRAINT `ck_order_merge_relation_distinct_orders` CHECK (`parent_order_id` <> `source_order_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
