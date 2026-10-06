/**
 * Sansheng 平台 · BC5 Harness · 能力模型
 *
 * 来源:`docs/DESIGN-PLATFORM.md` §3.1(闭合联合)与 §3.2(能力 → 工具展开)。
 * **本文件是那两张表的转录,不是独立设计。** 一旦两边不一致,
 * `tests/platform/design-conformance.test.ts` 会红 —— 设计文档是唯一真相源。
 *
 * 两个概念的分工:
 *   Capability  权限判定的单位(「这个角色原则上能不能做这类事」)
 *   ToolName    模型实际能调的东西(挂进 createAgentSession 的 customTools)
 * 一条 capability 可以展开成 1~N 个工具(`blackboard.read` → `board_list` + `board_read`)。
 */

/**
 * 能力闭合联合。**加一条必须走设计文档评审** —— 它是权限面的最小单位,
 * 而权限面的形状决定了整套组织架构(见设计 1 §1)。
 */
export type Capability =
  // ── BC1 项目与工作 ──
  | "project.open" // 立项
  | "project.read"
  | "project.update" // 改 name / goal / status(active|paused),非终态
  | "project.close" // 终态 done|abandoned,不可逆
  | "work.create" // 拆解
  | "work.update"
  | "work.assign" // 改派(create 之后换人)
  | "work.read"
  | "work.list"
  // ── BC2 协作 ──
  | "collab.ask" // 向某角色提问(提问者进入 blocked)
  | "collab.answer"
  | "collab.read" // 列出 / 读取提问与升级
  | "collab.convene" // 发起对焦会议
  | "collab.meeting.read"
  | "collab.meeting.respond" // 参会者表态
  | "collab.meeting.conclude" // 主持人出纪要,会议落终态
  | "collab.escalate" // 向上一层升级(目标由平台计算)
  // ── BC3 工件 ──
  | "blackboard.read"
  | "blackboard.write"
  // ── BC4 变更与阻塞 ──
  | "change.propose"
  | "change.review"
  | "change.read"
  | "blocker.open"
  | "blocker.update"
  | "blocker.read"
  // ── BC7 记忆 ──
  | "memory.read"
  | "memory.write"
  // ── 面向甲方(受 scope 门控,见设计 1 §4.3)──
  | "client.ask"
  | "client.message"
  // ── 执行 ──
  | "code.read"
  | "code.write"
  | "code.exec"
  | "work.report"
  // ── 021:审查结论。**平台只认这个工具调用**,不解析 review_finding 的正文 ——
  // 见 tools/review.ts 文件头(事故 2026-10-06 08:57)。
  | "work.review_verdict";

/** 闭合集数组形式 —— 遍历/校验用。顺序与设计文档一致。 */
export const CAPABILITIES = [
  "project.open",
  "project.read",
  "project.update",
  "project.close",
  "work.create",
  "work.update",
  "work.assign",
  "work.read",
  "work.list",
  "collab.ask",
  "collab.answer",
  "collab.read",
  "collab.convene",
  "collab.meeting.read",
  "collab.meeting.respond",
  "collab.meeting.conclude",
  "collab.escalate",
  "blackboard.read",
  "blackboard.write",
  "change.propose",
  "change.review",
  "change.read",
  "blocker.open",
  "blocker.update",
  "blocker.read",
  "memory.read",
  "memory.write",
  "client.ask",
  "client.message",
  "code.read",
  "code.write",
  "code.exec",
  "work.report",
  "work.review_verdict",
] as const satisfies readonly Capability[];

/**
 * 工具名闭合联合 = Pi SDK 内置 8 个 + 平台自有 33 个。
 *
 * SDK 侧:`read` / `grep` / `find` / `ls` / `edit` / `write` / `bash` / `powershell`。
 * 平台侧走 `createAgentSession({ customTools })` —— SDK 的 allowlist 对
 * builtin / extension / customTools **统一过滤**(`isAllowedTool`),所以两边
 * 可以混在同一个 `tools: string[]` 名单里。`powershell` 不在任何角色的
 * ceiling 内(Windows-only,本平台不启用)。
 */
export type SdkToolName = "read" | "grep" | "find" | "ls" | "edit" | "write" | "bash";

export type PlatformToolName =
  | "project_open" | "project_read" | "project_update" | "project_close"
  | "work_create" | "work_update" | "work_assign" | "work_list" | "work_read"
  | "ask_role" | "answer" | "ask_list" | "ask_read"
  | "convene" | "meeting_read" | "meeting_respond" | "meeting_conclude" | "escalate"
  | "board_list" | "board_read" | "board_write"
  | "change_propose" | "change_review" | "change_list" | "change_read"
  | "blocker_open" | "blocker_update" | "blocker_list" | "blocker_read"
  | "memory_search" | "memory_remember"
  | "ask_client" | "tell_client"
  | "report"
  | "review_verdict";

