-- =============================================
-- 文件说明：backend/sql/018_task4_business_field_constraints.sql
-- 文件职责：为 Task4 补齐商品与出库单关键字段的 MySQL 兜底约束，防止旁路写库或历史脚本写入非法数值。
-- 实现逻辑：
-- 1) 为商品表增加非负与库存关系约束；
-- 2) 为出库主表增加幂等键非空、总数量与总金额非负约束；
-- 3) 为出库明细增加行号、数量与单价的正数约束。
-- 维护说明：若后续调整商品库存、订单金额或明细结构，请同步更新服务层校验与本脚本。
-- =============================================

ALTER TABLE `base_product`
  ADD CONSTRAINT `ck_base_product_non_negative`
  CHECK (
    `default_price` >= 0
    AND `limit_per_user` >= 1
    AND `current_stock` >= 0
    AND `pre_ordered_stock` >= 0
    AND `pre_ordered_stock` <= `current_stock`
  );

ALTER TABLE `biz_outbound_order`
  ADD CONSTRAINT `ck_biz_outbound_order_amounts`
  CHECK (
    `total_qty` >= 0
    AND `total_amount` >= 0
    AND CHAR_LENGTH(TRIM(`idempotency_key`)) > 0
  );

ALTER TABLE `biz_outbound_order_item`
  ADD CONSTRAINT `ck_biz_outbound_order_item_positive`
  CHECK (
    `line_no` >= 1
    AND `qty` > 0
    AND `unit_price` > 0
    AND `line_amount` >= 0
  );
