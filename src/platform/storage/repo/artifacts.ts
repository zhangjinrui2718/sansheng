/**
 * BC3 Blackboard · artifacts / artifact_links 仓储
 *
 * ── 这个仓储不做权限判定 ──────────────────────────────────────────
 *
 * `blackboard.write` 能写哪些 kind 由 `ROLE_SPECS[role].writeKinds` 决定,
 * 判定发生在 `harness/authorize.ts` 的 `WriteKindGate`(调用期第三道门)。
 * 仓储层只负责「schema 允许的 kind」与「数据完整性」。
 *
 * 这个分工是有意的:权限是**角色相关**的,仓储不该知道调用者是谁。把两者
 * 混在一起会让「换个调用方就得改仓储」,也再没有单一位置能回答
 * 「这个角色到底能写什么」。
 */
import type Database from "better-sqlite3";
import {
  ARTIFACT_KINDS,
  isArtifactKind,
  type ArtifactKind,
} from "../../identity/role.js";

// ── 交付物类型(migration 025)────────────────────────────────────

/**
 * 交付物类型闭合联合。**只有真正有写入口的类型才在这里**(设计 1 §6.4)。
 *
 * `html_report` = 「凡是只有信息交付的」:技术方案、架构图、汇报材料、
 * 评审结论、说明书。正文是一份**自包含的 HTML 文档**,读面在**禁用脚本的
 * 沙箱 iframe** 里渲染它(`web/src/components/deliverable/HtmlReport.tsx`)。
 *
 * `code_service`(**026 新增**)= **代码服务**:用户原话「这个是一个 git 仓库,
 * 然后这个仓库可以独立部署到 docker 上面」。它是**唯一一个正文之外还有硬坐标**
 * 的类型 —— 仓库路径 / 分支 / HEAD / Dockerfile / 服务名与端口写在 `metadata_json`,
 * 而**写入口带现场核对**:`tools/blackboard.ts` 会调 `codeservice` 端口去盘上
 * 把这几件事读一遍,读不到就不让写(`src/platform/codeservice/git.ts`)。
 * 所以「写个 type 字段就算交付」这条路不通 —— 7-E 的教训是
 * 「**闭集里每一个值都必须有一条真的写入口**」,`code_service` 的写入口就是
 * 那次核对,不是一个字符串枚举。
 *
 * ⚠️ **本闭集必须与 `migrations/026` 的 `deliverable_type` CHECK 恰好相等**,
 * 理由与上面 `ArtifactKind` 那段完全相同:schema 先开、代码后跟的那段窗口里,
 * 读面是**关**的 —— `rowToArtifact` 对未定义类型**硬抛**。
 *
 * ── 预留类型(刻意**不在**这个闭集里)─────────────────────────────
 *
 * 「git 仓库上的某几个提交」「镜像」「部署实例」都还没有写入口。预留的方式是
 * **结构**而不是**名字**:`artifacts.deliverable_type` 是一列
 * (`kind='deliverable'` 的 1:N 属性),类型专属坐标落 `metadata_json`,
 * 加一种类型只需:往本闭集加一个值 → 往 026 那条 CHECK 里同步 → 在
 * `board_write` 加一条类型专属校验 + 在读面加一个渲染分支,
 * **不改表、不改迁移、不动 `integrate` / `handover` 两条规则**(它们按 `kind` 查)。
 *
 * ⚠️ **为什么当初不把 `git_repo` 写进闭集、而现在写进了 `code_service`**:
 * 判据不是「谁更该有名字」,而是**有没有写入口**。025 那版闭集里写进去,
 * 模型就会照着声明去写一条平台造不出来的交付物;现在写进去,是因为
 * `codeservice` 端口能在写入那一刻**把假的东西挡在门外**。
 */
export type DeliverableType = "html_report" | "code_service";

export const DELIVERABLE_TYPES = [
  "html_report",
  "code_service",
] as const satisfies readonly DeliverableType[];

export function isDeliverableType(v: unknown): v is DeliverableType {
  return typeof v === "string" && (DELIVERABLE_TYPES as readonly string[]).includes(v);
}

