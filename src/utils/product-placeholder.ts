/**
 * 文件说明：
 * 统一维护商品默认占位图，确保管理端与客户端在“无预览图”场景下视觉一致。
 */

/**
 * 统一占位图（几何风）：
 * - 使用低饱和青灰色，贴合当前系统主色与卡片背景；
 * - 使用固定图形，避免不同商品出现风格跳变。
 */
const UNIFIED_PRODUCT_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eef5f7"/>
      <stop offset="100%" stop-color="#d8e8ec"/>
    </linearGradient>
  </defs>
  <rect width="240" height="240" rx="28" fill="url(#bg)"/>
  <rect x="30" y="30" width="180" height="180" rx="20" fill="rgba(13,148,136,0.08)"/>
  <circle cx="168" cy="82" r="24" fill="rgba(13,148,136,0.22)"/>
  <path d="M54 150 L100 102 L130 132 L176 88" stroke="rgba(13,148,136,0.42)" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="54" y="146" width="132" height="40" rx="10" fill="rgba(13,148,136,0.18)"/>
  <text x="120" y="206" text-anchor="middle" fill="rgba(71,85,105,0.78)" font-size="20" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">暂无图片</text>
</svg>
`)}`;

export const resolveProductPlaceholder = (thumbnail?: string | null) => {
  const normalizedThumbnail = thumbnail?.trim()
  return normalizedThumbnail || UNIFIED_PRODUCT_PLACEHOLDER
}

