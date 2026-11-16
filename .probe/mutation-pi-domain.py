#!/usr/bin/env python3
# 变异自检:.probe/mutation-pi-domain.py
# pi 适配器域批次(2026-11-16:thinkingLevel 接线 + 模型目录自有)的回归有没有真的咬合 ——
# 每条变异**真的移除/改写语句**(加注释不算变异 —— AGENTS.md 三类静默失败),且:
#   ① 断言「改后那一行确实变了」(str.replace 不匹配时静默不执行、退出码 0);
#   ② 写盘后读回复核(写盘也不能信自述);
#   ③ 红的原因必须是 Failed Tests —— Transform failed / Failed Suites(语法/编译错)不算数;
#   ④ 复原:按内存里的原文写回 + 断言逐字相同(不用 git checkout —— 新增文件不在 git 里时
#      pathspec 报错会让变异留在盘上)。
import subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = [
    "tests/platform/model-catalog.test.ts",
    "tests/platform/session-thinking-level.test.ts",
]

# (编号, 文件, 原文, 变异文, 说明)
MUTATIONS = [
    (
        "M1",
        "src/platform/runtime/agentRuntime/pi/modelCatalog.ts",
        "  return MODELS[provider]?.[modelId];",
        "  return undefined;",
        "目录解析直接返回空(resolveCatalogModel 恒查不到)⇒ 抽查 / 整表 deep-equal / resolveModel 全红",
    ),
    (
        "M2",
        "src/platform/runtime/agentRuntime/pi/session.ts",
        '    ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),\n',
        "",
        "thinkingLevel 不再进交给 SDK 的配置(死接线复辟:settings 存了但从未传给会话)⇒ session-thinking-level 红",
    ),
    (
        "M3",
        "src/platform/runtime/agentRuntime/pi/providers.ts",
        "    const m: Model<any> = { ...builtin };",
        "    const m: Model<any> = builtin;",
        "B6 浅拷贝被去掉(resolveModel 就地改写共享目录里的那一份)⇒「baseUrl 传 null = 回到 catalog 默认」红",
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
            try:
                ok, detail = run_vitest()
                results.append((num, ok, f"{detail} —— {why}"))
            finally:
                # **本条变异跑完立刻复原**(不要让上一条的变异叠进下一条的现场
                # —— 否则下一条的「红」有一部分是上一条造成的,归因就脏了),
                # 并断言逐字相同。
                f.write_bytes(originals[rel])
                assert f.read_bytes() == originals[rel], f"复原失败:{rel}"
    finally:
                # 兜底复原(上一层的 finally 已逐条做过;这里防中途异常漏网)。
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
