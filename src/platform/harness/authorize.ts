/**
 * Sansheng 平台 · BC5 Harness · 授权求解(三重门控)
 *
 * 来源:`docs/DESIGN-PLATFORM.md` §4。这是整套设计的支点 ——
 * **「工具 = 能力 × 作用域」在这里从一句话变成可执行代码。**
 *
 * ── 为什么分成求解期与调用期两个阶段 ─────────────────────────────
 *
 * 有些判定在「装配工具集」时就能做完(这个角色原则上能不能做这类事、
 * 这个项目是不是 active);有些**必须等到模型真正发起调用**才知道:
 *
 *   - `board_write(kind=...)` 的 `kind` 是调用参数 —— 求解期根本不知道
 *   - `ask_role(target=...)` 的 `target` 也是调用参数
 *
 * 混在一起写会得到一个「求解期假装校验了 kind」的假门。设计 1 §4.2 的
 * 七步里,第 6 步(WriteKindGate)本来就标注为**工具运行时**校验,这里照着实现:
 *
 *   求解期  solveToolset()    → 能力级门控,产出工具面
 *   调用期  authorizeCall()   → 参数级门控,产出允许/拒绝
 *
 * 两道都**只减不增**:集合文件突破不了 ceiling,调用参数突破不了 scope 与 writeKind。
 */
import {
  CAPABILITIES,
  CAPABILITY_TOOLS,
  expandCapabilities,
  isToolName,
  type Capability,
  type ToolName,
} from "./capability.js";
import {
  ROLE_SPECS,
  ARTIFACT_KINDS,
  isArtifactKind,
  type ArtifactKind,
  type ProjectRole,
  type Specialization,
} from "../identity/role.js";

// ── 领域类型(BC0 Identity + BC1 的项目侧最小子集)────────────────

/** 全局 Agent。角色是「全局的人」,创建后不随项目变化。 */
export interface Agent {
  readonly id: string;
  readonly role: ProjectRole;
  readonly specialization?: Specialization;
  readonly displayName: string;
}

export type ProjectStatus = "draft" | "active" | "paused" | "done" | "abandoned";

export interface ProjectAssignment {
  readonly agentId: string;
  readonly removedAt?: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly assignments: readonly ProjectAssignment[];
}

/**
 * 用户可编辑的工具集合(`harness/tools/{role}.json` 的形态,沿用 7-E 格式)。
 * 沿用**工具名**而非能力名 —— 用户看到的是工具,不是能力。
 */
export interface ToolSetFile {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

// ── 拒绝结果 ─────────────────────────────────────────────────────

export type DenialCode =
  | "ceiling" // 超出角色架构上界
  | "scope" // 上界内,但当前作用域不允许
  | "writeKind" // 能力有,但这次调用的 kind 不在白名单
  | "unknownTool"; // 名单里出现了不认识的工具名

export interface Denial {
  readonly code: DenialCode;
  /** 被拒的能力或工具名 */
  readonly subject: string;
  /** 对用户可见的理由(7-E 纪律:提权失败必须可见,不许静默丢弃) */
  readonly reason: string;
  /**
   * 这个拒绝是因为「给的值根本不存在」,而不是「无权做这件事」。
   *
   * 为什么必须区分:两者的**下一步动作完全不同** ——
   *   值不存在   → 模型记错了参数名,回灌合法值**全集**即可自纠
   *   存在但无权 → 模型越权,回灌**该角色**的合法值,换一个值也没用
   * 派发器据此选更贴切的错误码(参数错 vs 权限错)。合成一个会让模型的下一步
   * 失去依据 —— 而它只能靠错误信息决定下一步。
   */
  readonly invalidValue?: boolean;
  /** 结构化补充。`writeKind` 拒绝时回灌合法 kind 列表 —— 8-F 教训:
   *  「传错参数」的表现形式往往是编造,必须告诉模型合法值是什么。 */
  readonly alternatives?: readonly string[];
}

export type CallVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly denial: Denial };

