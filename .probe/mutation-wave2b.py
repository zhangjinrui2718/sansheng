#!/usr/bin/env python3
"""Wave 2b 变异自检 —— 四条新判据各改坏一次,必须实测变红。

纪律(AGENTS.md「三类静默失败」):
  - 变异必须**真的改写语句**,不是加个注释;
  - `str.replace` 不匹配时**静默不执行** ⇒ 每一步都断言「改后与改前不同」;
  - 复原后断言**与原文逐字相同**(不用 `git checkout --`:未入库的新文件它会直接报错)。
"""
import io
import subprocess
import sys

WEB = "web/src"
CASES = [
    (
        "⑧ 屏上裸 **",
        f"{WEB}/routes/About.tsx",
        "下面是这块界面现在说不到的地方",
        "下面是这块界面**现在**说不到的地方",
    ),
    (
        "⑥ hint 预算(Works 第 3 条 hint)",
        f"{WEB}/routes/Works.tsx",
        '      helpId="artifact.no-work"',
        '      hint="第 3 条"\n      helpId="artifact.no-work"',
    ),
    (
        "⑦ hint 长度",
        f"{WEB}/routes/About.tsx",
        'hint="说明书,不是设置"',
        'hint="这一页是这块界面的说明书,它要回答的是四态到底什么意思,而不是设置面板,所以别把它当设置用"',
    ),
    (
        "⑨ 长悬停只许减不许增",
        f"{WEB}/routes/About.tsx",
        '        title="关于"',
        '        title="关于这一页:它是这块界面的说明书,回答四态含义与词汇表,而不是设置面板,所以别把它当设置用"',
    ),
]

CMD = [sys.executable, "-m", "pytest"]  # 占位,见下方 run()


def run_tests() -> int:
    p = subprocess.run(
        ["npx", "vitest", "run", "tests/web/annotation-budget.test.ts"],
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
            print(f"✗ {name}:变异点找不到 —— {path} 里没有 {old[:40]!r}")
            failed += 1
            continue
        mutated = src.replace(old, new, 1)
        assert mutated != src, "变异没有改动任何字节"
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
