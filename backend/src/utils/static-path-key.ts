/** 静态资源策略比较键：遵循 Express 默认大小写与单个尾斜杠语义，不改写请求或解码路径。 */
export function staticPathKey(path: string): string {
  const key = path.replace(/[A-Z]/g, (char) => char.toLowerCase())
  return key.length > 1 && key.endsWith('/') ? key.slice(0, -1) : key
}
