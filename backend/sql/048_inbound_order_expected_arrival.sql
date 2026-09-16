-- Issue #95：送货单录入新增“预计送达时间”必填项，管理端送货单池据此安排备货与入库排班。
-- 结构：biz_inbound_order 新增可空列 expected_arrival_at（DATETIME(6)，与实体 timestamp 精度一致）。
-- 数据：只加列不回填；上线前的历史送货单保持 NULL，列表与详情按“未填写”兜底。
-- 幂等：通过 information_schema 判断列是否存在后再动态执行 DDL，重复执行不会报错。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order' AND COLUMN_NAME = 'expected_arrival_at') = 0,
  'ALTER TABLE `biz_inbound_order` ADD COLUMN `expected_arrival_at` DATETIME(6) NULL COMMENT ''预计送达时间（供货方提交时必填）'' AFTER `remark`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
