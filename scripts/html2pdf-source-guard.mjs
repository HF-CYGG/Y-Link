/**
 * 文件职责：核验 html2pdf.js 0.14.0 的全部插件入口，以及 html2canvas 字符表的无损编码。
 * 维护说明：保留供应商实现、DOMPurify 与全部 PDF 资源；源码或依赖版本变化须重新审查清单。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const manifest = JSON.parse(fs.readFileSync(new URL('./html2pdf-source-manifest.json', import.meta.url), 'utf8'))
const canvasSourceHash = 'c3b0b8b257996d79b5e362d2aee2411ff74fd23e984e9900f5ba005ea4753d64'
const canvasTrieHashes = {
  'base64$1': '2a00285184a835209c8590fa5611e7fb9665593eb6ff1023669af8f45c1099c3',
  base64: '81599cbbb36cbd25d1ac24a72a63ab501fdb9d9910df2d452e32116b3cb6421a',
}
const canvasTrieCodec = 'ylink:pdf/trie-inflate'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const listJs = (root, prefix = 'src') => fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? listJs(root, `${prefix}/${entry.name}`) : entry.name.endsWith('.js') ? [`${prefix}/${entry.name}`] : [])

function encodeCanvasTries(code) {
  assert.equal(sha256(code), canvasSourceHash, 'html2canvas ESM 源码未经复核')
  const trieNames = new Set()
  const compactCode = code.replace(/^var (base64\$1|base64) = '([A-Za-z0-9+/=]+)';$/gm, (_, name, value) => {
    const bytes = Buffer.from(value, 'ascii')
    assert.equal(sha256(bytes), canvasTrieHashes[name], `html2canvas Unicode 字符表变化：${name}`)
    assert.ok(!trieNames.has(name), `html2canvas Unicode 字符表重复：${name}`)
    trieNames.add(name)
    const compressed = deflateRawSync(bytes)
    assert.deepEqual(inflateRawSync(compressed), bytes, `html2canvas Unicode 字符表无损校验失败：${name}`)
    return `var ${name} = restorePdfUnicodeTrie('${compressed.toString('base64')}');`
  })
  assert.equal(trieNames.size, Object.keys(canvasTrieHashes).length, 'html2canvas 必须保留两份 Unicode 字符表')
  return [
    `import { inflateSync as inflatePdfUnicodeTrie } from '${canvasTrieCodec}';`,
    'const restorePdfUnicodeTrie = (encoded) => new TextDecoder().decode(inflatePdfUnicodeTrie(Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0))));',
    compactCode,
  ].join('\n')
}

export const html2pdfSourcePlugin = () => {
  let sourceRoot
  let canvasEntry
  let pdfEntry
  let canvasEncoded = false
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
        if (name === 'html2canvas') {
          assert.equal(descriptor.module, 'dist/html2canvas.esm.js', 'html2canvas 的 ESM 入口变化')
          canvasEntry = path.join(directory, descriptor.module)
        }
        if (name === 'jspdf') {
          assert.equal(descriptor.module, 'dist/jspdf.es.min.js', 'jsPDF 的 ESM 入口变化')
          pdfEntry = path.join(directory, descriptor.module)
        }
      }
      const pdfRequire = createRequire(pdfEntry)
      assert.equal(pdfRequire('fflate/package.json').version, '0.8.3', 'PDF 字符表使用的 fflate 版本未经复核')
    },
    buildStart() {
      // watch 缓存可复用已核验模块；每轮仍重新检查磁盘源码清单与哈希。
      assert.deepEqual([...listJs(sourceRoot), 'package.json'].sort(), Object.keys(manifest).sort(), 'PDF 供应商源码清单变化')
      for (const [name, hash] of Object.entries(manifest)) {
        const file = path.join(sourceRoot, name)
        this.addWatchFile(file)
        assert.equal(sha256(fs.readFileSync(file)), hash, `PDF 供应商源码变化：${name}`)
      }
      this.addWatchFile(canvasEntry)
      assert.equal(sha256(fs.readFileSync(canvasEntry)), canvasSourceHash, 'html2canvas ESM 源码未经复核')
    },
    resolveId(id, importer) {
      if (id === 'html2pdf.js') return path.join(sourceRoot, 'src/index.js')
      if (id === 'html2canvas' && importer) {
        const sourcePath = path.resolve(importer.split('?')[0])
        // 两个 PDF 调用方共用同版本官方 ESM 的默认导出，绕过包的 UMD browser 入口。
        if (sourcePath === path.join(sourceRoot, 'src/worker.js') || sourcePath === pdfEntry) return canvasEntry
      }
      // 通过 jsPDF 的实际 importer 解析，两个调用点始终复用同一浏览器版本。
      if (id === canvasTrieCodec) return this.resolve('fflate', pdfEntry, { skipSelf: true })
    },
    transform(code, id) {
      const sourcePath = id.split('?')[0]
      if (path.resolve(sourcePath) === canvasEntry) {
        const compact = encodeCanvasTries(code)
        canvasEncoded = true
        return compact
      }
      const relative = path.relative(sourceRoot, sourcePath).replaceAll('\\', '/')
      if (relative.startsWith('../') || path.isAbsolute(relative)) return null
      assert.ok(Object.hasOwn(manifest, relative), `PDF 构建出现未审查模块：${relative}`)
      assert.equal(sha256(code), manifest[relative], `PDF 转换前源码变化：${relative}`)
      visited.add(relative)
      return null
    },
    buildEnd(error) {
      if (error) return
      for (const name of ['src/index.js', 'src/worker.js', 'src/utils.js', 'src/plugin/jspdf-plugin.js', 'src/plugin/pagebreaks.js', 'src/plugin/hyperlinks.js']) {
        assert.ok(visited.has(name), `PDF 完整入口缺少必需模块：${name}`)
      }
      assert.ok(canvasEncoded, 'PDF 完整入口必须包含已核验的 html2canvas Unicode 字符表')
    },
  }
}
