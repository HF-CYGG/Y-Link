-- YZ 通用 SKU 编码体系：数据层结构变更（第 1 批）。
-- 背景：现有 base_product.product_code 历史上混用 P-/WC- 等前缀编码，缺少统一规则；
--       新版 YZ 编码体系把“系列码（两位大写字母）+ 系列内序号 + 一级变体码 + 尺码码”组合为定长编码，
--       同时用商品-系列的“主系列标签”消除商品-标签多对多关系下系列码归属的歧义，
--       并用“变体码永不回收”登记表保证同一商品下已分配的变体码/尺码码在整个生命周期内稳定不变。
-- 结构：
--   1. 新增 base_product_variant_code_registry：变体码/尺码码永久登记表；
--   2. base_tag 新增 series_code（两位大写字母，唯一）；
--   3. base_product 新增 primary_series_tag_id / series_seq / code_scheme，
--      并加 (primary_series_tag_id, series_seq) 唯一索引与指向 base_tag 的外键；
--   4. base_product_sku 新增 variant_code / size_code。
-- 数据：只加结构不回填；存量商品 code_scheme 一律落默认值 'legacy'，其余新列为 NULL，
--       与历史 P-/WC- 编码商品互不影响，YZ 编码接入将在后续批次实现。
-- 幂等：建表使用 IF NOT EXISTS；加列、索引与外键均先查 information_schema 再用 PREPARE/EXECUTE
--       动态 DDL 判断是否已存在，可安全重复执行、可安全重放。

CREATE TABLE IF NOT EXISTS `base_product_variant_code_registry` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL COMMENT '商品ID',
  `axis` VARCHAR(8) NOT NULL COMMENT '编码轴：variant=一级变体，size=尺码',
  `spec_value` VARCHAR(64) NOT NULL COMMENT '规格取值原文，重命名时只改本列',
  `code` VARCHAR(1) NOT NULL COMMENT '已分配的码，一经登记永不变更、永不回收',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_registry_lookup` (`product_id`, `axis`, `spec_value`),
  UNIQUE KEY `uk_registry_code` (`product_id`, `axis`, `code`),
  CONSTRAINT `fk_base_product_variant_code_registry_product_id` FOREIGN KEY (`product_id`) REFERENCES `base_product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='YZ 编码体系变体码/尺码码永久登记表';

-- base_tag.series_code
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_tag' AND COLUMN_NAME = 'series_code') = 0,
  'ALTER TABLE `base_tag` ADD COLUMN `series_code` VARCHAR(2) NULL COMMENT ''文创系列码（两位大写字母，供商品编码使用）'' AFTER `tag_code`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_tag' AND INDEX_NAME = 'uk_base_tag_series_code') = 0, 'CREATE UNIQUE INDEX `uk_base_tag_series_code` ON `base_tag` (`series_code`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- base_product.primary_series_tag_id / series_seq / code_scheme
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND COLUMN_NAME = 'primary_series_tag_id') = 0,
  'ALTER TABLE `base_product` ADD COLUMN `primary_series_tag_id` BIGINT UNSIGNED NULL COMMENT ''主系列标签ID（编码唯一权威，消除商品-标签多对多歧义）'' AFTER `pre_ordered_stock`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND INDEX_NAME = 'idx_base_product_primary_series_tag_id') = 0, 'CREATE INDEX `idx_base_product_primary_series_tag_id` ON `base_product` (`primary_series_tag_id`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND COLUMN_NAME = 'series_seq') = 0,
  'ALTER TABLE `base_product` ADD COLUMN `series_seq` SMALLINT UNSIGNED NULL COMMENT ''系列内商品序号（1-99）'' AFTER `primary_series_tag_id`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND INDEX_NAME = 'uk_base_product_series_seq') = 0, 'CREATE UNIQUE INDEX `uk_base_product_series_seq` ON `base_product` (`primary_series_tag_id`, `series_seq`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND COLUMN_NAME = 'code_scheme') = 0,
  'ALTER TABLE `base_product` ADD COLUMN `code_scheme` VARCHAR(8) NOT NULL DEFAULT ''legacy'' COMMENT ''编码体系：legacy=历史P-/WC编码，yz=新版定长编码'' AFTER `series_seq`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 按列结构判断外键是否已存在（与 041/043/044/049 一致），兼容 DB_SYNC 建库时 TypeORM 生成的外键名
SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `base_product` ADD CONSTRAINT `fk_base_product_primary_series_tag_id` FOREIGN KEY (`primary_series_tag_id`) REFERENCES `base_tag` (`id`) ON DELETE RESTRICT',
    'SELECT 1'
  )
  FROM information_schema.KEY_COLUMN_USAGE AS kcu
  WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'base_product'
    AND kcu.COLUMN_NAME = 'primary_series_tag_id'
    AND kcu.REFERENCED_TABLE_SCHEMA = DATABASE()
    AND kcu.REFERENCED_TABLE_NAME = 'base_tag'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- base_product_sku.variant_code / size_code
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND COLUMN_NAME = 'variant_code') = 0,
  'ALTER TABLE `base_product_sku` ADD COLUMN `variant_code` VARCHAR(1) NULL COMMENT ''一级变体码（0-9），仅 YZ 编码商品使用'' AFTER `sort_order`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND COLUMN_NAME = 'size_code') = 0,
  'ALTER TABLE `base_product_sku` ADD COLUMN `size_code` VARCHAR(1) NULL COMMENT ''尺码码（A-E），NULL 表示无尺码位'' AFTER `variant_code`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
