/** 非Mobile固定派生npm/可信内联及SQLite缓存契约；这里只读取源码与纯数据。 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PINNED_NPM, PINNED_NODE, NPM_TARBALL_URL } from '../backend/scripts/install-pinned-npm.mjs'
import { BASE_SOURCE, SOURCE_POLICY_SHA256 } from '../backend/scripts/build-pinned-npm.mjs'
const digest = text => createHash('sha256').update(text).digest('hex')
const title = '固定派生 npm 11.21.2-ylink.1（官方源/本地修订校验）'

/** 可信代码只来自工作流内联；仓库只提供由内联固定哈希验证的纯数据。 */
export function renderTrustedNpmSteps(builder, installer) {
  if (!builder.endsWith('\n') || !installer.endsWith('\n')) throw Error('可信模块必须保留末尾换行')
  const indent = value => value.replace(/\n$/, '').split('\n').map(line => line ? '          ' + line : '').join('\n')
  const split = builder.lastIndexOf('\n', Math.floor(builder.length / 2)) + 1
  const parts = [builder.slice(0, split), builder.slice(split)]
  const partNames = ['build-pinned-npm.part1', 'build-pinned-npm.part2']
  const directoryGuard = [
    '          node --input-type=module <<\'Y_LINK_TRUSTED_DIRECTORY\'',
    '          import fs from \'node:fs\'',
    '          import path from \'node:path\'',
    '          const directory = fs.realpathSync(process.env.Y_LINK_TRUSTED_NPM_DIRECTORY)',
    '          if (directory !== process.env.Y_LINK_TRUSTED_NPM_DIRECTORY || path.dirname(directory) !== fs.realpathSync(process.env.RUNNER_TEMP) || !/^ylink-pinned-npm\\.[A-Za-z0-9]{6}$/.test(path.basename(directory))) throw Error(\'可信工具临时目录归属不符\')',
    '          Y_LINK_TRUSTED_DIRECTORY',
  ]
  return [
    '      - name: 准备可信派生 npm 构建引导',
    '        id: pinned-npm-trusted-bootstrap',
    '        shell: bash',
    '        run: |',
    '          trusted_dir="$(mktemp -d "' + '$' + '{RUNNER_TEMP:?}/ylink-pinned-npm.XXXXXX")"',
    '          set -C',
    '          cat > "$trusted_dir/' + partNames[0] + '" <<\'Y_LINK_PINNED_NPM_BUILDER_PART1\'',
    indent(parts[0]),
    '          Y_LINK_PINNED_NPM_BUILDER_PART1',
    '          printf \'directory=%s\\n\' "$trusted_dir" >> "$GITHUB_OUTPUT"',
    '',
    '      - name: 续写可信派生 npm 构建引导',
    '        shell: bash',
    '        env:',
    '          Y_LINK_TRUSTED_NPM_DIRECTORY: ' + '$' + '{{ steps.pinned-npm-trusted-bootstrap.outputs.directory }}',
    '        run: |',
    ...directoryGuard,
    '          set -C',
    '          cat > "$Y_LINK_TRUSTED_NPM_DIRECTORY/' + partNames[1] + '" <<\'Y_LINK_PINNED_NPM_BUILDER_PART2\'',
    indent(parts[1]),
    '          Y_LINK_PINNED_NPM_BUILDER_PART2',
    '',
    '      - name: ' + title,
    '        shell: bash',
    '        env:',
    '          Y_LINK_TRUSTED_NPM_DIRECTORY: ' + '$' + '{{ steps.pinned-npm-trusted-bootstrap.outputs.directory }}',
    '        run: |',
    ...directoryGuard,
    '          set -C',
    '          cat > "$Y_LINK_TRUSTED_NPM_DIRECTORY/install-pinned-npm.mjs" <<\'Y_LINK_PINNED_NPM_INSTALLER\'',
    indent(installer),
    '          Y_LINK_PINNED_NPM_INSTALLER',
    '          node --input-type=module <<\'Y_LINK_PINNED_NPM\'',
    '          import fs from \'node:fs\'',
    '          import path from \'node:path\'',
    '          import { createHash } from \'node:crypto\'',
    '          import { pathToFileURL } from \'node:url\'',
    '          const parent = fs.realpathSync(process.env.RUNNER_TEMP)',
    '          const directory = fs.realpathSync(process.env.Y_LINK_TRUSTED_NPM_DIRECTORY)',
    '          if (path.dirname(directory) !== parent || !/^ylink-pinned-npm\\.[A-Za-z0-9]{6}$/.test(path.basename(directory))) throw Error(\'可信工具临时目录归属不符\')',
    '          const modules = new Map()',
    '          for (const [name, expected] of ' + JSON.stringify([...partNames.map((name, index) => [name, digest(parts[index])]), ['install-pinned-npm.mjs', digest(installer)]]) + ') {',
    '            const file = path.join(directory, name), stat = fs.lstatSync(file)',
    '            if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw Error(\'可信引导文件归属不符\')',
    '            const bytes = fs.readFileSync(file)',
    '            if (createHash(\'sha256\').update(bytes).digest(\'hex\') !== expected) throw Error(\'可信引导字节不符\')',
    '            modules.set(name, bytes)',
    '          }',
    '          const builder = Buffer.concat(' + JSON.stringify(partNames) + '.map(name => modules.get(name)))',
    '          if (createHash(\'sha256\').update(builder).digest(\'hex\') !== ' + JSON.stringify(digest(builder)) + ') throw Error(\'可信完整模块字节不符\')',
    '          fs.writeFileSync(path.join(directory, \'build-pinned-npm.mjs\'), builder, { flag: \'wx\', mode: 0o600 })',
    '          try {',
    '            const { installPinnedNpm } = await import(pathToFileURL(path.join(directory, \'install-pinned-npm.mjs\')))',
    '            await installPinnedNpm(\'ci\', { dataDirectory: path.resolve(\'backend/npm-toolchain\') })',
    '          } finally { fs.rmSync(directory, { recursive: true }) }',
    '          Y_LINK_PINNED_NPM',
    '',
  ].join('\n')
}

