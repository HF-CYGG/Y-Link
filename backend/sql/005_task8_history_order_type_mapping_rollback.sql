UPDATE `biz_outbound_order` AS o
INNER JOIN `task8_order_type_mapping_backup` AS b ON b.`order_id` = o.`id`
SET o.`order_type` = b.`order_type`;

DROP TABLE `task8_order_type_mapping_backup`;
