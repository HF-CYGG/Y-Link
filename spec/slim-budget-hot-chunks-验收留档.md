# 文件说明
- 本文件用于为 `slim-budget-hot-chunks` 记录预算专项瘦身的正式验收留档，沉淀本轮压降前后关键数值、已完成瘦身动作、剩余风险与下一阶段建议。
- 本次留档目标：把“预算已恢复通过”的结论与“后续仍值得继续瘦身的热点”分开记录，方便后续继续治理时直接复用。

# 实现逻辑
- 静态实现依据：`vite.config.ts`、`src/main.ts`、`src/App.vue`、`src/views/order-list/OrderListView.vue`、`src/views/order-list/components/OrderVoucherWorkbenchDialog.vue`、`src/views/system/UserCenterView.vue`、`src/views/system/user-center-performance.ts`、`src/utils/pdf/export-voucher-pdf.ts`。
- 验证依据：`scripts/verify-enterprise-performance-suite.mjs`、`scripts/verify-enterprise-page-performance.mjs`、`scripts/verify-enterprise-core-paths.mjs`、`.local-dev/enterprise-performance-budget-report.json`、`.local-dev/task6-core-path-2026-05-01T12-19-10-595Z.report.json`。
- 执行方式：以项目根目录 `f:\Y-Link` 为工作目录，执行真实前端构建、预算校验与核心路径回归，不依赖 mock 结果。

# 验收范围
- 构建预算：总产物、`vendor`、`ui-kit`、高频路由分包。
- 热点来源治理：低频重库、按需组件、正式出库单工作台、用户中心低频页签。
- 脚本口径稳定：预算报告输出、核心路径报告输出、静态断言与动态链路回归。

# 本轮已完成瘦身动作
## 1. 共享大包已从“单桶堆积”改为“热点专包 + 兜底 vendor”
- `vite.config.ts` 已把低频重库从共享 `vendor` 中拆成独立专包：
  - `charting`
  - `pdf-export`
  - `qr-scanner`
  - `qr-code`
  - `image-tools`
- 该调整避免 `html2pdf.js`、`html5-qrcode`、`qrcode`、`browser-image-compression`、`echarts/vue-echarts` 继续堆进共享 `vendor`。

## 2. Element Plus 已从运行时整包注册改为编译期按需引入
- `main.ts` 去掉 `app.use(ElementPlus)` 与整包样式引入。
- `vite.config.ts` 已接入 `unplugin-vue-components` 与 `ElementPlusResolver({ importStyle: 'css' })`。
- `App.vue` 补上 `el-config-provider`，继续保持全站中文 locale，不影响现有控件口径。

## 3. 高频页面中的低频重能力已进一步异步化
- `OrderListView.vue` 已把正式出库单工作台改为异步组件，只在真正打开时加载。
- `OrderVoucherWorkbenchDialog.vue` 统一承接补填、预览、打印、PDF 导出与打印 Teleport，避免列表主入口继续同步背负重逻辑。
- `UserCenterView.vue` 已把“管理端用户 / 客户端用户”两个低频治理页签拆为异步标签组件，降低用户中心壳层同步负担。

## 4. 核心路径验证口径已恢复稳定
- `verify-enterprise-core-paths.mjs` 已与正式出库单工作台异步拆分后的结构重新对齐。
- 最新核心路径报告已恢复完整 `7` 步验证，不再出现空 `verificationSteps` 报告。

# 预算前后对比
## 1. 历史失败基线
- 构建总产物：`3890.69 KB`
- `vendor`：`1846.38 KB`
- `ui-kit`：`906.18 KB`
- `OrderListView`：`30.85 KB`
- 当时结论：
  - 总产物超预算 `90.69 KB`
  - `OrderListView` 超预算 `0.85 KB`
  - 核心路径报告因断言漂移未完成完整回归

## 2. 本轮通过结果
- 构建总产物：`3538.82 KB`
- `vendor`：`204 KB`
- `ui-kit`：`617.82 KB`
- `OrderListView`：`24.81 KB`
- 结果说明：
  - 总产物已回到 `3800 KB` 预算线内
  - `vendor` 已从大共享桶显著收缩
  - `ui-kit` 明显下降，且页面交互未回归
  - `OrderListView` 已压回 `30 KB` 预算线内

## 3. 压降明细
| 指标 | 历史值 | 当前值 | 变化 |
|---|---:|---:|---:|
| 构建总产物 | `3890.69 KB` | `3538.82 KB` | `-351.87 KB` |
| `vendor` | `1846.38 KB` | `204 KB` | `-1642.38 KB` |
| `ui-kit` | `906.18 KB` | `617.82 KB` | `-288.36 KB` |
| `OrderListView` | `30.85 KB` | `24.81 KB` | `-6.04 KB` |

# 验证结果
## 1. 企业性能统一验证
- 执行命令：`npm run verify:performance`
- 执行时间：`2026-05-01`
- 结果状态：`PASS`
- 关键结论：
  - 构建预算校验通过
  - 核心路径回归通过
  - 客户端并发基线验证通过

## 2. 构建预算报告
- 报告路径：`.local-dev/enterprise-performance-budget-report.json`
- 关键指标：
  - `totalAssetsKB = 3538.82`
  - `vendor = 204`
  - `ui-kit = 617.82`
  - `OrderListView = 24.81`

## 3. 核心路径自动化回归
- 报告路径：`.local-dev/task6-core-path-2026-05-01T12-19-10-595Z.report.json`
- 关键结论：
  - 已恢复完整 `7` 步验证
  - 覆盖首页工作台、基础资料、出库列表、系统配置、用户管理、审计导出等主链路

# 本轮验收结论
- `slim-budget-hot-chunks` 已达到“预算专项瘦身”目标：
  - 预算验证恢复通过
  - 热点大包来源已完成第一轮明显压降
  - 核心路径脚本口径已恢复稳定
- 本轮可以判定为专项闭环完成。

# 剩余风险
- `ui-kit` 虽已明显下降，但仍是当前单体最大共享前端包之一，后续若再增加大量 Element Plus 重组件，存在回涨风险。
- `pdf-export` 与 `charting` 已拆出共享 `vendor`，但它们本身仍是较大的低频专包；如果未来使用频率上升，需要再评估是否继续分组或更细粒度延迟加载。
- 预算已恢复通过，但仍应保留“阶段结束前强制执行 `npm run verify:performance`”的规范，避免后续迭代把包体重新推回红线外。

# 下一阶段建议
## 1. 持续观察 `ui-kit`
- 优先关注系统管理页、复杂表单页、弹窗页是否又引入大量低频 Element Plus 组件。
- 若继续增长，可进一步按场景审查全局图标、指令与低频控件是否还能再减。

## 2. 继续细化低频专包
- `pdf-export`、`charting`、`qr-scanner` 目前已从共享包中剥离。
- 若后续仍需进一步压缩总产物，可继续评估这些专包内部是否还能拆成“首触发再加载”的更细粒度能力块。

## 3. 保持脚本口径与页面结构同步
- 任何涉及正式出库单、打印模板、工作台异步拆分的改动，都应同步复核 `verify-enterprise-core-paths.mjs`。
- 避免再次出现“页面已改、脚本未跟、报告空跑”的口径漂移问题。
