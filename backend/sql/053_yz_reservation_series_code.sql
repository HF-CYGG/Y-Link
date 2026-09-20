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
--   a) 结构化解析 product_code 快照，不依赖当前全局前缀：product_code 本身就是
--      `${前缀}${两位大写系列码}${两位数字序号}` 的定长拼接（见 product-code.service.ts 的
--      formatProductCode），且这行自己的 series_seq 列已知（回填前就存在，不需要反推）。既然序号位
--      已知，直接从字符串尾部反切：末两位必须等于该行 series_seq 补零后的值，其前两位就是系列码，
--      再往前剩下的部分就是前缀——全程不假设前缀等于当前配置，因此即使登记之后全局前缀被改过
--      （P2-B 修复，PR #109 第七轮评审：旧实现按“当前前缀”反推，前缀改过的环境里旧编码反推失败后
--      退化到标签反查，但 code_prefix 却被强制写成当前前缀，例如历史编码 `ABPX01` 会被错误登记成
--      `YZ/PX/01`——前缀切回 AB 后 `ABPX01` 可以被重新分配，同时还多占了一个根本不存在的 `YZPX01`），
--      也无需依赖标签是否还存在。解析结果需要满足：总长度落在「前缀 1-4 位 + 系列码 2 位 + 序号 2 位」
--      即 5-8 位区间内，切出的系列码需匹配两位大写字母，切出的前缀需匹配 1-4 位大写字母，两者都校验
--      通过才采信；
--   b) 若结构化解析失败（product_code 长度或格式本身就不满足上述定长规则），退化为按 series_tag_id
--      反查 base_tag.series_code——标签未被删除时这是唯一还能拿到系列码的来源；拿到系列码后仍然用
--      同一套结构化反切规则反推前缀（用标签给出的系列码去匹配 product_code 该位置的子串，而不是直接
--      采信任何两位大写字母），反推失败（product_code 里对应位置的子串与标签系列码对不上，或前缀部分
--      不合法）同样不采信，绝不会退回到套用当前前缀这种做法；
--   c) 两条都反推不出的记录（product_code 完全不符合定长规则、且标签已删除或对不上，通常是格式本来
--      就不对的存量脏数据）：不瞎猜，写入占位哨兵 series_code='??'、code_prefix='?'。这两个值都不
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

-- 回填 a：结构化解析 product_code 快照，不依赖当前前缀——已知 series_seq（本行自带），从字符串尾部
-- 反切：长度落在 5-8 位区间内，末两位须等于 series_seq 补零后的值，其前两位切作系列码（须为两位大写
-- 字母），再往前剩下的部分切作前缀（须为 1-4 位大写字母），两项校验都通过才采信。
UPDATE `base_yz_series_seq_reservation`
SET series_code = SUBSTRING(product_code, LENGTH(product_code) - 3, 2),
    code_prefix = SUBSTRING(product_code, 1, LENGTH(product_code) - 4)
WHERE series_code IS NULL
  AND product_code IS NOT NULL
  AND LENGTH(product_code) BETWEEN 5 AND 8
  AND RIGHT(product_code, 2) = LPAD(series_seq, 2, '0')
  AND SUBSTRING(product_code, LENGTH(product_code) - 3, 2) REGEXP '^[A-Z]{2}$'
  AND SUBSTRING(product_code, 1, LENGTH(product_code) - 4) REGEXP '^[A-Z]{1,4}$';

-- 回填 b：结构化解析失败则退化为按 series_tag_id 反查标签当前的 series_code（标签已删除则查不到，
-- 跳过），拿到系列码后仍用同一套结构化反切规则反推前缀——校验 product_code 对应位置的子串确实等于
-- 标签给出的系列码、且序号位吻合，再切出前缀并校验 1-4 位大写字母，全部满足才采信；任何一步对不上都
-- 不写入，留给回填 c 的占位哨兵，绝不套用当前全局前缀顶替。
UPDATE `base_yz_series_seq_reservation` AS r
INNER JOIN `base_tag` AS t ON t.id = r.series_tag_id
SET r.series_code = t.series_code,
    r.code_prefix = SUBSTRING(r.product_code, 1, LENGTH(r.product_code) - 4)
WHERE r.series_code IS NULL
  AND t.series_code IS NOT NULL
  AND r.product_code IS NOT NULL
  AND LENGTH(r.product_code) BETWEEN 5 AND 8
  AND RIGHT(r.product_code, 2) = LPAD(r.series_seq, 2, '0')
  AND SUBSTRING(r.product_code, LENGTH(r.product_code) - 3, 2) = t.series_code
  AND SUBSTRING(r.product_code, 1, LENGTH(r.product_code) - 4) REGEXP '^[A-Z]{1,4}$';

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

