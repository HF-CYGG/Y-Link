-- =============================================
-- 文件说明：backend/sql/001_init_schema.sql
-- 文件职责：用于全新 MySQL 数据库初始化，创建后端运行所需的核心业务表、索引与默认配置。
-- 实现逻辑：
-- 1) 初始化商品、标签、用户、会话、审计、系统配置、出库、入库等基础表；
-- 2) 补齐常用索引与唯一约束，保证查询性能与业务唯一性；
-- 3) 初始化单双流水号相关系统配置，满足后续单号生成能力。
-- 维护说明：历史数据库升级请优先走增量迁移脚本，不建议直接对存量库重复执行全量初始化脚本。
-- =============================================

CREATE TABLE IF NOT EXISTS `base_product` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '产品主键',
  `product_code` VARCHAR(64) NOT NULL COMMENT '产品编码（业务唯一）',
  `product_name` VARCHAR(128) NOT NULL COMMENT '产品名称',
  `pinyin_abbr` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '拼音首字母检索字段',
  `default_price` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '默认单价',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_base_product_code` (`product_code`),
  KEY `idx_base_product_name` (`product_name`),
  KEY `idx_base_product_pinyin_abbr` (`pinyin_abbr`),
  KEY `idx_base_product_is_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='基础资料-产品表';

CREATE TABLE IF NOT EXISTS `base_tag` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '标签主键',
  `tag_name` VARCHAR(64) NOT NULL COMMENT '标签名称（唯一）',
  `tag_code` VARCHAR(64) DEFAULT NULL COMMENT '标签编码（可选，唯一）',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_base_tag_name` (`tag_name`),
  UNIQUE KEY `uk_base_tag_code` (`tag_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='基础资料-标签表';

CREATE TABLE IF NOT EXISTS `rel_product_tag` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '关系主键',
  `product_id` BIGINT UNSIGNED NOT NULL COMMENT '产品ID',
  `tag_id` BIGINT UNSIGNED NOT NULL COMMENT '标签ID',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_rel_product_tag` (`product_id`, `tag_id`),
  KEY `idx_rel_product_tag_tag_id_product_id` (`tag_id`, `product_id`),
  CONSTRAINT `fk_rel_product_tag_product_id` FOREIGN KEY (`product_id`) REFERENCES `base_product` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_rel_product_tag_tag_id` FOREIGN KEY (`tag_id`) REFERENCES `base_tag` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='产品标签关系表（多对多）';

CREATE TABLE IF NOT EXISTS `sys_user` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '用户主键',
  `username` VARCHAR(64) NOT NULL COMMENT '登录账号（唯一）',
  `password_hash` VARCHAR(255) NOT NULL COMMENT '密码哈希（salt:hash）',
  `display_name` VARCHAR(64) NOT NULL COMMENT '用户显示名称',
  `role` VARCHAR(32) NOT NULL DEFAULT 'operator' COMMENT '用户角色：admin/operator',
  `status` VARCHAR(32) NOT NULL DEFAULT 'enabled' COMMENT '用户状态：enabled/disabled',
  `last_login_at` DATETIME(3) DEFAULT NULL COMMENT '最后登录时间',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sys_user_username` (`username`),
  KEY `idx_sys_user_role` (`role`),
  KEY `idx_sys_user_status` (`status`),
  KEY `idx_sys_user_last_login_at` (`last_login_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统用户表';

