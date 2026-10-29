/** 补货提交键映射：被活跃需求去重的请求键也必须保留，避免到期后重试产生新需求。 */
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { ClientRestockRequest } from './client-restock-request.entity.js'
import { ClientUser } from './client-user.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'client_restock_request_key' })
@Index('uk_restock_key_client_request', ['clientUserId', 'clientRequestId'], { unique: true })
export class ClientRestockRequestKey {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'client_user_id', ...entityColumnOptions.foreignId })
  clientUserId!: string

  @Column({ name: 'client_request_id', type: 'varchar', length: 64, ...(entityColumnOptions.isSqlite ? {} : { collation: 'utf8mb4_bin' }) })
  clientRequestId!: string

  @Column({ name: 'payload_digest', type: 'varchar', length: 64 })
  payloadDigest!: string

  @Column({ name: 'restock_request_id', ...entityColumnOptions.foreignId })
  restockRequestId!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @ManyToOne(() => ClientRestockRequest, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'restock_request_id' })
  restockRequest?: Relation<ClientRestockRequest>

  @ManyToOne(() => ClientUser, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_user_id' })
  clientUser?: Relation<ClientUser>
}
