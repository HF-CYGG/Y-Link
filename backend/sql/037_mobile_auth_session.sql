-- Native Mobile 独立 Bearer 会话（MySQL 8.0/8.4 增量升级）。
-- 明文 access/refresh token 永不落库；当前/上一 refresh 摘要与 generation 支持原子轮换。

CREATE TABLE IF NOT EXISTS client_mobile_session (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  client_user_id bigint unsigned NOT NULL,
  device_id varchar(64) NOT NULL COMMENT '设备标签，不参与认证',
  device_name varchar(64) NULL,
  platform varchar(16) NOT NULL,
  app_version varchar(32) NULL,
  access_token_hash varchar(64) NOT NULL,
  access_expires_at datetime(6) NOT NULL,
  refresh_token_hash varchar(64) NOT NULL,
  refresh_expires_at datetime(6) NOT NULL,
  previous_refresh_token_hash varchar(64) NULL,
  previous_refresh_grace_until datetime(6) NULL,
  refresh_generation int unsigned NOT NULL DEFAULT 0,
  absolute_expires_at datetime(6) NOT NULL,
  last_ip varchar(64) NULL,
  last_access_at datetime(6) NOT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  revoked_at datetime(6) NULL,
  revoke_reason varchar(64) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_client_mobile_session_access_hash (access_token_hash),
  UNIQUE KEY uk_client_mobile_session_refresh_hash (refresh_token_hash),
  KEY idx_client_mobile_session_previous_refresh_hash (previous_refresh_token_hash),
  KEY idx_client_mobile_session_user_active (client_user_id, revoked_at, last_access_at),
  KEY idx_client_mobile_session_user_device (client_user_id, device_id),
  KEY idx_client_mobile_session_cleanup (revoked_at, absolute_expires_at, id),
  KEY idx_client_mobile_session_refresh_expiry (revoked_at, refresh_expires_at, id),
  CONSTRAINT fk_client_mobile_session_user FOREIGN KEY (client_user_id) REFERENCES client_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Native Mobile 独立会话与刷新血缘';
