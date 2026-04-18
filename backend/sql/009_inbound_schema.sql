-- =============================================
-- 文件说明：backend/sql/009_inbound_schema.sql
-- 文件职责：为既有 MySQL 数据库补齐入库单与入库明细表结构，供供应商送货与库管核销流程使用。
-- 实现逻辑：
-- 1) 创建入库主单表，记录供货方、核销码、核销人和状态快照；
-- 2) 创建入库明细表，并通过外键约束绑定入库主单与商品；
-- 3) 保持幂等执行，避免重复执行迁移时出现建表报错。
-- =============================================

CREATE TABLE IF NOT EXISTS `biz_inbound_order` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '入库主单ID',
  `show_no` VARCHAR(48) NOT NULL COMMENT '业务展示单号（INYYYYMMDD0001）',
  `verify_code` VARCHAR(64) NOT NULL COMMENT '二维码核销码',
  `supplier_id` BIGINT UNSIGNED NOT NULL COMMENT '供货方用户ID',
  `supplier_name` VARCHAR(128) DEFAULT NULL COMMENT '供货方名称快照',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '单据状态：pending/verified/cancelled',
  `total_qty` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '总数量',
  `remark` VARCHAR(255) DEFAULT NULL COMMENT '供货方备注',
  `verified_at` DATETIME(3) DEFAULT NULL COMMENT '核销入库时间',
  `verified_by_user_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '核销操作人ID',
  `verified_by_username` VARCHAR(64) DEFAULT NULL COMMENT '核销操作人账号快照',
  `verified_by_display_name` VARCHAR(128) DEFAULT NULL COMMENT '核销操作人姓名快照',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_biz_inbound_show_no` (`show_no`),
  UNIQUE KEY `uk_biz_inbound_verify_code` (`verify_code`),
  KEY `idx_biz_inbound_supplier_id` (`supplier_id`),
  KEY `idx_biz_inbound_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='入库主表';

CREATE TABLE IF NOT EXISTS `biz_inbound_order_item` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '入库明细ID',
  `order_id` BIGINT UNSIGNED NOT NULL COMMENT '入库主单ID',
  `product_id` BIGINT UNSIGNED NOT NULL COMMENT '商品ID',
  `product_name_snapshot` VARCHAR(255) NOT NULL COMMENT '商品名称快照',
  `qty` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '入库数量',
  PRIMARY KEY (`id`),
  KEY `idx_biz_inbound_item_order_id` (`order_id`),
  KEY `idx_biz_inbound_item_product_id` (`product_id`),
  CONSTRAINT `fk_biz_inbound_item_order_id` FOREIGN KEY (`order_id`) REFERENCES `biz_inbound_order` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_biz_inbound_item_product_id` FOREIGN KEY (`product_id`) REFERENCES `base_product` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='入库明细表';
