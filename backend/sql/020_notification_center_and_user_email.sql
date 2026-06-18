ALTER TABLE `sys_user`
  ADD COLUMN IF NOT EXISTS `email` VARCHAR(128) NULL COMMENT '邮箱地址（可空且唯一）' AFTER `display_name`,
  ADD UNIQUE KEY `uk_sys_user_email` (`email`);

CREATE TABLE IF NOT EXISTS `notification_rule` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '通知规则主键',
  `rule_code` VARCHAR(64) NOT NULL COMMENT '规则编码',
  `rule_name` VARCHAR(128) NOT NULL COMMENT '规则名称',
  `event_type` VARCHAR(64) NOT NULL COMMENT '事件类型',
  `enabled` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  `recipient_user_ids_json` TEXT NOT NULL COMMENT '接收账号 ID 列表(JSON)',
  `email_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否启用邮件提醒',
  `feishu_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否启用飞书提醒',
  `external_trigger_mode` VARCHAR(64) NOT NULL DEFAULT 'all_management_offline' COMMENT '外发触发模式',
  `watched_user_ids_json` TEXT NOT NULL COMMENT '监测账号 ID 列表(JSON)',
  `feishu_webhook_url` VARCHAR(500) NULL COMMENT '飞书群机器人 Webhook 地址',
  `email_subject_prefix` VARCHAR(128) NOT NULL DEFAULT '[Y-Link]' COMMENT '邮件主题前缀',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_notification_rule_code` (`rule_code`),
  KEY `idx_notification_rule_event_type` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通知规则表';

CREATE TABLE IF NOT EXISTS `notification_event` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '通知事件主键',
  `event_type` VARCHAR(64) NOT NULL COMMENT '事件类型',
  `source_type` VARCHAR(64) NOT NULL COMMENT '来源类型',
  `source_id` VARCHAR(128) NOT NULL COMMENT '来源业务 ID',
  `payload_json` TEXT NOT NULL COMMENT '事件载荷(JSON)',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '处理状态',
  `error_message` VARCHAR(500) NULL COMMENT '失败原因',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_notification_event_event_type` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通知事件表';

CREATE TABLE IF NOT EXISTS `notification_inbox` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '站内通知主键',
  `event_id` BIGINT UNSIGNED NOT NULL COMMENT '通知事件 ID',
  `user_id` BIGINT UNSIGNED NOT NULL COMMENT '接收账号 ID',
  `event_type` VARCHAR(64) NOT NULL COMMENT '事件类型',
  `title` VARCHAR(200) NOT NULL COMMENT '通知标题',
  `content` TEXT NOT NULL COMMENT '通知正文',
  `payload_json` TEXT NOT NULL COMMENT '通知快照(JSON)',
  `is_read` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已读',
  `read_at` DATETIME(3) NULL COMMENT '已读时间',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_notification_inbox_event_id` (`event_id`),
  KEY `idx_notification_inbox_user_id` (`user_id`),
  CONSTRAINT `fk_notification_inbox_event_id` FOREIGN KEY (`event_id`) REFERENCES `notification_event` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_notification_inbox_user_id` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='站内通知收件箱';

CREATE TABLE IF NOT EXISTS `notification_dispatch` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '外发记录主键',
  `event_id` BIGINT UNSIGNED NOT NULL COMMENT '通知事件 ID',
  `channel` VARCHAR(32) NOT NULL COMMENT '外发渠道(email/feishu)',
  `target` VARCHAR(500) NOT NULL COMMENT '外发目标',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '投递状态',
  `attempt_count` INT NOT NULL DEFAULT 0 COMMENT '尝试次数',
  `error_message` VARCHAR(500) NULL COMMENT '失败原因',
  `response_code` INT NULL COMMENT '响应状态码',
  `sent_at` DATETIME(3) NULL COMMENT '发送时间',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_notification_dispatch_event_id` (`event_id`),
  KEY `idx_notification_dispatch_channel` (`channel`),
  CONSTRAINT `fk_notification_dispatch_event_id` FOREIGN KEY (`event_id`) REFERENCES `notification_event` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通知外发记录表';

INSERT INTO `notification_rule` (
  `rule_code`,
  `rule_name`,
  `event_type`,
  `enabled`,
  `recipient_user_ids_json`,
  `email_enabled`,
  `feishu_enabled`,
  `external_trigger_mode`,
  `watched_user_ids_json`,
  `feishu_webhook_url`,
  `email_subject_prefix`
)
VALUES
  (
    'preorder_created_rule',
    '新预订单通知规则',
    'o2o_preorder_created',
    1,
    '[]',
    0,
    0,
    'all_management_offline',
    '[]',
    NULL,
    '[Y-Link]'
  ),
  (
    'customer_service_message_rule',
    '新客服消息通知规则',
    'customer_service_client_message_created',
    1,
    '[]',
    0,
    0,
    'all_management_offline',
    '[]',
    NULL,
    '[Y-Link]'
  )
ON DUPLICATE KEY UPDATE
  `rule_name` = VALUES(`rule_name`),
  `event_type` = VALUES(`event_type`);
