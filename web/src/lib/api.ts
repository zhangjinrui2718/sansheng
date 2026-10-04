/**
 * Sansheng · 前端唯一的后端出口(薄 fetch 封装)
 *
 * ── 为什么必须只有这一个文件认识 `/api/...` ──────────────────────────
 *
 * 改这一层之前,裸 `fetch` 调用散在 12 个文件里(页面、store、hook 各一份),
 * 于是:同一个端点在不同页面用不同的错误解析(有的看 `res.error`、有的只看
 * `res.ok`、有的什么都不看直接 `as T`),路径改名要全仓 grep 一遍还未必找得全。
 * 现在**任何页面/store 都不许再写 fetch**,一律经本文件。
 *
 * ── 路径来自冻结契约,不是这里发明的 ─────────────────────────────
 *
 * `shared/types/platform.ts` 末尾的「HTTP 接口面(冻结于 2026-10-04)」是唯一真相,
 * 本文件逐条照它实现。两条硬约束照抄在这里,免得后来人绕过:
 *   - **没有 `/api/conversations*`** —— 对话就是项目的;
 *   - **没有 `/api/works` / `/api/artifacts` 平级列表** —— 工作项与工件总是属于
 *     某个项目,提供跨项目列表等于邀请调用方绕过「项目」这个组织维度。
 *
 * harness **有写面了**(批次 16):`PUT /units/:id` / `POST /units/:id/reset` /
 * `GET /units/:id/backups`。写面的四条规矩(闭合注册表防路径穿越、备份是写的前置、
 * 报成功 = 真生效、恢复出厂 ≠ 删文件)在后端;前端只负责**如实呈现**:
 *   - 保存成功后用**响应里的 `content`**(后端回读的那份)当新状态,不用入参回显;
 *   - 恢复出厂必须显式二次确认(后端要求 `{ confirm: "reset" }`);
 *   - `ceiling` / `writeKinds` 是代码内常量 —— 界面上要标注「改不了」。
 *
 * 列表类接口一律返回具名键(`{ projects: [...] }`),本文件的返回类型照此声明。
 *
 * ── 错误语义 ────────────────────────────────────────────────────
 *
 * 非 2xx 一律抛 `ApiError`,带 `code` / `message`(契约 `ApiErrorBody`;后端可能
 * 出现的 code 见契约 `错误形状` 那段)。后端返回了无法解析的 body 时退化成
 * `http_<status>`,**不吞错**:调用方永远能拿到一个可判断、可展示的错误对象。
 */
import type {
  AppConfigResponse,
  ArtifactStatus,
  ArtifactView,
  AskView,
  BlockerView,
  ChangeView,
  ClientQuestionView,
  HarnessView,
  HealthResponse,
  IntakeMessagesResponse,
  MemberConversationsResponse,
  MemberView,
  MemoryFragmentView,
  MessagesResponse,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  WorkView,
} from "@shared/types/platform";
import type { ProviderInfo, SettingsPublic } from "@shared/types/settings";

// ── 错误 ────────────────────────────────────────────────────────

/**
 * 带机器可读 code 的接口错误。`code` 取自后端 `ApiErrorBody.error.code`,不是 HTTP status。
 *
 * `validIds` 是 harness 写面特有的**额外**字段:后端在 `unknown_unit` 时把它塞在
 * `error` 里面(`{ error: { code, message, validIds } }`),让调用方知道哪些 id 合法,
 * 而不是去猜。它不属于契约 `ApiErrorBody` 的字段,所以是可选的、按需读取。
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
  readonly validIds?: string[];

  constructor(
    code: string,
    message: string,
    status: number,
    detail?: string,
    validIds?: string[],
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
    if (validIds !== undefined) this.validIds = validIds;
  }
}

/** 契约 `ApiErrorBody` 的运行时收窄 —— 后端返回怪形状时不崩。 */
function parseErrorBody(
  v: unknown,
): { code: string; message: string; detail?: string; validIds?: string[] } | null {
  if (v === null || typeof v !== "object") return null;
  const err = (v as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const detail = (err as { detail?: unknown }).detail;
  const rawValid = (err as { validIds?: unknown }).validIds;
  if (typeof code !== "string") return null;
  const validIds = Array.isArray(rawValid)
    ? rawValid.filter((x): x is string => typeof x === "string")
    : undefined;
  return {
    code,
    message: typeof message === "string" ? message : code,
    ...(typeof detail === "string" ? { detail } : {}),
    ...(validIds !== undefined ? { validIds } : {}),
  };
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const parsed = parseErrorBody(body);
    if (parsed) {
      throw new ApiError(parsed.code, parsed.message, res.status, parsed.detail, parsed.validIds);
    }
    throw new ApiError(`http_${res.status}`, `HTTP ${res.status} ${res.statusText}`.trim(), res.status);
  }
  return body as T;
}

