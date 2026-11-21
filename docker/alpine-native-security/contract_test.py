"""统一验收时运行的固定包边界回归；本阶段不执行，不包含原生漏洞触发器。"""
import copy
import io
import os
import unittest
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
from unittest.mock import patch
import build as builder
from contract import BASE_VERSIONS, compare_payload, check_dependency_tokens, records, safe_path, targets, candidate_policy, serialize_candidate_contract


class AlpineContractTests(unittest.TestCase):
    @unittest.skipIf(os.name == 'nt', 'Windows不提供完整POSIX权限语义，统一Linux验收执行')
    def test_build_key_scope_preserves_official_keys_on_success_and_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            keys = root / 'keys'; keys.mkdir()
            official = keys / 'official.rsa.pub'; official.write_bytes(b'fixed official key')
            public = root / 'ylink-alpine-batch.rsa.pub'; public.write_bytes(b'unique batch public key')
            before = builder.keyring_snapshot(keys)
            for fail in [False, True]:
                try:
                    with builder.temporary_build_key(public, keys):
                        self.assertEqual((keys / public.name).read_bytes(), public.read_bytes())
                        self.assertEqual(official.read_bytes(), b'fixed official key')
                        if fail:
                            raise RuntimeError('original producer failure')
                except RuntimeError as error:
                    self.assertEqual(str(error), 'original producer failure')
                self.assertEqual(builder.keyring_snapshot(keys), before)
            target = keys / public.name; target.write_bytes(b'existing key')
            with self.assertRaises(FileExistsError):
                with builder.temporary_build_key(public, keys):
                    self.fail('不得覆盖既有公钥')
            self.assertEqual(target.read_bytes(), b'existing key')
            target.unlink()
            with self.assertRaisesRegex(ValueError, '官方keyring'):
                with builder.temporary_build_key(public, keys):
                    official.write_bytes(b'changed key')
            self.assertFalse(target.exists())

    @unittest.skipIf(os.name == 'nt', 'Windows无当前普通账户的POSIX链接权限，统一Linux验收执行')
    def test_build_key_refuses_linked_roots_and_public(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            keys = root / 'keys'; keys.mkdir()
            public = root / 'ylink-alpine-batch.rsa.pub'; public.write_bytes(b'public')
            alias = root / 'alias'; alias.symlink_to(keys, target_is_directory=True)
            with self.assertRaises(ValueError):
                with builder.temporary_build_key(public, alias):
                    self.fail('不能向链接keyring写入')
            public.unlink(); public.symlink_to(root / 'missing')
            with self.assertRaises(ValueError):
                with builder.temporary_build_key(public, keys):
                    self.fail('不能读取链接public')

    def test_real_vendor_source_insertion_preserves_other_blocks(self):
        assets = pathlib.Path(__file__).resolve().parent
        pins = json.loads((assets / 'source-pins.json').read_text(encoding='utf8'))
        for component in ['openssl', 'libxml2']:
            file = assets / pins['packages'][component]['recipe']
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), pins['packages'][component]['recipeSha256'])
            original = file.read_text(encoding='utf8')
            addition = '\tylink-fixed-production.patch'
            changed = builder.append_patch_sources(original, [addition])
            self.assertEqual(changed.count(addition), 1)
            self.assertEqual(changed.replace(addition + '\n', '', 1), original)
            source = changed.split('source="', 1)[1].split('"', 1)[0]
            self.assertIn(addition + '\n', source)
            for invalid in [original.replace('source="', 'missing="', 1), original + '\nsource="extra\n\t"\n']:
                with self.assertRaises(ValueError):
                    builder.append_patch_sources(invalid, [addition])
            for invalid in ['\t../escape.patch', '\tline\nbreak.patch', '\tquote".patch']:
                with self.assertRaises(ValueError):
                    builder.append_patch_sources(original, [invalid])

    def archive_fixture(self, data=b'authenticated archive fixture'):
        return {'name': 'fixed.tar.xz', 'url': 'https://example.invalid/fixed.tar.xz', 'bytes': len(data),
                'sha256': hashlib.sha256(data).hexdigest(), 'sha512': hashlib.sha512(data).hexdigest()}

    def test_verified_source_cache_and_original_missing_download(self):
        data = b'authenticated archive fixture'
        source = self.archive_fixture(data)
        pins = {'packages': {'component': {'upstreamInputs': [source]}}}
        with tempfile.TemporaryDirectory() as temporary:
            work = pathlib.Path(temporary).resolve() / 'work'
            with patch.object(builder, 'WORK', work), patch.object(builder, 'OUT', work.parent / 'out'):
                builder.prepare_work(pins)
                with patch.object(builder.urllib.request, 'urlopen', return_value=io.BytesIO(data)) as fetch:
                    self.assertEqual(builder.upstream_archive(source).read_bytes(), data)
                    fetch.assert_called_once_with(source['url'], timeout=120)
                with patch.object(builder.urllib.request, 'urlopen', side_effect=AssertionError('有效缓存不得触网')):
                    builder.prepare_work(pins)
                    self.assertEqual(builder.upstream_archive(source).read_bytes(), data)
                for changed in [b'corrupt same size'.ljust(len(data), b'!'), data + b'x']:
                    (work / 'distfiles' / source['name']).write_bytes(changed)
                    with patch.object(builder.urllib.request, 'urlopen', side_effect=AssertionError('坏缓存不得重取')):
                        with self.assertRaises(ValueError):
                            builder.prepare_work(pins)
                        with self.assertRaises(ValueError):
                            builder.upstream_archive(source)
                (work / 'distfiles' / source['name']).write_bytes(data)
                wrong = {**source, 'sha512': '0' * 128}
                with self.assertRaises(ValueError):
                    builder.upstream_archive(wrong)
                for name in ['../escape.tar.xz', '/escape.tar.xz', 'sub/fixed.tar.xz']:
                    with self.assertRaises(ValueError):
                        builder.upstream_archive({**source, 'name': name})
                (work / 'unexpected-build-tree').mkdir()
                with self.assertRaises(ValueError):
                    builder.prepare_work(pins)

    def test_source_cache_rejects_unknown_or_nonregular_entries(self):
        source = self.archive_fixture()
        pins = {'packages': {'component': {'upstreamInputs': [source]}}}
        with tempfile.TemporaryDirectory() as temporary:
            work = pathlib.Path(temporary).resolve() / 'work'
            with patch.object(builder, 'WORK', work), patch.object(builder, 'OUT', work.parent / 'out'):
                builder.prepare_work(pins)
                unknown = work / 'distfiles' / 'unknown.tar.xz'; unknown.write_bytes(b'unknown')
                with self.assertRaises(ValueError):
                    builder.prepare_work(pins)
                unknown.unlink()
                (work / 'distfiles' / source['name']).mkdir()
                with self.assertRaises(ValueError):
                    builder.prepare_work(pins)
                with self.assertRaises(ValueError):
                    builder.upstream_archive(source)

    @unittest.skipIf(os.name == 'nt', '符号链接拒绝需在Linux补充执行')
    def test_source_cache_rejects_root_directory_and_archive_links(self):
        data = b'authenticated archive fixture'
        source = self.archive_fixture(data)
        pins = {'packages': {'component': {'upstreamInputs': [source]}}}
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary).resolve(); real = base / 'real'; real.mkdir()
            work = base / 'work'; work.symlink_to(real, target_is_directory=True)
            with patch.object(builder, 'WORK', work), patch.object(builder, 'OUT', base / 'out'):
                with self.assertRaises(ValueError):
                    builder.prepare_work(pins)
                work.unlink(); work.mkdir(); (work / 'distfiles').symlink_to(real, target_is_directory=True)
                with self.assertRaises(ValueError):
                    builder.prepare_work(pins)
                (work / 'distfiles').unlink(); (work / 'distfiles').mkdir()
                archive = real / source['name']; archive.write_bytes(data)
                (work / 'distfiles' / source['name']).symlink_to(archive)
                with self.assertRaises(ValueError):
                    builder.prepare_work(pins)
                with self.assertRaises(ValueError):
                    builder.upstream_archive(source)

    def candidate(self):
        return {'schema': 1, 'candidateOnly': True, 'approvedForRelease': False,
                'securityVerificationBlocked': True, 'upstreamTestsPreserved': True,
                'upstreamSuiteScopeStatus': 'not-established',
                'nativeTests': {'executed': False, 'reason': 'explicit-candidate-only-abuild-options-nocheck'}}

    def test_real_producer_format_and_strict_states(self):
        raw, policy = serialize_candidate_contract(self.candidate())
        self.assertIn(b'"nativeTests": {\n', raw)
        self.assertIn(('manifest_sha256=' + hashlib.sha256(raw).hexdigest() + '\n').encode(), policy)
        self.assertEqual(candidate_policy(raw), policy)
        for key in ['candidateOnly', 'approvedForRelease', 'securityVerificationBlocked', 'upstreamTestsPreserved']:
            for wrong in [None, 0, 1, 'true', 'false', [], {}]:
                changed = self.candidate(); changed[key] = wrong
                with self.assertRaises(ValueError):
                    serialize_candidate_contract(changed)
            changed = self.candidate(); del changed[key]
            with self.assertRaises(ValueError):
                serialize_candidate_contract(changed)
        for wrong in [None, 'false', 0, True, []]:
            changed = self.candidate(); changed['nativeTests']['executed'] = wrong
            with self.assertRaises(ValueError):
                serialize_candidate_contract(changed)
        changed = self.candidate(); changed['nativeTests']['unexpectedFailures'] = 0
        with self.assertRaises(ValueError):
            serialize_candidate_contract(changed)

    def test_duplicate_and_contradictory_manifest_rejected(self):
        raw, _ = serialize_candidate_contract(self.candidate())
        for value in [raw.replace(b'"candidateOnly": true', b'"candidateOnly": true, "candidateOnly": false'),
                      raw.replace(b'"executed": false', b'"executed": false, "executed": true'),
                      raw.replace(b'"approvedForRelease": false', b'"approvedForRelease": true'),
                      raw.replace(b'"executed": false', b'"executed": NaN')]:
            with self.assertRaises(ValueError):
                candidate_policy(value)

    @unittest.skipUnless(sys.platform.startswith('linux'), '实际POSIX消费者留待获准Linux guest；skip不当作覆盖通过')
    def test_shell_consumes_real_producer_and_rejects_tampering(self):
        helper = pathlib.Path(__file__).with_name('verify-candidate-policy.sh').resolve()
        raw, policy = serialize_candidate_contract(self.candidate())
        with tempfile.TemporaryDirectory(prefix='ylink-alpine-policy-') as directory:
            root = pathlib.Path(directory)
            def consume(manifest, sidecar):
                (root / 'manifest.json').write_bytes(manifest)
                (root / 'candidate-policy.txt').write_bytes(sidecar)
                return subprocess.run(['/bin/sh', str(helper)], cwd=root, capture_output=True, timeout=5).returncode
            self.assertEqual(consume(raw, policy), 0)
            for sidecar in [b'', policy + b'native_tests_executed=true\n', policy.replace(b'candidate_only=true', b'candidate_only=false'),
                            policy.replace(b'native_tests_executed=false', b'native_tests_executed=0'),
                            policy.replace(b'manifest_sha256=', b'manifest_sha256=0')]:
                self.assertNotEqual(consume(raw, sidecar), 0)
            self.assertNotEqual(consume(raw + b' ', policy), 0)

    def database(self):
        return {name: {"V": BASE_VERSIONS[name], "A": "aarch64", "o": "libxml2" if name == "libxml2" else "openssl"}
                for name in ("libcrypto3", "libssl3", "libxml2")}

    def test_no_optional_runtime_additions(self):
        self.assertEqual(targets(self.database(), "aarch64"), ["libcrypto3", "libssl3", "libxml2"])

    def test_missing_mandatory_refused(self):
        db = self.database()
        del db["libssl3"]
        with self.assertRaises(ValueError):
            targets(db, "aarch64")

    def test_version_arch_origin_drift_refused(self):
        for key, value in (("V", "3.6.0-r0"), ("A", "x86_64"), ("o", "unknown")):
            db = self.database()
            db["libcrypto3"][key] = value
            with self.assertRaises(ValueError):
                targets(db, "aarch64")

    def test_duplicate_metadata_refused(self):
        with self.assertRaises(ValueError):
            records("P:libxml2\nV:2.13.9-r2\nP:evil\n")

    def test_only_fixed_runtime_targets_consume_database_paths(self):
        certificate = "usr/share/ca-certificates/mozilla"
        name = "NetLock_Arany_=Class_Gold=_Főtanúsítvány.crt"
        other = "P:ca-certificates\nV:20260622-r0\nA:x86_64\no:ca-certificates\nF:" + certificate + "\nR:" + name + "\n"
        target = "P:libxml2\nV:2.13.9-r2\nA:x86_64\no:libxml2\nF:usr/lib\nR:libxml2.so.2\n"
        db = records(other + "\n" + target)
        self.assertEqual(db['ca-certificates']['V'], '20260622-r0')
        self.assertEqual(db['ca-certificates']['files'], [])
        self.assertEqual(db['libxml2']['files'], ['usr/lib/libxml2.so.2'])
        for package in ('libcrypto3', 'libssl3', 'libxml2', 'openssl', 'openssl-fips'):
            for fields in ['F:usr/lib\nR:' + name, 'F:../lib\nR:a', 'F:/usr/lib\nR:a', 'F:usr/lib\nR:../a', 'R:a']:
                with self.assertRaises(ValueError):
                    records('P:' + package + '\nV:fixed\n' + fields + '\n')
        for value in [other + 'V:duplicate\n', other + '\n' + other]:
            with self.assertRaises(ValueError):
                records(value)

    def test_paths_refuse_shell_and_escape(self):
        for value in ("../lib/a", "/usr/a", "usr//a", "usr/./a", "usr/a\nfoo", "usr/$(id)", "usr/a\\b"):
            with self.assertRaises(ValueError):
                safe_path(value)

    def test_only_same_batch_dependency_revision_changes(self):
        check_dependency_tokens("libcrypto3=3.5.9-r0 so:libc.musl-aarch64.so.1", "libcrypto3=3.5.9-r100 so:libc.musl-aarch64.so.1")
        with self.assertRaises(ValueError):
            check_dependency_tokens("so:libc.musl-aarch64.so.1", "so:libc.musl-aarch64.so.1 new-runtime")

    def test_payload_permissions_links_and_file_set_preserved(self):
        old = [{"path": "usr/lib/a.so", "type": "file", "uid": 0, "gid": 0, "mode": 493, "sha256": "a", "elf": None}]
        compare_payload(old, copy.deepcopy(old), "libxml2")
        for candidate in ([], [{**old[0], "mode": 511}], [{**old[0], "uid": 1000}], [{**old[0], "type": "symlink", "target": "x"}]):
            with self.assertRaises(ValueError):
                compare_payload(old, candidate, "libxml2")

    def test_removed_exports_or_new_needed_refused(self):
        base = {"path": "usr/lib/a.so", "type": "file", "uid": 0, "gid": 0, "mode": 493,
                "elf": {"soname": ["libxml2.so.2"], "needed": ["libc.musl-aarch64.so.1"], "interpreter": [], "exports": ["old@@VERSION"]}}
        for field, value in (("exports", []), ("needed", ["new.so"]), ("soname", ["libxml2.so.16"])):
            changed = copy.deepcopy(base)
            changed["elf"][field] = value
            with self.assertRaises(ValueError):
                compare_payload([base], [changed], "libxml2")


if __name__ == "__main__":
    unittest.main()
