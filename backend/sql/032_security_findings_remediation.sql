-- Y-Link 15 项安全发现修复：MySQL 8.0 结构迁移。
-- 生产执行前请先备份；历史联系方式按产品决策统一保持未验证。

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_staff_directory' AND COLUMN_NAME = 'invite_code_digest') = 0, 'ALTER TABLE client_staff_directory ADD COLUMN invite_code_digest VARCHAR(64) NULL COMMENT ''HMAC-SHA-256 邀请码摘要''', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_staff_directory' AND COLUMN_NAME = 'invite_issued_at') = 0, 'ALTER TABLE client_staff_directory ADD COLUMN invite_issued_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_staff_directory' AND COLUMN_NAME = 'invite_expires_at') = 0, 'ALTER TABLE client_staff_directory ADD COLUMN invite_expires_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_staff_directory' AND COLUMN_NAME = 'invite_used_at') = 0, 'ALTER TABLE client_staff_directory ADD COLUMN invite_used_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_staff_directory' AND COLUMN_NAME = 'invite_failed_attempts') = 0, 'ALTER TABLE client_staff_directory ADD COLUMN invite_failed_attempts INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_staff_directory' AND COLUMN_NAME = 'invite_locked_until') = 0, 'ALTER TABLE client_staff_directory ADD COLUMN invite_locked_until DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'mobile_verified_at') = 0, 'ALTER TABLE client_user ADD COLUMN mobile_verified_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'email_verified_at') = 0, 'ALTER TABLE client_user ADD COLUMN email_verified_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE client_user SET mobile_verified_at = NULL, email_verified_at = NULL;

CREATE TABLE IF NOT EXISTS client_feedback_attachment (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_client_user_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NULL,
  message_id BIGINT UNSIGNED NULL,
  storage_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NULL,
  size_bytes INT NULL,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_client_feedback_attachment_owner (owner_client_user_id),
  KEY idx_client_feedback_attachment_conversation (conversation_id),
  KEY idx_client_feedback_attachment_expires (expires_at),
  CONSTRAINT fk_feedback_attachment_owner FOREIGN KEY (owner_client_user_id) REFERENCES client_user(id),
  CONSTRAINT fk_feedback_attachment_conversation FOREIGN KEY (conversation_id) REFERENCES client_feedback_conversation(id),
  CONSTRAINT fk_feedback_attachment_message FOREIGN KEY (message_id) REFERENCES client_feedback_message(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
