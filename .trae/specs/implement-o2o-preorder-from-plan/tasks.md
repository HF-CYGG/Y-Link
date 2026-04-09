# Tasks
- [x] Task 1: 扩展数据模型与配置基础
  - [x] SubTask 1.1: 为商品与库存模型补充上下架、预览图、详情、限购与双库存字段及迁移脚本
  - [x] SubTask 1.2: 新增 O2O 业务配置持久化（超时取消开关/时长、限购开关/默认限额）并写入默认值
  - [x] SubTask 1.3: 增加数据库驱动切换与迁移校验脚本，确保 SQLite/MySQL 兼容

- [x] Task 2: 实现客户端认证与密码找回
  - [x] SubTask 2.1: 完成客户端用户注册、登录、会话鉴权接口与前端页面
  - [x] SubTask 2.2: 实现短信验证码通道与图形验证码自动降级策略
  - [x] SubTask 2.3: 实现“忘记密码”两步流程（身份校验 + 重置密码）

- [x] Task 3: 实现客户端商品大厅与预订单闭环
  - [x] SubTask 3.1: 完成商品大厅页面（分类、列表、库存与已预订展示）
  - [x] SubTask 3.2: 完成购物车、下单、订单详情与核销二维码展示
  - [x] SubTask 3.3: 实现下单防超卖事务逻辑与失败重试/提示

- [x] Task 4: 实现管理端 O2O 功能
  - [x] SubTask 4.1: 完成商品大厅维护页（上/下架、预览图、详情编辑）
  - [x] SubTask 4.2: 完成预订单核销台（扫码识别、详情校验、确认出库）
  - [x] SubTask 4.3: 完成入库管理页与库存流水落库
  - [x] SubTask 4.4: 在系统配置页接入线上预订规则开关与参数设置

- [x] Task 5: 实现备份恢复与迁移工具
  - [x] SubTask 5.1: 提供 SQLite 物理备份下载接口
  - [x] SubTask 5.2: 提供 JSON 导出/导入接口并处理依赖顺序恢复
  - [x] SubTask 5.3: 验证 SQLite 导出到 MySQL 导入的可行性与一致性

- [x] Task 6: 构建自动化测试与验收
  - [x] SubTask 6.1: 增加后端自动化测试（认证、密码找回、下单、核销、库存、配置）
  - [x] SubTask 6.2: 增加前端关键交互测试（客户端与管理端核心流程）
  - [x] SubTask 6.3: 执行项目测试命令并修复失败项，确保全部通过
  - [x] SubTask 6.4: 执行 `npm run verify:performance`，确认性能回归通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1 and Task 2
- Task 4 depends on Task 1 and Task 3
- Task 5 depends on Task 1 and Task 4
- Task 6 depends on Task 2, Task 3, Task 4, and Task 5
