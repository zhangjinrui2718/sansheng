#!/usr/bin/env python3
"""实体脊(identity strip)的变异自检。

仓库纪律(AGENTS.md「三类静默失败」第 3 条):**「测试是绿的」在变异实测过之前不算数**。
两条必须同时成立:
  ① 变异要**真的改坏语句**(不是加注释 —— 注释不会让语句失效);
  ② 每次变异后要**断言那一行确实变了**,否则 `str.replace` 不匹配会静默不执行。

用法:`python3 .probe/mutation-entity-spine.py`
"""
import io
import subprocess
import sys

ROOT = "/root/projects/sansheng"

CASES = [
    (
        "M1 「作者」指向工作项页(地址拼错与拼对在屏幕上长得一样)",
        "web/src/lib/entityMeta.ts",
        '      links: [{ label: authorLabelOf(a), to: memberLocation(a.authorAgentId) }],',
        '      links: [{ label: authorLabelOf(a), to: workLocation(a.authorAgentId) }],',
        ["tests/web/entity-meta.test.ts"],
    ),
    (
        "M2 「产出于」拿不到标题时退成空(空与「没有」长得一样)",
        "web/src/lib/entityMeta.ts",
        "          links: [{ label: opts.workTitle ?? a.workId, to: workLocation(a.workId) }],",
        "          links: [{ label: opts.workTitle ?? \"\", to: workLocation(a.workId) }],",
        ["tests/web/entity-meta.test.ts"],
    ),
    (
        "M3 阻塞「卡住」的条数写死(数出来的 vs 估的)",
        "web/src/lib/entityMeta.ts",
        '          : `${b.blockedWorkIds.length} 个工作项`,',
        '          : "若干个工作项",',
        ["tests/web/entity-meta.test.ts"],
    ),
    (
        "M4 标签换了(「作者」→「产出者」—— 标签是契约)",
        "web/src/lib/entityMeta.ts",
        '      label: "作者",',
        '      label: "产出者",',
        ["tests/web/entity-meta.test.ts", "tests/web/entity-spine-wiring.test.ts"],
    ),
    (
        "M5 顶层环节谎称有父项",
        "web/src/lib/entityMeta.ts",
        '      ? { label: "父项", value: "顶层环节", title: "没有父工作项 —— 这是一条顶层环节" }',
        '      ? { label: "父项", value: "无", title: "没有父工作项 —— 这是一条顶层环节" }',
        ["tests/web/entity-meta.test.ts"],
    ),
    (
        "M6 链接改成 onClick(右键复制 / 中键 / 后退三件全没了)",
        "web/src/components/ui/MetadataStrip.tsx",
        '            <a key={l.to.route + JSON.stringify(l.to.params)} className="ss-link truncate" href={toHash(l.to)}>\n              {l.label}\n            </a>',
        '            <span key={l.to.route + JSON.stringify(l.to.params)} className="ss-link truncate" onClick={() => toHash(l.to)}>\n              {l.label}\n            </span>',
        ["tests/web/metadata-strip.test.ts"],
    ),
    (
        "M7 页面自己造一份事实(手写 items)",
        "web/src/routes/Works.tsx",
        "      <MetadataStrip items={artifactMeta(a, { workTitle })} className=\"mt-1\" />",
        "      <MetadataStrip items={[{ label: \"作者\", value: a.authorName }]} className=\"mt-1\" />",
        ["tests/web/entity-spine-wiring.test.ts"],
    ),
    (
        "M8 页面自己兜底作者名(多了一个事实来源)",
        "web/src/routes/ProjectDetail.tsx",
        "                    <MetadataStrip items={workMeta(w)} className=\"mt-1\" />",
        "                    <MetadataStrip items={workMeta(w)} className=\"mt-1\" />\n                    <span className=\"ss-meta\">{w.assigneeName || w.assigneeAgentId}</span>",
        ["tests/web/entity-spine-wiring.test.ts"],
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
