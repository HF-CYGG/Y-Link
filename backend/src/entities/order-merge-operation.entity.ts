/**
 * 文件说明：订单合并操作实体，保存提交幂等键、规范请求摘要与提交结果快照。
 * 实现逻辑：幂等键唯一，同键请求只能重放相同摘要；目标订单使用 RESTRICT 外键防止合并历史被物理删除。
 * 维护重点：不得在结果或审计快照中保存 Cookie、Token 等敏感信息。
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BizOutboundOrder } from './biz-outbound-order.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

const jsonColumnType = entityColumnOptions.isSqlite ? 'text' : 'longtext'

@Entity({ name: 'order_merge_operation' })
export class OrderMergeOperation {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_order_merge_operation_uuid', { unique: true })
  @Column({ name: 'operation_uuid', ...entityColumnOptions.uuid, length: 36 })
  operationUuid!: string

  @Index('uk_order_merge_operation_idempotency_key', { unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey!: string

  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash!: string

  @Index('idx_order_merge_operation_target_order_id')
  @Column({ name: 'target_order_id', ...entityColumnOptions.foreignId })
  targetOrderId!: string

  @Column({ name: 'target_order_uuid', ...entityColumnOptions.uuid, length: 36 })
  targetOrderUuid!: string

  @Column({ name: 'target_edit_version', type: 'integer' })
  targetEditVersion!: number

  @Column({ name: 'merged_source_order_ids_json', type: jsonColumnType })
  mergedSourceOrderIdsJson!: string

  @Column({ name: 'result_json', type: jsonColumnType })
  resultJson!: string

  @Column({ name: 'reason', type: 'varchar', length: 500 })
  reason!: string

  @Column({ name: 'actor_user_id', type: 'varchar', length: 64, nullable: true })
  actorUserId!: string | null

  @Column({ name: 'actor_username', type: 'varchar', length: 64 })
  actorUsername!: string

  @Column({ name: 'actor_display_name', type: 'varchar', length: 64 })
  actorDisplayName!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @ManyToOne(() => BizOutboundOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'target_order_id' })
  targetOrder?: Relation<BizOutboundOrder>
}
