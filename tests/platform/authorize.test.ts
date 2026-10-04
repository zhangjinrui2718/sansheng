/**
 * 三重门控求解器 · 行为测试
 *
 * 这个测试守护的是整套设计的支点(设计 1 §4):**工具 = 能力 × 作用域**。
 *
 * 分两层测,因为门控本来就分两个阶段(见 authorize.ts 文件头):
 *   求解期  solveToolset()   —— 装配工具集时能判的(ceiling / active 项目)
 *   调用期  authorizeCall()  —— 必须等模型真正发起调用才知道的(kind / target)
 *
 * 混在一起测会得到一个「假装求解期就校验了 kind」的假门 —— 那正是这个测试
 * 要防的东西。
 */
import { describe, it, expect } from "vitest";
import {
  solveToolset,
  authorizeCall,
  capabilityOfTool,
  resolveEscalationTarget,
  activeMemberIds,
  ESCALATION_TARGET,
  type Agent,
  type Project,
  type ProjectStatus,
} from "../../src/platform/harness/authorize.js";
import {
  PROJECT_ROLES,
  ROLE_SPECS,
  type ProjectRole,
} from "../../src/platform/identity/role.js";
import { ALL_TOOLS, CAPABILITY_TOOLS, type ToolName } from "../../src/platform/harness/capability.js";

// ── fixtures ─────────────────────────────────────────────────────

function agent(role: ProjectRole, id?: string): Agent {
  return {
    id: id ?? `agent-${role}`,
    role,
    displayName: role,
    ...(role === "worker" ? { specialization: "engineering" as const } : {}),
  };
}

function project(status: ProjectStatus, members: readonly Agent[]): Project {
  return {
    id: "p1",
    name: "测试项目",
    status,
    assignments: members.map((m) => ({ agentId: m.id })),
  };
}

const BM = agent("business_manager");
const PM = agent("project_manager");
const WK = agent("worker");
const QA = agent("quality_reviewer");
const ALL = [BM, PM, WK, QA];

const ACTIVE = project("active", ALL);
const DRAFT = project("draft", ALL);
const PAUSED = project("paused", ALL);

// ── 求解期:ceiling 门 ────────────────────────────────────────────

describe("求解期 · 无集合文件 → 出厂行为", () => {
  for (const role of PROJECT_ROLES) {
    it(`${role} 拿到自己 ceiling 的全集`, () => {
      const r = solveToolset(agent(role), ACTIVE);
      expect(r.blockedByCeiling).toEqual([]);
      expect(r.blockedByScope).toEqual([]);
      expect(r.unknownTools).toEqual([]);
      // 出厂工具面必须非空(否则这个角色什么都做不了,是个配置事故)
      expect(r.tools.length).toBeGreaterThan(0);
    });
  }

  it("business_manager 的出厂工具面含 ask_client / tell_client", () => {
    const r = solveToolset(BM, ACTIVE);
    expect(r.tools).toContain("ask_client");
    expect(r.tools).toContain("tell_client");
  });

  it("其余三个角色的出厂工具面不含 client.* 工具", () => {
    for (const a of [PM, WK, QA]) {
      const r = solveToolset(a, ACTIVE);
      expect(r.tools, `${a.role} 不该拿到 ask_client`).not.toContain("ask_client");
      expect(r.tools, `${a.role} 不该拿到 tell_client`).not.toContain("tell_client");
    }
  });
});

