/**
 * 模块说明：src/utils/product-placeholder.ts
 * 文件职责：统一维护商品默认占位图资源与解析函数，确保管理端和客户端在“无预览图”场景下输出一致的兜底图片。
 * 维护说明：
 * - 若后续要调整无图商品视觉风格，优先只改这里的 SVG 与导出函数，避免页面层重复散落占位图常量；
 * - `resolveProductPlaceholder()` 只负责“有值返回原图、无值返回占位图”的最小兜底，不承担图片可访问性探测。
 */

/**
 * 统一占位图（极简风）：
 * - 采用接近 Apple 风格的低对比中性色与大圆角，减少视觉噪声；
 * - 只保留“相片”语义的极简轮廓，不再使用复杂几何图形与大段文案；
 * - 让无图商品在列表中更克制，不抢占商品名称与价格信息焦点。
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
