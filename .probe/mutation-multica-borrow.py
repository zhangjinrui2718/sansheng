#!/usr/bin/env python3
# 变异自检:.probe/mutation-multica-borrow.py
# 「multica 借鉴批次」(2026-11-22,migrations 035–038)的回归有没有真的咬合。
# 每条变异**真的移除/改写语句**(不是加注释),且:
#   ① 断言「改后那一行确实变了」(str.replace 不匹配时静默不执行 —— 本项目第 2 类静默失败);
#   ② 红的原因必须是 Failed Tests —— Transform failed / Failed Suites(语法错)不算数;
#   ③ 复原按内存原文写回 + 断言逐字相同。
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 变异所伤及的判据分布在这些文件里(Wave 2d 的教训:runner 必须覆盖本批全部判据所在文件,
# 只跑一个文件会把「改坏了却绿」误判成「没改坏」)。
TESTS = [
    "tests/platform/turn-events.test.ts",
    "tests/platform/busy-queue.test.ts",
    "tests/platform/busy-latch-granularity.test.ts",
    "tests/platform/d1-d4-parallel-projects.test.ts",
    "tests/platform/work-acceptance.test.ts",
    "tests/platform/wakeups.test.ts",
    "tests/platform/context-overflow.test.ts",
    # 2026-11-25:M13 / M14(上下文超长真的丢弃会话)的判据落在这里。
    "tests/platform/provider-failure.test.ts",
    "tests/platform/dispatcher-rules.test.ts",
    "tests/platform/client.test.ts",
    "tests/platform/design-conformance.test.ts",
]

MUTATIONS = [
    # ── ① 执行日志(035)──────────────────────────────────────────────
    # 2026-11-25(轨迹逐条落库)重新锚定:工具行改成了每次调用结束就写,
    # 收口那一笔只剩故障 / 标记 / 收口行 —— M1 关掉它,红的是这几类的判据
    # (逐条写自己的变异在 .probe/mutation-long-turns.py)。
    (
        "M1",
        "src/platform/runtime/turn.ts",
        "    // 两条出口各跑一次,与用量同一处、同一条纪律)。\n    recordTurnEvents();",
        "    // 两条出口各跑一次,与用量同一处、同一条纪律)。\n    // MUT: recordTurnEvents();",
        "收口的尾部行不写(故障 / 标记 / 收口行全丢)⇒ turn-events 红",
    ),
    (
        "M2",
        "src/platform/runtime/turn.ts",
        "    if (rows.length === 0) return;",
        "    if (rows.length >= 0) return;",
        "写入函数被改成「永远不写」(2026-11-25 起锚在 writeTurnEvents —— 逐条写与收口都走它)⇒ turn-events 全红",
    ),
    # ── ② 忙时排队(036)──────────────────────────────────────────────
    (
        "M3",
        "src/platform/transport/hub.ts",
        "            if (\n              cmd.projectId !== null &&\n              this.handlers.onUserMessageQueued !== undefined\n            ) {",
        "            if (false) {",
        "忙时退回拒收(onUserMessageQueued 死接线)⇒ busy-queue / busy-latch② / d1d4④ 红",
    ),
    (
        "M4",
        "src/platform/runtime/dispatcher.ts",
        "        const m = q === null ? null : getSessionMessage(db, q.messageId);",
        "        const m = getSessionMessage(db, id);",
        "两跳变一跳(账行 id 当消息 id —— 第一版真实 bug)⇒ busy-queue 的「原话进正文」红",
    ),
    (
        "M5",
        "src/platform/runtime/dispatcher.ts",
        "      if (todo.kind === \"answer_client_message\") {\n        const n = consumeQueuedClientMessages(deps.db, todo.refs, deps.now());",
        "      if (false) {\n        const n = consumeQueuedClientMessages(deps.db, todo.refs, deps.now());",
        "排队账不消费(带回后永远 pending)⇒ busy-queue / busy-latch② / d1d4④ 的消费断言红",
    ),
    # ── ③ 工作项判据(037)────────────────────────────────────────────
    (
        "M6",
        "src/platform/transport/views.ts",
        "    acceptanceCriteria: row.acceptanceCriteria,",
        "    acceptanceCriteria: [],",
        "读面永远交空数组(「未给」变「永远没给过」)⇒ work-acceptance 的 WorkView 断言红",
    ),
    (
        "M7",
        "src/platform/runtime/dispatcher.ts",
        "        : \"  **验收判据**:未给(037 结构化判据为空)—— 只能对照上面的 goal 判断\",",
        "        : \"  MUT\",",
        "质检的任务正文里判据块被拆掉 ⇒ work-acceptance 的「未给要明说」红",
    ),
    # ── ④⑤ 唤醒与保险丝(038)────────────────────────────────────────
    (
        "M8",
        "src/platform/runtime/dispatcher.ts",
        "      if (bm === undefined || q.dueWakeups.length === 0) return [];",
        "      if (bm === undefined || q.dueWakeups.length >= 0) return [];",
        "wakeup_due 规则不产待办(唤醒永远没人读)⇒ wakeups 的规则/渲染断言红",
    ),
    (
        "M9",
        "src/platform/storage/repo/wakeups.ts",
        "    ledger\n      .filter((r) => r.notified_at !== null)\n      .map((r) => r.todo_key),",
        "    ledger\n      .filter((r) => r.attempts >= 0)\n      .map((r) => r.todo_key),",
        "熔断不看 notified_at(任何账本行都算烧穿)⇒ wakeups 熔断的 wu_alive 负样本红",
    ),
    (
        "M10",
        "src/platform/storage/repo/wakeups.ts",
        "      if (w.kind === \"at\") return w.at !== null && w.at <= now;\n      const anchor = w.lastFiredAt ?? w.createdAt;\n      return w.intervalMs !== null && w.intervalMs > 0 && now - anchor >= w.intervalMs;",
        "      if (w.kind === \"at\") return w.at !== null && w.at <= now;\n      const anchor = w.lastFiredAt ?? w.createdAt;\n      return w.intervalMs !== null && w.intervalMs > 0 && now - anchor >= w.intervalMs / 2;",
        "周期减半(错过折叠与续期判据漂了)⇒ wakeups 到期谓词红",
    ),
    # ── ⑥ resume-unsafe(context_overflow)──────────────────────────
    (
        "M11",
        "src/platform/runtime/providerFailure.ts",
        "  if (matchesAny(lower, CONTEXT_OVERFLOW_WORDS)) return \"context_overflow\";",
        "  if (false) { if (matchesAny(lower, CONTEXT_OVERFLOW_WORDS)) return \"context_overflow\"; }",
        "超长词表永不命中(退回 unknown ⇒ 换家/记 failed)⇒ context-overflow 分类红",
    ),
    (
        "M12",
        "src/platform/runtime/dispatcher.ts",
        "    if (!aborted && !failed && !failoverApplied && !brakePaused && !sessionReset) {",
        "    if (!aborted && !failed && !failoverApplied && !brakePaused) {",
        "sessionReset 的一轮也消费(被拒说成办过)⇒ context-overflow 的「不消费」红",
    ),
    (
        "M13",
        "src/platform/host/serve.ts",
        "          providerSessionReset = true;\n          disposeOneSession(\n            projectId, sessionId, agentId,\n            \"context overflow(resume-unsafe,下一次派发换新会话)\",\n          );",
        "          providerSessionReset = true; /* MUT: 不丢弃会话 */",
        "工作路径撞超长不再换会话(续跑中毒会话)⇒ provider-failure ⑧ 工作路径的丢弃判据红",
    ),
    # 2026-11-25:上一版 M13 只把 disposeOneSession 的**原因文案**改成 "MUT" —— 会话照样
    # 被丢,而没有任何测试读那句话,所以它从来没咬合过(干净的 master 上实测:施加后
    # context-overflow 照样全绿)。判据补在 provider-failure.test.ts ⑧(按角色记丢弃了谁),
    # M13 改成真的拿掉调用,并补聊天路径那条 M14。
    (
        "M14",
        "src/platform/host/serve.ts",
        "            disposeOneSession(\n              projectId, sessionId, agentId,\n              \"context overflow(resume-unsafe,下一轮换新会话)\",\n            );",
        "            /* MUT: 聊天路径不丢弃会话 */",
        "聊天路径撞超长不再换会话 ⇒ provider-failure ⑧ 聊天路径的丢弃判据红",
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
    # 2026-11-25:全绿时 dot reporter 没有 failed 字样 —— 先认「红」,再认「全绿」,
    # 都不是才是异常退出(原来一律报「异常退出」,会把「没抓住」说成崩溃)。
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

    print("\n═══ 变异自检 · multica 借鉴批次(035–038)═══")
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
