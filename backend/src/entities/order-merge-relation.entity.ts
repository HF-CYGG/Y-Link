/**
 * 文件说明：订单合并父子关系实体，只保存一层“目标父单 -> 来源原单”关系。
 * 实现逻辑：来源订单唯一且父/来源均使用 RESTRICT 外键，保证来源不能重复归并、任意成员不能物理删除。
 * 维护重点：目标可追加多个来源，但来源永远不能再作为目标或来源参与其它合并。
 */

import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BizOutboundOrder } from './biz-outbound-order.entity.js'
import { entityColumnOptions } from './entity-column-options.js'
import { OrderMergeOperation } from './order-merge-operation.entity.js'

@Entity({ name: 'order_merge_relation' })
@Check('ck_order_merge_relation_distinct_orders', '`parent_order_id` <> `source_order_id`')
@Index('uk_order_merge_relation_source_order_id', ['sourceOrderId'], { unique: true })
@Index('uk_order_merge_relation_parent_source', ['parentOrderId', 'sourceOrderId'], { unique: true })
export class OrderMergeRelation {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_order_merge_relation_operation_id')
  @Column({ name: 'operation_id', ...entityColumnOptions.foreignId })
  operationId!: string

  @Index('idx_order_merge_relation_parent_order_id')
  @Column({ name: 'parent_order_id', ...entityColumnOptions.foreignId })
  parentOrderId!: string

  @Column({ name: 'parent_order_uuid', ...entityColumnOptions.uuid, length: 36 })
  parentOrderUuid!: string

  @Column({ name: 'parent_business_no_snapshot', type: 'varchar', length: 32 })
  parentBusinessNoSnapshot!: string

  @Column({ name: 'source_order_id', ...entityColumnOptions.foreignId })
  sourceOrderId!: string

  @Column({ name: 'source_order_uuid', ...entityColumnOptions.uuid, length: 36 })
  sourceOrderUuid!: string

  @Column({ name: 'source_business_no_snapshot', type: 'varchar', length: 32 })
  sourceBusinessNoSnapshot!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @ManyToOne(() => OrderMergeOperation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'operation_id' })
  operation?: Relation<OrderMergeOperation>

  @ManyToOne(() => BizOutboundOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'parent_order_id' })
  parentOrder?: Relation<BizOutboundOrder>

  @ManyToOne(() => BizOutboundOrder, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'source_order_id' })
  sourceOrder?: Relation<BizOutboundOrder>
}
