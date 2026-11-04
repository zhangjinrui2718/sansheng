#!/usr/bin/env python3
"""把 AgentConversations 的手写四态链换成 ui/DataState。

纪律:每一步都断言「确实改了」(str.replace 不匹配时静默不动 = 第 3 类静默失败)。
"""
import io
import re
import sys

PATH = "web/src/components/members/AgentConversations.tsx"

OPEN_OLD = """        {error !== null ? (
          <div className="ss-note" style={{ color: "var(--cinnabar)" }}>
            {`对话内容读不到:${error} —— 这一次请求失败了,所以下面不是「他一句话都没说过」。`}
          </div>
        ) : !known ? (
          <div className="ss-note">正在读取对话内容…</div>
        ) : lines.length === 0 ? (
          <div className="ss-note">
            {`${agentName}在这个项目里还没有留下任何发言记录。`}
          </div>
        ) : (
          <details className="ss-disclosure">
"""

OPEN_NEW = """        <DataState
          what="对话内容"
          variant="note"
          state={convState}
          errorLabel="对话内容读不到"
          errorNote=" —— 这一次请求失败了,所以下面不是「他一句话都没说过」。"
          loadingLabel="正在读取对话内容…"
        >
          {(rows) =>
            rows.length === 0 ? (
              <div className="ss-note">
                {`${agentName}在这个项目里还没有留下任何发言记录。`}
              </div>
            ) : (
              <details className="ss-disclosure">
"""

CLOSE_OLD = """          </details>
        )}
"""

CLOSE_NEW = """              </details>
            )
          }
        </DataState>
"""

IMPORT_OLD = 'import { Pill } from "@/components/ui/primitives";'
IMPORT_NEW = (
    'import { Pill } from "@/components/ui/primitives";\n'
    'import { DataState, remoteListOf } from "@/components/ui/DataState";'
)

KNOWN_OLD = """  const known = error === null && !(loading && lines.length === 0);"""
KNOWN_NEW = """  /**
   * 这块读面的**唯一判据** —— 四态只在这里算一次。
   * ⚠️ 原来下面是 `known = error === null && !(loading && lines.length === 0)`,
   * 而那个四态链又**自己算了一遍**(error / !known / 空)⇒ 两处各算一次,
   * 迟早算出不一样的结果(那正是「同一个东西两个地方说法不一样」那类病)。
   */
  const convState = remoteListOf(lines, loading, error);
  const known = convState.kind === "ready";"""

HEADER_OLD = """            {error !== null ? "读不到" : known ? `共 ${total} 条` : "正在读取…"}"""
HEADER_NEW = """            {convState.kind === "error"
              ? "读不到"
              : known
                ? `共 ${total} 条`
                : "正在读取…"}"""


def indent_block(text: str) -> str:
    """给块里每一行加两格缩进(空行不动)。"""
    out = []
    for line in text.split("\n"):
        out.append(("  " + line) if line.strip() else line)
    return "\n".join(out)


def main() -> int:
    src = io.open(PATH, encoding="utf-8").read()

    for marker in (OPEN_OLD, CLOSE_OLD, IMPORT_OLD, KNOWN_OLD, HEADER_OLD):
        assert marker in src, f"标记找不到:{marker[:60]!r}"

    # 1) 取出 <details>…</details> 整块(在链的内部)
    head, sep, tail = src.partition(OPEN_OLD)
    assert sep, "链的开头没找到"
    details, sep2, rest = tail.partition(CLOSE_OLD)
    assert sep2, "链的结尾没找到"
    # ⚠️ OPEN_OLD 已经吃掉了 `<details …>` 那一行、CLOSE_OLD 吃掉了 `</details>` 那一行
    # ⇒ 这一段是**内容**,里面不该再有 details 标签
    assert "<details" not in details
    assert "</details>" not in details

    # 2) 重新拼:DataState 包裹 + details 整块缩进两格
    body = indent_block(details)
    new_block = OPEN_NEW + body + CLOSE_NEW
    src = head + new_block + rest

    src = src.replace(IMPORT_OLD, IMPORT_NEW, 1)
    src = src.replace(KNOWN_OLD, KNOWN_NEW, 1)
    src = src.replace(HEADER_OLD, HEADER_NEW, 1)

    io.open(PATH, "w", encoding="utf-8").write(src)
    print("已改:", PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
