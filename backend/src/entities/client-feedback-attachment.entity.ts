import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'client_feedback_attachment' })
export class ClientFeedbackAttachment {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_client_feedback_attachment_owner')
  @Column({ name: 'owner_client_user_id', type: 'varchar', length: 36 })
  ownerClientUserId!: string

  @Index('idx_client_feedback_attachment_conversation')
  @Column({ name: 'conversation_id', type: 'varchar', length: 36, nullable: true })
  conversationId!: string | null

  @Column({ name: 'message_id', type: 'varchar', length: 36, nullable: true })
  messageId!: string | null

  @Column({ name: 'storage_name', type: 'varchar', length: 255 })
  storageName!: string

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName!: string

  @Column({ name: 'mime_type', type: 'varchar', length: 128, nullable: true })
  mimeType!: string | null

  @Column({ name: 'size_bytes', type: 'int', nullable: true })
  sizeBytes!: number | null

  @Index('idx_client_feedback_attachment_expires')
  @Column({ name: 'expires_at', ...entityColumnOptions.timestamp, nullable: true })
  expiresAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
