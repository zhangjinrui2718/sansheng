#!/usr/bin/env python3
"""「停止对话的能力」这一波的变异自检。

纪律(AGENTS.md「三类静默失败」第三节 + 2026-10-26 的两条补充):
  - 变异必须**真的改写语句**(删条件、换字面量),不是加个注释 ——
    「在语句前面加个注释」不会让语句失效,那样「改坏了却全绿」是假的;
  - `str.replace` 不匹配时**静默不执行** ⇒ 每一步都断言「改后与改前不同」;
  - 复原后断言**与原文逐字相同**(不用 `git checkout --`:未入库的新文件它会直接报错);
  - runner 覆盖**本波所有判据所在的文件**;
  - ⚠️ **「变红」不等于「判据有效」** —— 变红可能是**语法错**或**编译错**
    ⇒ 本脚本额外判「红的原因」:输出里出现 `Transform failed` / `Failed Suites`
    ⇒ 这条变异**不算数**。

这一波要守的现场(用户原话):「和业务经理聊天的时候 没有停止对话的能力」——
中断入口的可见性此前**只数本地在飞的轮**,于是刷新之后那盏灯写着「推演中」,
而手上没有任何办法停下来。
"""
import io
import subprocess
import sys

TEST_FILES = ["tests/web/interrupt-stop.test.ts", "tests/platform/interrupt-live.test.ts"]
DATA = "web/src/lib/data.ts"
COMPOSER = "web/src/components/chat/ChatComposer.tsx"
SURFACE = "web/src/components/chat/ChatSurface.tsx"
STORE = "web/src/stores/chat.ts"

CASES = [
    (
        "M1 判据不看服务端那份运行态(刷新之后中断入口凭空消失)",
        DATA,
        [(
            "  if (remote === null) return false;\n  return remote.client || remote.internal;",
            "  if (remote === null) return false;\n  return false;",
        )],
    ),
    (
        "M2 「读不到」被当成「在跑」(摆一个按下去必然无效的按钮)",
        DATA,
        [(
            "  if (remote === null) return false;\n  return remote.client || remote.internal;",
            "  if (remote === null) return true;\n  return remote.client || remote.internal;",
        )],
    ),
    (
        "M3 输入区里那个停止按钮被删掉",
        COMPOSER,
        [("        {interruptible && (", "        {false && (")],
    ),
    (
        "M4 Esc 的武装条件退回「输入框被禁用」(刷新之后 Esc 又不灵)",
        COMPOSER,
        [(
            "  const canInterrupt = !!interruptible && !!onInterrupt;",
            '  const canInterrupt = !!disabled && reason === "streaming" && !!onInterrupt;',
        )],
    ),
    (
        "M5 `runtime !== \"host\"` 不再看(把「读不到」说成「一个人都没在跑」)",
        STORE,
        [(
            "        const live = (await api.getProjectLive(projectId as string)).live;\n"
            "        if (live.runtime !== \"host\") {\n"
            "          set({ remoteRunning: null });\n"
            "          return;\n"
            "        }\n",
            "        const live = (await api.getProjectLive(projectId as string)).live;\n",
        )],
    ),
    (
        "M6 服务端说「他正忙着」不再记成运行态证据(于是又没有中断入口)",
        STORE,
        [(
            '        if (e.error.code === "busy") {',
            '        if (e.error.code === "__never__") {',
        )],
    ),
    (
        "M7 页头的中断按钮退回「只看本地在飞的轮」",
        SURFACE,
        [("          {interruptible && (", "          {liveCount > 0 && (")],
    ),
    (
        "M8 「他正忙着」那条拒收不过期(「他在跑」变成一句过期的事实)",
        STORE,
        [(
            '            error: s.error?.code === "busy" ? null : s.error,',
            "            error: s.error,",
        )],
    ),
    (
        "M9 「他正忙着」那条拒收在对话页看不见(用户以为消息到了)",
        "web/src/components/chat/MessageList.tsx",
        [(
            '          {error && (status === "error" || error.code === "busy") && (',
            '          {error && status === "error" && (',
        )],
    ),
    (
        "M10 甲方那条消息登记的触发维度不对(前端会把业务经理这一轮读成「内部在跑」)",
        "src/platform/host/serve.ts",
        [(
            '    hub.setBusy(projectId, bm.id, true, { kind: "user" });',
            '    hub.setBusy(projectId, bm.id, true, { kind: "todo", todoKind: "handover" });',
        )],
    ),
    (
        "M11 中断之后闩不释放(界面一直亮着一个按了没用的按钮)",
        "src/platform/host/serve.ts",
        [(
            "      hub.setBusy(projectId, bm.id, false);",
            "      // 闩不释放(变异)",
        )],
    ),
    (
        "M12 左栏把「他正忙着」说成「加载失败」(一句关于系统状态的假话)",
        "web/src/components/shell/HistoryRail.tsx",
        [(
            '            {error.code.endsWith("_load_failed") ? `加载失败: ${error.message}` : error.message}',
            "            加载失败: {error.message}",
        )],
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
    """红在**断言**上(测试跑到并断言失败),而不是红在语法/编译/模块加载上。

    ⚠️ **「Failed Tests」才是判据** —— vitest 把两种红分开报:
      · `Failed Suites`  = 模块没加载起来(语法错 / 导入错 / 编译错)
        ⇒ 断言**根本没被问到**,不算数;
      · `Failed Tests`   = 测试跑到了、断言失败(或测试自己 `throw` 了一个错)
        ⇒ 这才是「判据抓到了」。
    """
    if "Transform failed" in output or "Failed Suites" in output:
        return False
    if "Failed Tests" in output:
        return True
    return "AssertionError" in output or "expected" in output


def main() -> int:
    code, out = run_tests()
    if code != 0:
        print("基线就是红的 —— 先修好再谈变异")
        print(out[-3000:])
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
