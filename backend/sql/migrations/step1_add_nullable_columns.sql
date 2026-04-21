-- 模块说明：base_product 大表迁移脚本（第一步）
-- 文件职责：先以低风险方式新增可空列并建立必要索引，为后续回填与约束收紧做准备
-- 维护说明：若新增线上预订字段，需在本脚本与后续回填、收紧脚本中保持一致

-- Step 1: 低风险加列 (允许 NULL，不带默认值)
-- 为什么安全：只修改表元数据字典，不回填任何老数据，通常是瞬间完成。
-- 即使表有几百万行，也能把 DDL 耗时控制在毫秒级。

ALTER TABLE `base_product`
  ADD COLUMN `o2o_status` VARCHAR(16) NULL COMMENT '线上预订状态',
  ADD COLUMN `thumbnail` VARCHAR(255) NULL COMMENT '预览图地址',
  ADD COLUMN `detail_content` TEXT NULL COMMENT '商品详情',
  ADD COLUMN `limit_per_user` INT NULL COMMENT '单人限购数量',
  ADD COLUMN `current_stock` INT NULL COMMENT '物理库存',
  ADD COLUMN `pre_ordered_stock` INT NULL COMMENT '已预订库存';

-- Step 2: （可选）如果在回填期间就需要支持基于这些列的检索，可以先加索引
-- 注意：MySQL 5.6+ 采用 Online DDL，加索引允许并发 DML，但仍会有 IO 开销。
-- 如果是业务低峰期，可一并执行。
ALTER TABLE `base_product` 
  ADD INDEX `idx_base_product_o2o_status` (`o2o_status`);
