#!/usr/bin/env python3
"""「一圈邻居」(RelationsRail)的变异自检。

仓库纪律(AGENTS.md「三类静默失败」第 3 条):**「测试是绿的」在变异实测过之前不算数**。
两条必须同时成立:
  ① 变异要**真的改坏语句**(不是加注释 —— 注释不会让语句失效);
  ② 每次变异后要**断言那一行确实变了**,否则 `str.replace` 不匹配会静默不执行。

⚠️ **复原用「内存里的原文写回」,不用 `git checkout --`** —— 新增文件还没入库时
`git checkout --` 会报 `pathspec … did not match`,于是**变异留在盘上**、脚本自己崩。

用法:`python3 .probe/mutation-relations.py`
"""
import io
import subprocess
import sys

ROOT = "/root/projects/sansheng"

CASES = [
    (
        "M1 「读不到」被说成「没有」(三态合一 —— 这套界面反复吃过这个亏)",
        "web/src/lib/relations.ts",
        '      if (piece === undefined || piece.error !== null) {',
        '      if (false) {',
        ["tests/web/relations.test.ts"],
    ),
    (
        "M2 「还在拉」被说成「没有」(loading 档消失)",
        "web/src/lib/relations.ts",
        "      if (piece.loading) {",
        "      if (false) {",
        ["tests/web/relations.test.ts"],
    ),
    (
        "M3 关系词退成原始 rel 字符串(英文 parent/depends_on 回到屏幕上)",
        "web/src/lib/relations.ts",
        "  parent: \"父工件\",",
        "  parent: \"parent\",",
        ["tests/web/relations.test.ts"],
    ),
    (
        "M4 阻塞的地址丢掉项目 id(半个地址:跳过去落不到点上)",
        "web/src/lib/relations.ts",
        "        to: blockerLocation(b.id, data.projectId),",
        "        to: blockerLocation(b.id),",
        ["tests/web/relations.test.ts", "tests/web/relations-wiring.test.ts"],
    ),
    (
        "M5 链接改成 onClick(右键复制 / 中键 / 后退三件全没了)",
        "web/src/components/relations/RelationsRail.tsx",
        "                    href={toHash(it.to)}",
        "                    href=\"#\" onClick={() => toHash(it.to)}",
        ["tests/web/relations.test.ts"],
    ),
    (
        "M6 读不到时静默(不显示任何字 —— 「读不到」与「没有」在屏幕上长得一样)",
        "web/src/components/relations/RelationsRail.tsx",
        """          {g.state === "unavailable" ? (
            <span className="ss-meta" style={{ marginLeft: 6 }}>
              读不到
            </span>""",
        """          {g.state === "unavailable" ? (
            <span className="ss-meta" style={{ marginLeft: 6 }}>
              无
            </span>""",
        ["tests/web/relations.test.ts"],
    ),
    (
        "M7 关系栏把「作者」也说了(与身份条重叠 = 同一个事实两处说)",
        "web/src/lib/relations.ts",
        '      title: "相关工件",',
        '      title: "作者",',
        ["tests/web/relations.test.ts"],
    ),
    (
        "M8 深链接一打开就被抹掉(首帧不清的判据被去掉)",
        "web/src/lib/route.ts",
        "  if (!state.mounted) return false;",
        "  if (false) return false;",
        ["tests/web/relations-wiring.test.ts"],
    ),
    (
        "M9 换项目时不清旧选择(旧 id 指向别的项目的东西)",
        "web/src/lib/route.ts",
        "  return state.projectId !== nextProjectId;",
        "  return false;",
        ["tests/web/relations-wiring.test.ts"],
    ),
    (
        "M10 工作项页又有了页面私有的 scope(两个「当前项目」)",
        "web/src/routes/Works.tsx",
        '  const scope = useChatStore((s) => s.projectId);',
        '  const scope = useState<string | null>(useChatStore((s) => s.projectId))[0];',
        ["tests/web/relations-wiring.test.ts"],
    ),
    (
        "M11 关系栏从项目页消失(判据在那儿,但没有读者)",
        "web/src/routes/ProjectDetail.tsx",
        """                    <RelationsRail
                      subject={{ kind: "work", work: w }}
                      context={relations}
                      compact
                    />""",
        "",
        ["tests/web/relations-wiring.test.ts"],
    ),
    (
        "M12 关系栏从成员页消失(同上)",
        "web/src/routes/Members.tsx",
        """        <RelationsRail
          subject={{ kind: "member", memberId: member.id }}
          context={relations}
          title="他负责的环节"
        />""",
        "",
        ["tests/web/relations-wiring.test.ts"],
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
        # ⚠️ 断言「改后那一行确实变了」——`str.replace` 不匹配时是**静默**的。
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
