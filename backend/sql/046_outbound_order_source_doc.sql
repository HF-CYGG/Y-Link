-- Issue #70：线上预订单核销生成的正式出库单改用结构化来源字段，不再把预订单号写入主单备注与明细备注。
-- 结构：biz_outbound_order 新增 source_doc_type / source_doc_id / source_doc_no 与组合索引 idx_biz_outbound_source_doc。
-- 数据：按幂等键 o2o-preorder-verify:<预订单ID> 关联预订单回填来源快照；仅清理与系统自动文案逐字节一致的备注，
--       人工备注、带人工追加内容的备注、无法关联到预订单的历史单据一律保留。
-- 幂等：数据步骤只处理 source_doc_type IS NULL 的主单，重复执行不会清理之后人工写回的同样文案；
--       先清理明细再回填主单，保证明细清理能以“血缘主单尚未回填”为一次性判断依据。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'source_doc_type') = 0,
  'ALTER TABLE `biz_outbound_order` ADD COLUMN `source_doc_type` VARCHAR(32) NULL COMMENT ''来源单据类型'' AFTER `idempotency_key`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'source_doc_id') = 0,
  'ALTER TABLE `biz_outbound_order` ADD COLUMN `source_doc_id` BIGINT UNSIGNED NULL COMMENT ''来源单据ID'' AFTER `source_doc_type`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'source_doc_no') = 0,
  'ALTER TABLE `biz_outbound_order` ADD COLUMN `source_doc_no` VARCHAR(64) NULL COMMENT ''来源单据号快照'' AFTER `source_doc_id`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_source_doc') = 0,
  'CREATE INDEX `idx_biz_outbound_source_doc` ON `biz_outbound_order` (`source_doc_type`, `source_doc_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ① 明细：血缘主单（明细自身所属主单，或合并复制行的来源主单）尚未回填，且备注与该预订单自动文案逐字节一致时才置空。
UPDATE `biz_outbound_order_item` AS i
INNER JOIN `biz_outbound_order` AS lineage ON lineage.`id` = COALESCE(i.`source_order_id`, i.`order_id`)
INNER JOIN `o2o_preorder` AS p ON lineage.`idempotency_key` = CONCAT('o2o-preorder-verify:', p.`id`)
SET i.`remark` = NULL,
    i.`updated_at` = i.`updated_at`
WHERE lineage.`source_doc_type` IS NULL
  AND lineage.`idempotency_key` LIKE 'o2o-preorder-verify:%'
  AND i.`remark` IS NOT NULL
  AND CAST(i.`remark` AS BINARY) = CAST(CONCAT('线上预订核销，预订单号：', p.`show_no`) AS BINARY);

-- ② 主单：回填来源快照，并在同一语句中仅清理逐字节等于自动文案的主单备注；保留原更新时间。
UPDATE `biz_outbound_order` AS o
INNER JOIN `o2o_preorder` AS p ON o.`idempotency_key` = CONCAT('o2o-preorder-verify:', p.`id`)
SET o.`remark` = CASE
      WHEN o.`remark` IS NOT NULL
        AND CAST(o.`remark` AS BINARY) = CAST(CONCAT('线上预订核销出库，预订单号：', p.`show_no`) AS BINARY)
      THEN NULL
      ELSE o.`remark`
    END,
    o.`source_doc_type` = 'o2o_preorder',
    o.`source_doc_id` = p.`id`,
    o.`source_doc_no` = p.`show_no`,
    o.`updated_at` = o.`updated_at`
WHERE o.`source_doc_type` IS NULL
  AND o.`idempotency_key` LIKE 'o2o-preorder-verify:%';
