import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dockerfiles = [
  'Dockerfile.onebox',
  'backend/Dockerfile',
]

for (const filePath of dockerfiles) {
  const source = readFileSync(filePath, 'utf8')
  assert.ok(
    source.includes('ARG Y_LINK_NODE_IMAGE='),
    `${filePath} should expose Y_LINK_NODE_IMAGE build arg for registry mirror override`,
  )
  assert.ok(
    !source.includes('FROM node:20-bookworm-slim'),
    `${filePath} should not pull node:20-bookworm-slim directly from Docker Hub`,
  )
  assert.ok(
    source.includes('${Y_LINK_NODE_IMAGE}'),
    `${filePath} should use Y_LINK_NODE_IMAGE in FROM instructions`,
  )
}

console.log('[verify:docker-base-image] Docker base image registry guard passed')
