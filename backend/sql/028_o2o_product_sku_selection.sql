-- 为 O2O 商品增加规格 SKU 支持。
CREATE TABLE IF NOT EXISTS base_product_sku (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  sku_code VARCHAR(96) NOT NULL,
  spec_values_json TEXT NOT NULL,
  spec_text VARCHAR(255) NOT NULL DEFAULT '默认规格',
  default_price DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  discount_rate DECIMAL(3, 1) NOT NULL DEFAULT 10.0,
  current_stock INT NOT NULL DEFAULT 0,
  pre_ordered_stock INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  thumbnail VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_base_product_sku_code (sku_code),
  KEY idx_base_product_sku_product_id (product_id),
  CONSTRAINT fk_base_product_sku_product_id FOREIGN KEY (product_id) REFERENCES base_product(id) ON DELETE CASCADE
);

INSERT INTO base_product_sku (
  product_id,
  sku_code,
  spec_values_json,
  spec_text,
  default_price,
  discount_rate,
  current_stock,
  pre_ordered_stock,
  is_active,
  thumbnail,
  sort_order
)
SELECT
  p.id,
  CONCAT(p.product_code, '-DEFAULT'),
  '{}',
  '默认规格',
  p.default_price,
  p.discount_rate,
  p.current_stock,
  p.pre_ordered_stock,
  p.is_active,
  p.thumbnail,
  0
FROM base_product p
WHERE NOT EXISTS (
  SELECT 1
  FROM base_product_sku s
  WHERE s.product_id = p.id
);

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE o2o_preorder_item ADD COLUMN sku_id BIGINT UNSIGNED NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE o2o_preorder_item ADD COLUMN sku_code_snapshot VARCHAR(96) NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'sku_code_snapshot'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE o2o_preorder_item ADD COLUMN spec_text_snapshot VARCHAR(255) NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'spec_text_snapshot'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE o2o_preorder_item ADD COLUMN sku_image_snapshot VARCHAR(255) NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND COLUMN_NAME = 'sku_image_snapshot'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_o2o_preorder_item_sku_id ON o2o_preorder_item (sku_id)',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND INDEX_NAME = 'idx_o2o_preorder_item_sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE o2o_return_request_item ADD COLUMN sku_id BIGINT UNSIGNED NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_return_request_item' AND COLUMN_NAME = 'sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE o2o_return_request_item ADD COLUMN sku_code_snapshot VARCHAR(96) NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_return_request_item' AND COLUMN_NAME = 'sku_code_snapshot'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE o2o_return_request_item ADD COLUMN spec_text_snapshot VARCHAR(255) NULL',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_return_request_item' AND COLUMN_NAME = 'spec_text_snapshot'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX idx_o2o_return_request_item_sku_id ON o2o_return_request_item (sku_id)',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_return_request_item' AND INDEX_NAME = 'idx_o2o_return_request_item_sku_id'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE o2o_preorder_item item
JOIN base_product_sku sku ON sku.id = (
  SELECT selected_sku.id
  FROM base_product_sku selected_sku
  WHERE selected_sku.product_id = item.product_id
  ORDER BY selected_sku.sort_order ASC, selected_sku.id ASC
  LIMIT 1
)
SET
  item.sku_id = sku.id,
  item.sku_code_snapshot = COALESCE(item.sku_code_snapshot, sku.sku_code),
  item.spec_text_snapshot = COALESCE(item.spec_text_snapshot, sku.spec_text),
  item.sku_image_snapshot = COALESCE(item.sku_image_snapshot, sku.thumbnail)
WHERE item.sku_id IS NULL;

UPDATE o2o_return_request_item item
JOIN base_product_sku sku ON sku.id = (
  SELECT selected_sku.id
  FROM base_product_sku selected_sku
  WHERE selected_sku.product_id = item.product_id
  ORDER BY selected_sku.sort_order ASC, selected_sku.id ASC
  LIMIT 1
)
SET
  item.sku_id = sku.id,
  item.sku_code_snapshot = COALESCE(item.sku_code_snapshot, sku.sku_code),
  item.spec_text_snapshot = COALESCE(item.spec_text_snapshot, sku.spec_text)
WHERE item.sku_id IS NULL;
