import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
assert.ok(readFileSync('Dockerfile', 'utf8').includes('FROM nginx:1.30.6-alpine AS runtime'), '独立前端 Nginx 必须固定批准的补丁版本')

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
const buildJobSource = workflowSource.split('\n  build:\n')[1]?.split('\n  merge:\n')[0]
assert.ok(buildJobSource, '镜像发布工作流应包含 build 作业')
const buildStepSource = buildJobSource.split('\n      - name: 构建并按 digest 推送\n')[1]?.split('\n      - name: 导出 digest\n')[0]
assert.ok(buildStepSource, 'build 作业应包含按 digest 推送步骤')
assert.match(
  buildJobSource,
  /- name: 登录 Docker Hub\s+if: \$\{\{ needs\.prepare\.outputs\.dockerhub_enabled == 'true' \}\}\s+uses: docker\/login-action@v4\s+with:\s+username: \$\{\{ secrets\.DOCKERHUB_USERNAME \}\}\s+password: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/,
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
