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
 * 本文件逐条照它实现。三条硬约束照抄在这里,免得后来人绕过:
 *   - **没有 `/api/conversations*`** —— 对话就是项目的;
 *   - **没有 `/api/works` / `/api/artifacts` 平级列表** —— 工作项与工件总是属于
 *     某个项目,提供跨项目列表等于邀请调用方绕过「项目」这个组织维度;
 *   - **harness 只有 GET** —— 写面是单独一批的工作。
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
  BlockerView,
  ClientQuestionView,
  HarnessView,
  HealthResponse,
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

/** 带机器可读 code 的接口错误。`code` 取自后端 `ApiErrorBody.error.code`,不是 HTTP status。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;

  constructor(code: string, message: string, status: number, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 契约 `ApiErrorBody` 的运行时收窄 —— 后端返回怪形状时不崩。 */
function parseErrorBody(v: unknown): { code: string; message: string; detail?: string } | null {
  if (v === null || typeof v !== "object") return null;
  const err = (v as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const detail = (err as { detail?: unknown }).detail;
  if (typeof code !== "string") return null;
  return {
    code,
    message: typeof message === "string" ? message : code,
    ...(typeof detail === "string" ? { detail } : {}),
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
    if (parsed) throw new ApiError(parsed.code, parsed.message, res.status, parsed.detail);
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

/** 立项的唯一出口。返回 `{ project: ProjectSummary }`(201)—— 详情要另拉。 */
export function createProject(input: {
  name: string;
  client: string;
  goal: string;
}): Promise<{ project: ProjectSummary }> {
  return request<{ project: ProjectSummary }>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getProject(id: string): Promise<{ project: ProjectDetail }> {
  return request<{ project: ProjectDetail }>(`/projects/${encodeURIComponent(id)}`);
}

/** 项目的一条连续对话。 */
export function getProjectMessages(id: string): Promise<MessagesResponse> {
  return request<MessagesResponse>(`/projects/${encodeURIComponent(id)}/messages`);
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

// ── harness(本次只读)──────────────────────────────────────────

/** 只有 GET。契约 `HarnessView.writable: false` —— 没有 PUT / facets / reset。 */
export function getHarness(): Promise<HarnessView> {
  return request<HarnessView>("/harness");
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
export interface ResetResult {
  ok: boolean;
  removed: string[];
  failed: string[];
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
