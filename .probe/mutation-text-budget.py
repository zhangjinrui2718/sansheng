#!/usr/bin/env python3
"""Wave 6 哨兵的变异自检(2026-11-12)。

纪律(AGENTS.md 三次栽过的坑):
  · 变异必须**真的改写语句** —— 在语句前加注释不算变异;
  · 每次 replace 后必须断言「文件真的变了」—— python str.replace 不匹配时
    静默不执行、退出码 0;
  · 复原必须断言「与原文逐字相同」;
  · 只有 Failed Tests 算数,Failed Suites(模块没加载起来)不算。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TEXT_BUDGET = ROOT / "tests/web/text-budget.test.ts"
ANNOTATION = ROOT / "tests/web/annotation-budget.test.ts"
WORKS = ROOT / "web/src/routes/Works.tsx"
MEMBERS = ROOT / "web/src/routes/Members.tsx"


def run_vitest(target: str) -> tuple[bool, str]:
    """返回 (有 Failed Tests, 输出尾段)。Failed Suites 不算数。"""
    r = subprocess.run(
        ["npx", "vitest", "--run", target],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    out = r.stdout + r.stderr
    failed_suites = "Failed Suites" in out
    failed_tests = "Failed Tests" in out
    return failed_tests and not failed_suites, out[-1200:]


class Mutation:
    def __init__(self, mid, path, old, new, target, why):
        self.mid, self.path, self.old, self.new = mid, path, old, new
        self.target, self.why = target, why

    def run(self):
        src = self.path.read_text()
        if self.old not in src:
            print(f"❌ {self.mid}: 锚点没找到 —— 变异根本没发生(静默失败防线)")
            return False
        mutated = src.replace(self.old, self.new, 1)
        if mutated == src:
            print(f"❌ {self.mid}: replace 后内容没变")
            return False
        self.path.write_text(mutated)
        try:
            red, tail = run_vitest(self.target)
            if not red:
                print(f"❌ {self.mid}: 改坏之后测试仍然绿 —— {self.why}")
                print(tail)
                return False
            print(f"✅ {self.mid}: 红(判据抓到了)")
            return True
        finally:
            self.path.write_text(src)
            if self.path.read_text() != src:
                print(f"❌ {self.mid}: 复原后与原文不一致!")
                return False
            return True


MUTATIONS = [
    # M1 屏上多一段 60 字散文 ⇒ text-budget ① 红(Works 超基线)
    Mutation(
        "M1 可见散文回潮",
        WORKS,
        '{"决策 / 会议 / 变更 / 甲方问答 —— 本来就不由某条工作项产出;"',
        '{"决策 / 会议 / 变更 / 甲方问答 —— 本来就不由某条工作项产出;"\n'
        '            + "这一段是变异测试加进来的六十个字的散文说明它解释为什么这里会有这么多字让人读不完";',
        "tests/web/text-budget.test.ts",
        "① 的 per-file ratchet 没生效",
    ),
    # M2 模板悬停塞一段 50 字 ⇒ annotation-budget ⑩ 红
    Mutation(
        "M2 模板悬停超长",
        MEMBERS,
        'role="tab"',
        'role="tab"\n            title={"这一段变异自检用的悬停文本有整整五十个中文字符它必须被第十条判据当场抓住否则判据就是假的啦啦啦啦啦啦啦"}',
        "tests/web/annotation-budget.test.ts",
        "⑩ 的 per-literal 预算没生效",
    ),
    # M3 仪器自坏:计数器被改瞎 ⇒ ③ 的已知样本自检必须红
    Mutation(
        "M3 计数器改瞎",
        TEXT_BUDGET,
        "const cjkCount = (s: string): number => (s.match(/[\\u4e00-\\u9fff]/g) ?? []).length;",
        "const cjkCount = (s: string): number => (s.match(/[\\u4e00-\\u9fff]/g) ?? []).filter(() => false).length;",
        "tests/web/text-budget.test.ts",
        "③ 的合成样本自检没生效(仪器坏了但测试绿 = 假绿)",
    ),
    # M4 基线表删一行 ⇒ ② 的文件覆盖断言红
    Mutation(
        "M4 文件逃出仪器",
        TEXT_BUDGET,
        '  "components/brand/Seal.tsx": 2,\n',
        "",
        "tests/web/text-budget.test.ts",
        "② 的「基线表覆盖所有文件」没生效",
    ),
    # M5 预算口径改宽(40 → 4000)⇒ ⑩ 的正样本自检必须红(仪器改弱)
    Mutation(
        "M5 判据改弱",
        ANNOTATION,
        "if (n > 40) violations.push(`段 ${n} 字 —— ${seg.slice(0, 50)}`);",
        "if (n > 4000) violations.push(`段 ${n} 字 —— ${seg.slice(0, 50)}`);",
        "tests/web/annotation-budget.test.ts",
        "⑩ 的合成正样本自检没生效",
    ),
]


def main() -> int:
    ok = True
    for m in MUTATIONS:
        ok = m.run() and ok
    print("=" * 46)
    print("全部变异实测变红 ✅" if ok else "有变异没被抓到 ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
