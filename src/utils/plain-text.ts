/**
 * 模块说明：src/utils/plain-text.ts
 * 文件职责：把商品描述等可能混入 HTML 标签的文本转换为安全的纯文本，供客户端以文本插值方式展示和建立搜索索引。
 * 实现逻辑：
 * - 段落、换行、列表项等块级标签转为换行，其余标签整体去除；
 * - 解码常见 HTML 实体（含十进制/十六进制数字实体），再合并多余空白与连续空行；
 * - 结果只用于 `{{ }}` 文本插值，永远不交给 v-html，因此即使输入含脚本也不会被执行。
 * 维护说明：这里不是 HTML 净化器，不能用于“保留格式的富文本渲染”；若未来需要富文本，必须另行引入白名单净化方案。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

const decodeHtmlEntities = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
  if (entity.startsWith('#')) {
    const isHex = entity[1]?.toLowerCase() === 'x'
    const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10)
    // 非法码点或控制字符保持原样，避免把异常输入解码成不可见字符。
    if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 0x10ffff) {
      return match
    }
    return String.fromCodePoint(codePoint)
  }
  return NAMED_ENTITIES[entity.toLowerCase()] ?? match
})

/** 将可能含 HTML 标签的描述转为纯文本，保留段落换行。 */
export const htmlToPlainText = (value: string | null | undefined): string => {
  const source = value?.trim()
  if (!source) {
    return ''
  }
  // 快速路径：不含尖括号与实体时无需处理，避免对大目录逐条跑正则。
  if (!/[<&]/.test(source)) {
    return source
  }
  const withoutBlocks = source
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '· ')
    .replace(/<\/?(?:a|abbr|b|blockquote|br|code|div|em|h[1-6]|hr|i|img|li|ol|p|pre|section|article|span|strong|table|tbody|td|th|thead|tr|u|ul|script|style)(?=[\s/>])(?:[^"'>]|"[^"]*"|'[^']*')*>/gi, '')
    // 本地缓存会截断长描述，可能留下未闭合的半截标签（如结尾的 “<p”），一并去掉。
    .replace(/<\/?(?:p|div|span|br|li|strong|em|img)(?:\s[^>]*)?$/i, '')
  return decodeHtmlEntities(withoutBlocks)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
