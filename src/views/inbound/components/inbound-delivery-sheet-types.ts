/**
 * 模块说明：src/views/inbound/components/inbound-delivery-sheet-types.ts
 * 文件职责：定义供货方送货单打印弹窗的临时补填字段类型，供工作台和打印模板共享。
 * 实现逻辑：
 * - 将项目内容、送货方信息、验收勾选项、问题描述、验收人和签字信息统一收敛为单一字段结构；
 * - 类型文件独立于 Vue SFC，避免在组件内导出类型造成编译边界不清晰；
 * - 字段只描述前端打印会话状态，不代表后端入库单持久化结构。
 * 维护说明：
 * - 若送货单纸质模板新增补填字段，应先扩展该类型，再同步更新工作台默认值和打印模板展示；
 * - 不要在该类型中混入后端送货单状态字段，后端详情仍以 InboundOrderDetail 为准。
 */
export interface InboundDeliverySheetFields {
  projectCategory: string
  content: string
  senderName: string
  deliveryDate: string
  deliveredTime: string
  quantityMatched: boolean
  qualityAccepted: boolean
  hasIssue: boolean
  issueDescription: string
  inspectorName: string
  senderSignature: string
  receiverSignature: string
  senderSignDate: string
  receiverSignDate: string
}
