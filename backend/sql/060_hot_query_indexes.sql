-- 热点查询性能索引（MySQL 8.0）：只新增二级索引，不修改任何数据。
-- 每个索引先查询 information_schema，旧库、新库与重复执行均可安全运行；已列入 DB_AUTO_MIGRATE 白名单。
-- InnoDB 新增二级索引默认在线执行（不阻塞读写），仅在开始与结束时短暂持有元数据锁；
-- 大表执行耗时与表行数成正比，建议在业务低峰执行，并确认没有长事务占用这些表。
-- SQLite 由 backend/src/config/database-bootstrap.ts 的启动期索引补齐逻辑自动创建同名索引。

-- 库存流水按时间范围筛选的计数、分页与导出
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND INDEX_NAME = 'idx_inventory_log_created_id') = 0,
  'CREATE INDEX idx_inventory_log_created_id ON inventory_log (created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 出库列表轮询的未删除有效根单分页与计数
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_deleted_status_id') = 0,
  'CREATE INDEX idx_biz_outbound_deleted_status_id ON biz_outbound_order (is_deleted, status, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 送货单池按状态计数与已入库分栏按核销时间倒序
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order' AND INDEX_NAME = 'idx_biz_inbound_pool_status_verified') = 0,
  'CREATE INDEX idx_biz_inbound_pool_status_verified ON biz_inbound_order (is_deleted, status, verified_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 供货方历史按创建时间倒序分页
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order' AND INDEX_NAME = 'idx_biz_inbound_supplier_deleted_created') = 0,
  'CREATE INDEX idx_biz_inbound_supplier_deleted_created ON biz_inbound_order (supplier_id, is_deleted, created_at)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 反馈附件清理按存储名核对引用
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_attachment' AND INDEX_NAME = 'idx_client_feedback_attachment_storage_name') = 0,
  'CREATE INDEX idx_client_feedback_attachment_storage_name ON client_feedback_attachment (storage_name)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