/**
 * `html_report` 正文的**最小验收判据**。
 *
 * 为什么要有:「一份 HTML 报告」这个概念对模型来说太宽 —— 它会把 markdown
 * 塞进来、把裸文本塞进来、或者写一篇依赖 CDN 脚本库的可视化。读面拿到之后
 * 在沙箱 iframe 里渲染,后两种的表现是**一片空白**,而空白页看起来像「平台坏了」。
 *
 * ⇒ 判据定在**能渲染出东西**这一条线上,且每条拒绝都**带可执行的处置**:
 *   · 不是 HTML  → 告诉它要写标签(它多半是写了 markdown)
 *   · 带 `<script>` / `<iframe>` → 告诉它沙箱里脚本不执行,改用 CSS + 内联 SVG
 *   · 超过上限   → 告诉它拆成几份,或把长附录放进子工作项的产出
 *
 * **不校验的东西**:标签闭合、CSS 语法、是否 `<!doctype>`。沙箱 iframe 对残缺
 * 标签是宽容的,而一个「HTML 校验器」只会逼模型去修它看不见的东西。
 */
const HTML_TAG = /<[a-z][\s\S]*>/i;
const HTML_SCRIPT = /<\s*(script|iframe|object|embed)\b/i;
const MAX_HTML_REPORT_BYTES = 512 * 1024;

/** 一条 `html_report` 的正文能不能当报告渲染。`null` = 通过。 */
export function validateHtmlReport(body: string): string | null {
  if (!HTML_TAG.test(body)) {
    return (
      "`html_report` 的正文必须是一份 **HTML 文档**,而不是 markdown 或纯文本。" +
      "至少要有一个 HTML 标签(例如 `<!doctype html><html><body>…`)。" +
      "现在这份正文里一个标签都没有 —— 若你手上有的是一份 markdown 正文," +
      "请改写成一个自包含的 HTML 页面(结构用标签、样式用内联 `<style>`)。"
    );
  }
  const bad = body.match(HTML_SCRIPT);
  if (bad !== null) {
    return (
      `本平台的 HTML 交付报告渲染在**禁用脚本的沙箱 iframe** 里(sandbox 空值、` +
      `srcDoc),所以 \`<${bad[1]}>\` 不会执行 —— 写了它这一页在甲方那里是**空白**。` +
      "请改成纯 HTML + CSS + **内联 SVG**(架构图用 SVG 画,不要用脚本绘图库)," +
      "并且不要外链样式表或字体。"
    );
  }
  if (Buffer.byteLength(body, "utf8") > MAX_HTML_REPORT_BYTES) {
    return (
      `这份 HTML 报告有 ${Math.round(Buffer.byteLength(body, "utf8") / 1024)} KiB,` +
      `超过上限 ${MAX_HTML_REPORT_BYTES / 1024} KiB。` +
      "请拆成主报告 + 若干子工作项产出(正文写进那些产出,用 links 指回来)," +
      "或者把长表格/长代码压缩成摘要 + 要点。"
    );
  }
  return null;
}

/**
 * `code_service` 正文的**最小验收判据**。
 *
 * 正文是给甲方读的**说明**(这个服务是什么、怎么跑、怎么部署、外部依赖是什么),
 * 读面按 **markdown** 渲染它 —— 所以判据只有一条:**它不能是一份 HTML 文档**。
 * 把 HTML 塞进来会原样显示成一堆标签(读面不会为它开沙箱 iframe ——
 * 那是 `html_report` 的待遇)。这与 `validateHtmlReport` 恰好互为反向,
 * 而两条都**不做**内容质量判断:平台不替模型评价「这份说明写得好不好」。
 *
 * ⚠️ **仓库坐标的核对不在这里。** 它是**纯函数**层的校验,拿不到磁盘;
 * 真核对在 `tools/blackboard.ts` → `codeservice/port.ts`(需要 workspaceRoot)。
 * 类型专属判据因此分两层:**形状**(这里)与**事实**(端口)。
 */
