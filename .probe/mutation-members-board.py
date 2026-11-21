#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
变异自检:tests/web/members-board.test.ts(v5 Wave D 全员并发板,2026-11-20)

纪律同 .probe/mutation-stream-cards.py:真改坏语句 + 断言改动生效 + 期望变红 +
内存原文复原且逐字一致。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "tests/web/members-board.test.ts"

MUTATIONS = [
    # M1(灵魂判据):板退化成「只渲染选中的那张」—— 并发不可见,正是本波要修的病
    ("web/src/components/members/MemberCard.tsx",
     "      {members.map((m) => (",
     "      {members.filter((m) => m.id === selectedId).map((m) => ("),
    # M2:读不到被点亮(TurnStatus 的三态判据在卡上塌掉)
    ("web/src/components/members/TurnStatus.tsx",
     '  if (runtime === "unavailable") {',
     "  if (false) {"),
    # M3:实时行判据漂移 —— 倒序取「最后一个块」改成正序取「第一个块」
    ("web/src/components/members/MemberCard.tsx",
     "  for (let i = t.blocks.length - 1; i >= 0; i -= 1) {",
     "  for (let i = 0; i < t.blocks.length; i += 1) {"),
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
            print(f"M{i} SKIP: 变异点没找到({rel}: {old[:40]!r})")
            failures.append(f"M{i}-missing")
            continue
        mutated = original.replace(old, new, 1)
        if mutated == original:
            print(f"M{i} SKIP: 替换没有生效")
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
