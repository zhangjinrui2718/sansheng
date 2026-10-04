/**
 * Sansheng 平台 · BC0 Identity · 全局角色与角色规格
 *
 * 来源:`docs/DESIGN-AGENTS.md` §2–§5(四个角色的 ceiling / writeKinds / 出厂集合)
 * 与 `docs/DESIGN-PLATFORM.md` §7.1(`RoleSpec` 形状)。
 *
 * **核心事实:角色是「全局的人」,不随项目变化。** 因此 `clientFacing` 这类属性
 * 定义在这里(代码内常量),而不是运行时数据 —— 它因此在结构上不存在被篡改的
 * 路径。这是「甲方只与业务经理交互」能被机械保证的前提(设计 1 §4.3)。
 */
import {
  CAPABILITY_TOOLS,
  expandCapabilities,
  CAPABILITIES,
  type Capability,
  type ToolName,
} from "../harness/capability.js";

/** 四个全局角色。增删角色 = 改这个联合 + ROLE_SPECS,一次显式代码评审。 */
export type ProjectRole =
  | "business_manager" // 业务经理(唯一 clientFacing)
  | "project_manager" // 项目经理
  | "worker" // 执行工种(可多个,分工程/算法/数据)
  | "quality_reviewer"; // 质检审查员

export const PROJECT_ROLES = [
  "business_manager",
  "project_manager",
  "worker",
  "quality_reviewer",
] as const satisfies readonly ProjectRole[];

/** worker 的领域细分。枚举而非自由文本 —— 自由文本会让「算法/工程/数据」的
 *  一致性无法校验,而这三个值直接参与 work 分派与歧义检查(设计 1 §3.3)。 */
export type Specialization = "engineering" | "algorithm" | "data";

export const SPECIALIZATIONS = [
  "engineering",
  "algorithm",
  "data",
] as const satisfies readonly Specialization[];

/**
 * 工件 kind 闭合联合。转录自设计 1 §6.1。
 *
 * 其中 `client_question` / `meeting_note` / `change_record` 是**协议工具的必然
 * 产物**,不由模型手写,因此**不在任何角色的 writeKinds 里**(设计 1 §6.2)。
 * `decision` 是唯一例外 —— 问答流程会原子创建它,业务经理与项目经理也可以
 * 独立手写一条不来自问答的决策。
 *
 * `deliverable`(C2 新增,设计 1 §2.11.5)是**项目经理**在**根工作项**上写下的
 * 整合产物 —— 它表达「这份交付已经整合完了」这个**结构化事实**,是 `integrate`
 * 规则的终止判据(不是项目的终态,也不是 worker 的产出;设计 1 §2.11.5 明写
 * 「交付物」有四个所指,不许单独写这三个字)。
 *
 * ⚠️ **本闭集与 `migrations/016` 的 `artifacts.kind` CHECK 必须恰好相等。**
 * schema 侧先开、代码侧后跟的那段窗口里,读面是**关**的:`repo/artifacts.ts` 的
 * `rowToArtifact` 用下面这个 `isArtifactKind` 对未定义 kind **硬抛** —— 一条
 * schema 认、代码不认的行会让整个项目的 `getArtifact` / `listArtifacts` 全挂。
 */
export type ArtifactKind =
  | "decision"
  | "note"
  | "evidence"
  | "hypothesis"
  | "project_brief"
  | "work_brief"
  | "meeting_note"
  | "review_finding"
  | "change_record"
  | "client_question"
  | "deliverable";

export const ARTIFACT_KINDS = [
  "decision",
  "note",
  "evidence",
  "hypothesis",
  "project_brief",
  "work_brief",
  "meeting_note",
  "review_finding",
  "change_record",
  "client_question",
  "deliverable",
] as const satisfies readonly ArtifactKind[];

/**
 * 由协议工具创建、模型不能手写的 kind。转录自设计 1 §6.2。
 *
 * 注意含 `decision`:它确实会被 `answer` / `escalate` 流程原子创建。
 * 「能不能由模型**手写**」是另一个问题,见下面的 `WRITEKIND_EXEMPT_KINDS`。
 */
export const PROTOCOL_CREATED_KINDS = [
  "client_question",
  "decision",
  "meeting_note",
  "change_record",
] as const satisfies readonly ArtifactKind[];

