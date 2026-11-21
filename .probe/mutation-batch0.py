#!/usr/bin/env python3
"""批次 0 变异自检:对比度哨兵必须真的抓得住坏值。

纪律(AGENTS.md「测试判据:变异自检要真的改坏一遍」):
  · 每条变异真的改写语句(不是加注释),并断言「改后那一行确实变了」;
  · 变异后哨兵必须红,还原后必须绿;
  · 不用 git checkout 复原 —— 按内存原文写回 + 断言与原文逐字相同。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKENS = ROOT / "web/src/styles/tokens.css"
THEME = ROOT / "web/src/styles/theme.css"
TEST = "tests/web/theme-contrast.test.ts"

orig_tokens = TOKENS.read_text()
orig_theme = THEME.read_text()

def run_test() -> bool:
    """true = 哨兵红(抓到);false = 哨兵绿(漏掉 —— 变异白做)"""
    r = subprocess.run(
        ["npx", "vitest", "--run", TEST],
        capture_output=True, text=True, cwd=ROOT,
    )
    return "failed" in (r.stdout + r.stderr).lower() or "Tests  " not in r.stdout

def mutate(path: Path, orig: str, old: str, new: str, mid: int):
    mutated = orig.replace(old, new, 1)
    assert mutated != orig, f"M{mid}: 变异未生效(找不到目标行): {old[:60]}"
    path.write_text(mutated)

MUTATIONS = [
    ("M1 文本级色降亮度 ⇒ 必须红", TOKENS, orig_tokens,
     "--text-2: oklch(0.72 0.008 260);", "--text-2: oklch(0.55 0.008 260);"),
    ("M2 状态表越界裸色 ⇒ 必须红", THEME, orig_theme,
     "--status-work-done: var(--ok);", "--status-work-done: oklch(0.4 0.18 300);"),
    ("M3 删兼容别名 --jade ⇒ 必须红", TOKENS, orig_tokens,
     "  --jade: var(--brand);\n", ""),
    ("M4 状态映射删一枚 reject ⇒ 必须红", THEME, orig_theme,
     "  --status-reject: var(--danger);\n", ""),
    ("M5 危险色亮度压低 ⇒ 必须红", TOKENS, orig_tokens,
     "--danger: oklch(0.7 0.16 25);", "--danger: oklch(0.55 0.16 25);"),
]

results = []
for i, (name, path, orig, old, new) in enumerate(MUTATIONS, 1):
    mutate(path, orig, old, new, i)
    caught = run_test()
    path.write_text(orig)  # 还原
    assert path.read_text() == orig, f"{name}: 还原失败"
    ok = caught
    results.append(ok)
    print(f"{'✅' if ok else '❌ 漏掉'} {name}")

# 还原后哨兵必须回到绿
final_green = not run_test()
assert TOKENS.read_text() == orig_tokens and THEME.read_text() == orig_theme

if all(results) and final_green:
    print(f"\n全部 {len(results)} 条变异实测变红,还原后全绿。")
    sys.exit(0)
sys.exit(1)
