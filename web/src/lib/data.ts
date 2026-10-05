/**
 * Sansheng · 页面读取层的共享 hooks(项目为中心)
 *
 * ── 这个文件取代了旧的 `lib/artifacts.ts` ──────────────────────────
 *
 * 旧文件是「会话为中心」的:一个 `useArtifacts()` 读
 * `GET /api/artifacts?conversationId=` + limit=200,外加 intent/todo/orphanTodos
 * 这套**计划时代**的词表(计划已删)。现在:
 *
 *   - 读取按**项目**分组(每个 hook 都吃 `projectId`);
 *   - 词表(中文读法 + 语义色)搬到 `lib/vocab.ts` —— 它是纯映射,不该和
 *     「怎么取数」混在一个文件里;
 *   - 每个 hook 的 `loading` **初值都是 `true`**。
 *
 * ── 为什么 loading 初值必须是 true(旧文件用一整段注释守过这条)────────
 *
 * 初值 `false` 会让页面首帧拿到 `{loading:false, data:[]}` —— 此时请求还没发出去,
 * 页面已经替用户断言「这个项目没有工件」。于是每次切页必然依次闪:
 * 「还没有工件」→「加载中…」→ 真实结果。**「还没查过」不等于「查过了,是空」。**
 * 这是说假话,不是风格问题。
 *
 * ── 一条纪律:刷新靠 store 的 revision,不靠轮询 ────────────────────
 *
 * WS 事件只递增 `projectRevision` / `projectsRevision`(见 stores/chat.ts),
 * 页面依赖它重新回查后端拿权威数据 —— 前端不留第二份会漂移的真相。
 * `pollMs` 只给右侧摘要栏做**慢速兜底**(WS 断流时它要能收敛),页面一律不轮询。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  ArtifactView,
  AskView,
  BlockerView,
  ChangeView,
  ClientQuestionView,
  HarnessView,
  MemberConversationView,
  MemberView,
  ProjectDetail,
  ProjectRole,
  ProjectUsageResponse,
  ProjectUsageView,
  RoleHarnessView,
  WorkView,
} from "@shared/types/platform";
import * as api from "./api";
import { errorMessage } from "./api";
import { useChatStore, type ChatStatus, type Turn } from "../stores/chat";

/** 客户端请求的页大小。后端有上限时由后端截断,这里不假装知道它的上限。 */
export const ARTIFACT_LIMIT = 200;

interface Loaded<T> {
  data: T;
  loading: boolean;
  error: string | null;
}

/** 通用只读加载器:依赖变化 / revision 变化时重跑。 */
function useLoad<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  pollMs = 0,
): Loaded<T | null> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方声明,见各 hook
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetcher();
      setData(next);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const id = setInterval(() => void load(), pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  return { data, loading, error };
}

export function useArtifacts(options?: {
  projectId?: string | null;
  pollMs?: number;
}): Loaded<ArtifactView[]> {
  const projectId = options?.projectId ?? null;
  const revision = useChatStore((s) => s.projectRevision);
  const r = useLoad(
    // 工件**总是属于某个项目** —— 没有项目时返回空,不去打一个不存在的平级接口。
    // (契约里刻意没有 `/api/artifacts`:跨项目的同类列表等于邀请调用方绕过
    //  项目这个组织维度。)
    () =>
      projectId === null
        ? Promise.resolve({ artifacts: [] as ArtifactView[] })
        : api.listArtifacts(projectId, { limit: ARTIFACT_LIMIT }),
    [projectId, revision],
    options?.pollMs ?? 0,
  );
  return { data: r.data?.artifacts ?? [], loading: r.loading, error: r.error };
}

export function useWorks(projectId?: string | null): Loaded<WorkView[]> {
  const revision = useChatStore((s) => s.projectRevision);
  const r = useLoad(
    () =>
      projectId
        ? api.listWorks(projectId)
        : Promise.resolve({ works: [] as WorkView[] }),
    [projectId, revision],
  );
  return { data: r.data?.works ?? [], loading: r.loading, error: r.error };
}

/** 本项目成员(四个固定职能)。 */
export function useProjectMembers(projectId: string | null): Loaded<MemberView[]> {
  const revision = useChatStore((s) => s.projectRevision);
  const r = useLoad(
    () =>
      projectId
        ? api.listMembers(projectId)
        : Promise.resolve({ members: [] as MemberView[] }),
    [projectId, revision],
  );
  return { data: r.data?.members ?? [], loading: r.loading, error: r.error };
}

