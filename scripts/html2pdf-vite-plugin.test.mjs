/** 文件职责：检查生产 PDF 完整源码入口及失败关闭保护。 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import test from 'node:test'
import {html2pdfSourcePlugin} from './html2pdf-source-guard.mjs'
const require=createRequire(import.meta.url)
const root=process.cwd()
const vendor=require.resolve('html2pdf.js/package.json').replace(/package\.json$/, '')
const create=()=>{const plugin=html2pdfSourcePlugin();plugin.configResolved({root});plugin.buildStart.call({addWatchFile(){}});return plugin}
test('生产入口保留完整插件并拒绝缺失和篡改',()=>{
 const p=create();assert.equal(p.resolveId('unrelated'),undefined)
 assert.equal(p.resolveId('html2pdf.js').replaceAll('\\','/'),vendor.replaceAll('\\','/')+'src/index.js')
 assert.throws(()=>p.buildEnd(),/缺少必需模块/)
 for(const name of ['index.js','worker.js','utils.js','plugin/jspdf-plugin.js','plugin/pagebreaks.js','plugin/hyperlinks.js']){
  const id=vendor+'src/'+name;const source=readFileSync(id,'utf8');assert.throws(()=>p.transform(source+'\n',id),/源码变化/);assert.equal(p.transform(source,id),null)
 }
 p.buildEnd();p.buildStart.call({addWatchFile(){}});p.buildEnd()
 assert.throws(()=>p.transform('',vendor+'dist/html2pdf.js'),/未审查模块/)
})
