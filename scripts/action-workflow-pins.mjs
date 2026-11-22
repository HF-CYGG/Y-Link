/** 工作流供应链契约：只接受从官方仓库 tag/commit 核验的固定版本与最小令牌权限。 */
export const officialActionPins = Object.freeze({
  'actions/checkout': ['d23441a48e516b6c34aea4fa41551a30e30af803', 'v6.1.0'],
  'actions/setup-node': ['49933ea5288caeca8642d1e84afbd3f7d6820020', 'v4.4.0'],
  'actions/cache': ['0057852bfaa89a56745cba8c7296529d2fc39830', 'v4.3.0'],
  'actions/upload-artifact': ['ea165f8d65b6e75b540449e92b4886f43607fa02', 'v4.6.2'],
  'actions/download-artifact': ['d3f86a106a0bac45b974a628896c90dbdf5c8093', 'v4.3.0'],
  'docker/setup-buildx-action': ['f87e5991a6d7451dcb8d9637bfbc97413f497069', 'v4.4.1'],
  'docker/login-action': ['8aa5831fb8d48d8f76594c7ddde61ae58019f550', 'v4.8.0'],
  'docker/metadata-action': ['dc802804100637a589fabce1cb79ff13a1411302', 'v6.2.0'],
  'docker/build-push-action': ['c3c9e263c25d99ce0380d002d59b67737d91b0dc', 'v7.4.0'],
  'SonarSource/sonarqube-scan-action': ['ba9859eae8dd6bd29e412f25ddbbef3d032000f4', 'v8.2.2'],
})

// 2026-11-14：通过 https://api.github.com/repos/<官方仓库>/git/ref/tags/<版本> 及官方 tags 列表核实。
// 更新 SHA 时须再次核验发布 tag 与 commit，不接受第三方示例提供的 SHA。
export function validateActionWorkflowPins(workflows) {
  const errors = []
  for (const { file, content } of workflows) {
    const lines = content.replaceAll('\r\n', '\n').split('\n')
    const permissionBlock = (start, indent) => {
      const entries = []
      for (let i = start + 1; i < lines.length; i++) {
        if (!lines[i].trim() || lines[i].trimStart().startsWith('#')) continue
        if (lines[i].search(/\S/) <= indent) break
        const match = new RegExp(`^ {${indent + 2}}([a-z-]+): (read|write|none)\\s*(?:#.*)?$`).exec(lines[i])
        entries.push(match ? `${match[1]}:${match[2]}` : 'unsupported')
      }
      return entries
    }
    const roots = lines.flatMap((line, index) => /^permissions:/.test(line) ? [index] : [])
    const root = roots[0] ?? -1
    if (roots.length !== 1 || lines[root].trim() !== 'permissions:' || permissionBlock(root, 0).join(',') !== 'contents:read') {
      errors.push(`${file} 默认 permissions 必须仅为 contents: read`)
    }
    let inJobs = false, job = ''
    const publishingJobs = new Set(), jobs = new Set(), permissionJobs = new Set()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^jobs:\s*$/.test(line)) inJobs = true
      else if (inJobs && /^\S/.test(line)) inJobs = false
      if (inJobs) {
        const heading = /^ {2}([\w-]+):\s*$/.exec(line)
        if (heading) {
          job = heading[1]
          if (jobs.has(job)) errors.push(`${file}:${i + 1} 禁止重复作业声明`)
          jobs.add(job)
        }
        if (/^ {4}permissions:/.test(line)) {
          if (permissionJobs.has(job)) errors.push(`${file}:${i + 1} 禁止重复作业权限声明`)
          permissionJobs.add(job)
          const permitted = file === '.github/workflows/docker-publish.yml' && ['build', 'merge'].includes(job)
          const entries = permissionBlock(i, 4)
          if (line.trim() !== 'permissions:' || !permitted || entries.length !== 2 || !entries.includes('contents:read') || !entries.includes('packages:write')) {
            errors.push(`${file}:${i + 1} 仅镜像 build/merge 作业允许 contents: read + packages: write`)
          } else publishingJobs.add(job)
        }
      }
      const use = /^\s+(?:-\s+)?uses:\s*(.+)$/.exec(line)
      if (!use) continue
      const pin = /^([\w.-]+\/[\w.-]+)@([a-f0-9]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/.exec(use[1])
      const expected = pin && officialActionPins[pin[1]]
      if (!pin || !expected || pin[2] !== expected[0] || pin[3] !== expected[1]) {
        errors.push(`${file}:${i + 1} 外部 Action 必须固定已核验官方完整 SHA 并注明 release`)
      }
      if (use[1].startsWith('actions/checkout@')) {
        const block = []
        for (let next = i + 1; next < lines.length; next++) {
          if (lines[next].trim() && !lines[next].trimStart().startsWith('#') && lines[next].search(/\S/) <= 6) break
          block.push(lines[next])
        }
        if (block.filter(value => /^ {10}persist-credentials: false\s*(?:#.*)?$/.test(value)).length !== 1
          || block.some(value => /persist-credentials:/.test(value) && !/^ {10}persist-credentials: false\s*(?:#.*)?$/.test(value))) {
          errors.push(`${file}:${i + 1} checkout 必须显式 persist-credentials: false`)
        }
      }
    }
    if (file === '.github/workflows/docker-publish.yml' && (!publishingJobs.has('build') || !publishingJobs.has('merge'))) {
      errors.push(`${file} build/merge 必须各自声明必要的 packages: write`)
    }
  }
  return errors
}