CREATE TABLE IF NOT EXISTS `sys_user_session` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '会话主键',
  `session_token` VARCHAR(128) NOT NULL COMMENT 'Bearer 会话令牌',
  `user_id` BIGINT UNSIGNED NOT NULL COMMENT '所属用户ID',
  `expires_at` DATETIME(3) NOT NULL COMMENT '过期时间',
  `last_access_at` DATETIME(3) NOT NULL COMMENT '最后访问时间',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sys_user_session_token` (`session_token`),
  KEY `idx_sys_user_session_user_id` (`user_id`),
  KEY `idx_sys_user_session_expires_at` (`expires_at`),
  CONSTRAINT `fk_sys_user_session_user_id` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户登录会话表';

CREATE TABLE IF NOT EXISTS `sys_audit_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '审计日志主键',
  `action_type` VARCHAR(64) NOT NULL COMMENT '动作类型，如 auth.login / order.create',
  `action_label` VARCHAR(128) NOT NULL COMMENT '动作中文描述',
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '操作人ID',
  `actor_username` VARCHAR(64) DEFAULT NULL COMMENT '操作人账号快照',
  `actor_display_name` VARCHAR(64) DEFAULT NULL COMMENT '操作人姓名快照',
  `target_type` VARCHAR(64) NOT NULL COMMENT '目标类型，如 user / order / session',
  `target_id` VARCHAR(64) DEFAULT NULL COMMENT '目标主键',
  `target_code` VARCHAR(128) DEFAULT NULL COMMENT '目标业务标识，如账号/单号',
  `result_status` VARCHAR(32) NOT NULL DEFAULT 'success' COMMENT '执行结果：success/failed',
  `detail_json` LONGTEXT DEFAULT NULL COMMENT '关键上下文 JSON 文本',
  `ip_address` VARCHAR(64) DEFAULT NULL COMMENT '来源 IP',
  `user_agent` VARCHAR(255) DEFAULT NULL COMMENT '客户端 UA',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_sys_audit_log_action_type` (`action_type`),
  KEY `idx_sys_audit_log_actor_user_id` (`actor_user_id`),
  KEY `idx_sys_audit_log_target_type` (`target_type`),
  KEY `idx_sys_audit_log_target_id` (`target_id`),
  KEY `idx_sys_audit_log_result_status` (`result_status`),
  KEY `idx_sys_audit_log_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统审计日志表';

