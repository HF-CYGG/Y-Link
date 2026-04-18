-- =============================================
-- 文件说明：backend/sql/007_o2o_preorder_cancel_reason.sql
-- 文件职责：为 O2O 预订单补充取消原因字段，区分人工撤回与超时取消。
-- 维护说明：若取消原因枚举扩展，请同步更新实体、服务层状态报告与本脚本注释。
-- =============================================

ALTER TABLE `o2o_preorder`
ADD COLUMN IF NOT EXISTS `cancel_reason` VARCHAR(16) NULL COMMENT '取消原因' AFTER `status`;