/**
 * 项目详情 + 阻塞(「哪件事被卡住了」)。`projectId` 为空时不发请求。
 *
 * `pollMs` 只给右侧摘要栏做慢速兜底(WS 断流时它要能收敛);页面不轮询。
 */
export function useProjectDetail(
  projectId: string | null,
  options?: { pollMs?: number },
): {
  detail: ProjectDetail | null;
  blockers: BlockerView[];
  loading: boolean;
  error: string | null;
} {
  const revision = useChatStore((s) => s.projectRevision);
  const pollMs = options?.pollMs ?? 0;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [blockers, setBlockers] = useState<BlockerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setDetail(null);
      setBlockers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [d, b] = await Promise.all([
        api.getProject(projectId),
        api.listBlockers(projectId),
      ]);
      setDetail(d.project);
      setBlockers(Array.isArray(b.blockers) ? b.blockers : []);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, revision]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const id = setInterval(() => void load(), pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  return { detail, blockers, loading, error };
}

/** 所有项目里等甲方答的问题(待办 / 评审队列)。 */
export function useClientQuestions(): Loaded<ClientQuestionView[]> {
  const revision = useChatStore((s) => s.projectsRevision);
  const r = useLoad(() => api.listClientQuestions(), [revision]);
  return { data: r.data?.questions ?? [], loading: r.loading, error: r.error };
}

/**
 * 本项目里**角色之间**的提问(内部协作),不是等甲方答的问题。
 *
 * 与 `useClientQuestions()` 刻意分开:那个是**用户的队列**(要动手答),这个是
 * **团队内部的横向沟通**(看了知道进度,不需要用户插手)。混在一起会让用户
 * 以为自己欠了 20 个回答。
 */
export function useProjectAsks(projectId: string | null): Loaded<AskView[]> {
  const revision = useChatStore((s) => s.projectRevision);
  const r = useLoad(
    () => (projectId ? api.listProjectAsks(projectId) : Promise.resolve({ asks: [] as AskView[] })),
    [projectId, revision],
  );
  return { data: r.data?.asks ?? [], loading: r.loading, error: r.error };
}

/** 本项目的变更记录(提议 → 评审 → 接受/实施)。 */
export function useProjectChanges(projectId: string | null): Loaded<ChangeView[]> {
  const revision = useChatStore((s) => s.projectRevision);
  const r = useLoad(
    () =>
      projectId
        ? api.listProjectChanges(projectId)
        : Promise.resolve({ changes: [] as ChangeView[] }),
    [projectId, revision],
  );
  return { data: r.data?.changes ?? [], loading: r.loading, error: r.error };
}

/**
 * 成员页的「他产生了什么对话」清单(`GET /api/projects/:id/member-conversations`)。
 *
 * 条数来自后端的 SQL `GROUP BY agent_id` —— **不要**改成拿 `useProjectMessages` 在
 * 客户端分组:那条读函数每条会话只取最早的 200 条,消息一多,数出来的条数会静默少数。
 */
export function useMemberConversations(projectId: string | null): Loaded<MemberConversationView[]> {
  const revision = useChatStore((s) => s.projectRevision);
  const r = useLoad(
    () =>
      projectId
        ? api.listMemberConversations(projectId)
        : Promise.resolve({ groups: [] as MemberConversationView[] }),
    [projectId, revision],
  );
  return { data: r.data?.groups ?? [], loading: r.loading, error: r.error };
}

// ── 用量(这个项目花了多少 token)──────────────────────────────────

