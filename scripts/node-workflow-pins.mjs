/** 检查本项目 setup-node 步骤的精确版本，不把本地工具缓存匹配当作最新安全补丁。 */
const requiredWorkflows = new Map([
  ['.github/workflows/verify-db-concurrency.yml', 1],
  ['.github/workflows/security-updates.yml', 1],
  ['.github/workflows/sonarcloud.yml', 2],
  ['.github/workflows/mobile-check.yml', 2],
])

/** 只接受本项目现有的显式 setup-node/with/node-version 结构；表达式或间接版本必须重新核实。 */
export function validateWorkflowNodePins(workflows, expectedVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? '')) return ['缺少明确的项目 Node 补丁版本']
  const errors = []
  const counts = new Map()
  for (const { file, content } of workflows) {
    const lines = (content ?? '').split(/\r?\n/)
    let count = 0
    for (let index = 0; index < lines.length; index += 1) {
      const step = /^(\s*)(-\s+)?uses:\s*actions\/setup-node@\S+/.exec(lines[index])
      if (!step) continue
      count += 1
      const stepIndent = step[1].length - (step[2] ? 0 : 2)
      const versions = []
      let inWith = false
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next]
        if (!line.trim() || line.trimStart().startsWith('#')) continue
        const indent = /^\s*/.exec(line)[0].length
        if (indent <= stepIndent) break
        if (indent === stepIndent + 2) inWith = /^\s*with:\s*(?:#.*)?$/.test(line)
        if (inWith && indent === stepIndent + 4 && /^\s*node-version:/.test(line)) {
          const match = /^\s*node-version:\s*(?:"([^"]+)"|'([^']+)'|([^#]*?))\s*(?:#.*)?$/.exec(line)
          versions.push((match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim())
        }
      }
      if (versions.length !== 1 || versions[0] !== expectedVersion) {
        errors.push(`${file}:${index + 1} setup-node 必须显式固定 ${expectedVersion}，不能使用浮动、表达式、错误补丁或缺失版本`)
      }
    }
    counts.set(file, count)
  }
  for (const [file, expectedCount] of requiredWorkflows) {
    if (counts.get(file) !== expectedCount) errors.push(`${file} 应有 ${expectedCount} 个受保护的 setup-node 步骤，实际 ${counts.get(file) ?? 0}`)
  }
  return errors
}