CREATE TABLE IF NOT EXISTS `system_configs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '配置主键',
  `config_key` VARCHAR(128) NOT NULL COMMENT '配置键',
  `config_value` VARCHAR(255) NOT NULL COMMENT '配置值',
  `config_group` VARCHAR(64) NOT NULL DEFAULT 'general' COMMENT '配置分组',
  `remark` VARCHAR(255) DEFAULT NULL COMMENT '备注',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_system_configs_config_key` (`config_key`),
  KEY `idx_system_configs_group` (`config_group`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统配置表';

CREATE TABLE IF NOT EXISTS `biz_outbound_order` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '出库主单ID',
  `order_uuid` CHAR(36) NOT NULL COMMENT '系统唯一UUID',
  `show_no` VARCHAR(32) NOT NULL COMMENT '业务展示单号（CK-YYYYMMDD-0001）',
  `order_type` VARCHAR(32) NOT NULL DEFAULT 'walkin' COMMENT '订单类型',
  `has_customer_order` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有客户订单',
  `is_system_applied` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否系统申请',
  `issuer_name` VARCHAR(64) DEFAULT NULL COMMENT '出单人',
  `customer_department_name` VARCHAR(128) DEFAULT NULL COMMENT '客户部门名称',
  `idempotency_key` VARCHAR(128) NOT NULL COMMENT '幂等键（防重复提交）',
  `customer_name` VARCHAR(128) DEFAULT NULL COMMENT '客户名称',
  `remark` VARCHAR(500) DEFAULT NULL COMMENT '备注',
  `total_qty` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '总数量',
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '总金额',
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已删除（软删除）',
  `deleted_at` DATETIME(3) DEFAULT NULL COMMENT '删除时间',
  `deleted_by_user_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '删除操作用户ID',
  `deleted_by_username` VARCHAR(64) DEFAULT NULL COMMENT '删除操作账号快照',
  `deleted_by_display_name` VARCHAR(64) DEFAULT NULL COMMENT '删除操作姓名快照',
  `creator_user_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '开单用户ID',
  `creator_username` VARCHAR(64) DEFAULT NULL COMMENT '开单账号快照',
  `creator_display_name` VARCHAR(64) DEFAULT NULL COMMENT '开单姓名快照',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_biz_outbound_order_uuid` (`order_uuid`),
  UNIQUE KEY `uk_biz_outbound_show_no_is_deleted` (`show_no`, `is_deleted`),
  UNIQUE KEY `uk_biz_outbound_idempotency_key` (`idempotency_key`),
  KEY `idx_biz_outbound_order_type` (`order_type`),
  KEY `idx_biz_outbound_order_type_created_at` (`order_type`, `created_at`),
  KEY `idx_biz_outbound_is_deleted` (`is_deleted`),
  KEY `idx_biz_outbound_deleted_by_user_id` (`deleted_by_user_id`),
  KEY `idx_biz_outbound_creator_user_id` (`creator_user_id`),
  KEY `idx_biz_outbound_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='出库主表';

CREATE TABLE IF NOT EXISTS `biz_outbound_order_item` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '出库明细ID',
  `order_id` BIGINT UNSIGNED NOT NULL COMMENT '主单ID',
  `line_no` INT NOT NULL COMMENT '行号（从1开始）',
  `product_id` BIGINT UNSIGNED NOT NULL COMMENT '产品ID',
  `product_name_snapshot` VARCHAR(128) NOT NULL COMMENT '产品名称快照',
  `qty` DECIMAL(12,2) NOT NULL COMMENT '数量',
  `unit_price` DECIMAL(12,2) NOT NULL COMMENT '单价',
  `line_amount` DECIMAL(14,2) NOT NULL COMMENT '行金额',
  `remark` VARCHAR(200) DEFAULT NULL COMMENT '行备注',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_biz_outbound_order_line` (`order_id`, `line_no`),
  KEY `idx_biz_outbound_item_product_id` (`product_id`),
  CONSTRAINT `fk_biz_outbound_item_order_id` FOREIGN KEY (`order_id`) REFERENCES `biz_outbound_order` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_biz_outbound_item_product_id` FOREIGN KEY (`product_id`) REFERENCES `base_product` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='出库明细表';

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

ALTER TABLE `biz_outbound_order`
  ADD COLUMN IF NOT EXISTS `creator_user_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '开单用户ID',
  ADD COLUMN IF NOT EXISTS `creator_username` VARCHAR(64) DEFAULT NULL COMMENT '开单账号快照',
  ADD COLUMN IF NOT EXISTS `creator_display_name` VARCHAR(64) DEFAULT NULL COMMENT '开单姓名快照',
  ADD COLUMN IF NOT EXISTS `is_deleted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已删除（软删除）',
  ADD COLUMN IF NOT EXISTS `deleted_at` DATETIME(3) DEFAULT NULL COMMENT '删除时间',
  ADD COLUMN IF NOT EXISTS `deleted_by_user_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '删除操作用户ID',
  ADD COLUMN IF NOT EXISTS `deleted_by_username` VARCHAR(64) DEFAULT NULL COMMENT '删除操作账号快照',
  ADD COLUMN IF NOT EXISTS `deleted_by_display_name` VARCHAR(64) DEFAULT NULL COMMENT '删除操作姓名快照',
  ADD COLUMN IF NOT EXISTS `order_type` VARCHAR(32) NOT NULL DEFAULT 'walkin' COMMENT '订单类型',
  ADD COLUMN IF NOT EXISTS `has_customer_order` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有客户订单',
  ADD COLUMN IF NOT EXISTS `is_system_applied` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否系统申请',
  ADD COLUMN IF NOT EXISTS `issuer_name` VARCHAR(64) DEFAULT NULL COMMENT '出单人',
  ADD COLUMN IF NOT EXISTS `customer_department_name` VARCHAR(128) DEFAULT NULL COMMENT '客户部门名称';

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
VALUES
  ('order.serial.department.start', '1', 'order_serial', '部门单号起始值'),
  ('order.serial.department.current', '0', 'order_serial', '部门单号当前值'),
  ('order.serial.department.width', '6', 'order_serial', '部门单号位宽'),
  ('order.serial.walkin.start', '1', 'order_serial', '散客单号起始值'),
  ('order.serial.walkin.current', '0', 'order_serial', '散客单号当前值'),
  ('order.serial.walkin.width', '6', 'order_serial', '散客单号位宽')
ON DUPLICATE KEY UPDATE
  `config_value` = VALUES(`config_value`),
  `config_group` = VALUES(`config_group`),
  `remark` = VALUES(`remark`);
