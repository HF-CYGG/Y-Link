* [x] `tailwind.config.js` 已开启 `darkMode: 'class'`。

* [x] `main.ts` 已成功引入 `element-plus/theme-chalk/dark/css-vars.css`。

* [x] `style.css` 已重写，包含 `.apple-card` 等原子类与 `fade-slide` 动画，亮暗色变量配置无误。

* [x] `router/routes.ts` 已重构，基础资料拆分为 `products` 与 `tags` 子路由。

* [x] 成功拆分出独立的 `ProductManageView.vue` 与 `TagManageView.vue` 页面。

* [x] `AppLayout.vue` 已全新重构，左侧侧边栏、右侧带 `useDark` 切换开关的 Header 及主体区过渡动画正常工作。

* [x] 切换 Header 上的亮暗模式开关，全站配色能流畅反转且 Element Plus 组件样式同步跟随。

* [x] `DashboardView.vue` 改造为 Widget 风格，拥有高级排版和卡片悬浮（`apple-card-hover`）特效。

* [x] 所有业务页面的外层冗余类名（如 `bg-white rounded-xl shadow-sm...`）已被统一替换为 `.apple-card`。

