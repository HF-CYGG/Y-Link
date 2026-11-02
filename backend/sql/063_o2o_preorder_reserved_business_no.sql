-- 部门预订单下单即预留正式出库业务号，核销时由正式单继承；历史行保留 NULL，由服务启动后补号。重复执行只补缺失结构。
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'reserved_business_no') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `reserved_business_no` VARCHAR(32) NULL COMMENT ''预留正式出库业务号''', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND INDEX_NAME = 'uk_o2o_preorder_reserved_business_no') = 0,
  'CREATE UNIQUE INDEX `uk_o2o_preorder_reserved_business_no` ON `o2o_preorder` (`reserved_business_no`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
