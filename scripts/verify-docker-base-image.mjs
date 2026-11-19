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
assert.ok(oneboxRuntime.includes('CMD node -e'), '工具分层必须保留Node内置健康检查')
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
const webRuntime = webSource.split('FROM nginx:1.30.6-alpine AS runtime')[1]
assert.ok(webRuntime, '独立前端 Nginx 必须固定批准的补丁版本')
assert.ok(webRuntime.includes("grep -Eq '^3\\.24\\.' /etc/alpine-release"), 'Web运行包定向修补仅使用已核实的Alpine3.24分支')
assert.ok(webRuntime.includes('apk info -e zlib libxslt >/dev/null'), '两个目标运行库必须原已安装，不能新增运行包')
assert.ok(webRuntime.includes('apk add --no-cache --upgrade zlib=1.4-r0 libxslt=1.1.43-r4'), 'Web仅固定同源已核实的zlib/libxslt安全补丁版本')
for (const phase of ['before', 'after']) {
  assert.ok(webRuntime.includes(`${phase}_packages="$(apk info -v)"`), '包清单读取失败必须停止构建')
  assert.ok(webRuntime.includes(`${phase}_other="$(printf '%s\\n' "$${phase}_packages" | grep -Ev '^(zlib|libxslt)-[0-9]' | sort)"`), '比较清单只能排除这两个目标包')
}
assert.ok(webRuntime.includes('RUN set -eu;') && webRuntime.includes('test "$before_other" = "$after_other"'), '其它包的新增、删除或版本漂移必须使构建失败')
assert.ok(webRuntime.includes("grep -Fqx 'zlib-1.4-r0'") && webRuntime.includes("grep -Fqx 'libxslt-1.1.43-r4'"), '最终实际包版本必须匹配两个批准固定点')
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
