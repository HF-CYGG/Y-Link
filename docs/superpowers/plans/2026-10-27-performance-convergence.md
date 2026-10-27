# 性能收敛实施计划

> 执行约束：按本批主线合同由唯一工程负责人原地执行；全局批次审查/统一验收优先，不逐改TDD、不worktree、不自动commit、不再次委派。

**目标：** 保持原4690KiB总产物、855KiB首屏JS、3000ms冷启动预算与全部业务/安全语义，使原`npm run verify:performance`完整通过。

**架构：** 先隔离量化产物与真实启动阶段，以最小可归因改动消除冗余；数据库/加密/权限/迁移等必要就绪工作仍须完成后才listen成功。冷启动用固定全样本协议，不以复采最快值或调整就绪/fixture伪造收益。

**技术栈：** 现有Vue/TypeScript/Vite8/Oxc、Node22/tsx、Express/TypeORM/SQLite；无新依赖。

## 范围、非目标和责任

- 本批起点为补货086b快照，HEAD b4e0a853…；全部用户/补货改动保留。本批patch仅相对baseline-source字节副本，不对HEAD生成混合dirty补丁。
- 不改预算、计量口径、fixture规模、权限/KeepAlive/预热、首帧主题/CSP/缓存、PDF/扫码/图表低频懒加载和补货/SSE/并发语义。
- 不切分支/同步/提交/推送/部署，不操作用户数据库/8090/Docker，不写node_modules。
- 工程写入/集成/QA唯一负责人：当前GPT-6.1 Sol工程agent；主线负责决策，前端reader只读候选；实现整体完成后主线派一次针对本批实际增量的独立完整审查，集中修复后统一验收。

## 当前数据与候选

| 项目 | 当前证据 | 决策 |
| --- | --- | --- |
| 总产物 | 4,844,600 bytes；预算4,802,560，需减42,040 | 必须真实减少所有计入资源总量 |
| 首屏JS | 875,757 bytes；预算875,520，需减237 | 同时保留真实入口图与经典同步主题脚本计入 |
| 冷启动 | 本批固定原样本5370.53/3043.69/3133.59ms，均退出1；中位3133.59/最大5370.53 | 不选最快；ExcelJS一次模块树673.72ms，必要就绪校验不变 |
| Terser | 仅Mobile Metro链提供，Web `npm ci --workspaces=false`不保证 | 排除，不加依赖或声明绕过 |
| Oxc/现有资源 | 原压缩开关已启用；聚合扫码入口命名收口仍执行未用UI | 不动压缩器，采用低层惰性桥和同版本官方Code128预设 |
| 隔离组合候选 | 4,768,989 bytes / 首屏875,432 bytes；原预算脚本退出0，原dist哈希不变 | 主线批准实施；仅候选数据，最终正式build重新判定，首屏余量88 bytes |

## 步骤1：固定比较协议与基线

- [x] 在`performance-convergence/baseline.json`记录当前源文件SHA256、HEAD、原补货manifest；拟修改文件先在`baseline-source/`保存字节和哈希。原补货父目录证据只读。
- [x] 冷启动固定3次原`node scripts/verify-enterprise-core-paths.mjs`串行样本，每次新空SQLite/独立数据根、loopback3301。原spawn后起点、首次成功health终点、50ms探测、3000ms预算、fixture与断言全部不变；保留全部样本/中位数/最大值，不取最快。
- [x] 另固定1次诊断副本，仅加入stdout阶段接收时间及CPU profile，不改计时/断言/fixture；该样本分开标为诊断，不作预算通过证据。原Windows强杀不落CPU文件，按主线批准的既有tsx CLI入口完成一次纯import CPU诊断（不连DB）。前两次入口错误与全部样本保留。
- [x] 首次业务日志前2836.56ms，数据源36.5ms、结构244.9ms、账号哈希222.8ms。ExcelJS首个模块树673.72ms只计一次，不乘五；主线批准只延迟五服务八个原异步文件操作的模块导入。

## 步骤2：单次候选隔离与实施

- [x] 两次有界候选分别验证聚合入口/低层桥，以隔离outDir/cache/configLoader=runner构建；固定原target/chunk/CSS/统计图，无依赖安装。两次原dist/source哈希不变。
- [x] 主线批准三个同源路由工厂共享、扫码低层两值桥、Code128官方预设私有window静态包装；原文/许可保留、精确virtual ID、版本/指纹升级guard、无eval或全包pure。
- [x] 五服务八个异步操作共用ExcelJS模块Promise，失败重置、Workbook/Writer每请求独立。所有启动校验与listen/health代码未改；测试使用真实XLSX模板/导入解析/导出/流及编译后Node桥接。
- [ ] 写`performance.patch`与新快照，只相对本批baseline；回滚仅反向本批patch或恢复这份副本，禁止reset整文件至HEAD。

## 步骤3：一次审查、集中修复、统一验收

- [ ] 完整实现后冻结本批源码，主线派独立reviewer只审本批实际性能增量及必要影响链，一次完整审查后集中修复。
- [ ] 唯一QA执行原`npm run verify:performance`完整入口：前端build→构建预算→管理端核心路径/运行时→客户端并发→backend cwd客户端五场景→双预算汇总。任一步失败保留失败，不拼接子项冒充总通过。
- [ ] 正式验收前已固定后测组为3样本：统一入口core-paths为第1次，再串行执行两次原`node scripts/verify-enterprise-core-paths.mjs`；保留三个退出码、全样本、中位/最大，不因结果选择性复采。其他性能子项只在完整入口执行一次。
- [ ] `npm run verify:text-encoding`；后端TS有改动才跑`npm --prefix backend run build`，按真实影响保留路由/安全/默认初始化与补货前端行为专项。
- [ ] 生产编译产物的浏览器核心场景覆盖被改重模块/首帧主题与补货核心操作；不以dev-only冒烟替代。必要检查最终清单随实际采纳方案确定并写明，未受影响原数据库证据范围复用。
- [ ] 失败仅定向诊断/修复并重跑受影响项；连续两次同路径无实质进展上报。不得复采冷启动挑最快，或追加全审/全测。

## 最终必要检查清单（实现完成，当前尚未执行）

按`performance-convergence/acceptance-plan.md`唯一顺序执行：原完整性能入口与后两次固定启动样本单独占用资源；再执行后端build、真实八操作与生产Node桥接、既有报表/名单边界、低频导入/路由/扫码/真实Code128/原条码四模板与SFC状态、补货前端和编码。源码/测试/配置冻结后关联新snapshot，旧MySQL/补货事务/SSE结果仅按未改范围复用。

生产浏览器由主线持有唯一MCP会话执行：本批原/新真实chunk SVG比对及ZXing QR/Code128解码，随后静态preview实际应用首帧主题、路由共享壳/KeepAlive、条码四模板与批次、扫码文件入口、补货核心页。真实相机硬件、打印机物理输出不伪报。浏览器仅在三次启动采样全部完成后启动，子agent不抢占/reset主线profile。

## 输出

新批基线/方案/诊断/审查/快照/完整命令与退出状态/原始日志/生产产物行为/复用依据统一保存`performance-convergence/`，与原补货delivery-report和验收结果分开。按实际结果说明通过、失败、受阻与未测，不把新批授权扩张为部署或数据库操作。
