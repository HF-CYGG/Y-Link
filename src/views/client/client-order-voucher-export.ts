/**
 * 模块说明：src/views/client/client-order-voucher-export.ts
 * 文件职责：在异步加载 PDF 模块前固定客户端正式出库单的当前纸面。
 * 实现逻辑：复制已分页的可见 DOM，并暂时挂到视口外；导出完成后由调用方释放。
 */
export const createClientVoucherExportSnapshot = (sourceElement: HTMLElement) => {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.position = 'fixed'
  host.style.left = '-100000px'
  host.style.top = '0'
  host.style.pointerEvents = 'none'
  host.style.width = `${sourceElement.getBoundingClientRect().width}px`
  const snapshot = sourceElement.cloneNode(true) as HTMLElement
  host.appendChild(snapshot)
  document.body.appendChild(host)
  return {
    sourceElement: snapshot,
    dispose: () => host.remove(),
  }
}
