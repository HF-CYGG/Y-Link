-- Issue #110 扩展：正式出库单、O2O 预订单与永久业务号拆分独立命名空间。
-- 只初始化配置和并发流水高水位；历史 show_no/business_no 原值均不改写。

-- 只有 start/current/width 三项都存在才算完成首迁；部分新配置必须继续安全领养缺失 shape 和 legacy 高水位。
-- sequence 可能被早期 bootstrap 先行创建，不能因此丢失历史 start/width/current。
SET @order_business_department_config_complete = (
  SELECT COUNT(1)
  FROM `system_configs`
  WHERE `config_key` IN (
    'order.business.department.start',
    'order.business.department.current',
    'order.business.department.width'
  )
) = 3;
SET @order_business_walkin_config_complete = (
  SELECT COUNT(1)
  FROM `system_configs`
  WHERE `config_key` IN (
    'order.business.walkin.start',
    'order.business.walkin.current',
    'order.business.walkin.width'
  )
) = 3;
SET @order_business_department_marker_complete = EXISTS(
  SELECT 1 FROM `system_configs`
  WHERE `config_key` = 'order.business.department.migration.055' AND `config_value` = '1'
);
SET @order_business_walkin_marker_complete = EXISTS(
  SELECT 1 FROM `system_configs`
  WHERE `config_key` = 'order.business.walkin.migration.055' AND `config_value` = '1'
);
SET @order_business_department_sequence_exists = EXISTS(
  SELECT 1 FROM `business_sequence` WHERE `sequence_key` = 'order.business.department'
);
SET @order_business_walkin_sequence_exists = EXISTS(
  SELECT 1 FROM `business_sequence` WHERE `sequence_key` = 'order.business.walkin'
);
SET @order_business_department_needs_migration =
  @order_business_department_marker_complete = 0
  OR @order_business_department_config_complete = 0
  OR @order_business_department_sequence_exists = 0;
SET @order_business_walkin_needs_migration =
  @order_business_walkin_marker_complete = 0
  OR @order_business_walkin_config_complete = 0
  OR @order_business_walkin_sequence_exists = 0;

SET @order_system_department_needs_migration = (
  SELECT COUNT(1) FROM `system_configs`
  WHERE `config_key` IN ('order.system.department.start', 'order.system.department.current', 'order.system.department.width')
) < 3 OR NOT EXISTS(
  SELECT 1 FROM `business_sequence` WHERE `sequence_key` = 'order.system.department'
);
SET @order_system_walkin_needs_migration = (
  SELECT COUNT(1) FROM `system_configs`
  WHERE `config_key` IN ('order.system.walkin.start', 'order.system.walkin.current', 'order.system.walkin.width')
) < 3 OR NOT EXISTS(
  SELECT 1 FROM `business_sequence` WHERE `sequence_key` = 'order.system.walkin'
);
SET @o2o_preorder_department_needs_migration = (
  SELECT COUNT(1) FROM `system_configs`
  WHERE `config_key` IN ('o2o.preorder.department.start', 'o2o.preorder.department.current', 'o2o.preorder.department.width')
) < 3 OR NOT EXISTS(
  SELECT 1 FROM `business_sequence` WHERE `sequence_key` = 'o2o.preorder.department'
);
SET @o2o_preorder_walkin_needs_migration = (
  SELECT COUNT(1) FROM `system_configs`
  WHERE `config_key` IN ('o2o.preorder.walkin.start', 'o2o.preorder.walkin.current', 'o2o.preorder.walkin.width')
) < 3 OR NOT EXISTS(
  SELECT 1 FROM `business_sequence` WHERE `sequence_key` = 'o2o.preorder.walkin'
);

