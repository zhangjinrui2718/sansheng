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
  BlockerView,
  ClientQuestionView,
  MemberView,
  ProjectDetail,
  WorkView,
} from "@shared/types/platform";
import * as api from "./api";
import { errorMessage } from "./api";
import { useChatStore } from "../stores/chat";

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
