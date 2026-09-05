import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dockerfiles = [
  'Dockerfile',
  'Dockerfile.onebox',
  'backend/Dockerfile',
  'backend/Dockerfile.mysql',
]

for (const filePath of dockerfiles) {
  const source = readFileSync(filePath, 'utf8')
  assert.ok(
    source.includes('ARG Y_LINK_NODE_IMAGE='),
    `${filePath} should expose Y_LINK_NODE_IMAGE build arg for registry mirror override`,
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

console.log('[verify:docker-base-image] Docker base image registry guard passed')
