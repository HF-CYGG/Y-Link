-- 模块说明：base_product 大表迁移脚本（第三步）
-- 文件职责：在数据回填完成后收紧字段约束，将关键列改为非空并补默认值
-- 维护说明：执行前需先完成回填核验，避免因历史空值导致收紧失败

-- Step 3: 收紧约束 (改为 NOT NULL 并设置默认值)
-- 为什么安全：前面的回填脚本已经把所有的 NULL 值都填充为了有效数据。
-- 此时再执行 NOT NULL，MySQL 只需要校验一下表里是否还有 NULL 行，不需要大量写盘。

-- 注意：这依然需要拿排他元数据锁 (Exclusive MDL)。
-- 执行前请务必排查有没有慢查询或长事务卡在 base_product 表上。

ALTER TABLE `base_product`
  MODIFY COLUMN `o2o_status` VARCHAR(16) NOT NULL DEFAULT 'unlisted' COMMENT '线上预订状态',
  MODIFY COLUMN `limit_per_user` INT NOT NULL DEFAULT 5 COMMENT '单人限购数量',
  MODIFY COLUMN `current_stock` INT NOT NULL DEFAULT 0 COMMENT '物理库存',
  MODIFY COLUMN `pre_ordered_stock` INT NOT NULL DEFAULT 0 COMMENT '已预订库存';
