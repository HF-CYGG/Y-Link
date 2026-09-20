-- YZ 通用 SKU 编码体系：系列内序号永久占用登记表按“系列码”重建命名空间（第 7 批，PR #109 第五轮评审
-- P1-C 修复）。
-- 背景：052 的占用表按 series_tag_id 隔离唯一性。某系列最后一个 YZ 商品被删除后，若该系列的标签也被
--       一并删除（主系列引用计数归零后标签允许删除），随后新建一个 seriesCode 相同的标签会拿到全新的
--       tagId——占用表与序列游标都按旧 tagId 隔离，于是序号从 01 重新分配，生成与旧印刷标签完全相同的
--       商品编码与 SKU 编码。tagId 只是内部自增主键，不会印在标签上；真正决定印刷编码文本是否重复的
--       是「前缀 + 系列码 + 序号」这三元组，因此权威唯一性必须迁移到这个维度。
-- 结构：
--   1. 新增 series_code VARCHAR(2) NOT NULL：系列编码（两位大写字母），与 base_tag.series_code 同构；
--   2. 新增 code_prefix VARCHAR(4) NOT NULL：登记时的全局前缀快照。前缀由 system_configs 的
--      product.yz_code.prefix 配置，理论上可以被改动，因此必须与 series_code 一起入命名空间——否则
--      前缀切换后旧登记会错误地拦住新前缀下本该允许的序号，或反过来放过跨前缀的真实冲突；
--   3. 新增唯一索引 uk_yz_series_seq_reservation_code (code_prefix, series_code, series_seq)：修复后
--      的权威唯一性来源；
--   4. 旧唯一索引 uk_yz_series_seq_reservation (series_tag_id, series_seq) 降级为普通索引并改名为
--      idx_yz_series_seq_reservation_tag，不删除——仍用于按 tagId 反查“这个标签当年生成过哪些序号”，
--      仅追溯用途，不再承担唯一性约束。
-- 数据回填（幂等，按优先级依次尝试，前一步能解析出的记录不会被后一步覆盖）：
--   a) 用当前全局前缀反推 product_code：product_code 本身就是 `${prefix}${seriesCode}${序号补零}` 的
--      定长拼接（见 product-code.service.ts 的 formatProductCode），比反查标签更可靠——标签可能已经
--      被删除，但 product_code 是登记时写入的快照，永远还在。若 product_code 以当前前缀开头、总长度
--      恰好等于「前缀长度 + 4」、紧跟着两位大写字母系列码和两位数字序号，且这两位数字序号与本行
--      series_seq 完全一致，则直接解析出 series_code，code_prefix 取当前前缀；
--   b) 若按当前前缀反推失败（说明登记时用的是历史前缀，配置后来改过，或本来就不是 YZ 格式），退化为
--      按 series_tag_id 反查 base_tag.series_code——标签未被删除时这是唯一还能拿到 series_code 的
--      来源，code_prefix 只能取当前全局配置（无法得知登记时刻的历史前缀值）；
--   c) 两条都反推不出的记录（标签已删除、且 product_code 格式又不匹配当前前缀，通常是前缀曾经改过又
--      找不到标签的存量脏数据）：不瞎猜，写入占位哨兵 series_code='??'、code_prefix='?'。这两个值都不
--      满足系列码/前缀的合法格式（系列码要求两位大写字母、前缀要求 1-4 位大写字母），不会被真实的
--      allocateSeriesSeq/reserveSeriesSeq 查询意外命中造成误拦截，只是让这几条脏数据在新命名空间下
--      "可查、不冲突"，便于后续用 `WHERE series_code = '??'` 一键定位人工核对。
-- 幂等：ADD COLUMN 用 information_schema 探测是否已存在；MODIFY COLUMN 收紧 NOT NULL 前先确认当前
--       仍为 NULLABLE 才执行；索引的降级/改名分别探测旧唯一索引与新索引名是否存在；UPDATE 语句本身用
--       `series_code IS NULL` 等条件保证可安全重放。
-- 环境说明：与 051/052 一致，本文件只面向 MySQL 执行；SQLite 由 database-bootstrap.ts 的
--          prepareSqliteYzReservationSeriesCodeColumns 负责补齐新列与等价回填口径，见该函数注释。