const HTML_DOC_HEAD = /^\s*<(?:!doctype\s+html|html)\b/i;

export function validateCodeServiceBody(body: string): string | null {
  if (HTML_DOC_HEAD.test(body)) {
    return (
      "`code_service` 的正文是给甲方读的**说明文档**(markdown),不是 HTML 页面 —— " +
      "把 HTML 塞进来,读面会原样显示成一堆标签。请用 markdown 写:这个服务是什么、" +
      "怎么构建、怎么跑起来、怎么部署到 Docker、端口与外部依赖是什么。" +
      "如果你的交付物**只有信息**(一份报告),那它该写成 `html_report`。"
    );
  }
  return null;
}

/**
 * 类型专属的正文校验。新增一种类型就在这里加一条分支 ——
 * **闭集里每个值都必须在这里有分支**,否则 `null` 意味着「不校验」而不是「合法」。
 */
export function validateDeliverableBody(type: DeliverableType, body: string): string | null {
  switch (type) {
    case "html_report":
      return validateHtmlReport(body);
    case "code_service":
      return validateCodeServiceBody(body);
  }
}

/** 工件状态机(设计 1 §6.3)。 */
export type ArtifactStatus = "open" | "accepted" | "rejected" | "superseded";

export const ARTIFACT_STATUSES: readonly ArtifactStatus[] = [
  "open",
  "accepted",
  "rejected",
  "superseded",
];

export function isArtifactStatus(v: unknown): v is ArtifactStatus {
  return typeof v === "string" && (ARTIFACT_STATUSES as readonly string[]).includes(v);
}

/** 工件间关系类型 */
export type ArtifactLinkRel = "parent" | "depends_on" | "answers";

export const ARTIFACT_LINK_RELS: readonly ArtifactLinkRel[] = [
  "parent",
  "depends_on",
  "answers",
];

export function isArtifactLinkRel(v: unknown): v is ArtifactLinkRel {
  return typeof v === "string" && (ARTIFACT_LINK_RELS as readonly string[]).includes(v);
}

export interface ArtifactRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  kind: ArtifactKind;
  status: ArtifactStatus;
  authorAgentId: string;
  title: string;
  body: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * **产出这条工件的工作项**(provenance,migration 014)。
   *
   * `null` = 这条工件不是任何工作项的执行产出:立项书 / 会议纪要 / 变更记录 /
   * 甲方问答 / 质检意见。**这是合法状态,不是缺参数**。
   *
   * 为什么它是**一条边**而不是「当前工作项」:一次会话会连跑多个工作项,
   * 而 `ToolRunContext` 是建会话时构造一次的 —— 放在那里会过期。
   */
  workId: string | null;
  /**
   * **这条交付物是哪种类型**(migration 025)。
   *
   * ⚠️ `null` 对非交付物工件是**唯一合法取值**,对 `kind='deliverable'` 是
   * **存量状态**(真机 23 条,全是 016 之后写的 markdown 正文,见 025 的注释)。
   * 它**不是缺参数**:新写入的交付物必须带类型(工具层强制),
   * 而读面**必须**把 NULL 交付物按普通正文呈现 —— 按「html_report」渲染
   * 那 23 条会得到 23 片空白。
   */
  deliverableType: DeliverableType | null;
}

/**
 * 插入用的一行。`workId` / `deliverableType` 可省:
 * 多数工件不是「某条工作项的产出」,而**所有非交付物工件都没有类型**。
 *
 * 与 `repo/works.ts` 的 `NewWorkRow` 同一个形状理由 —— 读出来的一行必须
 * 答得出「谁产出了它」「它是哪种交付物」,写入方却不必知道这两条边。
 */
export type NewArtifactRow = Omit<ArtifactRow, "workId" | "deliverableType"> & {
  readonly workId?: string | null;
  readonly deliverableType?: DeliverableType | null;
};

interface RawArtifact {
  id: string;
  project_id: string;
  conversation_id: string | null;
  kind: string;
  status: string;
  author_agent_id: string;
  title: string;
  body: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  work_id: string | null;
  deliverable_type: string | null;
}

