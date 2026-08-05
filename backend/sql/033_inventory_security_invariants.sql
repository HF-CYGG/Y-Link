-- 库存 SKU 记账与共享认证风控：MySQL 8.0 增量迁移。
-- 历史入库明细优先绑定“默认规格”，其次绑定排序最前的当前启用 SKU。

CREATE TABLE IF NOT EXISTS auth_risk_state (
  bucket_digest VARCHAR(64) NOT NULL COMMENT '风控桶键 SHA-256 摘要',
  state_type VARCHAR(24) NOT NULL COMMENT 'rate_limit/login_failure',
  request_timestamps_json LONGTEXT NULL COMMENT '有界请求时间戳窗口',
  failure_count INT NOT NULL DEFAULT 0 COMMENT '登录失败次数',
  first_failed_at DATETIME(6) NULL,
  last_failed_at DATETIME(6) NULL,
  locked_until DATETIME(6) NULL,
  expires_at DATETIME(6) NOT NULL COMMENT '状态过期时间',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (bucket_digest),
  KEY idx_auth_risk_state_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='共享认证风控状态';

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order_item' AND COLUMN_NAME = 'sku_id') = 0,
  'ALTER TABLE biz_inbound_order_item ADD COLUMN sku_id BIGINT UNSIGNED NULL COMMENT ''入库SKU ID'' AFTER product_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE biz_inbound_order_item AS item
SET item.sku_id = (
  SELECT sku.id
  FROM base_product_sku AS sku
  WHERE sku.product_id = item.product_id
    AND sku.is_active = 1
    AND sku.is_current = 1
  ORDER BY
    CASE WHEN sku.spec_text = '默认规格' OR sku.spec_values_json = '{}' THEN 0 ELSE 1 END,
    sku.sort_order ASC,
    sku.id ASC
  LIMIT 1
)
WHERE item.sku_id IS NULL;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order_item' AND INDEX_NAME = 'idx_biz_inbound_item_sku_id') = 0,
  'CREATE INDEX idx_biz_inbound_item_sku_id ON biz_inbound_order_item (sku_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order_item' AND CONSTRAINT_NAME = 'fk_biz_inbound_item_sku_id') = 0,
  'ALTER TABLE biz_inbound_order_item ADD CONSTRAINT fk_biz_inbound_item_sku_id FOREIGN KEY (sku_id) REFERENCES base_product_sku (id) ON DELETE SET NULL ON UPDATE RESTRICT',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
