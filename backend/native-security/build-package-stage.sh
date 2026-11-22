#!/bin/sh
# 独立候选target：不进入普通final依赖，不默认禁测，不把nocheck候选当已验收发布物。
set -eu
test "${Y_LINK_PACKAGE_SECURITY_BUILD:-}" = image
test "$#" = 2
test "$1" = --candidate-only
case "$2" in --sources=coreutils,perl) sources='coreutils perl' ;; --sources=coreutils,openssl,perl) sources='coreutils openssl perl' ;; *) exit 1 ;; esac
test "$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)" = bookworm
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) exit 1 ;; esac
node --input-type=module -e 'import assert from "node:assert/strict"; import {pins,sha256} from "/ylink-native-security/package-backport-contract.mjs"; assert.equal(sha256("/usr/share/keyrings/debian-archive-keyring.gpg"),pins.keyringSha256)'
# 仅使用原发行版可信签名索引；不导入新钥匙、不接自定义源、不允许未认证包。
printf '%s\n' 'Types: deb-src' 'URIs: https://deb.debian.org/debian' 'Suites: bookworm' 'Components: main' 'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' '' 'Types: deb-src' 'URIs: https://security.debian.org/debian-security' 'Suites: bookworm-security' 'Components: main' 'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' > /etc/apt/sources.list.d/ylink-package-candidate.sources
apt-get update
mkdir /native-package-source /native-package-out
for source in $sources; do
  version="$(node --input-type=module -e 'import {component} from "/ylink-native-security/package-backport-contract.mjs"; process.stdout.write(component(process.argv[1]).version)' "$source")"
  packages="$(node --input-type=module -e 'import {component} from "/ylink-native-security/package-backport-contract.mjs"; process.stdout.write(component(process.argv[1]).runtimePackages.join(" "))' "$source")"
  mkdir "/native-package-source/$source"
  cd "/native-package-source/$source"
  mkdir reference
  for package in $packages; do
    # 完整原版本DEB由APT签名索引及哈希认证，供完整payload/control/ABI逐项对照。
    (cd reference && apt-get download "$package=$version")
  done
  apt-get source --download-only --only-source "$source=$version"
  # 下游--build=binary同时包含any与all；不以arch-only漏掉适用Indep构建依赖。
  DEBIAN_FRONTEND=noninteractive apt-get build-dep -y --no-install-recommends --build-profiles=nobiarch "$source=$version"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-remove binutils
  node /ylink-native-security/build-package-backports.mjs --candidate-only "--source=$source"
done
