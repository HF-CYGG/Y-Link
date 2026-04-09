ALTER TABLE `base_product`
  ADD COLUMN `o2o_status` VARCHAR(16) NOT NULL DEFAULT 'unlisted' COMMENT '线上预订状态',
  ADD COLUMN `thumbnail` VARCHAR(255) NULL COMMENT '预览图地址',
  ADD COLUMN `detail_content` TEXT NULL COMMENT '商品详情',
  ADD COLUMN `limit_per_user` INT NOT NULL DEFAULT 5 COMMENT '单人限购数量',
  ADD COLUMN `current_stock` INT NOT NULL DEFAULT 0 COMMENT '物理库存',
  ADD COLUMN `pre_ordered_stock` INT NOT NULL DEFAULT 0 COMMENT '已预订库存';

CREATE TABLE IF NOT EXISTS `client_user` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `mobile` VARCHAR(20) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `real_name` VARCHAR(64) NOT NULL,
  `department_name` VARCHAR(128) NOT NULL DEFAULT '',
  `status` VARCHAR(16) NOT NULL DEFAULT 'enabled',
  `last_login_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_client_user_mobile` (`mobile`)
);

CREATE TABLE IF NOT EXISTS `client_user_session` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_token` VARCHAR(128) NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `last_access_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_client_user_session_token` (`session_token`),
  KEY `idx_client_user_session_user_id` (`user_id`)
);

CREATE TABLE IF NOT EXISTS `o2o_preorder` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `show_no` VARCHAR(48) NOT NULL,
  `client_user_id` BIGINT UNSIGNED NOT NULL,
  `verify_code` VARCHAR(64) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `total_qty` INT NOT NULL DEFAULT 0,
  `remark` VARCHAR(255) NULL,
  `timeout_at` DATETIME(3) NULL,
  `verified_at` DATETIME(3) NULL,
  `verified_by` VARCHAR(64) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_o2o_preorder_show_no` (`show_no`),
  UNIQUE KEY `uk_o2o_preorder_verify_code` (`verify_code`),
  KEY `idx_o2o_preorder_client_user_id` (`client_user_id`)
);

CREATE TABLE IF NOT EXISTS `o2o_preorder_item` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `qty` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_o2o_preorder_item_order_id` (`order_id`),
  KEY `idx_o2o_preorder_item_product_id` (`product_id`)
);

CREATE TABLE IF NOT EXISTS `inventory_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `change_type` VARCHAR(32) NOT NULL,
  `change_qty` INT NOT NULL,
  `before_current_stock` INT NOT NULL DEFAULT 0,
  `after_current_stock` INT NOT NULL DEFAULT 0,
  `before_preordered_stock` INT NOT NULL DEFAULT 0,
  `after_preordered_stock` INT NOT NULL DEFAULT 0,
  `operator_type` VARCHAR(32) NOT NULL DEFAULT 'system',
  `operator_id` VARCHAR(64) NULL,
  `operator_name` VARCHAR(128) NULL,
  `ref_type` VARCHAR(32) NULL,
  `ref_id` VARCHAR(64) NULL,
  `remark` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_inventory_log_product_id` (`product_id`)
);
