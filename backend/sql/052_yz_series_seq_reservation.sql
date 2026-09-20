-- YZ 通用 SKU 编码体系：系列内序号永久占用登记表（第 5 批，PR #109 第四轮评审 P1 修复）。
-- 背景：现有删除接口对 base_product 做物理删除，而此前 reserveSeriesSeq（导入指定序号）与
--       allocateSeriesSeq（新建/升级顺序分配）只查“仍然存在”的 base_product 行判断某个系列的某个
--       序号是否被占用。一个尚无业务引用、但已经打印过标签的 YZ 商品被删除后，同一系列同一序号会被
--       重新分配，生成与旧标签完全相同的商品编码与 SKU 编码，导致旧标签静默指向新商品。
--       business_sequence 只保存序列最高水位，拦不住导入显式复用一个比当前水位更小的历史序号。
-- 结构：新增 base_yz_series_seq_reservation，记录每一个曾经被分配过的 (series_tag_id, series_seq)
--       组合，一经登记永久占用，不因商品甚至标签被删除而释放：
--         - series_tag_id：系列标签ID；
--         - series_seq：系列内序号（1-99）；
--         - product_code：当时生成的产品编码，仅作追溯展示，便于人工核对旧标签对应的历史编码；
--         - uk_yz_series_seq_reservation(series_tag_id, series_seq)：同一系列同一序号只登记一次。
-- 数据：只加结构，不回填历史数据——此前已被删除的 YZ 商品其（系列, 序号）组合已经无法从现有数据反推
--       （被删商品的行本身已经不存在，business_sequence 也只留最高水位，不留每个曾用过的具体序号），
--       因此本表只对本次修复上线之后新分配/新预占的序号生效，无法回溯覆盖修复前已经发生过的删除。
-- 幂等：建表使用 IF NOT EXISTS，与 050/051 一致。
--
-- 【重要，写给后续维护者】本表刻意不建任何指向 base_tag 或 base_product 的外键，
--       尤其绝不能加 ON DELETE CASCADE——这张表存在的全部意义就是在商品、甚至标签本身都被删除之后，
--       依然要让“这个序号用过”这件事可查。一旦有人为 series_tag_id 补上级联外键，
--       标签或商品被删除时这些登记行会被一并清掉，P1 修复的核心不变量就被破坏了，
--       请不要把这里的"缺外键"当成疏漏顺手补上。

CREATE TABLE IF NOT EXISTS `base_yz_series_seq_reservation` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `series_tag_id` BIGINT UNSIGNED NOT NULL COMMENT '系列标签ID，不建外键，标签或商品被删除后本行依然永久保留',
  `series_seq` SMALLINT UNSIGNED NOT NULL COMMENT '系列内序号（1-99），一经登记永久占用，不因商品删除而释放',
  `product_code` VARCHAR(64) NOT NULL COMMENT '当时生成的产品编码，仅作追溯展示',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_yz_series_seq_reservation` (`series_tag_id`, `series_seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='YZ 编码体系系列内序号永久占用登记表，无外键，商品/标签删除不清除，见表头维护说明';
