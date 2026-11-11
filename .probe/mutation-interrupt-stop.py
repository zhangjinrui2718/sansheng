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

TEST_FILES = [
    "tests/web/interrupt-stop.test.ts",
    "tests/platform/interrupt-live.test.ts",
    "tests/platform/interrupt-before-session.test.ts",
    "tests/web/offline-recovery.test.ts",
    "tests/platform/interrupt.test.ts",
]
DATA = "web/src/lib/data.ts"
COMPOSER = "web/src/components/chat/ChatComposer.tsx"
SURFACE = "web/src/components/chat/ChatSurface.tsx"
STORE = "web/src/stores/chat.ts"
WS = "web/src/lib/ws.ts"
SERVE = "src/platform/host/serve.ts"

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
            "          return null;\n"
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
    # ── 第二波:「按了没反应」的两半 ─────────────────────────────────
    (
        "M13 中断登记挪回 await 之后(「停止」落在建会话那段时间里 ⇒ 落到空气上)",
        "src/platform/host/serve.ts",
        [(
            "    inflight.set(inflightKey, abortThisTurn);\n\n"
            "    const got = await getOrCreateSession({ projectId, agentId, sessionId });",
            "    const got = await getOrCreateSession({ projectId, agentId, sessionId });",
        ), (
            "    const session = got.session;\n    sessionRef = session;",
            "    const session = got.session;\n    sessionRef = session;\n"
            "    inflight.set(inflightKey, abortThisTurn);",
        )],
    ),
    (
        "M14 中断意图不被记下来(用户按了停止,那一轮照跑、照花 token)",
        "src/platform/host/serve.ts",
        [(
            "    const abortThisTurn = (): void => {\n      aborted = true;",
            "    const abortThisTurn = (): void => {\n      aborted = false;",
        )],
    ),
    (
        "M15 按下停止之后不再补问运行态(那盏灯与按钮一直亮着,按下去只被幂等忽略)",
        STORE,
        [(
            "    void get().refreshRunning();\n    return true;\n  },",
            "    return true;\n  },",
        )],
    ),
    (
        "M16 对话页不再定期补问服务端那份运行态(快照过期 ⇒ 灯与按钮永远亮着)",
        SURFACE,
        [(
            "    const t = setInterval(() => void refreshRunning(), REMOTE_WATCH_INTERVAL_MS);",
            "    const t = setInterval(() => void undefined, REMOTE_WATCH_INTERVAL_MS);",
        )],
    ),
    (
        "M17 「服务端那份说在跑吗」恒为否(于是永远不补问)",
        DATA,
        [(
            "export function remoteClaimsRunning(\n"
            "  remote: { readonly client: boolean; readonly internal: boolean } | null,\n"
            "): boolean {\n"
            "  if (remote === null) return false;\n"
            "  return remote.client || remote.internal;\n"
            "}",
            "export function remoteClaimsRunning(\n"
            "  remote: { readonly client: boolean; readonly internal: boolean } | null,\n"
            "): boolean {\n"
            "  if (remote === null) return false;\n"
            "  return false;\n"
            "}",
        )],
    ),
    # ── 第三波:「连接断了」那一格 ───────────────────────────────────
    (
        "M18 传输层断了也回报「发成功了」(静默丢弃 = 用户以为消息到了)",
        WS,
        [(
            "      ws.send(JSON.stringify(cmd));\n"
            "      return true;\n"
            "    }\n"
            "    return false;\n"
            "  }",
            "      ws.send(JSON.stringify(cmd));\n"
            "      return true;\n"
            "    }\n"
            "    return true;\n"
            "  }",
        )],
    ),
    (
        "M19 发送失败时**不撤乐观上屏**(那句话留在屏幕上,假装到了)",
        STORE,
        [(
            "    const delivered = socket.sendToProject(intakeActive ? null : projectId, text, line ?? undefined);\n"
            "    if (!delivered) {",
            "    const delivered = socket.sendToProject(intakeActive ? null : projectId, text, line ?? undefined);\n"
            "    if (delivered) {",
        )],
    ),
    (
        "M20 中断失败时也回报「发出去了」(用户按了没反应,界面还说没事)",
        STORE,
        [(
            '    const delivered = socket.interrupt(intakeActive ? null : projectId, "client");\n'
            "    if (!delivered) {",
            '    const delivered = socket.interrupt(intakeActive ? null : projectId, "client");\n'
            "    if (delivered) {",
        )],
    ),
    (
        "M21 中断入口不看连接状态(亮着一个按下去必然无效的按钮)",
        DATA,
        [(
            '  if (socket !== "open") return false;\n'
            '  const clientOnly = opts.scope === "client";\n'
            "  if (activity.client.length > 0 || (!clientOnly && activity.internal.length > 0)) return true;",
            '  const clientOnly = opts.scope === "client";\n'
            "  if (activity.client.length > 0 || (!clientOnly && activity.internal.length > 0)) return true;",
        )],
    ),
    (
        "M22 过期的那几轮永远不被认出(重连之后输入框还是死锁的)",
        DATA,
        [(
            "  if (runningAgentIds === null) return [];\n"
            "  return turns\n"
            "    .filter((t) => t.agentId !== null && !runningAgentIds.has(t.agentId))\n"
            "    .map((t) => t.id);",
            "  return [];",
        )],
    ),
    (
        "M23 重连之后不对账(本地那张轮表永远留着过期的那几轮)",
        STORE,
        [(
            "    const stale = staleTurnIds(local, runningAgentIds);\n"
            "    if (stale.length === 0) return;",
            "    const stale = staleTurnIds(local, runningAgentIds);\n"
            "    if (stale.length >= 0) return;",
        )],
    ),
    # ── 第四波(2026-11-11):范围收窄 ─────────────────────────────
    # 用户裁决:「我说的停止,是指我和业务经理沟通的时候,当前的对话能终止下来,
    # 而不是终止整个项目在做的事情」⇒ 带 `channel: "client"` 的中断只停甲方通道。
    (
        "M24 服务端忽略 channel(带 client 的中断把内部角色一起停 —— 回到超集)",
        SERVE,
        [(
            "          return channelForAgent(db, agentId) === channel;",
            "          return channel === undefined || channelForAgent(db, agentId) === channel;\n"
            "          // MUT-INVALID",
        )],
    ),
    (
        "M25 对话页不再把 scope 传给判据(前端重新给「停不掉的入口」)",
        SURFACE,
        [(
            "  const interruptible = interruptAvailableOf(activity, remoteRunning, socketStatus, {\n"
            '    scope: "client",\n'
            "  });",
            "  const interruptible = interruptAvailableOf(activity, remoteRunning, socketStatus);",
        )],
    ),
    (
        "M26 传输层把 channel 丢了(指令到了服务端,却退化成停全部)",
        WS,
        [(
            '    return this.send({ type: "interrupt", projectId, ...(channel ? { channel } : {}) });',
            '    return this.send({ type: "interrupt", projectId });',
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