describe("求解期 · ceiling 门(集合文件越权必须可见)", () => {
  it("worker 手写 tell_client → 被 ceiling 挡下,且理由可见", () => {
    const r = solveToolset(WK, ACTIVE, { allow: ["tell_client"], deny: [] });
    expect(r.tools).toEqual([]);
    expect(r.blockedByCeiling).toHaveLength(1);
    const d = r.blockedByCeiling[0]!;
    expect(d.code).toBe("ceiling");
    // 粒度是工具级:拒绝的是工具名,理由里带出它属于哪条能力
    expect(d.subject).toBe("tell_client");
    expect(d.reason).toContain("tell_client");
    expect(d.reason).toContain("client.message");
    expect(d.reason.length, "拒绝理由不能是空串 —— 7-E:提权失败必须对用户可见").toBeGreaterThan(10);
  });

  it("四个非客户接口角色都无法通过集合文件拿到 client.*", () => {
    for (const a of [PM, WK, QA]) {
      const r = solveToolset(a, ACTIVE, { allow: ["ask_client", "tell_client"], deny: [] });
      expect(r.tools, `${a.role} 不该拿到 client.* 工具`).toEqual([]);
      expect(r.blockedByCeiling.length).toBeGreaterThan(0);
    }
  });

  it("ceiling 只减不增:集合文件给了上界外的能力,结果里一定没有它", () => {
    // worker 没有 convene(发起会议)
    const r = solveToolset(WK, ACTIVE, { allow: ["convene", "board_write"], deny: [] });
    expect(r.tools).toContain("board_write");
    expect(r.tools).not.toContain("convene");
    expect(r.blockedByCeiling.map((d) => d.subject)).toContain("convene");
  });

  it("不认识的工具名进 unknownTools,不静默生效", () => {
    const r = solveToolset(WK, ACTIVE, { allow: ["not_a_real_tool", "board_write"], deny: [] });
    expect(r.unknownTools).toHaveLength(1);
    expect(r.unknownTools[0]!.code).toBe("unknownTool");
    expect(r.unknownTools[0]!.subject).toBe("not_a_real_tool");
    expect(r.tools).toEqual(["board_write"]);
  });

  it("deny 优先于 allow", () => {
    const r = solveToolset(WK, ACTIVE, { allow: ["board_write"], deny: ["board_write"] });
    expect(r.tools).toEqual([]);
    expect(r.blockedByCeiling, "deny 掉的不算越权,不该进 blockedByCeiling").toEqual([]);
  });

  it("集合文件可以收窄工具面", () => {
    const full = solveToolset(WK, ACTIVE).tools.length;
    const narrow = solveToolset(WK, ACTIVE, { allow: ["board_list"], deny: [] }).tools;
    expect(narrow).toEqual(["board_list"]);
    expect(narrow.length).toBeLessThan(full);
  });
});

// ── 求解期:scope 门 ─────────────────────────────────────────────

describe("求解期 · scope 规则 3(项目须 active)", () => {
  for (const status of ["draft", "paused", "done", "abandoned"] as ProjectStatus[]) {
    it(`项目 ${status} → 项目内能力全部被 scope 挡下`, () => {
      const r = solveToolset(PM, project(status, ALL));
      expect(r.blockedByScope.length).toBeGreaterThan(0);
      for (const d of r.blockedByScope) {
        expect(d.code).toBe("scope");
        expect(d.reason).toContain(status);
      }
      // 项目内工具一个都不该剩下
      const projectTools = r.tools.filter((t) => {
        const c = capabilityOfTool(t);
        return c !== undefined && !c.startsWith("memory.") && !c.startsWith("code.");
      });
      expect(projectTools, `项目 ${status} 时不该留下项目内工具`).toEqual([]);
    });
  }

  it("memory.* 与 code.* 是项目无关的,非 active 项目下仍可用", () => {
    const r = solveToolset(WK, DRAFT);
    expect(r.tools).toContain("memory_search");
    expect(r.tools).toContain("read");
    expect(r.tools).toContain("bash");
  });

  it("业务经理在非 active 项目里仍拿得到 client.* 能力", () => {
    // client.* 是角色固有属性,不以项目状态为前提 —— 否则业务经理在项目
    // 关闭后就没法跟甲方交代了
    const r = solveToolset(BM, DRAFT);
    expect(r.blockedByScope.map((d) => d.subject)).not.toContain("client.ask");
  });
});

// ── R1 不变量(端到端)──────────────────────────────────────────

