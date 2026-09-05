-- 部门共享账号稳定节点绑定：字段与唯一键均可安全重放；存量数据回填由启动期服务按当前部门树预检后执行。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'department_node_id') = 0,
  'ALTER TABLE `client_user` ADD COLUMN `department_node_id` VARCHAR(128) NULL COMMENT ''部门共享账号绑定的稳定部门节点ID'' AFTER `department_name`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'department_name' AND CHARACTER_MAXIMUM_LENGTH < 271) > 0,
  'ALTER TABLE `client_user` MODIFY COLUMN `department_name` VARCHAR(271) NOT NULL DEFAULT '''' COMMENT ''所属部门完整路径（最多 8 级，每级 32 字符）''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND INDEX_NAME = 'uk_client_user_department_node_id') = 0,
  'CREATE UNIQUE INDEX `uk_client_user_department_node_id` ON `client_user` (`department_node_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
