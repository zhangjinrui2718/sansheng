#!/usr/bin/env python3
"""Wave 2d 变异自检 —— 词汇表扩容的四条判据各改坏一次,必须实测变红。

纪律(AGENTS.md「三类静默失败」):
  - 变异必须**真的改写语句**(删一行、改正则),不是加个注释;
  - `str.replace` 不匹配时**静默不执行** ⇒ 每一步都断言「改后与改前不同」;
  - 复原后断言**与原文逐字相同**(不用 `git checkout --`:未入库的新文件它会直接报错)。
"""
import io
import subprocess
import sys

TEST = "tests/web/annotation-budget.test.ts"
# ⚠️ 2026-10-26:第一条跑 M5 时发现**这个 runner 只跑一个文件** ⇒ M5 的判据在
# `deliverable-render.test.ts` 里,压根没被执行 ⇒ 「改坏了却是绿的」。
# ⇒ runner 必须覆盖**本波所有判据所在的文件**(变异脚本自己也会犯「仪器只看一处」的错)。
TEST_FILES = ["tests/web/annotation-budget.test.ts", "tests/web/deliverable-render.test.ts"]
GLOSSARY = "web/src/lib/glossary.ts"

CASES = [
    (
        "M1 删掉一个 `?` ⇒ 那条词汇表条目变成没人用",
        "web/src/routes/Works.tsx",
        '            <Help id="work.artifacts" />\n',
        "",
    ),
    (
        "M2 扫描器只认 `helpId=`(看不见 `<Help id=`)⇒ 11 条被判成孤儿",
        TEST,
        'f.src.matchAll(/helpId="([^"]+)"|<Help id="([^"]+)"/g)',
        'f.src.matchAll(/helpId="([^"]+)"/g)',
    ),
    (
        "M3 词汇表里多一条没有读者的条目",
        GLOSSARY,
        '  "member.runtime": {',
        '  "zzz.no-reader": {\n'
        '    line: "没有读者的条目",\n'
        '    basis: "变异用",\n'
        '    source: "变异用",\n'
        '  },\n'
        '  "member.runtime": {',
    ),
    (
        "M4 一条条目的判据落点被清空",
        GLOSSARY,
        '    basis: "transport/views.ts 的 memberActivity 视图(忙闩与工作项两路合读)",',
        '    basis: "",',
    ),
    (
        "M5 真读一次 `artifact.body` ⇒ 「正文走现读」那条必须变红(仪器没被掏空)",
        "web/src/routes/Works.tsx",
        "export function WorksPage(",
        "const __mut = (artifact: ArtifactView) => artifact.body;\nexport function WorksPage(",
    ),
]


def run_tests() -> int:
    p = subprocess.run(
        ["npx", "vitest", "run", *TEST_FILES],
        capture_output=True,
        text=True,
    )
    return p.returncode


def main() -> int:
    base = run_tests()
    if base != 0:
        print("基线就是红的 —— 先修好再谈变异")
        return 1
    print("基线:绿")

    failed = 0
    for name, path, old, new in CASES:
        src = io.open(path, encoding="utf-8").read()
        if old not in src:
            print(f"✗ {name}:变异点找不到 —— {path} 里没有 {old[:48]!r}")
            failed += 1
            continue
        mutated = src.replace(old, new, 1)
        assert mutated != src, f"变异没有改动任何字节:{path}"
        io.open(path, "w", encoding="utf-8").write(mutated)
        try:
            code = run_tests()
        finally:
            io.open(path, "w", encoding="utf-8").write(src)
        back = io.open(path, encoding="utf-8").read()
        assert back == src, f"复原失败:{path}"
        if code == 0:
            print(f"✗ {name}:改坏了却是绿的(该断言没生效)")
            failed += 1
        else:
            print(f"✓ {name}:如期变红")

    tail = run_tests()
    print("复原后:", "绿" if tail == 0 else "红")
    return 1 if failed or tail != 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
