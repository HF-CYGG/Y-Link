#!/bin/sh
# 仅独立候选stage；先安装完整匹配GCC构建闭包，原发行版信任与固定输入不变。
set -eu
test "$#" = 1 && test "$1" = --candidate-only
test "${Y_LINK_NODE_SECURITY_BUILD:-}" = image
test "$(dpkg --print-architecture)" = amd64
node /ylink-native-security/prepare-gcc-offline-build.mjs --candidate-only --node-builder-only
node /ylink-native-security/install-gcc-backport.mjs --candidate-only --context=build
node /ylink-native-security/prepare-node-offline-build.mjs --candidate-only
# 缺少已认证生成工具即停；不以在线APT或无校验下载补齐本次输入。
nasm -v
perl -MText::Template -e 'exit 0'
mkdir /native-node-source
cp /ylink-node-inputs/node-v22.23.5.tar.xz /native-node-source/node-v22.23.5.tar.xz
node /ylink-native-security/build-node-backport.mjs --candidate-only