/** 通用请求。所有端点的唯一出口(url 由本文件拼出,调用方只给路径)。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch (e) {
    // 网络层失败(server 没起 / 连接被拒)也要是一个带 code 的错误对象。
    throw new ApiError("network_error", e instanceof Error ? e.message : String(e), 0);
  }
  return readJson<T>(res);
}

// ── 健康 / 配置 / 设置 ──────────────────────────────────────────

/**
 * 唯一一条直接写死字面量路径的调用 —— 它没有参数,且被 App 每 5s 轮询一次,
 * 走通用 helper 只会多一层无意义的拼接。
 */
export function getHealth(): Promise<HealthResponse> {
  return fetch("/api/health").then((r) => readJson<HealthResponse>(r));
}

export function getConfig(): Promise<AppConfigResponse> {
  return request<AppConfigResponse>("/config");
}

export function getSettings(): Promise<SettingsPublic> {
  return request<SettingsPublic>("/settings");
}

export function putSettings(
  next: SettingsPublic,
): Promise<{ ok: boolean; settings: SettingsPublic }> {
  return request<{ ok: boolean; settings: SettingsPublic }>("/settings", {
    method: "PUT",
    body: JSON.stringify(next),
  });
}

export function getProviders(): Promise<{ providers: ProviderInfo[] }> {
  return request<{ providers: ProviderInfo[] }>("/providers");
}

// ── 项目 ────────────────────────────────────────────────────────

export function listProjects(status?: ProjectStatus): Promise<{ projects: ProjectSummary[] }> {
  const q = status !== undefined ? `?status=${encodeURIComponent(status)}` : "";
  return request<{ projects: ProjectSummary[] }>(`/projects${q}`);
}

/**
 * ⚠️ **这里刻意没有 `createProject`。**
 *
 * 后端仍有 `POST /api/projects`(契约里注明:API / 维护用途),但**界面不许调它**:
 * 立项是**业务经理**的动作,不是甲方的动作。甲方做的只有一件事 —— 在接待会话里
 * 与业务经理把诉求谈清楚,谈拢之后由业务经理调 `project_open`,
 * 服务端广播 `project_opened`(见 `@shared/types/platform`)。
 *
 * 上一版界面放了一张 name / client / goal 的表单,用户提交时撞上参数校验报
 * 「goal 不能为空」—— 那正是「让甲方替业务经理立项」的形态。包装函数一并删掉,
 * 免得下一次又有人把它接回界面。
 */
export function getProject(id: string): Promise<{ project: ProjectDetail }> {
  return request<{ project: ProjectDetail }>(`/projects/${encodeURIComponent(id)}`);
}

/** 项目的一条连续对话。 */
export function getProjectMessages(id: string): Promise<MessagesResponse> {
  return request<MessagesResponse>(`/projects/${encodeURIComponent(id)}/messages`);
}

/**
 * 成员页的「他产生了什么对话」清单 —— **按 `agent_id` 在 SQL 里分组**。
 *
 * ⚠️ 它**不是** `getProjectMessages()` 的客户端分组的替代品:那条端点每条会话只取
 * 最早的 200 条,消息一多,客户端数出来的条数就会**静默少数**。这里的 `total` 是
 * `GROUP BY` 的真值,页面要显示条数就必须用它。
 */
export function listMemberConversations(
  id: string,
  opts?: { limit?: number },
): Promise<MemberConversationsResponse> {
  const q = opts?.limit !== undefined ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
  return request<MemberConversationsResponse>(
    `/projects/${encodeURIComponent(id)}/member-conversations${q}`,
  );
}

/**
 * **接待会话**(第一个项目之前)的一条连续对话。
 *
 * 与 `getProjectMessages` 是**同一个后端读函数**,只是没有 projectId 可传。
 * 它存在的理由:那条对话也是真的 —— 它落库、它有历史,刷新之后必须还在。
 * 没有接待会话时后端返回空列表(不是 404),所以首屏不会显示成一次错误。
 */
export function getIntakeMessages(): Promise<IntakeMessagesResponse> {
  return request<IntakeMessagesResponse>("/intake/messages");
}

/**
 * 本项目的工作项。**函数名不带 `Project` 前缀,但参数就是项目** ——
 * 契约里刻意**没有**跨项目的 `/api/works` 平级列表(工作项总是属于某个项目),
 * 所以这里必须给 projectId,没有「全部项目」这个重载。
 */
export function listWorks(projectId: string): Promise<{ works: WorkView[] }> {
  return request<{ works: WorkView[] }>(`/projects/${encodeURIComponent(projectId)}/works`);
}

