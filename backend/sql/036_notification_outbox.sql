-- 通知可靠 Outbox（MySQL 8.0/8.4 增量升级）
-- 目标：业务请求只落 notification_event；后台 Worker 通过 CAS 领取、有限重试并可恢复崩溃任务。

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_event' AND COLUMN_NAME = 'attempt_count') = 0,
  'ALTER TABLE notification_event ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 COMMENT ''后台处理已完成失败次数'' AFTER status',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_event' AND COLUMN_NAME = 'next_attempt_at') = 0,
  'ALTER TABLE notification_event ADD COLUMN next_attempt_at DATETIME(3) NULL COMMENT ''下次可重试时间'' AFTER attempt_count',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_event' AND COLUMN_NAME = 'processing_started_at') = 0,
  'ALTER TABLE notification_event ADD COLUMN processing_started_at DATETIME(3) NULL COMMENT ''当前领取开始时间'' AFTER next_attempt_at',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_event' AND COLUMN_NAME = 'processing_owner') = 0,
  'ALTER TABLE notification_event ADD COLUMN processing_owner VARCHAR(128) NULL COMMENT ''当前 Worker 实例标识'' AFTER processing_started_at',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_event' AND COLUMN_NAME = 'processed_at') = 0,
  'ALTER TABLE notification_event ADD COLUMN processed_at DATETIME(3) NULL COMMENT ''处理完成时间'' AFTER processing_owner',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_dispatch' AND COLUMN_NAME = 'dedupe_key') = 0,
  'ALTER TABLE notification_dispatch ADD COLUMN dedupe_key VARCHAR(64) NULL COMMENT ''外发目标去重摘要'' AFTER target',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_dispatch' AND COLUMN_NAME = 'last_attempt_at') = 0,
  'ALTER TABLE notification_dispatch ADD COLUMN last_attempt_at DATETIME(3) NULL COMMENT ''最近尝试时间'' AFTER sent_at',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 旧版同步路径可能为同一事件/账号留下重复收件箱：先把已读状态合并到最早记录，再清理重复项。
DROP TEMPORARY TABLE IF EXISTS `tmp_notification_inbox_dedupe`;
CREATE TEMPORARY TABLE `tmp_notification_inbox_dedupe` AS
SELECT
  `event_id`,
  `user_id`,
  MIN(`id`) AS `keeper_id`,
  MAX(`is_read`) AS `merged_is_read`,
  MAX(`read_at`) AS `merged_read_at`
FROM `notification_inbox`
GROUP BY `event_id`, `user_id`
HAVING COUNT(*) > 1;

UPDATE `notification_inbox` AS `keeper`
INNER JOIN `tmp_notification_inbox_dedupe` AS `merged`
  ON `keeper`.`id` = `merged`.`keeper_id`
SET
  `keeper`.`is_read` = `merged`.`merged_is_read`,
  `keeper`.`read_at` = `merged`.`merged_read_at`;

DELETE `duplicate`
FROM `notification_inbox` AS `duplicate`
INNER JOIN `tmp_notification_inbox_dedupe` AS `merged`
  ON `duplicate`.`event_id` = `merged`.`event_id`
 AND `duplicate`.`user_id` = `merged`.`user_id`
 AND `duplicate`.`id` <> `merged`.`keeper_id`;

DROP TEMPORARY TABLE IF EXISTS `tmp_notification_inbox_dedupe`;

-- 若升级在“补 dedupe_key”之后、“建唯一键”之前中断，新 Worker 可能已写入重复投递行。
-- 重跑时优先保留 sent 行；同等状态下保留最早记录，避免 CREATE UNIQUE INDEX 被 1062 阻断。
DROP TEMPORARY TABLE IF EXISTS `tmp_notification_dispatch_dedupe`;
CREATE TEMPORARY TABLE `tmp_notification_dispatch_dedupe` AS
SELECT
  `event_id`,
  `channel`,
  `dedupe_key`,
  COALESCE(
    MIN(CASE WHEN `status` = 'sent' THEN `id` END),
    MIN(`id`)
  ) AS `keeper_id`
FROM `notification_dispatch`
WHERE `dedupe_key` IS NOT NULL
GROUP BY `event_id`, `channel`, `dedupe_key`
HAVING COUNT(*) > 1;

DELETE `duplicate`
FROM `notification_dispatch` AS `duplicate`
INNER JOIN `tmp_notification_dispatch_dedupe` AS `merged`
  ON `duplicate`.`event_id` = `merged`.`event_id`
 AND `duplicate`.`channel` = `merged`.`channel`
 AND `duplicate`.`dedupe_key` = `merged`.`dedupe_key`
 AND `duplicate`.`id` <> `merged`.`keeper_id`;

DROP TEMPORARY TABLE IF EXISTS `tmp_notification_dispatch_dedupe`;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_event' AND INDEX_NAME = 'idx_notification_event_pending_claim') = 0,
  'CREATE INDEX idx_notification_event_pending_claim ON notification_event (status, next_attempt_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_event' AND INDEX_NAME = 'idx_notification_event_processing_recovery') = 0,
  'CREATE INDEX idx_notification_event_processing_recovery ON notification_event (status, processing_started_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_inbox' AND INDEX_NAME = 'uk_notification_inbox_event_user') = 0,
  'CREATE UNIQUE INDEX uk_notification_inbox_event_user ON notification_inbox (event_id, user_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- dedupe_key 对历史记录保持 NULL；新 Worker 写入 SHA-256 后由该唯一键防止重启/重试重复建投递记录。
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_dispatch' AND INDEX_NAME = 'uk_notification_dispatch_event_channel_target') = 0,
  'CREATE UNIQUE INDEX uk_notification_dispatch_event_channel_target ON notification_dispatch (event_id, channel, dedupe_key)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
