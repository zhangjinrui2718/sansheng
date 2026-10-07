/**
 * 平台运行时 · 当前项目上下文(注入面 A)
 *
 * ── 它补的是一个被签名证明过的洞 ──────────────────────────────────
 *
 * 2026-10-04 真机跑「立项 → 在项目里说『开工』」时,业务经理的回答是
 * **「当前没有在跑的项目」并提议再开一个新项目** —— 而它当时就在那个项目里,
 * 库里 `projects=1`。根因不在提示词,在签名:
 *
 *   renderRoleBrief(role)               ← 参数只有 role
 *   composeSystemPrompt(dataDir, role)  ← 参数只有 role
 *
 * 也就是说:系统提示 = 机械角色简报 + 盘上提示词单元,**两者都拿不到项目**。
 * 回合消息里注入的 `pendingWork` 只含待办,那一刻是空的。于是这个 agent 手上的
 * 项目信息是**零** —— 它得主动调 `project_read` 才发现自己在哪,而它没调。
 *
 * ── 为什么注入在回合消息里,而不是系统提示里 ──────────────────────
 *
 * 三个理由,第一个是硬约束:
 *
 *   1. **系统提示是会话建立时算一次的。** `composeSystemPrompt` 只在
 *      `createPlatformSession` 里调用;而一个项目的会话是**常驻**的(宿主按
 *      项目缓存)。项目状态会在这个会话活着的时候变 —— `project_update` 改目标、
 *      `project_close` 关项目、成员增减。拼进系统提示等于把一份**建立那一刻的
 *      快照**当成了永久事实,而且它会一直骗下去(没有任何东西会提醒它过期)。
 *   2. 待办注入已经确立了「每回合现算、拼在 user 消息前部」这个形态
 *      (见 `turn.ts` 文件头:重建会话会丢掉历史,而历史正是「它已经查过什么」
 *      的来源)。项目上下文与待办是同一类信息:每回合都在变的现场。
 *   3. `composeTurnMessage` 已经有「系统替我列的东西在前、我该干的事在后」的
 *      分层。项目上下文进那一层,模型看到的就是
 *      **我在哪(项目) → 我手上有什么(待办) → 这回合干什么(任务)**。
 *
 * ── 接待会话:这里注入「你以前做过什么」(2026-10-06 补)────────────
 *
 * 原来 `projectId === null` 返回**空串**,理由是「没有项目可注入,不给它编废话」。
 * 那条理由在**第一个项目之前**成立,但它在**有项目之后**变成了一个洞:
 *
 * 真机现场:甲方在接待会话里谈一个新项目,业务经理**对已经做过的项目一无所知**
 * —— 它问「你想做什么」而不是「你要的这个和上次那个美股平台方案是什么关系」。
 * 根因有两层,都不在提示词:
 *   ① 这里返回空串,项目清单**一个字都不进**;
 *   ② **它没有任何一条路能自己去查** —— `project_read` 要一个已知的 projectId,
 *      而它无从得到那个 id(改前 BM 连 `project_list` 工具都没有)。
 *
 * ⇒ 所以这一段现在**列清单**。三条纪律:
 *   · **只列结构化的列**(id / 名字 / 甲方 / 状态 / 目标的前若干字),不抄工件正文
 *     —— 与规则的 `if` 同一条(§2.11.3):上下文注入不做语义猜测;
 *   · **不替它判断**「这次和上次像不像同一个事」—— 那是它的活,提示词里写了
 *     「必要时开下一个版本」,那是**它**的判断;
 *   · 清单为空时**如实说是空的**,不写「你还没有任何项目」这类每回合都会出现的废话。
 */
import type Database from "better-sqlite3";
import { getProjectRow, listProjects, loadProjectRoster } from "../storage/repo/projects.js";
import { getAgent } from "../storage/repo/agents.js";
import { isProjectRole, type ProjectRole } from "../identity/role.js";
import type { ProjectStatus } from "../harness/authorize.js";
import { roleDisplayName } from "./org.js";

const STATUS_NAME: Readonly<Record<string, string>> = {
  draft: "草稿",
  active: "进行中",
  paused: "暂停",
  done: "已完成",
  abandoned: "已废弃",
};

export interface ProjectContext {
  /** 注入文本。接待会话下是空串。 */
  readonly text: string;
  /** 一句话摘要(日志/诊断),接待会话下如实说明为什么是空的。 */
  readonly summary: string;
  /** 实际注入了哪个项目;`null` = 接待会话 */
  readonly projectId: string | null;
}

/**
 * 渲染「你所在的项目」这一段。**纯查询,无副作用。**
 *
 * 项目不存在时**不静默返回空**:那会让「项目被删了」和「这是一条接待会话」
 * 在模型那边长得一模一样。这里返回一段明说问题的文本 —— 一个 agent 在
 * 指名道姓要它干活的项目里读不到项目,必须看得见。
 */
