"""仅构建两个固定同版本源包；临时签名只认证本次精确输出，不扩展运行时信任。"""
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import stat
import tarfile
import urllib.request
from contextlib import contextmanager
from contract import ASSETS, BASE_VERSIONS, VERSIONS, MACHINES, require, sha, run, records, targets, safe_path, payload, compare_payload, check_dependency_tokens, serialize_candidate_contract

WORK = pathlib.Path("/work/ylink-alpine-native")
OUT = pathlib.Path("/out/ylink-alpine-security")
BASE = pathlib.Path("/tmp/ylink-alpine-baseline")


def keyring_snapshot(directory):
    require(directory.is_dir() and not directory.is_symlink() and directory.resolve() == directory, '构建验签目录必须是物理目录')
    result = {}
    for file in directory.iterdir():
        value = file.lstat()
        require(stat.S_ISREG(value.st_mode), '原官方keyring只接受普通文件')
        result[file.name] = (sha(file), value.st_mode & 0o7777, value.st_uid, value.st_gid)
    return result


@contextmanager
def temporary_build_key(public, directory=pathlib.Path('/etc/apk/keys')):
    # 仅自有隔离builder临时信任本次公钥；abuild自己的apk index也必须真实验签。
    original = keyring_snapshot(directory)
    value = public.lstat()
    require(stat.S_ISREG(value.st_mode) and public.resolve() == public, '本次公钥必须是物理普通文件')
    require(public.name == 'ylink-alpine-batch.rsa.pub', '未知构建签名key basename')
    target = directory / public.name
    contents = public.read_bytes()
    stream = target.open('xb')
    created = os.fstat(stream.fileno())
    complete = False
    try:
        with stream:
            stream.write(contents)
        os.chmod(target, 0o644)
        complete = True
        yield
    finally:
        stream.close()
        current = target.lstat()
        require(stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino, current.st_uid, current.st_gid) == (created.st_dev, created.st_ino, created.st_uid, created.st_gid), '本次构建公钥身份漂移，拒绝删除未知文件')
        actual = target.read_bytes()
        require(actual == contents if complete else contents.startswith(actual), '本次构建公钥字节漂移，拒绝删除未知文件')
        if complete:
            require(current.st_mode & 0o7777 == 0o644, '本次构建公钥权限漂移')
        target.unlink()
        require(keyring_snapshot(directory) == original, '构建前后官方keyring必须逐字节及元数据不变')


def prepare_work(pins):
    # 只允许预置固定归档的空白构建根；任何上次构建残留都不能当作有效输入。
    expected = {source['name'] for pin in pins['packages'].values() for source in pin['upstreamInputs']
                if source['name'].endswith(('.tar.gz', '.tar.xz'))}
    require(not OUT.exists(), '输出目录已有状态，禁止重用')
    require(WORK.resolve() == WORK and not WORK.is_symlink(), '构建目录必须是固定物理路径')
    if WORK.exists():
        require(WORK.is_dir() and {file.name for file in WORK.iterdir()} == {'distfiles'}, '只允许预置distfiles，不复用build tree')
        cache = WORK / 'distfiles'
        require(cache.is_dir() and not cache.is_symlink(), '归档缓存必须是真实目录')
        require({file.name for file in cache.iterdir()} <= expected, '归档缓存存在未知输入')
        require(all(stat.S_ISREG(file.lstat().st_mode) for file in cache.iterdir()), '归档缓存只接受普通文件')
        for pin in pins['packages'].values():
            for source in pin['upstreamInputs']:
                if source['name'] in expected and (cache / source['name']).exists():
                    upstream_archive(source)
    else:
        WORK.mkdir(parents=True)
        (WORK / 'distfiles').mkdir()


def upstream_archive(source):
    name = source['name']
    require(pathlib.PurePosixPath(name).name == name and safe_path(name) == name, '归档名不能越界')
    dest = WORK / 'distfiles' / name
    require(dest.parent.is_dir() and not dest.parent.is_symlink() and dest.parent.resolve() == WORK / 'distfiles', '缓存目录必须是固定物理路径')
    if dest.exists() or dest.is_symlink():
        require(stat.S_ISREG(dest.lstat().st_mode), '已有归档必须是普通文件，不能使用符号链接')
    else:
        with urllib.request.urlopen(source['url'], timeout=120) as response, dest.open('xb') as stream:
            shutil.copyfileobj(response, stream, length=1024 * 1024)
    # 既有坏缓存直接拒绝；不覆盖、不改URL重取、不放宽任一固定摘要。
    require(dest.stat().st_size == source['bytes'] and sha(dest) == source['sha256'], '官方归档长度/SHA256不符')
    require(hashlib.sha512(dest.read_bytes()).hexdigest() == source['sha512'], '官方APKBUILD归档SHA512不符')
    return dest


