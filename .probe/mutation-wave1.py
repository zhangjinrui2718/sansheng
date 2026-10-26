#!/usr/bin/env python3
"""Wave 1(地址承载 UI 状态)的变异自检。

仓库纪律(AGENTS.md「三类静默失败」第 3 条):**「测试是绿的」在变异实测过之前不算数**。
两条必须同时成立:
  ① 变异要**真的改坏语句**(不是加注释 —— 注释不会让语句失效);
  ② 每次变异后要**断言那一行确实变了**,否则 `str.replace` 不匹配会静默不执行。

用法:`python3 .probe/mutation-wave1.py`
"""
import io
import subprocess
import sys

ROOT = "/root/projects/sansheng"

CASES = [
    (
        "M1 未知路由保留陌生参数(不该保留)",
        "web/src/lib/route.ts",
        "  if (!isRoute(route)) return HOME;",
        "  if (!isRoute(route)) return { route: \"chat\", params };",
        ["tests/web/app-route.test.ts"],
    ),
    (
        "M2 地址不排序(同一份状态两个地址)",
        "web/src/lib/route.ts",
        "    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))\n",
        "",
        ["tests/web/app-route.test.ts"],
    ),
    (
        "M3 裸 decodeURIComponent(手打 %% 抛错)",
        "web/src/lib/route.ts",
        "    return decodeURIComponent(s);\n  } catch {",
        "    return s;\n  } catch {",
        ["tests/web/app-route.test.ts"],
    ),
    (
        "M4 App 退回页面私有路由 state",
        "web/src/App.tsx",
        "  const route = loc.route;",
        "  const [, setRoute] = useState<Route>(\"chat\");\n  const route: Route = \"chat\";",
        ["tests/web/app-route.test.ts"],
    ),
    (
        "M5 成员选中项退回页面 state(刷新即失忆)",
        "web/src/routes/Members.tsx",
        '  const activeId = paramOf(loc, "member");',
        "  const activeId = useState<string | null>(null)[0];",
        ["tests/web/app-route.test.ts"],
    ),
    (
        "M7 工作项选中项退回页面 state(地址不可分享)",
        "web/src/routes/Works.tsx",
        '  const picked: string | null | undefined = paramOf(loc, "work") ?? undefined;',
        "  const picked: string | null | undefined = useState<string | null | undefined>(undefined)[0];",
        ["tests/web/app-route.test.ts"],
    ),
    (
        "M6 toRoute 保留旧参数(跨页噪音)",
        "web/src/lib/route.ts",
        "export function toRoute(route: Route, params: Record<string, string> = {}): AppLocation {",
        "export function toRoute(route: Route, params: Record<string, string> = { stale: \"1\" }): AppLocation {",
        ["tests/web/app-route.test.ts"],
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
