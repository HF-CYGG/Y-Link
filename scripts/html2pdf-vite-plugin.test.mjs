/** 文件职责：检查生产 PDF 完整源码入口及失败关闭保护。 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
import test from 'node:test'
import {html2pdfSourcePlugin} from './html2pdf-source-guard.mjs'
const require=createRequire(import.meta.url)
const root=process.cwd()
const vendor=require.resolve('html2pdf.js/package.json').replace(/package\.json$/, '')
const canvasPackage=require.resolve('html2canvas/package.json')
const canvasEntry=path.join(path.dirname(canvasPackage),require(canvasPackage).module)
const canvasSource=readFileSync(canvasEntry,'utf8')
const pdfPackage=require.resolve('jspdf/package.json')
const pdfEntry=path.join(path.dirname(pdfPackage),require(pdfPackage).module)
const create=()=>{const plugin=html2pdfSourcePlugin();plugin.configResolved({root});plugin.buildStart.call({addWatchFile(){}});return plugin}
test('生产入口保留完整插件并拒绝缺失和篡改',()=>{
 const p=create();assert.equal(p.resolveId('unrelated'),undefined)
 assert.equal(p.resolveId('html2pdf.js').replaceAll('\\','/'),vendor.replaceAll('\\','/')+'src/index.js')
 assert.throws(()=>p.buildEnd(),/缺少必需模块/)
 for(const name of ['index.js','worker.js','utils.js','plugin/jspdf-plugin.js','plugin/pagebreaks.js','plugin/hyperlinks.js']){
  const id=vendor+'src/'+name;const source=readFileSync(id,'utf8');assert.throws(()=>p.transform(source+'\n',id),/源码变化/);assert.equal(p.transform(source,id),null)
 }
 assert.throws(()=>p.buildEnd(),/必须包含已核验的 html2canvas Unicode 字符表/)
 assert.throws(()=>p.transform(canvasSource+'\n',canvasEntry),/html2canvas ESM 源码未经复核/)
 p.transform(canvasSource,canvasEntry)
 p.buildEnd();p.buildStart.call({addWatchFile(){}});p.buildEnd()
 assert.throws(()=>p.transform('',vendor+'dist/html2pdf.js'),/未审查模块/)
})

test('无损恢复 html2canvas 两份 Unicode 字符表，复用 jsPDF 的 fflate',()=>{
 const p=create()
 assert.equal(p.resolveId('html2canvas',path.join(vendor,'src/worker.js')),canvasEntry)
 assert.equal(p.resolveId('html2canvas',pdfEntry),canvasEntry)
 assert.equal(p.resolveId('html2canvas',import.meta.filename),undefined)
 assert.match(canvasSource,/export default html2canvas;/)
 const compact=p.transform(canvasSource,canvasEntry)
 const [codecImport,restoreExpression]=compact.split('\n',2)
 const codec=codecImport.match(/from '([^']+)'/)[1]
 const resolution=p.resolveId.call({resolve(id,importer,options){return {id,importer,options}}},codec)
 assert.equal(resolution.id,'fflate')
 assert.equal(resolution.options.skipSelf,true)
 const pdfRequire=createRequire(resolution.importer)
 assert.equal(pdfRequire('fflate/package.json').version,'0.8.3')
 const declarations=[...compact.matchAll(/^var (?:base64\$1|base64) = restorePdfUnicodeTrie\('[A-Za-z0-9+/=]+'\);$/gm)]
 assert.equal(declarations.length,2)
 const expected=[...canvasSource.matchAll(/^var (?:base64\$1|base64) = '([A-Za-z0-9+/=]+)';$/gm)].map(match=>match[1])
 const restore=new Function('inflatePdfUnicodeTrie',[
  restoreExpression,...declarations.map(match=>match[0]),'return [base64$1, base64]',
 ].join('\n'))
 assert.deepEqual(restore(pdfRequire('fflate/browser').inflateSync),expected)
 assert.ok(Buffer.byteLength(compact)<Buffer.byteLength(canvasSource)-60*1024,'应实际减小供应商 JS 编译输入')
})
