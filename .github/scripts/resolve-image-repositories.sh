#!/usr/bin/env bash
# ------------------------------
# 文件说明：解析 Y-Link 各镜像应推送到哪些镜像仓库。
# 实现逻辑：
# - 根据仓库变量与凭据存在性，决定 Docker Hub 与阿里云 ACR 是否参与推送；
# - 校验命名空间与 ACR 地址格式，非法值直接失败，避免把镜像推到意外仓库；
# - 结果写入 $GITHUB_OUTPUT，供调用方的后续步骤引用。
#
# 用法：
#   bash .github/scripts/resolve-image-repositories.sh            # 只输出推送开关
#   bash .github/scripts/resolve-image-repositories.sh <镜像名>   # 额外输出该镜像的仓库清单
#   镜像名取值：frontend | backend | onebox
#
# 维护说明：
# 本脚本必须在「需要用到仓库清单的那个作业内部」执行，不能把清单作为 job output 跨作业传递。
# Docker Hub 命名空间与 DOCKERHUB_USERNAME 同值时会被判定为 secret，
# 而 GitHub 会把包含 secret 的 job output 整体清空（跨作业传递时静默变成空字符串），
# 从而让 metadata-action 只生成裸标签名，最终把镜像误推到 docker.io/library/<tag>。
# ------------------------------
set -euo pipefail

target_image="${1:-}"

DEFAULT_ACR_REGISTRY="crpi-9gmsq2s17re73ia9.cn-qingdao.personal.cr.aliyuncs.com"
DEFAULT_ACR_NAMESPACE="yyh163"

write_output() {
  local key="$1"
  local value="$2"
  if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Invalid output key: $key" >&2
    exit 1
  fi
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "Invalid multiline value for output: $key" >&2
    exit 1
  fi
  printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
}

namespace="${DOCKERHUB_NAMESPACE_VAR:-}"
if [ -z "$namespace" ]; then
  namespace="${GITHUB_REPOSITORY_OWNER}"
fi
namespace="$(printf '%s' "$namespace" | tr '[:upper:]' '[:lower:]')"
if [[ ! "$namespace" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]]; then
  echo "Invalid DOCKERHUB_NAMESPACE; only Docker namespace characters are allowed." >&2
  exit 1
fi

gh_owner="$(printf '%s' "${GITHUB_REPOSITORY_OWNER}" | tr '[:upper:]' '[:lower:]')"
write_output "gh_owner" "$gh_owner"

acr_registry="${ACR_REGISTRY_VAR:-}"
if [ -z "$acr_registry" ]; then
  acr_registry="$DEFAULT_ACR_REGISTRY"
fi
acr_namespace="${ACR_NAMESPACE_VAR:-}"
if [ -z "$acr_namespace" ]; then
  acr_namespace="$DEFAULT_ACR_NAMESPACE"
fi
acr_push_mode="${ACR_PUSH_MODE_VAR:-}"
if [ -z "$acr_push_mode" ]; then
  acr_push_mode="release_tag_only"
fi

if [[ ! "$acr_registry" =~ ^[a-z0-9][a-z0-9.-]*\.aliyuncs\.com$ ]]; then
  echo "Invalid ACR_REGISTRY; only Aliyun ACR registry hosts are allowed." >&2
  exit 1
fi
if [[ ! "$acr_namespace" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]]; then
  echo "Invalid ACR_NAMESPACE; only registry namespace characters are allowed." >&2
  exit 1
fi
case "$acr_push_mode" in
  all|release_tag_only)
    ;;
  *)
    echo "Unsupported ACR_PUSH_MODE=$acr_push_mode, fallback to release_tag_only"
    acr_push_mode="release_tag_only"
    ;;
esac
write_output "acr_registry" "$acr_registry"
write_output "acr_namespace" "$acr_namespace"
write_output "acr_push_mode" "$acr_push_mode"

acr_enabled="false"
if [ "${HAS_ACR_CREDS}" = "true" ]; then
  case "$acr_push_mode" in
    all)
      acr_enabled="true"
      ;;
    release_tag_only)
      if [[ "${GITHUB_REF}" == refs/tags/release-v* ]]; then
        acr_enabled="true"
      fi
      ;;
  esac
fi
write_output "acr_enabled" "$acr_enabled"

dockerhub_enabled="false"
if [ "${HAS_DOCKERHUB_CREDS}" = "true" ]; then
  dockerhub_enabled="true"
fi
write_output "dockerhub_enabled" "$dockerhub_enabled"

if [ -z "$target_image" ]; then
  exit 0
fi

case "$target_image" in
  frontend|backend|onebox)
    ;;
  *)
    echo "Unsupported image name: $target_image" >&2
    exit 1
    ;;
esac

# onebox 在阿里云 ACR 上使用 y-link 短名，便于直接用于部署。
acr_repository="y-link-${target_image}"
if [ "$target_image" = "onebox" ]; then
  acr_repository="y-link"
fi

# 排列顺序即 metadata-action 的标签顺序，首位会被后续步骤当作校验用的主标签。
images=("ghcr.io/${gh_owner}/y-link-${target_image}")
if [ "$dockerhub_enabled" = "true" ]; then
  images=("docker.io/${namespace}/y-link-${target_image}" "${images[@]}")
fi
if [ "$acr_enabled" = "true" ]; then
  images=("${acr_registry}/${acr_namespace}/${acr_repository}" "${images[@]}")
fi

# metadata-action 的 images 输入同时接受换行与逗号分隔，这里用逗号保持单行输出。
joined="$(IFS=,; printf '%s' "${images[*]}")"
write_output "images" "$joined"
echo "镜像 ${target_image} 的推送目标数量: ${#images[@]}"
