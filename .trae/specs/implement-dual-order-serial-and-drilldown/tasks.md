# Tasks

- [x] Task 1: 完成订单模型与数据库迁移改造
  - [x] SubTask 1.1: 在 `orders` 增加 `orderType/hasCustomerOrder/isSystemApplied/issuerName/customerDepartmentName` 字段并补充索引（含 `orderType + createdAt`）
  - [x] SubTask 1.2: 在 `system_configs` 增加双流水配置项（起始号、当前号、位宽）并初始化默认值
  - [x] SubTask 1.3: 评估并落实 `order_no` 唯一约束与软删兼容策略

- [x] Task 2: 实现后端双流水单号服务与下单链路改造
  - [x] SubTask 2.1: 新增 `OrderSerialService.generateOrderNo(orderType)`，使用事务 + 行级锁保障并发一致性
  - [x] SubTask 2.2: 改造订单创建接口，按 `orderType` 生成单号，拒绝前端覆盖最终单号
  - [x] SubTask 2.3: 增加默认开单人逻辑（优先前端传入，缺省取当前用户 `displayName`）
  - [x] SubTask 2.4: 补充接口参数校验与错误码（非法类型、配置缺失、序号异常）

- [x] Task 3: 实现统计与明细下钻 API
  - [x] SubTask 3.1: 新增产品榜/客户榜明细下钻接口（支持时间范围与订单类型筛选）
  - [x] SubTask 3.2: 新增标签聚合接口（`tagId + dateRange + orderType? -> totalQuantity/totalAmount`）
  - [x] SubTask 3.3: 新增 Dashboard 饼图数据接口（商品占比、客户占比、散客 vs 部门占比）

- [x] Task 4: 完成前端开单页与 API 契约升级
  - [x] SubTask 4.1: 开单页新增订单类型选择、客户单/系统申请字段、开单人可编辑输入
  - [x] SubTask 4.2: 提交参数与详情展示适配新增字段；单号改为后端回显
  - [x] SubTask 4.3: 列表/详情/导出视图补齐新增字段展示

- [x] Task 5: 完成前端 Dashboard 下钻与标签统计升级
  - [x] SubTask 5.1: 增加 3 个饼图卡片并接入新统计接口
  - [x] SubTask 5.2: Top5 榜单支持点击，在 `ElDrawer` 中展示明细清单
  - [x] SubTask 5.3: 标签页面增加时间范围与订单类型筛选，并显示数量/金额统计卡

- [x] Task 6: 完成凭证生成与打印能力
  - [x] SubTask 6.1: 在订单详情页增加“生成凭证”入口与模板弹窗
  - [x] SubTask 6.2: 实现 `window.print()` 打印流程与打印样式优化
  - [x] SubTask 6.3: 预留可选 PDF 导出接入点（`html2pdf.js` 可开关）

- [x] Task 7: 完成权限治理与配置管理页
  - [x] SubTask 7.1: 系统配置页增加双流水起始号/当前号展示与维护能力
  - [x] SubTask 7.2: 限制仅管理员可修改序号配置，普通角色只读
  - [x] SubTask 7.3: 增加配置变更审计日志（操作者、时间、变更前后）

- [x] Task 8: 完成兼容迁移、回归测试与性能验证
  - [x] SubTask 8.1: 执行迁移脚本（增字段与配置初始化），可选执行历史订单类型映射脚本
  - [x] SubTask 8.2: 覆盖并发单号、双类型串号、看板下钻、标签聚合、凭证打印的端到端回归
  - [x] SubTask 8.3: 运行项目规范验证（含 `npm run verify:performance`）并修复回归

# Task Dependencies

- Task 2 依赖 Task 1。
- Task 3 依赖 Task 1 与 Task 2。
- Task 4 依赖 Task 2。
- Task 5 依赖 Task 3。
- Task 6 依赖 Task 2 与 Task 4。
- Task 7 可在 Task 2 后并行推进。
- Task 8 依赖前置全部任务完成。
