#!/usr/bin/env python3
"""Wave 3 变异自检 —— 「工件详情搬进右侧抽屉」这一刀的判据各改坏一次,必须实测变红。

纪律(AGENTS.md「三类静默失败」):
  - 变异必须**真的改写语句**(删一行、改条件),不是加个注释 ——
    「在语句前面加个注释」不会让语句失效,那样「改坏了却全绿」是假的;
  - `str.replace` 不匹配时**静默不执行** ⇒ 每一步都断言「改后与改前不同」;
  - 复原后断言**与原文逐字相同**(不用 `git checkout --`:未入库的新文件它会直接报错);
  - runner 覆盖**本波所有判据所在的文件**。
"""
import io
import subprocess
import sys

TEST_FILES = ["tests/web/entity-inspector.test.ts"]
INSPECTOR = "web/src/components/shell/EntityInspector.tsx"
WORKS = "web/src/routes/Works.tsx"

CASES = [
    (
        "M1 抽屉里自己算一次事实(加一次 fmtTime 调用)⇒ 第二个事实来源",
        INSPECTOR,
        [
            (
                'import { MetadataStrip } from "@/components/ui/MetadataStrip";',
                'import { MetadataStrip } from "@/components/ui/MetadataStrip";\n'
                'import { fmtTime } from "@/lib/vocab";',
            ),
            (
                "            <MetadataStrip items={items} />",
                "            <MetadataStrip items={items} />\n"
                "            <span>{fmtTime(0)}</span>",
            ),
        ],
    ),
    (
        "M2 「拿不到的主体」也画关系段 ⇒ 一段空的关系",
        INSPECTOR,
        [
            (
                "        {subject !== null && (",
                "        {true && (",
            ),
        ],
    ),
    (
        "M3 「没有事实」也画事实段 ⇒ 一段空的事实",
        INSPECTOR,
        [
            (
                "        {items.length > 0 && (",
                "        {true && (",
            ),
        ],
    ),
    (
        "M4 去掉 ESC 关抽屉 ⇒ 键盘用户没有出路",
        INSPECTOR,
        [
            (
                '      if (e.key === "Escape") onClose();',
                "      if (false) onClose();",
            ),
        ],
    ),
    (
        "M5 抽屉不接地址里的 `artifact=` ⇒ 深链接打不开详情",
        WORKS,
        [
            (
                "      {openId !== null && (",
                "      {false && (",
            ),
        ],
    ),
    (
        "M6 工件行里再内联展开一份详情 ⇒ 同一实体两个渲染面",
        WORKS,
        [
            (
                "      {/*\n        ⚠️ **工件详情现在住在右侧抽屉里**",
                "      {open && <ArtifactDetail id={a.id} known={known} relations={relations} />}\n"
                "      {/*\n        ⚠️ **工件详情现在住在右侧抽屉里**",
            ),
        ],
    ),
]


def run_tests() -> int:
    p = subprocess.run(
        ["npx", "vitest", "run", *TEST_FILES],
        capture_output=True,
        text=True,
    )
    return p.returncode


def main() -> int:
    base = run_tests()
    if base != 0:
        print("基线就是红的 —— 先修好再谈变异")
        return 1
    print("基线:绿")

    failed = 0
    for name, path, edits in CASES:
        src = io.open(path, encoding="utf-8").read()
        mutated = src
        broken = False
        for old, new in edits:
            if old not in mutated:
                print(f"✗ {name}:变异点找不到 —— {path} 里没有 {old[:48]!r}")
                failed += 1
                broken = True
                break
            mutated = mutated.replace(old, new, 1)
            assert mutated != src, f"变异没有改动任何字节:{path}"
        if broken:
            continue
        assert mutated != src, f"变异没有改动任何字节:{path}"
        io.open(path, "w", encoding="utf-8").write(mutated)
        try:
            code = run_tests()
        finally:
            io.open(path, "w", encoding="utf-8").write(src)
        back = io.open(path, encoding="utf-8").read()
        assert back == src, f"复原失败:{path}"
        if code == 0:
            print(f"✗ {name}:改坏了却是绿的(该断言没生效)")
            failed += 1
        else:
            print(f"✓ {name}:如期变红")

    tail = run_tests()
    print("复原后:", "绿" if tail == 0 else "红")
    return 1 if failed or tail != 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
