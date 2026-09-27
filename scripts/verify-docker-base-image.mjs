import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dockerfiles = [
  'Dockerfile',
  'Dockerfile.onebox',
  'backend/Dockerfile',
  'backend/Dockerfile.mysql',
]
const publicEcrNodeImage = 'public.ecr.aws/docker/library/node:22-bookworm-slim'
const dockerHubNodeImage = 'docker.io/library/node:22-bookworm-slim'

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

console.log('[verify:docker-base-image] Docker base image registry guard passed')
