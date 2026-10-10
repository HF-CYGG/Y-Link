-- 管理端通行密钥兼容升级：旧凭据继续作为免密登录，旧 TOTP 与恢复码原值保留。
-- MySQL DDL 非事务性；每一步先检查当前结构，可在失败后安全重放。

SET @ylink_mfa_factor_revision_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user_mfa' AND COLUMN_NAME = 'factor_revision'
);
SET @ylink_mfa_factor_revision_ddl = IF(
  @ylink_mfa_factor_revision_exists = 0,
  'ALTER TABLE `sys_user_mfa` ADD COLUMN `factor_revision` INT NOT NULL DEFAULT 1 COMMENT ''第二因素配置版本''',
  'SELECT 1'
);
PREPARE ylink_mfa_factor_revision_stmt FROM @ylink_mfa_factor_revision_ddl;
EXECUTE ylink_mfa_factor_revision_stmt;
DEALLOCATE PREPARE ylink_mfa_factor_revision_stmt;

SET @ylink_mfa_totp_not_null = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user_mfa'
    AND COLUMN_NAME = 'totp_secret_sealed' AND IS_NULLABLE = 'NO'
);
SET @ylink_mfa_totp_nullable_ddl = IF(
  @ylink_mfa_totp_not_null > 0,
  'ALTER TABLE `sys_user_mfa` MODIFY COLUMN `totp_secret_sealed` VARCHAR(255) NULL COMMENT ''TOTP 秘钥密文（AES-256-GCM）；仅通行密钥用户可为空''',
  'SELECT 1'
);
PREPARE ylink_mfa_totp_nullable_stmt FROM @ylink_mfa_totp_nullable_ddl;
EXECUTE ylink_mfa_totp_nullable_stmt;
DEALLOCATE PREPARE ylink_mfa_totp_nullable_stmt;

SET @ylink_webauthn_usage_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user_webauthn_credential' AND COLUMN_NAME = 'usage'
);
SET @ylink_webauthn_usage_ddl = IF(
  @ylink_webauthn_usage_exists = 0,
  'ALTER TABLE `sys_user_webauthn_credential` ADD COLUMN `usage` VARCHAR(16) NOT NULL DEFAULT ''passwordless'' COMMENT ''凭据用途：免密登录或密码登录第二因素''',
  'SELECT 1'
);
PREPARE ylink_webauthn_usage_stmt FROM @ylink_webauthn_usage_ddl;
EXECUTE ylink_webauthn_usage_stmt;
DEALLOCATE PREPARE ylink_webauthn_usage_stmt;
