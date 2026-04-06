# syntax=docker/dockerfile:1

# ------------------------------
# 构建阶段：安装依赖并产出 Vite 静态资源
# 说明：
# - 前端默认使用 /api 作为请求前缀；
# - 运行阶段通过 Nginx 反向代理到 backend 服务。
# ------------------------------
FROM node:20-bookworm-slim AS build

WORKDIR /app

# 先安装依赖，充分利用层缓存。
COPY package*.json ./
RUN npm ci

# 复制前端源码与构建配置后执行生产打包。
COPY index.html ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json ./
COPY tsconfig.app.json ./
COPY tsconfig.node.json ./
COPY vite.config.ts ./
COPY tailwind.config.js ./
COPY postcss.config.js ./
RUN npm run build

# ------------------------------
# 运行阶段：使用 Nginx 托管静态资源并代理后端 API
# ------------------------------
FROM nginx:1.27-alpine AS runtime

# 使用可模板化站点配置：
# - 处理 Vue Router history 路由回退；
# - 默认代理到同编排 backend:3001，并通过延迟解析降低启动阶段 DNS 瞬态失败风险。
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
