#!/usr/bin/env python3
"""Wave 2e 变异自检 —— 「项目坐标」与「语料来源有地址」六条判据各改坏一次,必须实测变红。

纪律(AGENTS.md「三类静默失败」):
  - 变异必须**真的改写语句**(删一行、改正则),不是加个注释;
  - `str.replace` 不匹配时**静默不执行** ⇒ 每一步都断言「改后与改前不同」;
  - 复原后断言**与原文逐字相同**(不用 `git checkout --`:未入库的新文件它会直接报错);
  - runner 覆盖**本波所有判据所在的文件** —— 变异脚本自己也会犯「仪器只看一处」的错
    (2026-10-26,Wave 2d 第一版就栽在这上面)。
"""
import io
import subprocess
import sys

TEST_FILES = ["tests/web/deep-link.test.ts", "tests/web/relations-wiring.test.ts"]
DEEP = "web/src/lib/deepLink.ts"
META = "web/src/lib/entityMeta.ts"

CASES = [
    (
        "M1 删掉「坐标过期就清掉」那条 ⇒ 用户切了项目会被地址拽回去",
        DEEP,
        "  if (state.applied !== null && projectId !== state.applied) {\n"
        "    return { state: { applied: null }, switchTo: null, clear: true };\n"
        "  }",
        "  if (false) {\n"
        "    return { state: { applied: null }, switchTo: null, clear: true };\n"
        "  }",
    ),
    (
        "M2 「指向空气的地址」也切 ⇒ 地址点名的项目不存在时切过去",
        DEEP,
        "  if (knownProjectIds.length > 0 && !knownProjectIds.includes(wanted)) return false;",
        "  if (false) return false;",
    ),
    (
        "M3 已经在看它也切 ⇒ 无意义的重复切换",
        DEEP,
        "  if (wanted === currentProjectId) return false;",
        "  if (false) return false;",
    ),
    (
        "M4 应用外壳不挂坐标落地 ⇒ 深链接落不到别的项目上",
        "web/src/App.tsx",
        "  useProjectCoordinate();",
        "  // 变异:不挂",
    ),
    (
        "M5 语料来源的地址不带项目坐标 ⇒ 半个地址",
        META,
        "    return withProjectCoordinate(artifactLocation(chunk.artifactId), chunk.projectId);",
        "    return artifactLocation(chunk.artifactId);",
    ),
    (
        "M6 语料来源渲染成纯文本 ⇒ 没有地址",
        "web/src/routes/Memory.tsx",
        "                          <a href={toHash(sourceTo)}>{chunkSourceLabel(c)}</a>",
        "                          {chunkSourceLabel(c)}",
    ),
    (
        "M7 「地址带来的换项目」也清 ⇒ 深链接落地后选中项被自己抹掉",
        "web/src/lib/route.ts",
        "  if (addressProjectId !== undefined && addressProjectId === nextProjectId) return false;",
        "  if (false) return false;",
    ),
    (
        "M8 工作项页不把坐标传进去 ⇒ 判据写在 lib 里却没人用",
        "web/src/routes/Works.tsx",
        "    if (!shouldClearSelection(prev, scope, addressProject)) return;",
        "    if (!shouldClearSelection(prev, scope)) return;",
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
    for name, path, old, new in CASES:
        src = io.open(path, encoding="utf-8").read()
        if old not in src:
            print(f"✗ {name}:变异点找不到 —— {path} 里没有 {old[:48]!r}")
            failed += 1
            continue
        mutated = src.replace(old, new, 1)
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