/** 本项目的工件。同样**没有**跨项目的 `/api/artifacts` 平级列表。 */
export function listArtifacts(
  projectId: string,
  opts?: { kind?: string; status?: ArtifactStatus; limit?: number },
): Promise<{ artifacts: ArtifactView[] }> {
  const params = new URLSearchParams();
  if (opts?.kind !== undefined) params.set("kind", opts.kind);
  if (opts?.status !== undefined) params.set("status", opts.status);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const q = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ artifacts: ArtifactView[] }>(
    `/projects/${encodeURIComponent(projectId)}/artifacts${q}`,
  );
}

/**
 * 本项目的阻塞。「哪件事被卡住了」是甲方要的答案,而
 * `ProjectSummary.counts.openBlockers` 只给了个数。
 */
export function listBlockers(projectId: string): Promise<{ blockers: BlockerView[] }> {
  return request<{ blockers: BlockerView[] }>(`/projects/${encodeURIComponent(projectId)}/blockers`);
}

/**
 * 本项目里**角色之间**的提问(worker 问项目经理这类)。
 *
 * ⚠️ 与 `listClientQuestions()` 是**两回事**,不要混在一起展示:
 *   - 这里的 AskView 是**内部协作**——甲方不是对话的一方,看了也插不上手;
 *   - `ClientQuestionView` 才是**等甲方拍板**的问题,那才是用户要动手的队列。
 * 契约原话:「甲方看不到横向沟通,只看发给自己那部分」。
 */
export function listProjectAsks(projectId: string): Promise<{ asks: AskView[] }> {
  return request<{ asks: AskView[] }>(`/projects/${encodeURIComponent(projectId)}/asks`);
}

/** 本项目的变更记录(提议 → 评审 → 接受/实施)。 */
export function listProjectChanges(projectId: string): Promise<{ changes: ChangeView[] }> {
  return request<{ changes: ChangeView[] }>(`/projects/${encodeURIComponent(projectId)}/changes`);
}

/**
 * 单个工件的详情。
 *
 * 契约里**没有**跨项目的 `/api/artifacts` 列表,但有 `/:id` 详情 —— 从列表点进一条
 * 时不必把整个项目的工件再拉一遍。
 */
export function getArtifact(id: string): Promise<{ artifact: ArtifactView }> {
  return request<{ artifact: ArtifactView }>(`/artifacts/${encodeURIComponent(id)}`);
}

/** 本项目成员(四个固定职能)。`ProjectDetail` 里也带 members,这一条给成员页单独用。 */
export function listMembers(projectId: string): Promise<{ members: MemberView[] }> {
  return request<{ members: MemberView[] }>(`/projects/${encodeURIComponent(projectId)}/members`);
}

// ── 待甲方答的问题 ──────────────────────────────────────────────

/** 所有项目里**等甲方答**的问题(待办 / 评审队列的数据源)。 */
export function listClientQuestions(): Promise<{ questions: ClientQuestionView[] }> {
  return request<{ questions: ClientQuestionView[] }>("/client-questions");
}

/** 回答一个问题 —— 后端走 resolveClientQuestion,落 decision 工件。 */
export function answerClientQuestion(
  id: string,
  answer: string,
): Promise<{ ok: boolean; decisionArtifactId: string }> {
  return request<{ ok: boolean; decisionArtifactId: string }>(
    `/client-questions/${encodeURIComponent(id)}/answer`,
    { method: "POST", body: JSON.stringify({ answer }) },
  );
}

// ── harness ─────────────────────────────────────────────────────
//
// 读是契约 `HarnessView`(`writable: true`),写面只覆盖**提示词单元**:
// `ceiling` / `writeKinds` 是 `ROLE_SPECS` 里的代码内常量,改它们要走代码评审
// (7-E 的架构裁决:集合文件突破不了上界)。所以这里**没有**改工具集合的函数。

/** 四个角色的能力面 + 提示词单元。 */
export function getHarness(): Promise<HarnessView> {
  return request<HarnessView>("/harness");
}

/**
 * 写一个提示词单元。
 *
 * **返回的 `content` 是后端回读的那份** —— 不是入参回显(写面规矩③:报成功 = 真生效)。
 * 调用方必须拿它当新状态,否则界面显示的是「我以为写进去的」而不是「盘上真有的」。
 *
 * 失败时:404 且 `error.validIds` 带全部合法 id(`ApiError.validIds` 里能读到),
 * 让调用方知道该用哪个 id,而不是去猜。
 */
export function updatePromptUnit(
  unitId: string,
  content: string,
): Promise<{ ok: boolean; content: string; backupPath?: string }> {
  return request<{ ok: boolean; content: string; backupPath?: string }>(
    `/harness/units/${encodeURIComponent(unitId)}`,
    { method: "PUT", body: JSON.stringify({ content }) },
  );
}