-- P1-B 修复（PR #109 第六轮评审）：回填迁移执行时仍存活的 YZ 商品的占用登记。
-- 背景：052 只建表，不回填历史数据——如果某环境先上线了 050 并已经创建过 YZ 商品，052/053 执行时这些
--       仍存活商品的占用完全没有写进 base_yz_series_seq_reservation（052 的建表注释里"只加结构、不回填
--       历史数据"针对的是"已删除商品无法反推"的场景，但仍存活商品的 primary_series_tag_id/series_seq/
--       product_code 明明还在，完全具备回填条件，此前漏掉了）。这批商品一旦后续被删除，其（系列, 序号）
--       组合此前从未登记为永久占用，导入相同序号仍会成功，静默复用旧印刷标签对应的编码指向新商品。
--       053 才引入 series_code/code_prefix 两列，因此回填写在这里，不改 052 的建表段。
-- 口径（P1-B 修复，PR #109 第八轮评审）：不再依赖当前全局前缀反推，改成与上面「回填 a」完全一致的
--       结构化反切——已知 series_seq（本行 base_product.series_seq 自带），从 product_code 字符串
--       尾部反切：末两位须等于该行 series_seq 补零后的值，其前两位切作系列码（须两位大写字母），
--       再往前剩下的部分切作前缀（须 1-4 位大写字母），长度落在 5-8 位区间，全部满足才采信。
--       旧实现按当前全局前缀 @current_prefix 反推——如果某环境先用旧前缀创建过 YZ 商品、随后又切换
--       了前缀，这些旧前缀商品的 product_code 不匹配当前前缀，回填时会被 REGEXP 过滤掉、完全不会
--       写入占用表；这些商品一旦被删除，只要前缀再切回旧值，导入侧显式指定原序号就能重新分配出与
--       已打印旧标签完全相同的编码，静默指向新商品。改成结构化反切后不再受前缀是否变过的影响。
--       不追加回填 b/c 那样的标签反查或占位哨兵——这里要补登记的是"确实存活、结构完整"的商品，
--       反推失败大概率意味着 product_code 是手工改过的脏数据，登记一个猜测出来的 series_code 比
--       不登记更危险（会错误拦住真实合法的序号），因此反推失败的行跳过不登记，留给人工核对。
-- 范围：base_product.code_scheme = 'yz' 且 primary_series_tag_id / series_seq / product_code 三者
--       均非空（这是"曾经完整走过 YZ 生成路径"的判定条件），且 product_code 满足上述结构化反切规则。
-- 幂等：NOT EXISTS 子查询按权威唯一键 (code_prefix, series_code, series_seq) 判断是否已登记，可安全
--       重放；不区分该记录是此前已存在还是本次新插入，重复执行不会产生重复行或触发唯一索引冲突。
INSERT INTO `base_yz_series_seq_reservation` (`series_tag_id`, `series_seq`, `product_code`, `series_code`, `code_prefix`)
SELECT
  p.`primary_series_tag_id`,
  p.`series_seq`,
  p.`product_code`,
  SUBSTRING(p.`product_code`, LENGTH(p.`product_code`) - 3, 2),
  SUBSTRING(p.`product_code`, 1, LENGTH(p.`product_code`) - 4)
FROM `base_product` AS p
WHERE p.`code_scheme` = 'yz'
  AND p.`primary_series_tag_id` IS NOT NULL
  AND p.`series_seq` IS NOT NULL
  AND p.`product_code` IS NOT NULL
  AND LENGTH(p.`product_code`) BETWEEN 5 AND 8
  AND RIGHT(p.`product_code`, 2) = LPAD(p.`series_seq`, 2, '0')
  AND SUBSTRING(p.`product_code`, LENGTH(p.`product_code`) - 3, 2) REGEXP '^[A-Z]{2}$'
  AND SUBSTRING(p.`product_code`, 1, LENGTH(p.`product_code`) - 4) REGEXP '^[A-Z]{1,4}$'
  AND NOT EXISTS (
    SELECT 1 FROM `base_yz_series_seq_reservation` AS r
    WHERE r.`code_prefix` = SUBSTRING(p.`product_code`, 1, LENGTH(p.`product_code`) - 4)
      AND r.`series_code` = SUBSTRING(p.`product_code`, LENGTH(p.`product_code`) - 3, 2)
      AND r.`series_seq` = p.`series_seq`
  );