def materialize_baseline():
    directory = WORK / "baseline"
    directory.mkdir()
    with tarfile.open(BASE / "payload.tar") as archive:
        for member in archive:
            name = safe_path(member.name.removeprefix("./"))
            require(member.isfile() or member.issym(), "基线只应有包文件")
            target = directory / name
            original = pathlib.Path("/mnt/ylink-alpine-original") / name
            actual = original.lstat()
            require((actual.st_uid, actual.st_gid, actual.st_mode & 0o7777) == (member.uid, member.gid, member.mode), "只读原基座元数据与snapshot不符")
            require(not os.listxattr(original, follow_symlinks=False), "原目标含未建模ACL/capability/xattr，停止而不丢弃")
            target.parent.mkdir(parents=True, exist_ok=True)
            require(not target.exists() and not target.is_symlink(), "基线重复文件")
            if member.issym():
                require(original.is_symlink() and os.readlink(original) == member.linkname, "原链接漂移")
                require(not pathlib.PurePosixPath(member.linkname).is_absolute(), "未知绝对基线链接")
                os.symlink(member.linkname, target)
                os.chown(target, member.uid, member.gid, follow_symlinks=False)
            else:
                require(not original.is_symlink() and original.is_file(), "原文件类型漂移")
                target.write_bytes(archive.extractfile(member).read())
                require(sha(original) == sha(target), "原完整文件与snapshot不符")
                os.chmod(target, member.mode)
                os.chown(target, member.uid, member.gid)
    return directory


def append_patch_sources(text, additions):
    # OpenSSL的subpackages与source有相同结尾；只在唯一source赋值内追加。
    require(len(re.findall(r'(?m)^source=', text)) == 1, '官方source赋值必须唯一')
    matches = list(re.finditer(r'(?m)^source="[^\"]*\n\t"\n', text))
    require(len(matches) == 1, '官方source字段布局漂移')
    require(additions and all(re.fullmatch(r'\t[A-Za-z0-9_.+-]+', name) for name in additions), '补丁source名不能越界')
    match = matches[0]
    replacement = match[0][:-3] + '\n'.join(additions) + '\n\t"\n'
    return text[:match.start()] + replacement + text[match.end():]


def recipe(component, pin):
    directory = WORK / "aports" / "main" / component
    directory.mkdir(parents=True)
    original = ASSETS / pin["recipe"]
    require(sha(original) == pin["recipeSha256"], "官方APKBUILD身份不符")
    text = original.read_text()
    require(text.count("pkgrel=" + str(pin["baseRevision"]) + "\n") == 1, "未知原修订")
    text = text.replace("pkgrel=" + str(pin["baseRevision"]) + "\n", "pkgrel=100\n", 1)
    for source in pin["upstreamInputs"]:
        name = source["name"]
        if name.endswith((".tar.gz", ".tar.xz")):
            upstream_archive(source)
        else:
            file = ASSETS / "vendor" / component / name
            expected = pin.get("contextOnlyBasePatch", {}) if name == "CVE-2026-6732.patch" else source
            require(sha(file) == expected["sha256"], "官方本地输入或已准许context适配不符")
            shutil.copyfile(file, directory / name)
    if component == "libxml2":
        change = pin["contextOnlyBasePatch"]
        old = next(s for s in pin["upstreamInputs"] if s["name"] == "CVE-2026-6732.patch")["sha512"]
        require(text.count(old) == 1, "旧校验值不唯一")
        text = text.replace(old, change["sha512"])
    additions, checksums = [], []
    for patch in pin["patches"]:
        file = ASSETS / patch["file"]
        require(sha(file) == patch["sha256"] and hashlib.sha512(file.read_bytes()).hexdigest() == patch["sha512"], "回迁补丁hash不符")
        if "upstreamFile" in patch:
            require(sha(ASSETS / patch["upstreamFile"]) == patch["upstreamSha256"], "官方补丁原件身份不符")
        shutil.copyfile(file, directory / file.name)
        additions.append("\t" + file.name)
        checksums.append(patch["sha512"] + "  " + file.name)
    text = append_patch_sources(text, additions)
    match = re.search(r'sha512sums="\n(.*?)\n"\s*$', text, re.S)
    require(match is not None, "官方校验字段漂移")
    text = text[:match.start()] + 'sha512sums="\n' + match[1] + "\n" + "\n".join(checksums) + '\n"\n'
    require(text.count("build() {") == 1, "官方build函数不唯一")
    text = text.replace("build() {", "_ylink_official_build() {", 1)
    text += '\n# 所有patch严格应用；保留官方prepare/build/check及功能配置。\npatch_args="--batch --forward --fuzz=0 -p1"\n'
    text += 'build() {\n python3 ' + str(ASSETS / "contract.py") + ' --prepared ' + component + ' "$builddir"\n _ylink_official_build\n}\n'
    # 仅显式候选recipe使用abuild原生!check选项；原check()函数/测试完全保留。
    text += '\noptions="$options !check"\n'
    (directory / "APKBUILD").write_text(text)
    return directory, sha(directory / "APKBUILD")


