-- =============================================
-- File: backend/sql/019_client_feedback_and_customer_service.sql
-- Purpose:
--   Add client feedback conversation/message tables and seed
--   customer service system configs for MySQL deployments.
--   The script is idempotent and safe to execute repeatedly.
-- =============================================

CREATE TABLE IF NOT EXISTS `client_feedback_conversation` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `conversation_no` varchar(48) NOT NULL COMMENT '反馈会话编号',
  `client_user_id` bigint unsigned NOT NULL COMMENT '客户端用户 ID',
  `client_username` varchar(128) NOT NULL COMMENT '客户端用户名快照',
  `client_account` varchar(128) NOT NULL COMMENT '客户端账号快照',
  `department_name_snapshot` varchar(128) NOT NULL DEFAULT '' COMMENT '客户端部门快照',
  `category` varchar(32) NOT NULL DEFAULT 'general' COMMENT '反馈分类',
  `order_ref` varchar(64) DEFAULT NULL COMMENT '关联订单号/业务单号',
  `subject` varchar(128) NOT NULL COMMENT '反馈主题',
  `expected_result` longtext NOT NULL COMMENT '期望结果描述',
  `actual_result` longtext NOT NULL COMMENT '实际结果描述',
  `reproduction_steps` longtext DEFAULT NULL COMMENT '复现步骤描述',
  `contact_preference` varchar(64) DEFAULT NULL COMMENT '联系偏好',
  `tag_json` longtext NOT NULL COMMENT '结构化问题标签 JSON 文本',
  `source_label` varchar(64) NOT NULL DEFAULT '客户端反馈页' COMMENT '反馈来源入口文案',
  `status` varchar(16) NOT NULL DEFAULT 'open' COMMENT '反馈会话状态',
  `priority` varchar(16) NOT NULL DEFAULT 'normal' COMMENT '反馈优先级',
  `assigned_user_id` bigint unsigned DEFAULT NULL COMMENT '当前处理客服 ID',
  `assigned_username` varchar(64) DEFAULT NULL COMMENT '当前处理客服账号快照',
  `assigned_display_name` varchar(64) DEFAULT NULL COMMENT '当前处理客服姓名快照',
  `last_message_preview` varchar(255) DEFAULT NULL COMMENT '最近一条消息摘要',
  `last_message_sender_type` varchar(16) NOT NULL DEFAULT 'client' COMMENT '最近消息发送方类型',
  `last_message_at` datetime(6) NOT NULL COMMENT '最近消息时间',
  `unread_for_client_count` int NOT NULL DEFAULT 0 COMMENT '客户端未读消息数',
  `unread_for_service_count` int NOT NULL DEFAULT 0 COMMENT '客服中心未读消息数',
  `closed_at` datetime(6) DEFAULT NULL COMMENT '关闭时间',
  `internal_remark` longtext DEFAULT NULL COMMENT '客服内部备注',
  `internal_remark_updated_at` datetime(6) DEFAULT NULL COMMENT '内部备注更新时间',
  `internal_remark_by_user_id` bigint unsigned DEFAULT NULL COMMENT '内部备注更新人 ID',
  `internal_remark_by_username` varchar(64) DEFAULT NULL COMMENT '内部备注更新人账号快照',
  `internal_remark_by_display_name` varchar(64) DEFAULT NULL COMMENT '内部备注更新人姓名快照',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_client_feedback_conversation_no` (`conversation_no`),
  KEY `idx_client_feedback_client_user_id` (`client_user_id`),
  KEY `idx_client_feedback_category` (`category`),
  KEY `idx_client_feedback_status` (`status`),
  KEY `idx_client_feedback_priority` (`priority`),
  KEY `idx_client_feedback_last_sender_type` (`last_message_sender_type`),
  KEY `idx_client_feedback_last_message_at` (`last_message_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户端反馈会话表';

CREATE TABLE IF NOT EXISTS `client_feedback_message` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `conversation_id` bigint unsigned NOT NULL COMMENT '所属反馈会话 ID',
  `sender_type` varchar(16) NOT NULL DEFAULT 'client' COMMENT '消息发送方类型',
  `sender_user_id` bigint unsigned DEFAULT NULL COMMENT '发送方用户 ID',
  `sender_name` varchar(128) DEFAULT NULL COMMENT '发送方名称快照',
  `message_type` varchar(16) NOT NULL DEFAULT 'text' COMMENT '消息类型',
  `content` longtext NOT NULL COMMENT '消息正文',
  `attachment_json` longtext NOT NULL COMMENT '消息附件 JSON 文本',
  `client_read_at` datetime(6) DEFAULT NULL COMMENT '客户端已读时间',
  `service_read_at` datetime(6) DEFAULT NULL COMMENT '客服中心已读时间',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_client_feedback_message_conversation_id` (`conversation_id`),
  KEY `idx_client_feedback_message_sender_type` (`sender_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户端反馈消息表';

