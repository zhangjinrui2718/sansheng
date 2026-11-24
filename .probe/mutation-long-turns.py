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
    "tests/platform/turn-events.test.ts",
    "tests/web/turn-log-refresh.test.ts",
]

MUTATIONS = [
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
    originals: dict[str, str] = {}
    results: list[tuple[str, str, bool, str]] = []
    for mid, path, old, new, note in MUTATIONS:
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
