#!/bin/sh
# 仅将管理员配置的 IP/CIDR 写入 Nginx，绝不把原始配置作为 shell 或 Nginx 指令执行。
set -eu
config_dir="${Y_LINK_NGINX_CONFIG_DIR:-/etc/nginx/ylink}"
mkdir -p "$config_dir"
: > "$config_dir/trusted-realip.conf"
: > "$config_dir/trusted-edge.geo"
for peer in $(printf '%s' "${Y_LINK_TRUSTED_EDGE_PROXIES:-}" | tr ',' ' '); do
  case "$peer" in
    *[!0-9a-fA-F:./]*|0.0.0.0/0|::/0) echo '[proxy-boundary] invalid trusted edge address' >&2; exit 1 ;;
  esac
  # 完整的 IP/CIDR 语义由后续 nginx -t 检验；这里先阻断空白/分号/变量/指令注入。
  printf 'set_real_ip_from %s;\n' "$peer" >> "$config_dir/trusted-realip.conf"
  printf '%s 1;\n' "$peer" >> "$config_dir/trusted-edge.geo"
done
hsts_age="${Y_LINK_HSTS_MAX_AGE_SECONDS:-15552000}"
case "$hsts_age" in ''|*[!0-9]*) echo '[proxy-boundary] invalid HSTS age' >&2; exit 1 ;; esac
if [ "$hsts_age" -gt 63072000 ]; then echo '[proxy-boundary] HSTS age too large' >&2; exit 1; fi
cat > "$config_dir/edge-protocol.conf" <<EOF
geo \$realip_remote_addr \$ylink_trusted_edge {
    default 0;
    include $config_dir/trusted-edge.geo;
}
map "\$ylink_trusted_edge:\$http_x_forwarded_proto" \$ylink_forwarded_proto {
    default \$scheme;
    "1:https" https;
    "1:http" http;
}
map \$ylink_forwarded_proto \$ylink_hsts {
    default "";
    https "max-age=$hsts_age";
}
EOF