SET @order_business_department_start = COALESCE(
  IF(
    @order_business_department_marker_complete = 0,
    (SELECT `config_value` FROM `system_configs`
     WHERE `config_key` = 'order.serial.department.start'
       AND `config_value` REGEXP '^[0-9]+$' AND CAST(`config_value` AS UNSIGNED) > 0),
    NULL
  ),
  (SELECT `config_value` FROM `system_configs`
   WHERE `config_key` = 'order.business.department.start'
     AND `config_value` REGEXP '^[0-9]+$' AND CAST(`config_value` AS UNSIGNED) > 0),
  '1'
);
SET @order_business_department_width = COALESCE(
  IF(
    @order_business_department_marker_complete = 0,
    (SELECT `config_value` FROM `system_configs`
     WHERE `config_key` = 'order.serial.department.width'
       AND `config_value` REGEXP '^[0-9]+$'
       AND CAST(`config_value` AS UNSIGNED) BETWEEN 1 AND 12),
    NULL
  ),
  (SELECT `config_value` FROM `system_configs`
   WHERE `config_key` = 'order.business.department.width'
     AND `config_value` REGEXP '^[0-9]+$'
     AND CAST(`config_value` AS UNSIGNED) BETWEEN 1 AND 12),
  '6'
);
SET @order_business_walkin_start = COALESCE(
  IF(
    @order_business_walkin_marker_complete = 0,
    (SELECT `config_value` FROM `system_configs`
     WHERE `config_key` = 'order.serial.walkin.start'
       AND `config_value` REGEXP '^[0-9]+$' AND CAST(`config_value` AS UNSIGNED) > 0),
    NULL
  ),
  (SELECT `config_value` FROM `system_configs`
   WHERE `config_key` = 'order.business.walkin.start'
     AND `config_value` REGEXP '^[0-9]+$' AND CAST(`config_value` AS UNSIGNED) > 0),
  '1'
);
SET @order_business_walkin_width = COALESCE(
  IF(
    @order_business_walkin_marker_complete = 0,
    (SELECT `config_value` FROM `system_configs`
     WHERE `config_key` = 'order.serial.walkin.width'
       AND `config_value` REGEXP '^[0-9]+$'
       AND CAST(`config_value` AS UNSIGNED) BETWEEN 1 AND 12),
    NULL
  ),
  (SELECT `config_value` FROM `system_configs`
   WHERE `config_key` = 'order.business.walkin.width'
     AND `config_value` REGEXP '^[0-9]+$'
     AND CAST(`config_value` AS UNSIGNED) BETWEEN 1 AND 12),
  '6'
);

SET @order_system_department_current = COALESCE((
  SELECT MAX(CAST(SUBSTRING(`show_no`, 7) AS UNSIGNED))
  FROM `biz_outbound_order`
  WHERE `order_type` = 'department' AND `show_no` REGEXP '^OUT-D-[0-9]{6}$'
), 0);
SET @order_system_walkin_current = COALESCE((
  SELECT MAX(CAST(SUBSTRING(`show_no`, 7) AS UNSIGNED))
  FROM `biz_outbound_order`
  WHERE `order_type` = 'walkin' AND `show_no` REGEXP '^OUT-W-[0-9]{6}$'
), 0);
SET @o2o_preorder_department_current = COALESCE((
  SELECT MAX(CAST(SUBSTRING(`show_no`, 7) AS UNSIGNED))
  FROM `o2o_preorder`
  WHERE `client_order_type` = 'department' AND `show_no` REGEXP '^PRE-D-[0-9]{6}$'
), 0);
SET @o2o_preorder_walkin_current = COALESCE((
  SELECT MAX(CAST(SUBSTRING(`show_no`, 7) AS UNSIGNED))
  FROM `o2o_preorder`
  WHERE `client_order_type` = 'walkin' AND `show_no` REGEXP '^PRE-W-[0-9]{6}$'
), 0);
SET @order_business_department_current = GREATEST(
  IF(CAST(@order_business_department_start AS UNSIGNED) > 0, CAST(@order_business_department_start AS UNSIGNED) - 1, 0),
  CAST(COALESCE((SELECT `config_value` FROM `system_configs` WHERE `config_key` = 'order.business.department.current'), '0') AS UNSIGNED),
  COALESCE((SELECT `current_value` FROM `business_sequence` WHERE `sequence_key` = 'order.business.department'), 0),
  COALESCE((SELECT MAX(`serial_value`) FROM `order_business_no_occupancy` WHERE `business_namespace` = 'hyyzjd'), 0),
  COALESCE((
    SELECT MAX(CAST(SUBSTRING(`business_no`, 7) AS UNSIGNED))
    FROM `biz_outbound_order`
    WHERE `order_type` = 'department' AND `business_no` REGEXP '^hyyzjd[0-9]+$'
  ), 0),
  IF(
    @order_business_department_marker_complete = 0,
    CAST(COALESCE((SELECT `config_value` FROM `system_configs` WHERE `config_key` = 'order.serial.department.current'), '0') AS UNSIGNED),
    0
  ),
  IF(
    @order_business_department_marker_complete = 0,
    COALESCE((SELECT `current_value` FROM `business_sequence` WHERE `sequence_key` = 'order.serial.department'), 0),
    0
  )
);
SET @order_business_walkin_current = GREATEST(
  IF(CAST(@order_business_walkin_start AS UNSIGNED) > 0, CAST(@order_business_walkin_start AS UNSIGNED) - 1, 0),
  CAST(COALESCE((SELECT `config_value` FROM `system_configs` WHERE `config_key` = 'order.business.walkin.current'), '0') AS UNSIGNED),
  COALESCE((SELECT `current_value` FROM `business_sequence` WHERE `sequence_key` = 'order.business.walkin'), 0),
  COALESCE((SELECT MAX(`serial_value`) FROM `order_business_no_occupancy` WHERE `business_namespace` = 'hyyz'), 0),
  COALESCE((
    SELECT MAX(CAST(SUBSTRING(`business_no`, 5) AS UNSIGNED))
    FROM `biz_outbound_order`
    WHERE `order_type` = 'walkin' AND `business_no` REGEXP '^hyyz[0-9]+$'
  ), 0),
  IF(
    @order_business_walkin_marker_complete = 0,
    CAST(COALESCE((SELECT `config_value` FROM `system_configs` WHERE `config_key` = 'order.serial.walkin.current'), '0') AS UNSIGNED),
    0
  ),
  IF(
    @order_business_walkin_marker_complete = 0,
    COALESCE((SELECT `current_value` FROM `business_sequence` WHERE `sequence_key` = 'order.serial.walkin'), 0),
    0
  )
);