-- base_yz_series_seq_reservation.series_code
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_yz_series_seq_reservation' AND COLUMN_NAME = 'series_code') = 0,
  'ALTER TABLE `base_yz_series_seq_reservation` ADD COLUMN `series_code` VARCHAR(2) NULL COMMENT ''系列编码（两位大写字母），与 code_prefix、series_seq 共同构成权威唯一命名空间'' AFTER `product_code`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- base_yz_series_seq_reservation.code_prefix
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_yz_series_seq_reservation' AND COLUMN_NAME = 'code_prefix') = 0,
  'ALTER TABLE `base_yz_series_seq_reservation` ADD COLUMN `code_prefix` VARCHAR(4) NULL COMMENT ''YZ 编码全局前缀快照，随 system_configs.product.yz_code.prefix 可能变化，必须与 series_code 一起入命名空间'' AFTER `series_code`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 当前全局前缀（读不到则回退默认值 'YZ'，与 product-code.service.ts 的 getProductCodePrefix 口径一致）。
SET @current_prefix := (
  SELECT IF(config_value REGEXP '^[A-Z]{1,4}$', config_value, 'YZ')
  FROM system_configs WHERE config_key = 'product.yz_code.prefix' LIMIT 1
);
SET @current_prefix := COALESCE(@current_prefix, 'YZ');

-- 回填 a：按当前前缀反推 product_code。
UPDATE `base_yz_series_seq_reservation`
SET series_code = SUBSTRING(product_code, LENGTH(@current_prefix) + 1, 2),
    code_prefix = @current_prefix
WHERE series_code IS NULL
  AND product_code REGEXP CONCAT('^', @current_prefix, '[A-Z]{2}[0-9]{2}$')
  AND CAST(SUBSTRING(product_code, LENGTH(@current_prefix) + 3, 2) AS UNSIGNED) = series_seq;

-- 回填 b：反推失败则退化为按 series_tag_id 反查标签当前的 series_code（标签已删除则查不到，跳过）。
UPDATE `base_yz_series_seq_reservation` AS r
INNER JOIN `base_tag` AS t ON t.id = r.series_tag_id
SET r.series_code = t.series_code,
    r.code_prefix = @current_prefix
WHERE r.series_code IS NULL
  AND t.series_code IS NOT NULL;

-- 回填 c：两条都反推不出的记录，写入不合法格式的占位哨兵，标记为待人工核对，不影响新查询逻辑判断唯一性。
UPDATE `base_yz_series_seq_reservation`
SET series_code = '??',
    code_prefix = '?'
WHERE series_code IS NULL;

-- 收紧为 NOT NULL（仅当仍为 NULLABLE 时执行，保证重放安全）。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_yz_series_seq_reservation' AND COLUMN_NAME = 'series_code' AND IS_NULLABLE = 'YES') = 1,
  'ALTER TABLE `base_yz_series_seq_reservation` MODIFY COLUMN `series_code` VARCHAR(2) NOT NULL COMMENT ''系列编码（两位大写字母），与 code_prefix、series_seq 共同构成权威唯一命名空间''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_yz_series_seq_reservation' AND COLUMN_NAME = 'code_prefix' AND IS_NULLABLE = 'YES') = 1,
  'ALTER TABLE `base_yz_series_seq_reservation` MODIFY COLUMN `code_prefix` VARCHAR(4) NOT NULL COMMENT ''YZ 编码全局前缀快照，随 system_configs.product.yz_code.prefix 可能变化，必须与 series_code 一起入命名空间''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 旧唯一索引降级并改名为普通索引：先删旧的唯一索引（仅当它确实还是唯一索引时才删，重放安全）。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_yz_series_seq_reservation' AND INDEX_NAME = 'uk_yz_series_seq_reservation' AND NON_UNIQUE = 0) > 0,
  'ALTER TABLE `base_yz_series_seq_reservation` DROP INDEX `uk_yz_series_seq_reservation`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_yz_series_seq_reservation' AND INDEX_NAME = 'idx_yz_series_seq_reservation_tag') = 0,
  'CREATE INDEX `idx_yz_series_seq_reservation_tag` ON `base_yz_series_seq_reservation` (`series_tag_id`, `series_seq`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 新的权威唯一索引：(code_prefix, series_code, series_seq)。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'base_yz_series_seq_reservation' AND INDEX_NAME = 'uk_yz_series_seq_reservation_code') = 0,
  'CREATE UNIQUE INDEX `uk_yz_series_seq_reservation_code` ON `base_yz_series_seq_reservation` (`code_prefix`, `series_code`, `series_seq`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