/**
 * 恢复出厂。**必须显式二次确认** —— 后端要求 `{ confirm: "reset" }`,
 * 传别的会 400 `confirmation_required`。
 *
 * 「恢复出厂」≠「删文件」:删文件会让单元变成 `loaded: false`(agent 从此不知道
 * 那条规矩),写回出厂字节才是恢复默认。所以这个动作能失败(找不到出厂副本时
 * 如实报 `no_factory_copy`,而不是删文件假装成功)。
 */
export function resetPromptUnit(unitId: string): Promise<{ ok: boolean; content: string }> {
  return request<{ ok: boolean; content: string }>(
    `/harness/units/${encodeURIComponent(unitId)}/reset`,
    { method: "POST", body: JSON.stringify({ confirm: "reset" }) },
  );
}

/** 某个单元的历史备份(新的在前)。前端只展示份数,不做回滚 UI。 */
export function listPromptUnitBackups(
  unitId: string,
): Promise<{ backups: Array<{ file: string; path: string }> }> {
  return request<{ backups: Array<{ file: string; path: string }> }>(
    `/harness/units/${encodeURIComponent(unitId)}/backups`,
  );
}

// ── 记忆画像(结构化摘要,与 fragments 互补)──────────────────────
//
// 两层:**片段**是流水式记录(「用户说过 X」),**画像**是当前的结构化摘要
// (「用户是谁」)。两者都在 BC7,都经 MemoryPort 的存储层 —— 所以它们并列展示,
// 不是一个取代另一个。

/** 结构化画像。`entries` 的 key 是画像项 id,value 是任意 JSON。 */
export function getProfile(): Promise<{ entries: Record<string, unknown> }> {
  return request<{ entries: Record<string, unknown> }>("/profile");
}

/** 写一项画像。回读后的 `value` / `updatedAt` 是权威值(写面规矩③)。 */
export function putProfile(
  key: string,
  value: unknown,
): Promise<{ ok: boolean; key: string; value: unknown; updatedAt: number }> {
  return request<{ ok: boolean; key: string; value: unknown; updatedAt: number }>(
    `/profile/${encodeURIComponent(key)}`,
    { method: "PUT", body: JSON.stringify({ value }) },
  );
}

// ── 记忆 ────────────────────────────────────────────────────────

/**
 * 长期记忆片段。
 *
 * **没有 projectId 参数** —— 记忆记的是**用户**,不是项目(设计与工件刻意分开:
 * 记忆关于用户、会淡忘;工件关于项目、不淡忘)。按项目过滤它没有语义。
 */
export function listMemoryFragments(limit?: number): Promise<{ fragments: MemoryFragmentView[] }> {
  const q = limit !== undefined ? `?limit=${limit}` : "";
  return request<{ fragments: MemoryFragmentView[] }>(`/memory/fragments${q}`);
}

// ── 维护动作(不在平台的接口面里)────────────────────────────────

/**
 * 重置本地数据(危险区按钮)。
 *
 * ⚠️ **这条路径不在冻结契约的「HTTP 接口面」表里** —— 它属于旧 server 的维护
 * 端点(`src/server/http.ts` 的 `POST /api/reset`,至今仍在),不是平台业务接口。
 * 之所以放在这里而不是让页面自己 `fetch`:项目纪律要求**任何页面都不许散落裸
 * fetch**(否则错误解析会各写一份)。它是有意为之的例外,已在报告里如实列出:
 * 若平台决定不再提供这个动作,删掉本函数与设置页的危险区即可。
 */
/**
 * `POST /api/reset` 的响应。
 *
 * ⚠️ 这里原本是 `{ok, removed, failed}` —— 那是**旧系统**删 .db 文件的形状。
 * 新设计改成「清平台表的行」后返回 `{ok, cleared, totalRows}`,而前端类型没跟上,
 * 于是 `SettingsPanel` 读 `data.removed.length` **运行时必崩**。
 * 是并行 subagent 逐接口比对时发现的 —— 类型对不上的地方,编译器不会报,
 * 因为两边各自都自洽。
 */
export interface ResetResult {
  ok: boolean;
  /** 每张表清了多少行 */
  cleared: Array<{ table: string; rows: number }>;
  totalRows: number;
}

export function resetData(): Promise<ResetResult> {
  return request<ResetResult>("/reset", {
    method: "POST",
    body: JSON.stringify({ confirm: "reset" }),
  });
}

// ── 给 UI 用的小工具(不碰网络)────────────────────────────────

/** 统一把 unknown 异常转成可展示文案。 */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
