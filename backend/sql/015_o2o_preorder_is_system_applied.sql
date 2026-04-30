-- =============================================
-- 文件说明：backend/sql/015_o2o_preorder_is_system_applied.sql
-- 文件职责：为 O2O 预订单补充“是否系统申请”字段，承接客户端必填选择并用于核销后出库单落库。
-- 维护说明：若后续调整字段默认值或语义，请同步更新实体 `o2o-preorder.entity.ts` 与路由提交校验。
-- =============================================

ALTER TABLE `o2o_preorder`
  ADD COLUMN `is_system_applied` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否系统申请（客户端选择快照）'
  AFTER `department_name_snapshot`;
