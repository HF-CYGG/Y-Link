-- =============================================
-- 文件说明：backend/sql/005_task8_history_order_type_mapping_rollback.sql
-- 文件职责：回滚 Task8 历史订单类型映射，将 order_type 恢复为备份表中的旧值。
-- 维护说明：仅在 004 脚本已执行且备份表仍存在时使用，执行后会删除回滚备份表。
-- =============================================

UPDATE `biz_outbound_order` AS o
INNER JOIN `task8_order_type_mapping_backup` AS b ON b.`order_id` = o.`id`
SET o.`order_type` = b.`order_type`;

DROP TABLE `task8_order_type_mapping_backup`;
