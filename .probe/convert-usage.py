#!/usr/bin/env python3
"""把 ProjectDetail 的「用量」四态链换成 ui/DataState。

纪律:每一步都断言「确实改了」(str.replace 不匹配时静默不动 = 第 3 类静默失败)。
"""
import io
import re

PATH = "web/src/routes/ProjectDetail.tsx"

HEAD_OLD = """            {usageError !== null ? (
              <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
                读不到用量:{usageError}
              </div>
            ) : usageLoading && usage === null ? (
              <EmptyState>加载中…</EmptyState>
            ) : usage === null ? (
              // 「还没查过」不是「查过了,是 0」—— 与 useProjectUsage 文件头那条同源。
              <EmptyState>还没有读到用量。</EmptyState>
            ) : (
"""

HEAD_NEW = """            <DataState
              what="用量"
              variant="card"
              state={remoteOf(usage, usageError, usageLoading)}
              errorLabel="读不到用量"
              loadingLabel="加载中…"
              unavailable="还没有读到用量。"
            >
              {(u) => (
"""

TAIL_OLD = """              </div>
            )}
          </Section>
"""

TAIL_NEW = """              </div>
              )}
            </DataState>
          </Section>
"""


def indent_block(text: str) -> str:
    return "\n".join(("  " + ln) if ln.strip() else ln for ln in text.split("\n"))


def main() -> int:
    src = io.open(PATH, encoding="utf-8").read()
    assert HEAD_OLD in src, "链的开头没找到"
    assert TAIL_OLD in src, "链的结尾没找到"

    head, sep, tail = src.partition(HEAD_OLD)
    assert sep
    body, sep2, rest = tail.partition(TAIL_OLD)
    assert sep2

    # 内容里的 `usage.` 全部换成 `u.`(children 的参数)
    renamed, n = re.subn(r"\busage\.", "u.", body)
    assert n >= 6, f"替换的 usage. 太少:{n}"

    src = head + HEAD_NEW + indent_block(renamed) + TAIL_NEW + rest
    io.open(PATH, "w", encoding="utf-8").write(src)
    print(f"已改:{PATH}(替换 usage. {n} 处)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
