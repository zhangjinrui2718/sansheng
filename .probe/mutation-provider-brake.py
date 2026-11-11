#!/usr/bin/env python3
# 变异自检:.probe/mutation-provider-brake.py
# 批次 31「provider 全局刹车 + 预算恢复」的回归有没有真的咬合 —— 每条变异
# **真的移除/改写语句**(不许加注释糊弄 —— AGENTS.md 三类静默失败),且:
#   ① 断言「改后那一行确实变了」(str.replace 不匹配时静默不执行);
#   ② 红的原因必须是 Failed Tests —— Transform failed / Failed Suites(语法/编译错)不算数。
# 复原:按内存里的原文写回 + 断言逐字相同(不用 git checkout —— 新增文件不在 git 里时
# pathspec 报错会让变异留在盘上)。
import subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = [
    "tests/platform/provider-brake.test.ts",
    "tests/platform/provider-failure.test.ts",
    "tests/platform/dispatcher-c3.test.ts",
    "tests/platform/rework.test.ts",
]

# (编号, 文件, 原文, 变异文, 说明)
MUTATIONS = [
    (
        "M1",
        "src/platform/runtime/providerBrake.ts",
        "  if (!BRAKEABLE_KINDS.has(kind)) {",
        "  if (false) {",
        "quota/auth 也能触发刹车(额度问题等不好,不该刹)⇒ ⓪ 负样本红",
    ),
    (
        "M2",
        "src/platform/runtime/providerBrake.ts",
        "  const cooldownMs = Math.min(\n    baseCooldownMs * BACKOFF_FACTOR ** (failureStreak - 1),\n    maxCooldownMs,\n  );",
        "  const cooldownMs = Math.min(\n    baseCooldownMs * BACKOFF_FACTOR ** (failureStreak - 1),\n    Number.MAX_SAFE_INTEGER,\n  );",
        "退避封顶被去掉(streak 一直涨 ⇒ 退避推到小时级)⇒ ⓪ 封顶测试红",
    ),
    (
        "M3",
        "src/platform/runtime/dispatcher.ts",
        "    if (deps.providerBrakeActive?.() === true) {",
        "    if (false) {",
        "排空器的刹车门失效(退避期内照派)⇒ ①/②/⑤ 红",
    ),
    (
        "M4",
        "src/platform/host/serve.ts",
        "          if (failure.retryable && !turn.timedOut && !aborted) {",
        "          if (failure.retryable && !aborted) {",
        "超时也算 provider 故障(自动重跑卡死行为不是等能治的)⇒ ⑥-2 红",
    ),
    (
        "M5",
        "src/platform/host/serve.ts",
        "          execution.turn.toolCalls.length === 0 &&",
        "          execution.turn.toolCalls.length >= 0 &&",
        "有副作用的回合也进刹车(留在 in_progress 等自动重派 = 重跑不安全)⇒ ⑥-3 红",
    ),
    (
        "M6",
        "src/platform/runtime/dispatcher.ts",
        "    } else if (brakePaused) {",
        "    } else if (false) {",
        "刹车路径不重置尝试预算(provider 故障烧「叫醒3次」的预算)⇒ ⑥-1 红",
    ),
    (
        "M7",
        "src/platform/host/serve.ts",
        "        execution.outcome !== \"refused\" && execution.outcome !== \"timed_out\"\n      ) {\n        clearProviderBrake();\n      }",
        "        execution.outcome !== \"refused\" && execution.outcome !== \"timed_out\"\n      ) {\n      }",
        "成功回合不清刹车(只能干等冷却过期)⇒ ④a 红",
    ),
    (
        "M8",
        "src/platform/host/serve.ts",
        "          if (note.episode) {\n            announceProviderBrakePaused(projectId, note.brakedUntilAt);\n          } else {",
        "          if (false) {\n            announceProviderBrakePaused(projectId, note.brakedUntilAt);\n          } else {",
        "工作路径的刹车通知不落库(⚠️ 供应商 首行没了)⇒ ⑥-1 的通知断言红",
    ),
]


def run_vitest() -> tuple[bool, str]:
    """红 = Failed Tests 存在且 >0;Transform failed / Failed Suites 的红不算数。"""
    cmd = ["npx", "vitest", "run", *TESTS, "--reporter=verbose"]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    out = (p.stdout + p.stderr)
    if "Transform failed" in out or "Failed Suites" in out:
        return False, "编译/套件级红(不算数 —— 判据根本没被问到)\n" + out[-1500:]
    import re
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
        for num, rel, old, new, why in MUTATIONS:
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
            ok, detail = run_vitest()
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