export interface SolveResult {
  /** 最终工具面 —— 直接喂给 `createAgentSession({ tools })` */
  readonly tools: readonly ToolName[];
  /** 最终能力面(工具的来源,便于审计与调试) */
  readonly capabilities: readonly Capability[];
  /** 被 ceiling 挡下的(用户要了,架构不给) */
  readonly blockedByCeiling: readonly Denial[];
  /** 被 scope 挡下的(架构给了,作用域不给) */
  readonly blockedByScope: readonly Denial[];
  /** 用户集合文件里的无效条目(不认识的工具名) */
  readonly unknownTools: readonly Denial[];
}

// ── 能力分类:哪些需要「活跃项目」 ────────────────────────────────

/**
 * 需要 `project.status === "active"` 的能力族。
 *
 * 不在此列的两族是**项目无关**的:
 *   - `memory.*`  —— 记忆是关于「用户」的,跨项目(设计 2 §10)
 *   - `code.*`    —— 工作在 `settings.cwd` 里,不属于某个 project
 * `client.*` 单独走 clientFacing 规则,不重复要求 active(它以业务经理身份成立)。
 */
const PROJECT_SCOPED_PREFIXES = [
  "project.",
  "work.",
  "collab.",
  "blackboard.",
  "change.",
  "blocker.",
] as const;

/**
 * ⚠️ **`project.` 这一族里要挖掉三个**(2026-10-06 补,真机现场)。
 *
 * 原来 `needsActiveProject` 是纯前缀匹配 ⇒ 项目一收口(`done`/`abandoned`),
 * **连「读」和「开下一个」都被挡掉**。而这挡掉的是**甲方与业务经理之间
 * 唯一还开着的通道**:
 *
 * 真机:两个项目收口之后,再发消息拿到的是 `serve.ts` 里的
 * `code: "project_closed"` —— 用户想问一句「W3 那个券商结论现在还成立吗?」
 * 都发不出去。**项目里该冻结的是「干活」,不是「说话」。**
 *
 * 这三个留在 `active` 之外:
 *   · `project.read`  —— 收口之后**恰恰最该能读**:交付物、结论、依据都在那里,
 *     而「这个项目到底做成了什么」是甲方验收时要问的第一句。
 *   · `project.open`  —— 从一个已收口的项目**开下一个版本 / 新项目**就是 BM 的
 *     职责。它本来就是 project-scoped(要在一个具体项目上下文里开),但它
 *     **不修改那个项目**,所以不该被那个项目的状态挡住。
 *   · `project.close` —— 让它可达是为了拿到工具自己的那句「已是终态」报错,
 *     而不是被一道 scope 门拦成另一种说法。
 *
 * ⚠️ **`project.update` 不在列** —— 收口的项目**不许再改**(名字、目标、状态)。
 * 那正是「收口」这个词的语义。
 */
const DIALOGUE_SURVIVES_CLOSURE: ReadonlySet<Capability> = new Set<Capability>([
  "project.read",
  "project.open",
  "project.close",
]);

function needsActiveProject(cap: Capability): boolean {
  if (DIALOGUE_SURVIVES_CLOSURE.has(cap)) return false;
  return PROJECT_SCOPED_PREFIXES.some((p) => cap.startsWith(p));
}

/** 需要「目标在本项目内」的能力 —— 这两个的目标是调用参数,所以只在调用期校验。 */
const TARGETED_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  "collab.ask",
  "collab.escalate",
]);

// ── 接待模式:第一个项目之前 ─────────────────────────────────────

