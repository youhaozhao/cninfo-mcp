#!/usr/bin/env python3
"""校验当前解释器是否满足 requirements.txt 的全部约束。

退出码 0 表示全部满足,调用方可以跳过 pip 安装;非 0 表示需要执行
`pip install -r requirements.txt`。

这个脚本只是一个优化——用来省掉一次很慢的 pip 调用,pip 自身才是约束的
最终权威。因此所有无法确定的情况(依赖缺失、版本不符、约束解析失败、
连比较版本号的库都找不到)一律返回非 0,让 pip 去做真正的判断。宁可多跑
一次 pip,也不能放行一个不满足约束的环境。
"""

import os
import sys
from importlib.metadata import PackageNotFoundError, version

REQUIREMENTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements.txt")


def _load_requirement_parser():
    """返回 packaging 的 Requirement 类,找不到时返回 None。

    packaging 不是本项目的直接依赖,全新 venv 里通常不存在,因此回退到 pip
    自带的 vendored 副本。部分发行版(如 Debian)会去除 vendoring,那时两者
    都不可用,由调用方按“未满足”处理。
    """
    try:
        from packaging.requirements import Requirement

        return Requirement
    except ImportError:
        pass
    try:
        from pip._vendor.packaging.requirements import Requirement

        return Requirement
    except ImportError:
        return None


def unsatisfied(requirements_path=None):
    """返回未满足的约束列表;无法判断时抛出异常由调用方兜底。"""
    # 默认值在调用时解析,而不是在 def 时绑定,便于测试替换 REQUIREMENTS
    if requirements_path is None:
        requirements_path = REQUIREMENTS

    Requirement = _load_requirement_parser()
    if Requirement is None:
        raise RuntimeError("packaging is unavailable; cannot verify requirements")

    missing = []
    with open(requirements_path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip()
            # 跳过空行,以及 -r/-e/--index-url 这类非约束指令
            if not line or line.startswith("-"):
                continue

            req = Requirement(line)
            try:
                installed = version(req.name)
            except PackageNotFoundError:
                missing.append(f"{req.name} (not installed)")
                continue

            # prereleases=True:已装的预发布版本若落在区间内也算满足,
            # 避免把 pip 已经接受的环境反复重装。
            if not req.specifier.contains(installed, prereleases=True):
                missing.append(f"{req.name} {installed} does not satisfy {req.specifier}")

    return missing


def main():
    try:
        missing = unsatisfied()
    except Exception as exc:  # 解析失败、文件缺失等一律按“需要安装”处理
        print(f"dependency check inconclusive: {exc}", file=sys.stderr)
        return 1

    if missing:
        for item in missing:
            print(f"dependency not satisfied: {item}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
