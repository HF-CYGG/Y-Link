SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation' AND COLUMN_NAME = 'client_account_type') = 0,
  'ALTER TABLE `client_feedback_conversation` ADD COLUMN `client_account_type` VARCHAR(16) NOT NULL DEFAULT ''personal'' COMMENT ''客户端账号类型快照(personal/department)'' AFTER `department_name_snapshot`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation' AND COLUMN_NAME = 'staff_no_snapshot') = 0,
  'ALTER TABLE `client_feedback_conversation` ADD COLUMN `staff_no_snapshot` VARCHAR(64) NULL COMMENT ''客户端教职工号快照'' AFTER `client_account_type`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
