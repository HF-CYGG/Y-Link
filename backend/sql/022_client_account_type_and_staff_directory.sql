ALTER TABLE `client_user`
  ADD COLUMN IF NOT EXISTS `account_type` VARCHAR(16) NOT NULL DEFAULT 'personal' COMMENT '账号类型(personal/department)' AFTER `department_name`,
  ADD COLUMN IF NOT EXISTS `staff_no` VARCHAR(64) NULL COMMENT '教职工号' AFTER `account_type`,
  ADD COLUMN IF NOT EXISTS `staff_verified` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '工号是否通过目录校验' AFTER `staff_no`;

SET @add_client_user_staff_no_unique_index = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'client_user'
        AND INDEX_NAME = 'uk_client_user_staff_no'
    ),
    'SELECT 1',
    'ALTER TABLE `client_user` ADD UNIQUE KEY `uk_client_user_staff_no` (`staff_no`)'
  )
);
PREPARE stmt_add_client_user_staff_no_unique_index FROM @add_client_user_staff_no_unique_index;
EXECUTE stmt_add_client_user_staff_no_unique_index;
DEALLOCATE PREPARE stmt_add_client_user_staff_no_unique_index;

CREATE TABLE IF NOT EXISTS `client_staff_directory` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '教职工目录主键',
  `staff_no` VARCHAR(64) NOT NULL COMMENT '教职工号',
  `real_name` VARCHAR(128) NOT NULL COMMENT '真实姓名',
  `department_name` VARCHAR(128) NOT NULL COMMENT '所属部门',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT '目录状态(active/inactive)',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_client_staff_directory_staff_no` (`staff_no`),
  KEY `idx_client_staff_directory_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='客户端教职工目录';

ALTER TABLE `o2o_preorder`
  ADD COLUMN IF NOT EXISTS `staff_no_snapshot` VARCHAR(64) NULL COMMENT '下单时工号快照' AFTER `department_name_snapshot`;