/**
 * 「即便由协议工具创建,模型也可以手写」的例外。目前只有 `decision`。
 *
 * 为什么它是例外:业务经理或项目经理可能需要记录一条**不来自问答**的决策
 * (例如看完立项书后自主拍板的事)。其余三个协议 kind 没有这种正当场景 ——
 * 会议纪要只能由 `meeting_conclude` 产出,变更记录只能由 `change_review` 裁定产出。
 *
 * 因此判定规则是:`PROTOCOL_CREATED_KINDS \ WRITEKIND_EXEMPT_KINDS` 里的 kind
 * 不得出现在任何角色的 `writeKinds` 中。
 */
export const WRITEKIND_EXEMPT_KINDS = ["decision"] as const satisfies readonly ArtifactKind[];

/** 提示词单元 id。闭合集,**与 Capability 分属两个命名空间** ——
 *  早期设计里 `client.align` 与能力 `client.ask` 撞名,已改为 `business_manager.align`。 */
export type PromptUnitId =
  | "business_manager.core"
  | "business_manager.protocol"
  | "business_manager.align"
  | "project_manager.core"
  | "project_manager.protocol"
  | "worker.core"
  | "worker.protocol"
  | "quality_reviewer.core"
  | "quality_reviewer.protocol"
  | "collaboration.ask"
  | "collaboration.convene"
  | "change.propose";

/**
 * 一个角色的完整规格 = 架构上界 + 写面白名单 + 客户可见性 + 边界可见性。
 *
 * **`allow` 不在这里** —— 出厂工具集由 `ceiling` 推导(`factoryToolset`),
 * 不另存一份。少一个真相源就少一处漂移(旧 `enabledTools` 字段就是这么烂掉的:
 * 它是一份独立名单,于是可以声称有而实际没有)。
 */
export interface RoleSpec {
  readonly role: ProjectRole;
  /** 是否客户接口。**只有业务经理为 true**,这是 R1 的全部实现。 */
  readonly clientFacing: boolean;
  /** 架构上界。集合文件永远突破不了它。 */
  readonly ceiling: readonly Capability[];
  /** `blackboard.write` 能写的 kind 白名单。 */
  readonly writeKinds: readonly ArtifactKind[];
  /** 该角色装载的提示词单元。 */
  readonly promptUnits: readonly PromptUnitId[];
  /**
   * 仅供 UI 展示「本角色拿不到哪些工具」——**不参与授权判定**。
   * 写在这里而不是让它们「不存在」,是为了让边界在界面上看得见:
   * 「Worker 不能跟甲方说话」应该是一条明示,而不是一排没有的绿 chip。
   */
  readonly boundaryDeny: readonly ToolName[];
}

