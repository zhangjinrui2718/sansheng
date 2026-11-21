#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
变异自检:tests/web/chat-no-persona.test.ts(v5 Wave C 去角色化,2026-11-20)

纪律同 .probe/mutation-stream-cards.py:真改坏语句 + 断言改动生效 + 期望变红 +
内存原文复原且逐字一致。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "tests/web/chat-no-persona.test.ts"

MUTATIONS = [
    # M1:人格漏回接待页头(「接待 · 业务经理」复活)
    ("web/src/components/chat/ChatSurface.tsx",
     '{intakeActive ? "接待" : project ? project.name : "未选项目"}',
     '{intakeActive ? "接待 · 业务经理" : project ? project.name : "未选项目"}'),
    # M2:占位符漏回角色名
    ("web/src/components/chat/ChatSurface.tsx",
     "? \"说说你想做什么 —— 三生会和你对齐,谈拢后立项\"",
     "? \"说说你想做什么 —— 业务经理会和你对齐\""),
    # M3:工作记录悬停漏回
    ("web/src/components/chat/MessageList.tsx",
     'title="决定「不值得打扰你」时留下的现场"',
     'title="业务经理判断「不值得打扰你」时留下的现场"'),
    # M4:哨兵自缴 —— 扫描器漏一个目录(deliverable 漏扫)
    ("tests/web/chat-no-persona.test.ts",
     '  "components/deliverable",\n',
     ""),
]


def run_tests() -> int:
    r = subprocess.run(
        ["npx", "vitest", "--run", TEST],
        cwd=ROOT, capture_output=True, text=True, timeout=600,
    )
    return r.returncode


def main() -> int:
    failures = []
    for i, (rel, old, new) in enumerate(MUTATIONS, 1):
        path = ROOT / rel
        original = path.read_text(encoding="utf-8")
        if original.count(old) < 1:
            print(f"M{i} SKIP: 变异点没找到({rel}: {old[:40]!r})—— 判据可能已漂移,先看代码")
            failures.append(f"M{i}-missing")
            continue
        mutated = original.replace(old, new, 1)
        if mutated == original:
            print(f"M{i} SKIP: 替换没有生效(变异是假的)")
            failures.append(f"M{i}-noop")
            continue
        path.write_text(mutated, encoding="utf-8")
        try:
            code = run_tests()
        finally:
            path.write_text(original, encoding="utf-8")
        if path.read_text(encoding="utf-8") != original:
            print(f"M{i} FATAL: 复原后与原文不一致 —— 手工检查 {rel}")
            return 2
        status = "RED(判据抓住了)" if code != 0 else "GREEN(判据没生效!)"
        print(f"M{i} [{rel.split('/')[-1]}] -> {status}")
        if code == 0:
            failures.append(f"M{i}-green")
    if failures:
        print("FAIL:", ", ".join(failures))
        return 1
    print(f"全部 {len(MUTATIONS)} 条变异实测变红,复原逐字一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
