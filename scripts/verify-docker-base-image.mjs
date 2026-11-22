import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { validateActionWorkflowPins } from './action-workflow-pins.mjs'
import { validatePinnedNpmToolchain } from './pinned-npm-contract.mjs'

assert.deepEqual(validatePinnedNpmToolchain(), [], '全部非Mobile镜像/CI的固定npm完整性契约')

const dockerfiles = [
  'Dockerfile',
  'Dockerfile.onebox',
  'backend/Dockerfile',
  'backend/Dockerfile.mysql',
]
const publicEcrNodeImage = 'public.ecr.aws/docker/library/node:22.23.5-bookworm-slim'
const dockerHubNodeImage = 'docker.io/library/node:22.23.5-bookworm-slim'
const oneboxSource = readFileSync('Dockerfile.onebox', 'utf8')
const nginxSigningFingerprints = [
  '573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62',
  '8540A6F18833A80E9C1653A42FD21310B49F6B46',
  '9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3',
]
assert.deepEqual(
  oneboxSource.match(/nginx_key_fingerprints='([^']+)'/)?.[1].split(' '),
  nginxSigningFingerprints,
  'Onebox 仅允许官方固定的三把完整签名指纹',
)
assert.ok(oneboxSource.includes('grep -qx "fpr:::::::::$fingerprint:" || exit 1'), '每把允许的指纹核验失败都必须中止')
assert.ok(oneboxSource.includes('gpg --batch --export $nginx_key_fingerprints > /usr/share/keyrings/nginx-archive-keyring.gpg'), '独立 keyring 不得导出下载文件中的未知 key')
assert.ok(oneboxSource.includes('signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] https://nginx.org/packages/debian bookworm nginx'), '保留 bookworm 官方 stable 源和独立 signed-by')
assert.ok(oneboxSource.includes('ARG Y_LINK_NGINX_VERSION=1.30.6-1~bookworm'), 'Onebox Nginx 必须固定批准的 bookworm 补丁版本')
assert.ok(oneboxSource.includes('gpgv --status-fd 1 --keyring /usr/share/keyrings/nginx-archive-keyring.gpg /var/lib/apt/lists/nginx.org_packages_debian_dists_bookworm_InRelease'), '构建必须记录 APT 实际 InRelease 的有效完整签名者')
const signingStage = oneboxSource.split('FROM backend-prod-deps AS nginx-keyring')[1]?.split('FROM ${Y_LINK_NODE_IMAGE} AS runtime')[0]
const oneboxRuntime = oneboxSource.split('FROM ${Y_LINK_NODE_IMAGE} AS runtime')[1]
assert.ok(signingStage?.includes('gpg --batch --export $nginx_key_fingerprints'), '完整验钥只能在专门构建阶段完成')
assert.ok(oneboxRuntime?.includes('COPY --from=nginx-keyring /usr/share/keyrings/nginx-archive-keyring.gpg'), '最终层只使用已经完整指纹核验的keyring')
assert.doesNotMatch(oneboxRuntime, /apt-get install[^\n]*(?:\bcurl\b|\bgnupg\b)/, '下载/验钥工具不得留在最终运行闭包')
const imageHealthcheck = oneboxRuntime.match(/^HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3[ \t]+\\\r?\n[ \t]+CMD (\[[^\r\n]+\])[ \t]*$/m)
assert.ok(imageHealthcheck, 'Onebox 运行镜像必须定义带启动宽限期的可执行健康检查')
const imageHealthCommand = JSON.parse(imageHealthcheck[1])
assert.deepEqual(imageHealthCommand, [
  'node',
  '-e',
  "require('node:http').get('http://127.0.0.1/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))",
], '健康检查必须用 Node 内置 HTTP 检查容器回环的 /health，并以响应状态或连接失败设置退出码')

const oneboxService = readFileSync('compose.onebox.yml', 'utf8').split(/^  ylink:[ \t]*\r?\n/m)[1]?.split(/^(?:\S| {2}\S)/m)[0] ?? ''
const composeHealthcheck = oneboxService.match(/^    healthcheck:[ \t]*\r?\n((?: {6}[^\r\n]*\r?\n)+)/m)?.[1] ?? ''
const composeHealthTest = composeHealthcheck.match(/^      test:[ \t]*\r?\n((?:        - [^\r\n]+\r?\n)+)/m)?.[1] ?? ''
const composeHealthCommand = [...composeHealthTest.matchAll(/^        - (.+)$/gm)].map(([, argument]) =>
  argument.startsWith('"') ? JSON.parse(argument) : argument)
