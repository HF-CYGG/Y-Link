-- 阿里云 PNVS 短信验证码受理与 MNS 回执表：只保存脱敏手机号与 HMAC 摘要，绝不落验证码或完整手机号。
CREATE TABLE IF NOT EXISTS `sms_verification_record` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `out_id` VARCHAR(64) NOT NULL COMMENT '阿里云请求外部幂等标识',
  `biz_id` VARCHAR(128) NULL COMMENT '阿里云业务标识',
  `channel` VARCHAR(16) NOT NULL DEFAULT 'mobile' COMMENT '验证码通道',
  `scene` VARCHAR(32) NOT NULL COMMENT '验证码业务场景',
  `scheme_name` VARCHAR(20) NOT NULL DEFAULT '' COMMENT '发送时的阿里云方案名称',
  `target_digest` CHAR(64) NOT NULL COMMENT '手机号 HMAC 摘要',
  `target_masked` VARCHAR(32) NOT NULL COMMENT '脱敏手机号展示值',
  `send_status` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '发送受理状态',
  `delivery_status` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '短信回执状态',
  `verification_status` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '验证码核验状态',
  `provider_error_code` VARCHAR(128) NULL COMMENT '平台错误码',
  `provider_error_message` VARCHAR(500) NULL COMMENT '脱敏平台错误信息',
  `sent_at` DATETIME(6) NULL COMMENT '发送受理时间',
  `reported_at` DATETIME(6) NULL COMMENT 'MNS 回执时间',
  `verified_at` DATETIME(6) NULL COMMENT '核验成功时间',
  `expires_at` DATETIME(6) NOT NULL COMMENT '验证码到期时间',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl = CASE WHEN (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sms_verification_record' AND COLUMN_NAME = 'scheme_name') = 0
  THEN 'ALTER TABLE `sms_verification_record` ADD COLUMN `scheme_name` VARCHAR(20) NOT NULL DEFAULT '''' COMMENT ''发送时的阿里云方案名称'' AFTER `scene`' ELSE 'SELECT 1' END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = CASE WHEN (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sms_verification_record' AND INDEX_NAME = 'uk_sms_verification_record_out_id') = 0
  THEN 'CREATE UNIQUE INDEX `uk_sms_verification_record_out_id` ON `sms_verification_record` (`out_id`)' ELSE 'SELECT 1' END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = CASE WHEN (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sms_verification_record' AND INDEX_NAME = 'idx_sms_verification_record_lookup') = 0
  THEN 'CREATE INDEX `idx_sms_verification_record_lookup` ON `sms_verification_record` (`channel`, `scene`, `target_digest`, `expires_at`)' ELSE 'SELECT 1' END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = CASE WHEN (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sms_verification_record' AND INDEX_NAME = 'idx_sms_verification_record_retention') = 0
  THEN 'CREATE INDEX `idx_sms_verification_record_retention` ON `sms_verification_record` (`created_at`)' ELSE 'SELECT 1' END;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
