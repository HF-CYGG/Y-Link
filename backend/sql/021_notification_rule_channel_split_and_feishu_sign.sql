ALTER TABLE `notification_rule`
  ADD COLUMN IF NOT EXISTS `email_recipient_admin_user_ids_json` TEXT NULL COMMENT '邮件接收账号（admin/operator）ID 列表(JSON)' AFTER `recipient_user_ids_json`,
  ADD COLUMN IF NOT EXISTS `email_recipient_supplier_user_ids_json` TEXT NULL COMMENT '邮件接收账号（supplier）ID 列表(JSON)' AFTER `email_recipient_admin_user_ids_json`,
  ADD COLUMN IF NOT EXISTS `feishu_sign_secret` VARCHAR(256) NULL COMMENT '飞书群机器人签名密钥' AFTER `feishu_webhook_url`;

UPDATE `notification_rule` AS `rule`
SET
  `email_recipient_admin_user_ids_json` = COALESCE(
    (
      SELECT JSON_ARRAYAGG(CAST(`user`.`id` AS CHAR))
      FROM JSON_TABLE(
        `rule`.`recipient_user_ids_json`,
        '$[*]' COLUMNS (
          `user_id` VARCHAR(64) PATH '$'
        )
      ) AS `parsed`
      INNER JOIN `sys_user` AS `user`
        ON CAST(`user`.`id` AS CHAR) = `parsed`.`user_id`
      WHERE `user`.`role` IN ('admin', 'operator')
    ),
    '[]'
  ),
  `email_recipient_supplier_user_ids_json` = COALESCE(
    (
      SELECT JSON_ARRAYAGG(CAST(`user`.`id` AS CHAR))
      FROM JSON_TABLE(
        `rule`.`recipient_user_ids_json`,
        '$[*]' COLUMNS (
          `user_id` VARCHAR(64) PATH '$'
        )
      ) AS `parsed`
      INNER JOIN `sys_user` AS `user`
        ON CAST(`user`.`id` AS CHAR) = `parsed`.`user_id`
      WHERE `user`.`role` = 'supplier'
    ),
    '[]'
  )
WHERE
  (`rule`.`email_recipient_admin_user_ids_json` IS NULL OR `rule`.`email_recipient_admin_user_ids_json` = '' OR `rule`.`email_recipient_admin_user_ids_json` = '[]')
  AND (`rule`.`email_recipient_supplier_user_ids_json` IS NULL OR `rule`.`email_recipient_supplier_user_ids_json` = '' OR `rule`.`email_recipient_supplier_user_ids_json` = '[]');

UPDATE `notification_rule`
SET
  `email_recipient_admin_user_ids_json` = COALESCE(NULLIF(`email_recipient_admin_user_ids_json`, ''), '[]'),
  `email_recipient_supplier_user_ids_json` = COALESCE(NULLIF(`email_recipient_supplier_user_ids_json`, ''), '[]');

ALTER TABLE `notification_rule`
  MODIFY COLUMN `email_recipient_admin_user_ids_json` TEXT NOT NULL COMMENT '邮件接收账号（admin/operator）ID 列表(JSON)',
  MODIFY COLUMN `email_recipient_supplier_user_ids_json` TEXT NOT NULL COMMENT '邮件接收账号（supplier）ID 列表(JSON)';