assert.deepEqual(composeHealthCommand, ['CMD', ...imageHealthCommand], 'Onebox Compose 必须使用和运行镜像一致的 Node 健康检查命令')
for (const [key, value] of [['interval', '30s'], ['timeout', '5s'], ['start_period', '20s'], ['retries', '3']]) {
  assert.match(composeHealthcheck, new RegExp('^      ' + key + ':[ \\t]+' + value + '[ \\t]*$', 'm'), 'Onebox Compose 健康检查的 ' + key + ' 必须与镜像一致')
}
for (const file of ['Dockerfile.onebox', 'backend/Dockerfile']) {
  const source = readFileSync(file, 'utf8')
  assert.ok(source.includes('scripts/install-pinned-sqlite.mjs ./scripts/'), `${file}必须在原生npm ci之前提供受控安装入口`)
  assert.ok(source.indexOf('scripts/install-pinned-sqlite.mjs ./scripts/') < source.indexOf('RUN npm ci --omit=dev'), `${file}不得绕过默认原生postinstall`)
  assert.ok(source.includes('ENV npm_config_nodedir=/usr/local'), `${file}必须复用镜像既有Node头文件`)
  assert.ok(source.includes('node_modules/.ylink-native-sqlite /usr/local/share/ylink-native-sqlite/'), `${file}必须携带实际绑定证明而非只携带版本声明`)
}
const backendScripts = JSON.parse(readFileSync('backend/package.json')).scripts
assert.equal(backendScripts.postinstall, 'node scripts/install-pinned-sqlite.mjs', '普通backend安装必须受控重建，不仅Docker替换')
// 两个独立后端以业务Node作为主进程；不能让npm/shell截断SIGTERM或计划退出75。
assert.equal(backendScripts.start, 'node dist/index.js', '直接容器入口必须与现有start脚本保持一致')
assert.equal(backendScripts.prestart, undefined, '新增prestart需要同步直接容器入口的生命周期约定')
assert.equal(backendScripts.poststart, undefined, '新增poststart需要同步直接容器入口的生命周期约定')
for (const file of ['backend/Dockerfile', 'backend/Dockerfile.mysql']) {
  const commands = [...readFileSync(file, 'utf8').matchAll(/^CMD\s+(.+)$/gm)]
  assert.equal(commands.length, 1, `${file}必须有唯一的业务运行入口`)
  assert.deepEqual(JSON.parse(commands[0][1]), ['node', 'dist/index.js'], `${file}必须让业务Node直接接收信号并保留退出码`)
}
const mysqlSource = readFileSync('backend/Dockerfile.mysql', 'utf8')
assert.ok(mysqlSource.includes('npm ci --ignore-scripts'), 'MySQL-only构建显式跳过不会保留的SQLite安装hook')
assert.ok(mysqlSource.includes('npm uninstall sqlite3 --ignore-scripts') && mysqlSource.includes('test ! -e node_modules/sqlite3'), 'MySQL-only卸载不得重新构建SQLite，最终必须不存在')
const webSource = readFileSync('Dockerfile', 'utf8')
const alpineBase = webSource.split('FROM nginx:1.30.6-alpine AS alpine-native-base')[1]?.split('FROM alpine-native-base AS alpine-native-build')[0]
assert.ok(alpineBase, '独立前端基座必须固定批准的Nginx补丁版本')
const webRuntime = webSource.split('FROM alpine-native-base AS runtime')[1]
assert.ok(webRuntime, '最终层必须继承原基座并单独更新官方运行包')
assert.doesNotMatch(alpineBase, /apk[^\n]*--repositories-file|libxml2>=|libxslt>=|zlib>=/, '候选使用的共用基座必须保留固定的原包修订')
const alpineCandidate = webSource.split('FROM alpine-native-base AS alpine-native-build')[1]?.split('FROM alpine-native-base AS runtime')[0]
assert.ok(alpineCandidate?.includes('COPY docker/alpine-native-security /opt/ylink-alpine-security'), '候选stage必须消费固定完整生产/安装契约')
assert.ok(alpineCandidate.includes('--mount=from=alpine-native-base,source=/,target=/mnt/ylink-alpine-original,ro'), '候选必须只读挂载升级前的原基座')
assert.ok(alpineCandidate.includes('python3 /opt/ylink-alpine-security/build.py --candidate-only'), '候选构建必须显式选择未验收模式')
assert.doesNotMatch(webRuntime, /--from=alpine-native-build|\/tmp\/ylink-alpine-security\/install\.sh/, '普通前端不得消费未验收候选 APK')
for (const file of ['backend/Dockerfile', 'backend/Dockerfile.mysql', 'Dockerfile.onebox']) {
  const source = readFileSync(file, 'utf8'), prefix = file === 'Dockerfile.onebox' ? 'backend/' : ''
  const baseline = source.split(/ AS native-security-build\r?\n/)[1]?.split(/^FROM /m)[0]
  const runtime = source.split(/ AS runtime\r?\n/)[1]
  assert.ok(baseline?.includes(`COPY ${prefix}native-security/baseline-v7 /ylink-native-security`), `${file}普通链只构建冻结v7资产`)
  assert.ok(runtime?.includes('COPY --from=native-security-build /native-out /tmp/ylink-native-security'), `${file}保留原已接受的libblkid/zlib闭包`)
  assert.ok(runtime.includes(`${prefix}native-security/baseline-v7/install-backports.mjs ${prefix}native-security/baseline-v7/source-pins.json`), `${file}原安装器及pins不能与新候选混用`)
  assert.doesNotMatch(runtime, /--from=(?:native-security-candidate|glibc-security-build|package-security-candidate|gcc-security-candidate|node-security-candidate)/, `${file}普通runtime不得引用本批候选`)
  for (const target of ['native-security-candidate', 'glibc-security-build', 'package-security-candidate', 'gcc-security-candidate', 'node-security-candidate']) assert.ok(new RegExp(' AS ' + target + '\\r?$', 'm').test(source), `${file}保留独立候选target：${target}`)
}
const alpineInstall = readFileSync('docker/alpine-native-security/install.sh', 'utf8')
assert.ok(alpineInstall.includes('--keys-dir /tmp/ylink-alpine-security/keys'), '只能使用本批独立keys-dir')
assert.ok(alpineInstall.includes('--no-network') && alpineInstall.includes('--simulate'), '安装禁止网络且必须核对模拟事务')
assert.ok(alpineInstall.includes('sh ./verify-candidate-policy.sh'), '候选状态必须由producer机器契约严格消费')
assert.ok(alpineInstall.includes('verify_payload after.tsv') && alpineInstall.includes('cmp -s after-packages.tsv current-packages.tsv'), '必须比较完整载荷与全运行包库存')
assert.doesNotMatch(alpineInstall, /--allow-untrusted|--force-|--no-check-certificate|cp[^\n]*\/etc\/apk\/keys/)
assert.ok(webRuntime.includes("grep -Eq '^3\\.24\\.' /etc/alpine-release"), 'Web运行包定向修补仅使用已核实的Alpine3.24分支')
assert.ok(webRuntime.includes('apk info -e zlib libxml2 libxslt >/dev/null'), '允许升级的三个包必须原已安装')
assert.match(webRuntime, /apk --repositories-file \/dev\/null \s*\\\r?\n\s*--repository https:\/\/dl-cdn\.alpinelinux\.org\/alpine\/v3\.24\/main \s*\\\r?\n\s*--repository https:\/\/dl-cdn\.alpinelinux\.org\/alpine\/v3\.24\/community \s*\\\r?\n\s*add --no-cache --upgrade 'zlib>=1\.4-r0' 'libxml2>=2\.13\.9-r3' 'libxslt>=1\.1\.43-r4';/,
  'Web 更新仅接受 Alpine 3.24 官方仓库中达到版本下限的 zlib、libxml2 与 libxslt')
