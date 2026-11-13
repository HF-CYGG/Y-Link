/** 生产静态验收宿主：不启动 Vite，不读取 .env；仅代理显式的回环隔离后端。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
export async function startProductionStaticServer({dist,backend,plugins=[]}){
 const root=fs.realpathSync(dist);assert.ok(fs.existsSync(path.join(root,'index.html'))||fs.existsSync(path.join(root,'scripts/voucher-visual-fixture.html')),'缺少正式构建产物')
 let target
 if(backend){target=new URL(backend);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.protocol,'http:');assert.ok(target.port&&!target.username&&!target.password)}
 const middlewares=[],requests=[];const host={middlewares:{use:fn=>middlewares.push(fn)}}
 for(const plugin of plugins)await plugin.configureServer?.(host)
 middlewares.push((request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1')
  if(target&&/^\/(?:api|health|uploads|__issues_verify)(?:\/|$)/.test(url.pathname)){
   const upstream=http.request(new URL(request.url,target),{method:request.method,headers:request.headers},remote=>{response.writeHead(remote.statusCode,remote.headers);remote.pipe(response)})
   upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end('isolated backend unavailable')});request.pipe(upstream);return
  }
  let candidate
  try{candidate=path.resolve(root,'.'+decodeURIComponent(url.pathname))}catch{response.writeHead(400);response.end();return}
  const relative=path.relative(root,candidate)
  if(relative.startsWith('..')||path.isAbsolute(relative)){response.writeHead(403);response.end();return}
  if(!fs.existsSync(candidate)||!fs.statSync(candidate).isFile()){
   if(url.pathname.startsWith('/assets/')||url.pathname.startsWith('/src/')){response.writeHead(404);response.end();return}
   candidate=path.join(root,'index.html')
  }
  if(!fs.existsSync(candidate)){response.writeHead(404);response.end();return}
  const real=fs.realpathSync(candidate),realRelative=path.relative(root,real)
  if(realRelative.startsWith('..')||path.isAbsolute(realRelative)){response.writeHead(403);response.end();return}
  response.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.pdf':'application/pdf'})[path.extname(real)]??'application/octet-stream');fs.createReadStream(real).pipe(response)
 })
 const server=http.createServer((req,res)=>{const record={path:req.url,status:null};requests.push(record);res.once('finish',()=>{record.status=res.statusCode});const dispatch=index=>Promise.resolve(middlewares[index](req,res,()=>dispatch(index+1))).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('isolated fixture failure')});void dispatch(0)})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 return {origin:'http://127.0.0.1:'+server.address().port,requests,config:{production:true,realBackend:Boolean(target)},close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
