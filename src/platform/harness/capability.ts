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
  // ── 知识语料(设计 `docs/DESIGN-KNOWLEDGE.md`)──
  // **只读**:索引由平台做(零模型调用),agent 只消费 —— 所以没有 knowledge.write
  | "knowledge.read"
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
  "knowledge.read",
  "client.ask",
  "client.message",
  "code.read",
  "code.write",
  "code.exec",
  "work.report",
  "work.review_verdict",
] as const satisfies readonly Capability[];

/**
 * 能力 → **中文分组**(只给界面读;授权判定一个字节都不用它)。
 *
 * 为什么需要它:能力 id 本身是英文的点分名(`blackboard.read`),而成员页那张
 * 工具表要回答的是「这堆英文名到底都是些啥」。类型那一列取这里的分组名,
 * 于是 `board_list` / `board_read` 一眼归到「工件」,而不是又一行英文。
 *
 * ⚠️ **它是内容还是名字?** 分组名是**代码内常量**,不是从数据里读的 —— 与角色中文名
 * 同一个处置:只有这一处真相。给它写一张 `Record<Capability, string>`,TS 会在
 * 能力联合增删时**当场报缺项**,不会静默漂开。
 *
 * ⚠️ 分组**不是**授权单位(`ceiling` 里写的仍是能力 id),所以这里改一个名字
 * 不影响任何判定 —— 它只改屏幕上那一格的字。
 */
export const CAPABILITY_GROUP: Readonly<Record<Capability, string>> = {
  // BC1 项目与工作
  "project.open": "项目",
  "project.read": "项目",
  "project.update": "项目",
  "project.close": "项目",
  "work.create": "工作项",
  "work.update": "工作项",
  "work.assign": "工作项",
  "work.read": "工作项",
  "work.list": "工作项",
  // BC2 协作
  "collab.ask": "协作",
  "collab.answer": "协作",
  "collab.read": "协作",
  "collab.convene": "协作",
  "collab.meeting.read": "协作",
  "collab.meeting.respond": "协作",
  "collab.meeting.conclude": "协作",
  "collab.escalate": "协作",
  // BC3 工件
  "blackboard.read": "工件",
  "blackboard.write": "工件",
  // BC4 变更与阻塞
  "change.propose": "变更",
  "change.review": "变更",
  "change.read": "变更",
  "blocker.open": "阻塞",
  "blocker.update": "阻塞",
  "blocker.read": "阻塞",
  // BC7 记忆
  "memory.read": "记忆",
  "memory.write": "记忆",
  // 知识语料
  "knowledge.read": "知识语料",
  // 面向甲方
  "client.ask": "甲方",
  "client.message": "甲方",
  // 执行:三个 code.* 能力的工具是 read / grep / find / ls / edit / write / bash
  // —— 它们操作的是这台机器上的文件与命令,所以类型叫「本机操作」而不是「执行」。
  "code.read": "本机操作",
  "code.write": "本机操作",
  "code.exec": "本机操作",
  "work.report": "汇报",
  "work.review_verdict": "审查",
};

/** 一个能力的中文分组(界面用)。键是闭合联合,所以这里不会漏项。 */
export function capabilityGroup(cap: Capability): string {
  return CAPABILITY_GROUP[cap];
}

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
  | "project_open" | "project_list" | "project_read" | "project_update" | "project_close"
  | "work_create" | "work_update" | "work_assign" | "work_list" | "work_read"
  | "ask_role" | "answer" | "ask_list" | "ask_read"
  | "convene" | "meeting_read" | "meeting_respond" | "meeting_conclude" | "escalate"
  | "board_list" | "board_read" | "board_write"
  | "change_propose" | "change_review" | "change_list" | "change_read"
  | "blocker_open" | "blocker_update" | "blocker_list" | "blocker_read"
  | "memory_search" | "memory_remember"
  | "knowledge_search" | "knowledge_read"
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
  // ⚠️ `project_list` 归属 `project.read`(2026-06 补):它是「读项目」这个动作的
  // 一条腿,不是一个新能力 —— 为它新增能力要动 `Capability` 联合、
  // 角色 ceiling、以及 `check:design` 的能力↔工具表三处,而语义上它就是读。
  // 它存在的理由:业务经理此前**没有任何一条路**能知道库里有哪些项目
  // (`project_read` 要一个已知的 projectId,而那个 id 从哪来?),
  // 真机上因此对「甲方已经做过的项目」完全失明。
  "project.read": ["project_list", "project_read"],
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
  // 知识语料:目录级(knowledge_search)+ 正文级(knowledge_read)两个工具,
  // 与 board_list / board_read 同一条"粒度是工具级"的纪律 ——
  // 只想看列表不该连带拿到正文(而正文会吃光提示词预算)。
  "knowledge.read": ["knowledge_search", "knowledge_read"],
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
