/**
 * 平台运行时 · 组织
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────
 *
 * 「这个系统里有哪几个人」是**平台级事实**,不是 CLI 的实现细节。CLI 与
 * HTTP 都要用它(建项目时要知道把谁加进成员、跑工作项时要找 worker)。
 * 原先它写在 `cli/run.ts` 里,HTTP 一来就得复制一份 —— 复制的那份迟早会漂。
 */
import type Database from "better-sqlite3";
import { insertAgent, getAgent, listAgents, type AgentRow } from "../storage/repo/agents.js";
import { addMember, loadProjectRoster } from "../storage/repo/projects.js";
import { isExecutorRole, EXECUTOR_ROLES, type ProjectRole, type Specialization } from "../identity/role.js";

export interface OrgMember {
  readonly id: string;
  readonly role: ProjectRole;
  readonly spec: Specialization | null;
  readonly name: string;
}

/**
 * 固定组织:五个角色各一人。
 *
 * **一人一角色**是刻意的起点。执行角色的 specialization 用枚举
 * (`engineering|algorithm|data`)而不是自由文本 —— 经校准的裁决:枚举是
 * 代码内常量,自由文本是数据;前者要改得走代码评审,后者谁都能改。
 * 想加「前端」时改的是代码,那是**特性不是缺陷**。
 *
 * ── 2026-10-08:执行角色一分为二(研究工 / 编码工)─────────────────
 *
 * `wk` 这个 id **刻意保留给研究工**(它是原来那个 `worker`):`works.assignee_agent_id`
 * 里存着它、`project_assignments` 里也存着它,换个新 id 等于把「谁在做这条活」
 * 这条历史线剪断。新增的编码工拿新 id `cw`。
 *
 * ⚠️ **已存在的项目不会自动长出 `cw`** —— `ensureProjectOrg` 原本只在
 * 立项时跑一次。旧的库升上来之后,编码工不是任何老项目的成员,于是
 * `buildToolContext` 对它返回 `agent_not_assigned`、会话建不出来,而**屏幕上看不出
 * 任何异常**(只是编码工永远不动)。所以 `ensureProjectOrg` 现在也在宿主启动时补跑
 * (`host/serve.ts` 的 `syncOrgForExistingProjects`)—— 见那里的注释。
 *
 * ── ⚠️ 这五个 `name` 是**界面里角色中文名的唯一来源**(2026-10-06)────────
 *
 * 在此之前同一个角色在界面上有**三个名字**:harness 页读 `transport/http.ts`
 * 一张私有表(写成 `Worker(执行者)` —— 一个名字里塞进一句解释),成员页读
 * `agents.display_name`(播种值 = 本表),而前端 `lib/vocab.ts` 的兜底表又写成
 * `执行者` / `质检审查员`。用户的原话是「harness 页面和成员页面四个角色的命名
 * 统一一下,就不要有解释了」。
 *
 * 现在:
 *   - 播种(`ensureOrg` / `ensureProjectOrg`)用本表;
 *   - `RoleHarnessView.displayName` 走 `roleDisplayName()`,**也**读本表;
 *   - `runtime/promptAssembly.ts` 的角色简报也走 `roleDisplayName()`(第四个
 *     写名字的地方,2026-10-08 一并收编 —— 它当时写的是 `Worker(执行者)`);
 *   - 前端 `ROLE_LABEL` 的兜底值与本表逐项相同,并由
 *     `tests/web/role-names.test.ts` 做**跨边界对照**(两边不许再漂)。
 *
 * ⚠️ 设计文档(`docs/DESIGN-AGENTS.md`)的角色表用的是**代号读法**(`Worker` /
 * `质检审查员`)—— 那是文档对**角色**的称呼,不是运行期显示名;本表才是运行期的
 * 那一份。改这里不必改文档,反之亦然,但**两处都不许再长出第三份**。
 */
export const ORG: readonly OrgMember[] = [
  { id: "bm", role: "business_manager", spec: null, name: "业务经理" },
  { id: "pm", role: "project_manager", spec: null, name: "项目经理" },
  // id `wk` = 原来那个 worker。它改名而不换 id(见上「一分为二」那段)。
  // specialization 保持 `engineering` 不动 —— 那是**领域**轴,与角色轴正交,
  // 改写它才是「为了整齐去改事实」(migration 026 的探针显式断言了它被原样保留)。
  { id: "wk", role: "research_worker", spec: "engineering", name: "研究员" },
  { id: "cw", role: "coding_worker", spec: "engineering", name: "工程师" },
  { id: "qa", role: "quality_reviewer", spec: null, name: "质检" },
];

