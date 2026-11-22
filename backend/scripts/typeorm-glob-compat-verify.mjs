/** 对 TypeORM 实际 CJS glob 子树及目录加载器做跨平台固定 pattern/实体/迁移验证。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
const require=createRequire(new URL('../package.json',import.meta.url))
const ormEntry=require.resolve('typeorm')
const globEntry=require.resolve('glob',{paths:[path.dirname(ormEntry)]})
const globRequire=createRequire(globEntry)
function packageDescriptor(entry, expectedName) {
  let directory = path.dirname(fs.realpathSync(entry))
  while (true) {
    const file = path.join(directory, 'package.json')
    if (fs.existsSync(file)) {
      const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'))
      // dist/commonjs 的 type 描述符不是包身份，必须继续向上找到对应的包名。
      if (descriptor.name === expectedName && typeof descriptor.version === 'string') {
        return { ...descriptor, directory }
      }
    }
    const parent = path.dirname(directory)
    assert.notEqual(parent, directory, `无法从实际入口定位 ${expectedName} 的包级描述符`)
    directory = parent
  }
}
const globPackage = packageDescriptor(globEntry, 'glob')
const minimatchPackage = packageDescriptor(globRequire.resolve('minimatch'), 'minimatch')
assert.equal(globPackage.version,'14.0.3')
assert.equal(minimatchPackage.version,'11.0.2')
assert.match(packageDescriptor(ormEntry, 'typeorm').version,/^0\.3\./)

// 官方14.0.3发布tarball的两个默认bundle，逐字节比对过官方minimatch v11.0.2修复源码。
// 既检查入口和map配对，也检查map里的真实源码；外置包版本不能证明内嵌matcher安全。
// 来源：https://registry.npmjs.org/glob/14.0.3 与 https://github.com/isaacs/minimatch/tree/v11.0.2/src。
const fixedMatcherSources = {
  'assert-valid-pattern.ts': '8c005b3d77e34f87599bbfd348d9ac6ef9fc97044fd4170cc37d268c7ecfd9ee',
  'escape.ts': '9afe88446437ff605240a21d6c0a1afd8ebe839de679f57ae81a1828712b8068',
  'unescape.ts': '7a6eb135b52447fc50f8adc0bb78332f7594bb298ff7b01fc4e4ac7967759403',
  'index.ts': 'eff2f23257708f4bd102cf94d746c8f26f5887e993e6de0f3c139bdae924c37b',
}
const publishedBundles = {
  commonjs: {
    code: 'e0e787fa4b225c70db7aab2886011cae21855ef232908db066ce054c8f8ded16',
    map: 'c7d0d38a8e318cc679b5917150a42e01a4c6fed3301883d802611561af240dab',
  },
  esm: {
    code: '2f9b6d6d8afd271d48c25fdf87643983192cfefac359713c341136a39d635d49',
    map: '2b28349c7c9ff001b1b8f7473419f98a43fd64076a9de676731714e7b7f9a772',
  },
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
for (const [format, hashes] of Object.entries(publishedBundles)) {
  const entry = path.join(globPackage.directory, 'dist', format, 'index.min.js')
  assert.equal(sha256(fs.readFileSync(entry)), hashes.code, `${format}默认bundle必须是已核验发布物`)
  const mapBytes = fs.readFileSync(entry + '.map')
  assert.equal(sha256(mapBytes), hashes.map, `${format}默认bundle的source map必须配对`)
  const map = JSON.parse(mapBytes.toString('utf8'))
  const matcherSources = map.sources.flatMap((source, index) => {
    const marker = '/minimatch/src/'
    const offset = source.indexOf(marker)
    return offset < 0 ? [] : [[source.slice(offset + marker.length), sha256(map.sourcesContent[index])]]
  })
  assert.deepEqual(Object.fromEntries(matcherSources), fixedMatcherSources, '内嵌matcher不得回退到缺少GHSA-g3hv-75wg-m249修复的源码')
  if (format === 'commonjs') assert.equal(fs.realpathSync(globEntry), fs.realpathSync(entry))
}
const glob = globRequire('glob')
assert.equal(typeof glob.sync,'function');assert.equal(typeof glob.globSync,'function')
const {importClassesFromDirectories}=require(path.join(path.dirname(ormEntry),'util/DirectoryExportedClassesLoader.js'))
const {PlatformTools}=require(path.join(path.dirname(ormEntry),'platform/PlatformTools.js'))
const {DataSource}=require(ormEntry)
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'ylink-orm-glob-'))
let dataSource
try{
 for(const directory of ['entities/nested','migrations'])fs.mkdirSync(path.join(runtime,directory),{recursive:true})
 fs.writeFileSync(path.join(runtime,'entities/nested/fixture.cjs'),`const {EntitySchema}=require(${JSON.stringify(ormEntry)});module.exports=new EntitySchema({name:'GlobFixture',columns:{id:{type:Number,primary:true},label:{type:String}}})`)
 fs.writeFileSync(path.join(runtime,'entities/ignored.d.ts'),'export class Ignored {}')
 fs.writeFileSync(path.join(runtime,'migrations/fixture.cjs'),`module.exports=class GlobMigration1700000000000 {name='GlobMigration1700000000000';async up(q){await q.query('CREATE TABLE glob_migration_fixture (id INTEGER PRIMARY KEY)')}async down(q){await q.query('DROP TABLE glob_migration_fixture')}}`)
 const pattern=path.join(runtime,'entities/**/*.cjs')
 assert.equal(glob.sync(PlatformTools.pathNormalize(pattern)).length,1)
 assert.equal(glob.sync(PlatformTools.pathNormalize(pattern.replaceAll('\\','/'))).length,1)
 if(process.platform==='win32')assert.equal(glob.sync(PlatformTools.pathNormalize(pattern.replaceAll('/','\\'))).length,1)
 const logger={log(){}}
 const entities=await importClassesFromDirectories(logger,[path.join(runtime,'entities/**/*.{cjs,ts}')])
 const migrations=await importClassesFromDirectories(logger,[path.join(runtime,'migrations/*.cjs')])
 assert.equal(entities.length,1);assert.equal(migrations.length,1)
 dataSource=new DataSource({type:'sqlite',database:path.join(runtime,'fixture.sqlite'),entities:[path.join(runtime,'entities/**/*.cjs')],migrations:[path.join(runtime,'migrations/*.cjs')],synchronize:true})
 await dataSource.initialize();assert.equal(dataSource.entityMetadatas.length,1)
 await dataSource.getRepository('GlobFixture').save({id:1,label:'实际实体写入'})
 assert.equal((await dataSource.getRepository('GlobFixture').findOneByOrFail({id:1})).label,'实际实体写入')
 assert.equal((await dataSource.runMigrations()).length,1)
 await dataSource.query('INSERT INTO glob_migration_fixture(id) VALUES (1)')
 assert.equal((await dataSource.query('SELECT id FROM glob_migration_fixture'))[0].id,1)
 await dataSource.undoLastMigration()
 console.log(`[typeorm-glob] ${process.platform}/${process.arch} CJS、sync、固定 pattern、实体与真实 SQLite 迁移通过`)
}finally{if(dataSource?.isInitialized)await dataSource.destroy();fs.rmSync(runtime,{recursive:true,force:true})}