/** 行 → 领域对象。边界处校验闭合集,不让未定义的 kind/status/类型冒充类型。 */
function rowToArtifact(raw: RawArtifact): ArtifactRow {
  if (!isArtifactKind(raw.kind)) {
    throw new Error(`artifacts 表里出现未定义 kind「${raw.kind}」(id=${raw.id})`);
  }
  if (!isArtifactStatus(raw.status)) {
    throw new Error(`artifacts 表里出现未定义 status「${raw.status}」(id=${raw.id})`);
  }
  // 025 之前建的库(还没跑迁移)读出来是 undefined —— 如实当成「未声明类型」,
  // 不让字段名缺失变成类型层的一句谎话(与下面 `work_id ?? null` 同理)。
  const deliverableType = raw.deliverable_type ?? null;
  if (deliverableType !== null && !isDeliverableType(deliverableType)) {
    throw new Error(
      `artifacts 表里出现未定义 deliverable_type「${deliverableType}」(id=${raw.id})`,
    );
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    conversationId: raw.conversation_id,
    kind: raw.kind,
    status: raw.status,
    authorAgentId: raw.author_agent_id,
    title: raw.title,
    body: raw.body,
    metadataJson: raw.metadata_json,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    // `?? null`:014 之前建的库(还没跑迁移)读出来是 undefined —— 如实当成
    // 「没有产出工作项」,不让字段名缺失变成类型层的一句谎话。
    workId: raw.work_id ?? null,
    deliverableType,
  };
}

// ── artifacts ───────────────────────────────────────────────────

