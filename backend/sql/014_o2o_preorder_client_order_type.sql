-- =============================================
-- 文件说明：backend/sql/014_o2o_preorder_client_order_type.sql
-- 文件职责：为 O2O 预订单补充客户端下单归属类型与部门快照，支持区分“部门订 / 散客”。
-- 维护说明：若调整下单归属枚举或前端展示口径，请同步更新实体、服务返回结构与客户端页面。
-- =============================================

ALTER TABLE o2o_preorder
  ADD COLUMN client_order_type VARCHAR(16) NOT NULL DEFAULT 'walkin' COMMENT '客户端下单归属类型',
  ADD COLUMN department_name_snapshot VARCHAR(128) NULL COMMENT '下单时部门名称快照';
