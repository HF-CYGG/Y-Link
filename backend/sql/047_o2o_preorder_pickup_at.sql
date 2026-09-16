-- Issue #96：客户端确认订单页为部门单新增“到店取货时间”必填项，随预订单保存供门店备货与核销排班。
-- 结构：o2o_preorder 新增可空列 pickup_at（DATETIME(6)，与实体 timestamp 精度一致）。
-- 数据：只加列不回填；散客单与上线前的历史订单保持 NULL，展示层按“未填写”兜底。
-- 幂等：通过 information_schema 判断列是否存在后再动态执行 DDL，重复执行不会报错。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'pickup_at') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `pickup_at` DATETIME(6) NULL COMMENT ''到店取货时间（部门单必填）'' AFTER `pickup_contact`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
