#!/usr/bin/env python3
"""Wave 3 变异自检 —— 「工件详情搬进右侧抽屉」这一刀的判据各改坏一次,必须实测变红。

纪律(AGENTS.md「三类静默失败」):
  - 变异必须**真的改写语句**(删一行、改条件),不是加个注释 ——
    「在语句前面加个注释」不会让语句失效,那样「改坏了却全绿」是假的;
  - `str.replace` 不匹配时**静默不执行** ⇒ 每一步都断言「改后与改前不同」;
  - 复原后断言**与原文逐字相同**(不用 `git checkout --`:未入库的新文件它会直接报错);
  - runner 覆盖**本波所有判据所在的文件**;
  - ⚠️⚠️ **「变红」不等于「判据有效」** —— 变红可能是**语法错**或**编译错**
    (2026-10-26 实测:第一版 M1 把一个 `<span>` 插成 `<section>` 的兄弟,
    JSX 直接不合法 ⇒ 整份测试文件 transform 失败 ⇒ 「红」了,但判据**根本没被问到**)。
    ⇒ 本脚本**额外判「红的原因」**:输出里出现 `Transform failed` / `Failed Suites`
    (即没有测试跑到断言)⇒ 这条变异**不算数**,报「红在了错误的原因上」。
    ⇒ 所以变异必须保持**语法合法**、且**真的让某个断言失败**。
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
                # ⚠️ **插在同一个元素内部** —— 插成兄弟会让 JSX 不合法,
                # 那就是「红在了语法错上」,证明不了判据(见文件头)。
                "<MetadataStrip items={items} />",
                "<span>{fmtTime(0)}<MetadataStrip items={items} /></span>",
            ),
        ],
    ),
    (
        "M2 「拿不到的主体」也画关系段 ⇒ 一段空的关系",
        INSPECTOR,
        [
            # ⚠️ **不许把守卫改成 `true &&`** —— 那会让 `subject` 不再被收窄,
            # TS 直接报错 ⇒ 整份测试文件编译失败 ⇒ 「红」了,但红在**编译错**上,
            # 判据根本没被问到(见文件头)。
            # ⇒ 这里改成「**段头移出守卫**」:主体拿不到时那一段照样出现 ⇒ 断言照样红,
            # 而类型仍然合法。
            (
                "        {subject !== null && (",
                '        <div className="ss-section">关系</div>\n'
                "        {subject !== null && (",
            ),
        ],
    ),
    (
        "M3 「没有事实」也画事实段 ⇒ 一段空的事实",
        INSPECTOR,
        [("        {items.length > 0 && (", "        {true && (")],
    ),
    (
        "M4 去掉 ESC 关抽屉 ⇒ 键盘用户没有出路",
        INSPECTOR,
        [('      if (e.key === "Escape") onClose();', "      if (false) onClose();")],
    ),
    (
        "M5 抽屉不接地址里的 `artifact=` ⇒ 深链接打不开详情",
        WORKS,
        [("      {openId !== null && (", "      {false && (")],
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


def run_tests() -> tuple[int, str]:
    p = subprocess.run(
        ["npx", "vitest", "run", *TEST_FILES],
        capture_output=True,
        text=True,
    )
    return p.returncode, p.stdout + p.stderr


def red_for_the_right_reason(output: str) -> bool:
    """红在**断言**上(测试跑到并断言失败),而不是红在语法/编译/模块加载上。"""
    if "Transform failed" in output or "Failed Suites" in output:
        return False
    return "AssertionError" in output or "expected" in output


def main() -> int:
    code, out = run_tests()
    if code != 0:
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
            before = mutated
            mutated = mutated.replace(old, new, 1)
            assert mutated != before, f"变异没有改动任何字节:{path}"
        if broken:
            continue
        io.open(path, "w", encoding="utf-8").write(mutated)
        try:
            code, out = run_tests()
        finally:
            io.open(path, "w", encoding="utf-8").write(src)
        back = io.open(path, encoding="utf-8").read()
        assert back == src, f"复原失败:{path}"
        if code == 0:
            print(f"✗ {name}:改坏了却是绿的(该断言没生效)")
            failed += 1
        elif not red_for_the_right_reason(out):
            print(f"✗ {name}:红了,但红的原因不对(语法/编译错,断言根本没被问到)")
            failed += 1
        else:
            print(f"✓ {name}:如期变红(且红在断言上)")

    code, _ = run_tests()
    print("复原后:", "绿" if code == 0 else "红")
    return 1 if failed or code != 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
