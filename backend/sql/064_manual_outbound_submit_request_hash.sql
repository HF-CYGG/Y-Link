-- 仅为新手工出库单保存首次提交摘要。旧单快照可编辑，保留 NULL，禁止推算原请求。
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'submit_request_hash') = 0,
  'ALTER TABLE `biz_outbound_order` ADD COLUMN `submit_request_hash` VARCHAR(64) NULL COMMENT ''手工出库首次提交摘要''', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
