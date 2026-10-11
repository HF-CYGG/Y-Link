# PR #153 性能评审修复实施计划

> **执行方式：** 用户已要求修复当前 PR；由本任务唯一前端写入负责人在现有目录顺序执行，不新增 worktree 或子 agent。

**目标：** 消除管理端认证 Store 对低频 WebAuthn API 的首屏静态依赖，并在现有预算不变的前提下恢复全部性能门禁。

**结构：** 只在 `completeWebAuthnLogin` 被调用时导入 WebAuthn API；保留统一 Store 对登录态、Cookie 响应、取消信号与过渡态的现有处理。对总产物先量化归因，主线授权后仅缩短已核验 html2pdf Webpack 成品的内部模块 ID；供应商源码或闭合结构变化时拒绝构建。

**技术栈：** Vue 3、Pinia、TypeScript、Vite/Rolldown、Node.js 验证脚本。

## 全局约束

- 不改性能预算、coverage 排除项、认证语义、后端接口或依赖；不删除功能或隐藏构建产物。
- `src/store/modules/auth.ts` 是管理端鉴权状态唯一真源；只在成功且请求未中止后更新状态。
- 测试与构建产物由本任务独占；本地修复经独立复核及主线放行前不提交、推送或回复 PR。

### 任务 1：确认并消除静态导入

**文件：** `src/store/modules/auth.ts`；`scripts/verify-admin-webauthn.mjs`。

- [x] 对照同依赖 main 与 PR 产物：原 PR 总产物 4745.69/4690 KB、首屏 JS 855.32/855 KB；main 4674.94/4690 KB、853.88/855 KB。原 `store` chunk 比 main 大约 1.51 KB。
- [x] 在前端 WebAuthn 回归脚本中以 TypeScript AST 断言共享 Store 没有 WebAuthn API 的运行时静态导入；运行 `npm run verify:admin-webauthn`，预期因当前静态导入 red exit 1，实际 exit 1。
- [x] 删除 `verifyAdminWebAuthnLogin` 静态导入；在 `completeWebAuthnLogin` 内执行 `const { verifyAdminWebAuthnLogin } = await import('@/api/modules/admin-webauthn')`，请求及状态更新顺序保持不变。
- [x] `npm run verify:admin-webauthn` green exit 0；`npm run build` exit 0。
- [x] `npm run verify:performance:budget` exit 1：首屏 JS 已通过，**总产物 4747.24/4690 KB**；拆包使总量较原快照增加 1.55 KB，不能单靠拆包恢复总量门禁。

### 任务 2：总量可行性门禁

**只读证据：** `dist/assets`、`tmp/pr-delivery-20261010/main-baseline-v2/dist/assets`、`.local-dev/enterprise-performance-budget-report.json` 与对应源码。

- [x] 按产物名/字节数对照 main，确认新增与膨胀模块。主要增量为 `AdminWebAuthnDialog` 17.09 KB、WebAuthn SDK `esm` 12.82 KB、`UserManageView` 11.66 KB、`LoginView` 9.14 KB、`AdminMfaDialog` 6.46 KB，另有登录样式与共享 Store 增量。没有 57.24 KB 的显性重复。
- [x] 检查默认 Oxc 产物的转义/保留文本：当前与 main 均只有 96 个 Unicode 转义、43 个十六进制转义；二者均无许可证标记或 sourceMappingURL，新增中文直接以 UTF-8 输出。SDK 整块 12.82 KB，即使整块省去也不足以补 57.24 KB 缺口。
- [x] 使用已装 CLI 在任务专属临时目录试建：`vite build --minify terser` exit 0，资产 4778.81 KB，比默认 Oxc 4747.24 KB 更大；`--minify esbuild` 因本机无 esbuild 包 exit 1，未安装依赖。阶段结论上报主线，不再猜测式尝试；动态拆包本身不减少全部产物字节数。

### 任务 2.5：已授权的 html2pdf 内部 ID 闭合压缩

**文件：** `vite.config.ts`、`scripts/html2pdf-module-id-shortener.mjs`、类型声明及两份专项测试。供应商源码保持原样。

- [x] 锁定本地 `html2pdf.js` 0.14.0 成品 SHA-256 `013f32413e8f24641bf84044e950839660ef03229433a586472a60b6063dd351`；AST 确认 307 个模块键中只有 300 个内部路径需改，1457 处字面量由 300 键、1155 个直接 require 和 2 个 bind 组成，外部 `html2canvas` 不在映射内。
- [x] 在 Vite `pre` transform 阶段、内容哈希形成前对字面量位置做双射替换；逆映射后 AST 结构哈希和完整源码均相同。孤立证明净省 70032 字节，标准构建 `pdf-export` 为 865.90 KB。
- [x] `node --test scripts/html2pdf-module-id-shortener.test.mjs` exit 0，6/6；固定哈希、动态 require/bind、bind 接收者、模块表外泄、未知路径/位置均有拒绝夹具。`node --test scripts/html2pdf-vite-plugin.test.mjs` exit 0，2/2；构建入口变化、首次缺失、同轮重复和 watch 缓存周期均有断言。
- [x] 隔离浏览器对照原版和缩名版：中文凭证、图片、CSS 分页、链接均输出 2 页、39487 字节、1 个链接注释、2 个图片对象，画布 SHA-256 同为 `625d35cf5562ef7bf2c4b1b8e18d0276299252061f70c6d6644437b79bdb2343`；无效源均报 `Unknown source type.`。分别触发 `pdf.html`/SVG 的 dompurify/canvg bind 后，输出均为 2 页、35956 字节、3 个图片对象。此为隔离夹具，不宣称真实打印机或所有 PDF 阅读器已测试。
- [x] 标准 `npm run verify:performance:budget` exit 0，总 4678.85/4690 KB、首屏 JS 854.72/855 KB；完整 `npm run verify:performance` 首轮沙箱回环限制 exit 1，提升本地回环权限后 exit 0，构建、预算、核心路径运行时、客户端并发、五场景与双预算均通过。

### 任务 3：同快照验收与交接

- [x] 新增模块首次加载失败重试、失败/中止不写登录态、最终请求不使用选项 signal 和离页解冻回归；`npm run verify:admin-webauthn` exit 0。
- [x] 初始 `npm run build` exit 0、`npm run verify:text-encoding` exit 0；修复前 `npm run verify:performance` exit 1 的旧快照证据保留，最终结果见任务 2.5。
- [x] 最终冻结源文件后复查 `npm run build`、`npm run verify:text-encoding`、`git diff --check` 与 blob/manifest；性能阶段结果及 PDF 对照见忽略目录 `tmp/pr153-performance-20261011/performance-final-result.json`，提交主线和独立 reviewer；在放行前不 commit/push。
