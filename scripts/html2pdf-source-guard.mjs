/**
 * 文件职责：通过完整源码清单核验 html2pdf.js 0.14.0，再使用含全部插件的 ESM 入口。
 * 维护说明：不改供应商实现，不移除 DOMPurify；源码或依赖版本变化须重新审查清单。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const manifest = JSON.parse(fs.readFileSync(new URL('./html2pdf-source-manifest.json', import.meta.url), 'utf8'))
const listJs = (root, prefix = 'src') => fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? listJs(root, `${prefix}/${entry.name}`) : entry.name.endsWith('.js') ? [`${prefix}/${entry.name}`] : [])

export const html2pdfSourcePlugin = () => {
  let sourceRoot
  const visited = new Set()
  return {
    name: 'ylink-html2pdf-verified-source',
    enforce: 'pre',
    apply: 'build',
    configResolved(config) {
      const require = createRequire(path.join(config.root, 'package.json'))
      sourceRoot = path.dirname(require.resolve('html2pdf.js/package.json'))
      for (const [name, version] of Object.entries({ jspdf: '4.2.1', html2canvas: '1.4.1', dompurify: '3.4.17' })) {
        let directory = path.dirname(require.resolve(name))
        while (!fs.existsSync(path.join(directory, 'package.json'))) {
          const parent = path.dirname(directory)
          assert.notEqual(parent, directory, `PDF 依赖描述缺失：${name}`)
          directory = parent
        }
        const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
        assert.equal(descriptor.name, name, `PDF 依赖解析目标变化：${name}`)
        assert.equal(descriptor.version, version, `PDF 依赖版本未经复核：${name}`)
      }
    },
    buildStart() {
      // watch 缓存可复用已核验模块；每轮仍重新检查磁盘源码清单与哈希。
      assert.deepEqual([...listJs(sourceRoot), 'package.json'].sort(), Object.keys(manifest).sort(), 'PDF 供应商源码清单变化')
      for (const [name, hash] of Object.entries(manifest)) {
        const file = path.join(sourceRoot, name)
        this.addWatchFile(file)
        assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, `PDF 供应商源码变化：${name}`)
      }
    },
    resolveId(id) {
      if (id === 'html2pdf.js') return path.join(sourceRoot, 'src/index.js')
    },
    transform(code, id) {
      const relative = path.relative(sourceRoot, id.split('?')[0]).replaceAll('\\', '/')
      if (relative.startsWith('../') || path.isAbsolute(relative)) return null
      assert.ok(Object.hasOwn(manifest, relative), `PDF 构建出现未审查模块：${relative}`)
      assert.equal(createHash('sha256').update(code).digest('hex'), manifest[relative], `PDF 转换前源码变化：${relative}`)
      visited.add(relative)
      return null
    },
    buildEnd(error) {
      if (error) return
      for (const name of ['src/index.js', 'src/worker.js', 'src/utils.js', 'src/plugin/jspdf-plugin.js', 'src/plugin/pagebreaks.js', 'src/plugin/hyperlinks.js']) {
        assert.ok(visited.has(name), `PDF 完整入口缺少必需模块：${name}`)
      }
    },
  }
}
