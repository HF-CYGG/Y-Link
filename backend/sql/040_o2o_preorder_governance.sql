-- O2O 管理端取消来源、面向用户的说明与取消时间。
-- 历史订单不回填，缺失时由服务层按 cancel_reason 降级展示。
SET @ddl = CASE
  WHEN (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder') = 0 THEN 'SELECT 1'
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'cancellation_source') = 0 THEN
    'ALTER TABLE `o2o_preorder` ADD COLUMN `cancellation_source` VARCHAR(16) NULL COMMENT ''取消来源'''
  ELSE 'SELECT 1'
END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = CASE
  WHEN (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder') = 0 THEN 'SELECT 1'
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'cancellation_remark') = 0 THEN
    'ALTER TABLE `o2o_preorder` ADD COLUMN `cancellation_remark` VARCHAR(200) NULL COMMENT ''取消说明'''
  ELSE 'SELECT 1'
END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = CASE
  WHEN (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder') = 0 THEN 'SELECT 1'
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'cancelled_at') = 0 THEN
    'ALTER TABLE `o2o_preorder` ADD COLUMN `cancelled_at` DATETIME(6) NULL COMMENT ''取消时间'''
  ELSE 'SELECT 1'
END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