/**
 * 角色的**界面显示名**(中文)—— `ORG` 是唯一来源。
 *
 * 查不到时兜底返回 `role`(英文代号)而不是空串:界面上出现 `worker` 是
 * **看得出来的**「这个名字没配」,而空串在屏幕上只是一片空白(与 `vocab.ts`
 * 「未知取值原样透出,不猜」同一条纪律)。
 */
export function roleDisplayName(role: ProjectRole): string {
  return ORG.find((m) => m.role === role)?.name ?? role;
}

/**
 * 按需播种组织。**幂等**,但返回本次新建了哪些 —— 幂等不等于静默:
 * 「我什么都没做」和「我建了五个人」是不同的信息。
 *
 * ── 2026-10-08:它现在**也校准显示名** ─────────────────────────────
 *
 * 在此之前它只做「缺了就插入」,于是 `agents.display_name` 一旦写进去就再也
 * 不跟着 `ORG` 变 —— 而 `ORG` 被文档认定为中文名的**唯一来源**。真后果:
 * 026 把 `wk` 的角色改成研究工之后,库里那一行的名字还停在「工程师」,
 * 成员页照库里的显示,与 `ORG`/前端兜底表**当场漂开**,而没有任何检查会红。
 *
 * 所以这里补一条 UPDATE:`ORG` 说叫什么,库里就叫什么。这是安全的 ——
 * 平台**没有给用户留改 `agents.display_name` 的入口**(全仓只有 `insertAgent`
 * 写它),所以不存在「覆盖用户自定义」这回事。
 */
export function ensureOrg(db: Database.Database, at: number): string[] {
  const created: string[] = [];
  for (const m of ORG) {
    const existing = getAgent(db, m.id);
    if (existing === null) {
      insertAgent(db, {
        id: m.id,
        role: m.role,
        specialization: m.spec,
        displayName: m.name,
        createdAt: at,
      });
      created.push(`${m.id}(${m.name}/${m.role})`);
      continue;
    }
    // 角色或名字与 ORG 不一致 → 校准。角色漂移只可能来自代码改名(如 026),
    // 名字漂移只可能来自 ORG 改动 —— 两种都该被这次调用拉齐。
    if (existing.role !== m.role || existing.displayName !== m.name) {
      db.prepare(`UPDATE agents SET role = ?, display_name = ? WHERE id = ?`).run(
        m.role,
        m.name,
        m.id,
      );
      created.push(`${m.id}(校准为 ${m.name}/${m.role})`);
    }
  }
  return created;
}

/** 组织是否已就位(HTTP 路由用它决定要不要报「先跑一次 CLI」)。 */
export function orgReady(db: Database.Database): boolean {
  return ORG.every((m) => getAgent(db, m.id) !== null);
}

/**
 * 把一个项目**应有的组织**放进项目成员表。幂等。
 *
 * ── 为什么必须有这一条(这是驱动者循环的前置)─────────────────────
 *
 * `project_open` 原本只把**立项人**(业务经理)加成成员。后果不是「少几个人看」,
 * 是**组织根本动不起来**:
 *
 *   - `buildToolContext` 对非成员返回 `agent_not_assigned` → 项目经理/执行角色/质检
 *     的会话**建不出来**,驱动者循环第一步就撞墙(实测形态:`projects=1, works=0`)
 *   - `resolveAssignee` 走 `loadProjectRoster` → 项目经理 `work_create` 时
 *     「项目里没有这个角色的成员」,**拆解当场失败**
 *
 * 也就是说「立项之后组织自动接手」这件事在此之前**结构上不可能发生** ——
 * 而它不会以报错的形式出现,只会以「什么都没发生」的形式出现。
 *
 * ── ⚠️ 它**只补缺席的人,不复活被移出的人**(2026-10-08 收紧)────────
 *
 * 它现在也在宿主启动时对**所有已存在的项目**补跑(`syncOrgForExistingProjects`,
 * 025→026 升上来的库里没有 `cw` 那一行)。如果它顺手 `addMember` 每一个人,
 * 那就会把「用户明确从项目里移出某个成员」这个动作**在下次启动时静静撤销**。
 * 所以判据从「无脑 addMember」改成「这个人在这个项目里**一行都没有**才加」——
 * 有行(哪怕 `removed_at` 非空)就是用户已经表过态,不碰。
 *
 * 与 `ensureOrg` 同一条理由:幂等不等于静默,这里返回本次真正加了谁。
 */