/** 按当前YAML缩进保守计算正文长度；不执行或展开表达式。 */
export function workflowRunLengths(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n'), result = []
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s+)(?:-\s+)?run:\s*(.*)$/)
    if (!match) continue
    let body = match[2]
    if (/^[|>][+-]?$/.test(body)) {
      const indent = match[1].length, block = []
      for (let next = index + 1; next < lines.length; next++) {
        if (lines[next].trim() && lines[next].match(/^ */)[0].length <= indent) break
        block.push(lines[next].slice(indent + 2))
      }
      body = block.join('\n') + '\n'
    }
    result.push({ line: index + 1, characters: body.length })
  }
  return result
}
export function validateControlledSqliteCi(root = process.cwd(), read = name => fs.readFileSync(path.join(root, name), 'utf8')) {
  const errors = []
  for (const file of ['sonarcloud.yml', 'verify-db-concurrency.yml']) {
    const source = read('.github/workflows/' + file).replaceAll('\r\n', '\n')
    const runtime = file === 'sonarcloud.yml' ? source.split(/^  sonarcloud:/m)[0] : source
    const cache = runtime.split('\n').find(line => line.trimStart().startsWith('key: backend-node-modules')) ?? ''
    for (const input of ['backend/package-lock.json', 'backend/package.json', 'backend/src/database/pinned-sqlite-source.json',
      'backend/scripts/*pinned-sqlite*.mjs', 'backend/npm-toolchain/*.json', 'backend/scripts/*pinned-npm*.mjs']) {
      if (!cache.includes(input)) errors.push(file + '的原生缓存缺少策略输入' + input)
    }
    const guard = runtime.match(/^      - name: 校验实际 SQLite 绑定（缓存命中也执行）\n([\s\S]*?)(?=^      - |(?![\s\S]))/m)?.[1] ?? ''
    if (!guard.includes('run: node backend/scripts/verify-pinned-sqlite.mjs --project=backend --static') || /^\s+if:/m.test(guard)) errors.push(file + '必须在缓存命中后仍校验实际绑定')
    if (file === 'sonarcloud.yml' && (!runtime.includes('npm --prefix ./backend run postinstall') || /npm .*rebuild sqlite3/.test(runtime))) errors.push('coverage必须使用受控包级postinstall')
  }
  return errors
}
export function validatePinnedNpmToolchain(root = process.cwd(), read = name => fs.readFileSync(path.join(root, name), 'utf8')) {
  const errors = [], installer = read('backend/scripts/install-pinned-npm.mjs').replaceAll('\r\n', '\n')
  const builder = read('backend/scripts/build-pinned-npm.mjs').replaceAll('\r\n', '\n')
  if (PINNED_NPM !== '11.21.2-ylink.1' || PINNED_NODE !== '22.23.5' || NPM_TARBALL_URL !== BASE_SOURCE.url) errors.push('派生npm/官方基线/Node固定点不一致')
  try {
    const raw = read('backend/npm-toolchain/source-manifest.json'), policy = JSON.parse(raw)
    const lockRaw = read('backend/npm-toolchain/source-lock.json'), overlayRaw = read('backend/npm-toolchain/source-overlay.json')
    if (digest(raw) !== SOURCE_POLICY_SHA256 || digest(lockRaw) !== policy.sourceLockSha256 || digest(overlayRaw) !== policy.sourceOverlaySha256) errors.push('工具纯数据固定哈希不一致')
    const lock = JSON.parse(lockRaw), overlay = JSON.parse(overlayRaw)
    if (policy.revision !== PINNED_NPM || policy.node !== PINNED_NODE || overlay.revision !== PINNED_NPM
      || lock.format !== 'ylink-npm-source-archives-v1' || JSON.stringify(lock.base) !== JSON.stringify(BASE_SOURCE)) errors.push('工具来源/修订身份不一致')
  } catch { errors.push('固定工具纯数据缺失或格式不符') }
  if (/^import .*?from ['"](?!node:)/m.test(builder) || /^import .*?from ['"](?!node:|\.\/build-pinned-npm\.mjs['"])/m.test(installer)) errors.push('可信内联不得引入其它仓库可执行文件')
  let stageCount = 0
  for (const file of ['Dockerfile', 'Dockerfile.onebox', 'backend/Dockerfile', 'backend/Dockerfile.mysql']) {
    const source = read(file).replaceAll('\r\n', '\n')
    for (const stage of source.split(/(?=^FROM )/m).filter(value => /^FROM .*\$\{Y_LINK_NODE_IMAGE\}/.test(value))) {
      stageCount++
      const prefix = file.startsWith('backend/') ? '' : 'backend/'
      const copies = ['COPY ' + prefix + 'scripts/install-pinned-npm.mjs /tmp/ylink-install-pinned-npm.mjs',
        'COPY ' + prefix + 'scripts/build-pinned-npm.mjs /tmp/build-pinned-npm.mjs', 'COPY ' + prefix + 'npm-toolchain /tmp/ylink-npm-toolchain']
      const install = stage.indexOf('RUN node /tmp/ylink-install-pinned-npm.mjs --context=image --data-dir=/tmp/ylink-npm-toolchain')
      const firstNpm = stage.search(/^RUN npm\b/m)
      if (install < 0 || copies.some(copy => stage.indexOf(copy) < 0 || stage.indexOf(copy) > install) || firstNpm >= 0 && install > firstNpm) errors.push(file + '的' + stage.split('\n')[0] + '未先固定完整工具制品')
    }
  }
  if (stageCount !== 10) errors.push('非Mobile Node镜像应覆盖10阶段，实际' + stageCount)
  let jobs = 0
  for (const file of ['verify-db-concurrency.yml', 'security-updates.yml', 'sonarcloud.yml']) {
    const source = read('.github/workflows/' + file).replaceAll('\r\n', '\n')
    for (const step of workflowRunLengths(source)) if (step.characters > 21000) errors.push(file + ':' + step.line + '的run步骤超过21000字符')
    for (const job of source.split(/(?=^  [a-zA-Z0-9_-]+:$)/m)) {
      if (!job.includes('uses: actions/setup-node@')) continue
      jobs++
      const setup = job.indexOf('uses: actions/setup-node@'), step = job.indexOf('name: ' + title)
      if (step < setup) errors.push(file + '缺派生npm步骤')
      if (file === 'sonarcloud.yml' && /^  sonarcloud:/m.test(job)) {
        const start = job.indexOf('      - name: 准备可信派生 npm 构建引导'), end = job.indexOf('      - name: 安装类型声明所需依赖')
        if (start < 0 || end < start || job.slice(start, end).trimEnd() !== renderTrustedNpmSteps(builder, installer).trimEnd()
          || job.includes('run: node backend/scripts/install-pinned-npm.mjs')) errors.push('Sonar密钥job必须逐字匹配可信分步引导，禁止执行PR脚本')
      } else if (!job.includes('run: node backend/scripts/install-pinned-npm.mjs --context=ci')) errors.push(file + '缺同一派生工具安装器')
      const npmCommand = job.search(/^\s+(?:run: )?npm (?:ci|--prefix|run)\b/m)
      if (npmCommand >= 0 && (step < 0 || step > npmCommand)) errors.push(file + '在固定工具前运行依赖命令')
    }
  }
  if (jobs !== 4) errors.push('非Mobile Node CI应覆盖4job，实际' + jobs)
  errors.push(...validateControlledSqliteCi(root, read))
  return errors
}
