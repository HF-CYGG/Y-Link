/**
 * 模块说明：src/utils/product-placeholder.ts
 * 文件职责：统一维护商品默认占位图，确保管理端与客户端在“无预览图”场景下视觉一致。
 * 实现逻辑：
 * - 使用内联 SVG 生成统一占位图并编码为 data URL，避免额外静态资源依赖；
 * - 占位图采用低对比中性色与简化轮廓，弱化装饰信息，突出商品主信息阅读优先级；
 * - `resolveProductPlaceholder` 优先返回真实缩略图，缺失时回退统一占位图。
 * 维护说明：若调整占位图风格或尺寸，需同时回归客户端商城和管理端列表的缩略图显示一致性。
 */
const UNIFIED_PRODUCT_PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">' +
  '<defs>' +
  '<linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0%" stop-color="#f7f8fa"/>' +
  '<stop offset="100%" stop-color="#eef1f5"/>' +
  '</linearGradient>' +
  '<linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0%" stop-color="#ffffff" stop-opacity="0.72"/>' +
  '<stop offset="100%" stop-color="#f3f5f8" stop-opacity="0.94"/>' +
  '</linearGradient>' +
  '</defs>' +
  '<rect width="240" height="240" rx="34" fill="url(#panel)"/>' +
  '<rect x="44" y="44" width="152" height="152" rx="28" fill="url(#surface)"/>' +
  '<rect x="76" y="80" width="88" height="80" rx="18" fill="none" stroke="#c8cfd8" stroke-width="5"/>' +
  '<circle cx="146" cy="98" r="8" fill="#c8cfd8"/>' +
  '<path d="M88 144 L110 122 L126 138 L152 114" fill="none" stroke="#b8c1cb" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>'

const UNIFIED_PRODUCT_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(UNIFIED_PRODUCT_PLACEHOLDER_SVG)}`

export const resolveProductPlaceholder = (thumbnail?: string | null) => {
  const normalizedThumbnail = thumbnail?.trim()
  return normalizedThumbnail || UNIFIED_PRODUCT_PLACEHOLDER
}
