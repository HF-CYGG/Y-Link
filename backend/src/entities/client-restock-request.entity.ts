/**
 * 模块说明：客户端补货需求，独立保存业务状态、商品规格快照和请求幂等依据。
 * 维护说明：不占用库存；历史商品、SKU、会话与账号引用必须保留，规格退役不删除需求。
 */
import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn, type Relation } from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { BaseProductSku } from './base-product-sku.entity.js'
import { ClientUser } from './client-user.entity.js'
import { ClientFeedbackConversation } from './client-feedback-conversation.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

export const RESTOCK_STATUSES = ['requested', 'accepted', 'restocked', 'cancelled'] as const
export type RestockStatus = (typeof RESTOCK_STATUSES)[number]
export const RESTOCK_EFFECTIVE_STATUSES = [...RESTOCK_STATUSES, 'expired'] as const
export type RestockEffectiveStatus = (typeof RESTOCK_EFFECTIVE_STATUSES)[number]

@Entity({ name: 'client_restock_request' })
@Index('uk_restock_conversation', ['conversationId'], { unique: true })
@Index('uk_restock_client_request', ['clientUserId', 'clientRequestId'], { unique: true })
@Index('idx_restock_active', ['clientUserId', 'skuId', 'status', 'latestPickupAt'])
@Index('idx_restock_product_created', ['productId', 'createdAt'])
@Index('idx_restock_created', ['createdAt'])
@Check('ck_restock_quantity_positive', '`quantity` > 0')
@Check('ck_restock_status', "`status` IN ('requested', 'accepted', 'restocked', 'cancelled')")
export class ClientRestockRequest {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'conversation_id', ...entityColumnOptions.foreignId })
  conversationId!: string

  @Column({ name: 'client_user_id', ...entityColumnOptions.foreignId })
  clientUserId!: string

  @Column({ name: 'product_id', ...entityColumnOptions.foreignId })
  productId!: string

  @Column({ name: 'sku_id', ...entityColumnOptions.foreignId })
  skuId!: string

  @Column({ name: 'product_name_snapshot', type: 'varchar', length: 128 })
  productNameSnapshot!: string

  @Column({ name: 'product_code_snapshot', type: 'varchar', length: 64 })
  productCodeSnapshot!: string

  @Column({ name: 'sku_code_snapshot', type: 'varchar', length: 96 })
  skuCodeSnapshot!: string

  @Column({ name: 'spec_text_snapshot', type: 'varchar', length: 255 })
  specTextSnapshot!: string

  @Column({ name: 'quantity', type: 'int' })
  quantity!: number

  @Column({ name: 'latest_pickup_at', ...entityColumnOptions.timestamp })
  latestPickupAt!: Date

  @Column({ name: 'remark', type: 'varchar', length: 1000, nullable: true })
  remark!: string | null

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'requested' })
  status!: RestockStatus

  @Column({ name: 'handled_at', ...entityColumnOptions.timestamp, nullable: true })
  handledAt!: Date | null

  @Column({ name: 'client_request_id', type: 'varchar', length: 64, ...(entityColumnOptions.isSqlite ? {} : { collation: 'utf8mb4_bin' }) })
  clientRequestId!: string

  @Column({ name: 'payload_digest', type: 'varchar', length: 64 })
  payloadDigest!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @OneToOne(() => ClientFeedbackConversation, (conversation) => conversation.restock, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'conversation_id' })
  conversation?: Relation<ClientFeedbackConversation>

  @ManyToOne(() => ClientUser, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_user_id' })
  clientUser?: Relation<ClientUser>

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>

  @ManyToOne(() => BaseProductSku, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sku_id' })
  sku?: Relation<BaseProductSku>
}
