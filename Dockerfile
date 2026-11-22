# syntax=docker/dockerfile:1

# 模块说明：前端独立部署 Docker 构建文件
# 文件职责：定义前端静态资源的打包过程与 Nginx 运行环境
# 维护说明：若前端构建流程增加必须的环境变量或改变产物目录，需同步修改此处

# ------------------------------
# 文件说明：Y-Link 前端镜像构建文件。
# 实现逻辑：
# - 构建阶段复制仓库级 `.npmrc`，强制使用官方 npm 源安装依赖并产出 Vite 静态资源；
# - 运行阶段通过 Nginx 托管静态资源，并把 `/api` 代理到同编排的后端服务。
# ------------------------------
# sqlite3@5 的 N-API 预编译产物在 Node 22 LTS 上稳定可用；升级 Node 主版本前必须先通过 Onebox SQLite 冒烟。
# 固定到 Node 22 最新安全补丁版本；Node 发布新安全版本后 `npm run verify:security-updates` 会报红，需同步升级全部 Node 版本固定点。
ARG Y_LINK_NODE_IMAGE=public.ecr.aws/docker/library/node:22.23.5-bookworm-slim

FROM --platform=$BUILDPLATFORM ${Y_LINK_NODE_IMAGE} AS build
# 固定既有npm工具；官方包完整性失败即停，不改变Node/Nginx或应用锁。
COPY backend/scripts/install-pinned-npm.mjs /tmp/ylink-install-pinned-npm.mjs
COPY backend/scripts/build-pinned-npm.mjs /tmp/build-pinned-npm.mjs
COPY backend/npm-toolchain /tmp/ylink-npm-toolchain
RUN node /tmp/ylink-install-pinned-npm.mjs --context=image --data-dir=/tmp/ylink-npm-toolchain

WORKDIR /app

# 先安装依赖，充分利用层缓存。
COPY package*.json ./
COPY .npmrc ./
# 根 lockfile 同时服务 Web、Mobile 与共享包；前端镜像只安装根 Web 依赖，
# 避免把 Expo/React Native workspace 依赖带入静态站点构建层。
RUN npm ci --workspaces=false

# 复制前端源码与构建配置后执行生产打包。
COPY index.html ./
COPY rescue.html ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY packages/shared-types ./packages/shared-types
COPY packages/validation ./packages/validation
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
# nginx 跟随官方 stable 分支（1.30.x）；1.27 主线分支已停止维护，不再获得安全修复。
FROM nginx:1.30.6-alpine AS alpine-native-base

ENV TZ=Asia/Shanghai

RUN apk add --no-cache tzdata \
  && mkdir -p /var/cache/nginx/ylink-public \
  && chown -R nginx:nginx /var/cache/nginx/ylink-public

# 候选阶段保留原基座的精确修订和载荷，供固定源包和签名契约核对。
FROM alpine-native-base AS alpine-native-build
COPY docker/alpine-native-security /opt/ylink-alpine-security
RUN --mount=from=alpine-native-base,source=/,target=/mnt/ylink-alpine-original,ro \
  sh /opt/ylink-alpine-security/capture-baseline.sh \
  && apk add --no-cache abuild build-base python3 python3-dev perl linux-headers xz-dev zlib-dev patch binutils openssl \
  && python3 /opt/ylink-alpine-security/build.py --candidate-only

FROM alpine-native-base AS runtime
# 仅从 Alpine 3.24 官方源更新三个已装包。libxslt 依赖 libxml2，后者依赖 zlib。
# 保留系统可信密钥，校验版本下限并核对其它包的名称和版本。
RUN set -eu; \
  set -o pipefail; \
  grep -Eq '^3\.24\.' /etc/alpine-release; \
  apk info -e zlib libxml2 libxslt >/dev/null; \
  before_packages="$(apk info -v)"; \
  before_other="$(printf '%s\n' "$before_packages" | grep -Ev '^(zlib|libxml2|libxslt)-[0-9]' | LC_ALL=C sort)"; \
  apk --repositories-file /dev/null \
    --repository https://dl-cdn.alpinelinux.org/alpine/v3.24/main \
    --repository https://dl-cdn.alpinelinux.org/alpine/v3.24/community \
    add --no-cache --upgrade 'zlib>=1.4-r0' 'libxml2>=2.13.9-r3' 'libxslt>=1.1.43-r4'; \
  after_packages="$(apk info -v)"; \
  after_other="$(printf '%s\n' "$after_packages" | grep -Ev '^(zlib|libxml2|libxslt)-[0-9]' | LC_ALL=C sort)"; \
  test "$before_other" = "$after_other" || { printf >&2 '%s\n' 'APK 事务更改了范围外的运行包库存'; exit 1; }; \
  for requirement in zlib:1.4-r0 libxml2:2.13.9-r3 libxslt:1.1.43-r4; do \
    package="${requirement%:*}"; \
    minimum="${requirement#*:}"; \
    previous="$(printf '%s\n' "$before_packages" | sed -n "/^$package-[0-9]/s/^$package-//p")"; \
    installed="$(printf '%s\n' "$after_packages" | sed -n "/^$package-[0-9]/s/^$package-//p")"; \
    test -n "$installed"; \
    apk version --check "$previous" "$installed"; \
    if [ "$(apk version --test "$previous" "$minimum")" = '>' ]; then minimum="$previous"; fi; \
    case "$(apk version --test "$installed" "$minimum")" in \
      '='|'>') ;; \
      *) printf >&2 '%s 安装版本 %s 低于要求的 %s\n' "$package" "$installed" "$minimum"; exit 1 ;; \
    esac; \
  done

# 使用可模板化站点配置：
# - 处理 Vue Router history 路由回退；
# - 默认代理到同编排 backend:3001，并通过延迟解析降低启动阶段 DNS 瞬态失败风险。
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/nginx/page-security-headers.conf /etc/nginx/ylink/page-security-headers.conf
COPY docker/nginx/proxy-security-headers.conf /etc/nginx/ylink/proxy-security-headers.conf
COPY docker/nginx/configure-proxy-boundary.sh /docker-entrypoint.d/19-ylink-proxy-boundary.sh
RUN chmod +x /docker-entrypoint.d/19-ylink-proxy-boundary.sh
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
