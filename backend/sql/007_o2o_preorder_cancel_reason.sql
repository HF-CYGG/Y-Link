ALTER TABLE `o2o_preorder`
ADD COLUMN IF NOT EXISTS `cancel_reason` VARCHAR(16) NULL COMMENT '取消原因' AFTER `status`;