/**
 * **接待模式** = `project === null`,即「会话还没有项目」。
 *
 * 它对应的是那条 `project_id IS NULL` 的接待会话(全局唯一一条,见
 * `migrations/012_intake_session.sql`):甲方在这里与业务经理把诉求谈清楚,
 * 谈拢了由**业务经理**调 `project_open` 立项 —— 而不是让甲方填一张
 * 「创建项目」表单(那等于让甲方替业务经理立项,业务经理在整件事里没有位置)。
 *
 * ── 这份名单是怎么定的(不是照抄谁)────────────────────────────
 *
 * 判据只有一条:**这个能力的工具需不需要 `ctx.project`**。
 * 四个 `ROLE_SPECS[*].ceiling` 里,业务经理是唯一 clientFacing、也是唯一持有
 * `project.open` 的角色,所以实际的接待工具面就是下面这三个能力的展开:
 *
 *   - `project.open`   —— 立项这个动作本身就是接待模式的出口。它只需要
 *                         db / newId / now / ctx.agent,**不读 ctx.project**
 *                         (见 tools/project.ts 的 project_open)。
 *   - `memory.read` / `memory.write` —— 记忆是关于**用户**的、跨项目
 *                         (设计 1 §4.3 明写 `memory.*` 项目无关)。
 *
 * 被排除的,以及为什么(全部逐个核对过 `ctx.project` 的使用):
 *   - `project.read/update/close` —— 缺省目标就是 `ctx.project.id`;
 *     `project_close` 更是「关掉当前项目」,没有当前项目时语义不成立。
 *   - `work.*` / `blackboard.*` / `change.*` / `blocker.*` / `collab.*` ——
 *     全部按 project_id 归属,`needsActiveProject()` 已把这一类挡住。
 *   - `client.ask` / `client.message` —— **这一条是刻意的**:`ask_client` 落的
 *     `client_question` 是**工件**,而 `artifacts.project_id` 是 NOT NULL。
 *     接待阶段没有项目可挂,所以澄清只能走**正常对话**。
 *     (「候选项 + 倾向」那套纪律是**项目内**结构化决策的纪律,不是接待阶段的。)
 *   - `code.*` —— 业务经理的 ceiling 里没有它,而接待会话的 agent 固定是业务经理
 *     (宿主接线),所以这一族不在接待模式的实际工具面上。
 */
const INTAKE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "project.open",
  "memory.read",
  "memory.write",
]);

/**
 * 接待模式下这条能力可用吗。
 *
 * **导出**是为了让 `tools/registry.ts` 的调用期门用同一份判定 —— 求解期给过的
 * 工具面不构成「调用一定合法」的理由(会话可能是旧形态下建的)。
 */
export function isIntakeCapability(cap: Capability): boolean {
  return INTAKE_CAPABILITIES.has(cap);
}

/** 接待模式的能力面(报告 / 报错文案用;顺序稳定,便于断言)。 */
export function intakeCapabilities(): readonly Capability[] {
  return CAPABILITIES.filter((c) => INTAKE_CAPABILITIES.has(c));
}

// ── 工具 → 能力 反查 ─────────────────────────────────────────────

/** 反查表。工具名全局唯一(conformance 测试守护 E4),所以这个映射无歧义。 */
const TOOL_TO_CAPABILITY: ReadonlyMap<string, Capability> = (() => {
  const m = new Map<string, Capability>();
  for (const [cap, tools] of Object.entries(CAPABILITY_TOOLS) as [Capability, readonly ToolName[]][]) {
    for (const t of tools) m.set(t, cap);
  }
  return m;
})();

export function capabilityOfTool(tool: string): Capability | undefined {
  return TOOL_TO_CAPABILITY.get(tool);
}

// ── 求解期 ───────────────────────────────────────────────────────

/**
 * 求解一个 Agent 在某个项目里的有效工具面。
 *
 * `project === null` = **接待模式**(第一个项目之前,见 `INTAKE_CAPABILITIES`)。
 * 此时 scope 门只放行项目无关的能力,`project.open` 是其中之一 —— 否则
 * 业务经理永远开不了第一个项目。
 *
 * ── 粒度:工具级,不是能力级 ────────────────────────────────────
 *
 * 集合文件列的是**工具名**,门控算的是**能力** —— 两者粒度不同,必须选一个。
 * 这里选**工具级**,理由是安全:
 *
 *   `blackboard.read` 展开成 `board_list` + `board_read` 两个工具。
 *   如果按能力粒度授权,用户只写 `allow: ["board_list"]`(只想让它看列表)
 *   会连带拿到 `board_read`(按 id 读任意工件正文)—— **这是用户没要的权限**。
 *
 * 所以有效工具面 = `(allow \ deny) ∩ expand(ceiling)`,能力集是由工具集**反推**
 * 出来的报告字段,不是授权单位。
 *
 * ── 为什么 writeKind 不在这里 ────────────────────────────────────
 *
 * `board_write(kind=…)` 的 kind 是**调用参数**,求解期根本不知道。它属于
 * 调用期的第三道门(见 `authorizeCall`)。设计 1 §4.2 的七步里第 6 步本就
 * 标注为「工具运行时」校验 —— 放进求解期会得到一个假装校验了的假门。
 */
