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
  RoleHarnessView,
  WorkView,
} from "@shared/types/platform";
import * as api from "./api";
import { errorMessage } from "./api";
import { useChatStore, type Turn } from "../stores/chat";

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

// ── 通道分离:对话页 = 甲方 ↔ 业务经理(设计 1 §2.10 / §2.12 的 A3)──────
//
// 「谁面向甲方」**不需要新字段**:`agentId` → `MemberView.role` →
// `HarnessView.roles[].clientFacing` 两跳,两个端点都已经在页面上被读过。

/** 一轮属于哪条通道。三值而不是布尔:系统提示既不是甲方说的,也不是内部角色的。 */
export type TurnChannel = "client" | "system" | "internal";

export interface ChannelContext {
  /** agentId → role(`GET /api/projects/:id/members`) */
  readonly rolesByAgentId: ReadonlyMap<string, ProjectRole>;
  /** 面向甲方的角色(`GET /api/harness` 的 `RoleHarnessView.clientFacing`) */
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
 * 这一轮该进哪条通道。
 *
 * ── 判据(三条,顺序不能换)────────────────────────────────────
 *
 * 1. **`agentId === null` 不等于「甲方」** —— `session_messages.agent_id` 的 null
 *    有**两个**作者:`kind='user'`(甲方)与 `kind='system'`(平台通知,
 *    `host/serve.ts` 的 `announceDrain` 在排空器异常停下时落的那条)。所以必须
 *    **同时看 kind**;`Turn.role` 就是 kind 的投影(kind `user` → role `user`,
 *    kind `system` → role `system`)。
 * 2. `agentId !== null` → 两跳查该 agent 的角色是否 `clientFacing`。
 * 3. **映射缺失时**(这个 agent 不在本项目成员表里,或接待会话根本没有成员表):
 *    - 接待会话:`client` —— 那条会话的对象就是业务经理(界面头部也这么写),
 *      而成员表是**按项目**的,接待会话没有项目 ⇒ 这里拿不到判据,不该假装拿得到;
 *    - 项目里:`internal`(**fail-closed**)。宁可暂时看不见业务经理的发言,也不
 *      把内部角色的发言放进甲方通道 —— 后者是**通道分离失效**,前者只是晚一拍,
 *      而且被滤掉的**条数**会显示在页面上(见 `partitionTurns().hidden`)。
 */
export function channelOf(turn: Turn, ctx: ChannelContext): TurnChannel {
  if (turn.agentId === null) {
    return turn.role === "user" ? "client" : "system";
  }
  const role = ctx.rolesByAgentId.get(turn.agentId);
  if (role === undefined) {
    return ctx.intake ? "client" : "internal";
  }
  return ctx.clientFacingRoles.has(role) ? "client" : "internal";
}

/** 一屏里要看的两类轮 + 被滤掉的条数。 */
export interface ConversationPartition {
  /** 按时间正序,只含 `client` 与 `system`(内部角色的发言不在里面) */
  timeline: Array<{ turn: Turn; channel: Exclude<TurnChannel, "internal"> }>;
  /**
   * 被滤掉的内部角色发言**条数**。
   *
   * ⚠️ **必须有读者**:看不到就等于平台替甲方删了证据(设计 1 §2.10.4 的同一条
   * 纪律)。调用方把它显示成一行「另有 N 条不在这条通道里」。
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
