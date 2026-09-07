# ------------------------------
# 文件说明：Y-Link 后端镜像构建文件。
# 实现逻辑：
# - 编译阶段固定跑在构建机原生架构（$BUILDPLATFORM）上，只做 TypeScript 编译，
#   并用 `--ignore-scripts` 跳过原生模块编译，避免跨架构构建时被 QEMU 拖慢；
# - 生产依赖阶段必须运行在目标架构上，sqlite3 / sharp 的原生产物与 CPU 架构强绑定；
# - 运行阶段仅保留生产依赖、编译产物与 SQL 模板，兼顾体积与 sqlite3 兼容性。
# ------------------------------
# SQLite 镜像固定 Node 22 LTS，避免未验收的新 ABI 让 optional sqlite3 在安装期被静默跳过。
ARG Y_LINK_NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim

# ------------------------------
# 编译阶段：只产出 dist，不产出 node_modules。
# 这里固定用 $BUILDPLATFORM，因为 tsc 是纯 JavaScript，编译结果与目标架构无关；
# 配合 `--ignore-scripts` 可跳过 sqlite3 / sharp 的原生编译，它们在此阶段只被当作类型使用。
# ------------------------------
FROM --platform=$BUILDPLATFORM ${Y_LINK_NODE_IMAGE} AS build

WORKDIR /app

# 先复制依赖清单，最大化复用 Docker 构建缓存。
COPY package*.json ./
COPY .npmrc ./
RUN npm ci --ignore-scripts

# 再复制源码并执行生产构建。
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ------------------------------
# 生产依赖阶段：在目标架构上安装运行期依赖。
# 说明：
# - 官方 Node 镜像已内置 /usr/local/include/node，显式复用本地头文件，
#   避免 sqlite3 回退 node-gyp 时还需外网下载与运行时完全匹配的 Node headers；
# - 编译工具只存在于该中间层，最终运行镜像不会携带编译器；
#   缺失这些工具会让 optional sqlite3 被 npm 静默跳过，直到启动时才报 DriverPackageNotInstalled。
# ------------------------------
FROM ${Y_LINK_NODE_IMAGE} AS prod-deps

WORKDIR /app

ENV npm_config_nodedir=/usr/local

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY .npmrc ./
RUN npm ci --omit=dev \
  && node -e "require('sqlite3')"

# ------------------------------
# 运行阶段：仅保留生产依赖与编译产物
# 说明：
# - 继续使用相同发行版，避免 sqlite3 二进制兼容问题；
# - 默认将 SQLite 数据落到 /app/data、上传图片落到 /app/uploads，便于通过 volume 持久化。
# ------------------------------
FROM ${Y_LINK_NODE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  PORT=3001 \
  SQLITE_DB_PATH=/app/data/y-link.sqlite \
  TZ=Asia/Shanghai

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*

# 创建运行目录并提前授权给 node 用户，降低容器默认 root 运行风险。
# 这里同时预创建 uploads 目录，确保首次上传前容器内就具备稳定的落盘路径。
RUN mkdir -p /app/data /app/uploads \
  && chown -R node:node /app

# 复制运行所需文件：package 信息、生产依赖、编译产物、SQL 模板。
COPY --from=prod-deps --chown=node:node /app/package*.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node sql ./sql

USER node

EXPOSE 3001

# 启动编译后的后端服务。
CMD ["npm", "run", "start"]
