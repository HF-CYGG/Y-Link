-- YZ 通用 SKU 编码体系：历史编码字段（第 4 批，代号 B9）。
-- 背景：050/存量升级（upgradeProductToYzCode）此前把旧 skuCode 回填进 base_product_sku.barcode
--       （原厂条码），用来让已打印的旧标签仍可扫描——人工测试反馈这样混用语义不对：
--       “原厂条码”应当只放商品自带的厂商条码（EAN/UPC），历史编码要有自己的位置。
-- 结构：
--   1. base_product 新增 legacy_product_code：升级前的历史产品编码，仅作追溯展示，不参与任何查询匹配；
--   2. base_product_sku 新增 legacy_sku_code：升级前的历史 SKU 编码，参与扫码匹配（lookupByCode 第三路），
--      并加普通索引 idx_base_product_sku_legacy_code（扫码要按它查）。
--      不加唯一索引：历史编码理论上可能重复（不同商品各自的历史编码体系并无全局唯一保证），
--      加唯一约束会让升级失败，因此只加普通索引。
-- 数据：一次性、幂等的回填（见文件末尾 UPDATE），把此前误写入 barcode 的历史编码搬到 legacy_sku_code，
--       并把 barcode 置空；商品级 legacy_product_code 无法从现有数据反推（旧 productCode 在升级时已被
--       新编码覆盖，原值没有留痕），不瞎猜，一律留空，后续只有新执行的升级会正确写入。
-- 幂等：加列、索引均先查 information_schema 再用 PREPARE/EXECUTE 动态 DDL 判断是否已存在，禁止裸
--       ADD COLUMN IF NOT EXISTS；UPDATE 语句本身通过 WHERE 条件保证可安全重放（首次搬运后 barcode
--       已置空，二次执行不会再匹配到同一批行）。

-- base_product.legacy_product_code
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product' AND COLUMN_NAME = 'legacy_product_code') = 0,
  'ALTER TABLE `base_product` ADD COLUMN `legacy_product_code` VARCHAR(64) NULL COMMENT ''升级到 YZ 编码前的历史产品编码，仅作追溯展示'' AFTER `code_scheme`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- base_product_sku.legacy_sku_code
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND COLUMN_NAME = 'legacy_sku_code') = 0,
  'ALTER TABLE `base_product_sku` ADD COLUMN `legacy_sku_code` VARCHAR(96) NULL COMMENT ''升级到 YZ 编码前的历史 SKU 编码，参与扫码匹配以兼容已打印标签'' AFTER `size_code`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_product_sku' AND INDEX_NAME = 'idx_base_product_sku_legacy_code') = 0,
  'CREATE INDEX `idx_base_product_sku_legacy_code` ON `base_product_sku` (`legacy_sku_code`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 数据迁移（一次性、幂等）：把此前误回填进 barcode 的历史编码搬到 legacy_sku_code，barcode 置空。
-- 判定口径（保守，宁可漏判也不能误删真实原厂条码）：
--   仅当 base_product.code_scheme = 'yz'，且 barcode 形如历史编码格式时才搬运：
--     - 以 'P-' 开头，且包含 '-DEFAULT' 或 '-SKU-'（旧 P- 系编码商品/SKU 编码的常见后缀）；
--     - 或以 'WC' 开头，紧跟数字（旧 WC 系编码格式）。
--   两条规则都不满足的 barcode 一律不动——很可能是真实原厂条码（EAN/UPC 等），不做任何改动。
-- 幂等性：迁移后这些行的 barcode 已被置空，`barcode IS NOT NULL` 与 `legacy_sku_code IS NULL` 两个
--         条件保证脚本可安全重放，不会重复搬运或覆盖已有的历史编码。
-- 环境说明：本文件只面向 MySQL 执行（`AUTO_MIGRATABLE_FILES` 白名单/启动期迁移），下面这条 UPDATE 用了
--          MySQL 专有的 `INNER JOIN ... SET` 多表更新语法与 `REGEXP`，SQLite 不支持、也不会执行这份
--          .sql；本地/单测使用的 SQLite 库结构由 database-bootstrap.ts 的实体同步负责补齐新列，但不会
--          跑这条数据搬运，SQLite 环境下的历史数据（如果有）需要另行处理，不在本脚本范围内。
UPDATE `base_product_sku` AS sku
INNER JOIN `base_product` AS p ON p.id = sku.product_id
SET sku.legacy_sku_code = sku.barcode,
    sku.barcode = NULL
WHERE p.code_scheme = 'yz'
  AND sku.barcode IS NOT NULL
  AND sku.legacy_sku_code IS NULL
  AND (
    (sku.barcode LIKE 'P-%' AND (sku.barcode LIKE '%-DEFAULT%' OR sku.barcode LIKE '%-SKU-%'))
    OR (sku.barcode REGEXP '^WC[0-9]')
  );
