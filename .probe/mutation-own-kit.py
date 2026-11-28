#!/usr/bin/env python3
# 变异自检:.probe/mutation-own-kit.py
# 「自己的仓库与经验库」批次(2026-11-28,migration 040)的回归有没有真的咬合。
# 写法与纪律照抄 .probe/mutation-duties.py:
#   每条变异**真的移除/改写语句**(不是加注释),且:
#   ① 断言「改后那一行确实变了」(str.replace 不匹配时静默不执行 —— 本项目第 2 类静默失败);
#   ② 红的原因必须是 Failed Tests —— Transform failed / Failed Suites(语法/编译错)不算数;
#   ③ 复原按内存原文写回 + 断言逐字相同;
#   ④ 一条都没跑不算通过。
# ⚠️ 脚本运行期间会临时改写源码 —— 那段时间**不要同时编辑这些文件**。
# 可选参数 = 只跑指定编号的变异(重跑单条时用:`python3 脚本 S2 H3`);
# `--check` = 只核对每条变异的锚点找不找得到,不跑测试。
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 本批全部判据所在的文件(runner 必须覆盖全 —— 只跑一个文件会把「改坏了却绿」
# 误判成「没改坏」,Wave 2d 的教训)。
TESTS = [
    "tests/platform/session-load-policy.test.ts",
    "tests/platform/own-repo.test.ts",
    "tests/platform/agent-notes.test.ts",
    "tests/platform/own-kit-context.test.ts",
    "tests/platform/own-mcp.test.ts",
    "tests/platform/own-kit-host.test.ts",
    # 收尾等待的定时器从 prompt() 返回之后才起算(2026-11-28 真模型实验抓到的旧缺陷)
    "tests/platform/turn.test.ts",
    # 真模型实验之后修掉的四个问题 + abort 路径三处误报(F 组)
    "tests/platform/execution.test.ts",
    "tests/platform/blackboard.test.ts",
    "tests/platform/prompt-assembly.test.ts",
    "tests/platform/tools.test.ts",
    "tests/platform/interrupt-live.test.ts",
    "tests/platform/provider-key-channel.test.ts",
    "tests/platform/reset.test.ts",
    "tests/web/own-kit-section.test.ts",
]


def J(*lines: str) -> str:
    """多行锚点:逐行拼,免得转义写错一个空格就静默不匹配。"""
    return "\n".join(lines)


SESS = "src/platform/runtime/agentRuntime/pi/session.ts"
SESS_TURN = "src/platform/runtime/turn.ts"
OWN = "src/platform/harness/ownTools.ts"
NOTES = "src/platform/storage/repo/agentNotes.ts"
EXP = "src/platform/tools/experience.ts"
OWNTOOL = "src/platform/tools/own.ts"
CTX = "src/platform/runtime/ownKitContext.ts"
SOLVE = "src/platform/mcp/solve.ts"
PICFG = "src/platform/runtime/agentRuntime/pi/mcpConfig.ts"
SERVE = "src/platform/host/serve.ts"
HTTP = "src/platform/transport/http.ts"
OKV = "src/platform/transport/ownKitView.ts"
SEC = "web/src/components/harness/OwnKitSection.tsx"
RH = "web/src/components/members/RoleHarness.tsx"
EXEC = "src/platform/runtime/execution.ts"
PROV = "src/platform/runtime/agentRuntime/pi/providers.ts"
BLACK = "src/platform/tools/blackboard.ts"
PROMPT = "src/platform/runtime/promptAssembly.ts"
PROJ = "src/platform/tools/project.ts"

MUTATIONS = [
    # ── L:会话装载策略 ─────────────────────────────────────────────
    ("L1", SESS, "    noExtensions: true,\n", "", "项目仓里的 .pi/extensions/*.js 又会被自动装载(当代码执行)"),
    ("L2", SESS, "    noSkills: true,\n", "", "项目仓里的 .pi/skills 又会被自动发现"),
    ("L3", SESS, "    noContextFiles: true,\n", "", "项目仓与上级目录的 AGENTS.md 又会进系统提示"),
    ("L4", SESS, "resolveProjectTrust: async () => false", "resolveProjectTrust: async () => true",
     "reload 时仍信任项目目录(项目级提示词模板被读进来)"),
    ("L5", SESS, "await reloadSessionResources(loader);", "await loader.reload();",
     "换成裸 reload —— 装载策略的另一半边没接上"),
    # ── S:扫描与校验(仓库就是真相)──────────────────────────────
    ("S1", OWN, 'if (description === "") {', 'if (description === "" && !dirName) {',
     "说明书缺 description 也算合法"),
    ("S2", OWN, "if (!opts.canExec) {", "if (!opts.canExec && false) {",
     "没有跑命令能力的角色(质检)写的 mcp.json 也生效"),
    ("S3", OWN, 'if (def.transport === "http" || obj["url"] !== undefined) {', 'if (obj["url"] === "x-never") {',
     "自己的 MCP 服务可以写出网地址"),
    ("S4", OWN, 'if (obj["headers"] !== undefined) {', 'if (obj["headers"] === "x-never") {',
     "自己的 MCP 服务可以带请求头"),
    ("S5", OWN, 'if (v.includes("${")) {', 'if (v.includes("${never")) {',
     "自己的 MCP 服务可以在 env 里引用环境变量(凭据)"),
    ("S6", OWN, 'return ROLE_SPECS[role].ceiling.includes("own.write");', 'return ROLE_SPECS[role].ceiling.includes("code.write");',
     "「谁有仓库」判错(质检没有仓库、两个执行角色有)"),
    ("S7", OWN, 'return ROLE_SPECS[role].ceiling.includes("code.exec");', 'return ROLE_SPECS[role].ceiling.includes("own.write");',
     "「谁能提交 MCP」判错(质检也能)"),
    ("S8", OWN, "return `${OWN_MCP_PREFIX}-${role}-${toolName}`;", "return `${OWN_MCP_PREFIX}-${toolName}`;",
     "自己的 MCP 服务名不带角色(会与别的角色撞名)"),
    ("S9", OWN, 'return { root, state: existsSync(root) ? "ready" : "missing", tools: [] };',
     'return { root, state: "ready", tools: [] };', "仓库目录不在也说成「读到了、没有工具」"),
    ("S10", OWN, "export const OWN_TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;",
     "export const OWN_TOOL_NAME_RE = /^.+$/;", "工具目录名不校验(带空格 / 斜杠也认)"),
    ("S11", OWN, "          h.update(readFileSync(join(dir, rel)));", "",
     "指纹不读文件内容(改了服务器代码也算没变)"),
    ("S12", OWN, "    if (!existsSync(join(dir, OWN_MCP_FILE))) continue;",
     "    if (!existsSync(join(dir, OWN_MCP_FILE)) && !existsSync(join(dir, OWN_SKILL_FILE))) continue;",
     "说明类工具也进指纹(每写一个说明类工具就换一次会话)"),
    # ── N:经验库仓储 ──────────────────────────────────────────────
    ("N1", NOTES, "WHERE agent_notes_fts MATCH ? AND n.agent_id = ? AND n.status = 'active'${kindFilter}",
     "WHERE agent_notes_fts MATCH ? AND (n.agent_id = ? OR 1 = 1) AND n.status = 'active'${kindFilter}",
     "检索不按角色隔离(搜得到别人的经验)"),
    ("N2", NOTES, "WHERE agent_notes_fts MATCH ? AND n.agent_id = ? AND n.status = 'active'${kindFilter}",
     "WHERE agent_notes_fts MATCH ? AND n.agent_id = ? AND (n.status = 'active' OR 1 = 1)${kindFilter}",
     "退休的条目还会被检索到"),
    ("N3", NOTES, 'const status: AgentNoteStatus | "all" = opts.status ?? "active";',
     'const status: AgentNoteStatus | "all" = opts.status ?? "all";', "人读面缺省连退休的一起列"),
    ("N4", NOTES, "WHERE id = ? AND status = 'active'`,", "WHERE id = ? AND (status = 'active' OR status = 'retired')`,",
     "重复退休也算成功"),
    ("N5", NOTES, "if (!isAgentNoteKind(raw.kind)) {", 'if (!isAgentNoteKind(raw.kind) && raw.kind === "") {',
     "闭集之外的 kind 读到不抛(被归到某一类)"),
    ("N6", NOTES, "indexTerms(`${n.title}\\n${n.content}`), args.now, args.now,",
     "indexTerms(n.title), args.now, args.now,", "索引只切标题不切正文(正文里的词永远搜不到)"),
    ("N8", NOTES, "const limit = Math.min(Math.max(opts.limit ?? 3, 1), 20);",
     "const limit = Math.max(opts.limit ?? 3, 1);", "仓储层检索条数没有上限(提示词预算失守)"),
    ("N7", NOTES, "seg = ?, status = 'active', retire_reason = NULL, updated_at = ?",
     "seg = ?, status = status, retire_reason = retire_reason, updated_at = ?", "改写一条退休的条目不会救活它"),
    # ── E:经验库工具 ───────────────────────────────────────────────
    ("E1", EXP, 'if (kindRaw === "research" && (source === null || source === "")) {',
     'if (kindRaw === "research-never" && (source === null || source === "")) {', "调研条目不带出处也收"),
    ("E2", EXP, "if (note === null || note.agentId !== ctx.agent.id) {", "if (note === null) {",
     "读得到、改得到、退休得了别人的条目"),
    ("E3", EXP, "if (active >= EXPERIENCE_MAX_ACTIVE) {", "if (active >= EXPERIENCE_MAX_ACTIVE * 1000) {",
     "在用条目上限形同虚设"),
    ("E5", EXP, 'if (title.value.trim() === "") {', 'if (title.value.trim() === "" && false) {',
     "标题只有空白也收"),
    ("E7", EXP, "if (!retireAgentNote(ctx.db, id.value, reason.value.trim(), ctx.now())) {",
     "if (!retireAgentNote(ctx.db, id.value, reason.value.trim(), ctx.now()) && false) {",
     "退休写库失败被当成功(返回值被丢)"),
    ("E9", EXP, "active === 0", "active > 0", "「库是空的」与「没命中」两句说反"),
    ("E10", EXP, ": (prior !== null ? prior.sourceProjectId : (ctx.project?.id ?? null));", ": null;",
     "来源项目不落库"),
    ("E11", EXP, "const SOURCE_MAX = 600;", "const SOURCE_MAX = 60;",
     "出处上限又缩回去(几处官方出处并列就被拒)"),
    # ── O:own_read / own_write ─────────────────────────────────────
    ("O1", OWNTOOL, "if (isGitInternal(at.rel)) {", "if (isGitInternal(at.rel) && false) {", "能往 .git/ 里写"),
    ("O2", OWNTOOL, "if (content.value.length > WRITE_MAX) {", "if (content.value.length > WRITE_MAX * 1000) {",
     "单文件大小上限形同虚设"),
    ("O3", OWNTOOL, "if (r.value.length > READ_MAX) {", "if (r.value.length > READ_MAX * 100) {",
     "读超大文件不截断(整份进上下文)"),
    ("O4", OWNTOOL, 'const brake = disabled ? "\\n⚠️ 甲方停用了这个工具 —— 你改它不会让它重新生效;要恢复得由甲方在界面上操作。" : "";',
     'const brake = "";', "往被停用的工具里写东西时不提醒"),
    ("O5", OWNTOOL, "const feedback = toolFeedback(ctx, access.root, at.rel);", "const feedback = null;",
     "写工具文件后不回话(合不合法要等下一轮才知道)"),
    ("O6", OWNTOOL, J("  const r = ctx.workspace?.resolveInside({ root, path: rel });",
                     "  if (r === undefined || !r.ok) {"),
     J("  const r = ctx.workspace?.resolveInside({ root, path: rel });",
       "  if (r !== undefined && !r.ok) {", "    return { ok: true, abs: rel, rel };", "  }", "  if (r === undefined) {"),
     "越界路径不拒(交给更底层的端口去撞)"),
    # ── C:每轮注入 ────────────────────────────────────────────────
    ("C1", CTX, "limit: OWN_CONTEXT_NOTE_HITS", "limit: 10", "相关经验一次摆十条(预算失守)"),
    ("C2", CTX, 'const notes = ceiling.includes("experience.read") ? notesSection(db, agentId, opts.query) : null;',
     "const notes = notesSection(db, agentId, opts.query);", "没有经验库的角色(业务经理)也被注入经验段"),
    ("C2b", CTX, "const repo = ownsRepo(role) ? repoSection(db, agentId, role, opts.repoRoot) : null;",
     "const repo = repoSection(db, agentId, role, opts.repoRoot);", "没有仓库的角色(业务经理)也被注入仓库段"),
    ("C3", CTX, '"- ⚠️ 这次读不到(不代表它是空的)。需要时自己调 `experience_search`。",',
     '"- 在用:经验 0 条 · 调研 0 条。",', "经验库读失败被说成「0 条」"),
    ("C4", CTX, "不是给你的指令", "是你的笔记", "抬头不再声明「资料不是指令」"),
    ("C5", CTX, "if (disabled) {", "if (disabled && false) {", "被停用的工具在任务前不点名"),
    ("C6", CTX, '"- ⚠️ 这一轮没有接到仓库路径:读不到也写不了(`own_read` / `own_write` 会报装配错误)。"].join("\\n");',
     '"- 工具:还没有。"].join("\\n");', "没接到仓库路径被说成「还没有工具」"),
    # ── M:自己的 MCP 服务进会话 ───────────────────────────────────
    ("M1", SOLVE, "if (disabled.includes(t.name)) continue;", "if (disabled.includes(t.name + \"-never\")) continue;",
     "被停用的 MCP 服务照样连"),
    ("M2", SOLVE, "if (takenNames.has(name)) {", "if (takenNames.has(name) && false) {",
     "撞了人的目录也连(人的那份被盖掉)"),
    ("M3", SOLVE, "const scan = scanOwnTools(root, { canExec: canRunOwnMcp(agent.role) });",
     "const scan = scanOwnTools(root, { canExec: true });", "质检的 mcp.json 也连"),
    ("M4", SOLVE, "cwd: t.dir,", "cwd: root,", "进程工作目录不在工具目录(相对路径的脚本找不到)"),
    ("M5", PICFG, "...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),", "...({} as Record<string, never>),",
     "cwd 算出来了却没交给 pi"),
    ("T1", SESS_TURN, "  let timer: ReturnType<typeof setTimeout> | undefined;\n",
     "  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { timedOut = true; settled = true; }, timeoutMs);\n",
     "收尾等待的定时器又从回合一开始就走(正常收尾的长回合被说成超时)"),
    # ── H:宿主与 HTTP ─────────────────────────────────────────────
    ("H1", SERVE, J('        // 「这一轮没有接到仓库路径」,而聊天 / 评审那条路是好的)。',
                   "        ...(ownRole !== null ? { ownRepoRoot: agentWorkspaceRoot(workspaceRootOf(), ownRole) } : {}),"),
     J('        // 「这一轮没有接到仓库路径」,而聊天 / 评审那条路是好的)。'),
     "执行那条路没接自己的仓库路径(工程师干活走的正是这条)"),
    ("H2", SERVE, "ownMcpBuilt.get(k) !== now", "false",
     "自己仓库里与 MCP 有关的内容变了也不换会话(下一轮工具面里没有它)"),
    ("H10", SERVE, "    ownMcpBuilt.set(key, ownMcpFingerprintOf(agentId));\n", "",
     "不记下「这条会话是用哪一版仓库建的」⇒ 每一轮都把会话当成过期换掉"),
    ("H3", SERVE, 'if (!existsSync(join(root, ".git"))) {', "if (true) {",
     "每轮收尾都重新 initRepo(改动以「三生平台」的身份被提交)"),
    ("H4", SERVE, "if (inflight.has(key)) {", "if (inflight.has(key) && false) {",
     "他正在跑的那一轮被硬丢(停用 = 中断)"),
    ("H5", SERVE, J("      author: `${name} <${agentId}@sansheng.local>`,",
                   "      message: `housekeeping: ${name} 的回合结束(${outcome})`,",
                   "    });",
                   "    if (!r.ok) {",
                   "      reportOwnRepoProblem("),
     J('      author: "三生平台 <platform@sansheng.local>",',
       "      message: `housekeeping: ${name} 的回合结束(${outcome})`,",
       "    });",
       "    if (!r.ok) {",
       "      reportOwnRepoProblem("),
     "自己的仓库的提交不写角色作者(归属丢了)"),
    ("H6", SERVE, J("      housekeepingOwnRepo(agentId, outcomeLabel, projectId);",
                   "      flushDeferredDisposes();",
                   "    }",
                   "  }",
                   "",
                   "  // ── 排空器接线"),
     J("      flushDeferredDisposes();",
       "    }",
       "  }",
       "",
       "  // ── 排空器接线"),
     "执行那条路的收尾不提交自己的仓库"),
    ("H7", HTTP, "if (changed) deps.onOwnToolToggled?.(own.agentId);", "deps.onOwnToolToggled?.(own.agentId);",
     "没改动行也换会话(空操作被说成生效)"),
    ("H8", HTTP, "if (tool === undefined) {", "if (tool === undefined && false) {",
     "停用一条不存在的工具不回 404"),
    ("H9", HTTP, "if (n === null || n.agentId !== own.agentId) {", "if (n === null) {",
     "删得到别的角色的经验条目"),
    # ── V:人读面视图 ──────────────────────────────────────────────
    ("V1", OKV, 'state: t.problem !== null ? "invalid" : disabledAt !== null ? "disabled" : "usable",',
     'state: disabledAt !== null ? "disabled" : "usable",', "格式不对的工具在人读面上显示成「在用」"),
    # ── W:界面判据 ────────────────────────────────────────────────
    ("W1", SEC, 'if (own === undefined || own.repoState === "unavailable") return "";', 'if (own === undefined) return "";',
     "仓库读不到时标题上仍编出「工具 0 个」"),
    ("W2", SEC, 'if (tool.state === "invalid") return { text: "格式不对", tone: "cinnabar" };',
     'if (tool.state === "invalid-never") return { text: "格式不对", tone: "cinnabar" };',
     "格式不对的工具在界面上显示成「在用」"),
    ("W3", RH, "{hasOwnKit && found?.own !== undefined && (", "{found !== null && (",
     "没有这组能力的角色(业务经理)也画出这一块"),
    # ── F:真模型实验之后修掉的四个问题 + abort 路径三处误报(2026-11-28)────
    # F1–F4 活干完即停:判据 workFinishedByCall + 接线
    ("F1", EXEC, 'if (call.name !== "work_update" || call.isError) return null;',
     'if (call.isError) return null;', "任何一次成功的工具调用 + 库里已终态都算「干完了」"),
    ("F2", EXEC, 'if (call.name !== "work_update" || call.isError) return null;',
     'if (call.name !== "work_update") return null;', "报错的 work_update 也算干完了"),
    ("F3", EXEC, "if (w === null || !isTerminalWorkStatus(w.status)) return null;",
     "if (w === null) return null;", "不看库里的状态:参数说 done 而写口拒了也算办完"),
    ("F4", EXEC, "...(opts.stopWhenDone === false", "...(opts.stopWhenDone !== false",
     "活干完即停缺省关掉(只有显式要求才停)"),
    ("F5", SESS_TURN, "if (opts.stopAfterTool !== undefined) {",
     "if (opts.stopAfterTool !== undefined && false) {", "工具结束时根本不问判据"),
    ("F6", SESS_TURN,
     J("    abortRequested = true;",
       "    void requestSessionAbort(opts.session).then((err) => {",
       "      if (err === null) return;",
       "      abortError = err;",
       "      log.error(`turn: 活干完即停时 abort() 报错("),
     J("    abortRequested = true;",
       "    Promise.resolve(null as string | null).then((err) => {",
       "      if (err === null) return;",
       "      abortError = err;",
       "      log.error(`turn: 活干完即停时 abort() 报错("),
     "判说要停却不 abort 会话(模型接着跑)"),
    ("F7", SESS_TURN, "resultSummary: `${label},平台在此结束这一轮(之后不再调模型)`,",
     'resultSummary: "",', "轨迹里的标记行不写原因"),
    ("F8", SESS_TURN, "...(finishedBy !== null ? { finishedBy } : {}),", "...{},",
     "结果里不带 finishedBy(宿主分不出「干完即停」)"),
    ("F9", SESS_TURN,
     "if (promptErrorMessage !== null && !stopped && finishedBy === null) throw promptErrorValue;",
     "if (promptErrorMessage !== null && !stopped) throw promptErrorValue;",
     "即停让 prompt() 以错误收尾时被当成回合故障抛给调用方"),
    ("F10", SESS_TURN,
     J("    // `abortRequested` 置真:「打断与超时一律不算无下文」,这里同理 —— 它不是「模型没说话」",
       "    abortRequested = true;"),
     "    // `abortRequested` 置真:「打断与超时一律不算无下文」,这里同理 —— 它不是「模型没说话」",
     "即停的回合不记「平台打断过」⇒ 被报成没下文 / 被掐掉的 error 被记成 provider 故障"),
    ("F11", SERVE, '? "干完即停"', '? "结束"', "收尾提交把「干完即停」写成「结束」"),
    ("F12", PROJ,
     J("        lines.push(",
       "          `**这条工作项已到终态。**如果这一轮就是在执行它(任务开头是 \\`# 工作项 ${workId.value}\\`),` +",
       "            \"平台会在这一步结束这一轮 —— 之后再调的工具不会被执行;该写的工件、该记的经验都应当在之前做完。\",",
       "        );"),
     "        ;",
     "work_update 写到终态时不告诉模型「这一步之后不再调工具」"),
    # F13–F15 凭据通道:key 只进 ModelRuntime 的内存
    ("F13", PROV, "if (!apiKey) return false;", "return true;",
     "空 key 也说「设进去了」(冒充 runtime)"),
    ("F14", PROV, "if (pending === undefined) {", "if (true) {",
     "每次建会话重建一份 ModelRuntime"),
    ("F15", SESS, "if (opts.model !== undefined && opts.apiKey !== undefined) {",
     "if (opts.model !== undefined && opts.apiKey !== undefined && false) {",
     "给了 apiKey 也不建 ModelRuntime(key 没有通道进 SDK)"),
    ("F16", SESS, "if (await armRuntimeApiKey(modelRuntime, opts.model.provider, opts.apiKey)) {",
     "if (true) {", "没把 key 设进去也报「走了运行期通道」"),
    ("F17", SESS, "...(modelRuntime !== undefined ? { modelRuntime } : {}),", "...{},",
     "自建的 ModelRuntime 不交给 createAgentSession"),
    ("F18", SERVE, "...(currentProvider !== null ? { apiKey: currentProvider.apiKey } : {}),", "...{},",
     "宿主建会话时不把 key 交给 createPlatformSession"),
    # F19–F20 board_read 按项目隔离
    ("F19", BLACK, "if (a === null || ctx.project === null || a.projectId !== ctx.project.id) {",
     "if (a === null) {", "board_read 读得到别的项目的工件"),
    ("F20", BLACK, "if (a === null || ctx.project === null || a.projectId !== ctx.project.id) {",
     "if (a === null || ctx.project === null) {", "board_read 不比对工件属于哪个项目"),
    ("F21", BLACK, "if (a === null || ctx.project === null || a.projectId !== ctx.project.id) {",
     "if (a === null || a.projectId !== ctx.project.id) {", "没有项目的调用者读得到任意工件"),
    # F22–F23 能力说明文字
    ("F22", PROMPT, '  "mcp.read": "查看外部工具(MCP)的目录与各角色的授权",\n', "",
     "mcp.read 在角色简报里没有说明文字"),
    ("F23", PROMPT, "for (const c of spec.ceiling) lines.push(`- ${CAPABILITY_LABEL[c]}`);",
     "for (const c of spec.ceiling.slice(1)) lines.push(`- ${CAPABILITY_LABEL[c]}`);",
     "角色简报少列一条能力"),
    # F24–F28 平台自己掐掉的回合不算模型 / provider 的错
    ("F24", SESS_TURN,
     "const platformAborted = (): boolean => abortRequested || opts.aborted?.() === true;",
     "const platformAborted = (): boolean => opts.aborted?.() === true;",
     "看门狗 / 活干完即停自己掐的不算「平台打断过」"),
    ("F25", SESS_TURN,
     "const platformAborted = (): boolean => abortRequested || opts.aborted?.() === true;",
     "const platformAborted = (): boolean => abortRequested;",
     "宿主直接掐的(甲方按停止)不算「平台打断过」"),
    ("F26", SESS_TURN, "        if (platformAborted()) {\n          log.muted(",
     "        if (false) {\n          log.muted(",
     "被掐掉的调用照旧按 provider 故障分类"),
    ("F27", SESS_TURN, "if (!platformAborted()) warnIfAllZero(opts.agentId, total, usageCalls.length);",
     "warnIfAllZero(opts.agentId, total, usageCalls.length);",
     "被打断的回合用量 0 也报「SDK 字段名是不是变了」"),
    ("F28", SESS_TURN, "platformAborted() || timedOut || providerError !== undefined",
     "abortRequested || timedOut || providerError !== undefined",
     "宿主掐掉的回合又被算成「没有下文」"),
    ("F29", SERVE,
     J("        // 宿主自己的中断(甲方按了停止)要让 `runTurn` 知道(2026-11-28 真机补):被掐掉的回合",
       "        // 不算「没有下文」,被掐掉的那次调用也不按 provider 故障处置 —— 那是平台掐的,不是模型的错。",
       "        aborted: () => aborted,"),
     J("        // 宿主自己的中断(甲方按了停止)要让 `runTurn` 知道(2026-11-28 真机补):被掐掉的回合",
       "        // 不算「没有下文」,被掐掉的那次调用也不按 provider 故障处置 —— 那是平台掐的,不是模型的错。"),
     "聊天那条路不把宿主的中断告诉 runTurn"),
    ("F30", SERVE,
     J("        // 宿主自己的中断(甲方按了停止 / 整个上下文停掉)要传到 `runTurn`:与聊天那条路同一条接线。",
       "        aborted: () => aborted,"),
     "        // 宿主自己的中断(甲方按了停止 / 整个上下文停掉)要传到 `runTurn`:与聊天那条路同一条接线。",
     "执行那条路不把宿主的中断告诉 runTurn(被停掉的活记成 failed)"),
]


def run_vitest() -> tuple[bool, str]:
    cmd = ["npx", "vitest", "run", *TESTS, "--reporter=dot"]
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
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
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv[1:]
    only = set(args)
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
        if src.count(old) > 1:
            results.append((mid, note, False, f"变异点不唯一({src.count(old)} 处)—— 锚点要带上下文"))
            continue
        mutated = src.replace(old, new, 1)
        assert mutated != src, f"{mid} 替换后与原文相同(变异没发生)"
        if check_only:
            results.append((mid, note, True, "锚点在(未跑)"))
            continue
        full.write_text(mutated)
        try:
            ok, detail = run_vitest()
        finally:
            full.write_text(originals[path])
        results.append((mid, note, ok, detail if not ok else "红 ✔"))

    print("\n═══ 变异自检 · 自己的仓库与经验库批次(040)═══")
    bad = 0
    for mid, note, ok, detail in results:
        mark = ("🔵 锚点" if ok else "🟢 找不到") if check_only else ("🔴 变红" if ok else "🟢 漏网")
        if not ok:
            bad += 1
        tail = "\n       ".join((detail or "").splitlines()[:6])
        print(f"{mark}  {mid}  {note}\n       {tail}")
    for path, src in originals.items():
        now = (ROOT / path).read_text()
        if now != src:
            print(f"⚠️  {path} 复原不完整")
            bad += 1
    # ⚠️ **一条都没跑不算通过**(2026-11-28 实测踩过:0/0 却报「判据有牙 ✅」)。
    if len(results) == 0:
        unknown = sorted(only - {m[0] for m in MUTATIONS}) if only else []
        reason = f"这些编号不存在:{', '.join(unknown)}" if unknown else "变异表是空的"
        print(f"\n⚠️  一条变异都没跑 —— {reason}")
        return 1
    ids = [m[0] for m in MUTATIONS]
    assert len(ids) == len(set(ids)), "变异编号重复"
    print(f"\n结论:{len(results) - bad}/{len(results)} 条{'锚点核对通过' if check_only else '变异实测变红'}"
          + ("" if check_only else (" —— 判据有牙 ✅" if bad == 0 else f" —— 有 {bad} 条没咬合 ❌")))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