export function solveToolset(
  agent: Agent,
  project: Project | null,
  userToolSet?: ToolSetFile,
): SolveResult {
  const spec = ROLE_SPECS[agent.role];
  const ceilingTools = new Set<ToolName>(expandCapabilities(spec.ceiling));

  const blockedByCeiling: Denial[] = [];
  const blockedByScope: Denial[] = [];
  const unknownTools: Denial[] = [];

  // 步骤 3:requested(工具级)。
  // 未提供集合文件 → 取 ceiling 全集(出厂行为);提供了 → 严格按名单走,
  // 不隐式并回 ceiling —— 用户删掉一条就是要删掉它(7-E:集合文件是用户意图)。
  let requestedTools: Set<ToolName>;
  if (!userToolSet) {
    requestedTools = new Set(ceilingTools);
  } else {
    requestedTools = new Set<ToolName>();
    const denied = new Set(userToolSet.deny);
    for (const raw of userToolSet.allow) {
      if (denied.has(raw)) continue; // deny 优先
      if (!isToolName(raw)) {
        unknownTools.push({
          code: "unknownTool",
          subject: raw,
          reason: `不认识的工具名「${raw}」—— 已丢弃。工具名来自闭合集,拼写错误不会静默生效`,
        });
        continue;
      }
      requestedTools.add(raw);
    }
  }

  // 步骤 4:ceiling 门(工具级)。**越权条目必须可见**(7-E 纪律)。
  const inCeiling = new Set<ToolName>();
  for (const tool of requestedTools) {
    if (ceilingTools.has(tool)) {
      inCeiling.add(tool);
      continue;
    }
    const cap = capabilityOfTool(tool);
    blockedByCeiling.push({
      code: "ceiling",
      subject: tool,
      reason:
        `工具「${tool}」${cap ? `(能力 ${cap})` : ""}超出 ${agent.role} 的架构上界。` +
        `放开上界是改 ROLE_SPECS 的代码动作,不是改集合文件`,
      alternatives: [...ceilingTools].sort(),
    });
  }

  // 步骤 5:scope 门(按能力判定;同一能力下的多个工具只记一条拒绝)
  const scopedTools = new Set<ToolName>();
  const scopeDeniedCaps = new Set<Capability>();
  for (const tool of inCeiling) {
    const cap = capabilityOfTool(tool);
    if (cap === undefined) continue; // 理论上不可达:inCeiling 来自 ceilingTools
    if (scopeDeniedCaps.has(cap)) continue;
    const verdict = scopeGateAtSolve(cap, agent, project);
    if (verdict.ok) scopedTools.add(tool);
    else {
      scopeDeniedCaps.add(cap);
      blockedByScope.push(verdict.denial);
    }
  }

  // 能力集由工具集反推 —— 报告字段,不是授权单位
  const capabilities = new Set<Capability>();
  for (const t of scopedTools) {
    const cap = capabilityOfTool(t);
    if (cap !== undefined) capabilities.add(cap);
  }

  return {
    tools: [...scopedTools].sort(),
    capabilities: CAPABILITIES.filter((c) => capabilities.has(c)),
    blockedByCeiling,
    blockedByScope,
    unknownTools,
  };
}

