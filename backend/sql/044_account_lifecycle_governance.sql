-- Issue #74：双账号域生命周期、RESTRICT 外键与不可变事件。
-- 所有增量列和外键均按 information_schema 判定，允许迁移连续重放。

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'deactivated_at') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `deactivated_at` DATETIME(6) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'deactivation_reason') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `deactivation_reason` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'deactivated_by_user_id') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `deactivated_by_user_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'deactivated_by_username') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `deactivated_by_username` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'deactivated_by_display_name') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `deactivated_by_display_name` VARCHAR(128) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'restored_at') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `restored_at` DATETIME(6) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'restored_by_user_id') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `restored_by_user_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'restored_by_username') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `restored_by_username` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'restored_by_display_name') = 0, 'ALTER TABLE `sys_user` ADD COLUMN `restored_by_display_name` VARCHAR(128) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'deactivated_at') = 0, 'ALTER TABLE `client_user` ADD COLUMN `deactivated_at` DATETIME(6) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'deactivation_reason') = 0, 'ALTER TABLE `client_user` ADD COLUMN `deactivation_reason` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'deactivated_by_user_id') = 0, 'ALTER TABLE `client_user` ADD COLUMN `deactivated_by_user_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'deactivated_by_username') = 0, 'ALTER TABLE `client_user` ADD COLUMN `deactivated_by_username` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'deactivated_by_display_name') = 0, 'ALTER TABLE `client_user` ADD COLUMN `deactivated_by_display_name` VARCHAR(128) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'restored_at') = 0, 'ALTER TABLE `client_user` ADD COLUMN `restored_at` DATETIME(6) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'restored_by_user_id') = 0, 'ALTER TABLE `client_user` ADD COLUMN `restored_by_user_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'restored_by_username') = 0, 'ALTER TABLE `client_user` ADD COLUMN `restored_by_username` VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'restored_by_display_name') = 0, 'ALTER TABLE `client_user` ADD COLUMN `restored_by_display_name` VARCHAR(128) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `account_lifecycle_event` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `account_domain` VARCHAR(16) NOT NULL,
  `account_id_snapshot` VARCHAR(64) NOT NULL,
  `account_masked_snapshot` VARCHAR(160) NOT NULL,
  `event_type` VARCHAR(32) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `actor_user_id_snapshot` VARCHAR(64) NULL,
  `actor_username_snapshot` VARCHAR(64) NOT NULL,
  `actor_display_name_snapshot` VARCHAR(64) NOT NULL,
  `reference_summary_json` LONGTEXT NOT NULL,
  `event_summary_json` LONGTEXT NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_account_lifecycle_event_account` (`account_domain`, `account_id_snapshot`, `id`),
  KEY `idx_account_lifecycle_event_created_at` (`created_at`, `id`),
  CONSTRAINT `ck_account_lifecycle_event_domain` CHECK (`account_domain` IN ('sys_user', 'client_user')),
  CONSTRAINT `ck_account_lifecycle_event_type` CHECK (`event_type` IN ('deactivated', 'restored', 'permanently_deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='不可变账号生命周期事件';

-- MySQL 不支持 CREATE TRIGGER IF NOT EXISTS；在迁移 advisory lock 内重建单语句触发器，确保可重放。
DROP TRIGGER IF EXISTS `trg_account_lifecycle_event_no_update`;
CREATE TRIGGER `trg_account_lifecycle_event_no_update` BEFORE UPDATE ON `account_lifecycle_event` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY';
DROP TRIGGER IF EXISTS `trg_account_lifecycle_event_no_delete`;
CREATE TRIGGER `trg_account_lifecycle_event_no_delete` BEFORE DELETE ON `account_lifecycle_event` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY';

-- 将指定账号关联列上的旧 CASCADE/错误规则改为 RESTRICT；没有外键时补齐。
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='sys_user_session' AND kcu.COLUMN_NAME='user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `sys_user_session` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='sys_user_session' AND kcu.COLUMN_NAME='user_id' AND kcu.REFERENCED_TABLE_NAME='sys_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `sys_user_session` ADD CONSTRAINT `fk_sys_user_session_user_id` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_user_session' AND kcu.COLUMN_NAME='user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `client_user_session` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_user_session' AND kcu.COLUMN_NAME='user_id' AND kcu.REFERENCED_TABLE_NAME='client_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `client_user_session` ADD CONSTRAINT `fk_client_user_session_user_id` FOREIGN KEY (`user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_mobile_session' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `client_mobile_session` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_mobile_session' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME='client_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `client_mobile_session` ADD CONSTRAINT `fk_client_mobile_session_user` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='notification_inbox' AND kcu.COLUMN_NAME='user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `notification_inbox` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='notification_inbox' AND kcu.COLUMN_NAME='user_id' AND kcu.REFERENCED_TABLE_NAME='sys_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `notification_inbox` ADD CONSTRAINT `fk_notification_inbox_user_id` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 以下表历史上只有索引或部分环境缺少外键；统一补为 RESTRICT。
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='biz_inbound_order' AND kcu.COLUMN_NAME='supplier_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `biz_inbound_order` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='biz_inbound_order' AND kcu.COLUMN_NAME='supplier_id' AND kcu.REFERENCED_TABLE_NAME='sys_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `biz_inbound_order` ADD CONSTRAINT `fk_biz_inbound_supplier_user` FOREIGN KEY (`supplier_id`) REFERENCES `sys_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='o2o_preorder' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `o2o_preorder` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='o2o_preorder' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME='client_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `o2o_preorder` ADD CONSTRAINT `fk_o2o_preorder_client_user` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='o2o_return_request' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `o2o_return_request` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='o2o_return_request' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME='client_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `o2o_return_request` ADD CONSTRAINT `fk_o2o_return_client_user` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_conversation' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `client_feedback_conversation` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_conversation' AND kcu.COLUMN_NAME='client_user_id' AND kcu.REFERENCED_TABLE_NAME='client_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `client_feedback_conversation` ADD CONSTRAINT `fk_feedback_conversation_client_user` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_conversation' AND kcu.COLUMN_NAME='assigned_user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `client_feedback_conversation` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_conversation' AND kcu.COLUMN_NAME='assigned_user_id' AND kcu.REFERENCED_TABLE_NAME='sys_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `client_feedback_conversation` ADD CONSTRAINT `fk_feedback_conversation_assigned_user` FOREIGN KEY (`assigned_user_id`) REFERENCES `sys_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_conversation' AND kcu.COLUMN_NAME='internal_remark_by_user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `client_feedback_conversation` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_conversation' AND kcu.COLUMN_NAME='internal_remark_by_user_id' AND kcu.REFERENCED_TABLE_NAME='sys_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `client_feedback_conversation` ADD CONSTRAINT `fk_feedback_conversation_remark_user` FOREIGN KEY (`internal_remark_by_user_id`) REFERENCES `sys_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @fk_name = (SELECT kcu.CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_attachment' AND kcu.COLUMN_NAME='owner_client_user_id' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND rc.DELETE_RULE<>'RESTRICT' LIMIT 1);
SET @ddl = IF(@fk_name IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `client_feedback_attachment` DROP FOREIGN KEY `', REPLACE(@fk_name, '`', '``'), '`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME=kcu.TABLE_NAME AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME WHERE kcu.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='client_feedback_attachment' AND kcu.COLUMN_NAME='owner_client_user_id' AND kcu.REFERENCED_TABLE_NAME='client_user' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')=0, 'ALTER TABLE `client_feedback_attachment` ADD CONSTRAINT `fk_feedback_attachment_owner` FOREIGN KEY (`owner_client_user_id`) REFERENCES `client_user` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
