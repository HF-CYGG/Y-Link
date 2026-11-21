# 离线候选构建输入

本目录不保存下载脚本或未认证归档。执行候选stage前，由负责人把已认证原字节材料化到以下两个独占子目录；缺文件或SHA不匹配即停止。认证大归档保存在隔离证据目录，不随源码提交；只有README不代表输入已就绪。

- `gcc/`：固定3个GCC源码归档；`debs/`内014的119个原编号DEB；`reference/`内固定17个原版本参考DEB。来源及SHA由`gcc-offline-build-inputs.json`逐项绑定；`builder-debs/`另存032真实APT选中且033已逐SHA持久保存的55个构建工具DEB（75,128,872B），保留原文件名，不混入原119编号集合。
- `node/`：固定`node-v22.23.5.tar.xz`及复用039认证的`openssl-3.5.9.tar.gz`；`debs/`内两个已认证生成工具DEB，按`node-offline-build-inputs.json`核验。后者只在每个独占生成scratch补齐Node发布归档裁掉的doc/test输入（3078文件、96,034,620B、聚合SHA固定）；不覆盖Node已有路径、不加demos、不改变Configure参数或执行原suite。ICU数据来自同一签名Node源码归档，不重下载。

这些目录仅由候选stage消费，普通runtime无依赖；GCC/Node原生RUN使用断网，APT仅`--no-download`与自有canonical缓存，不自动更新索引或补依赖。各快照的实际编译、产包、安装和未验证项以对应原始回执为准，候选产包不等于安全测试或发行验收。原有npm安全工具准备沿已验证路径，不能覆盖为Node随附旧npm；它的既有获取行为不属于新离线APT入口。

正式GCC准备入口先验全部输入，再以原119恢复88→207、独立55恢复207→262；每步都核精确包集/版本，拒绝任何既有包重装、升级、降级或删除。新增工具仅在builder；原3个运行交付包及17个同源完整包集合不变。正式编译前以amd64、nobiarch和二进制any构建语义执行原生dpkg-checkbuilddeps，缺项即停；不得加-d、改Depends或缩减语言来放行。035已验证两阶段实际安装及依赖门；旧036/047失败保留，057在同批原17包上完成真实独立ABI检查与可重放文档包装后通过完整包门，未重复编译。该候选仍不具备原生安全测试及正式发行资格。

Node候选独占相同原始基座，只通过`--node-builder-only`恢复原119个工具至207，再消费同次GCC的完整17包和两个生成工具。禁止继承GCC源码builder的262状态或其build tree；新增55中的gnat-12、lib32gcc-s1、libgnat-12、libgphobos3、libgphobos-12-dev仍精确依赖原gcc-12-base，不能与候选版本混装。三份Dockerfile和QA均遵守此图，不改包Depends或扩大交付集合。

Node构建层另消费已认证、同版本的`reference/libgcc-s1_12.2.0-14+deb12u1_amd64.deb`：仅从其真实载荷补齐slim基座缺失的`/usr/share/lintian/overrides/libgcc-s1`，不重装或改变原88包版本。原119及候选17包的本次APT调用仅显式include四个已核实lintian文件（cpp-12/g++-12/gcc-12/libgcc-s1），其余完整载荷门和原doc/man/info缺省保留；不改全局dpkg配置、宿主或普通runtime。

官方OpenSSL生成器硬编码调用`gcc`，而固定工具集合仅安装`gcc-12`。生产生成入口在独占generation scratch建立`compiler-bin/gcc`链接，只给该生成子进程的PATH使用；不修改`/usr/bin`或宿主工具。链接真实目标及SHA必须对应已安装同批17包的C编译器，执行原GAS探针并严格核对2.40、真实`/dev/null`及退出状态，manifest保存绑定与原始输出；官方生成器、Configure参数、版本门及原测试边界均保留。

GCC本批为明确的native-only构建：C/C++/Fortran与quadmath保留，关闭biarch。仅gcc-12/g++-12构建包允许原Suggests首项对应multilib建议被原Debian生成链省略，manifest记录完整原值/候选值及配置证据；其余字段、所有运行包、载荷和依赖门保持严格，不宣称保留原multilib构建能力。
