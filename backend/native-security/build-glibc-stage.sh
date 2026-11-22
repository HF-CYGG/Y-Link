#!/bin/sh
# 原始Bookworm独立构建层；开发闭包绝不进入最终运行层或复用已修补运行库。
set -eu
test "$#" = 1 && test "$1" = --candidate-only
test "${Y_LINK_GLIBC_SECURITY_BUILD:-}" = image
test "$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)" = bookworm
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) exit 1 ;; esac
node /ylink-native-security/build-backports.mjs --verify-keyring
printf '%s\n' 'Types: deb-src' 'URIs: https://deb.debian.org/debian' 'Suites: bookworm' 'Components: main' 'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' > /etc/apt/sources.list.d/ylink-glibc-security.sources
apt-get update
mkdir /native-glibc-source
cd /native-glibc-source
mkdir reference
# download仍通过APT原签名索引/哈希认证，不允许未认证包或修改信任根。
(cd reference && apt-get download 'libc6=2.36-9+deb12u14' 'libc-bin=2.36-9+deb12u14')
apt-get source --download-only --only-source 'glibc=2.36-9+deb12u14'
DEBIAN_FRONTEND=noninteractive apt-get build-dep -y --no-install-recommends --arch-only --build-profiles=nobiarch 'glibc=2.36-9+deb12u14'
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-remove binutils
node /ylink-native-security/build-glibc-backport.mjs --candidate-only --work=/native-glibc-source
