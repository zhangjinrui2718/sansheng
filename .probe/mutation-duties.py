#!/usr/bin/env python3
# 变异自检:.probe/mutation-duties.py
# 「职责」批次(2026-11-27,migration 039:数字员工 + 曾国藩性情机制)的回归有没有真的咬合。
# 写法与纪律照抄 .probe/mutation-multica-borrow.py:
#   每条变异**真的移除/改写语句**(不是加注释),且:
#   ① 断言「改后那一行确实变了」(str.replace 不匹配时静默不执行 —— 本项目第 2 类静默失败);
#   ② 红的原因必须是 Failed Tests —— Transform failed / Failed Suites(语法/编译错)不算数;
#   ③ 复原按内存原文写回 + 断言逐字相同。
# ⚠️ 脚本运行期间会临时改写源码 —— 那段时间**不要同时编辑这些文件**。
# 可选参数 = 只跑指定编号的变异(重跑单条时用:`python3 脚本 D3 D7`)。
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 本批全部判据所在的文件(runner 必须覆盖全 —— 只跑一个文件会把「改坏了却绿」
# 误判成「没改坏」,Wave 2d 的教训)。
TESTS = [
    "tests/platform/duties.test.ts",
    "tests/platform/reset.test.ts",
]


def J(*lines: str) -> str:
    """多行锚点:逐行拼,免得转义写错一个空格就静默不匹配。"""
    return "\n".join(lines)


DUTY = "src/platform/runtime/duty.ts"
REPO = "src/platform/storage/repo/duties.ts"
HTTP = "src/platform/transport/http.ts"
VIEWS = "src/platform/transport/views.ts"

MUTATIONS = [
    # ── 时间(纯函数)──────────────────────────────────────────────────
    (
        "D1", DUTY,
        J("    const today = localSlot(after, hour, minute, 0);",
          "    return today > after ? today : localSlot(after, hour, minute, 1);"),
        J("    const today = localSlot(after, hour, minute, 0);",
          "    return today;"),
        "每天:今天的点已经过了也排今天(不排明天)⇒ 建职责时立刻开工",
    ),
    (
        "D2", DUTY,
        J("    if (!inQuietHours(t)) return t;",
          "    const hour = new Date(t).getHours();"),
        J("    return t;",
          "    const hour = new Date(t).getHours();"),
        "按小时的节奏夜里照开(静默时段不生效)",
    ),
    (
        "D3", DUTY,
        "  return hour >= DUTY_QUIET_FROM_HOUR || hour < DUTY_QUIET_TO_HOUR;",
        "  return hour > DUTY_QUIET_FROM_HOUR || hour < DUTY_QUIET_TO_HOUR;",
        "静默时段漏掉 22 点整",
    ),
    (
        "D4", DUTY,
        J("    const next = nextDueAt(cadence, t);",
          "    if (next > now) break;"),
        J("    const next = nextDueAt(cadence, t);",
          "    if (next >= now) break;"),
        "错过的轮次数:正好落在现在的那个排定点被漏数",
    ),
    (
        "D5", DUTY,
        "  const minutes = Math.floor(Math.max(0, ms) / 60_000);",
        "  const minutes = Math.round(Math.max(0, ms) / 60_000);",
        "时长四舍五入:30 秒被说成「1 分钟」",
    ),
    (
        "D6", DUTY,
        J("  return thisWeek > after ? thisWeek : localSlot(after, hour, minute, offset + 7);"),
        J("  return thisWeek;"),
        "每周:本周的点已经过了也排本周",
    ),
    (
        "D7", DUTY,
        "    if (!clock.ok) {",
        "    if (!clock.ok && false) {",
        "节奏的时刻不合法也放行(HH:MM 不校验)",
    ),
    (
        "D8", DUTY,
        "    if (typeof hours !== \"number\" || !Number.isInteger(hours) || hours < 1 || hours > 168) {",
        "    if (typeof hours !== \"number\" || !Number.isInteger(hours) || hours < 1) {",
        "按小时:间隔没有上限(一夜能排几百轮)",
    ),
    (
        "D9", DUTY,
        "    if (typeof weekday !== \"number\" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {",
        "    if (typeof weekday !== \"number\" || !Number.isInteger(weekday) || weekday < 0) {",
        "每周:星期几没有上限",
    ),
    # ── 仓储 ────────────────────────────────────────────────────────
    (
        "R1", REPO,
        "  if (fields.nextDueAt !== undefined) push(\"next_due_at\", fields.nextDueAt);",
        "  if (fields.nextDueAt !== undefined && fields.nextDueAt !== null) push(\"next_due_at\", fields.nextDueAt);",
        "暂停职责时「清空排定」被吞掉",
    ),
    (
        "R2", REPO,
        J("  } catch {",
          "    throw new Error(`duty_runs.steps 不是合法 JSON(duty_run id=${id})`);",
          "  }"),
        J("  } catch {",
          "    return [];",
          "  }"),
        "steps 的 JSON 坏了退成空数组(收工校验会空转通过)",
    ),
    (
        "R3", REPO,
        J("  if (!Array.isArray(parsed)) {",
          "    throw new Error(`duty_runs.steps 不是数组(duty_run id=${id})`);",
          "  }"),
        J("  if (!Array.isArray(parsed)) {",
          "    return [];",
          "  }"),
        "steps 不是数组时退成空数组",
    ),
    (
        "R4", REPO,
        "  if (!isDutyStatus(raw.status)) {",
        "  if (!isDutyStatus(raw.status) && false) {",
        "闭集外的 status 被读成合法值(不报错)",
    ),
    (
        "R5", REPO,
        "  if (!isDutyCadenceKind(raw.cadence_kind)) {",
        "  if (!isDutyCadenceKind(raw.cadence_kind) && false) {",
        "闭集外的 cadence_kind 被读成合法值(不报错)",
    ),
    (
        "R6", REPO,
        "    .prepare(`SELECT COUNT(*) AS n FROM duty_runs WHERE started_at >= ?`)",
        "    .prepare(`SELECT COUNT(*) AS n FROM duty_runs WHERE started_at > ?`)",
        "「今天开过几轮」漏掉正好开在起点那一刻的一轮",
    ),
    (
        "R7", REPO,
        "    .prepare(`SELECT * FROM duty_runs WHERE duty_id = ? AND status = 'open' ORDER BY started_at ASC LIMIT 1`)",
        "    .prepare(`SELECT * FROM duty_runs WHERE duty_id = ? ORDER BY started_at ASC LIMIT 1`)",
        "已收工的那一轮仍被读成「未收工」",
    ),
    (
        "R8", REPO,
        "    .prepare(`SELECT * FROM duty_runs WHERE duty_id = ? ORDER BY started_at DESC LIMIT 1`)",
        "    .prepare(`SELECT * FROM duty_runs WHERE duty_id = ? ORDER BY started_at ASC LIMIT 1`)",
        "「最近一轮」读成了最早一轮",
    ),
    (
        "R9", REPO,
        "    formal: raw.formal !== 0,",
        "    formal: false,",
        "产出形态永远是例行产出(正式交付物读丢了)",
    ),
    (
        "R10", REPO,
        "    .prepare(`SELECT * FROM duties ORDER BY (status = 'active') DESC, created_at ASC`)",
        "    .prepare(`SELECT * FROM duties ORDER BY created_at ASC`)",
        "职责列表不再把启用的排在前面",
    ),
    # ── 接口 ────────────────────────────────────────────────────────
    (
        "H1", HTTP,
        J("    if (goal === \"\") {",
          "      return c.json(err(\"invalid_args\", \"目标不能为空 —— 说清什么算做好了\").body, 400);",
          "    }",
          "    const cadence = validateCadence(body.cadence);"),
        J("    if (false && goal === \"\") {",
          "      return c.json(err(\"invalid_args\", \"目标不能为空 —— 说清什么算做好了\").body, 400);",
          "    }",
          "    const cadence = validateCadence(body.cadence);"),
        "建职责:目标为空也建得出来",
    ),
    (
        "H2", HTTP,
        J("    if (name === \"\") return c.json(err(\"invalid_args\", \"名称不能为空\").body, 400);",
          "    const goal = typeof body.goal === \"string\" ? body.goal.trim() : \"\";"),
        J("    if (false && name === \"\") return c.json(err(\"invalid_args\", \"名称不能为空\").body, 400);",
          "    const goal = typeof body.goal === \"string\" ? body.goal.trim() : \"\";"),
        "建职责:名称为空也建得出来",
    ),
    (
        "H3", HTTP,
        "      nextDueAt: startPaused ? null : nextDueAt(cadence.cadence, at),",
        "      nextDueAt: nextDueAt(cadence.cadence, at),",
        "「暂不启用」的职责也排了下一次(暂停时会自己开工)",
    ),
    (
        "H4", HTTP,
        "    if (startPaused) updateProject(db, r.id, { status: \"paused\" });",
        "    if (false && startPaused) updateProject(db, r.id, { status: \"paused\" });",
        "「暂不启用」时工作间项目没跟着暂停",
    ),
    (
        "H5", HTTP,
        "        projectStatus = body.status === \"active\" ? \"active\" : \"paused\";",
        "        projectStatus = body.status === \"active\" ? \"active\" : undefined;",
        "暂停职责时工作间项目照常跑",
    ),
    (
        "H6", HTTP,
        "      if (!willBeActive) fields.nextDueAt = null;",
        "      if (!willBeActive && false) fields.nextDueAt = null;",
        "暂停职责时没有清空排定",
    ),
    (
        "H7", HTTP,
        "      else if (cadence !== undefined || fields.status === \"active\") fields.nextDueAt = nextDueAt(cadence ?? duty.cadence, at);",
        "      else if (cadence !== undefined) fields.nextDueAt = nextDueAt(cadence ?? duty.cadence, at);",
        "启用职责时没有重新排下一次(永远不会开工)",
    ),
    (
        "H8", HTTP,
        "        if (isTerminalProjectStatus(project.status)) {",
        "        if (false && isTerminalProjectStatus(project.status)) {",
        "工作间已收口的职责也能启用",
    ),
    (
        "H9", HTTP,
        "      if (body.status !== \"active\" && body.status !== \"paused\") {",
        "      if (body.status !== \"active\" && body.status !== \"paused\" && false) {",
        "状态写成乱七八糟的值也放行",
    ),
    (
        "H10", HTTP,
        "      if (!checked.ok) return c.json(err(\"invalid_args\", checked.message).body, 400);",
        "      if (!checked.ok && false) return c.json(err(\"invalid_args\", checked.message).body, 400);",
        "改职责:节奏不合法也放行",
    ),
    (
        "H11", HTTP,
        J("      if (name === \"\") return c.json(err(\"invalid_args\", \"名称不能为空\").body, 400);",
          "      fields.name = name;"),
        J("      if (false && name === \"\") return c.json(err(\"invalid_args\", \"名称不能为空\").body, 400);",
          "      fields.name = name;"),
        "改职责:名称改成空也放行",
    ),
    (
        "H12", HTTP,
        "    if (duty.status !== \"active\") {",
        "    if (false && duty.status !== \"active\") {",
        "「现在做一次」:已暂停的职责不拦",
    ),
    (
        "H13", HTTP,
        "    if (project === null || project.status !== \"active\") {",
        "    if (project === null) {",
        "「现在做一次」:工作间项目不在进行中也不拦",
    ),
    (
        "H14", HTTP,
        "    if (openDutyRunOf(db, duty.id) !== null) {",
        "    if (false && openDutyRunOf(db, duty.id) !== null) {",
        "「现在做一次」:上一轮没收工也重排",
    ),
    (
        "H15", HTTP,
        "    updateDuty(db, duty.id, { nextDueAt: at }, at);",
        "    updateDuty(db, duty.id, {}, at);",
        "「现在做一次」什么都没改(按钮按了没反应)",
    ),
    # ── 视图 ────────────────────────────────────────────────────────
    (
        "V1", VIEWS,
        J("    ...(duty !== null",
          "      ? {"),
        J("    ...(duty === null",
          "      ? {"),
        "项目摘要:职责标记打在了普通项目上 / 职责项目反而没有",
    ),
    (
        "V2", VIEWS,
        "    lastRun: lastRun === null ? null : toDutyRunView(lastRun),",
        "    lastRun: null,",
        "职责读面永远说「最近一轮:无」",
    ),
    (
        "V3", VIEWS,
        "            cadence: cadenceText(duty.cadence),",
        "            cadence: \"\",",
        "项目摘要里职责的节奏是空的",
    ),
    (
        "V4", VIEWS,
        "    projectStatus: project.status,",
        "    projectStatus: \"active\",",
        "职责读面把工作间项目永远说成进行中",
    ),
]


def run_vitest() -> tuple[bool, str]:
    cmd = ["npx", "vitest", "run", *TESTS, "--reporter=dot"]
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as e:
        return False, "vitest 900s 超时(挂死)"
    out = p.stdout + p.stderr
    if "Transform failed" in out or "Failed Suites" in out:
        return False, "编译/套件级红(不算数 —— 判据根本没被问到)\n" + out[-1500:]
    m = re.search(r"Tests\s+(\d+) failed", out)
    if m is not None:
        return True, f"红(Failed Tests = {m.group(1)})"
    if re.search(r"Tests\s+\d+ passed", out):
        return False, "全绿(变异没被抓住)\n" + out[-1200:]
    return False, "解析不到测试统计(异常退出)\n" + out[-1500:]


def main() -> int:
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

    print("\n═══ 变异自检 · 职责批次(039)═══")
    bad = 0
    for mid, note, ok, detail in results:
        mark = "🔴 变红" if ok else "🟢 漏网"
        if not ok:
            bad += 1
        tail = "\n       ".join((detail or "").splitlines()[:6])
        print(f"{mark}  {mid}  {note}\n       {tail}")
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
