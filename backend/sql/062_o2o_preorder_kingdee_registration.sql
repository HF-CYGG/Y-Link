-- 金蝶编号只保存在原预订单，历史保留 NULL / 0；重复执行只补缺失列。
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'kingdee_voucher_no') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `kingdee_voucher_no` VARCHAR(128) NULL COMMENT ''金蝶单据编号''', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'kingdee_version') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `kingdee_version` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''金蝶登记版本''', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 版本非负约束与实体保持一致，旧库及重复迁移都可恢复。
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND CONSTRAINT_NAME = 'ck_o2o_kingdee_version_non_negative') = 0,
  'ALTER TABLE `o2o_preorder` ADD CONSTRAINT `ck_o2o_kingdee_version_non_negative` CHECK (`kingdee_version` >= 0)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
