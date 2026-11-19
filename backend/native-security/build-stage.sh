#!/bin/sh
# 仅镜像构建阶段：APT原有archive信任→Sources→精确源码版本；只产出两个本地运行库包。
set -eu
test "${Y_LINK_NATIVE_SECURITY_BUILD:-}" = image
test "$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)" = bookworm
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) exit 1 ;; esac
node /ylink-native-security/build-backports.mjs --verify-keyring
printf '%s\n' 'Types: deb-src' 'URIs: https://deb.debian.org/debian' 'Suites: bookworm' 'Components: main' 'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' > /etc/apt/sources.list.d/ylink-native-security.sources
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get build-dep -y --no-install-recommends --build-profiles=nobiarch 'util-linux=2.38.1-5+deb12u3' 'zlib=1:1.2.13.dfsg-1'
mkdir /native-source
cd /native-source
apt-get source --download-only --only-source 'util-linux=2.38.1-5+deb12u3' 'zlib=1:1.2.13.dfsg-1'
node /ylink-native-security/build-backports.mjs --work=/native-source --out=/native-out