/**
 * 本项目的 token 用量聚合(契约 `ProjectUsageView`)。
 *
 * ── 三条与这个页面直接相关的决定 ──────────────────────────────────
 *
 *   ① `projectId === null` **不发空结果,而是读接待会话那条端点**
 *      (`GET /api/intake/usage`)。接待会话是产品里**第一个花钱的回合**,
 *      把它显示成「还没有数据」等于把一笔真花掉的钱藏起来。
 *   ② `days` **必须由调用方传**:「今日」与「最近 7 天」是两个不同的问题,
 *      而窗口一旦写死在这一层,页面就再也问不了「总共花了多少」
 *      (那个数在 `allTime` 里,不受窗口影响)。
 *   ③ 刷新靠 `projectRevision` —— WS 的 `usage_recorded` / `agent_end` 等事件
 *      递增它,页面据此回查权威值。**权威值永远以后端为准**:事件会丢(断流),
 *      库不会。`loading` 初值为 `true`(见文件头):「还没查过」不是「查过了,是 0」。
 *
 * ⚠️ 返回的 `data` **可以是 `null`**(与 `useArtifacts` 那些返回 `[]` 的 hook 不同):
 * 数组有一条诚实的空值(「没有工件」),而用量**没有** —— 一个凭空造的 `0`
 * 会在首帧被读成「这个项目一分钱没花」,与「还没查过」长得一模一样
 * (文件头那条 `loading` 初值为 true 的规矩说的就是这件事)。
 * 调用方应当只在 `loading === false && error === null` 时把数字当数字。
 */
