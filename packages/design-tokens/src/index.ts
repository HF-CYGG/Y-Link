/** 跨端可消费的最小原始色值，不包含组件语义或主题逻辑。 */
export const colors = {
  primary: '#005b52',
  background: '#f5f7fa',
  surface: '#ffffff',
  text: '#0f172a',
  subtext: '#64748b',
  border: '#dbe2ea',
  warning: '#f59e0b',
  danger: '#ef4444',
} as const

/** 跨端布局基础间距，单位由消费端映射为 px 或 dp。 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const

/** 跨端基础圆角，单位由消费端映射为 px 或 dp。 */
export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  full: 9999,
} as const

/** 跨端基础字号，单位由消费端映射为 px 或 sp。 */
export const fontSize = {
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
} as const
