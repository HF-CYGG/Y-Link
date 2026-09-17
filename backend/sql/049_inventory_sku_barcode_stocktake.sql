-- Issue #103：文创店库存管理（SKU 条码、扫码出入库、库存盘点）。
-- 结构：
--   1. 新增商品分类 base_category、库位 base_storage_location；
--   2. base_product 新增 category_id；base_product_sku 新增 barcode（唯一）、cost_price、location_id；
--   3. 新增库存单据 inv_stock_doc / inv_stock_doc_item 与盘点单 inv_stocktake / inv_stocktake_item。
-- 数据：只加结构不回填；存量商品分类、SKU 条码、成本价、库位均为 NULL，SKU 条码为空时业务上以 SKU 编码作为内部条码。
-- 幂等：建表使用 IF NOT EXISTS，加列、索引与外键均先查 information_schema 再动态执行，可重复执行。

CREATE TABLE IF NOT EXISTS `base_category` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_code` VARCHAR(2) NOT NULL COMMENT '两位分类编码',
  `category_name` VARCHAR(64) NOT NULL COMMENT '分类名称',
  `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_base_category_code` (`category_code`),
  UNIQUE KEY `uk_base_category_name` (`category_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商品分类';

CREATE TABLE IF NOT EXISTS `base_storage_location` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `location_code` VARCHAR(32) NOT NULL COMMENT '库位编码',
  `location_name` VARCHAR(64) NULL COMMENT '库位名称',
  `remark` VARCHAR(255) NULL COMMENT '备注',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_base_storage_location_code` (`location_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='库位';

-- base_product.category_id
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND COLUMN_NAME = 'category_id') = 0,
  'ALTER TABLE `base_product` ADD COLUMN `category_id` BIGINT UNSIGNED NULL COMMENT ''商品分类ID'' AFTER `pre_ordered_stock`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND INDEX_NAME = 'idx_base_product_category_id') = 0, 'CREATE INDEX `idx_base_product_category_id` ON `base_product` (`category_id`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- 按列结构判断外键是否已存在（与 041/043/044 一致），兼容 DB_SYNC 建库时 TypeORM 生成的外键名
SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `base_product` ADD CONSTRAINT `fk_base_product_category_id` FOREIGN KEY (`category_id`) REFERENCES `base_category` (`id`) ON DELETE RESTRICT',
    'SELECT 1'
  )
  FROM information_schema.KEY_COLUMN_USAGE AS kcu
  WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'base_product'
    AND kcu.COLUMN_NAME = 'category_id'
    AND kcu.REFERENCED_TABLE_SCHEMA = DATABASE()
    AND kcu.REFERENCED_TABLE_NAME = 'base_category'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- base_product_sku.barcode / cost_price / location_id
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND COLUMN_NAME = 'barcode') = 0,
  'ALTER TABLE `base_product_sku` ADD COLUMN `barcode` VARCHAR(64) NULL COMMENT ''原厂条码（为空时以 SKU 编码作为内部条码）'' AFTER `default_price`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND INDEX_NAME = 'uk_base_product_sku_barcode') = 0, 'CREATE UNIQUE INDEX `uk_base_product_sku_barcode` ON `base_product_sku` (`barcode`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND COLUMN_NAME = 'cost_price') = 0,
  'ALTER TABLE `base_product_sku` ADD COLUMN `cost_price` DECIMAL(12,2) NULL COMMENT ''SKU 成本价'' AFTER `barcode`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND COLUMN_NAME = 'location_id') = 0,
  'ALTER TABLE `base_product_sku` ADD COLUMN `location_id` BIGINT UNSIGNED NULL COMMENT ''默认库位ID'' AFTER `cost_price`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND INDEX_NAME = 'idx_base_product_sku_location_id') = 0, 'CREATE INDEX `idx_base_product_sku_location_id` ON `base_product_sku` (`location_id`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- 按列结构判断外键是否已存在（与 041/043/044 一致），兼容 DB_SYNC 建库时 TypeORM 生成的外键名
SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `base_product_sku` ADD CONSTRAINT `fk_base_product_sku_location_id` FOREIGN KEY (`location_id`) REFERENCES `base_storage_location` (`id`) ON DELETE RESTRICT',
    'SELECT 1'
  )
  FROM information_schema.KEY_COLUMN_USAGE AS kcu
  WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'base_product_sku'
    AND kcu.COLUMN_NAME = 'location_id'
    AND kcu.REFERENCED_TABLE_SCHEMA = DATABASE()
    AND kcu.REFERENCED_TABLE_NAME = 'base_storage_location'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `inv_stock_doc` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `doc_no` VARCHAR(32) NOT NULL COMMENT '单据号',
  `client_request_id` VARCHAR(64) NULL COMMENT '提交幂等键',
  `doc_type` VARCHAR(16) NOT NULL COMMENT '单据类型',
  `status` VARCHAR(16) NOT NULL DEFAULT 'completed' COMMENT '单据状态',
  `reason_code` VARCHAR(32) NULL COMMENT '原因编码',
  `remark` VARCHAR(255) NULL COMMENT '备注',
  `total_qty` INT NOT NULL DEFAULT 0 COMMENT '变动数量绝对值合计',
  `operator_id` VARCHAR(64) NULL COMMENT '操作人ID',
  `operator_name` VARCHAR(128) NULL COMMENT '操作人',
  `void_reason` VARCHAR(255) NULL COMMENT '作废原因',
  `voided_at` DATETIME(6) NULL COMMENT '作废时间',
  `voided_by_name` VARCHAR(128) NULL COMMENT '作废人',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_inv_stock_doc_no` (`doc_no`),
  UNIQUE KEY `uk_inv_stock_doc_request` (`client_request_id`),
  KEY `idx_inv_stock_doc_status` (`status`),
  KEY `idx_inv_stock_doc_type_created` (`doc_type`, `created_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='库存单据';

