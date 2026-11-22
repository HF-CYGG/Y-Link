"""Alpine同版本原生包的固定契约；只供构建层与离线契约回归使用。"""
import hashlib
import json
import os
import pathlib
import re
import stat
import struct
import subprocess

ASSETS = pathlib.Path(__file__).resolve().parent
MANDATORY = ("libcrypto3", "libssl3", "libxml2")
OPTIONAL = ("openssl", "openssl-fips")
BASE_VERSIONS = {n: "3.5.9-r0" for n in MANDATORY + OPTIONAL}
BASE_VERSIONS["libxml2"] = "2.13.9-r2"
VERSIONS = {n: "3.5.9-r100" for n in MANDATORY + OPTIONAL}
VERSIONS["libxml2"] = "2.13.9-r100"
MACHINES = {"x86_64": 62, "aarch64": 183}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def run(args, **kwargs):
    print("[alpine-native]", json.dumps([str(a) for a in args]), flush=True)
    value = subprocess.run([str(a) for a in args], check=False, text=True,
                           stdout=subprocess.PIPE, stderr=None, **kwargs)
    print(value.stdout, end="", flush=True)
    value.check_returncode()
    return value.stdout


def safe_path(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_+.,/@=-]+", value), "包路径含未知字符")
    require(not value.startswith("/") and all(p not in ("", ".", "..") for p in value.split("/")), "包路径越界")
    return value


def records(text):
    result = {}
    for block in text.strip().split("\n\n"):
        data, files, directory = {}, [], None
        for line in block.splitlines():
            if len(line) < 2 or line[1] != ":":
                continue
            key, value = line[0], line[2:]
            if key == "F":
                directory = value
            elif key == "R":
                files.append((directory, value))
            elif key in ("P", "V", "A", "o", "D", "p"):
                require(key not in data, "APK身份字段重复")
                data[key] = value
        if "P" in data:
            require(data["P"] not in result, "APK包名重复")
            # 全包身份用于库存；仅本契约运行目标的文件会用于原载荷读取与比较。
            # 原基座其它包可能含合法Unicode文件名，不将其扩为目标路径许可。
            selected_files = []
            if data["P"] in MANDATORY + OPTIONAL:
                for directory, value in files:
                    require(directory is not None, "APK包库缺文件目录")
                    selected_files.append(safe_path(directory + "/" + value))
            data["files"] = sorted(selected_files)
            result[data["P"]] = data
    return result


def targets(db, arch):
    require(arch in MACHINES, "只支持原生amd64/arm64")
    require(all(n in db for n in MANDATORY), "原镜像缺必要运行包，禁止新增")
    selected = [n for n in MANDATORY + OPTIONAL if n in db]
    for name in selected:
        item = db[name]
        require(item.get("V") == BASE_VERSIONS[name], "原包修订漂移：" + name)
        require(item.get("A") == arch, "原包架构漂移")
        require(item.get("o") == ("libxml2" if name == "libxml2" else "openssl"), "原包source/origin漂移")
    return selected


def check_dependency_tokens(old, new):
    # 只允许同批已经存在的目标包精确版本随同升级；其它so/包依赖逐字不变。
    def normalize(text):
        return sorted(re.sub(r"^(libcrypto3|libssl3|libxml2|openssl|openssl-fips|openssl3)=[^ ]+$", r"\1=<same-batch>", token)
                      for token in text.split())
    require(normalize(old) == normalize(new), "运行依赖/提供者闭包改变")


def elf_info(file, arch):
    prefix = pathlib.Path(file).read_bytes()[:20]
    if not prefix.startswith(b"\x7fELF"):
        return None
    require(len(prefix) == 20 and prefix[4:6] == b"\x02\x01", "必须为64位小端ELF")
    require(struct.unpack("<H", prefix[18:20])[0] == MACHINES[arch], "实际ELF架构不符")
    dynamic = run(["readelf", "--dynamic", "--wide", file])
    symbols = run(["readelf", "--dyn-syms", "--wide", file])
    exports = []
    for line in symbols.splitlines():
        fields = line.split()
        if len(fields) >= 8 and fields[4] in ("GLOBAL", "WEAK", "UNIQUE") and fields[6] != "UND":
            exports.append(fields[7])
    headers = run(["readelf", "--program-headers", "--wide", file])
    return {"soname": re.findall(r"\(SONAME\).*\[([^]]+)\]", dynamic),
            "needed": sorted(re.findall(r"\(NEEDED\).*\[([^]]+)\]", dynamic)),
            "interpreter": re.findall(r"Requesting program interpreter: ([^]]+)", headers),
            "exports": sorted(set(exports))}