INSERT INTO `business_sequence` (`sequence_key`, `current_value`, `created_at`, `updated_at`)
SELECT `sequence_key`, `current_value`, `created_at`, `updated_at`
FROM (
  SELECT 'order.system.walkin' AS `sequence_key`, @order_system_walkin_current AS `current_value`, UTC_TIMESTAMP(6) AS `created_at`, UTC_TIMESTAMP(6) AS `updated_at`, @order_system_walkin_needs_migration AS `needs_migration`, 10 AS `lock_order`
  UNION ALL SELECT 'o2o.preorder.walkin', @o2o_preorder_walkin_current, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), @o2o_preorder_walkin_needs_migration, 20
  UNION ALL SELECT 'order.business.walkin', @order_business_walkin_current, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), @order_business_walkin_needs_migration, 30
  UNION ALL SELECT 'order.system.department', @order_system_department_current, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), @order_system_department_needs_migration, 40
  UNION ALL SELECT 'o2o.preorder.department', @o2o_preorder_department_current, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), @o2o_preorder_department_needs_migration, 50
  UNION ALL SELECT 'order.business.department', @order_business_department_current, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), @order_business_department_needs_migration, 60
) AS `pending_sequences`
WHERE `needs_migration` = 1
ORDER BY `lock_order`
ON DUPLICATE KEY UPDATE
  `updated_at` = IF(VALUES(`current_value`) > `current_value`, UTC_TIMESTAMP(6), `updated_at`),
  `current_value` = GREATEST(`current_value`, VALUES(`current_value`));

