-- 治理权限覆盖只新增 nullable 列；历史账号保持 NULL，不回填、不重写数据。
-- 旧应用会忽略非 NULL 权限限制；回滚应用前必须评估授权扩大风险，不能视为完整兼容回滚。
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'governance_permissions_json') = 0,
  'ALTER TABLE `sys_user` ADD COLUMN `governance_permissions_json` TEXT NULL COMMENT ''治理权限覆盖，NULL 沿用角色默认''', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
