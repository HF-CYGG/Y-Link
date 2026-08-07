-- =============================================
-- 文件说明：backend/sql/014_o2o_preorder_client_order_type.sql
-- 文件职责：为 O2O 预订单补充客户端下单归属类型与部门快照，支持区分“部门订 / 散客”。
-- 维护说明：若调整下单归属枚举或前端展示口径，请同步更新实体、服务返回结构与客户端页面。
-- =============================================

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'client_order_type') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `client_order_type` VARCHAR(16) NOT NULL DEFAULT ''walkin'' COMMENT ''客户端下单归属类型''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'department_name_snapshot') = 0,
  'ALTER TABLE `o2o_preorder` ADD COLUMN `department_name_snapshot` VARCHAR(128) NULL COMMENT ''下单时部门名称快照''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
