-- =============================================
-- 文件说明：backend/sql/011_o2o_preorder_merchant_message.sql
-- 文件职责：为 O2O 预订单补充商家留言字段，支持管理端维护与客户端详情展示。
-- 维护说明：若留言长度上限调整，请同步更新实体定义、路由校验和服务层标准化逻辑。
-- =============================================

ALTER TABLE `o2o_preorder`
ADD COLUMN IF NOT EXISTS `merchant_message` VARCHAR(500) NULL COMMENT '商家留言' AFTER `business_status`;
