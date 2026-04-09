# Tasks
- [x] Task 1: 建立整体功能可用性检查清单并落地执行范围
  - [x] SubTask 1.1: 梳理关键链路（登录、开单、列表、详情、凭证、系统配置、工作台图表）
  - [x] SubTask 1.2: 为每条链路定义最小可验收步骤与结果标准
  - [x] SubTask 1.3: 形成可复用的检查项文档结构（通过/失败/备注）

- [x] Task 2: 实现核心交互的统一动效增强
  - [x] SubTask 2.1: 统一按钮、开关、标签切换、抽屉/弹窗开合动效节奏
  - [x] SubTask 2.2: 增强列表筛选与分页状态切换反馈
  - [x] SubTask 2.3: 增强图表悬停与加载态过渡，保持信息可读性

- [x] Task 3: 增加动效可访问性与性能兜底
  - [x] SubTask 3.1: 接入减少动画偏好（prefers-reduced-motion）降级策略
  - [x] SubTask 3.2: 对高频动画场景设置时长上限与可中断策略
  - [x] SubTask 3.3: 确认低性能设备下无明显卡顿与交互阻塞

- [x] Task 4: 完成回归验证并收口
  - [x] SubTask 4.1: 按可用性清单执行全量检查并记录结果
  - [x] SubTask 4.2: 修复发现的问题并复测通过
  - [x] SubTask 4.3: 输出最终验收结论

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 1, Task 2, and Task 3