export function insertArtifact(db: Database.Database, row: NewArtifactRow): void {
  db.prepare(
    `INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                            title, body, metadata_json, created_at, updated_at, work_id,
                            deliverable_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.conversationId, row.kind, row.status, row.authorAgentId,
    row.title, row.body, row.metadataJson, row.createdAt, row.updatedAt,
    row.workId ?? null,
    row.deliverableType ?? null,
  );
}

export function getArtifact(db: Database.Database, id: string): ArtifactRow | null {
  const raw = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
    | RawArtifact
    | undefined;
  return raw ? rowToArtifact(raw) : null;
}

export interface ListArtifactsFilter {
  kind?: ArtifactKind;
  status?: ArtifactStatus;
  authorAgentId?: string;
  /** 只要某条工件的子件(rel='parent') */
  parentOf?: string;
  /**
   * 只要**某条工作项产出的**工件(migration 014 的产出边)。
   *
   * 这是「这条工作项产出了什么」在模型里的唯一答案 —— 在 014 之前它只能靠
   * 「回合前后整个项目的集合差」算(`runtime/execution.ts` 的旧判据),
   * 那个判据连 `author_agent_id` 都不读,同项目两回合交叠时会互相认领。
   */
  workId?: string;
  /** 只要某种**交付物类型**(migration 025 的部分索引 idx_artifacts_deliverable)。 */
  deliverableType?: DeliverableType;
  limit?: number;
}

/**
 * 列工件。**作用域是 projectId,不是 conversationId** ——
 * 这是本次升级最关键的一处签名变更(设计 1 §3.2):对话活不过项目。
 */
export function listArtifacts(
  db: Database.Database,
  projectId: string,
  filter: ListArtifactsFilter = {},
): ArtifactRow[] {
  const where = ["a.project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.kind !== undefined) { where.push("a.kind = ?"); vals.push(filter.kind); }
  if (filter.status !== undefined) { where.push("a.status = ?"); vals.push(filter.status); }
  if (filter.authorAgentId !== undefined) {
    where.push("a.author_agent_id = ?");
    vals.push(filter.authorAgentId);
  }
  if (filter.workId !== undefined) {
    // 走 014 的部分索引 idx_artifacts_work(WHERE work_id IS NOT NULL)
    where.push("a.work_id = ?");
    vals.push(filter.workId);
  }
  if (filter.deliverableType !== undefined) {
    // 走 025 的部分索引(WHERE deliverable_type IS NOT NULL)
    where.push("a.deliverable_type = ?");
    vals.push(filter.deliverableType);
  }
  if (filter.parentOf !== undefined) {
    where.push(
      `a.id IN (SELECT artifact_id FROM artifact_links WHERE rel = 'parent' AND target_artifact_id = ?)`,
    );
    vals.push(filter.parentOf);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  vals.push(limit);
  const rows = db
    .prepare(
      `SELECT a.* FROM artifacts a WHERE ${where.join(" AND ")}
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(...vals) as RawArtifact[];
  return rows.map(rowToArtifact);
}

/** 改状态。终态之间的互转由调用方负责语义(仓储只管闭集与幂等)。 */
export function setArtifactStatus(
  db: Database.Database,
  id: string,
  status: ArtifactStatus,
  at: number,
): void {
  db.prepare(`UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?`).run(status, at, id);
}

export function updateArtifactBody(
  db: Database.Database,
  id: string,
  body: string,
  at: number,
): void {
  db.prepare(`UPDATE artifacts SET body = ?, updated_at = ? WHERE id = ?`).run(body, at, id);
}

// ── 索引化的读面(设计 `docs/DESIGN-WORKSPACE.md` §4.1 / §4.4)──────
//
// ⚠️ **今天 `body_path` 这一列还不存在** —— 它由 **P2** 的 migration 027 加上
// (与 `body_sha256` / `body_bytes` / `commit_sha` 一起)。P0 只是**读面**,
// 所以这里必须先问 schema 再查(`PRAGMA table_info`),读法与
// `runtime/dispatcher.ts` 的 `deliveredArtifactIds` 逐字同源:
//
//   - 列不在 → `runtime: "not_migrated"` + 空 paths —— **如实报**「索引还没落地」;
//   - 列在   → 查出这个项目里 `body_path` 非空的行。
//
// 为什么**不**返回一个空数组假装索引是空的:那会与「迁移已跑、但这个项目一件
// 工件都还没落盘」**在结果上完全一样**,而前者是「机制缺一半」、后者是「项目还
// 没干活」—— 本项目最贵的失败形态就是把这两种混成一种(7-E)。
//
// 为什么不是 `try { … } catch { return [] }`:一条 SQL 报错被吞掉之后,
// 「列还没迁移」与「查询写错了」长得一模一样。`PRAGMA table_info` 是一次
// **问得出答案**的检查,不需要靠异常区分。
//
// 为什么不在模块作用域缓存表结构:那是跨调用的进程内状态,而这条读面的纪律是
// 「每次从库里重算」;`table_info` 是常数级开销。
//
// ⚠️ **P2 落地后这条读面自动点亮** —— 扫描模块与 UI 一行都不用改。

/** 索引里的一条正文路径。`title` 随行带上,让「库里有、盘上无」能报出是哪件工件。 */
export interface IndexedBodyPath {
  /** 项目根相对路径(平台生成的 `artifacts/<id>-<slug>.<ext>`) */
  path: string;
  artifactId: string;
  title: string;
}

export interface IndexedBodyPathList {
  /** `not_migrated` = `body_path` 列还不存在(P0 的真实状态),不是「索引是空的」 */
  runtime: "ok" | "not_migrated";
  paths: IndexedBodyPath[];
}

export function listIndexedBodyPaths(
  db: Database.Database,
  projectId: string,
): IndexedBodyPathList {
  const columns = db.pragma("table_info(artifacts)") as ReadonlyArray<{ name: string }>;
  if (!columns.some((c) => c.name === "body_path")) {
    return { runtime: "not_migrated", paths: [] };
  }
  const rows = db
    .prepare(
      `SELECT id AS artifactId, title AS title, body_path AS path
       FROM artifacts
       WHERE project_id = ? AND body_path IS NOT NULL
       ORDER BY body_path`,
    )
    .all(projectId) as ReadonlyArray<{ artifactId: string; title: string; path: string }>;
  return { runtime: "ok", paths: rows.map((r) => ({ path: r.path, artifactId: r.artifactId, title: r.title })) };
}

/** 按 kind 计数 —— 「未解决阻塞/待审意见有多少」这类汇总读法。 */
export function countArtifactsByKind(db: Database.Database, projectId: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM artifacts WHERE project_id = ? GROUP BY kind`)
    .all(projectId) as Array<{ kind: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

// ── artifact_links ──────────────────────────────────────────────

export type AddLinkResult = { ok: true } | { ok: false; reason: "self" | "duplicate" | "not_found" };

export function addArtifactLink(
  db: Database.Database,
  artifactId: string,
  rel: ArtifactLinkRel,
  targetArtifactId: string,
): AddLinkResult {
  if (artifactId === targetArtifactId) return { ok: false, reason: "self" };
  if (getArtifact(db, artifactId) === null || getArtifact(db, targetArtifactId) === null) {
    return { ok: false, reason: "not_found" };
  }
  const exists = db
    .prepare(
      `SELECT 1 FROM artifact_links WHERE artifact_id = ? AND rel = ? AND target_artifact_id = ?`,
    )
    .get(artifactId, rel, targetArtifactId);
  if (exists) return { ok: false, reason: "duplicate" };
  db.prepare(
    `INSERT INTO artifact_links (artifact_id, rel, target_artifact_id) VALUES (?, ?, ?)`,
  ).run(artifactId, rel, targetArtifactId);
  return { ok: true };
}

export function removeArtifactLink(
  db: Database.Database,
  artifactId: string,
  rel: ArtifactLinkRel,
  targetArtifactId: string,
): void {
  db.prepare(
    `DELETE FROM artifact_links WHERE artifact_id = ? AND rel = ? AND target_artifact_id = ?`,
  ).run(artifactId, rel, targetArtifactId);
}

/** 出边:这条工件指向谁 */
export function listLinks(
  db: Database.Database,
  artifactId: string,
  rel?: ArtifactLinkRel,
): string[] {
  const rows = (
    rel === undefined
      ? db.prepare(`SELECT target_artifact_id AS t FROM artifact_links WHERE artifact_id = ?`).all(artifactId)
      : db
          .prepare(`SELECT target_artifact_id AS t FROM artifact_links WHERE artifact_id = ? AND rel = ?`)
          .all(artifactId, rel)
  ) as Array<{ t: string }>;
  return rows.map((r) => r.t);
}

/**
 * 出边的**完整形态**(rel + target)。
 *
 * `listLinks` 只给 target id —— 那是给"有没有关联"这类判断用的。要画边、
 * 要在 UI 上区分 `answers` 与 `depends_on`,需要 rel 一起取出来。
 */
export function listLinkEdges(
  db: Database.Database,
  artifactId: string,
): Array<{ rel: ArtifactLinkRel; targetId: string }> {
  const rows = db
    .prepare(
      `SELECT rel, target_artifact_id AS t FROM artifact_links
       WHERE artifact_id = ? ORDER BY rel, target_artifact_id`,
    )
    .all(artifactId) as Array<{ rel: string; t: string }>;
  const out: Array<{ rel: ArtifactLinkRel; targetId: string }> = [];
  for (const r of rows) {
    if (!isArtifactLinkRel(r.rel)) continue; // 坏数据跳过,不让整个接口 500
    out.push({ rel: r.rel, targetId: r.t });
  }
  return out;
}

/** 入边:谁指向这条工件(例如「哪些 decision 回答了这个提问」) */
export function listBackLinks(
  db: Database.Database,
  artifactId: string,
  rel?: ArtifactLinkRel,
): string[] {
  const rows = (
    rel === undefined
      ? db.prepare(`SELECT artifact_id AS a FROM artifact_links WHERE target_artifact_id = ?`).all(artifactId)
      : db
          .prepare(`SELECT artifact_id AS a FROM artifact_links WHERE target_artifact_id = ? AND rel = ?`)
          .all(artifactId, rel)
  ) as Array<{ a: string }>;
  return rows.map((r) => r.a);
}

/** 全部合法 kind(供 WriteKindGate 回灌给模型用,与 ROLE_SPECS 同源) */
export const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = ARTIFACT_KINDS;
