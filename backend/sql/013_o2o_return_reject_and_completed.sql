-- =============================================
-- 文件说明：backend/sql/013_o2o_return_reject_and_completed.sql
-- 文件职责：为 O2O 退货申请补充拒绝处理字段，并兼容“已完结（交易结束）”商家状态扩展。
-- 维护说明：若后续继续扩展退货结果或处理轨迹，请同步更新实体、服务层、路由校验与 SQLite bootstrap 检查项。
-- =============================================

ALTER TABLE `o2o_return_request`
ADD COLUMN IF NOT EXISTS `handled_at` DATETIME(3) NULL COMMENT '处理时间' AFTER `total_qty`;

ALTER TABLE `o2o_return_request`
ADD COLUMN IF NOT EXISTS `handled_by` VARCHAR(64) NULL COMMENT '处理人' AFTER `handled_at`;

ALTER TABLE `o2o_return_request`
ADD COLUMN IF NOT EXISTS `rejected_reason` VARCHAR(500) NULL COMMENT '拒绝原因' AFTER `handled_by`;

-- 历史“已回库”记录补齐统一处理轨迹，便于后续详情与审计按同一字段展示。
UPDATE `o2o_return_request`
SET
  `handled_at` = COALESCE(`handled_at`, `verified_at`),
  `handled_by` = COALESCE(`handled_by`, `verified_by`)
WHERE `status` = 'verified';