export type ToolName = SdkToolName | PlatformToolName;

/**
 * 能力 → 工具展开表。转录自设计 1 §3.2。
 *
 * 不变式(由 conformance 测试守护):
 *   - 键集合 === CAPABILITIES(不多不少)
 *   - 工具名全局唯一(一个工具不能挂到两条能力下,否则展开有歧义)
 */
export const CAPABILITY_TOOLS: Readonly<Record<Capability, readonly ToolName[]>> = {
  // BC1
  "project.open": ["project_open"],
  "project.read": ["project_read"],
  "project.update": ["project_update"],
  "project.close": ["project_close"],
  "work.create": ["work_create"],
  "work.update": ["work_update"],
  "work.assign": ["work_assign"],
  "work.read": ["work_read"],
  "work.list": ["work_list"],
  // BC2
  "collab.ask": ["ask_role"],
  "collab.answer": ["answer"],
  "collab.read": ["ask_list", "ask_read"],
  "collab.convene": ["convene"],
  "collab.meeting.read": ["meeting_read"],
  "collab.meeting.respond": ["meeting_respond"],
  "collab.meeting.conclude": ["meeting_conclude"],
  "collab.escalate": ["escalate"],
  // BC3
  "blackboard.read": ["board_list", "board_read"],
  "blackboard.write": ["board_write"],
  // BC4
  "change.propose": ["change_propose"],
  "change.review": ["change_review"],
  "change.read": ["change_list", "change_read"],
  "blocker.open": ["blocker_open"],
  "blocker.update": ["blocker_update"],
  "blocker.read": ["blocker_list", "blocker_read"],
  // BC7
  "memory.read": ["memory_search"],
  "memory.write": ["memory_remember"],
  // 甲方
  "client.ask": ["ask_client"],
  "client.message": ["tell_client"],
  // 执行
  "code.read": ["read", "grep", "find", "ls"],
  "code.write": ["edit", "write"],
  "code.exec": ["bash"],
  "work.report": ["report"],
  "work.review_verdict": ["review_verdict"],
};

/** SDK 内置工具名集合。**必须先于 PLATFORM_TOOLS 初始化** —— 后者在模块加载期
 *  就要读它,顺序颠倒会踩 TDZ(const 声明不提升)。 */
const SDK_TOOL_SET: ReadonlySet<string> = new Set<SdkToolName>([
  "read", "grep", "find", "ls", "edit", "write", "bash",
]);

function isSdkTool(t: string): t is SdkToolName {
  return SDK_TOOL_SET.has(t);
}

/** 这个工具名是否由 Pi SDK 提供(平台不需要自己实现)。 */
export function isSdkToolName(t: string): t is SdkToolName {
  return SDK_TOOL_SET.has(t);
}

/** 全部平台自有工具名(不含 SDK 内置)。 */
export const PLATFORM_TOOLS: readonly PlatformToolName[] = Object.values(CAPABILITY_TOOLS)
  .flat()
  .filter((t): t is PlatformToolName => !isSdkTool(t));

/** 全部工具名(含 SDK 内置),按能力展开后去重。 */
export const ALL_TOOLS: readonly ToolName[] = [...new Set(Object.values(CAPABILITY_TOOLS).flat())].sort();

const TOOL_SET: ReadonlySet<string> = new Set(ALL_TOOLS);

/** module-level type guard:工具名闭集校验(集合文件里的拼写错误靠它挡)。 */
export function isToolName(v: unknown): v is ToolName {
  return typeof v === "string" && TOOL_SET.has(v);
}

/**
 * 把一组能力展开成工具名列表(去重,保序:按 CAPABILITIES 的声明顺序)。
 *
 * 保序是为了让 `createAgentSession({ tools })` 的名单在不同调用间稳定 ——
 * 名单顺序影响不到权限,但稳定的输出让测试断言与日志 diff 可读。
 */
export function expandCapabilities(caps: Iterable<Capability>): ToolName[] {
  const want = new Set(caps);
  const out: ToolName[] = [];
  const seen = new Set<ToolName>();
  for (const cap of CAPABILITIES) {
    if (!want.has(cap)) continue;
    for (const tool of CAPABILITY_TOOLS[cap]) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      out.push(tool);
    }
  }
  return out;
}

/** module-level type guard(项目纪律:禁止宽类型断言,窄化一律写 guard)。 */
export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}
