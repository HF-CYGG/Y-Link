-- O2O 幂等下单与常数时间业务流水号的 MySQL 8.0 增量结构。
-- 使用 information_schema + 动态 DDL，允许已有生产库安全重复执行。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'client_request_id') = 0,
  'ALTER TABLE o2o_preorder ADD COLUMN client_request_id varchar(64) NULL COMMENT ''客户端下单幂等请求键'' AFTER client_user_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'client_request_hash') = 0,
  'ALTER TABLE o2o_preorder ADD COLUMN client_request_hash varchar(64) NULL COMMENT ''客户端下单请求摘要'' AFTER client_request_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND INDEX_NAME = 'uk_o2o_preorder_client_request') = 0,
  'CREATE UNIQUE INDEX uk_o2o_preorder_client_request ON o2o_preorder (client_user_id, client_request_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS business_sequence (
  sequence_key varchar(64) NOT NULL,
  current_value bigint unsigned NOT NULL DEFAULT 0,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (sequence_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='并发安全业务流水序列';
