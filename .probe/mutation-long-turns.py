#!/usr/bin/env python3
# 变异自检:.probe/mutation-long-turns.py
# 「让回合可以跑得久」批次(2026-11-25:看门狗 / 补话 / 轨迹逐条落库)的回归有没有真的咬合。
# 写法与纪律照抄 .probe/mutation-multica-borrow.py:
#   每条变异**真的移除/改写语句**(不是加注释),且:
#   ① 断言「改后那一行确实变了」(str.replace 不匹配时静默不执行 —— 本项目第 2 类静默失败);
#   ② 红的原因必须是 Failed Tests —— Transform failed / Failed Suites(语法/编译错)不算数;
#   ③ 复原按内存原文写回 + 断言逐字相同。
# ⚠️ 脚本运行期间会临时改写源码 —— 那段时间**不要同时编辑这些文件**。
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 本批全部判据所在的文件(runner 必须覆盖全 —— 只跑一个文件会把「改坏了却绿」
# 误判成「没改坏」,Wave 2d 的教训)。
TESTS = [
    # ③ 轨迹逐条落库
    "tests/platform/turn-events.test.ts",
    "tests/web/turn-log-refresh.test.ts",
    # ① 看门狗 + bash 默认超时
    "tests/platform/turn.test.ts",
    "tests/platform/execution.test.ts",
    "tests/platform/bash-timeout.test.ts",
    "tests/platform/agent-runtime-events.test.ts",
    "tests/platform/turn-watchdog-host.test.ts",
    # ② 补话
    "tests/platform/steer.test.ts",
    "tests/web/steer-note.test.ts",
    # 缺陷修复:SDK 重试成功后不再当故障处置
    "tests/platform/provider-failure.test.ts",
]

MUTATIONS = [
    # ── 顺带修复:SDK 自己重试成功 ⇒ 不是 provider 故障(turn.ts)──────
    (
        "R1",
        "src/platform/runtime/turn.ts",
        "        providerError = undefined;\n      }\n      return;\n    }",
        "        /* MUT: 不清掉 —— 一次被救回来的抖动仍被当成故障 */\n      }\n      return;\n    }",
        "重试成功后故障不清(误报 provider_error / 误降级 / 待办不消费)⇒ provider-failure ① 与 ⑨ 红",
    ),
    # ── ② 补话:判据(runtime/steer.ts)──────────────────────────────
    (
        "T1",
        "src/platform/runtime/steer.ts",
        "  if (input.entry.trigger?.kind !== \"user\") {",
        "  if (false) { /* MUT: 不管这一轮是谁触发的 */",
        "往内部任务里也补话(对方在跑汇报 / 整合时插进去会混进一件无关的活)⇒ steer 端到端「内部任务」红",
    ),
    (
        "T2",
        "src/platform/runtime/steer.ts",
        "  if ((input.line ?? input.runningLine) !== input.runningLine) {",
        "  if (false) { /* MUT: 不管发在哪条线上 */",
        "别的线上的话也被补进主对话这一轮(答非所问)⇒ steer 端到端「另一条线」红",
    ),
    (
        "T3",
        "src/platform/runtime/steer.ts",
        "  if (input.entry.steered() >= MAX_STEERS_PER_TURN) return { ok: false, reason: \"cap\" };\n",
        "  /* MUT: 不设上限 */\n",
        "一轮可以无限补话(回合被拖成没完没了)⇒ steer「第 4 句」红",
    ),
    (
        "T4",
        "src/platform/runtime/steer.ts",
        "  if (added.includes(steeredText)) return steeredText;\n  return added.length > 0 ? added[added.length - 1]! : steeredText;",
        "  return steeredText; /* MUT: 目标文本永远按原话 */",
        "回执目标不认 SDK 展开后的文本(原话被展开过就永远认不出回执)⇒ steer「展开过」红",
    ),
    (
        "T5",
        "src/platform/runtime/steer.ts",
        "  return deliveredText === target;",
        "  return deliveredText.length > 0; /* MUT: 正文对不上也算 */",
        "回执不逐字比(任何用户消息都算送达)⇒ 纯判据红",
    ),
    # ── ② 补话:宿主接线(serve.ts)───────────────────────────────
    (
        "T6",
        "src/platform/host/serve.ts",
        "          p.target = steerTargetOf(steerState.lastSteering, ev.steering, p.text);",
        "          p.target = p.text; /* MUT: 不认队列快照 */",
        "队列快照不再用来定目标文本(第一版真实缺陷:登记晚于快照)⇒ steer「展开过」红",
    ),
    (
        "T7",
        "src/platform/host/serve.ts",
        "        ? consumeQueuedClientMessages(db, steerState.delivered, now())\n        : 0;",
        "        ? consumeQueuedClientMessages(db, steerState.delivered, now())\n        : consumeQueuedClientMessages(db, steerState.delivered, now()); /* MUT: 没成功收尾也销账 */",
        "回没收尾成功也把补话销账(话送到了、可这一轮随后被打断 —— 那句话其实没得到回应)⇒ steer「送到了但被中断」红",
    ),
    (
        "T8",
        "src/platform/host/serve.ts",
        "      if (steerState.pending.length > 0 || !turnOk) sessionRef?.clearQueue?.();",
        "      if (false) sessionRef?.clearQueue?.(); /* MUT: 不清 SDK 队列 */",
        "没送达的补话留在 SDK 队列里(下一轮说两遍)⇒ steer「没赶上」「不相关的消息」红",
    ),
    (
        "T9",
        "src/platform/host/serve.ts",
        "        const at = steerState.pending.findIndex((p) => isSteerReceipt(ev.text, p.target));",
        "        const at = steerState.pending.length > 0 ? 0 : -1; /* MUT: 任何用户消息都算回执 */",
        "一条不相关的用户消息被当成送达回执(那半句被丢掉、账被销掉)⇒ steer「不相关的消息」红",
    ),
    (
        "T10",
        "src/platform/host/serve.ts",
        "    if (await trySteer(projectId, content, sessionId, rowId, userMessageId)) return;",
        "    if (false && await trySteer(projectId, content, sessionId, rowId, userMessageId)) return; /* MUT: 永远排队 */",
        "补话入口死接线(忙时的话永远排队)⇒ steer 端到端正样本红",
    ),
    (
        "T11",
        "src/platform/host/serve.ts",
        "      hasSteer: entry?.steer !== null && entry?.steer !== undefined,",
        "      hasSteer: false, /* MUT: 永远报「会话不能补」 */",
        "判据被喂了假的「不能补」⇒ steer 端到端正样本红",
    ),
    (
        "T12",
        "src/platform/runtime/agentRuntime/pi/events.ts",
        "      return { type: \"user_message_start\", text: userTextOf(ev.message.content) };",
        "      return null; /* MUT: 送达回执被丢弃 */",
        "用户的 message_start 不翻译(回执永远认不到)⇒ steer 正样本 + agent-runtime-events 红",
    ),
    (
        "T13",
        "src/platform/runtime/agentRuntime/pi/session.ts",
        "    ...(isSteerableSession(pi)\n      ? {",
        "    ...(false && isSteerableSession(pi)\n      ? {",
        "端口不暴露 steer / clearQueue(适配器把能力吞了)⇒ steer 端到端全红",
    ),
    # ── ② 补话:前端 ────────────────────────────────────────────
    (
        "T14",
        "web/src/stores/chat.ts",
        "          steeredNote: { projectId: e.projectId, sessionId: e.sessionId, messageId: e.messageId },",
        "          steeredNote: null, /* MUT: 不记提示 */",
        "message_steered 被忽略(用户不知道这句话补进去了)⇒ steer-note 红",
    ),
    (
        "T15",
        "web/src/stores/chat.ts",
        "            steeredNote: s.steeredNote !== null && s.steeredNote.sessionId === e.sessionId\n              ? null\n              : s.steeredNote,",
        "            steeredNote: s.steeredNote, /* MUT: 不过期 */",
        "补话提示永远挂着(那一轮早就结束了)⇒ steer-note 红",
    ),
    (
        "T16",
        "web/src/features/chat/ChatSurface.tsx",
        "    if (!text || !hasKey || !hasContext) return false;",
        "    if (!text || clientBusy || !hasKey || !hasContext) return false; /* MUT: 回答期间又发不出去了 */",
        "回答期间输入框又被拦(补话够不着)⇒ steer-note 接线哨兵红",
    ),
    (
        "T17",
        "web/src/features/chat/ChatSurface.tsx",
        "    (t) => t.origin.source === \"turn\" && t.origin.trigger.kind === \"user\" && t.sessionId === sessionId,",
        "    (t) => t.sessionId === sessionId, /* MUT: 播报轮也算补得进去 */",
        "状态行对播报轮也说「会补进这一轮」(一句假话)⇒ steer-note 同源哨兵红",
    ),
    (
        "T18",
        "web/src/features/chat/ChatComposer.tsx",
        "                    \"正在回答 · 现在发的话会补进这一轮 · Esc 中断\"",
        "                    \"就绪\" /* MUT: 什么都不说 */",
        "回答期间状态行说「就绪」(用户不知道发的话走哪一条)⇒ steer-note 红",
    ),
    # ── ③ 轨迹逐条落库 ─────────────────────────────────────────────
    # ── ① 看门狗:三道闸的判据(turn.ts)──────────────────────────
    (
        "W1",
        "src/platform/runtime/turn.ts",
        "    if (inflight.size === 0 && now - lastEventAt >= idleMs) stopTurn(\"idle\");",
        "    if (false) stopTurn(\"idle\"); /* MUT: 无进展判据失效 */",
        "无进展这一道闸失效 ⇒ 回合静默到天荒地老 ⇒ turn ① / execution / 宿主① 红",
    ),
    (
        "W2",
        "src/platform/runtime/turn.ts",
        "    if (inflight.size === 0 && now - lastEventAt >= idleMs) stopTurn(\"idle\");",
        "    if (now - lastEventAt >= idleMs) stopTurn(\"idle\"); /* MUT: 不看有没有工具在跑 */",
        "无进展不看「有没有工具在跑」⇒ 一次安静的 npm install 被当成卡死 ⇒ turn ① 负样本红",
    ),
    (
        "W3",
        "src/platform/runtime/turn.ts",
        "      if (now - rec.startedAt >= toolMs + toolWatchdogSlackMs(toolMs)) {",
        "      if (false) { /* MUT: 单工具判据失效 */",
        "单工具这一道闸失效 ⇒ 卡死在一条命令上的回合永远不停 ⇒ turn ② / 宿主① 红",
    ),
    (
        "W4",
        "src/platform/runtime/turn.ts",
        "  const unsub = opts.session.subscribe((ev: RuntimeEvent) => {\n    lastEventAt = Date.now();",
        "  const unsub = opts.session.subscribe((ev: RuntimeEvent) => {\n    /* MUT: 活动时刻不刷新 */",
        "事件不再刷新「最后活动时刻」⇒ 一直在出声的回合也被判无进展 ⇒ turn ① 负样本红",
    ),
    (
        "W5",
        "src/platform/runtime/turn.ts",
        "      if (toolCalls.length >= maxToolCalls) {",
        "      if (false) { /* MUT: 次数判据失效 */",
        "工具次数这一道闸失效(「每步都快但永不收敛」没人拦)⇒ turn ③ / 宿主① 红",
    ),
    (
        "W6",
        "src/platform/runtime/turn.ts",
        "export const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 0;",
        "export const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 600_000; /* MUT: 缺省回到 10 分钟总时长 */",
        "缺省回到 10 分钟总时长(与「还在不在动」无关的旧闸)⇒ turn 的缺省判据红",
    ),
    (
        "W7",
        "src/platform/runtime/turn.ts",
        "      rows.push(tail(\"marker\", turnStopMarker(stopCause, timeoutScene()), true));",
        "      rows.push(tail(\"marker\", \"超时打断\", true)); /* MUT: 原因不落库 */",
        "轨迹标记不再写明是哪一道闸 ⇒ 事后分不清「跑得久」与「不动了」⇒ turn-events 红",
    ),
    (
        "W8",
        "src/platform/runtime/turn.ts",
        "  return Math.min(5_000, Math.floor(toolMs / 10));",
        "  return 0; /* MUT: 没有宽限 */",
        "宽限归零 ⇒ 自带超时的工具来不及自己收场就被整回合打断 ⇒ 纯判据红",
    ),
    (
        "W9",
        "src/platform/runtime/turn.ts",
        "      if (now - rec.startedAt >= toolMs + toolWatchdogSlackMs(toolMs)) {",
        "      if (now - lastEventAt >= toolMs + toolWatchdogSlackMs(toolMs)) { /* MUT: 按最后输出算 */",
        "单工具窗口按「最后输出」算 ⇒ 一条 tail -f 永不停 ⇒ turn ②(tail -f)红",
    ),
    (
        "W10",
        "src/platform/runtime/turn.ts",
        "export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;",
        "export const DEFAULT_IDLE_TIMEOUT_MS = 60_000; /* MUT */",
        "缺省无进展窗口被改(与旧墙钟同值的承诺破了)⇒ 纯判据红",
    ),
    (
        "W11",
        "src/platform/runtime/turn.ts",
        "export const DEFAULT_MAX_TOOL_CALLS = 200;",
        "export const DEFAULT_MAX_TOOL_CALLS = 2; /* MUT */",
        "缺省次数上限被改 ⇒ 纯判据红",
    ),
    (
        "W12",
        "src/platform/runtime/agentRuntime/pi/events.ts",
        "      return { type: \"tool_update\", toolCallId: ev.toolCallId, toolName: ev.toolName };",
        "      return null; /* MUT: 持续输出被丢弃 */",
        "工具的持续输出不再翻译(看门狗看不到「还在动」)⇒ agent-runtime-events 红",
    ),
    # ── ① bash 的默认超时与封顶(bashTimeout.ts)──────────────────
    (
        "B1",
        "src/platform/runtime/agentRuntime/pi/bashTimeout.ts",
        "  return Math.min(requested, windowSec);",
        "  return requested; /* MUT: 不封顶 */",
        "模型给的更长超时不再封顶 ⇒ bash-timeout 的封顶判据红",
    ),
    (
        "B2",
        "src/platform/runtime/agentRuntime/pi/bashTimeout.ts",
        "  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return windowSec;",
        "  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return 0; /* MUT: 不补默认 */",
        "模型没给超时就不再补默认(0 = SDK 当非法)⇒ bash-timeout 红",
    ),
    (
        "B3",
        "src/platform/runtime/agentRuntime/pi/bashTimeout.ts",
        "          timeout: resolveBashTimeout(params.timeout, windowMs),",
        "          timeout: params.timeout, /* MUT: 补好的值没交给底层 */",
        "包装算了超时却没交给底层 execute(死接线)⇒ bash-timeout 红",
    ),
    # ── ① 会话接线(session.ts)──────────────────────────────────
    (
        "S1",
        "src/platform/runtime/agentRuntime/pi/session.ts",
        "  const sdkCustomTools = bashOverride === null ? customTools : [...customTools, bashOverride];",
        "  const sdkCustomTools = customTools; /* MUT: 包装没交给 SDK */",
        "包装好的 bash 没有真的交给 SDK(模型用的还是没有超时的内置那份)⇒ bash-timeout 接线红",
    ),
    (
        "S2",
        "src/platform/runtime/agentRuntime/pi/session.ts",
        "    ? withBashTimeout(createBashToolDefinition(opts.cwd), toolTimeoutMs)",
        "    ? withBashTimeout(createBashToolDefinition(opts.cwd), 600_000) /* MUT: 窗口与闸不同源 */",
        "bash 的超时写死、不跟单工具窗口(bash 先于闸到点的保证破了)⇒ bash-timeout 的 90s 判据红",
    ),
    (
        "S3",
        "src/platform/runtime/agentRuntime/pi/session.ts",
        "    toolTimeoutMs,\n",
        "    toolTimeoutMs: undefined, /* MUT: 不转交 */\n",
        "窗口不转交给建会话那一层(「宿主传没传」从此不可断言)⇒ 宿主③ 红",
    ),
    # ── ① 宿主接线(serve.ts)—— 只接一条路径等于没接 ─────────────
    (
        "H1",
        "src/platform/host/serve.ts",
        "        // 真机现场走的正是这里,只接 `runAgentTurn` 等于没接。看门狗同理。\n        ...turnLimits(opts),",
        "        // 真机现场走的正是这里,只接 `runAgentTurn` 等于没接。看门狗同理。\n        ...(opts.turnWallClockMs !== undefined ? { wallClockTimeoutMs: opts.turnWallClockMs } : {}), /* MUT: 工作路径不接看门狗 */",
        "工作路径没接看门狗(worker 卡死那 16 分钟的现场走的正是这里)⇒ 宿主① 三条全红",
    ),
    (
        "H2",
        "src/platform/host/serve.ts",
        "        // 「文档说 10 分钟、实际是另一个数」。\n        ...turnLimits(opts),",
        "        // 「文档说 10 分钟、实际是另一个数」。\n        ...(opts.turnWallClockMs !== undefined ? { wallClockTimeoutMs: opts.turnWallClockMs } : {}), /* MUT: 聊天路径不接看门狗 */",
        "聊天路径没接看门狗 ⇒ 宿主② 红",
    ),
    (
        "H3",
        "src/platform/host/serve.ts",
        "        ...(opts.turnToolMs !== undefined ? { toolTimeoutMs: opts.turnToolMs } : {}),",
        "        /* MUT: 窗口不进会话 */",
        "宿主没把单工具窗口交给会话工厂 ⇒ 宿主③ 红",
    ),
    (
        "H4",
        "src/platform/host/serve.ts",
        "    ...(opts.turnMaxToolCalls !== undefined ? { maxToolCalls: opts.turnMaxToolCalls } : {}),",
        "    /* MUT: 漏了次数上限 */",
        "turnLimits 漏掉次数上限(两条路径同时失效)⇒ 宿主① 次数那条红",
    ),
    # ── ③ 轨迹逐条落库 ─────────────────────────────────────────────
    (
        "L1",
        "src/platform/runtime/turn.ts",
        "    if (ev.type === \"tool_end\") {\n      const started = inflight.get(ev.toolCallId);\n      const record: ToolCallRecord = {",
        "    opts.onEvent?.(ev); /* MUT: 广播挪到落库之前 */\n    if (ev.type === \"tool_end\") {\n      const started = inflight.get(ev.toolCallId);\n      const record: ToolCallRecord = {",
        "先广播后落库(观察者收到 tool_end 时那一行还没写)⇒ turn-events ⑤「先落库后广播」红",
    ),
    (
        "L2",
        "src/platform/runtime/turn.ts",
        "    if (!eventWriteFailed) rows.push(tail(\"turn_end\", \"\", false));",
        "    if (false) rows.push(tail(\"turn_end\", \"\", false)); // MUT",
        "收口行永远不写 ⇒ 所有回合都读成「未结束」⇒ turn-events 红",
    ),
    (
        "L3",
        "src/platform/runtime/turn.ts",
        "    if (!eventWriteFailed) rows.push(",
        "    if (true) rows.push(",
        "写入失败过的回合也盖「已结束」的章(缺行被读成全部)⇒ turn-events ⑥ 红",
    ),
    (
        "L4",
        "src/platform/transport/http.ts",
        "    if (r.kind === \"turn_end\") {\n      turn.finished = true;\n      continue;\n    }",
        "    if (r.kind === \"turn_end\") {\n      /* MUT: 不认收口行 */ continue;\n    }",
        "读面不认收口行 ⇒ finished 永远 false ⇒ turn-events ④ 与 HTTP 读面红",
    ),
    (
        "L5",
        "src/platform/transport/http.ts",
        "    if (r.kind === \"turn_end\") {\n      turn.finished = true;\n      continue;\n    }",
        "    if (r.kind === \"turn_end\") {\n      turn.finished = true;\n    }",
        "收口行混进事件列表(凭据被当成一次调用)⇒ turn-events 红",
    ),
    (
        "L6",
        "web/src/stores/chat.ts",
        "          turnLogRevision:\n            e.projectId === s.projectId ? s.turnLogRevision + 1 : s.turnLogRevision,\n        }));\n        // 只更新**它自己那个 messageId** 的那一轮里的那张工具卡。找不到就丢。",
        "          turnLogRevision: s.turnLogRevision, /* MUT: 不敲 */\n        }));\n        // 只更新**它自己那个 messageId** 的那一轮里的那张工具卡。找不到就丢。",
        "tool_end 不敲轨迹回查 ⇒ 成员面板那一块永远不长 ⇒ turn-log-refresh ① 红",
    ),
    (
        "L7",
        "web/src/stores/chat.ts",
        "    set((s) => ({ turnLogRevision: s.turnLogRevision + 1 }));\n    // ① 服务端那份",
        "    /* MUT: 重连不敲 */\n    // ① 服务端那份",
        "重连对账不补轨迹(断线期间落库的行永远取不到)⇒ turn-log-refresh ③ 红",
    ),
    (
        "L8",
        "web/src/lib/data.ts",
        "    [projectId, agentId, revision, turnLogRevision],",
        "    [projectId, agentId, revision], /* MUT */",
        "取数钩子不读 turnLogRevision(敲了也没人重拉)⇒ 接线哨兵红",
    ),
    (
        "L9",
        "web/src/components/members/AgentTurnLog.tsx",
        "        {!turn.finished && <Pill tone=\"mute\">未结束</Pill>}",
        "        {turn.finished && <Pill tone=\"mute\">未结束</Pill>}",
        "「未结束」标记反了(已收口的亮、没收口的不亮)⇒ 界面两条都红",
    ),
    (
        "L10",
        "web/src/components/members/AgentTurnLog.tsx",
        "                (failedTotal > 0 ? ` / ${failedTotal} 次失败` : \"\") +\n                (openTotal > 0 ? ` / ${openTotal} 个未结束` : \"\")}",
        "                (failedTotal > 0 ? ` / ${failedTotal} 次失败` : \"\")}",
        "折叠标题不计数(默认收起时看不出有回合在长)⇒ 界面正样本红",
    ),
]


def run_vitest() -> tuple[bool, str]:
    cmd = ["npx", "vitest", "run", *TESTS, "--reporter=dot"]
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as e:
        return False, "vitest 900s 超时(挂死)\n" + ((e.stdout or b"").decode()[-800:] if isinstance(e.stdout, bytes) else str(e.stdout)[-800:])
    out = p.stdout + p.stderr
    if "Transform failed" in out or "Failed Suites" in out:
        return False, "编译/套件级红(不算数 —— 判据根本没被问到)\n" + out[-1500:]
    # ⚠️ 三种结局要分开报(2026-11-25 实测踩到):dot reporter 在全绿时只打
    # 「Tests N passed」、没有 failed 字样 —— 只匹配 failed 会把「没抓住」
    # 误报成「异常退出」,读的人会去查一个不存在的崩溃。
    m = re.search(r"Tests\s+(\d+) failed", out)
    if m is not None:
        return True, f"红(Failed Tests = {m.group(1)})"
    if re.search(r"Tests\s+\d+ passed", out):
        return False, "全绿(变异没被抓住)\n" + out[-1200:]
    return False, "解析不到测试统计(异常退出)\n" + out[-1500:]


def main() -> int:
    # 可选参数 = 只跑指定编号的变异(重跑单条时用:`python3 脚本 T7`)。
    only = set(sys.argv[1:])
    originals: dict[str, str] = {}
    results: list[tuple[str, str, bool, str]] = []
    for mid, path, old, new, note in MUTATIONS:
        if only and mid not in only:
            continue
        full = ROOT / path
        src = full.read_text()
        if path not in originals:
            originals[path] = src
        if old not in src:
            results.append((mid, note, False, "变异点找不到(判据或实现已漂移 —— 先修脚本)"))
            continue
        mutated = src.replace(old, new, 1)
        assert mutated != src, f"{mid} 替换后与原文相同(变异没发生)"
        full.write_text(mutated)
        try:
            ok, detail = run_vitest()
        finally:
            full.write_text(originals[path])
        results.append((mid, note, ok, detail if not ok else "红 ✔"))

    print("\n═══ 变异自检 · 让回合可以跑得久(2026-11-25)═══")
    bad = 0
    for mid, note, ok, detail in results:
        mark = "🔴 变红" if ok else "🟢 漏网"
        if not ok:
            bad += 1
        tail = "\n       ".join((detail or "").splitlines()[:6])
        print(f"{mark}  {mid}  {note}\n       {tail}")
    # 复原核对:逐字相同
    for path, src in originals.items():
        now = (ROOT / path).read_text()
        if now != src:
            print(f"⚠️  {path} 复原不完整")
            bad += 1
    print(f"\n结论:{len(results) - bad}/{len(results)} 条变异实测变红"
          + (" —— 判据有牙 ✅" if bad == 0 else f" —— 有 {bad} 条没咬合 ❌"))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
