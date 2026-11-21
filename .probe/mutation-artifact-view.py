#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
变异自检:tests/web/artifact-view.test.ts(v5 Wave B 工件视图,2026-11-20)

纪律同 .probe/mutation-stream-cards.py:真改坏语句 + 断言改动生效 + 期望变红 +
内存原文复原且逐字一致。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "tests/web/artifact-view.test.ts"

MUTATIONS = [
    # M1:懒加载拆掉 —— 收起态也挂正文(流背常驻请求)
    ("web/src/components/chat/StreamCards.tsx",
     "const [open, setOpen] = useState(false);",
     "const [open, setOpen] = useState(true);"),
    # M2:markdown 退场 —— 正文回到裸字面量(ArtifactTextBody)
    ("web/src/components/deliverable/ArtifactTextBody.tsx",
     "<Markdown text={data.content} />",
     "{data.content}"),
    # M3:分发不再走 bodyMode(第二份类型判据)
    ("web/src/components/deliverable/InlineDeliverableBody.tsx",
     "switch (bodyMode(artifact)) {",
     "switch (\"text\" as const) {"),
    # M4:文件树挂载点拆掉 —— 交付物回到「一级条目读不到」的形态
    ("web/src/components/deliverable/CodeService.tsx",
     "<FileTree artifactId={artifactId} />",
     "null"),
    # M5:四态塌掉 —— unavailable 渲染成空列表(「读不到」说成「没有文件」)
    ("web/src/components/deliverable/CodeService.tsx",
     "  if (data.runtime !== \"ok\") {\n    return (\n      <RedMeta as=\"div\" color={RED_FALLBACK} data-files-runtime={data.runtime}>",
     "  if (false) {\n    return (\n      <RedMeta as=\"div\" color={RED_FALLBACK} data-files-runtime={data.runtime}>"),
]


def run_tests() -> int:
    r = subprocess.run(
        ["npx", "vitest", "--run", TEST],
        cwd=ROOT, capture_output=True, text=True, timeout=600,
    )
    return r.returncode


def main() -> int:
    failures = []
    for i, (rel, old, new) in enumerate(MUTATIONS, 1):
        path = ROOT / rel
        original = path.read_text(encoding="utf-8")
        if original.count(old) < 1:
            print(f"M{i} SKIP: 变异点没找到({rel}: {old[:40]!r})—— 判据可能已漂移,先看代码")
            failures.append(f"M{i}-missing")
            continue
        mutated = original.replace(old, new, 1)
        if mutated == original:
            print(f"M{i} SKIP: 替换没有生效(变异是假的)")
            failures.append(f"M{i}-noop")
            continue
        path.write_text(mutated, encoding="utf-8")
        try:
            code = run_tests()
        finally:
            path.write_text(original, encoding="utf-8")
        if path.read_text(encoding="utf-8") != original:
            print(f"M{i} FATAL: 复原后与原文不一致 —— 手工检查 {rel}")
            return 2
        status = "RED(判据抓住了)" if code != 0 else "GREEN(判据没生效!)"
        print(f"M{i} [{rel.split('/')[-1]}] -> {status}")
        if code == 0:
            failures.append(f"M{i}-green")
    if failures:
        print("FAIL:", ", ".join(failures))
        return 1
    print(f"全部 {len(MUTATIONS)} 条变异实测变红,复原逐字一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
