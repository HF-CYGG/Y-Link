-- 部门完整路径快照容量：与 client_user.department_name 的 271 字符契约保持一致。
-- 表存在时，列缺失则补建、容量不足则扩容；表尚未创建时交由对应建表脚本处理。
SET @ddl = CASE
  WHEN (SELECT COUNT(*) FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder') = 0 THEN
    'SELECT 1'
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'department_name_snapshot') = 0 THEN
    'ALTER TABLE `o2o_preorder` ADD COLUMN `department_name_snapshot` VARCHAR(271) NULL COMMENT ''下单时部门完整路径快照'''
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'department_name_snapshot'
          AND CHARACTER_MAXIMUM_LENGTH < 271) > 0 THEN
    'ALTER TABLE `o2o_preorder` MODIFY COLUMN `department_name_snapshot` VARCHAR(271) NULL COMMENT ''下单时部门完整路径快照'''
  ELSE 'SELECT 1'
END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = CASE
  WHEN (SELECT COUNT(*) FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation') = 0 THEN
    'SELECT 1'
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation' AND COLUMN_NAME = 'department_name_snapshot') = 0 THEN
    'ALTER TABLE `client_feedback_conversation` ADD COLUMN `department_name_snapshot` VARCHAR(271) NOT NULL DEFAULT '''' COMMENT ''客户端部门完整路径快照'''
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation' AND COLUMN_NAME = 'department_name_snapshot'
          AND CHARACTER_MAXIMUM_LENGTH < 271) > 0 THEN
    'ALTER TABLE `client_feedback_conversation` MODIFY COLUMN `department_name_snapshot` VARCHAR(271) NOT NULL DEFAULT '''' COMMENT ''客户端部门完整路径快照'''
  ELSE 'SELECT 1'
END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = CASE
  WHEN (SELECT COUNT(*) FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order') = 0 THEN
    'SELECT 1'
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'customer_department_name') = 0 THEN
    'ALTER TABLE `biz_outbound_order` ADD COLUMN `customer_department_name` VARCHAR(271) NULL COMMENT ''客户部门完整路径'''
  WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'customer_department_name'
          AND CHARACTER_MAXIMUM_LENGTH < 271) > 0 THEN
    'ALTER TABLE `biz_outbound_order` MODIFY COLUMN `customer_department_name` VARCHAR(271) NULL COMMENT ''客户部门完整路径'''
  ELSE 'SELECT 1'
END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
