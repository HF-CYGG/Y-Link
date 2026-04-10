# 二轮打磨 client/login 移动端体验方案

## Summary
- 目标：在现有客户端登录/注册页基础上，继续做一轮更细的移动端打磨，重点覆盖登录/注册切换动画、验证码区域可点击性、注册成功后的“立即去登录”强化入口，以及客户端首页与登录页的视觉统一。
- 成功标准：
  - `/client/login` 在移动端具备更顺滑的 tab 切换反馈，不再只是静态切换。
  - 图形验证码区域在移动端更大、更易点，并有清晰的刷新/加载反馈。
  - 注册成功后的提示不只是一段文案，而是具备明确主动作按钮，引导用户去登录。
  - 客户端首页 [ClientMallView.vue](file:///f:/Y-Link/src/views/client/ClientMallView.vue) 的色彩、卡片、顶部视觉语言与登录页保持一致。
  - 不改变已完成的“注册成功后跳转登录”主流程，不影响验证码、忘记密码、客户端守卫与现有 O2O 下单链路。

## Current State Analysis
- 当前登录页位于 [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)：
  - 已具备品牌左侧说明区 + 右侧登录/注册卡片的双栏结构。
  - 注册成功后已改为回到 `/client/login`，并通过 `route.query.notice/mobile` 展示成功提示和手机号回填。
  - 现阶段登录/注册切换仍是 `v-if + activeTab` 的直接切换，没有更细的进入/离开动画。
  - 验证码区域目前是固定宽度的右侧按钮块，视觉上可用，但在移动端命中面积和刷新提示仍可加强。
  - 成功提示当前仅通过 `successTip` 横幅显示，没有单独强化的 CTA 按钮。
- 当前客户端首页位于 [ClientMallView.vue](file:///f:/Y-Link/src/views/client/ClientMallView.vue)：
  - 页面主要采用白色卡片 + 灰背景，结构清晰，但顶部视觉与登录页的品牌区风格差异较大。
  - 与登录页相比，首页缺少统一的品牌渐变背景、引导性头图层次和一致的按钮视觉语义。
- 当前客户端壳层位于 [ClientShell.vue](file:///f:/Y-Link/src/views/client/components/ClientShell.vue)：
  - 已提供顶部导航与当前用户信息，但整体视觉更偏功能型，不足以承担“与登录页统一”的品牌表达。

## Proposed Changes

### 1. 为登录/注册切换补充移动端友好的过渡动画
- 文件：
  - [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)
- 变更内容：
  - 在登录/注册表单区域增加轻量过渡动画（如淡入 + 轻微位移 + 高度平滑切换）。
  - 切换动画需兼容移动端，不使用过重或眩晕式动画。
  - 保持 `activeTab` 作为单一状态源，不改变表单业务逻辑。
- 原因：
  - 当前仅为瞬时切换，视觉跳变感较强。
  - 用户已明确希望补“登录/注册切换动画”，这属于纯前端体验增强。
- 实现方式：
  - 使用 Vue 内置 `<Transition>` / `<TransitionGroup>` 配合 scoped CSS 实现。
  - 避免引入外部动画库，保证实现简单且可维护。

### 2. 放大并强化验证码交互区
- 文件：
  - [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)
- 变更内容：
  - 扩大验证码点击区域与视觉盒子高度，使其更适合触屏点击。
  - 增加“点击刷新”或“换一张”的文案提示，弱化用户对验证码是“静态图片”的误解。
  - 保留当前 `captchaLoading` 逻辑，并在加载状态下显示更明确的骨架/按钮禁用反馈。
- 原因：
  - 当前验证码盒子可用，但在手机上点按仍偏紧凑。
  - 验证码本质是交互控件，应有更明确的操作暗示。
- 实现方式：
  - 仅改登录/注册页本地样式与文案，不动后端接口。
  - 保持验证码仍由 [client-auth.ts](file:///f:/Y-Link/src/api/modules/client-auth.ts) 中现有接口获取。

### 3. 强化注册成功后的“立即去登录”动作
- 文件：
  - [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)
- 变更内容：
  - 在 `successTip` 横幅基础上增加明显的主按钮，例如“立即去登录”。
  - 按钮点击后：
    - 强制切回登录 tab；
    - 保留已回填手机号；
    - 将焦点语义导向登录区（如果无需显式焦点管理，则至少视觉聚焦登录卡片）。
  - 与当前“注册成功后自动路由回 `/client/login`”形成一致闭环。
- 原因：
  - 现在成功提示主要靠文本，不够强引导。
  - 用户明确提出要强化“立即去登录”按钮。
- 实现方式：
  - 保持当前 query 驱动状态恢复逻辑，只在页面层补按钮与交互收口。
  - 不新增新的全局状态字段。

### 4. 统一客户端首页与登录页的视觉语言
- 文件：
  - [ClientShell.vue](file:///f:/Y-Link/src/views/client/components/ClientShell.vue)
  - [ClientMallView.vue](file:///f:/Y-Link/src/views/client/ClientMallView.vue)
- 变更内容：
  - 把登录页中的品牌渐变、圆角卡片、轻浮层感下沉到客户端壳层或首页头部。
  - 首页上方增加与登录页一致的视觉节奏：品牌头区 / 渐变背景 / 指引性文案 / 更统一的按钮样式。
  - 保持商品列表、购物车侧栏等业务布局不变，重点做“风格统一”而不是重构结构。
- 原因：
  - 当前登录页已经有较强品牌感，而客户端首页仍更像普通后台式商品列表。
  - 用户明确提出“客户端首页风格与登录页视觉统一”。
- 实现方式：
  - 优先修改 [ClientShell.vue](file:///f:/Y-Link/src/views/client/components/ClientShell.vue) 的头部与页面容器背景，让多个客户端页面自动继承统一外观。
  - 如仍不够统一，再在 [ClientMallView.vue](file:///f:/Y-Link/src/views/client/ClientMallView.vue) 补一个首页专属品牌头卡。

### 5. 保持现有注册后跳转链路稳定
- 文件：
  - [client-auth.ts](file:///f:/Y-Link/src/store/modules/client-auth.ts)
  - [ClientAuthView.vue](file:///f:/Y-Link/src/views/client/ClientAuthView.vue)
- 变更内容：
  - 确认当前“注册不自动登录”的行为继续保留。
  - 二轮打磨只增强 UI 和引导，不恢复“注册即登录”。
- 原因：
  - 当前该链路已符合用户上一轮确认结果，不能在二轮 UI 打磨中被破坏。
- 实现方式：
  - 验收时重点回归注册成功后是否仍停留在登录入口，而不是进入 `/client/mall`。

## Assumptions & Decisions
- 已明确的需求偏好：
  - 继续做更细的移动端打磨。
  - 优先覆盖四项：切换动画、验证码点击体验、注册成功后的“立即去登录”、客户端首页与登录页视觉统一。
- 设计决策：
  - 动画采用轻量 CSS / Vue Transition，不引入动画库。
  - 验证码交互强化仅改前端组件，不改变接口协议。
  - 首页风格统一优先通过 [ClientShell.vue](file:///f:/Y-Link/src/views/client/components/ClientShell.vue) 下沉公共视觉，而不是复制登录页结构。
  - 保持现有客户端路由与注册链路，不扩大到后端或管理端改造。
- 范围边界：
  - 本轮不新增新业务接口。
  - 本轮不改动忘记密码主流程，只要求视觉与入口保持兼容。
  - 本轮不重做客户端首页业务结构，只做视觉统一与交互细化。

## Verification Steps
1. 前端构建验证：
   - `npm run build`
2. 本地联调验证：
   - `.\start-local-dev.ps1 -NoAttachLogs`
3. 手动验证登录页：
   - 打开 `http://127.0.0.1:5173/client/login`
   - 在手机宽度下检查登录/注册切换动画是否自然
   - 检查验证码区域是否明显更大、更易点击
   - 检查成功提示中是否有更明确的“立即去登录”动作
4. 手动验证注册链路：
   - 完成一次注册
   - 确认不会直接进入 `/client/mall`
   - 确认会回到登录态入口，并保留手机号/引导登录
5. 手动验证首页统一风格：
   - 登录后进入 `http://127.0.0.1:5173/client/mall`
   - 检查客户端首页头部视觉、背景、卡片风格是否与登录页同体系
6. 回归兼容：
   - `http://127.0.0.1:5173/client/forgot-password` 仍可正常访问
   - 未登录访问 `/client/mall` 仍会被引导到 `/client/login`
