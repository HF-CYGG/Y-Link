-- 管理端 WebAuthn：不可变随机用户句柄与独立凭据表。
-- 仅写结构，不回填旧账号；首次绑定时在账号锁内生成 32 字节随机句柄。
-- 幂等：列/索引由 information_schema 判断后补建，凭据表 CREATE TABLE IF NOT EXISTS。

SET @ylink_webauthn_handle_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'webauthn_user_handle'
);
SET @ylink_webauthn_handle_ddl = IF(
  @ylink_webauthn_handle_exists = 0,
  'ALTER TABLE `sys_user` ADD COLUMN `webauthn_user_handle` VARCHAR(64) NULL COMMENT ''不可变随机 WebAuthn 用户句柄（32 字节小写十六进制）''',
  'SELECT 1'
);
PREPARE ylink_webauthn_handle_stmt FROM @ylink_webauthn_handle_ddl;
EXECUTE ylink_webauthn_handle_stmt;
DEALLOCATE PREPARE ylink_webauthn_handle_stmt;

SET @ylink_webauthn_handle_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND INDEX_NAME = 'uk_sys_user_webauthn_user_handle'
);
SET @ylink_webauthn_handle_index_ddl = IF(
  @ylink_webauthn_handle_index_exists = 0,
  'ALTER TABLE `sys_user` ADD UNIQUE KEY `uk_sys_user_webauthn_user_handle` (`webauthn_user_handle`)',
  'SELECT 1'
);
PREPARE ylink_webauthn_handle_index_stmt FROM @ylink_webauthn_handle_index_ddl;
EXECUTE ylink_webauthn_handle_index_stmt;
DEALLOCATE PREPARE ylink_webauthn_handle_index_stmt;

CREATE TABLE IF NOT EXISTS `sys_user_webauthn_credential` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `rp_id` VARCHAR(253) NOT NULL,
  `credential_id_sha256` VARCHAR(64) NOT NULL,
  `credential_id` BLOB NOT NULL,
  `public_key` BLOB NOT NULL,
  `counter` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `transports_json` VARCHAR(512) NULL,
  `device_type` VARCHAR(32) NOT NULL,
  `backed_up` TINYINT(1) NOT NULL DEFAULT 0,
  `name` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `last_used_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sys_user_webauthn_credential_user_id` (`user_id`),
  UNIQUE KEY `uk_sys_user_webauthn_rp_credential_sha256` (`rp_id`, `credential_id_sha256`),
  CONSTRAINT `fk_sys_user_webauthn_credential_user_id` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='管理端 WebAuthn 通行密钥凭据';
