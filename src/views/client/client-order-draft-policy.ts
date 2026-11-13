/**
 * 模块说明：src/views/client/client-order-draft-policy.ts
 * 文件职责：为改单与退货生成仅包含用户输入的脏状态基线。
 * 实现逻辑：排除后台重算的价格、库存和限购；零退货量与未填写等价。
 * 维护说明：新增可编辑字段时须同时纳入快照，关闭与路由离开共用同一基线。
 */
export const snapshotOrderEditDraft = (remark: string, addProductId: string, items: Array<{ itemKey: string; qty: number }>) => JSON.stringify({
  remark, addProductId, items: items.map(({ itemKey, qty }) => ({ itemKey, qty })).sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
})
export const snapshotOrderReturnDraft = (reason: string, quantities: Record<string, number>) => JSON.stringify({
  reason, quantities: Object.entries(quantities).filter(([, qty]) => qty !== 0).sort(([a], [b]) => a.localeCompare(b)),
})
