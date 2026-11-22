#!/bin/sh
# 只读验证producer严格派生的确定性sidecar；不解析宽松JSON或执行其内容。
set -eu
test "$#" -eq 0
test -f manifest.json && test ! -L manifest.json
test -f candidate-policy.txt && test ! -L candidate-policy.txt
manifest_digest=$(sha256sum manifest.json)
manifest_digest=${manifest_digest%% *}
test "${#manifest_digest}" -eq 64
case "$manifest_digest" in *[!0-9a-f]*) exit 1 ;; esac
printf '%s\n' \
  'YLINK_ALPINE_CANDIDATE_V1' \
  "manifest_sha256=$manifest_digest" \
  'candidate_only=true' \
  'approved_for_release=false' \
  'security_verification_blocked=true' \
  'upstream_tests_preserved=true' \
  'upstream_suite_scope=not-established' \
  'native_tests_executed=false' \
  'native_tests_reason=explicit-candidate-only-abuild-options-nocheck' \
  | cmp -s candidate-policy.txt -