for (const phase of ['before', 'after']) {
  assert.ok(webRuntime.includes(`${phase}_packages="$(apk info -v)"`), '包清单读取失败必须停止构建')
  assert.ok(webRuntime.includes(`${phase}_other="$(printf '%s\\n' "$${phase}_packages" | grep -Ev '^(zlib|libxml2|libxslt)-[0-9]' | LC_ALL=C sort)"`), '比较清单只能排除这三个既有包')
}
assert.ok(webRuntime.includes('RUN set -eu;') && webRuntime.includes('test "$before_other" = "$after_other"'), '其它包的新增、删除或版本漂移必须使构建失败')
assert.ok(webRuntime.includes('for requirement in zlib:1.4-r0 libxml2:2.13.9-r3 libxslt:1.1.43-r4; do')
  && webRuntime.includes('test -n "$installed"')
  && webRuntime.includes('apk version --test "$previous" "$minimum"')
  && webRuntime.includes('apk version --test "$installed" "$minimum"')
  && webRuntime.includes("'='|'>') ;;"), '三个包必须保留，版本经原生比较达到下限且不得降级')
assert.doesNotMatch(webRuntime, /\bapk\s+upgrade\b|--allow-untrusted|--no-check-certificate/, '不得整体升级或绕过包来源验证')

