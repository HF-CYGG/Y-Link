/** 多规格草稿是本次新增量，非法输入保留到提交时逐行反馈。 */
export const parseClientBatchQty = (raw: string): number => /^\d+$/.test(raw.trim()) && Number.isSafeInteger(Number(raw)) ? Number(raw) : NaN
export const buildClientBatchSelections = (drafts: Record<string, string>) => Object.entries(drafts).map(([skuId, raw]) => ({ skuId, qty: parseClientBatchQty(raw) }))
/** 每行仍按自身库存限制，但商品限购由购物车已有量与其它行本次草稿共同占用。 */
export const resolveClientBatchSkuMaxQty = (skuId: string, availableStock: number, limitPerUser: number,
  cart: Array<{ skuId: string | null; qty: number }>, drafts: Record<string, string>) => {
  const ownCartQty = cart.filter((item) => item.skuId === skuId).reduce((sum, item) => sum + item.qty, 0)
  const stock = Math.max(0, availableStock - ownCartQty)
  if (limitPerUser <= 0) return stock
  const otherDraftQty = buildClientBatchSelections(drafts).filter((item) => item.skuId !== skuId && Number.isSafeInteger(item.qty))
    .reduce((sum, item) => sum + item.qty, 0)
  return Math.max(0, Math.min(stock, limitPerUser - cart.reduce((sum, item) => sum + item.qty, 0) - otherDraftQty))
}
export const summarizeClientBatch = (drafts: Record<string, string>, prices: Map<string, string>) => {
  let qty = 0
  let amount = 0
  for (const selection of buildClientBatchSelections(drafts)) {
    if (!Number.isSafeInteger(selection.qty) || selection.qty < 0) return { qty: 0, amount: 0, valid: false }
    qty += selection.qty
    if (!selection.qty) continue
    const price = Number(prices.get(selection.skuId))
    if (!Number.isFinite(price) || price < 0) return { qty: 0, amount: 0, valid: false }
    amount += selection.qty * price
    if (!Number.isSafeInteger(qty) || !Number.isFinite(amount) || amount > Number.MAX_SAFE_INTEGER) return { qty: 0, amount: 0, valid: false }
  }
  return { qty, amount, valid: true }
}