describe("R1 不变量 · 甲方那道门只有一个把手", () => {
  it("全部角色 × 全部工具名逐个试,只有 business_manager 能拿到 client.*", () => {
    const clientTools = ["ask_client", "tell_client"] as const;
    for (const role of PROJECT_ROLES) {
      for (const t of clientTools) {
        const r = solveToolset(agent(role), ACTIVE, { allow: [t], deny: [] });
        const got = r.tools.includes(t);
        expect(got, `${role} 拿到了 ${t}`).toBe(role === "business_manager");
      }
    }
  });

  it("即便把 client.* 灌进任意角色的 ceiling,scope 门仍是第二道防线", () => {
    // 说明:当前 ROLE_SPECS 下非客户接口角色的 ceiling 里没有 client.*,
    // 所以是 ceiling 门先命中。这条测试钉住的是「两层都拦」这个事实 ——
    // 如果将来有人往某个角色的 ceiling 里加了 client.*,ceiling 就漏了,
    // 此时 scope 门的规则 1 会接手。见 authorize.ts scopeGateAtSolve 规则 1。
    for (const role of PROJECT_ROLES) {
      if (ROLE_SPECS[role].clientFacing) continue;
      const has = ROLE_SPECS[role].ceiling.some((c) => c.startsWith("client."));
      expect(has, `${role} 的 ceiling 不该含 client.*`).toBe(false);
    }
  });
});

// ── 调用期:writeKind 门 ────────────────────────────────────────

