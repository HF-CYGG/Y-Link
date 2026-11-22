#!/bin/sh
# 独立原始Bookworm候选stage；不进入普通runtime，不执行原suite。
set -eu
test "$#" = 1 && test "$1" = --candidate-only
test "${Y_LINK_GCC_SECURITY_BUILD:-}" = image
test "$(dpkg --print-architecture)" = amd64
node /ylink-native-security/prepare-gcc-offline-build.mjs --candidate-only
node /ylink-native-security/build-gcc-backport.mjs --candidate-only
