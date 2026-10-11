# PR #153 真实覆盖率采集实施计划

**目标：** 用现有工具运行有业务断言的后端和前端验证，把真实执行的 TypeScript/Vue 行与分支映射到 SonarCloud；以新代码覆盖率 80% 为验收目标，不伪造命中、不排除业务源码。

**边界：** 不改生产认证逻辑、阈值、依赖或锁文件；测试只使用临时 SQLite 和受控桩，不访问真实数据库或密钥。与性能修复共享工作区，保留已冻结改动，最终由主线协调提交。

## 1. 后端认证执行覆盖

- [x] 在 `scripts/run-coverage-report.mjs` 中补入已有 WebAuthn 直接、启用、兼容、负向、旧库升级及 MFA 验证；参数变体用测试包装入口隔离进程和 SQLite。
- [x] 单跑这些入口并核对原始 Node V8 LCOV 中的后端业务源码命中；最终合并报告另行验收。

## 2. 前端原始源码映射与行为断言

- [x] 使用现有 `@vue/compiler-sfc`、Rolldown 和 Node 测试运行器编译完整 SFC 并保留 source map；测试真实 setup、弹窗 SSR 路径及交互处理，断言可见结果和调用副作用。
- [x] 复用 `verify-admin-webauthn` 现有断言，并让其 Rolldown 产物带源映射；增加认证、条码及旧库升级的真实行为入口。
- [x] 查明 Node 22 内置 LCOV 对 Vue 映射存在未执行函数误报、已执行函数漏报。SFC 及同产物中的条码 helper.ts 不复用其 DA/BRDA；`scripts/v8-sfc-coverage.mjs` 从原始 V8 function/block ranges 与实际 source-map segment 保守归属，未覆盖 range 仍记零。无源码生成壳明确分类，真实模板 false 分支归零；其他无法归属的条件直接失败。
- [x] 四认证组件只导入、只 setup、四个单处理器与条码只导入共七个负例独立运行；正向套件完成后记录编译 `.mjs/.map` 的 SHA-256，探针后与最终合并前复核。原始 V8 内嵌源码图、行长度、`sourcesContent` 与磁盘同一快照一致，路径/行列越界立即失败。

## 3. 合并、CI 与验收

- [x] 合并重复 `SF` 的真实 V8 LCOV 计数，拒绝越界路径、非法行号或空报告；只生成一个 `coverage/lcov.info`。
- [x] 在无密钥的 coverage job 安装已有根依赖；Sonar token job 继续只下载报告和扫描。
- [x] 将仅供验证的 `backend/scripts/admin-webauthn-fixture.ts` 在 `sonar.test.inclusions` 与 `sonar.exclusions` 成对分类；不追加业务覆盖排除。
- [x] 运行最小单测、相关认证与后端套件、文本编码检查及完整覆盖率报告；对公开 Sonar 旧新代码行集逐行估算。最终 80% 是否通过仍以新的 SonarCloud 分析为准，必要构建和独立审查由主线统一验收。

## 4. PR 最新分析后的同范围补测

- [x] `0188b6a` 的 SonarCloud 新代码覆盖率为 78.8%（3,545 行中 651 行未覆盖，1,237 个条件中 363 个未覆盖）。在现有条码 SFC 测试内增加有可观察断言的实际打印会话、关闭与卸载清理、迟到回调、模板来源跟随、真实 JsBarcode SVG 生成失败、条码密度及标签净高场景；不改业务实现或覆盖排除。
- [x] 本地 11 项条码行为测试与完整覆盖率作业通过。对该次 Sonar 分析中条码组件的 91 条新可覆盖行逐行核对，先前 72 条未命中行中有 70 条在新的合并 LCOV 出现真实命中；余下 240–241 行是动态导入失败分支。本地 V8 条件记录与 Sonar 条件口径不完全一致，最终门禁仍需重新分析确认。
