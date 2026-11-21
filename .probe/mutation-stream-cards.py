#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
变异自检:tests/web/stream-cards.test.ts(v5 表态卡进流,2026-11-20)

纪律(AGENTS.md「测试判据:变异自检要真的改坏一遍」):
- 每条变异必须真的改写语句(不是加注释),并在改后断言「那一行确实变了」;
- 跑针对性测试,期望**变红**(退出码非 0);
- 用内存里的原文写回复原,断言逐字相同(不用 git checkout —— 新文件没入库时会
  报 pathspec 错,于是变异留在盘上、脚本自己崩)。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "tests/web/stream-cards.test.ts"

MUTATIONS = [
    # M1:主对话线限定去掉 —— 表态卡会漏进交付线/自建线
    ("web/src/lib/streamCards.ts",
     "if (!input.isMainSession) return [];",
     ""),
    # M2:接待会话不设防 —— 没有项目也发卡(接待没有表态)
    ("web/src/lib/streamCards.ts",
     "if (input.projectId === null) return [];",
     ""),
    # M3:「行在不在手」的判据去掉 —— 一行都没拿到也发计划卡(编锚:-Infinity)
    ("web/src/lib/streamCards.ts",
     "if (pending.length > 0) {",
     ""),
    # M4:归并排序倒置 —— 卡跑到整段历史前面
    ("web/src/lib/streamCards.ts",
     "items.sort((a, b) => a.at - b.at);",
     "items.sort((a, b) => b.at - a.at);"),
    # M5:F3 窗口塌掉 —— 「已答复 · 整理中」永远显示成「已落 decision 工件」
    ("web/src/components/chat/StreamCards.tsx",
     "{card.consumed",
     "{true"),
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
        restored = path.read_text(encoding="utf-8")
        if restored != original:
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