def write_table(file, rows):
    with file.open("x") as stream:
        for item in rows:
            stream.write("\t".join([item["path"], item["type"], format(item["mode"], "o"), str(item["uid"]), str(item["gid"]), item.get("target", item.get("sha256", ""))]) + "\n")


def finalize(arch, pins, db, selected, old_all, generated, abuild, public, replay_evidence=None):
    """正常构建与保全原件重验共用同一完整身份/载荷/ABI及候选门。"""
    files = []
    for name in selected:
        matches = list((WORK / "packages").glob("*/" + arch + "/" + name + "-" + VERSIONS[name] + ".apk"))
        require(len(matches) == 1, "目标APK不唯一：" + name)
        dest = OUT / matches[0].name
        shutil.copyfile(matches[0], dest)
        files.append(dest)
    run(["apk", "--keys-dir", OUT / "keys", "verify", *files])
    index = WORK / "APKINDEX.tar.gz"
    run(["apk", "--keys-dir", OUT / "keys", "index", "--output", index, *files])
    with tarfile.open(index) as archive:
        meta = records(archive.extractfile("APKINDEX").read().decode())
    require(sorted(meta) == sorted(selected), "APK实际元数据含未知包")
    entries, after_all = [], []
    for name, file in zip(selected, files):
        info = meta[name]
        require(info.get("V") == VERSIONS[name] and info.get("A") == arch and info.get("o") == db[name]["o"], "APK实际身份不符")
        for field in ("D", "p"):
            check_dependency_tokens(db[name].get(field, ""), info.get(field, ""))
        directory = WORK / ("payload-" + name)
        directory.mkdir()
        run(["apk", "--keys-dir", OUT / "keys", "extract", "--destination", directory, file])
        new = payload(directory, arch)
        old = [r for r in old_all if r["path"] in db[name]["files"]]
        require(len(old) == len(db[name]["files"]), "原包实际文件缺失")
        compare_payload(old, new, name)
        after_all.extend(new)
        entries.append({"name": name, "version": VERSIONS[name], "arch": arch, "origin": info["o"],
                        "file": file.name, "sha256": sha(file), "metadata": info, "payload": new})
    manifest = {"schema": 1, "identity": "Y-Link同版本安全派生包（非Alpine官方发行）", "arch": arch,
                "sourcePinsSha256": sha(ASSETS / "source-pins.json"), "recipes": generated,
                "publicKeySha256": sha(public), "baselineDatabaseSha256": sha(BASE / "installed"),
                "packages": entries, "sourceTargets": {n: p["targets"] for n, p in pins["packages"].items()},
                "candidateOnly": True, "approvedForRelease": False, "securityVerificationBlocked": True,
                "upstreamTestsPreserved": True, "upstreamSuiteScopeStatus": "not-established",
                "nativeTests": {"executed": False, "reason": "explicit-candidate-only-abuild-options-nocheck"},
                "abuildExecutableSha256": sha(abuild)}
    if replay_evidence is not None:
        require(type(replay_evidence) is dict and replay_evidence.get("component") == "openssl" and replay_evidence.get("productionExecuted") is False, "重用编译证据必须明确来源且不能冒称新编译")
        manifest["reusedCompilation"] = replay_evidence
    raw_manifest, policy = serialize_candidate_contract(manifest)
    (OUT / "manifest.json").write_bytes(raw_manifest)
    (OUT / "candidate-policy.txt").write_bytes(policy)
    (OUT / "database.sha256").write_text(sha(BASE / "installed") + "  /lib/apk/db/installed\n")
    shutil.copyfile(BASE / "system-keys.sha256", OUT / "system-keys.sha256")
    write_table(OUT / "before.tsv", old_all)
    write_table(OUT / "after.tsv", after_all)
    for label, versions in (("before", {n: v["V"] for n, v in db.items()}), ("after", {n: VERSIONS.get(n, v["V"]) if n in selected else v["V"] for n, v in db.items()})):
        (OUT / (label + "-packages.tsv")).write_text("".join(n + "\t" + versions[n] + "\n" for n in sorted(versions)))
    (OUT / "targets").write_text("".join(n + "\n" for n in sorted(selected)))
    (OUT / "arch").write_text(arch + "\n")
    shutil.copyfile(ASSETS / "install.sh", OUT / "install.sh")
    shutil.copyfile(ASSETS / "verify-candidate-policy.sh", OUT / "verify-candidate-policy.sh")
    shutil.copyfile(ASSETS / "source-pins.json", OUT / "source-pins.json")
    checkfiles = sorted(p for p in OUT.rglob("*") if p.is_file())
    (OUT / "artifacts.sha256").write_text("".join(sha(p) + "  " + p.relative_to(OUT).as_posix() + "\n" for p in checkfiles))