/** 求解期 scope 判定:不依赖调用参数的规则。 */
function scopeGateAtSolve(
  cap: Capability,
  agent: Agent,
  project: Project | null,
): CallVerdict {
  const spec = ROLE_SPECS[agent.role];

  // 规则 0:**接待模式**(还没有项目)。
  // 只放行项目无关的能力 —— 名单与理由见 INTAKE_CAPABILITIES。
  if (project === null) {
    if (INTAKE_CAPABILITIES.has(cap)) return { ok: true };
    if (cap === "client.ask" || cap === "client.message") {
      return {
        ok: false,
        denial: {
          code: "scope",
          subject: cap,
          reason:
            `接待会话里还没有项目,不能调「${cap}」—— ask_client 落的 client_question 是` +
            `**工件**,而工件必须挂 project_id。接待阶段的澄清直接写在回复里(那是正常对话),` +
            `谈拢之后用 project_open 立项,项目内的结构化决策再走 ask_client`,
        },
      };
    }
    return {
      ok: false,
      denial: {
        code: "scope",
        subject: cap,
        reason:
          `能力「${cap}」需要项目作用域,而当前是接待会话(还没有项目)。` +
          `接待模式可用的能力只有:${intakeCapabilities().join(" / ")}`,
      },
    };
  }

  // 规则 1:client.* 是本角色**固有属性**,与项目无关
  if (cap === "client.ask" || cap === "client.message") {
    if (spec.clientFacing) return { ok: true };
    return {
      ok: false,
      denial: {
        code: "scope",
        subject: cap,
        reason:
          `角色 ${agent.role} 不是客户接口。` +
          `「甲方只与业务经理交互」由 ROLE_SPECS.clientFacing 决定,与项目成员身份无关`,
      },
    };
  }

  // 规则 3:项目内能力需要 active 项目
  if (needsActiveProject(cap)) {
    if (project.status === "active") return { ok: true };
    return {
      ok: false,
      denial: {
        code: "scope",
        subject: cap,
        reason: `项目 ${project.id} 当前状态为 ${project.status},非 active —— 项目内能力不可用`,
      },
    };
  }

  // memory.* / code.* 项目无关
  return { ok: true };
}

// ── 调用期 ───────────────────────────────────────────────────────

export interface CallContext {
  readonly agent: Agent;
  /**
   * 当前项目。**可空** = 接待会话(第一个项目之前)。
   *
   * 这里不写「不可达」的假设:调用期门必须自己处理 `project === null`,
   * 而不是依赖「求解期已经挡过了」—— 那正是求解期与调用期分两道的理由。
   */
  readonly project: Project | null;
}

/**
 * 工具**运行时**的参数级门控。
 *
 * 目前两条规则:
 *   - `blackboard.write` 的 `kind` 必须落在角色 writeKinds 内(设计 1 §4.4 第三道门)
 *   - `collab.ask` / `collab.escalate` 的 `target` 必须是本项目参与方(§4.3 规则 2)
 *
 * 其余能力与参数放行 —— 门只加在「有能力但不该做这一件具体事」的地方。
 */
