/**
 * 文件说明：YZ 通用 SKU 编码体系「系列内序号」永久占用登记表实体（PR #109 第四轮评审 P1 修复；
 *      第五轮评审 P1-C 修复把权威唯一性从 series_tag_id 迁移到 series_code 维度，见下文）。
 * 背景：现有删除接口对 base_product 做物理删除，而 reserveSeriesSeq/allocateSeriesSeq 此前只查
 *      “仍然存在”的 base_product 行判断序号是否被占用。一个尚无业务引用、但已经打印过标签的 YZ 商品
 *      被删除后，同一系列同一序号会被重新分配，生成与旧标签完全相同的商品编码/SKU 编码，导致旧标签
 *      静默指向新商品。business_sequence 只保存最高水位，拦不住导入显式复用一个较小的历史序号。
 * P1-C 修复背景：052 最初按 series_tag_id 隔离命名空间。当某系列最后一个 YZ 商品被删除、对应标签也
 *      被一并删除后，新建一个 seriesCode 相同的标签会拿到全新的 tagId——tagId 不是印在标签上的东西，
 *      真正决定印刷编码文本是否重复的是「前缀 + 系列码 + 序号」这三元组。因此新增 series_code（两位
 *      大写字母）与 code_prefix（当时的全局前缀快照，前缀可配置且可能变化，必须与 series_code 一起
 *      入命名空间），并把唯一索引改建在 (code_prefix, series_code, series_seq) 上，这是修复后的权威
 *      唯一性来源；旧的 (series_tag_id, series_seq) 唯一索引降级为普通索引，仅保留用于按标签追溯。
 * 实现逻辑：
 * - 每当 allocateSeriesSeq 分配到一个新序号、或 reserveSeriesSeq（导入路径）成功预占一个指定序号，
 *   都会在本表写入一条永久登记行，记录当时生成的 productCode 便于追溯；
 * - 删除商品（无论物理删除还是其他清理路径）一律不清除本表的登记行——这是本表存在的全部意义：
 *   即使商品、甚至标签本身都已被删除，这一（code_prefix, series_code, series_seq）组合也要被永久视为
 *   “用过”，后续新建或导入都不能再分配到同一个号，避免旧印刷标签指向语义完全不同的新商品；
 * - allocateSeriesSeq 取下一个可用号时会同时参考本表与 base_product，跳过已登记但当前无商品的序号；
 *   reserveSeriesSeq 写入前会先查本表，命中则抛 409 并在文案中带出历史 productCode；
 * - tag.service.ts 删除标签时，除主系列引用计数外，还会按该标签的 seriesCode 查本表，命中则拒绝删除，
 *   避免删除后新建同 seriesCode 的标签重新从 01 分配、生成与旧标签重复的编码。
 * 维护重点：
 * - 【重要】本表不建任何指向 base_tag 或 base_product 的外键，尤其不能用 ON DELETE CASCADE——
 *   一旦加上级联外键，标签或商品被删除时这张表的登记行会被一并清除，P1 修复的核心不变量就被破坏了。
 *   后续任何人都不得为 series_tag_id 补建外键，这不是遗漏，是有意为之；
 * - 本表只允许新增，不允许更新 series_seq/series_tag_id/series_code/code_prefix、不允许删除，
 *   product_code 仅作追溯展示。
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'base_yz_series_seq_reservation' })
// P1-C 修复：权威唯一性迁移到 (code_prefix, series_code, series_seq)——真正决定印刷编码文本是否重复的
// 是这三者，不是内部自增的 tagId。
@Index('uk_yz_series_seq_reservation_code', ['codePrefix', 'seriesCode', 'seriesSeq'], { unique: true })
// 旧唯一索引降级为普通索引，仅用于按标签反查历史登记，不再承担唯一性约束。
@Index('idx_yz_series_seq_reservation_tag', ['seriesTagId', 'seriesSeq'])
export class BaseYzSeriesSeqReservation {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  // 有意不加 @ManyToOne / 外键：见文件头「维护重点」，标签被删除后本行必须原样保留。
  @Column({ name: 'series_tag_id', ...entityColumnOptions.foreignId, comment: '系列标签ID，不建外键，标签或商品被删除后本行依然永久保留；仅供追溯，不再是权威唯一性维度' })
  seriesTagId!: string

  @Column({ name: 'series_seq', type: 'smallint', unsigned: true, comment: '系列内序号（1-99），一经登记永久占用，不因商品删除而释放' })
  seriesSeq!: number

  @Column({ name: 'product_code', type: 'varchar', length: 64, comment: '当时生成的产品编码，仅作追溯展示' })
  productCode!: string

  @Column({ name: 'series_code', type: 'varchar', length: 2, comment: '系列编码（两位大写字母），与 code_prefix、series_seq 共同构成权威唯一命名空间（P1-C 修复）' })
  seriesCode!: string

  @Column({ name: 'code_prefix', type: 'varchar', length: 4, comment: 'YZ 编码全局前缀快照，随 system_configs.product.yz_code.prefix 可能变化，必须与 series_code 一起入命名空间（P1-C 修复）' })
  codePrefix!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
