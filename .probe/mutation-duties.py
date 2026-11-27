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
    "tests/platform/duty-runs.test.ts",
    # 时钟与开工:规则判据、职责项目里别的规则的口径、熔断、任务正文
    "tests/platform/duty-rule.test.ts",
    "tests/platform/duty-host.test.ts",
    "tests/platform/dispatcher-rules.test.ts",
    "tests/platform/project-close-rule.test.ts",
    "tests/web/text-budget.test.ts",
    "tests/platform/reset.test.ts",
    "tests/platform/execution.test.ts",
    # 能力 / 工具 / 提示词单元的登记处:计数哨兵与设计文档一致性
    "tests/platform/client.test.ts",
    "tests/platform/tool-briefs.test.ts",
    "tests/platform/design-conformance.test.ts",
    "tests/platform/harness-write.test.ts",
    "tests/platform/prompt-assembly.test.ts",
]


def J(*lines: str) -> str:
    """多行锚点:逐行拼,免得转义写错一个空格就静默不匹配。"""
    return "\n".join(lines)


DUTY = "src/platform/runtime/duty.ts"
REPO = "src/platform/storage/repo/duties.ts"
HTTP = "src/platform/transport/http.ts"
VIEWS = "src/platform/transport/views.ts"
TOOL = "src/platform/tools/duty.ts"
DISP = "src/platform/runtime/dispatcher.ts"
DTASK = "src/platform/runtime/dutyTask.ts"
PROJ = "src/platform/tools/project.ts"
PEND = "src/platform/runtime/pendingWork.ts"
SERVE = "src/platform/host/serve.ts"

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
    # ── 日课与日省:两个工具 ──────────────────────────────────────────
    (
        "K1", TOOL,
        J("    const open = openDutyRunOf(ctx.db, duty.id);",
          "    if (open !== null) {"),
        J("    const open = openDutyRunOf(ctx.db, duty.id);",
          "    if (false && open !== null) {"),
        "开工:上一轮没收工也开新的一轮(同一职责同时不止一轮)",
    ),
    (
        "K2", TOOL,
        "    if (duty.status !== \"active\") {",
        "    if (false && duty.status !== \"active\") {",
        "开工:已暂停的职责照开",
    ),
    (
        "K3", TOOL,
        "    if (proj.project.status !== \"active\") {",
        "    if (false && proj.project.status !== \"active\") {",
        "工作间项目不在进行中也照开 / 照收(工具自己那一眼被拿掉)",
    ),
    (
        "K4", TOOL,
        "  if (raw.length < 1) {",
        "  if (raw.length < 0) {",
        "开工:一步功课都不写也能开",
    ),
    (
        "K5", TOOL,
        "  if (raw.length > DUTY_MAX_STEPS) {",
        "  if (raw.length > DUTY_MAX_STEPS + 10) {",
        "开工:功课步数没有上限",
    ),
    (
        "K6", TOOL,
        "    if (title === \"\" || criterion === \"\") {",
        "    if (title === \"\" && criterion === \"\") {",
        "开工:功课没有可检验的标准也能开",
    ),
    (
        "K7", TOOL,
        "    if (dutyStartCapReached(ctx.db, now)) {",
        "    if (false && dutyStartCapReached(ctx.db, now)) {",
        "开工:每天的上限不拦(工具那第二道)",
    ),
    (
        "K8", TOOL,
        "    const { missed, nextDueAt } = slotsAfter(duty.cadence, slot, now);",
        "    const { missed, nextDueAt } = { missed: 0, nextDueAt: slot + 86_400_000 };",
        "开工:下一次按「排定点 + 24 小时」推(补做时那一格已经过去 ⇒ 刚开工就又到点)",
    ),
    (
        "K9", TOOL,
        "    if (failures.length > 0 && cause === null) {",
        "    if (false && failures.length > 0 && cause === null) {",
        "收工:出了失败也不要求写自己的原因",
    ),
    (
        "K10", TOOL,
        "  if (raw.length !== plan.length) {",
        "  if (raw.length > plan.length) {",
        "收工:功课可以少交代几步",
    ),
    (
        "K11", TOOL,
        J("  if (s === \"\") {",
          "    return { ok: false, result: fail(\"invalid_args\", `${key} 不许为空:${hint}`) };"),
        J("  if (false && s === \"\") {",
          "    return { ok: false, result: fail(\"invalid_args\", `${key} 不许为空:${hint}`) };"),
        "收工:自省五项可以空着",
    ),
    (
        "K12", TOOL,
        "    const failures = failuresSince(ctx.db, proj.project.id, run.startedAt);",
        "    const failures = failuresSince(ctx.db, proj.project.id, 0);",
        "收工:这一轮开工之前的失败也算在它头上",
    ),
    (
        "K13", TOOL,
        "    if (run === null) {",
        "    if (false && run === null) {",
        "收工:没有未收工的一轮也不拦",
    ),
    (
        "K14", REPO,
        J("       WHERE project_id = ? AND kind IN ('work_failed', 'work_blocked') AND created_at >= ?",
          "       ORDER BY created_at, seq`,"),
        J("       WHERE project_id = ? AND kind IN ('work_failed', 'work_blocked') AND created_at >= ? - 3",
          "       ORDER BY created_at, seq`,"),
        "失败清单的时间窗往前多开 3 毫秒(开工之前的失败被算进来)",
    ),
    (
        "K15", REPO,
        "`SELECT work_id FROM review_verdicts WHERE project_id = ? AND verdict = 'fail' AND created_at >= ? ORDER BY created_at, seq`",
        "`SELECT work_id FROM review_verdicts WHERE project_id = ? AND created_at >= ? ORDER BY created_at, seq`",
        "失败清单:质检「通过」也算失败",
    ),
    (
        "K16", REPO,
        "`SELECT artifact_id FROM delivery_verdicts WHERE project_id = ? AND verdict = 'reject' AND created_at >= ? ORDER BY created_at, seq`",
        "`SELECT artifact_id FROM delivery_verdicts WHERE project_id = ? AND created_at >= ? ORDER BY created_at, seq`",
        "失败清单:甲方「接受」也算失败",
    ),
    (
        "K17", DUTY,
        "  return countDutyRunsStartedSince(db, localDayStart(now)) >= DUTY_DAILY_START_CAP;",
        "  return countDutyRunsStartedSince(db, localDayStart(now)) > DUTY_DAILY_START_CAP;",
        "每天的上限差一(开满 12 轮还能再开一轮)",
    ),
    (
        "K18", DUTY,
        "    if (next > now) return { missed, nextDueAt: next };",
        "    if (next >= now) return { missed, nextDueAt: next };",
        "排定点正好是「现在」时被排到下一次(刚开工就又到点)",
    ),
    (
        "K19", "src/platform/runtime/execution.ts",
        "    ...(work.acceptanceCriteria.length > 0",
        "    ...(work.acceptanceCriteria.length < 0",
        "执行者的任务正文不带验收判据",
    ),
    (
        "K20", "src/platform/identity/role.ts",
        J("      // 做成工具就等于让模型替甲方预先授权。",
          "      \"duty.run\","),
        J("      // 做成工具就等于让模型替甲方预先授权。"),
        "业务经理的工具面里没有职责的功课(它根本调不了)",
    ),
    (
        "K21", "src/platform/harness/authorize.ts",
        J("  // 已收口)就不许再开工、收工。",
          "  \"duty.\","),
        J("  // 已收口)就不许再开工、收工。"),
        "职责的功课不是项目内能力(工作间不在进行中也拿得到工具)",
    ),
    (
        "G1", DUTY,
'    if (duty.nextDueAt === null || duty.nextDueAt > q.now) return null;',
'    if (duty.nextDueAt === null || duty.nextDueAt >= q.now) return null;',
        '到点判成「严格早于现在」:排定点正好是现在的那一轮永远不开工',
    ),
    (
        "G2", DUTY,
'  if (duty.status !== "active" || q.projectStatus !== "active") return null;',
'    if (q.projectStatus !== "active") return null;',
        '已暂停的职责照样开工 / 收工',
    ),
    (
        "G3", DUTY,
'  if (duty.status !== "active" || q.projectStatus !== "active") return null;',
'    if (duty.status !== "active") return null;',
        '工作间项目不在进行中也照样开工 / 收工',
    ),
    (
        "G4", DUTY,
J('    if (q.awaitingClient) return null;',
          '    if (duty.formal && q.acceptancePending) return null;'),
'    if (duty.formal && q.acceptancePending) return null;',
        '有问题在等甲方答时照样开新一轮(轮次叠起来)',
    ),
    (
        "G5", DUTY,
'    if (duty.formal && q.acceptancePending) return null;',
'    if (false && duty.formal && q.acceptancePending) return null;',
        '正式交付的职责:货交了等甲方验收时还开新工',
    ),
    (
        "G6", DUTY,
'    if (q.startCapReached) return null;',
'    if (false && q.startCapReached) return null;',
        '今天开满了照样开工(规则那一层不拦)',
    ),
    (
        "G7", DUTY,
J('  if (q.awaitingClient) return null;',
          '  const quiet = q.nonTerminalWorkCount === 0 && q.pendingReviewCount === 0 && q.openAskCount === 0;'),
'  const quiet = q.nonTerminalWorkCount === 0 && q.pendingReviewCount === 0 && q.openAskCount === 0;',
        '有问题在等甲方答时照样收工(他的答复被关在门外)',
    ),
    (
        "G8", DUTY,
'  const quiet = q.nonTerminalWorkCount === 0 && q.pendingReviewCount === 0 && q.openAskCount === 0;',
'  const quiet = q.pendingReviewCount === 0 && q.openAskCount === 0;',
        '「安静」不看还有没有没做完的活(活还在跑就收工)',
    ),
    (
        "G9", DUTY,
'  const quiet = q.nonTerminalWorkCount === 0 && q.pendingReviewCount === 0 && q.openAskCount === 0;',
'  const quiet = q.nonTerminalWorkCount === 0 && q.openAskCount === 0;',
        '「安静」不看还有没有等着审的产出',
    ),
    (
        "G10", DUTY,
'  const quiet = q.nonTerminalWorkCount === 0 && q.pendingReviewCount === 0 && q.openAskCount === 0;',
'  const quiet = q.nonTerminalWorkCount === 0 && q.pendingReviewCount === 0;',
        '「安静」不看还有没有没答的提问',
    ),
    (
        "G11", DUTY,
'  const overdue = duty.nextDueAt !== null && duty.nextDueAt <= q.now;',
'  const overdue = duty.nextDueAt !== null && duty.nextDueAt < q.now;',
        '拖到下一个排定点(正好那一刻)也不收',
    ),
    (
        "G12", DUTY,
'  return quiet || overdue ? "close" : null;',
'  return quiet ? "close" : null;',
        '上一轮永远可以拖着不收(既过不恋没了)',
    ),
    (
        "G13", DISP,
'          ? `duty_due:${duty.id}:open@${duty.nextDueAt ?? "unscheduled"}`',
'          ? `duty_due:${duty.id}:open`',
        '开工的账按职责记(不按排定点):恢复职责时带着烧穿的老账又被暂停',
    ),
    (
        "G14", DISP,
'          : `duty_due:${duty.id}:close@${q.openDutyRun?.id ?? "none"}`,',
'          : `duty_due:${duty.id}:close`,',
        '收工的账按职责记(不按那一轮):上一轮烧穿的预算被下一轮继承',
    ),
    (
        "G15", DISP,
'        startCapReached: q.dutyStartCapReached,',
'        startCapReached: false,',
        '规则读不到「今天开满了」',
    ),
    (
        "G16", DISP,
'        acceptancePending: q.acceptancePending.length > 0,',
'        acceptancePending: false,',
        '规则读不到「货交了等甲方验收」',
    ),
    (
        "G17", DISP,
'        openRunStartedAt: q.openDutyRun?.startedAt ?? null,',
'        openRunStartedAt: null,',
        '规则永远以为没有未收工的一轮(永远不收工)',
    ),
    (
        "G18", DISP,
'    dutyStartCapReached: duty !== null && dutyStartCapReached(db, now),',
'    dutyStartCapReached: false,',
        '事实装配不数「今天开过几轮」',
    ),
    (
        "G19", DISP,
'    if (kind === "duty_due") continue;',
'    if (false && kind === "duty_due") continue;',
        '职责到顶后换手给项目经理(他手里没有职责的工具,白叫三轮)',
    ),
    (
        "G20", DISP,
'  const duty = dutyOfProject(db, projectId);',
'  const duty = null;',
        '事实装配不认职责项目(规则永远不产出,四条规则的口径也不改)',
    ),
    (
        "G21", DISP,
'      return renderDutyTask(db, todo);',
'      return "现在轮到你了";',
        '职责到点的任务正文不摆现状(先看现状再动手没了)',
    ),
    (
        "G22", DISP,
J('      // 不该给甲方添的点击。正式交付物的职责照旧走这条流水线。)',
          '      if (q.duty !== null && !q.duty.formal) return [];'),
J('      // 不该给甲方添的点击。正式交付物的职责照旧走这条流水线。)',
          '      if (false && q.duty !== null && !q.duty.formal) return [];'),
        '例行产出的职责也去整合(写出交付物,接着就是待你验收)',
    ),
    (
        "G23", DISP,
J('      // 职责项目(039)· **例行产出**:不交付 —— 成果在日报里,没有要甲方验收的东西。',
          '      if (q.duty !== null && !q.duty.formal) return [];'),
J('      // 职责项目(039)· **例行产出**:不交付 —— 成果在日报里,没有要甲方验收的东西。',
          '      if (false && q.duty !== null && !q.duty.formal) return [];'),
        '例行产出的职责也去交付(给甲方添验收)',
    ),
    (
        "G24", DISP,
J('      // 它的终点是甲方在设置页暂停 / 归档它,不是「做完了」。',
          '      if (q.duty !== null && !q.duty.formal) return [];'),
J('      // 它的终点是甲方在设置页暂停 / 归档它,不是「做完了」。',
          '      if (false && q.duty !== null && !q.duty.formal) return [];'),
        '例行产出的职责也判收口',
    ),
    (
        "G25", DISP,
J('      // 例行职责本来就不产出交付物;每一轮做没做成,由 `duty_due` 的收工自省交代。',
          '      if (q.duty !== null && !q.duty.formal) return [];'),
J('      // 例行职责本来就不产出交付物;每一轮做没做成,由 `duty_due` 的收工自省交代。',
          '      if (false && q.duty !== null && !q.duty.formal) return [];'),
        '例行产出的职责也被问「为什么没交付物」',
    ),
    (
        "Z1", REPO,
'    updateDuty(db, duty.id, { status: "paused", nextDueAt: null }, now);',
'    void duty;',
        '开工到顶不暂停职责(每个 tick 都「到点了」,却永远没人来 —— 静默死)',
    ),
    (
        "Z2", REPO,
'    if (project !== null && project.status === "active") {',
'    if (false && project !== null && project.status === "active") {',
        '自动暂停职责时工作间项目照常跑',
    ),
    (
        "Z3", REPO,
'    status: "abandoned", finishedAt: now,',
'    status: "done", finishedAt: now,',
        '平台收掉的一轮被记成「模型自己收的」(没有自省却像反省过)',
    ),
    (
        "Z4", REPO,
'    ? `duty_due:${duty.id}:open@${duty.nextDueAt ?? "unscheduled"}`',
'    ? `duty_due:${duty.id}:open`',
        '熔断找错了账本(找不到 ⇒ 永远不暂停)',
    ),
    (
        "Z5", REPO,
'    : `duty_due:${duty.id}:close@${open.id}`;',
'    : `duty_due:${duty.id}:close`;',
        '熔断找错了收工的账本(没收工的一轮永远挂着)',
    ),
    (
        "Z6", REPO,
'  if (ledger === undefined || ledger.notified_at === null) return [];',
'  if (ledger === undefined) return [];',
        '熔断不等播报过:刚记了一次账就暂停职责',
    ),
    (
        "Z7", REPO,
'    gaps: "这一轮没能收工:平台连续三次叫业务经理来收工都没成,这一轮由平台收掉,没有自省。",',
'    gaps: "无",',
        '平台收掉的一轮写成「缺口:无」(把没收工说成没问题)',
    ),
    (
        "C1", PROJ,
'    const preApproved = dutyOfProject(ctx.db, pid) !== null;',
'    const preApproved = false;',
        '职责项目里的工作项也要等甲方点「确认开工」(预先授权没了)',
    ),
    (
        "C2", PROJ,
'        ...(preApproved ? { confirmedAt: at } : {}),',
'',
        '同上:算了预先授权却没写进 confirmed_at',
    ),
    (
        "N1", PEND,
'    duty === null;',
'    true;',
        '空的项目经理自己起头拆解,职责的工作间也不例外(绕过「先列功课」)',
    ),
    (
        "N2", PEND,
'    duty !== null && role !== null && ROLE_SPECS[role].clientFacing',
'    duty !== null && role !== null',
        '未收工的那一轮摆给了所有角色(不只对甲方说话的那个)',
    ),
    (
        "X1", DTASK,
'  const duty = todo.target !== null ? getDuty(db, todo.target) : null;',
'  const duty = todo.target !== null ? dutyOfProject(db, todo.target) : null;',
        '拿职责 id 当项目 id 去查(第一版的 bug:每一轮都说「记录已经不在了」)',
    ),
    (
        "X2", DTASK,
'  ← 这一条这一轮要兑现',
'',
        '任务正文不提醒「上一轮说要改的」这一轮要兑现',
    ),
    (
        "X3", DTASK,
J('    ...(failures.length > 0',
          '      ? [`- ⚠️ 这一轮有 ${failures.length} 件事没成:'),
J('    ...(false && failures.length > 0',
          '      ? [`- ⚠️ 这一轮有 ${failures.length} 件事没成:'),
        '收工正文不提「有失败必须写自己的原因」',
    ),
    (
        "X4", DTASK,
'  const stillOpen = works.filter((w) => !isTerminalWorkStatus(w.status));',
'  const stillOpen = touched.filter((w) => !isTerminalWorkStatus(w.status));',
        '收工正文只列这一轮动过的活(开工前就卡住、没碰过的不算「没做成」)',
    ),
    (
        "X5", DTASK,
'  const why = isQuiet(db, duty.projectId, works)',
'  const why = false',
        '收工正文永远说「拖到了下一个排定点」(明明是活落定了)',
    ),
    (
        "X6", DTASK,
'    `- 必须先问甲方的事:${duty.boundaries.trim() !== "" ? duty.boundaries : "(甲方没写 —— 按你平时的判断)"}`,',
'    `- 必须先问甲方的事:${duty.boundaries}`,',
        '甲方没写边界时留一个空的「必须先问甲方的事:」(看着像漏了)',
    ),
    (
        "U1", SERVE,
'    for (const s of settleExhaustedDuty(db, projectId, now())) {',
'    for (const s of [] as never[]) {',
        '宿主不扫职责的熔断(到顶之后既不暂停也不播报)',
    ),
    (
        "U2", SERVE,
'        notifyDesktop(`duty-paused:${s.duty.id}`, "三生 · 一条职责已自动暂停",',
'        notifyDesktop(`duty-paused:${s.duty.id}`, "三生",',
        '职责被自动暂停时桌面通知不说是什么事',
    ),
    (
        "U3", SERVE,
'            `⚠️ 职责:「${s.duty.name}」已自动暂停 —— 连续三次到点,业务经理都没能开工` +',
'            `职责:「${s.duty.name}」已自动暂停 —— 连续三次到点,业务经理都没能开工` +',
        '系统消息没有「⚠️ 职责:」首行前缀(界面上分不出这一类)',
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
