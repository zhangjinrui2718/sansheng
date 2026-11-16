#!/usr/bin/env python3
# 变异自检:.probe/mutation-work-batch.py
# 「工作项域批次」(显式优先级 + 收口复盘工件)的回归有没有真的咬合 —— 每条变异
# **真的移除/改写语句**(加注释糊弄不算变异 —— AGENTS.md 三类静默失败),且:
#   ① 断言「改后那一行确实变了」(str.replace 不匹配时静默不执行、退出码 0);
#   ② 红的原因必须是 Failed Tests —— Transform failed / Failed Suites(编译错)不算数。
# 复原:按内存里的原文写回 + 断言逐字相同(不用 git checkout —— 新增文件不在 git 里时
# pathspec 报错会让变异留在盘上)。
import subprocess, sys, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (编号, 文件, 原文, 变异文, 说明, 跑哪些测试)
MUTATIONS = [
    (
        "M1",
        "src/platform/runtime/dispatcher.ts",
        "      PRIORITY[a.kind] - PRIORITY[b.kind] ||\n"
        "      (a.workPriority ?? DEFAULT_WORK_PRIORITY) - (b.workPriority ?? DEFAULT_WORK_PRIORITY) ||\n"
        "      a.key.localeCompare(b.key),",
        "      PRIORITY[a.kind] - PRIORITY[b.kind] ||\n"
        "      a.key.localeCompare(b.key),",
        "排空器丢掉「工作项优先级」这一段(排序退化回加列前)⇒ 「优先级小的先跑」红",
        ["tests/platform/work-priority.test.ts"],
    ),
    (
        "M2",
        "src/platform/tools/project.ts",
        "  if (!written.ok) return { problem: written.problem };\n"
        "  insertArtifact(ctx.db, {",
        "  if (!written.ok || true) return { problem: written.problem };\n"
        "  insertArtifact(ctx.db, {",
        "复盘正文一律报「写盘失败」、行永远不插(note 不落库)⇒ 复盘存在性/计数断言红",
        ["tests/platform/project-retro.test.ts"],
    ),
]


def run_vitest(tests: list[str]) -> tuple[bool, str]:
    """红 = Failed Tests 存在且 >0;Transform failed / Failed Suites 的红不算数。"""
    cmd = ["npx", "vitest", "run", *tests, "--reporter=verbose"]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    out = p.stdout + p.stderr
    if "Transform failed" in out or "Failed Suites" in out:
        return False, "编译/套件级红(不算数 —— 判据根本没被问到)\n" + out[-1500:]
    m = re.search(r"Tests\s+(\d+) failed(?:\s*\|\s*(\d+) passed)?", out)
    if m is None:
        return False, "解析不到测试统计(异常退出)\n" + out[-1500:]
    failed = int(m.group(1))
    if failed > 0:
        return True, f"红(Failed Tests = {failed})"
    return False, "全绿(变异没被抓住)\n" + out[-1200:]


def main() -> int:
    originals: dict[str, bytes] = {}
    results: list[tuple[str, bool, str]] = []
    try:
        for num, rel, old, new, why, tests in MUTATIONS:
            f = ROOT / rel
            if rel not in originals:
                originals[rel] = f.read_bytes()
            src = originals[rel].decode("utf-8")
            if src.count(old) != 1:
                results.append((num, False, f"原文定位失败(count={src.count(old)} ≠ 1)—— 变异没施加"))
                continue
            mutated = src.replace(old, new, 1)
            if mutated == src:
                results.append((num, False, "replace 后没变 —— 变异没施加"))
                continue
            f.write_text(mutated, encoding="utf-8")
            # 复核落盘的确实是变异版(写盘也不能信自述)。
            if (ROOT / rel).read_text(encoding="utf-8") == src:
                results.append((num, False, "写盘后读回仍是原文 —— 写盘失败"))
                continue
            ok, detail = run_vitest(tests)
            results.append((num, ok, f"{detail} —— {why}"))
    finally:
        # 复原:按内存原文写回,断言逐字相同。
        for rel, data in originals.items():
            (ROOT / rel).write_bytes(data)
            assert (ROOT / rel).read_bytes() == data, f"复原失败:{rel}"
    # 汇总
    print("=" * 72)
    all_ok = True
    for num, ok, detail in results:
        mark = "RED ✓" if ok else "NOT-RED ✗"
        if not ok:
            all_ok = False
        print(f"{num}: {mark}  {detail.splitlines()[0]}")
    print("=" * 72)
    print("全部文件已复原并逐字核对 ✓" if all_ok else "⚠️ 有变异未变红或复原失败 —— 见上")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
