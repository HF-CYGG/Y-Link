#!/bin/sh
# 在增加任何构建工具前保留原镜像目标载荷和完整包库；仅在镜像构建层运行。
set -eu
set -o pipefail
test "$#" -eq 0
test ! -e /tmp/ylink-alpine-baseline
mkdir -m 0700 /tmp/ylink-alpine-baseline
grep -Eq '^3\.24\.' /etc/alpine-release
apk info -e libcrypto3 libssl3 libxml2 >/dev/null
cp /lib/apk/db/installed /tmp/ylink-alpine-baseline/installed
cp /etc/alpine-release /tmp/ylink-alpine-baseline/alpine-release
apk --print-arch > /tmp/ylink-alpine-baseline/arch
awk '
  /^P:/ { selected=($0 ~ /^P:(libcrypto3|libssl3|libxml2|openssl|openssl-fips)$/) }
  /^F:/ { directory=substr($0,3) }
  /^R:/ && selected { print directory "/" substr($0,3) }
' /lib/apk/db/installed | LC_ALL=C sort -u > /tmp/ylink-alpine-baseline/files
test -s /tmp/ylink-alpine-baseline/files
# -T只列包内文件，不递归打包usr/lib之类共享目录。
tar -C / -cpf /tmp/ylink-alpine-baseline/payload.tar -T /tmp/ylink-alpine-baseline/files
find /etc/apk/keys -type f -exec sha256sum '{}' ';' | LC_ALL=C sort > /tmp/ylink-alpine-baseline/system-keys.sha256
test -s /tmp/ylink-alpine-baseline/system-keys.sha256
