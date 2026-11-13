/** 固定同版本完整 canvg raw 入口；保留四个渲染依赖，不为空别名任何 polyfill。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {parseAst} from 'rolldown/parseAst'
const manifest=JSON.parse(fs.readFileSync(new URL('./canvg-source-manifest.json',import.meta.url),'utf8'))
const sha=value=>createHash('sha256').update(value).digest('hex')
const exportsOf=source=>parseAst(source).body.filter(node=>node.type==='ExportNamedDeclaration').flatMap(node=>{assert.equal(node.declaration,null,'canvg 导出结构变化');return node.specifiers.map(spec=>spec.exported.name)}).sort()
export function canvgSourcePlugin(){
 let root,seen=false
 return {name:'ylink-canvg-verified-full-source',enforce:'pre',apply:'build',
  configResolved(config){const require=createRequire(path.join(config.root,'package.json'));root=path.resolve(path.dirname(require.resolve('canvg')),'..')},
  buildStart(){
   for(const [file,hash] of Object.entries(manifest)){const absolute=path.join(root,file);this.addWatchFile(absolute);assert.equal(sha(fs.readFileSync(absolute)),hash,'canvg 源码变化，拒绝未经复核入口：'+file)}
   const descriptor=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));assert.equal(descriptor.version,'3.0.11');assert.equal(descriptor.raw,'lib/index.babel.js')
   const original=exportsOf(fs.readFileSync(path.join(root,'lib/index.es.js'),'utf8'));const raw=fs.readFileSync(path.join(root,descriptor.raw),'utf8');assert.equal(original.length,86);assert.deepEqual(exportsOf(raw),original,'canvg 完整导出清单变化')
   const imports=parseAst(raw).body.filter(node=>node.type==='ImportDeclaration').map(node=>node.source.value).sort();assert.deepEqual(imports,['raf','rgbcolor','stackblur-canvas','svg-pathdata'],'canvg 四个渲染依赖变化')
  },
  resolveId(id){if(id==='canvg')return path.join(root,'lib/index.babel.js')},
  transform(code,id){const relative=path.relative(root,id.split('?')[0]).replaceAll('\\','/');if(relative.startsWith('../')||path.isAbsolute(relative))return null;assert.equal(relative,'lib/index.babel.js','出现未经审查的 canvg 构建入口');assert.equal(sha(code),manifest[relative],'canvg 转换前源码变化');seen=true;return null},
  buildEnd(error){if(!error)assert.ok(seen,'生产图缺少完整 canvg 入口')},
 }
}
