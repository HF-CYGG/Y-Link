# ------------------------------
# 文件说明：Y-Link 后端镜像构建文件。
# 实现逻辑：
# - 编译阶段固定跑在构建机原生架构（$BUILDPLATFORM）上，只做 TypeScript 编译，
#   并用 `--ignore-scripts` 跳过原生模块编译，避免跨架构构建时被 QEMU 拖慢；
# - 生产依赖阶段必须运行在目标架构上，sqlite3 / sharp 的原生产物与 CPU 架构强绑定；
# - 运行阶段仅保留生产依赖、编译产物与 SQL 模板，兼顾体积与 sqlite3 兼容性。
# ------------------------------
# SQLite 镜像固定 Node 22 LTS，避免未验收的新 ABI 让 optional sqlite3 在安装期被静默跳过。
# 固定到 Node 22 最新安全补丁版本；Node 发布新安全版本后 `npm run verify:security-updates` 会报红，需同步升级全部 Node 版本固定点。
ARG Y_LINK_NODE_IMAGE=public.ecr.aws/docker/library/node:22.23.5-bookworm-slim

# ------------------------------
# 编译阶段：只产出 dist，不产出 node_modules。
# 这里固定用 $BUILDPLATFORM，因为 tsc 是纯 JavaScript，编译结果与目标架构无关；
# 配合 `--ignore-scripts` 可跳过 sqlite3 / sharp 的原生编译，它们在此阶段只被当作类型使用。
# ------------------------------
FROM --platform=$BUILDPLATFORM ${Y_LINK_NODE_IMAGE} AS build
# 固定既有npm工具；官方包完整性失败即停，不改变Node/Nginx或应用锁。
COPY scripts/install-pinned-npm.mjs /tmp/ylink-install-pinned-npm.mjs
COPY scripts/build-pinned-npm.mjs /tmp/build-pinned-npm.mjs
COPY npm-toolchain /tmp/ylink-npm-toolchain
RUN node /tmp/ylink-install-pinned-npm.mjs --context=image --data-dir=/tmp/ylink-npm-toolchain

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
#   固定源码重建不再外网下载与运行时完全匹配的 Node headers；
# - 编译工具只存在于该中间层，最终运行镜像不会携带编译器；
#   optional包缺失、重建失败或实际版本不匹配均立即阻断，不回退旧预编译绑定。
# ------------------------------
FROM ${Y_LINK_NODE_IMAGE} AS prod-deps
# 固定既有npm工具；官方包完整性失败即停，不改变Node/Nginx或应用锁。
COPY scripts/install-pinned-npm.mjs /tmp/ylink-install-pinned-npm.mjs
COPY scripts/build-pinned-npm.mjs /tmp/build-pinned-npm.mjs
COPY npm-toolchain /tmp/ylink-npm-toolchain
RUN node /tmp/ylink-install-pinned-npm.mjs --context=image --data-dir=/tmp/ylink-npm-toolchain

WORKDIR /app

ENV npm_config_nodedir=/usr/local

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ binutils \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY .npmrc ./
COPY scripts/pinned-sqlite-source.mjs scripts/build-pinned-sqlite.mjs scripts/verify-pinned-sqlite.mjs scripts/install-pinned-sqlite.mjs ./scripts/
COPY src/database/pinned-sqlite-source.json ./src/database/pinned-sqlite-source.json
RUN npm ci --omit=dev

# ------------------------------
# 运行阶段：仅保留生产依赖与编译产物
# 说明：
# - 继续使用相同发行版，避免 sqlite3 二进制兼容问题；
# - 默认将 SQLite 数据落到 /app/data、上传图片落到 /app/uploads，便于通过 volume 持久化。
# ------------------------------
FROM prod-deps AS native-security-build
COPY native-security/baseline-v7 /ylink-native-security
RUN Y_LINK_NATIVE_SECURITY_BUILD=image sh /ylink-native-security/build-stage.sh

# 新增补丁及PAM为独立未验收候选，不混用v7 pins/安装器。
FROM prod-deps AS native-security-candidate
COPY native-security /ylink-native-security
RUN Y_LINK_NATIVE_SECURITY_BUILD=image sh /ylink-native-security/build-stage.sh --candidate-only

# glibc开发闭包独占原始基座，禁止在已修补运行库上混装发行版dev依赖。
FROM ${Y_LINK_NODE_IMAGE} AS glibc-security-build
COPY native-security /ylink-native-security
RUN Y_LINK_GLIBC_SECURITY_BUILD=image sh /ylink-native-security/build-glibc-stage.sh --candidate-only

# 仅显式--target package-security-candidate产出未验收DEB；普通runtime不依赖此stage。
FROM ${Y_LINK_NODE_IMAGE} AS package-security-candidate
COPY native-security /ylink-native-security
RUN Y_LINK_PACKAGE_SECURITY_BUILD=image sh /ylink-native-security/build-package-stage.sh --candidate-only --sources=coreutils,perl
FROM ${Y_LINK_NODE_IMAGE} AS runtime
# 保留既有合法运行基线；本批未验收native候选仅由独立target产出，尚未接入runtime。
COPY --from=native-security-build /native-out /tmp/ylink-native-security
COPY native-security/baseline-v7/install-backports.mjs native-security/baseline-v7/source-pins.json /tmp/ylink-native-security-installer/
# 固定既有npm工具；官方包完整性失败即停，不改变Node/Nginx或应用锁。
COPY scripts/install-pinned-npm.mjs /tmp/ylink-install-pinned-npm.mjs
COPY scripts/build-pinned-npm.mjs /tmp/build-pinned-npm.mjs
COPY npm-toolchain /tmp/ylink-npm-toolchain
RUN node /tmp/ylink-install-pinned-npm.mjs --context=image --data-dir=/tmp/ylink-npm-toolchain

WORKDIR /app

# libuv 线程池默认 4 线程，由 scrypt、sharp、SQLite 驱动与文件读写共用；登录洪水时数据库查询会被饿死，扩到 8。
ENV NODE_ENV=production \
  PORT=3001 \
  SQLITE_DB_PATH=/app/data/y-link.sqlite \
  TZ=Asia/Shanghai \
  UV_THREADPOOL_SIZE=8

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata \
  && node /tmp/ylink-native-security-installer/install-backports.mjs --input=/tmp/ylink-native-security \
  && rm -rf /tmp/ylink-native-security /tmp/ylink-native-security-installer /tmp/ylink-pam-security /tmp/ylink-pam-security-installer /tmp/ylink-glibc-security /tmp/ylink-glibc-security-installer /var/lib/apt/lists/*

# 创建运行目录并提前授权给 node 用户，降低容器默认 root 运行风险。
# 这里同时预创建 uploads 目录，确保首次上传前容器内就具备稳定的落盘路径。
RUN mkdir -p /app/data /app/uploads \
  && chown -R node:node /app

# 复制运行所需文件：package 信息、生产依赖、编译产物、SQL 模板。
COPY --from=prod-deps --chown=node:node /app/package*.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps /app/scripts ./scripts
COPY --from=prod-deps /app/src/database/pinned-sqlite-source.json ./src/database/pinned-sqlite-source.json
COPY --from=prod-deps /app/node_modules/.ylink-native-sqlite /usr/local/share/ylink-native-sqlite/
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node sql ./sql

USER node

EXPOSE 3001

# 直接使用与 npm start 相同的 Node 入口，使业务进程接收容器信号并保留退出 75。
CMD ["node", "dist/index.js"]
