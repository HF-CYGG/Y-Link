-- 补齐核心业务复合索引；重复执行或中断后重试按实际结构继续。
-- 先完成并核对替代索引，再清理四个旧索引。回退时先恢复这四个索引，再移除新增索引。
-- 保留供应方单列索引，供 MySQL 同步临时重建复合索引期间维护外键。
SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_active_created_id'),
  'SELECT 1',
  'CREATE INDEX `idx_biz_outbound_active_created_id` ON `biz_outbound_order` (`is_deleted`, `status`, `created_at`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_active_type_created'),
  'SELECT 1',
  'CREATE INDEX `idx_biz_outbound_active_type_created` ON `biz_outbound_order` (`is_deleted`, `status`, `order_type`, `created_at`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order' AND INDEX_NAME = 'idx_biz_inbound_deleted_status_arrival_id'),
  'SELECT 1',
  'CREATE INDEX `idx_biz_inbound_deleted_status_arrival_id` ON `biz_inbound_order` (`is_deleted`, `status`, `expected_arrival_at`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order' AND INDEX_NAME = 'idx_biz_inbound_supplier_deleted_status_id'),
  'SELECT 1',
  'CREATE INDEX `idx_biz_inbound_supplier_deleted_status_id` ON `biz_inbound_order` (`supplier_id`, `is_deleted`, `status`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder' AND INDEX_NAME = 'idx_o2o_preorder_deleted_status_id'),
  'SELECT 1',
  'CREATE INDEX `idx_o2o_preorder_deleted_status_id` ON `o2o_preorder` (`is_deleted`, `status`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND INDEX_NAME = 'idx_o2o_preorder_item_product_order_qty'),
  'SELECT 1',
  'CREATE INDEX `idx_o2o_preorder_item_product_order_qty` ON `o2o_preorder_item` (`product_id`, `order_id`, `qty`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND INDEX_NAME = 'idx_client_user_real_name'),
  'SELECT 1',
  'CREATE INDEX `idx_client_user_real_name` ON `client_user` (`real_name`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inv_stocktake_item' AND INDEX_NAME = 'idx_inv_stocktake_item_counted'),
  'SELECT 1',
  'CREATE INDEX `idx_inv_stocktake_item_counted` ON `inv_stocktake_item` (`stocktake_id`, `counted_at`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation' AND INDEX_NAME = 'idx_feedback_conv_client_last_msg'),
  'SELECT 1',
  'CREATE INDEX `idx_feedback_conv_client_last_msg` ON `client_feedback_conversation` (`client_user_id`, `last_message_at`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation' AND INDEX_NAME = 'idx_feedback_conv_status_last_msg'),
  'SELECT 1',
  'CREATE INDEX `idx_feedback_conv_status_last_msg` ON `client_feedback_conversation` (`status`, `last_message_at`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_feedback_conversation' AND INDEX_NAME = 'idx_feedback_conv_assigned_status_last_msg'),
  'SELECT 1',
  'CREATE INDEX `idx_feedback_conv_assigned_status_last_msg` ON `client_feedback_conversation` (`assigned_user_id`, `status`, `last_message_at`, `id`)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 替代索引确认为完整的有序非唯一索引后再清理旧索引。
-- 发现异常同名索引时先保留旧索引，启动迁移结构校验会报错并阻止登记。
SET @replacement_indexes_ready = (
  SELECT COUNT(*) = 5
  FROM (
    SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS index_columns
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('biz_outbound_order', 'biz_inbound_order', 'o2o_preorder_item')
    GROUP BY TABLE_NAME, INDEX_NAME
    HAVING MIN(NON_UNIQUE) = 1 AND COUNT(*) = COUNT(COLUMN_NAME) AND COUNT(SUB_PART) = 0
  ) AS replacement
  WHERE (TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_active_created_id' AND index_columns = 'is_deleted,status,created_at,id')
     OR (TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_active_type_created' AND index_columns = 'is_deleted,status,order_type,created_at')
     OR (TABLE_NAME = 'biz_inbound_order' AND INDEX_NAME = 'idx_biz_inbound_deleted_status_arrival_id' AND index_columns = 'is_deleted,status,expected_arrival_at,id')
     OR (TABLE_NAME = 'biz_inbound_order' AND INDEX_NAME = 'idx_biz_inbound_supplier_deleted_status_id' AND index_columns = 'supplier_id,is_deleted,status,id')
     OR (TABLE_NAME = 'o2o_preorder_item' AND INDEX_NAME = 'idx_o2o_preorder_item_product_order_qty' AND index_columns = 'product_id,order_id,qty')
);

SET @ddl = IF(
  @replacement_indexes_ready AND EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_order_type'),
  'ALTER TABLE `biz_outbound_order` DROP INDEX `idx_biz_outbound_order_type`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  @replacement_indexes_ready AND EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND INDEX_NAME = 'idx_biz_outbound_is_deleted'),
  'ALTER TABLE `biz_outbound_order` DROP INDEX `idx_biz_outbound_is_deleted`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  @replacement_indexes_ready AND EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_inbound_order' AND INDEX_NAME = 'idx_biz_inbound_is_deleted'),
  'ALTER TABLE `biz_inbound_order` DROP INDEX `idx_biz_inbound_is_deleted`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  @replacement_indexes_ready AND EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'o2o_preorder_item' AND INDEX_NAME = 'idx_o2o_preorder_item_product_order'),
  'ALTER TABLE `o2o_preorder_item` DROP INDEX `idx_o2o_preorder_item_product_order`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