export const ROLE_SPECS: Readonly<Record<ProjectRole, RoleSpec>> = {
  // ── 业务经理:唯一客户接口 ──────────────────────────────────────
  business_manager: {
    role: "business_manager",
    clientFacing: true,
    ceiling: [
      "project.open", "project.read", "project.update", "project.close",
      "collab.ask", "collab.answer", "collab.read", "collab.convene",
      "collab.meeting.read", "collab.meeting.respond", "collab.meeting.conclude",
      "blackboard.read", "blackboard.write",
      "change.propose", "change.read",
      "blocker.open", "blocker.update", "blocker.read",
      "memory.read", "memory.write",
      "client.ask", "client.message",
    ],
    writeKinds: ["project_brief", "decision", "note"],
    promptUnits: [
      "business_manager.core", "business_manager.protocol",
      "business_manager.align", "collaboration.convene",
    ],
    // 业务经理不持有 work.* 与 code.* —— 它收敛诉求,不拆解、不干活
    boundaryDeny: [
      "work_create", "work_update", "work_assign", "work_list", "work_read", "report",
      "read", "grep", "find", "ls", "edit", "write", "bash",
    ],
  },

  // ── 项目经理:拆解与推进,不见甲方 ────────────────────────────────
  project_manager: {
    role: "project_manager",
    clientFacing: false,
    ceiling: [
      "project.read",
      "work.create", "work.update", "work.assign", "work.read", "work.list",
      "collab.ask", "collab.escalate", "collab.answer", "collab.read",
      "collab.convene", "collab.meeting.read", "collab.meeting.respond",
      "collab.meeting.conclude",
      "blackboard.read", "blackboard.write",
      "change.propose", "change.review", "change.read",
      "blocker.open", "blocker.update", "blocker.read",
      "memory.read", "work.report",
    ],
    // `deliverable` 只给项目经理:它是**整合的产物**(把子项产出收成一份交付),
    // 别的角色不加 —— worker 交付的是 `evidence`(执行产出),质检写 `review_finding`。
    writeKinds: ["work_brief", "decision", "note", "deliverable"],
    promptUnits: [
      "project_manager.core", "project_manager.protocol",
      "collaboration.ask", "collaboration.convene",
    ],
    // 边界:不能见甲方,也不能直接改项目范围(要改必须走 change.propose)
    boundaryDeny: ["ask_client", "tell_client", "project_update", "project_close"],
  },

  // ── Worker:唯一能动代码的角色 ───────────────────────────────────
  worker: {
    role: "worker",
    clientFacing: false,
    ceiling: [
      "project.read",
      "work.create", "work.update", "work.read", "work.list",
      "collab.ask", "collab.escalate", "collab.answer", "collab.read",
      "collab.meeting.read", "collab.meeting.respond",
      "blackboard.read", "blackboard.write",
      "change.propose", "change.review", "change.read",
      "blocker.open", "blocker.update", "blocker.read",
      "memory.read",
      "code.read", "code.write", "code.exec",
      "work.report",
    ],
    writeKinds: ["evidence", "hypothesis", "work_brief", "note"],
    promptUnits: [
      "worker.core", "worker.protocol", "collaboration.ask", "change.propose",
    ],
    // 边界:不能见甲方、不能主持或收尾会议、不能改项目范围
    boundaryDeny: [
      "ask_client", "tell_client",
      "convene", "meeting_conclude",
      "project_update", "project_close",
    ],
  },

  // ── 质检审查员:工具面最窄,只写 review_finding ──────────────────
  quality_reviewer: {
    role: "quality_reviewer",
    clientFacing: false,
    ceiling: [
      "project.read",
      "work.read", "work.list",
      "collab.ask", "collab.escalate", "collab.answer", "collab.read",
      "collab.meeting.read", "collab.meeting.respond",
      "blackboard.read", "blackboard.write",
      "change.review", "change.read",
      "blocker.open", "blocker.read",
      "memory.read",
    ],
    writeKinds: ["review_finding"],
    promptUnits: [
      "quality_reviewer.core", "quality_reviewer.protocol", "collaboration.ask",
    ],
    // 边界:不碰代码、不发起也不收尾会议、不改项目范围、不创建或改派工作
    boundaryDeny: [
      "convene", "meeting_conclude",
      "read", "grep", "find", "ls", "edit", "write", "bash",
      "ask_client", "tell_client",
      "project_update", "project_close",
      "work_create", "work_update", "work_assign",
    ],
  },
};

/**
 * 出厂工具集 = 由 ceiling 推导,不另存名单。
 *
 * 这样「集合文件声称的工具必须在池子里」(8-A 教训)在类型层面就成立 ——
 * allow 不可能包含 ceiling 之外的条目,因为它就是从 ceiling 算出来的。
 */
export function factoryToolset(role: ProjectRole): readonly ToolName[] {
  return expandCapabilities(ROLE_SPECS[role].ceiling);
}

/** 该角色能写的 kind(供 `WriteKindGate` 与 UI 用)。 */
export function writableKinds(role: ProjectRole): readonly ArtifactKind[] {
  return ROLE_SPECS[role].writeKinds;
}

// ── module-level type guards(项目纪律:禁止宽类型断言,窄化一律写 guard)──
export function isProjectRole(v: unknown): v is ProjectRole {
  return typeof v === "string" && (PROJECT_ROLES as readonly string[]).includes(v);
}

export function isSpecialization(v: unknown): v is Specialization {
  return typeof v === "string" && (SPECIALIZATIONS as readonly string[]).includes(v);
}

export function isArtifactKind(v: unknown): v is ArtifactKind {
  return typeof v === "string" && (ARTIFACT_KINDS as readonly string[]).includes(v);
}

/** 开发期自检:ceiling 里的每条能力都必须有工具映射(否则 ceiling 写了等于没写)。
 *  正常路径由 conformance 测试守着;这里留一个运行期兜底,给误改常量的人即时反馈。 */
for (const spec of Object.values(ROLE_SPECS)) {
  for (const cap of spec.ceiling) {
    if (!(cap in CAPABILITY_TOOLS)) {
      throw new Error(
        `ROLE_SPECS.${spec.role}.ceiling 含未映射工具的能力「${cap}」—— ` +
          `该能力在 CAPABILITY_TOOLS 里没有条目,授权时会静默失效`,
      );
    }
  }
  for (const k of spec.writeKinds) {
    if (!(ARTIFACT_KINDS as readonly string[]).includes(k)) {
      throw new Error(`ROLE_SPECS.${spec.role}.writeKinds 含未定义 kind「${k}」`);
    }
  }
}

/** 编译期断言用:确保 ceiling 里的值都是合法 Capability(多余或拼错会在这里报错)。 */
void (CAPABILITIES satisfies readonly Capability[]);
