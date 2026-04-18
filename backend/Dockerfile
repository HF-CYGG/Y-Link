# syntax=docker/dockerfile:1

# ------------------------------
# 文件说明：Y-Link 后端镜像构建文件。
# 实现逻辑：
# - 构建阶段安装完整依赖并编译 TypeScript；
# - 运行阶段仅保留生产依赖、编译产物与 SQL 模板，兼顾体积与 sqlite3 兼容性。
# ------------------------------
FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先复制依赖清单，最大化复用 Docker 构建缓存。
COPY package*.json ./
RUN npm ci

# 再复制源码与 SQL 脚本并执行生产构建。
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
RUN npm run build \
  && npm prune --omit=dev

# ------------------------------
# 运行阶段：仅保留生产依赖与编译产物
# 说明：
# - 继续使用相同发行版，避免 sqlite3 二进制兼容问题；
# - 默认将 SQLite 数据落到 /app/data，便于通过 volume 持久化。
# ------------------------------
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  PORT=3001 \
  SQLITE_DB_PATH=/app/data/y-link.sqlite

# 创建运行目录并提前授权给 node 用户，降低容器默认 root 运行风险。
RUN mkdir -p /app/data \
  && chown -R node:node /app

# 复制运行所需文件：package 信息、生产依赖、编译产物、SQL 模板。
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/sql ./sql

USER node

EXPOSE 3001

# 启动编译后的后端服务。
CMD ["npm", "run", "start"]