for (const filePath of dockerfiles) {
  const source = readFileSync(filePath, 'utf8')
  assert.ok(
    source.includes('ARG Y_LINK_NODE_IMAGE='),
    `${filePath} should expose Y_LINK_NODE_IMAGE build arg for registry mirror override`,
  )
  assert.ok(
    source.includes(`ARG Y_LINK_NODE_IMAGE=${publicEcrNodeImage}`),
    `${filePath} 应保留无 Docker Hub 凭据时的公共 ECR 默认镜像`,
  )
  assert.ok(
    !/FROM\s+(?:--platform=\S+\s+)?node:20-bookworm-slim/.test(source),
    `${filePath} should not use the EOL Node 20 base image directly`,
  )
  assert.ok(
    source.includes('${Y_LINK_NODE_IMAGE}'),
    `${filePath} should use Y_LINK_NODE_IMAGE in FROM instructions`,
  )
}

const workflowSource = readFileSync('.github/workflows/docker-publish.yml', 'utf8')
assert.deepEqual(validateActionWorkflowPins(readdirSync('.github/workflows').filter(file => /\.ya?ml$/.test(file))
  .map(file => ({ file: `.github/workflows/${file}`, content: readFileSync(`.github/workflows/${file}`, 'utf8') }))), [], '非 Mobile Action 固定点与最小权限契约')
const buildJobSource = workflowSource.split('\n  build:\n')[1]?.split('\n  merge:\n')[0]
assert.ok(buildJobSource, '镜像发布工作流应包含 build 作业')
const buildStepSource = buildJobSource.split('\n      - name: 构建并按 digest 推送\n')[1]?.split('\n      - name: 导出 digest\n')[0]
assert.ok(buildStepSource, 'build 作业应包含按 digest 推送步骤')
assert.match(
  buildJobSource,
  /- name: 登录 Docker Hub\s+if: \$\{\{ needs\.prepare\.outputs\.dockerhub_enabled == 'true' \}\}\s+uses: docker\/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4\.8\.0\s+with:\s+username: \$\{\{ secrets\.DOCKERHUB_USERNAME \}\}\s+password: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/,
  'build 作业应只在 Docker Hub 凭据齐备时登录，供基础镜像拉取使用',
)
assert.ok(
  buildJobSource.indexOf('      - name: 登录 Docker Hub') < buildJobSource.indexOf('      - name: 构建并按 digest 推送'),
  'build 作业必须在拉取基础镜像前登录 Docker Hub',
)
assert.ok(
  buildStepSource.includes(`Y_LINK_NODE_IMAGE=\${{ needs.prepare.outputs.dockerhub_enabled == 'true' && '${dockerHubNodeImage}' || '${publicEcrNodeImage}' }}`),
  'build 作业应在登录时改用 Docker Hub 基础镜像，无凭据时保留公共 ECR 默认值',
)

// 启动期 MySQL 自动迁移按 dist 相对路径读取 backend/sql，三类后端镜像都必须把 sql 放在 dist 同级。
const sqlPackagingRules = [
  ['Dockerfile.onebox', 'COPY backend/sql /app/backend/sql'],
  ['backend/Dockerfile', 'COPY --chown=node:node sql ./sql'],
  ['backend/Dockerfile.mysql', 'COPY --from=build --chown=node:node /app/sql ./sql'],
]
for (const [filePath, copyInstruction] of sqlPackagingRules) {
  assert.ok(
    readFileSync(filePath, 'utf8').includes(copyInstruction),
    `${filePath} 必须打包 MySQL 迁移脚本目录（${copyInstruction}），否则开启 DB_AUTO_MIGRATE 的启动会因缺脚本阻断`,
  )
}

console.log('[verify:docker-base-image] Docker base image registry guard passed')
