CREATE TABLE IF NOT EXISTS `task8_order_type_mapping_backup` (
  `order_id` BIGINT UNSIGNED NOT NULL,
  `order_type` VARCHAR(32) DEFAULT NULL,
  PRIMARY KEY (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Task8 历史订单类型映射回滚备份';

INSERT INTO `task8_order_type_mapping_backup` (`order_id`, `order_type`)
SELECT o.`id`, o.`order_type`
FROM `biz_outbound_order` AS o
LEFT JOIN `task8_order_type_mapping_backup` AS b ON b.`order_id` = o.`id`
WHERE b.`order_id` IS NULL;

UPDATE `biz_outbound_order`
SET `order_type` = CASE
  WHEN `order_type` IN ('department', 'walkin') THEN `order_type`
  WHEN `customer_department_name` IS NOT NULL AND TRIM(`customer_department_name`) <> '' THEN 'department'
  ELSE 'walkin'
END
WHERE `order_type` IS NULL
   OR `order_type` NOT IN ('department', 'walkin');