export function useProjectUsage(
  projectId: string | null,
  options?: { days?: number; limit?: number },
): Loaded<ProjectUsageView | null> {
  const revision = useChatStore((s) => s.projectRevision);
  const days = options?.days;
  const limit = options?.limit;
  const r = useLoad<ProjectUsageResponse>(
    () => {
      const opts = {
        ...(days !== undefined ? { days } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      return projectId !== null ? api.getProjectUsage(projectId, opts) : api.getIntakeUsage(opts);
    },
    [projectId, revision, days, limit],
  );
  return { data: r.data?.usage ?? null, loading: r.loading, error: r.error };
}

// ── 角色能力面(全局面;对话页的「谁面向甲方」判据的一半)─────────────

/**
 * 模块级缓存的 `GET /api/harness`。**失败不缓存** —— 一次网络抖动不该把
 * 「读不到角色能力面」钉死到整个会话(那样对话页会一直显示不出业务经理的发言)。
 */
let harnessPromise: Promise<HarnessView> | null = null;

export function loadHarnessOnce(): Promise<HarnessView> {
  if (harnessPromise === null) {
    harnessPromise = api.getHarness().catch((e: unknown) => {
      harnessPromise = null;
      throw e;
    });
  }
  return harnessPromise;
}

/**
 * 四个角色的能力面(只读,`clientFacing` 是代码内常量的投影)。
 *
 * `ready === false` 表示**还没有拿到这份判据** —— 调用方不许据此断言
 * 「这个人不面向甲方」(见 `channelOf` 的 fail-closed 分支与其后果说明)。
 */
export function useHarnessRoles(): {
  roles: RoleHarnessView[];
  ready: boolean;
  error: string | null;
} {
  const [roles, setRoles] = useState<RoleHarnessView[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadHarnessOnce()
      .then((h) => {
        if (cancelled) return;
        setRoles(h.roles);
        setReady(true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setReady(false);
        setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { roles, ready, error };
}

// ── 通道分离:对话页 = **由用户触发在页面上展示的那条通道**(设计 1 §2.10 / W2-④)──
//
// ── 判据换过一次(W2-④,2026-10-06):角色级 → 封套级 ──────────────────
//
// **旧判据**(A3):`agentId → MemberView.role → HarnessView.clientFacing` 两跳,
// 「谁面向甲方」⇒ 进甲方通道。它答的是**这个人是谁**。
//
// **新判据**(用户的原话):页面上只展示「**由用户触发在页面上展示的通道**」。
// 其实还有由工件触发的(与项目经理的对话)、某个角色触发的(多人会议)等等,
// 而那些不进页面。⇒ 判据是**这一轮为什么存在**,与「谁在说话」「他是不是甲方接口」
// **无关**:
//
//     进甲方通道 ⟺ 用户消息(`agentId === null`)
//                ∨ `source === "broadcast"`(tell_client 的播报,**无条件**显示)
//                ∨ `trigger.kind === "user"` 的回合正文
//     其余一律不进 —— 无论它由谁触发、是哪个角色
//
// **为什么 `clientFacing` 不再是判据**:业务经理**被工件叫醒的那一轮正文也不显示**
// —— 它若真对甲方说了话,那话在 `tell_client` 的**播报**里(那是另一条独立消息,
// 带 `source: "broadcast"`,无条件显示)。
//
// ⚠️ **`ctx` 还在,但它的地位被降级了(只剩回退)**:`origin === {source:"unknown"}`
// 的那些轮是**封套没到**的轮。W3-① 之前它唯一的来源是 REST 回填
// (`chat.ts` 的 `messageToTurn` —— 库里没落那两维);**现在缺口已闭合**
// (`SessionMessageView.origin`,migration 019),`unknown` 只剩两个来源:
//
//   - **019 之前写入的存量行**(那两列当时没被记录,回填就是编造)——
//     本文件第 5 步的回退判据对它们继续有效;
//   - 前端 `tool_start` 抢在 `message_start` 前面建轮(与库无关)。
//
// ⚠️ **不许把第 5 步删掉。** 它今天仍然真的会被读到(存量行 + 抢跑轮),
// 而删掉它就得在「刷新即清空对话」(fail-closed)与「所有 unknown 轮一律显示」
// 之间二选一 —— 两个都错。它现在的定位是**对旧数据的兜底**,不是主判据。
//
// 历史(留着,因为它是这条设计的理由):缺口存在时第 5 步是**刷新后的全部历史**,
// 而回退判据按角色两跳 ⇒ 业务经理(`clientFacing`)被工件/待办叫醒的那一轮,
// 刷新之后又出现在对话页上。两条路(流式 / 刷新)判据不一致 —— 那正是 W3-①。

/** 一轮属于哪条通道。三值而不是布尔:系统提示既不是甲方说的,也不是内部角色的。 */
export type TurnChannel = "client" | "system" | "internal";

export interface ChannelContext {
  /** agentId → role(`GET /api/projects/:id/members`)—— **只在 unknown 回退里读** */
  readonly rolesByAgentId: ReadonlyMap<string, ProjectRole>;
  /** 面向甲方的角色(`GET /api/harness` 的 `RoleHarnessView.clientFacing`)—— 同左 */
  readonly clientFacingRoles: ReadonlySet<ProjectRole>;
  /** 判据是否已就绪(harness 拿到了没)—— 只影响提示的措辞,不影响分类 */
  readonly ready: boolean;
  /** 当前上下文是**接待会话**(没有项目 ⇒ 没有成员表) */
  readonly intake: boolean;
}

export function channelContextOf(input: {
  members: readonly MemberView[];
  /**
   * 只需要「角色 → 是否面向甲方」这一列。**收窄类型是有意的**:判据只依赖
   * `ROLE_SPECS` 的这一个布尔,收窄之后测试能直接喂一张两列的表,
   * 而不必造一份完整的 `RoleHarnessView`。
   */
  roles: ReadonlyArray<Pick<RoleHarnessView, "role" | "clientFacing">>;
  ready: boolean;
  intake: boolean;
}): ChannelContext {
  return {
    rolesByAgentId: new Map(input.members.map((m) => [m.id, m.role])),
    clientFacingRoles: new Set(
      input.roles.filter((r) => r.clientFacing).map((r) => r.role),
    ),
    ready: input.ready,
    intake: input.intake,
  };
}

/**
 * 这一轮该进哪条通道(设计 1 §2.10 的**新判据**,W2-④)。
 *
 * ── 判据(顺序不能换)────────────────────────────────────────────
 *
 * 1. **平台通知**(`role === "system"`)走**独立的系统带**。
 *    `agentId === null` **不等于「甲方」** —— 它有**两个**作者:`kind='user'`
 *    (甲方)与 `kind='system'`(平台通知,`host/serve.ts` 的 `announceDrain`)。
 *    所以先按 `Turn.role`(kind 的投影)把 system 摘出去。
 * 2. **甲方自己说的话**(`agentId === null`)⇒ `client`。
 * 3. **播报封套**(`origin.source === "broadcast"`,只有 `tell_client` 发它)⇒
 *    `client`,**无条件** —— 它是一条独立落库的消息,不属于任何回合,所以
 *    「工件触发的那一轮」里的播报**不被连坐**(验收判据②的方向)。
 * 4. **回合封套**(`origin.source === "turn"`)⇒ 只有 `trigger.kind === "user"`
 *    的那一轮正文进;`todo`(排空器按待办叫醒的,`todoKind` 说清是哪条)
 *    **一律不进** —— 无论说话人是谁、是不是 `clientFacing`。
 * 5. **封套没到**(`origin.source === "unknown"`)⇒ **回退到角色的两跳判据**
 *    (`agentId → role → clientFacing`),映射缺失时 fail-closed。理由与缺口见上面
 *    那段「`ctx` 还在,但它的地位被降级了」。
 *
 * ── 为什么 `ctx` 这个参数还留着(而不是简化签名)──────────────────
 *
 * 第 5 步**真的会读它**:`unknown` 在今天**不是**「刷新后的全部历史」了
 * (W3-① 已闭合),但它仍是**019 之前存量行**的判据 —— 用户库里就有这样一批消息。
 * 把 `ctx` 从签名里删掉,就得在「旧数据一律清空」与「旧数据一律显示」之间二选一
 * —— 两个都错。删掉参数省下的是两个调用点(`MessageList` / `ChatSurface` 经
 * `channelActivityOf`),代价是判据**无声地**倒向一侧。
 */
export function channelOf(turn: Turn, ctx: ChannelContext): TurnChannel {
  if (turn.role === "system") return "system";
  if (turn.agentId === null) return "client";
  const origin = turn.origin;
  if (origin.source === "broadcast") return "client";
  if (origin.source === "turn") {
    return origin.trigger.kind === "user" ? "client" : "internal";
  }
  return fallbackChannelOf(turn, ctx);
}

/**
 * `origin === unknown` 时的回退判据 —— **A3 的两跳原样保留**(§2.10.2):
 * `agentId → 成员 role → clientFacing`,映射缺失时 fail-closed。
 *
 * - **接待会话**(没有项目 ⇒ 没有成员表):`client` —— 那条会话的对象就是业务经理
 *   (界面头部也这么写),而成员表是**按项目**的,接待会话没有项目 ⇒ 这里拿不到
 *   判据,不该假装拿得到;
 * - **项目里**:`internal`(**fail-closed**)。宁可暂时看不见业务经理的发言,也不把
 *   内部角色的发言放进甲方通道 —— 后者是**通道分离失效**,前者只是晚一拍,而且
 *   被滤掉的**条数**会显示在页面上(见 `partitionTurns().hidden`)。
 */
function fallbackChannelOf(turn: Turn, ctx: ChannelContext): TurnChannel {
  if (turn.agentId === null) return turn.role === "user" ? "client" : "system";
  const role = ctx.rolesByAgentId.get(turn.agentId);
  if (role === undefined) {
    return ctx.intake ? "client" : "internal";
  }
  return ctx.clientFacingRoles.has(role) ? "client" : "internal";
}

/** 一屏里要看的两类轮 + 被滤掉的条数。 */
export interface ConversationPartition {
  /** 按时间正序,只含 `client` 与 `system`(不进甲方通道的轮不在里面) */
  timeline: Array<{ turn: Turn; channel: Exclude<TurnChannel, "internal"> }>;
  /**
   * 被滤掉的轮**条数**(`channel === "internal"`)。
   *
   * ⚠️ **必须有读者**:看不到就等于平台替甲方删了证据(设计 1 §2.10.4 的同一条
   * 纪律)。调用方把它显示成一行「另有 N 条不在这条通道里」。
   *
   * ⚠️ W2-④ 起这一侧的**成分变了**:从前是「其他角色的回合」,现在既可能是其他
   * 角色,也可能是**被工件 / 待办叫醒的业务经理那几轮**(它的正文不是对甲方说的话)。
   * 所以调用方的措辞不能写死成「其他角色的回合」。
   */
  hidden: number;
}

/** 把一屏轮按通道分开。纯函数 —— 判据在这里,渲染层只消费结果。 */
export function partitionTurns(
  turns: readonly Turn[],
  ctx: ChannelContext,
): ConversationPartition {
  const timeline: ConversationPartition["timeline"] = [];
  let hidden = 0;
  for (const turn of turns) {
    const channel = channelOf(turn, ctx);
    if (channel === "internal") {
      hidden += 1;
      continue;
    }
    timeline.push({ turn, channel });
  }
  return { timeline, hidden };
}

// ── 运行态也按通道派生:输入框的禁用判据(bug A,2026-10-05)──────────────
//
// 「有人在跑」不等于「你不能说话」。传输级的 `ChatState.status` 是前者:
// 任何角色的 `message_start` / `delta` 都无条件把它置成 `"streaming"`
// (`stores/chat.ts` 的两处),而排空器会让四个角色在**同一个项目**里背靠背地跑
// (真机 2026-10-05:01:11–01:29 的 8 个回合 = pm → bm → pm → wk → wk → wk → qa → bm)。
// ⇒ 只要**任一**内部角色在跑,顶部就是「推演中」、输入框就被禁用 ——
// 而用户只是在等 worker 干活,他本来该能随时跟业务经理说话。
//
// 所以运行态在这里**按通道重算**,不读那个全局位:
//
//     输入框禁用 ⟺ **甲方通道**在**本上下文**里有在飞的轮
//     其余在跑 ⟹ 只影响显示(「内部推进中」)+ 中断按钮,**不影响可用性**
//
// ⚠️ **W2-④ 起「甲方通道」的含义跟着 `channelOf` 一起换了**(这是刻意的:
// 输入框与显示**必须**是同一个判据,否则会出现「页面上没有一条甲方消息,而输入框
// 说甲方正在说话」那种两个答案的现场):
//
//   - 原来:甲方说的 ∪ **业务经理**(按角色)正在说的;
//   - 现在:甲方说的 ∪ **播报**(`tell_client`)∪ **用户触发**的那一轮。
//
// 两处刻意的取舍(都有理由,别顺手改回去):
//   ① `status === "streaming"` 这一位**被忽略** —— 它答的是「有没有人在跑」,
//      而这个判据要答的是「**你的**对话在不在跑」(见 `surfaceStatusOf`)。
//   ② 范围是**当前上下文**(`contextKey`):别的项目里的业务经理正在说话,
//      不该锁住你这里的输入框。服务端的「忙」闩也是**按项目**的
//      (`transport/hub.ts` 的 `busy` 集合,键就是 projectId),两者同粒度。

/** 一条在飞轮按通道的三分。 */
export interface ChannelActivity {
  /** 甲方通道:甲方说的 ∪ 播报 ∪ 用户触发的那一轮 —— 只有这一侧禁用输入框 */
  readonly client: readonly Turn[];
  /** 不进甲方通道的轮(其他角色的、被待办叫醒的业务经理的那个回合;含 unknown 回退) */
  readonly internal: readonly Turn[];
  /** 平台通知(`role: "system"`)—— 两边都不算 */
  readonly system: readonly Turn[];
}

/**
 * 把**当前上下文**里在飞的轮按通道分开(纯函数,逐字复用 `channelOf`)。
 *
 * `contextKey` = 当前上下文,**`null` = 接待会话**(与 `Turn.projectId` /
 * `message_start.projectId` 逐字同义)。它是**恒等比较,不是通配** ——
 * 与 `agent_end` 只收自己那个上下文的轮是同一条纪律:别的项目里在飞的轮
 * 既不该在这里算作活动,也不该被这里收口。
 */
export function channelActivityOf(
  turns: readonly Turn[],
  ctx: ChannelContext,
  contextKey: string | null,
): ChannelActivity {
  const client: Turn[] = [];
  const internal: Turn[] = [];
  const system: Turn[] = [];
  for (const turn of turns) {
    if (turn.projectId !== contextKey) continue;
    const channel = channelOf(turn, ctx);
    if (channel === "client") client.push(turn);
    else if (channel === "internal") internal.push(turn);
    else system.push(turn);
  }
  return { client, internal, system };
}

/**
 * 对话页顶部的状态。比传输级的 `ChatStatus` 多一档:
 * **`internal` = 只有内部角色在跑**(输入框照常可用,见上面那段)。
 */
export type SurfaceStatus = "idle" | "streaming" | "internal" | "error" | "connecting";

/**
 * 顶部状态 + 输入框判据的派生。
 *
 * ⚠️ `raw` 只在 `error` / `connecting` 两档被采用 —— **`"streaming"` 那一位刻意
 * 不读**。改成「`raw === "streaming"` 就返回 `streaming`」等于把 bug A 原样复活:
 * 真机上 worker 每跑一轮,顶部就显示「推演中」、输入框永久禁用,而用户看不见
 * 任何一条内部角色的发言(`partitionTurns` 把它们滤掉了)。
 */
export function surfaceStatusOf(raw: ChatStatus, activity: ChannelActivity): SurfaceStatus {
  if (raw === "error") return "error";
  if (raw === "connecting") return "connecting";
  if (activity.client.length > 0) return "streaming";
  if (activity.internal.length > 0) return "internal";
  return "idle";
}
