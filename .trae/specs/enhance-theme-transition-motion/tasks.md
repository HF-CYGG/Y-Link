# Tasks
- [x] Task 1: 梳理现有主题切换链路与可复用样式基础
  - [x] SubTask 1.1: 分析 ThemeToggle 当前实现、主题状态来源与全局样式过渡范围
  - [x] SubTask 1.2: 明确全站视图过渡落点、兼容性降级策略与受影响页面范围
  - [x] SubTask 1.3: 确认按钮动效与全局视图过渡的协同方式，避免重复动画或闪烁

- [x] Task 2: 实现全局亮暗视图过渡能力
  - [x] SubTask 2.1: 在主题切换入口引入基于点击位置的视图级过渡逻辑
  - [x] SubTask 2.2: 为不支持 View Transitions API 的环境提供平滑降级方案
  - [x] SubTask 2.3: 调整全局样式，关闭默认交叉淡化并保证全站页面共享同一过渡规则

- [x] Task 3: 升级 ThemeToggle 丝滑交互动效
  - [x] SubTask 3.1: 优化按钮滑块位移、图标切换、背景与按压反馈节奏
  - [x] SubTask 3.2: 保证登录页、主系统页等所有出现 ThemeToggle 的位置都拥有一致体验
  - [x] SubTask 3.3: 确保主题切换过程中不会引入布局抖动、控件错位或可访问性退化

- [x] Task 4: 完成全站回归与视觉验收
  - [x] SubTask 4.1: 验证登录页与主系统页面在亮转暗、暗转亮时都具备丝滑过渡
  - [x] SubTask 4.2: 验证所有页面共享主题切换效果，且无明显闪烁、白屏或控制台错误
  - [x] SubTask 4.3: 验证浏览器不支持高级视图过渡时的降级行为仍然稳定可用

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1 and can partially run in parallel with Task 2
- Task 4 depends on Task 2 and Task 3
