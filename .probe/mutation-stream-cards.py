#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
变异自检:tests/web/stream-cards.test.ts(V2 行动区 + 流内塌缩,2026-11-21)

纪律(AGENTS.md「测试判据:变异自检要真的改坏一遍」):
- 每条变异必须真的改写语句(不是加注释),并在改后断言「那一行确实变了」;
- 跑针对性测试,期望**变红**;
- 用内存里的原文写回复原,断言逐字相同(不用 git checkout)。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "tests/web/stream-cards.test.ts"

MUTATIONS = [
    # M1:行动项的主对话线限定去掉 —— 表态会漏进交付线/自建线
    ("web/src/entities/streamCards.ts",
     "export function actionItemsOf(input: StreamCardsInput): ActionItem[] {\n  if (input.projectId === null) return [];\n  if (!input.isMainSession) return [];",
     "export function actionItemsOf(input: StreamCardsInput): ActionItem[] {"),
    # M2:事实行的接待防线拆掉 —— 接待会话也出塌缩行(接待没有表态)
    ("web/src/entities/streamCards.ts",
     "export function streamFactsOf(input: StreamCardsInput): StreamFact[] {\n  if (input.projectId === null) return [];\n  if (!input.isMainSession) return [];",
     "export function streamFactsOf(input: StreamCardsInput): StreamFact[] {"),
    # M3:「行在不在手」判据去掉 —— 一行没拿到也发确认开工项(编锚)
    ("web/src/entities/streamCards.ts",
     "    if (pending.length > 0) {\n      items.push({ type: \"confirm\", at: Math.max(...pending.map((w) => w.createdAt)), count: pending.length });\n    }",
     "    items.push({ type: \"confirm\", at: 0, count: pending.length });"),
    # M4:归并排序倒置 —— 事实跑到整段历史前面
    ("web/src/entities/streamCards.ts",
     "  items.sort((a, b) => a.at - b.at);\n  return items;\n}",
     "  items.sort((a, b) => b.at - a.at);\n  return items;\n}"),
    # M5:F3 窗口塌掉 —— 「已答复 · 整理中」永远显示成「已落 decision 工件」
    ("web/src/entities/streamCards.ts",
     "      consumed: row.consumedAt !== null,",
     "      consumed: true,"),
    # M6:行动区挂载点拆掉 —— 判据全在、界面没有读者(「代码里写了 ≠ 有读者」)
    ("web/src/features/chat/ChatSurface.tsx",
     "<ActionRail actions={actions} unavailable={cardsUnavailable} plan={planContext} />",
     ""),
    # M7:读不到静默 —— 行动区把读失败吞成「没有」
    ("web/src/features/chat/ActionRail.tsx",
     "if (props.actions.length === 0 && props.unavailable === null) return null;",
     "if (props.actions.length === 0) return null;"),
    # M8:close 不再独立分类 —— 收口提议混成普通提问(动词与表单全错)
    ("web/src/entities/streamCards.ts",
     "    items.push(\n      q.intent === \"close\"\n        ? { type: \"close\", at: q.createdAt, q }\n        : { type: \"question\", at: q.createdAt, q },\n    );",
     "    items.push({ type: \"question\", at: q.createdAt, q });"),
]

def run_test() -> bool:
    """true = 哨兵红(抓到)"""
    r = subprocess.run(["npx", "vitest", "--run", TEST], capture_output=True, text=True, cwd=ROOT)
    return "failed" in (r.stdout + r.stderr).lower()

def main() -> int:
    results = []
    for i, (rel, old, new) in enumerate(MUTATIONS, 1):
        path = ROOT / rel
        orig = path.read_text()
        mutated = orig.replace(old, new, 1)
        assert mutated != orig, f"M{i}: 变异未生效(找不到目标段): {rel} :: {old[:60]!r}"
        path.write_text(mutated)
        caught = run_test()
        path.write_text(orig)
        assert path.read_text() == orig, f"M{i}: 还原失败"
        results.append(caught)
        print(f"{'OK ' if caught else 'MISS'} M{i} ({rel})")

    final_green = not run_test()
    if all(results) and final_green:
        print(f"\n全部 {len(results)} 条变异实测变红,还原后全绿。")
        return 0
    return 1

if __name__ == "__main__":
    sys.exit(main())
