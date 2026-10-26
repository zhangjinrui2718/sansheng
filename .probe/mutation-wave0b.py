#!/usr/bin/env python3
"""Wave 0b 变异自检 —— 每条变异都**真的改坏**一句,并断言「改后那一行确实变了」。

为什么要这个脚本(AGENTS.md「三类静默失败」第 2/3 条):
  - `python str.replace` 不匹配时**静默不执行**、退出码 0 ⇒ 一条从未生效的变异
    会被当成「测过了」;
  - 「在语句前面加个注释」**不是变异** —— 注释不让语句失效。
所以这里每一步都断言:①目标串在文件里;②替换后字节确实变了;③目标测试**变红**。

用法:`python3 .probe/mutation-wave0b.py`(每条跑完自动 `git checkout --` 复原)
"""
import io
import subprocess
import sys

CASES = [
    # (名字, 文件, 原文, 改成, 期望变红的测试)
    (
        "M1 DataState:去掉「还没查过」那一档(慢请求会被读成空)",
        "web/src/components/ui/DataState.tsx",
        '  if (loading && rows.length === 0) return { kind: "loading" };\n',
        "",
        "tests/web/data-state.test.ts",
    ),
    (
        "M2 待答面板:把全局 questions 喂给状态(筛选没接上)",
        "web/src/components/client/ClientQuestionDock.tsx",
        "remoteListOf(items, loading, error)",
        "remoteListOf(questions, loading, error)",
        "tests/web/question-scope.test.ts",
    ),
    (
        "M3 关于页:少渲染一条词汇表(用户永远读不到它)",
        "web/src/routes/About.tsx",
        "const GLOSSARY_IDS = Object.keys(GLOSSARY) as GlossaryId[];",
        "const GLOSSARY_IDS = (Object.keys(GLOSSARY) as GlossaryId[]).slice(0, -1);",
        "tests/web/about-page.test.ts",
    ),
    (
        "M4 顶栏:把「关于」塞进 TABS(导航变成 7 项)",
        "web/src/components/shell/TopBar.tsx",
        '  { route: "chat", label: "对话" },',
        '  { route: "chat", label: "对话" },\n  { route: "about", label: "关于" },',
        "tests/web/about-page.test.ts",
    ),
    (
        "M5 App:只在 union 里加 about、不接分支(点了没反应)",
        "web/src/App.tsx",
        "        <AboutPage />\n",
        "",
        "tests/web/about-page.test.ts",
    ),
    (
        "M6 待验收面板:吞掉错误(读失败被当成「货收完了」)",
        "web/src/components/client/AcceptanceDock.tsx",
        "state={remoteOf(detail, error, loading)}",
        "state={remoteOf(detail, null, loading)}",
        "tests/web/acceptance-dock.test.ts",
    ),
]


def run(test_file: str) -> bool:
    """True = 绿。"""
    r = subprocess.run(
        ["npx", "vitest", "run", test_file],
        capture_output=True,
        text=True,
    )
    return r.returncode == 0


def main() -> int:
    failed = 0
    for name, path, old, new, test_file in CASES:
        src = io.open(path, encoding="utf-8").read()
        if old not in src:
            print(f"✗ {name}\n    目标串不存在:{old[:60]!r}(变异无法生效)")
            failed += 1
            continue
        assert src.count(old) == 1, f"{path}: 目标串出现 {src.count(old)} 次,不唯一"
        mutated = src.replace(old, new, 1)
        assert mutated != src, "替换后字节没有变化"
        io.open(path, "w", encoding="utf-8").write(mutated)
        try:
            changed = io.open(path, encoding="utf-8").read() != src
            assert changed, "写回后文件没变"
            green = run(test_file)
        finally:
            # ⚠️ 按**内存里的原文**复原,不用 `git checkout --`:
            # Wave 0b 的部分文件还没进版本库(新增文件),`git checkout` 会报
            # "did not match any file(s) known to git" 而**把变异留在盘上**。
            io.open(path, "w", encoding="utf-8").write(src)
        restored = io.open(path, encoding="utf-8").read()
        assert restored == src, f"{path} 没能复原"
        if green:
            print(f"✗ {name}\n    {test_file} 仍然全绿 ⇒ 这条判据是空断言")
            failed += 1
        else:
            print(f"✓ {name}\n    {test_file} 如实变红")
    print()
    if failed:
        print(f"{failed} 条变异没有被抓住")
        return 1
    print(f"全部 {len(CASES)} 条变异都变红 —— 判据有效")
    return 0


if __name__ == "__main__":
    sys.exit(main())
