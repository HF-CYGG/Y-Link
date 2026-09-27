-- 056：停用业务号永久占用/管理员回收模型。
-- 业务号唯一性只由 biz_outbound_order.business_no 的唯一索引约束；物理删除主单即释放号码。
DROP TRIGGER IF EXISTS `trg_order_business_no_reuse_event_no_update`;
DROP TRIGGER IF EXISTS `trg_order_business_no_reuse_event_no_delete`;
DROP TABLE IF EXISTS `order_business_no_reuse_event`;
DROP TABLE IF EXISTS `order_business_no_occupancy`;