-- 锁顺序必须与业务分配一致：先锁/领养 sequence，再补 config 镜像。
INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT `config_key`, `config_value`, `config_group`, `remark`
FROM (
  SELECT 'order.system.walkin.current' AS `config_key`, CAST(@order_system_walkin_current AS CHAR) AS `config_value`, 'order_identifier' AS `config_group`, '正式出库单散客单当前流水镜像' AS `remark`, @order_system_walkin_needs_migration AS `needs_migration`, 101 AS `lock_order`
  UNION ALL SELECT 'order.system.walkin.start', '1', 'order_identifier', '正式出库单散客单起始流水', @order_system_walkin_needs_migration, 102
  UNION ALL SELECT 'order.system.walkin.width', '6', 'order_identifier', '正式出库单散客单流水位数', @order_system_walkin_needs_migration, 103
  UNION ALL SELECT 'o2o.preorder.walkin.current', CAST(@o2o_preorder_walkin_current AS CHAR), 'order_identifier', 'O2O 散客预订单当前流水镜像', @o2o_preorder_walkin_needs_migration, 201
  UNION ALL SELECT 'o2o.preorder.walkin.start', '1', 'order_identifier', 'O2O 散客预订单起始流水', @o2o_preorder_walkin_needs_migration, 202
  UNION ALL SELECT 'o2o.preorder.walkin.width', '6', 'order_identifier', 'O2O 散客预订单流水位数', @o2o_preorder_walkin_needs_migration, 203
  UNION ALL SELECT 'order.business.walkin.current', CAST(@order_business_walkin_current AS CHAR), 'order_identifier', '散客永久业务号当前高水位镜像', @order_business_walkin_needs_migration, 301
  UNION ALL SELECT 'order.business.walkin.start', @order_business_walkin_start, 'order_identifier', '散客永久业务号起始流水', @order_business_walkin_needs_migration, 302
  UNION ALL SELECT 'order.business.walkin.width', @order_business_walkin_width, 'order_identifier', '散客永久业务号流水位数', @order_business_walkin_needs_migration, 303
  UNION ALL SELECT 'order.system.department.current', CAST(@order_system_department_current AS CHAR), 'order_identifier', '正式出库单部门单当前流水镜像', @order_system_department_needs_migration, 401
  UNION ALL SELECT 'order.system.department.start', '1', 'order_identifier', '正式出库单部门单起始流水', @order_system_department_needs_migration, 402
  UNION ALL SELECT 'order.system.department.width', '6', 'order_identifier', '正式出库单部门单流水位数', @order_system_department_needs_migration, 403
  UNION ALL SELECT 'o2o.preorder.department.current', CAST(@o2o_preorder_department_current AS CHAR), 'order_identifier', 'O2O 部门预订单当前流水镜像', @o2o_preorder_department_needs_migration, 501
  UNION ALL SELECT 'o2o.preorder.department.start', '1', 'order_identifier', 'O2O 部门预订单起始流水', @o2o_preorder_department_needs_migration, 502
  UNION ALL SELECT 'o2o.preorder.department.width', '6', 'order_identifier', 'O2O 部门预订单流水位数', @o2o_preorder_department_needs_migration, 503
  UNION ALL SELECT 'order.business.department.current', CAST(@order_business_department_current AS CHAR), 'order_identifier', '部门永久业务号当前高水位镜像', @order_business_department_needs_migration, 601
  UNION ALL SELECT 'order.business.department.start', @order_business_department_start, 'order_identifier', '部门永久业务号起始流水', @order_business_department_needs_migration, 602
  UNION ALL SELECT 'order.business.department.width', @order_business_department_width, 'order_identifier', '部门永久业务号流水位数', @order_business_department_needs_migration, 603
) AS `pending_configs`
WHERE `needs_migration` = 1
ORDER BY `lock_order`
ON DUPLICATE KEY UPDATE
  `config_value` = CASE
    WHEN VALUES(`config_key`) IN ('order.business.department.start', 'order.business.department.width')
      AND @order_business_department_marker_complete = 0
      THEN VALUES(`config_value`)
    WHEN VALUES(`config_key`) IN ('order.business.walkin.start', 'order.business.walkin.width')
      AND @order_business_walkin_marker_complete = 0
      THEN VALUES(`config_value`)
    WHEN VALUES(`config_key`) LIKE '%.current'
      THEN CAST(GREATEST(CAST(`config_value` AS UNSIGNED), CAST(VALUES(`config_value`) AS UNSIGNED)) AS CHAR)
    ELSE `config_value`
  END,
  `config_group` = VALUES(`config_group`),
  `remark` = VALUES(`remark`);

-- marker 最后写入；事务提交后 marker=1 才表示该 namespace 已完整完成领养。
INSERT INTO `system_configs` (`config_key`, `config_value`, `config_group`, `remark`)
SELECT `config_key`, `config_value`, `config_group`, `remark`
FROM (
  SELECT 'order.business.walkin.migration.055' AS `config_key`, '1' AS `config_value`, 'order_identifier_migration' AS `config_group`, 'Issue #110 散客业务号命名空间已完成首迁' AS `remark`, @order_business_walkin_needs_migration AS `needs_migration`, 10 AS `lock_order`
  UNION ALL SELECT 'order.business.department.migration.055', '1', 'order_identifier_migration', 'Issue #110 部门业务号命名空间已完成首迁', @order_business_department_needs_migration, 20
) AS `pending_markers`
WHERE `needs_migration` = 1
ORDER BY `lock_order`
ON DUPLICATE KEY UPDATE
  `config_value` = VALUES(`config_value`),
  `config_group` = VALUES(`config_group`),
  `remark` = VALUES(`remark`);