ALTER TABLE `client_feedback_conversation`
  ADD COLUMN IF NOT EXISTS `order_ref` varchar(64) DEFAULT NULL COMMENT '关联订单号/业务单号' AFTER `category`,
  ADD COLUMN IF NOT EXISTS `expected_result` longtext NOT NULL COMMENT '期望结果描述' AFTER `subject`,
  ADD COLUMN IF NOT EXISTS `actual_result` longtext NOT NULL COMMENT '实际结果描述' AFTER `expected_result`,
  ADD COLUMN IF NOT EXISTS `reproduction_steps` longtext DEFAULT NULL COMMENT '复现步骤描述' AFTER `actual_result`,
  ADD COLUMN IF NOT EXISTS `contact_preference` varchar(64) DEFAULT NULL COMMENT '联系偏好' AFTER `reproduction_steps`,
  ADD COLUMN IF NOT EXISTS `tag_json` longtext NOT NULL COMMENT '结构化问题标签 JSON 文本' AFTER `contact_preference`,
  ADD COLUMN IF NOT EXISTS `source_label` varchar(64) NOT NULL DEFAULT '客户端反馈页' COMMENT '反馈来源入口文案' AFTER `tag_json`,
  ADD COLUMN IF NOT EXISTS `internal_remark` longtext DEFAULT NULL COMMENT '客服内部备注' AFTER `closed_at`,
  ADD COLUMN IF NOT EXISTS `internal_remark_updated_at` datetime(6) DEFAULT NULL COMMENT '内部备注更新时间' AFTER `internal_remark`,
  ADD COLUMN IF NOT EXISTS `internal_remark_by_user_id` bigint unsigned DEFAULT NULL COMMENT '内部备注更新人 ID' AFTER `internal_remark_updated_at`,
  ADD COLUMN IF NOT EXISTS `internal_remark_by_username` varchar(64) DEFAULT NULL COMMENT '内部备注更新人账号快照' AFTER `internal_remark_by_user_id`,
  ADD COLUMN IF NOT EXISTS `internal_remark_by_display_name` varchar(64) DEFAULT NULL COMMENT '内部备注更新人姓名快照' AFTER `internal_remark_by_username`;

ALTER TABLE `client_feedback_message`
  ADD COLUMN IF NOT EXISTS `attachment_json` longtext NOT NULL COMMENT '消息附件 JSON 文本' AFTER `content`;

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.enabled', '1', 'customer_service', '客户端反馈入口启用开关'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.enabled'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.realtime_enabled', '1', 'customer_service', '客服中心实时通道启用开关'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.realtime_enabled'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.entry_notice', '客服中心工作时间内会尽快回复，请尽量描述问题现象、时间和影响范围。', 'customer_service', '客户端反馈入口提示语'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.entry_notice'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.workday_start', '09:00', 'customer_service', '客服工作开始时间'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.workday_start'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.workday_end', '18:00', 'customer_service', '客服工作结束时间'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.workday_end'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.workday_weekdays', '[1,2,3,4,5]', 'customer_service', '客服工作日配置(JSON 数组，0=周日，6=周六)'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.workday_weekdays'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.offline_notice', '当前客服暂时离线，您仍可提交问题，我们会在工作时间优先处理。', 'customer_service', '客服离线提示语'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.offline_notice'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.offline_faq_json', '[{"question":"客服什么时候在线？","answer":"默认工作时间为周一至周五 09:00-18:00。"},{"question":"离线时提交的问题会丢失吗？","answer":"不会，系统会保留完整会话记录，客服上线后继续跟进。"}]', 'customer_service', '客服离线 FAQ(JSON)'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.offline_faq_json'
);

INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT 'customer_service.sse_keepalive_seconds', '20', 'customer_service', '客服中心 SSE 心跳间隔（秒）'
WHERE NOT EXISTS (
  SELECT 1
  FROM `system_configs`
  WHERE `config_key` = 'customer_service.sse_keepalive_seconds'
);
