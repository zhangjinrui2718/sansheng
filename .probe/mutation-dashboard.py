#!/usr/bin/env python3
"""项目页仪表盘(§3.4)的变异自检。

仓库纪律(AGENTS.md「三类静默失败」第 3 条):**「测试是绿的」在变异实测过之前不算数**。
两条必须同时成立:
  ① 变异要**真的改坏语句**(不是加注释 —— 注释不会让语句失效);
  ② 每次变异后要**断言那一行确实变了**,否则 `str.replace` 不匹配会静默不执行。

用法:`python3 .probe/mutation-dashboard.py`
"""
import io
import subprocess
import sys

ROOT = "/root/projects/sansheng"

CASES = [
    (
        "M1 「运行态读不到」被当成「没待办」(读不到 ≠ 空闲)",
        "web/src/lib/dashboard.ts",
        '  if (facts.live === null || facts.live.runtime === "unavailable") {',
        '  if (false) {',
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M2 高危阻塞的严重度判据去掉(低危也报成高危)",
        "web/src/lib/dashboard.ts",
        "    (b) => OPEN_BLOCKER_STATES.has(b.status) && HIGH_SEVERITY.has(b.severity),",
        "    (b) => OPEN_BLOCKER_STATES.has(b.status),",
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M3 已解决的阻塞也算未解决",
        "web/src/lib/dashboard.ts",
        'const OPEN_BLOCKER_STATES = new Set(["open", "acknowledged"]);',
        'const OPEN_BLOCKER_STATES = new Set(["open", "acknowledged", "resolved"]);',
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M4 阻塞的地址丢掉项目 id(半个地址:只在「正好在看那个项目」时成立)",
        "web/src/lib/dashboard.ts",
        '      to: blockerLocation(high[0]?.id ?? "", facts.projectId),',
        '      to: blockerLocation(high[0]?.id ?? ""),',
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M5 档位顺序换了(等甲方答排到高危阻塞前面)",
        "web/src/lib/dashboard.ts",
        '  "next_high_blocker",\n  "next_waiting_client",',
        '  "next_waiting_client",\n  "next_high_blocker",',
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M6 「真的没有」也编一件出来充数(判据从有到无)",
        "web/src/lib/dashboard.ts",
        '    key: "next_none",\n    label: "此刻没有等你动作的事",',
        '    key: "next_none",\n    label: "有一条小事在推进",',
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M7 计数卡自己数一遍(与服务端算好的 counts 漂开)",
        "web/src/routes/ProjectDetail.tsx",
        "          works: detail?.counts.works ?? 0,",
        "          works: (detail?.works ?? []).length,",
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M8 项目页又把工作项列表画一遍(一个实体渲染两处 ⇒ 关联丢)",
        "web/src/routes/ProjectDetail.tsx",
        "      {detail && <DashboardCards cards={cards} next={next} />}",
        "      {detail && <DashboardCards cards={cards} next={next} />}\n      {detail && detail.works.map((w) => (\n        <div key={w.id}>{w.title}</div>\n      ))}",
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M9 页面自己判档位(判据从一处散成两处)",
        "web/src/routes/ProjectDetail.tsx",
        "  const next = useMemo(() => nextThing(dashboardFacts), [dashboardFacts]);",
        '  const next = useMemo(() => (dashboardFacts.blockers.data.length > 0\n    ? { key: "next_high_blocker", label: "有阻塞", why: "", action: "", to: null }\n    : nextThing(dashboardFacts)), [dashboardFacts]);',
        ["tests/web/project-dashboard.test.ts"],
    ),
    (
        "M10 计数卡不是链接(onClick 改 hash ⇒ 右键复制 / 中键 / 后退三件全没)",
        "web/src/components/dashboard/DashboardCards.tsx",
        '    <a className="ss-dashboard-card" href={toHash(card.to)} title={card.title}>\n      {body}\n    </a>',
        '    <span className="ss-dashboard-card" onClick={() => toHash(card.to)} title={card.title}>\n      {body}\n    </span>',
        ["tests/web/project-dashboard.test.ts"],
    ),
]


def run(files):
    p = subprocess.run(
        ["npx", "vitest", "run", *files],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return p.returncode


def main() -> int:
    failures = []
    for name, rel, old, new, files in CASES:
        path = f"{ROOT}/{rel}"
        original = io.open(path, encoding="utf-8").read()
        if old not in original:
            print(f"✗ {name}: 变异点找不到 —— 断言失败(不许跳过)")
            failures.append(name)
            continue
        mutated = original.replace(old, new, 1)
        assert mutated != original, f"{name}: 替换后内容没变"
        io.open(path, "w", encoding="utf-8").write(mutated)
        try:
            code = run(files)
        finally:
            io.open(path, "w", encoding="utf-8").write(original)
        restored = io.open(path, encoding="utf-8").read()
        assert restored == original, f"{name}: 复原失败"
        if code == 0:
            print(f"✗ {name}: 变异后仍然全绿 —— 判据没抓住")
            failures.append(name)
        else:
            print(f"✓ {name}: 变红(测试抓到了)")
    if failures:
        print(f"\n{len(failures)} 条变异没被抓住:{failures}")
        return 1
    print(f"\n{len(CASES)} 条变异全部实测变红")
    return 0


if __name__ == "__main__":
    sys.exit(main())
