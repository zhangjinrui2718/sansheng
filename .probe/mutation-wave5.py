#!/usr/bin/env python3
"""Wave 5 变异自检 —— 「红壳只有一处 + 四态只有一处」这两条 ratchet 各改坏一次,必须实测变红。

纪律(AGENTS.md「三类静默失败」第三节 + 2026-10-26 的两条补充):
  - 变异必须**真的改写语句**(删一行、改条件、换字面量),不是加个注释 ——
    「在语句前面加个注释」不会让语句失效,那样「改坏了却全绿」是假的;
  - `str.replace` 不匹配时**静默不执行** ⇒ 每一步都断言「改后与改前不同」;
  - 复原后断言**与原文逐字相同**(不用 `git checkout --`:未入库的新文件它会直接报错);
  - runner 覆盖**本波所有判据所在的文件**;
  - ⚠️ **「变红」不等于「判据有效」** —— 变红可能是**语法错**或**编译错**
    ⇒ 本脚本额外判「红的原因」:输出里出现 `Transform failed` / `Failed Suites`
    ⇒ 这条变异**不算数**。
  - ⚠️ **仪器自己有正样本自检** —— 所以「让扫描器认不出已知样本」也是一条变异
    (M3/M4),它必须让**正样本自检**那条断言变红,而不是让判据绿。
"""
import io
import subprocess
import sys

TEST_FILES = ["tests/web/data-state.test.ts", "tests/web/c10-dead-code.test.ts"]
PRIMITIVES = "web/src/components/ui/primitives.tsx"
WORKS = "web/src/routes/Works.tsx"
MEMORY = "web/src/routes/Memory.tsx"
CONVERSATIONS = "web/src/components/members/AgentConversations.tsx"
TEST_FILE = "tests/web/data-state.test.ts"

CASES = [
    (
        "M1 手写一处红壳(把 RedNote 换回 div + 朱色)⇒ 红壳又有了第二处定义",
        WORKS,
        [
            (
                '      <RedNote data-content-runtime="unavailable">',
                '      <div className="ss-note" style={{ color: "var(--cinnabar)" }} data-content-runtime="unavailable">',
            ),
            (
                "        读不到这份正文 —— {data.problem ?? \"原因未说明\"}。\n"
                "        (这不是「这条工件没有正文」,是这一次读不到。落点:{data.path})\n"
                "      </RedNote>",
                "        读不到这份正文 —— {data.problem ?? \"原因未说明\"}。\n"
                "        (这不是「这条工件没有正文」,是这一次读不到。落点:{data.path})\n"
                "      </div>",
            ),
        ],
    ),
    (
        "M2 朱色字面量不止一处(primitives 里再写一个)⇒ 色值外溢",
        PRIMITIVES,
        [('const RED = "var(--cinnabar)";', 'const RED = "var(--cinnabar)";\nconst RED2 = "var(--cinnabar)";')],
    ),
    (
        "M3 扫描器认不出已知样本(永远跳过)⇒ 正样本自检必须红",
        TEST_FILE,
        [('      if (!props.includes("var(--cinnabar")) continue;', "      if (true) continue;")],
    ),
    (
        "M4 条件色不再豁免(红/灰二选一也当红壳)⇒ 正样本自检必须红",
        TEST_FILE,
        [('      if (/\\?[^?]*var\\(--cinnabar/.test(props)) continue;', "      // 豁免去掉")],
    ),
    (
        "M5 少一个原语有读者(RedEmpty 的唯一用法换回普通 div)⇒ \"每个原语都要有读者\" 必须红",
        "web/src/components/ui/DataState.tsx",
        [(
            '  return <RedEmpty title={title}>{message}</RedEmpty>;',
            '  return <div className="ss-empty">{message}</div>;',
        )],
    ),
    (
        "M6 四态字面量写到外面去了(自己在 Memory.tsx 里写一个 kind: \"ready\")",
        MEMORY,
        [(
            'import { DataState, ReadError, remoteListOf, remoteOf } from "@/components/ui/DataState";',
            'import { DataState, ReadError, remoteListOf, remoteOf } from "@/components/ui/DataState";\n'
            "const __stateProbe = { kind: \"ready\" as const };",
        )],
    ),
    (
        "M7 四态的判据不再只有一处(自己写一遍 remoteListOf 的等价物)",
        CONVERSATIONS,
        [(
            "  const convState = remoteListOf(lines, loading, error);",
            "  const convState =\n"
            "    error !== null\n"
            "      ? { kind: \"error\" as const, error }\n"
            "      : loading\n"
            "        ? { kind: \"loading\" as const }\n"
            "        : { kind: \"ready\" as const, data: lines };",
        )],
    ),
]


def run_tests() -> tuple[int, str]:
    p = subprocess.run(
        ["npx", "vitest", "run", *TEST_FILES],
        capture_output=True,
        text=True,
    )
    return p.returncode, p.stdout + p.stderr


def red_for_the_right_reason(output: str) -> bool:
    """红在**断言**上(测试跑到并断言失败),而不是红在语法/编译/模块加载上。"""
    if "Transform failed" in output or "Failed Suites" in output:
        return False
    return "AssertionError" in output or "expected" in output


def main() -> int:
    code, out = run_tests()
    if code != 0:
        print("基线就是红的 —— 先修好再谈变异")
        print(out[-3000:])
        return 1
    print("基线:绿")

    failed = 0
    for name, path, edits in CASES:
        src = io.open(path, encoding="utf-8").read()
        mutated = src
        broken = False
        for old, new in edits:
            if old not in mutated:
                print(f"✗ {name}:变异点找不到 —— {path} 里没有 {old[:48]!r}")
                failed += 1
                broken = True
                break
            before = mutated
            mutated = mutated.replace(old, new, 1)
            assert mutated != before, f"变异没有改动任何字节:{path}"
        if broken:
            continue
        io.open(path, "w", encoding="utf-8").write(mutated)
        try:
            code, out = run_tests()
        finally:
            io.open(path, "w", encoding="utf-8").write(src)
        back = io.open(path, encoding="utf-8").read()
        assert back == src, f"复原失败:{path}"
        if code == 0:
            print(f"✗ {name}:改坏了却是绿的(该断言没生效)")
            failed += 1
        elif not red_for_the_right_reason(out):
            print(f"✗ {name}:红了,但红的原因不对(语法/编译错,断言根本没被问到)")
            failed += 1
        else:
            print(f"✓ {name}:如期变红(且红在断言上)")

    code, _ = run_tests()
    print("复原后:", "绿" if code == 0 else "红")
    return 1 if failed or code != 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
