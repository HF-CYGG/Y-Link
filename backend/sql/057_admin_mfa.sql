-- 管理端 TOTP 两步验证（自愿开启）。
-- 结构：一个管理端账号至多一行，存在即表示已开启；user_id 唯一并以 RESTRICT 外键指向 sys_user，
--       永久删除账号时由服务层在同一事务内先删除本行。
--   - totp_secret_sealed：TOTP 秘钥的 AES-256-GCM 密文（ylenc:v1:...），AAD 绑定账号 ID；
--   - recovery_codes_json：未使用恢复码的 HMAC-SHA256 摘要列表，恢复码明文只在生成时返回一次；
--   - last_used_step：最近一次成功使用的 TOTP 时间步，只能单调推进，防止同一动态码重放。
-- 幂等：CREATE TABLE IF NOT EXISTS 可安全重放；外键随建表一次创建。
-- 环境说明：本文件只面向 MySQL；SQLite 由实体同步建表（database-bootstrap.ts 的 SQLITE_REQUIRED_TABLES）。

CREATE TABLE IF NOT EXISTS `sys_user_mfa` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL COMMENT '管理端账号ID（一人一行）',
  `totp_secret_sealed` VARCHAR(255) NOT NULL COMMENT 'TOTP 秘钥密文（AES-256-GCM）',
  `recovery_codes_json` TEXT NOT NULL COMMENT '未使用恢复码的 HMAC-SHA256 摘要列表（JSON）',
  `enabled_at` DATETIME(6) NOT NULL COMMENT '开启时间',
  `last_used_step` INT NULL COMMENT '最近一次成功使用的 TOTP 时间步（防重放）',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sys_user_mfa_user_id` (`user_id`),
  CONSTRAINT `fk_sys_user_mfa_user_id` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='管理端 TOTP 两步验证';