/**
 * 接待会话注入的那一段:「你已经和甲方做过这些」。
 *
 * ⚠️ **只读结构化的列**:`projects` 表自己的 `id / name / client / status / goal`,
 * 外加每个项目的工件计数。**不读任何工件正文** —— 那要么是 `board_read` 的活,
 * 要么根本不该在每回合都进来。
 *
 * 排序:先按 `status` 分组(`active` 在前,因为那是**还有活**的),组内按 `created_at`
 * 倒序(最近做的在前)。⚠️ **这是呈现顺序,不是优先级判断** —— 业务经理该不该接着
 * 上一次那个项目继续,是它的判断,不是排序能替它做的。
 */
function renderKnownProjects(db: Database.Database): string {
  const projects = listProjects(db);
  if (projects.length === 0) {
    return "## 平台记录:你目前还没有任何项目\n\n" +
      "甲方正在跟你谈第一个诉求。谈拢之后用 `project_open` 立项。";
  }
  const countOf = (id: string, kind: string): number =>
    (db.prepare(
      `SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND kind = ?`,
    ).get(id, kind) as { n: number }).n;

  const rank = (s: ProjectStatus): number => (s === "active" ? 0 : s === "paused" ? 1 : s === "done" ? 2 : 3);
  const lines: string[] = [
    "## 平台记录:甲方已经和你做过这些项目",
    "",
    "**这是平台从库里查出来的,不是甲方这句话里说的。** 甲方现在跟你说的是**新的诉求**——",
    "它可能和下面某一个有关(续做、加需求、彻底换一件事),**那是你的判断**,不要替他假设。",
    "",
  ];
  for (const p of [...projects].sort(
    (a, b) => rank(a.status) - rank(b.status) || b.createdAt - a.createdAt,
  )) {
    const deliverables = countOf(p.id, "deliverable");
    lines.push(
      `- \`${p.id}\`「**${p.name}**」· 状态 ${STATUS_NAME[p.status] ?? p.status}(${p.status})` +
        ` · 交付物 ${deliverables} 份`,
      `    甲方:${p.client}`,
      `    目标:${p.goal.length > 160 ? `${p.goal.slice(0, 160)}…` : p.goal}`,
    );
    // 「下一个版本」那条通道:同一个交付物的第二次演进**是新项目**,把 parent 指回去。
    if (p.parentProjectId !== null) {
      lines.push(`    ↳ 这是上一个项目的下一个版本(parent = \`${p.parentProjectId}\`)`);
    }
    lines.push(`    要细节用 \`project_read\`(\`${p.id}\`);要接着做就用 \`project_open\` 开下一个。`);
  }
  return lines.join("\n");
}

export function renderProjectContext(
  db: Database.Database,
  agentId: string,
  projectId: string | null,
): ProjectContext {
  if (projectId === null) {
    return {
      text: renderKnownProjects(db),
      summary: "(接待会话:列出已知的项目)",
      projectId: null,
    };
  }

  const project = getProjectRow(db, projectId);
  if (project === null) {
    return {
      text:
        "## ⚠️ 你所在的项目读不出来\n\n" +
        `平台把你放在项目 \`${projectId}\` 里,但这个项目在库里不存在。\n` +
        "**不要猜项目内容,也不要另开一个项目** —— 把这个情况如实说出来。",
      summary: `(项目 ${projectId} 读不出来)`,
      projectId,
    };
  }

  const me = getAgent(db, agentId);
  const myRole: ProjectRole | null =
    me !== null && isProjectRole(me.role) ? me.role : null;

  const roster = loadProjectRoster(db, projectId);
  const lines: string[] = [
    "## 你所在的项目(平台注入,来源是库,不是用户这句话里说的)",
    "",
    `- 项目 ID:\`${project.id}\``,
    `- 项目名:${project.name}`,
    `- 甲方:${project.client}`,
    `- 状态:${STATUS_NAME[project.status] ?? project.status}(${project.status})`,
    `- 你是:${myRole !== null ? `${roleDisplayName(myRole)}(\`${myRole}\`)` : `\`${agentId}\`(角色未知)`}`,
    "",
    "### 目标(立项时与甲方对齐的结论)",
    project.goal,
    "",
    `### 项目成员(${roster.length})`,
    ...roster.map(
      (m) =>
        `- ${m.displayName} · ${m.role}${m.specialization !== null ? `/${m.specialization}` : ""} (\`${m.id}\`)`,
    ),
    "",
    "**这就是你此刻所在的项目。** 不要提议「再开一个新项目」来推进它 —— " +
      "新的活属于这个项目。要细节(工作项分布、阻塞、变更)用 `project_read` 查。",
  ];

  return {
    text: lines.join("\n"),
    summary: `项目 ${project.id}「${project.name}」(状态 ${project.status})· 我是 ${myRole ?? agentId}`,
    projectId,
  };
}