describe("调用期 · writeKind 门(第三道门)", () => {
  it("worker 写 evidence → 放行", () => {
    const v = authorizeCall("blackboard.write", { kind: "evidence" }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(true);
  });

  it("质检审查员写 review_finding → 放行", () => {
    const v = authorizeCall("blackboard.write", { kind: "review_finding" }, { agent: QA, project: ACTIVE });
    expect(v.ok).toBe(true);
  });

  it("质检审查员写 evidence → 拒绝,并回灌合法 kind 列表", () => {
    const v = authorizeCall("blackboard.write", { kind: "evidence" }, { agent: QA, project: ACTIVE });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.denial.code).toBe("writeKind");
    expect(v.denial.subject).toBe("evidence");
    // 8-F 教训:回灌合法值,否则模型只能猜,而猜错的表现是编造
    expect(v.denial.alternatives).toEqual(["review_finding"]);
  });

  it("worker 写 review_finding → 拒绝(角色边界对称)", () => {
    const v = authorizeCall("blackboard.write", { kind: "review_finding" }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.denial.code).toBe("writeKind");
    expect(v.denial.alternatives).toContain("evidence");
  });

  it("不在 ARTIFACT_KINDS 里的 kind → 拒绝", () => {
    const v = authorizeCall("blackboard.write", { kind: "made_up" }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.denial.code).toBe("writeKind");
    expect(v.denial.alternatives).toContain("evidence");
  });

  it("缺 kind 参数 → 拒绝(不是放行)", () => {
    const v = authorizeCall("blackboard.write", {}, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(false);
  });

  it("协议创建的 kind 不属于任何角色的 writeKinds → 都被拒", () => {
    for (const k of ["client_question", "meeting_note", "change_record"]) {
      for (const a of ALL) {
        const v = authorizeCall("blackboard.write", { kind: k }, { agent: a, project: ACTIVE });
        expect(v.ok, `${a.role} 不该能手写 ${k}`).toBe(false);
      }
    }
  });

  it("decision 是文档化例外:业务经理与项目经理可手写", () => {
    for (const a of [BM, PM]) {
      const v = authorizeCall("blackboard.write", { kind: "decision" }, { agent: a, project: ACTIVE });
      expect(v.ok, `${a.role} 应该能写 decision`).toBe(true);
    }
    // worker 的 writeKinds 里没有 decision
    const v = authorizeCall("blackboard.write", { kind: "decision" }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(false);
  });

  it("与 writeKinds 常量逐角色对齐(不是硬编码的另一份名单)", () => {
    for (const role of PROJECT_ROLES) {
      const spec = ROLE_SPECS[role];
      const a = agent(role);
      for (const k of spec.writeKinds) {
        expect(
          authorizeCall("blackboard.write", { kind: k }, { agent: a, project: ACTIVE }).ok,
          `${role} 应能写 ${k}`,
        ).toBe(true);
      }
    }
  });
});

// ── 调用期:目标门 ──────────────────────────────────────────────

describe("调用期 · 规则 2(通信目标须在本项目内)", () => {
  it("目标在本项目内 → 放行", () => {
    const v = authorizeCall("collab.ask", { targetAgentId: PM.id }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(true);
  });

  it("目标不在本项目 → 拒绝,并列出可用成员", () => {
    const v = authorizeCall("collab.ask", { targetAgentId: "outsider" }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.denial.code).toBe("scope");
    expect(v.denial.alternatives).toEqual(activeMemberIds(ACTIVE));
  });

  it("escalate 不给 target 是常态 → 放行(目标由平台算)", () => {
    const v = authorizeCall("collab.escalate", {}, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(true);
  });

  it("target 不是字符串 → 拒绝", () => {
    const v = authorizeCall("collab.ask", { targetAgentId: 42 }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(false);
  });

  it("已移出项目的成员不算参与方", () => {
    const p: Project = {
      id: "p1",
      name: "x",
      status: "active",
      assignments: [{ agentId: PM.id, removedAt: Date.now() }],
    };
    const v = authorizeCall("collab.ask", { targetAgentId: PM.id }, { agent: WK, project: p });
    expect(v.ok).toBe(false);
  });

  it("与项目无关的能力不受目标规则影响", () => {
    const v = authorizeCall("memory.read", { query: "x" }, { agent: WK, project: ACTIVE });
    expect(v.ok).toBe(true);
  });
});

// ── 升级路由 ────────────────────────────────────────────────────

describe("升级路由 · 目标由平台计算,模型无法指定", () => {
  it("worker → project_manager", () => {
    expect(resolveEscalationTarget(WK, ACTIVE, ALL)?.id).toBe(PM.id);
  });

  it("project_manager → business_manager", () => {
    expect(resolveEscalationTarget(PM, ACTIVE, ALL)?.id).toBe(BM.id);
  });

  it("quality_reviewer → business_manager(跳过被审查方,保审查独立)", () => {
    expect(resolveEscalationTarget(QA, ACTIVE, ALL)?.id).toBe(BM.id);
  });

  it("business_manager 上面没有人;它的出口是 client.ask", () => {
    expect(resolveEscalationTarget(BM, ACTIVE, ALL)).toBeNull();
    expect(ESCALATION_TARGET.business_manager).toBeNull();
    expect(ROLE_SPECS.business_manager.ceiling).toContain("client.ask");
  });

  it("strictly 向上一层:不存在越级", () => {
    // worker 绝不能直接落到 business_manager
    expect(ESCALATION_TARGET.worker).not.toBe("business_manager");
    expect(ESCALATION_TARGET.worker).toBe("project_manager");
  });

  it("项目里没有目标角色的人 → null(调用方必须显式处理,不许静默丢消息)", () => {
    const onlyWorker = project("active", [WK]);
    expect(resolveEscalationTarget(WK, onlyWorker, [WK])).toBeNull();
  });

  it("目标角色的人不在本项目 → null", () => {
    const p = project("active", [WK]);
    expect(resolveEscalationTarget(WK, p, ALL)).toBeNull();
  });
});

// ── 收窄与诚实性 ────────────────────────────────────────────────

describe("工具面收窄的整体行为", () => {
  it("求解结果里的工具全部来自被授予的能力(无凭空工具)", () => {
    for (const role of PROJECT_ROLES) {
      const r = solveToolset(agent(role), ACTIVE);
      for (const t of r.tools) {
        expect(ALL_TOOLS, `${role} 的工具 ${t} 不在 ALL_TOOLS 里`).toContain(t);
        expect(capabilityOfTool(t), `${t} 反查不到能力`).toBeDefined();
      }
    }
  });

  it("capabilities 与 tools 自洽:每条被授予能力的工具都在结果里", () => {
    for (const role of PROJECT_ROLES) {
      const r = solveToolset(agent(role), ACTIVE);
      const toolSet = new Set<ToolName>(r.tools);
      for (const cap of r.capabilities) {
        for (const t of CAPABILITY_TOOLS[cap]) {
          expect(toolSet, `${role}:能力 ${cap} 被授予,但工具 ${t} 不在结果里`).toContain(t);
        }
      }
    }
  });

  it("每个拒绝都带非空理由(可见性纪律)", () => {
    const cases = [
      solveToolset(WK, ACTIVE, { allow: ["tell_client", "nope"], deny: [] }),
      solveToolset(PM, DRAFT),
    ];
    for (const r of cases) {
      for (const d of [...r.blockedByCeiling, ...r.blockedByScope, ...r.unknownTools]) {
        expect(d.reason.length, `${d.code}/${d.subject} 的理由为空`).toBeGreaterThan(5);
      }
    }
  });

  it("门只减不增:任何输入下,结果都不超出 ceiling 展开", () => {
    const userSets = [
      undefined,
      { allow: [] as string[], deny: [] as string[] },
      { allow: ["tell_client", "convene", "bash", "nope"], deny: [] },
      { allow: [...ALL_TOOLS] as string[], deny: [] },
    ];
    for (const role of PROJECT_ROLES) {
      const a = agent(role);
      const max = new Set(solveToolset(a, ACTIVE).tools);
      for (const us of userSets) {
        const r = solveToolset(a, ACTIVE, us);
        for (const t of r.tools) {
          expect(max, `${role} 在输入 ${JSON.stringify(us)} 下拿到了上界外的 ${t}`).toContain(t);
        }
      }
    }
  });
});

// ── 接待模式(project === null)────────────────────────────────────
//
// 设计 1 §9.2 只写了「一个项目的会话拓扑」,**没写「第一个项目之前」**。
// 那一段就是接待模式:`project_id IS NULL` 的那条会话(见 migrations/012)。
// 这几条断言守的是「用户在与项目无关的阶段仍然能与业务经理对话」这件事 ——
// 它此前不存在,前端的临时处置是一张「创建项目」表单(用户明确反对)。

describe("接待模式 · 工具面只含项目无关的能力", () => {
  it("业务经理在接待模式下拿到 project_open + 记忆工具", () => {
    const r = solveToolset(BM, null);
    // `tools` 是排序后的(见 solveToolset),所以这里是字典序
    expect(r.tools).toEqual(["memory_remember", "memory_search", "project_open"]);
    expect(r.capabilities).toEqual(["project.open", "memory.read", "memory.write"]);
    expect(r.blockedByCeiling).toEqual([]);
  });

  it("**client.* 在接待模式下不可用** —— client_question 是工件,工件必须挂项目", () => {
    const r = solveToolset(BM, null);
    expect(r.tools).not.toContain("ask_client");
    expect(r.tools).not.toContain("tell_client");
    const denied = r.blockedByScope.find((d) => d.subject === "client.ask");
    expect(denied, "client.ask 应当被 scope 门挡下,并且可见").toBeDefined();
    expect(denied!.reason).toContain("工件");
  });

  it("项目内能力在接待模式下全部被挡,且每条都有理由(可见性纪律)", () => {
    const r = solveToolset(BM, null);
    expect(r.blockedByScope.length).toBeGreaterThan(0);
    for (const d of r.blockedByScope) {
      expect(d.code).toBe("scope");
      expect(d.reason.length).toBeGreaterThan(5);
    }
    // 逐条核对:ceiling 里除了那三条,其余都该落在 blockedByScope
    const allowed = new Set(r.capabilities);
    for (const cap of ROLE_SPECS.business_manager.ceiling) {
      if (allowed.has(cap)) continue;
      expect(r.blockedByScope.map((d) => d.subject)).toContain(cap);
    }
  });

  it("只有业务经理能在接待模式下立项(其余角色的 ceiling 不含 project.open)", () => {
    for (const role of PROJECT_ROLES) {
      const r = solveToolset(agent(role), null);
      if (role === "business_manager") expect(r.tools).toContain("project_open");
      else expect(r.tools).not.toContain("project_open");
    }
  });

  it("接待模式只减不增:工具面是同一角色 active 项目下的子集", () => {
    for (const role of PROJECT_ROLES) {
      const a = agent(role);
      const inProject = new Set(solveToolset(a, ACTIVE).tools);
      for (const t of solveToolset(a, null).tools) {
        expect(inProject, `${role} 在接待模式下拿到了项目内也没有的 ${t}`).toContain(t);
      }
    }
  });
});

describe("调用期 · 接待模式下的参数级门", () => {
  it("指定项目内通信目标时如实拒绝(而不是拿 null 去查成员)", () => {
    const v = authorizeCall("collab.ask", { targetAgentId: "agent-pm" }, { agent: BM, project: null });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.denial.code).toBe("scope");
      expect(v.denial.reason).toContain("接待会话");
    }
  });
});