def build(candidate_only=False):
    require(candidate_only is True, '未验收原生候选必须显式--candidate-only；默认不执行原suite')
    abuild = pathlib.Path(shutil.which('abuild') or '/missing-abuild')
    abuild_text = abuild.read_text()
    require(re.search(r'(?m)^want_check\(\)\s*\{[\s\S]*?options_has [\'\"]!check[\'\"] && return 1', abuild_text) is not None, '当前原生abuild未证明支持!check，停止而不调用未知suite')
    require(os.getuid() == 0 and pathlib.Path("/etc/alpine-release").read_text().startswith("3.24."), "只允许原生Alpine3.24构建层")
    arch = (BASE / "arch").read_text().strip()
    require(run(["apk", "--print-arch"]).strip() == arch and arch in MACHINES, "禁止交叉/未知架构配置")
    pins = json.loads((ASSETS / "source-pins.json").read_text())
    prepare_work(pins)
    OUT.mkdir(parents=True)
    (OUT / "keys").mkdir()
    require(pins["localRevision"] == 100 and pins["branch"] == "3.24", "未知固定方案")
    db = records((BASE / "installed").read_text())
    require(sha(BASE / "installed") == sha("/mnt/ylink-alpine-original/lib/apk/db/installed"), "原基座包库必须逐字匹配只读阶段")
    selected = targets(db, arch)
    baseline = materialize_baseline()
    old_all = payload(baseline, arch)
    key = WORK / "batch.rsa"
    public = OUT / "keys" / "ylink-alpine-batch.rsa.pub"
    run(["openssl", "genrsa", "-out", key, "4096"])
    os.chmod(key, 0o600)
    try:
        run(["openssl", "rsa", "-in", key, "-pubout", "-out", public])
        env = {**os.environ, "PACKAGER_PRIVKEY": str(key), "PACKAGER_PUBKEY": str(public),
               "REPODEST": str(WORK / "packages"), "SRCDEST": str(WORK / "distfiles"),
               "SOURCE_DATE_EPOCH": str(pins["sourceDateEpoch"]), "CBUILD": run(["gcc", "-dumpmachine"]).strip(),
               "CHOST": run(["gcc", "-dumpmachine"]).strip()}
        # 显式候选仅通过recipe原生!check；-K只保留临时文件，不能用来声称禁测。
        for name in ("ABUILD_BOOTSTRAP", "BOOTSTRAP", "CROSS_COMPILE", "CBUILDROOT", "USE_CCACHE"):
            env.pop(name, None)
        generated = {}
        with temporary_build_key(public):
            for component in ("openssl", "libxml2"):
                directory, digest = recipe(component, pins["packages"][component])
                generated[component] = digest
                run(["abuild", "-F", "-r"], cwd=directory, env=env)
        finalize(arch, pins, db, selected, old_all, generated, abuild, public)
    finally:
        key.unlink(missing_ok=True)


if __name__ == "__main__":
    import sys
    require(sys.argv[1:] == ['--candidate-only'], '仅显式候选入口；不接受任意路径/包参数')
    build(candidate_only=True)
