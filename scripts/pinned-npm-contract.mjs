/** 纯源码契约：全部非Mobile Node阶段先安装固定官方npm，密钥作业内联可信引导而不执行PR checkout脚本。 */
import fs from 'node:fs'
import path from 'node:path'
import { PINNED_NPM, PINNED_NODE, NPM_TARBALL_URL, NPM_TARBALL_INTEGRITY } from '../backend/scripts/install-pinned-npm.mjs'

export function validatePinnedNpmToolchain(root = process.cwd(), read = name => fs.readFileSync(path.join(root, name), 'utf8')) {
  const errors = [], installer = read('backend/scripts/install-pinned-npm.mjs').replaceAll('\r\n', '\n').trimEnd()
  if (PINNED_NPM !== '11.21.2' || PINNED_NODE !== '22.23.5' || NPM_TARBALL_URL !== 'https://registry.npmjs.org/npm/-/npm-11.21.2.tgz'
    || !installer.includes(NPM_TARBALL_INTEGRITY)) errors.push('固定npm版本、Node或官方完整性常量不一致')
  let stageCount = 0
  for (const file of ['Dockerfile', 'Dockerfile.onebox', 'backend/Dockerfile', 'backend/Dockerfile.mysql']) {
    const source = read(file).replaceAll('\r\n', '\n')
    for (const stage of source.split(/(?=^FROM )/m).filter(value => /^FROM .*\$\{Y_LINK_NODE_IMAGE\}/.test(value))) {
      stageCount++
      const copy = file.startsWith('backend/') ? 'COPY scripts/install-pinned-npm.mjs /tmp/ylink-install-pinned-npm.mjs'
        : 'COPY backend/scripts/install-pinned-npm.mjs /tmp/ylink-install-pinned-npm.mjs'
      const install = stage.indexOf('RUN node /tmp/ylink-install-pinned-npm.mjs --context=image')
      const firstNpm = stage.search(/^RUN npm\b/m)
      if (!stage.includes(copy) || install < stage.indexOf(copy) || (firstNpm >= 0 && install > firstNpm)) errors.push(`${file}的${stage.split('\n')[0]}未在npm使用前固定工具`)
    }
  }
  if (stageCount !== 10) errors.push(`非Mobile Node镜像阶段应覆盖10项，实际${stageCount}`)
  let jobs = 0
  for (const file of ['verify-db-concurrency.yml', 'security-updates.yml', 'sonarcloud.yml']) {
    const source = read('.github/workflows/' + file).replaceAll('\r\n', '\n')
    for (const job of source.split(/(?=^  [a-zA-Z0-9_-]+:$)/m)) {
      if (!job.includes('uses: actions/setup-node@')) continue
      jobs++
      const setup = job.indexOf('uses: actions/setup-node@'), step = job.indexOf('name: 固定官方 npm 11.21.2（校验包完整性）')
      if (step < setup) errors.push(`${file} Node作业缺少固定npm步骤`)
      if (file === 'sonarcloud.yml' && /^  sonarcloud:/m.test(job)) {
        const start = "          node --input-type=module <<'Y_LINK_PINNED_NPM'\n", end = "          await installPinnedNpm('ci')\n          Y_LINK_PINNED_NPM"
        const inline = job.split(start)[1]?.split(end)[0]?.replace(/^          /gm, '').trimEnd()
        if (inline !== installer || job.includes('run: node backend/scripts/install-pinned-npm.mjs')) errors.push('Sonar密钥作业必须使用逐字一致的内联固定npm引导，不执行PR脚本')
      } else if (!job.includes('run: node backend/scripts/install-pinned-npm.mjs --context=ci')) errors.push(`${file} CI缺少同一固定npm安装机制`)
      const npmCommand = job.search(/^\s+(?:run: )?npm (?:ci|--prefix|run)\b/m)
      if (npmCommand >= 0 && (step < 0 || step > npmCommand)) errors.push(`${file} 在固定npm前执行依赖命令`)
    }
  }
  if (jobs !== 4) errors.push(`非Mobile Node CI作业应覆盖4项，实际${jobs}`)
  return errors
}
