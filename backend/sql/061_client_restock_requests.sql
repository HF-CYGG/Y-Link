-- 补货需求与幂等键关联；一会话一条业务记录，重复点击只增加键映射，不增加需求计次。
-- 幂等：两表均 CREATE TABLE IF NOT EXISTS，并补齐实体同步已建表时缺失的两条 CHECK。
-- DB_AUTO_MIGRATE 默认关闭，存量 MySQL 须显式执行本脚本；非法历史数据令 ADD CHECK 失败，不清理或改写数据。
-- 不改库存，不回填旧反馈。历史商品/SKU/账号/会话引用采用 RESTRICT。
CREATE TABLE IF NOT EXISTS `client_restock_request` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `client_user_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `sku_id` BIGINT UNSIGNED NOT NULL,
  `product_name_snapshot` VARCHAR(128) NOT NULL,
  `product_code_snapshot` VARCHAR(64) NOT NULL,
  `sku_code_snapshot` VARCHAR(96) NOT NULL,
  `spec_text_snapshot` VARCHAR(255) NOT NULL,
  `quantity` INT NOT NULL,
  `latest_pickup_at` DATETIME(6) NOT NULL,
  `remark` VARCHAR(1000) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'requested',
  `handled_at` DATETIME(6) NULL,
  `client_request_id` VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  `payload_digest` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_restock_conversation` (`conversation_id`),
  UNIQUE KEY `uk_restock_client_request` (`client_user_id`, `client_request_id`),
  KEY `idx_restock_active` (`client_user_id`, `sku_id`, `status`, `latest_pickup_at`),
  KEY `idx_restock_product_created` (`product_id`, `created_at`),
  KEY `idx_restock_created` (`created_at`),
  CONSTRAINT `fk_restock_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `client_feedback_conversation` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_restock_client` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_restock_product` FOREIGN KEY (`product_id`) REFERENCES `base_product` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_restock_sku` FOREIGN KEY (`sku_id`) REFERENCES `base_product_sku` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_restock_quantity_positive` CHECK (`quantity` > 0),
  CONSTRAINT `ck_restock_status` CHECK (`status` IN ('requested', 'accepted', 'restocked', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='客户端补货需求';

CREATE TABLE IF NOT EXISTS `client_restock_request_key` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_user_id` BIGINT UNSIGNED NOT NULL,
  `client_request_id` VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  `payload_digest` VARCHAR(64) NOT NULL,
  `restock_request_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_restock_key_client_request` (`client_user_id`, `client_request_id`),
  CONSTRAINT `fk_restock_key_client` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_restock_key_request` FOREIGN KEY (`restock_request_id`) REFERENCES `client_restock_request` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='补货提交幂等键';

SET @restock_quantity_check_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'client_restock_request' AND CONSTRAINT_NAME = 'ck_restock_quantity_positive' AND CONSTRAINT_TYPE = 'CHECK') = 0,
  'ALTER TABLE `client_restock_request` ADD CONSTRAINT `ck_restock_quantity_positive` CHECK (`quantity` > 0)',
  'SELECT 1'
);
PREPARE restock_quantity_check_stmt FROM @restock_quantity_check_ddl;
EXECUTE restock_quantity_check_stmt;
DEALLOCATE PREPARE restock_quantity_check_stmt;

SET @restock_status_check_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'client_restock_request' AND CONSTRAINT_NAME = 'ck_restock_status' AND CONSTRAINT_TYPE = 'CHECK') = 0,
  'ALTER TABLE `client_restock_request` ADD CONSTRAINT `ck_restock_status` CHECK (`status` IN (''requested'', ''accepted'', ''restocked'', ''cancelled''))',
  'SELECT 1'
);
PREPARE restock_status_check_stmt FROM @restock_status_check_ddl;
EXECUTE restock_status_check_stmt;
DEALLOCATE PREPARE restock_status_check_stmt;
