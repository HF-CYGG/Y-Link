# 客户端交互统一验收准备（尚未执行）

生产实现经本批审查集中修复后，只做主线一次定向闭环复核；放行后才执行下列验收。

## 运行环境和数据

在指定worktree根目录执行：

```powershell
$env:POLISH_EVIDENCE_DIR = 'C:\Temp\ylink-pensive-evidence'
node scripts/run-client-polish-lab.mjs
```

- 服务器只绑定127.0.0.1随机端口，控制台及 `lab-session.json` 给出准确origin。不会启动真实后端、DB、SMS、Docker或其他工作区服务。
- 浏览器打开origin；初次没有恢复会话痕迹时从真实登录页登录。账号为体验甲、体验乙、T001，测试密码FixturePass42；图形码1234，联系方式验证码123456。均为内存fixture凭据。
- 数据包含35个商城商品、分类甲/乙、单规格商品、有货s2/无货s3；o1待提货、o2已核销可退货、o3已取消；f1处理中、f2待确认可评价、f3已关闭。订单/反馈写入在内存变更，页面后续GET会读到变更；缺少fixture的API返回501并进入unexpected日志，不能当覆盖。
- Vite cache固定在本次POLISH_EVIDENCE_DIR下。需要前后对比时固定390x844/dark，与baseline-v3同视口主题；完整matrix另含320x740、1280x800、light/dark、touch/mouse/keyboard、reduce。

## 可执行控制及观测

运行后另一个PowerShell窗口使用准确origin：

```powershell
$origin = 'http://127.0.0.1:<lab-session.json端口>'
Invoke-RestMethod "$origin/__polish/state"
# 延迟特定真实页面请求，然后从页面实际点击对应操作
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"hold","key":"POST /api/o2o/mall/preorders"}'
# 页面离开/换号后释放旧响应
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"release","key":"POST /api/o2o/mall/preorders"}'
# 某请求仅失败一次
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"failure","key":"PATCH /api/client-auth/profile","status":503,"count":1}'
# session=null用于登录/注册/找回；A/B/teacher用于恢复会话，切换后须通过页面登录/重新读取me触发真实Store变化
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"session","user":null}'
# SSE及图片失败
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"sse","id":"f1"}'
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"images","mode":"all-fail"}'
# 只改变原图identity，小图地址保持不变，页面刷新库存后断言重新尝试原图
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"images","mode":"small-fail","keepSmall":true}'
```

`__polish/state` 的ledger包含实际请求method/path/query及脱敏payload、status；unexpected必须为空（故意测试资源404不计API缺失）。取消类场景要检查相应POST没有新增，不能仅看页面没有跳转。

## QR真实渲染边界

lab的测试插件仅包裹订单详情对qrcode的导入，成功仍调用真实qrcode库。DevTools执行以下命令注入失败/延迟；不得直接给生产组件或Store赋状态：

```javascript
// 首次渲染前的确定性注入：存入sessionStorage再reload，lab在应用入口前消费一次。
sessionStorage.setItem('polish.qrControl',JSON.stringify({fail:['LAB-PICKUP-o1'],hold:[]}));location.reload()
// 在当前页面延迟下一次生成：
__polishQrControl.fail.push('LAB-PICKUP-o1')
__polishQrControl.hold.push('LAB-PICKUP-o1')
// hold场景同样可通过sessionStorage在reload前固定；release仅完成测试边界，不改变业务状态。
__polishQrControl.release['LAB-PICKUP-o1']?.()
__polishQrControl.calls
```

退货双行场景先在o2实际提交两次退货，由state读取各qrPayload；第一张fail、第二张hold，在第一行点重新生成，再release第二张，断言两张最终均有成功QR。可用浏览器CDP addScriptToEvaluateOnNewDocument在加载前设置控制；不把浏览器截图上的占位当渲染成功。

## 覆盖矩阵与记录

完整动作、fixture控制、DOM/网络断言在 `client-polish-coverage.json`，31项均初始not_run。现有 `verify-client-interaction-polish.mjs` 自动覆盖商城/反馈指定竞态；其余条目使用本lab作手工真实浏览器验收，不伪称已自动覆盖。验收负责人按项实际操作后保存截图/连续帧及网络证据，再记录：

```powershell
Invoke-RestMethod "$origin/__polish/control" -Method Post -ContentType application/json -Body '{"action":"record","id":"AUTH1","status":"passed","evidence":["绝对截图路径","ledger断言记录路径"]}'
```

Ctrl+C关闭本lab，导出lab-state.json。脚本存在、服务可启动、收到200均不单独构成通过；每项必须满足具体动作断言。遇501、空页或未匹配数据应记失败/受阻，不能记已验证。

## 其余统一验收

- 原约定performance（复用其前端build）、后端build、编码、安全/路由及业务专项均待放行后执行。
- `cd backend; node --import tsx scripts/sql-like-literal-verify.ts`：真实SQLite :memory:查询 `%`、`_`、`!`、反斜杠的contains/prefix/OR语义；不是纯函数替身，不改LIKE实现。
- 真实MySQL LIKE、Redis多实例/失租约、实际Nginx请求/gzip/cache/private隔离目前未执行；Docker daemon未就绪时记环境受阻。真实SMS/邮件外发不在fixture覆盖之内。
