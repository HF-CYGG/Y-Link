-- 高并发订单、库存审计、通知收件箱与会话清理的 MySQL 8.0 增量索引。
-- 每个索引都先查询 information_schema，允许在旧库、新库和重复执行场景中安全运行。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND INDEX_NAME = 'idx_o2o_preorder_client_deleted_id') = 0,
  'CREATE INDEX idx_o2o_preorder_client_deleted_id ON o2o_preorder (client_user_id, is_deleted, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND INDEX_NAME = 'idx_o2o_preorder_client_deleted_status_id') = 0,
  'CREATE INDEX idx_o2o_preorder_client_deleted_status_id ON o2o_preorder (client_user_id, is_deleted, status, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND INDEX_NAME = 'idx_o2o_preorder_due_claim') = 0,
  'CREATE INDEX idx_o2o_preorder_due_claim ON o2o_preorder (status, is_deleted, timeout_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND INDEX_NAME = 'idx_inventory_log_ref_lookup') = 0,
  'CREATE INDEX idx_inventory_log_ref_lookup ON inventory_log (ref_type, ref_id, change_type, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_log' AND INDEX_NAME = 'idx_inventory_log_product_created') = 0,
  'CREATE INDEX idx_inventory_log_product_created ON inventory_log (product_id, created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_inbox' AND INDEX_NAME = 'idx_notification_inbox_user_unread_id') = 0,
  'CREATE INDEX idx_notification_inbox_user_unread_id ON notification_inbox (user_id, is_read, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user_session' AND INDEX_NAME = 'idx_client_user_session_expires_id') = 0,
  'CREATE INDEX idx_client_user_session_expires_id ON client_user_session (expires_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