CREATE TABLE IF NOT EXISTS `inv_stock_doc_item` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `doc_id` BIGINT UNSIGNED NOT NULL COMMENT '单据ID',
  `product_id` BIGINT UNSIGNED NOT NULL COMMENT '商品ID',
  `sku_id` BIGINT UNSIGNED NOT NULL COMMENT 'SKU ID',
  `sku_code_snapshot` VARCHAR(96) NOT NULL COMMENT 'SKU 编码快照',
  `product_name_snapshot` VARCHAR(128) NOT NULL COMMENT '商品名称快照',
  `spec_text_snapshot` VARCHAR(255) NOT NULL COMMENT '规格快照',
  `qty` INT NOT NULL COMMENT '库存净变化',
  `before_sku_stock` INT NOT NULL COMMENT '记账前 SKU 库存',
  `after_sku_stock` INT NOT NULL COMMENT '记账后 SKU 库存',
  PRIMARY KEY (`id`),
  KEY `idx_inv_stock_doc_item_doc_id` (`doc_id`),
  KEY `idx_inv_stock_doc_item_product_id` (`product_id`),
  KEY `idx_inv_stock_doc_item_sku_id` (`sku_id`),
  CONSTRAINT `fk_inv_stock_doc_item_doc_id` FOREIGN KEY (`doc_id`) REFERENCES `inv_stock_doc` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inv_stock_doc_item_product_id` FOREIGN KEY (`product_id`) REFERENCES `base_product` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inv_stock_doc_item_sku_id` FOREIGN KEY (`sku_id`) REFERENCES `base_product_sku` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='库存单据明细';

CREATE TABLE IF NOT EXISTS `inv_stocktake` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `stocktake_no` VARCHAR(32) NOT NULL COMMENT '盘点单号',
  `scope_type` VARCHAR(16) NOT NULL COMMENT '盘点范围类型',
  `scope_json` TEXT NOT NULL COMMENT '盘点范围参数 JSON',
  `scope_label` VARCHAR(255) NULL COMMENT '盘点范围展示文本',
  `blind_mode` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否盲盘',
  `status` VARCHAR(16) NOT NULL DEFAULT 'counting' COMMENT '盘点状态',
  `remark` VARCHAR(255) NULL COMMENT '备注',
  `created_by_id` VARCHAR(64) NULL COMMENT '创建人ID',
  `created_by_name` VARCHAR(128) NULL COMMENT '创建人',
  `submitted_at` DATETIME(6) NULL COMMENT '提交确认时间',
  `completed_at` DATETIME(6) NULL COMMENT '完成时间',
  `completed_by_name` VARCHAR(128) NULL COMMENT '确认人',
  `cancelled_at` DATETIME(6) NULL COMMENT '取消时间',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_inv_stocktake_no` (`stocktake_no`),
  KEY `idx_inv_stocktake_status_created` (`status`, `created_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='盘点单';

CREATE TABLE IF NOT EXISTS `inv_stocktake_item` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `stocktake_id` BIGINT UNSIGNED NOT NULL COMMENT '盘点单ID',
  `product_id` BIGINT UNSIGNED NOT NULL COMMENT '商品ID',
  `sku_id` BIGINT UNSIGNED NOT NULL COMMENT 'SKU ID',
  `in_scope` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否属于建单范围',
  `book_qty_snapshot` INT NULL COMMENT '首次计数时的账面库存',
  `counted_qty` INT NULL COMMENT '实盘数量',
  `counted_by_name` VARCHAR(128) NULL COMMENT '计数人',
  `counted_at` DATETIME(6) NULL COMMENT '计数时间',
  `diff_reason` VARCHAR(32) NULL COMMENT '差异原因',
  `resolution` VARCHAR(16) NULL COMMENT '处理方式',
  `resolution_remark` VARCHAR(255) NULL COMMENT '处理备注',
  `applied_qty` INT NULL COMMENT '确认时实际调账数量',
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_inv_stocktake_item_sku` (`stocktake_id`, `sku_id`),
  KEY `idx_inv_stocktake_item_stocktake_id` (`stocktake_id`),
  KEY `idx_inv_stocktake_item_product_id` (`product_id`),
  KEY `idx_inv_stocktake_item_sku_id` (`sku_id`),
  CONSTRAINT `fk_inv_stocktake_item_stocktake_id` FOREIGN KEY (`stocktake_id`) REFERENCES `inv_stocktake` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inv_stocktake_item_product_id` FOREIGN KEY (`product_id`) REFERENCES `base_product` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inv_stocktake_item_sku_id` FOREIGN KEY (`sku_id`) REFERENCES `base_product_sku` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='盘点明细';
