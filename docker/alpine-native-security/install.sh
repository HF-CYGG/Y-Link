#!/bin/sh
# 只消费本构建输出的固定清单；无解释器/签名工具等新增运行依赖。
set -eu
set -o pipefail
# 默认正式安装入口拒绝当前未验收候选；显式选项仅供隔离兼容诊断。
test "$#" -eq 1 && test "$1" = --candidate-only
cd /tmp/ylink-alpine-security
test "$(pwd -P)" = /tmp/ylink-alpine-security
test ! -L /tmp/ylink-alpine-security
grep -Eq '^3\.24\.' /etc/alpine-release
test "$(apk --print-arch)" = "$(cat arch)"
sha256sum -c artifacts.sha256
# 该helper也在artifacts.sha256内；sidecar逐行严格且绑定当前manifest原字节摘要。
sh ./verify-candidate-policy.sh
sha256sum -c database.sha256
verify_keys() {
  find /etc/apk/keys -type f -exec sha256sum '{}' ';' | LC_ALL=C sort > current-keys.sha256
  cmp -s system-keys.sha256 current-keys.sha256
}
inventory() {
  awk '
    function emit() { if (name != "") { if (version == "") exit 1; print name "\t" version; name=""; version="" } }
    /^P:/ { name=substr($0,3) } /^V:/ { version=substr($0,3) } /^$/ { emit() } END { emit() }
  ' /lib/apk/db/installed | LC_ALL=C sort
}
verify_payload() {
  tab=$(printf '\t')
  while IFS="$tab" read -r file type mode uid gid value; do
    test -n "$file"
    test "$(stat -c '%a %u %g' "/$file")" = "$mode $uid $gid"
    case "$type" in
      file)
        test -f "/$file" && test ! -L "/$file"
        actual=$(sha256sum "/$file")
        test "${actual%% *}" = "$value" ;;
      symlink)
        test -L "/$file"
        test "$(readlink "/$file")" = "$value" ;;
      *) echo '未知载荷类型' >&2; exit 1 ;;
    esac
  done < "$1"
}
verify_keys
inventory > current-packages.tsv
cmp -s before-packages.tsv current-packages.tsv
verify_payload before.tsv
set --
while IFS= read -r name; do
  case "$name" in
    libcrypto3|libssl3|libxml2|openssl|openssl-fips) ;;
    *) echo '未知目标包' >&2; exit 1 ;;
  esac
  apk info -e "$name" >/dev/null
  case "$name" in libxml2) version=2.13.9-r100 ;; *) version=3.5.9-r100 ;; esac
  set -- "$@" "./$name-$version.apk"
done < targets
test "$#" -ge 3 && test "$#" -le 5
for required in libcrypto3 libssl3 libxml2; do grep -Fqx "$required" targets; done
apk --no-network --no-cache --keys-dir /tmp/ylink-alpine-security/keys verify "$@"
# 只允许这些原有包升级；未知事务格式亦失败，不靠安装后才发现扩张。
apk --no-network --no-cache --keys-dir /tmp/ylink-alpine-security/keys --repositories-file /dev/null add --simulate --no-interactive --no-progress --upgrade "$@" > simulation.log 2>&1
cat simulation.log
if grep -Eq 'Installing|Purging|Removing|Downgrading|Reinstalling' simulation.log; then exit 1; fi
sed -nE 's/^([(][0-9]+\/[0-9]+[)] )?Upgrading ([a-zA-Z0-9_.+-]+) .*/\2/p' simulation.log | LC_ALL=C sort > changed-targets
cmp -s targets changed-targets
apk --no-network --no-cache --keys-dir /tmp/ylink-alpine-security/keys --repositories-file /dev/null add --no-interactive --no-progress --upgrade "$@" > transaction.log 2>&1
cat transaction.log
inventory > current-packages.tsv
cmp -s after-packages.tsv current-packages.tsv
verify_payload after.tsv
verify_keys
test ! -e /usr/local/share/ylink-alpine-security
mkdir -p /usr/local/share/ylink-alpine-security
cp manifest.json candidate-policy.txt source-pins.json artifacts.sha256 simulation.log transaction.log /usr/local/share/ylink-alpine-security/
cp keys/ylink-alpine-batch.rsa.pub /usr/local/share/ylink-alpine-security/signer.pub
printf '%s\n' '完整载荷与实际包库存已核对；最终兼容/安全验收另行执行' > /usr/local/share/ylink-alpine-security/installed-proof.txt
