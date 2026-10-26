#!/usr/bin/env python3
"""变异自检:真的改坏一处 ⇒ 断言测试变红 ⇒ 改回来。

⚠️ AGENTS.md 的纪律:「在语句前面加个注释」不是变异;「str.replace 不匹配」
静默不执行 ⇒ 每次都必须**断言那行确实变了**(本脚本 `apply` 找不到就退出码 3)。
"""
import subprocess
import sys

MUTATIONS = [
    # (名字, 文件, 旧文本, 新文本, 期望变红的测试)
    ("M1 平台通知也端上来(去掉 kind='user' 那一半)",
     "src/platform/storage/repo/sessions.ts",
     "AND (agent_id = ? OR (agent_id IS NULL AND kind = 'user'))",
     "AND (agent_id = ? OR agent_id IS NULL)",
     "tests/platform/agent-conversations.test.ts"),
    ("M2 窗口从头顶切(回到 bug:交出去最早 N 条)",
     "src/platform/transport/http.ts",
     "const rows = truncated ? fetched.slice(fetched.length - limit) : fetched;",
     "const rows = truncated ? fetched.slice(0, limit) : fetched;",
     "tests/platform/agent-conversations.test.ts"),
    ("M3 截断标志拿 length===limit 判(恰好 limit 条会误报)",
     "src/platform/transport/http.ts",
     "const truncated = fetched.length > limit;",
     "const truncated = fetched.length >= limit;",
     "tests/platform/agent-conversations.test.ts"),
    ("M4 顺序倒回去(新的在前)",
     "src/platform/storage/repo/sessions.ts",
     ".all(sessionId, agentId, n) as RawMessage[];\n  return rows.reverse().map(toSessionMessageRow);",
     ".all(sessionId, agentId, n) as RawMessage[];\n  return rows.map(toSessionMessageRow);",
     "tests/platform/agent-conversations.test.ts"),
    ("M5 前端:条数拿这一页的长度冒充",
     "web/src/components/members/AgentConversations.tsx",
     "const total = lines.reduce((n, l) => n + l.messageCount, 0);",
     "const total = messages.length;",
     "tests/web/members-conversations.test.ts"),
    ("M6 前端:「读不到」显示成「共 0 条」",
     "web/src/components/members/AgentConversations.tsx",
     '{error !== null ? "读不到" : known ? `共 ${total} 条` : "正在读取…"}',
     '{error !== null ? `共 ${total} 条` : known ? `共 ${total} 条` : "正在读取…"}',
     "tests/web/members-conversations.test.ts"),
    ("M7 前端:正文截断到 90 字(回到旧摘要读法)",
     "web/src/components/members/AgentConversations.tsx",
     "<Markdown text={m.content} />",
     "<Markdown text={m.content.slice(0, 90)} />",
     "tests/web/members-conversations.test.ts"),
    ("M8 前端:思考混进正文",
     "web/src/components/members/AgentConversations.tsx",
     'if (b.kind === "text") text += b.text;\n    else if (b.kind === "thinking") thinking += b.text;',
     'if (b.kind === "text") text += b.text;\n    else if (b.kind === "thinking") text += b.text, thinking += b.text;',
     "tests/web/members-conversations.test.ts"),
    # ── 两条守 C10 静态接线(「读不到」≠「没有发言」那条搬了落点)──────────
    ("M9 不把取数错误传下去(error 恒 null)",
     "web/src/components/members/AgentConversations.tsx",
     "error={conv.error}",
     "error={null}",
     "tests/web/c10-dead-code.test.ts"),
    ("M10 拿到 error 也走「共 N 条」(拿 total 冒充)",
     "web/src/components/members/AgentConversations.tsx",
     '{error !== null ? "读不到" : known ? `共 ${total} 条` : "正在读取…"}',
     '{known ? `共 ${total} 条` : "正在读取…"}',
     "tests/web/c10-dead-code.test.ts"),
]


def apply(path: str, old: str, new: str) -> bool:
    with open(path, encoding="utf-8") as f:
        s = f.read()
    if old not in s:
        print(f"!! 变异点没找到:{path} :: {old[:60]}")
        return False
    if s.count(old) != 1:
        print(f"!! 变异点不唯一({s.count(old)} 次):{path} :: {old[:60]}")
        return False
    s2 = s.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(s2)
    # 断言「改后那一行确实变了」(AGENTS.md:str.replace 不匹配会静默不执行)
    with open(path, encoding="utf-8") as f:
        after = f.read()
    if new not in after or after == s:
        print(f"!! 改完那一行没变:{path}")
        return False
    return True


def run(test: str) -> int:
    r = subprocess.run(
        ["npx", "vitest", "run", test],
        capture_output=True, text=True,
    )
    return r.returncode


def main() -> int:
    failures = []
    for name, path, old, new, test in MUTATIONS:
        print(f"\n=== {name} ===")
        if not apply(path, old, new):
            failures.append((name, "变异没落地"))
            continue
        rc = run(test)
        if rc == 0:
            print(f"✗ 测试仍然全绿 ⇒ 这条变异**没被测到**({test})")
            failures.append((name, "测试仍然全绿"))
        else:
            print(f"✓ 测试变红(退出码 {rc})")
        # 改回来(逆向替换)
        if not apply(path, new, old):
            failures.append((name, "改不回来!"))
        else:
            print("  (已改回来)")
    print("\n================ 汇总 ================")
    if failures:
        for n, why in failures:
            print(f"✗ {n}: {why}")
        return 1
    print("✓ 全部变异都实测变红")
    return 0


if __name__ == "__main__":
    sys.exit(main())
