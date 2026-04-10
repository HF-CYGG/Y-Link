# 完善 client/login UI 与注册后跳转登录方案

## Summary
- 目标：优化客户端登录页 `/client/login` 的品牌视觉表现，并将“注册成功后自动登录”改为“注册成功后跳转到登录态入口”。
- 成功标准：
  - 客户端登录页在移动端与桌面端都具备更明确的品牌感、层次感和可读性。
  - 注册成功后不再直接进入 `/client/mall`，而是跳转到 `/client/login`。
  - 若用户选择“自动回登录页并带手机号”，则优先回填手机号；当前已确认方案为“跳转登录”，因此默认只跳转，不自动登录。
  - 不影响现有客户端登录、验证码、忘记密码与客户端路由守卫链路。

## Current State Analysis
- 当前客户端登录/注册页面集中在 [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)：
  - 登录与注册共用一个页面，通过 `activeTab` 在单卡片内切换。
  - UI 已有基础卡片与输入框样式，但仍偏“表单原型态”，品牌视觉表达较弱。
  - 注册成功逻辑位于 `handleRegister`，目前会调用 `clientAuthStore.register()` 后直接 `router.replace('/client/mall')`。
- 当前客户端登录态管理集中在 [client-auth.ts](file:///f:/Y-Link/src/store/modules/client-auth.ts)：
  - `register()` 内部会把后端返回的登录结果直接写入本地状态，属于“注册即登录”模式。
  - 这与本次确认的“注册成功后跳转登录”目标冲突。
- 当前客户端本地持久化逻辑位于 [client-auth-storage.ts](file:///f:/Y-Link/src/utils/client-auth-storage.ts)：
  - 已与管理端登录态隔离，具备支持“先注册、后登录”的基础。
- 当前客户端路由已存在：
  - 登录页：`/client/login`
  - 找回密码页：`/client/forgot-password`
  - 商品大厅：`/client/mall`
  - 订单页：`/client/orders`
  - 对应定义在 [routes.ts](file:///f:/Y-Link/src/router/routes.ts) 与 [route-performance.ts](file:///f:/Y-Link/src/router/route-performance.ts)。

## Proposed Changes

### 1. 调整客户端注册成功后的跳转链路
- 文件：
  - [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)
  - [client-auth.ts](file:///f:/Y-Link/src/store/modules/client-auth.ts)
  - [client-auth-storage.ts](file:///f:/Y-Link/src/utils/client-auth-storage.ts)
- 变更内容：
  - 将页面层的注册成功行为从“成功后进入 `/client/mall`”改为“成功后跳转 `/client/login`”。
  - 页面层在跳转前给出明确成功提示，例如“注册成功，请登录后进入商品大厅”。
  - store 层把 `register()` 从“写入登录态”改为“仅完成注册请求，不自动持久化客户端会话”。
- 原因：
  - 当前需求已明确为“注册之后自动跳转登录操作”，不是注册即登录。
  - 将会话写入逻辑留给真正的登录动作，能让客户端登录链路更清晰，减少“注册态就是登录态”的隐式行为。
- 实现方式：
  - 保持后端接口不变，优先在前端 store 层收口行为变化，降低改动范围。
  - 若后端注册接口仍返回 token/user，则前端忽略自动落盘，只消费“注册成功”语义。

### 2. 完善 `/client/login` 品牌视觉 UI
- 文件：
  - [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)
  - 如有必要，补充共用样式到客户端局部样式块，不新增全局污染。
- 变更内容：
  - 强化头部品牌区：名称、副标题、轻视觉背景层、卡片层次、移动端间距。
  - 优化登录卡片布局：登录 tab 更突出，登录主按钮更具品牌识别，验证码区更清晰。
  - 把“登录”和“注册”视觉层级区分得更明确，使 `/client/login` 更像最终交付页面，而不是原型表单。
- 原因：
  - 当前用户已明确本轮 UI 优先目标是“品牌视觉”。
  - 客户端页面面向终端用户，需要比管理端更强调亲和、识别和信任感。
- 实现方式：
  - 在现有单文件组件中完成样式升级，避免引入新 UI 库或额外工程结构。
  - 保持现有表单结构与验证码逻辑，优先做视觉增强，不扩散到后端。

### 3. 登录页与注册页切换体验细化
- 文件：
  - [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)
- 变更内容：
  - 注册成功后回到登录态时，切回登录 tab。
  - 可选增强：将刚注册的手机号回填到登录手机号输入框，减少重复输入。
- 原因：
  - 即使需求核心是“跳转登录”，若能保留手机号，将显著降低第二步登录的操作成本。
- 实现方式：
  - 优先通过页面内状态回填，若跳转采用完整路由切换，则通过 query 或临时状态带回手机号。
  - 不引入额外持久化字段，避免污染长期登录态存储。

### 4. 保持客户端守卫与登录链路兼容
- 文件：
  - [index.ts](file:///f:/Y-Link/src/router/index.ts)
  - [http.ts](file:///f:/Y-Link/src/api/http.ts)
- 变更内容：
  - 验证 `/client/login`、`/client/forgot-password`、`/client/mall` 的路由守卫在“注册后未登录”模式下仍正常工作。
  - 验证客户端 token 注入逻辑不依赖“注册即登录”前提。
- 原因：
  - 注册链路变更后，客户端页面会更频繁处于“已注册但未登录”状态，需要确认守卫不会误跳。
- 实现方式：
  - 只做兼容验证，除非发现问题，否则不扩大改动。

## Assumptions & Decisions
- 已确认决策：
  - 注册成功后采用“跳转登录”。
  - 本轮 UI 优先级为“品牌视觉”。
- 设计决策：
  - 优先在现有 `ClientAuthView.vue` 内完成视觉升级，不拆分额外组件，减少复杂度。
  - 优先把“注册即登录”行为在前端 store 层关闭，而不是先改后端接口，降低耦合。
  - 若回填手机号实现成本低，则一并纳入；若实现中发现会增加不必要复杂度，则至少保证“跳回登录 + 切换到登录 tab + 成功提示”。
- 约束：
  - 当前处于现有 Vue 3 + Element Plus + Tailwind 风格体系内，不引入新的第三方 UI 框架。
  - 不回滚用户已改动的客户端/O2O 相关文件。

## Verification Steps
1. 运行前端类型与构建验证：
   - `npm run build`
2. 运行本地联调启动脚本：
   - `.\start-local-dev.ps1 -NoAttachLogs`
3. 手动验证客户端路径：
   - 访问 `http://127.0.0.1:5173/client/login`
   - 检查登录页视觉是否明显提升
   - 使用新用户完成注册后，确认页面跳回登录态入口，而不是直接进入 `/client/mall`
   - 登录成功后，确认可进入 `/client/mall`
4. 回归忘记密码与客户端守卫：
   - 未登录访问 `/client/mall` 时应被正确引导到 `/client/login`
   - `/client/forgot-password` 仍可独立使用
5. 如有必要，再补充 onebox 烟雾验证：
   - `npm run verify:onebox:smoke`