export function authorizeCall(
  capability: Capability,
  params: Readonly<Record<string, unknown>>,
  ctx: CallContext,
): CallVerdict {
  const spec = ROLE_SPECS[ctx.agent.role];

  // ── 第三道门:writeKind(两级判定,见 Denial.invalidValue)──
  if (capability === "blackboard.write") {
    const kind = params["kind"];
    // 第一级:这个 kind 存在吗?不存在 → 参数错,回灌**全集**
    if (!isArtifactKind(kind)) {
      return {
        ok: false,
        denial: {
          code: "writeKind",
          subject: String(kind ?? "(缺失)"),
          reason: `「${String(kind ?? "(缺失)")}」不是合法工件 kind`,
          alternatives: [...ARTIFACT_KINDS],
          invalidValue: true,
        },
      };
    }
    // 第二级:存在但本角色不能写 → 权限错,回灌**该角色**的合法值
    if (!spec.writeKinds.includes(kind)) {
      return {
        ok: false,
        denial: {
          code: "writeKind",
          subject: kind,
          reason:
            `角色 ${ctx.agent.role} 不能写 kind=${kind}。` +
            `它只能写:${spec.writeKinds.join(" / ")}`,
          // 回灌合法 kind —— 8-F:工具协议段必须渲染参数清单,否则模型会传错参数名,
          // 而「传错」的表现形式往往是编造。
          alternatives: [...spec.writeKinds],
        },
      };
    }
    return { ok: true };
  }

  // ── 规则 2:通信目标必须在本项目内 ──
  if (TARGETED_CAPS.has(capability)) {
    // escalate 的目标由平台计算,不由模型指定 —— 调用参数里没有 target,
    // 它的合法性在 resolveEscalationTarget() 里保障,这里只校验模型显式给 target 的情况。
    const target = params["targetAgentId"];
    if (target === undefined) return { ok: true }; // escalate 的常态
    if (typeof target !== "string") {
      return {
        ok: false,
        denial: {
          code: "scope",
          subject: String(target),
          reason: `targetAgentId 必须是字符串`,
        },
      };
    }
    // 接待会话里没有项目,也就没有「项目内的目标」可指。
    // 这一条在今天的接待能力面上不可达(INTAKE_CAPABILITIES 不含 collab.*),
    // 但门必须自己判断,而不是假设调用方不会走到这里。
    if (ctx.project === null) {
      return {
        ok: false,
        denial: {
          code: "scope",
          subject: capability,
          reason: `接待会话里没有项目,无法指定项目内的通信目标`,
        },
      };
    }
    if (!isAssigned(ctx.project, target)) {
      return {
        ok: false,
        denial: {
          code: "scope",
          subject: capability,
          reason: `目标 agent「${target}」不是项目 ${ctx.project.id} 的参与方`,
          alternatives: activeMemberIds(ctx.project),
        },
      };
    }
    return { ok: true };
  }

  return { ok: true };
}

// ── 项目成员查询 ─────────────────────────────────────────────────

function isAssigned(project: Project, agentId: string): boolean {
  return project.assignments.some((a) => a.agentId === agentId && a.removedAt === undefined);
}

export function activeMemberIds(project: Project): string[] {
  return project.assignments.filter((a) => a.removedAt === undefined).map((a) => a.agentId);
}

export function isActiveMember(project: Project, agentId: string): boolean {
  return isAssigned(project, agentId);
}

// ── 升级路由:escalate 的目标由平台计算,模型无法指定 ─────────────

/**
 * 组织图的「向上一级」。这是 R2(不越级、不向下)能被**机械保证**的原因 ——
 * 模型调 `escalate` 时连目标参数都没有,自然越不了级。
 *
 * `null` 表示上面没有人了。业务经理是唯一这样的角色 —— 它的升级出口是
 * `client.ask`(向甲方),不是 escalate。
 *
 * ⚠️ **质检审查员 → 业务经理**(跳过项目经理):这是刻意选择,为了让审查独立。
 * 若质检必须经项目经理上报,那它就是在向「被审查对象」汇报。设计 2 §5.2 那句话
 * (「向项目经理或业务经理升级」)留有歧义,与「必定路由」的确定性相冲突,
 * 应改为明确的一级。见本批次报告。
 */
export const ESCALATION_TARGET: Readonly<Record<ProjectRole, ProjectRole | null>> = {
  // 两个执行角色的上一级都是项目经理 —— 它们平级,差别在**产出形态**
  // (研究工交信息,编码工交代码),不在组织层级。见 `identity/role.ts` 的
  // `EXECUTOR_ROLES` 注释。
  research_worker: "project_manager",
  coding_worker: "project_manager",
  project_manager: "business_manager",
  quality_reviewer: "business_manager",
  business_manager: null,
};

/**
 * 在项目里找出升级目标 agent。找不到(该项目没有这个角色的人)时返回 null ——
 * 调用方必须显式处理,不许静默丢消息(7-L 纪律:任何改变流程状态的通信都要留痕)。
 */
export function resolveEscalationTarget(
  agent: Agent,
  project: Project,
  members: readonly Agent[],
): Agent | null {
  const targetRole = ESCALATION_TARGET[agent.role];
  if (targetRole === null) return null;
  const ids = new Set(activeMemberIds(project));
  return members.find((m) => m.role === targetRole && ids.has(m.id)) ?? null;
}
