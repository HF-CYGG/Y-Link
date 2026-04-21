-- =============================================
-- 文件说明：backend/sql/010_optimize_o2o_preorder_query_indexes.sql
-- 文件职责：为 O2O 客户端订单条件分页与超时回收路径补齐复合索引，降低过滤查询全表扫描风险。
-- 维护说明：若后续调整 `/o2o/mall/preorders` 或超时取消查询条件，请同步评估该索引是否仍命中。
-- =============================================

ALTER TABLE `o2o_preorder`
  ADD INDEX `idx_o2o_preorder_client_id` (`client_user_id`, `id`),
  ADD INDEX `idx_o2o_preorder_client_status_id` (`client_user_id`, `status`, `id`),
  ADD INDEX `idx_o2o_preorder_status_timeout_at` (`status`, `timeout_at`);