export function ensureProjectOrg(
  db: Database.Database,
  projectId: string,
  at: number,
): string[] {
  const added: string[] = [];
  // 这个项目**历史上**参与过谁(含已被移出的)—— 用来区分「从没有过」与
  // 「有过、被移出了」。后者不该被补回来。
  const everAssigned = new Set(
    (
      db
        .prepare(`SELECT agent_id FROM project_assignments WHERE project_id = ?`)
        .all(projectId) as Array<{ agent_id: string }>
    ).map((r) => r.agent_id),
  );
  for (const m of ORG) {
    if (getAgent(db, m.id) === null) {
      // 组织还没播种(例如 project_open 直接在空库上跑)——
      // 在这里补种,而不是让项目带着一个不存在的成员。
      insertAgent(db, {
        id: m.id, role: m.role, specialization: m.spec,
        displayName: m.name, createdAt: at,
      });
      added.push(`${m.id}(补种)`);
    }
    if (everAssigned.has(m.id)) continue;
    addMember(db, projectId, m.id, at);
    added.push(`${m.id}(入项目)`);
  }
  return added;
}

/**
 * 启动时把组织补进**每一个已存在的项目**。幂等。
 *
 * ── 为什么必须有这一条(2026-10-08,新增 `coding_worker` 时发现)────────
 *
 * `ensureProjectOrg` 此前只在「立项」那一刻跑。于是**新增一个角色**这件事对
 * 存量项目是**结构性不发生**的:老的库里 `cw` 这个 agent 会被 `ensureOrg` 建出来
 * (组织级),但它不是任何已存在项目的成员 ——
 *
 *   · `buildToolContext` 对非成员返回 `agent_not_assigned` ⇒ 它连会话都建不出来
 *   · 项目经理 `work_create(assigneeRole='coding_worker')` 会撞上
 *     「项目里没有这个角色的成员」 ⇒ 编码工**永远不会被派活**
 *
 * 而屏幕上是**看不出**这件事的:成员页列出的是「这个项目里有谁」,
 * 少的那个角色只是不出现,看起来和「还没派到它」一模一样。
 *
 * 放在宿主启动时而不是每次消息时:这是**一次性对齐**(升级完成之后每轮都是空转),
 * 而每条消息都跑一遍会让「谁在项目里」这件事多一条与用户操作竞争写的路径。
 */
export function syncOrgForExistingProjects(db: Database.Database, at: number): string[] {
  const ids = (
    db.prepare(`SELECT id FROM projects`).all() as Array<{ id: string }>
  ).map((r) => r.id);
  const out: string[] = [];
  for (const pid of ids) {
    const added = ensureProjectOrg(db, pid, at);
    if (added.length > 0) out.push(`${pid} ← ${added.join(", ")}`);
  }
  return out;
}

export function findAgentByRole(db: Database.Database, role: ProjectRole): AgentRow | null {
  return listAgents(db).find((a) => a.role === role) ?? null;
}

/**
 * 找一个**执行角色**(研究工 / 编码工)。指定 id 时校验它真的是执行角色 ——
 * 否则会派错人(派给项目经理的工作项永远不会被执行,而平台也不会叫醒任何人)。
 *
 * 不指定时按 `EXECUTOR_ROLES` 的顺序取第一个在手的人。`platform run`(手工
 * 跑一个工作项)用它,所以默认值必须是**确定**的(顺序即优先级,不是随机的
 * 「随便挑一个」)。
 */
export function pickWorker(db: Database.Database, wanted?: string): AgentRow | null {
  if (wanted !== undefined) {
    const a = getAgent(db, wanted);
    return a !== null && isExecutorRole(a.role) ? a : null;
  }
  for (const role of EXECUTOR_ROLES) {
    const a = findAgentByRole(db, role);
    if (a !== null) return a;
  }
  return null;
}