def payload(root, arch):
    root = pathlib.Path(root)
    result = []
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = pathlib.Path(folder) / name
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            relative = safe_path(path.relative_to(root).as_posix())
            require(stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode), "禁止特殊设备载荷")
            require(not os.listxattr(path, follow_symlinks=False), "不接受未建模的ACL/capability/xattr载荷")
            row = {"path": relative, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                require(not target.startswith("/") and re.fullmatch(r"[A-Za-z0-9_+.,/@=-]+", target), "未知符号链接")
                resolved = os.path.normpath(str(pathlib.PurePosixPath(relative).parent / target))
                require(resolved != ".." and not resolved.startswith("../"), "链接越界")
                row.update(type="symlink", target=target)
            else:
                row.update(type="file", sha256=sha(path), elf=elf_info(path, arch))
            result.append(row)
    return sorted(result, key=lambda row: row["path"])


def compare_payload(before, after, name):
    old = {row["path"]: row for row in before}
    new = {row["path"]: row for row in after}
    require(old.keys() == new.keys(), "完整载荷增删：" + name)
    for path, a in old.items():
        b = new[path]
        require(all(a.get(k) == b.get(k) for k in ("type", "mode", "uid", "gid", "target")), "载荷类型/权限/归属/链接改变：" + path)
        ea, eb = a.get("elf"), b.get("elf")
        require(bool(ea) == bool(eb), "ELF文件类型改变")
        if ea:
            require(all(ea[k] == eb[k] for k in ("soname", "needed", "interpreter")), "ELF ABI或运行依赖改变：" + path)
            require(set(ea["exports"]) <= set(eb["exports"]), "原导出/符号版本丢失：" + path)
            added = set(eb["exports"]) - set(ea["exports"])
            require(not added or (name == "libxml2" and added == {"xmlRelaxParserSetIncLImit@@LIBXML2_2.6.5"}), "未批准新增ELF导出")
        elif a["type"] == "file" and path != "etc/ssl/fipsmodule.cnf":
            require(a["sha256"] == b["sha256"], "原非ELF配置/数据内容改变：" + path)


def prepared(component, directory):
    pins = json.loads((ASSETS / "source-pins.json").read_text())
    require(component in ("libxml2", "openssl"), "未知源包")
    root = pathlib.Path(directory)
    actual = {}
    for name, expected in pins["packages"][component]["targets"].items():
        actual[name] = sha(root / safe_path(name))
        require(actual[name] == expected, "configure前源码hash不符：" + name)
    print(json.dumps({"verificationPoint": "before-official-build-configure", "component": component,
                      "sourcePinsSha256": sha(ASSETS / "source-pins.json"), "actual": actual}), flush=True)


if __name__ == "__main__":
    import sys
    require(len(sys.argv) == 4 and sys.argv[1] == "--prepared", "只接受固定源码门禁")
    prepared(sys.argv[2], sys.argv[3])
def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'manifest存在重复JSON键：' + key)
        result[key] = value
    return result


def candidate_policy(manifest_bytes):
    """从真实序列化manifest严格派生机器sidecar，不把字符串/数字当布尔。"""
    require(isinstance(manifest_bytes, bytes), 'manifest必须是原始bytes')
    def invalid_constant(value):
        raise ValueError('manifest禁止非JSON有限数值：' + value)
    value = json.loads(manifest_bytes.decode('utf-8'), object_pairs_hook=_unique_json_object, parse_constant=invalid_constant)
    require(type(value) is dict, 'manifest必须是对象')
    for key, expected in [('candidateOnly', True), ('approvedForRelease', False),
                          ('securityVerificationBlocked', True), ('upstreamTestsPreserved', True)]:
        require(type(value.get(key)) is bool and value[key] is expected, '候选状态缺失/错型/矛盾：' + key)
    require(value.get('upstreamSuiteScopeStatus') == 'not-established', '候选suite状态不符')
    tests = value.get('nativeTests')
    require(type(tests) is dict and set(tests) == {'executed', 'reason'}, '原生测试状态结构不符')
    require(type(tests['executed']) is bool and tests['executed'] is False, '未执行不能写成已通过')
    require(tests['reason'] == 'explicit-candidate-only-abuild-options-nocheck', '测试原因不符')
    lines = ['YLINK_ALPINE_CANDIDATE_V1', 'manifest_sha256=' + hashlib.sha256(manifest_bytes).hexdigest(),
             'candidate_only=true', 'approved_for_release=false', 'security_verification_blocked=true',
             'upstream_tests_preserved=true', 'upstream_suite_scope=not-established',
             'native_tests_executed=false', 'native_tests_reason=explicit-candidate-only-abuild-options-nocheck']
    return ('\n'.join(lines) + '\n').encode('ascii')


def serialize_candidate_contract(manifest):
    raw = (json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')
    return raw, candidate_policy(raw)

